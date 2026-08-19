/**
 * Fiscal PDF delivery orchestrator — tests (Phase 2B-3A). Run:
 *   npx tsx lib/services/billing/signed-pdf-delivery.test.ts
 *
 * Pure/isolated: no DB, no renderer, no real secret. Injected ports drive OFF/ON,
 * failure, and concurrency paths; at least one path runs the REAL signer + verifier
 * end-to-end with disposable test material. Proves: OFF is behavior-neutral and never
 * touches signing; ON produces/serves a canonical signed artifact, fails closed on
 * every failure, signs once, and picks one canonical winner under concurrency.
 */
import { PDFDocument } from "pdf-lib";
import { createHash } from "node:crypto";
import {
  deliverFiscalBillingPdf,
  FiscalSigningError,
  type FiscalSigningDeps,
} from "./signed-pdf-delivery";
import type { SignedArtifactFields, SignedPdfArtifact, SignedArtifactStore } from "./signed-pdf-artifact";
import type { GetOrRenderBillingPdfResult } from "./billing-pdf.service";
import type { SigningMaterial, SignedPdf, SigningIdentityResolver } from "@/lib/services/signing/signing-types";
import { signPdf } from "@/lib/services/signing/pdf-signer.service";
import { verifySignedPdf } from "@/lib/services/signing/pdf-signature-verify";
import { createPlatformSigningIdentityResolver } from "@/lib/services/signing/platform-signing-identity";
import { makeDisposableP12, sourceFrom } from "@/lib/services/signing/__testutils__/platform-identity-fixtures";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else {
    failed += 1;
    console.error(`FAIL: ${name}`, extra ?? "");
  }
}
async function catchErr(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}
function sha256Hex(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}
async function makeUnsignedPdf(text = "Dubiz fiscal — includes graphical stamp"): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([320, 200]).drawText(text, { x: 20, y: 100, size: 12 });
  return Buffer.from(await doc.save());
}

const NOW = new Date("2026-08-19T12:00:00Z");
const INPUT = { businessId: 7, billingDocumentId: 42, actorUserId: 3 };

// ---- in-memory store (keyed by business:doc) with a legal/pdf marker + call spies ----
type Row = SignedArtifactFields & { pdfHashMarker: string; legalMarker: string };
function makeStore(seed: Row, opts?: { concurrentWinner?: SignedPdfArtifact }) {
  const key = `${INPUT.businessId}:${INPUT.billingDocumentId}`;
  const map = new Map<string, Row>([[key, { ...seed }]]);
  const spy = { read: 0, cas: 0 };
  const store: SignedArtifactStore = {
    async casRecordSignedArtifact({ artifact }) {
      spy.cas += 1;
      const row = map.get(key)!;
      // Simulate a concurrent winner installing a DIFFERENT artifact just before us.
      if (opts?.concurrentWinner && row.signedPdfStorageKey === null) {
        row.signedPdfStorageKey = opts.concurrentWinner.storageKey;
        row.signedPdfHash = opts.concurrentWinner.hash;
        row.signedAt = opts.concurrentWinner.signedAt;
        return 0; // we lost
      }
      if (row.signedPdfStorageKey !== null) return 0;
      row.signedPdfStorageKey = artifact.storageKey;
      row.signedPdfHash = artifact.hash;
      row.signedAt = artifact.signedAt;
      return 1;
    },
    async readSignedFields() {
      spy.read += 1;
      const row = map.get(key);
      if (!row) return null;
      return {
        signedPdfStorageKey: row.signedPdfStorageKey,
        signedPdfHash: row.signedPdfHash,
        signedAt: row.signedAt,
      };
    },
  };
  return { store, spy, get: () => map.get(key)! };
}
const unsignedRow = (): Row => ({
  signedPdfStorageKey: null,
  signedPdfHash: null,
  signedAt: null,
  pdfHashMarker: "PDFHASH_UNSIGNED",
  legalMarker: "legalSnapshotHash=SNAP123",
});

// ---- in-memory storage with spies ----
function makeStorage(prefill?: Record<string, Buffer>) {
  const objects = new Map<string, Buffer>(Object.entries(prefill ?? {}));
  const spy = { write: 0, read: 0, unlink: 0 };
  return {
    objects,
    spy,
    port: {
      async write(k: string, b: Buffer) {
        spy.write += 1;
        objects.set(k, b);
      },
      async read(k: string) {
        spy.read += 1;
        const b = objects.get(k);
        if (!b) throw new Error("storage: not found " + k);
        return b;
      },
      async unlinkQuiet(k: string) {
        spy.unlink += 1;
        objects.delete(k);
      },
    },
  };
}

const buildSignedKey = (b: number, d: number, h: string) => `biz/${b}/billing/${d}/${h}.pdf`;

function baseResult(buffer: Buffer): GetOrRenderBillingPdfResult {
  return {
    buffer,
    pdfHash: sha256Hex(buffer),
    pdfTemplateVersion: "billing-v1-html",
    documentNumberFormatted: "2026-42",
    renderedNow: true,
  };
}

// Spy resolver/signer wrappers
function spyResolver(inner: SigningIdentityResolver) {
  const spy = { calls: 0 };
  const r: SigningIdentityResolver = {
    async resolveSigningIdentity(businessId) {
      spy.calls += 1;
      return inner.resolveSigningIdentity(businessId);
    },
  };
  return { resolver: r, spy };
}
function spySigner(inner: (u: Buffer, m: SigningMaterial) => Promise<SignedPdf>) {
  const spy = { calls: 0, lastUnsigned: null as Buffer | null };
  const sign = async (u: Buffer, m: SigningMaterial) => {
    spy.calls += 1;
    spy.lastUnsigned = u;
    return inner(u, m);
  };
  return { sign, spy };
}

(async () => {
  const unsigned = await makeUnsignedPdf();
  const disposable = makeDisposableP12();
  const realResolver = createPlatformSigningIdentityResolver(sourceFrom(disposable), { now: () => NOW });

  function baseDeps(over: Partial<FiscalSigningDeps>): FiscalSigningDeps {
    return {
      isActive: () => false,
      getUnsigned: async () => baseResult(unsigned),
      resolver: realResolver,
      sign: signPdf,
      store: makeStore(unsignedRow()).store,
      storage: makeStorage().port,
      buildSignedKey,
      now: () => NOW,
      ...over,
    };
  }

  // ================= OFF =================
  {
    const st = makeStore(unsignedRow());
    const storage = makeStorage();
    const res = spyResolver(realResolver);
    const sg = spySigner(signPdf);
    const deps = baseDeps({
      isActive: () => false, // OFF-1 semantics: default/missing → false
      store: st.store,
      storage: storage.port,
      resolver: res.resolver,
      sign: sg.sign,
    });
    const out = await deliverFiscalBillingPdf(INPUT, deps);
    ok("OFF-2: serves unsigned buffer unchanged", out.buffer.equals(unsigned));
    ok("OFF-2: servedHash = unsigned pdfHash", out.servedHash === sha256Hex(unsigned));
    ok("OFF-2: signed flag false", out.signed === false);
    ok("OFF-3: resolver never called", res.spy.calls === 0);
    ok("OFF-4: signPdf never called", sg.spy.calls === 0);
    ok("OFF-5: no signed upload", storage.spy.write === 0);
    ok("OFF-6: no signed DB mutation (no cas)", st.spy.cas === 0);
    ok("OFF-7: signing path never entered (no store read)", st.spy.read === 0);
    ok("OFF-1: row signed* remain null", st.get().signedPdfStorageKey === null && st.get().signedPdfHash === null);
  }

  // ================= ON — happy path with REAL crypto =================
  {
    const st = makeStore(unsignedRow());
    const storage = makeStorage();
    const sg = spySigner(signPdf);
    const deps = baseDeps({ isActive: () => true, store: st.store, storage: storage.port, sign: sg.sign });
    const out = await deliverFiscalBillingPdf(INPUT, deps);
    ok("ON-1: signed flag true", out.signed === true);
    ok("ON-1: signPdf invoked once", sg.spy.calls === 1);
    ok("ON-2: servedHash = sha256(served signed bytes)", out.servedHash === sha256Hex(out.buffer));
    // real cryptographic verification of the served artifact
    const v = verifySignedPdf(out.buffer);
    ok("ON-1/§21: served signed PDF verifies", v.valid === true, v.reason);
    ok("§21: digest sha256", v.digestAlgorithm === "sha256");
    ok("§21: signature RSA", v.signatureAlgorithm === "RSA");
    // tamper detection
    const tampered = Buffer.from(out.buffer);
    const br = v.byteRange!;
    tampered[br[0] + Math.min(br[1] - 1, 80)] ^= 0xff;
    ok("§21: tampered signed PDF fails verification", verifySignedPdf(tampered).valid === false);
    // hash + legal immutability
    ok("ON-3: pdfHash marker unchanged", st.get().pdfHashMarker === "PDFHASH_UNSIGNED");
    ok("ON-4: legalSnapshotHash marker unchanged", st.get().legalMarker === "legalSnapshotHash=SNAP123");
    ok("ON-2b: pdfHash (unsigned) != signedPdfHash", sha256Hex(unsigned) !== out.servedHash);
    // stored signed artifact under a distinct content-addressed key
    const signedKey = buildSignedKey(INPUT.businessId, INPUT.billingDocumentId, out.servedHash);
    ok("§6: signed stored at signed-hash key", storage.objects.has(signedKey));
    ok("§6: signed key distinct from unsigned key", signedKey !== buildSignedKey(INPUT.businessId, INPUT.billingDocumentId, sha256Hex(unsigned)));
    ok("§22: signed key is tenant+doc scoped", signedKey.startsWith(`biz/${INPUT.businessId}/billing/${INPUT.billingDocumentId}/`));
    // ON-13: signer received exactly the unsigned canonical bytes (stamp already inside);
    // nothing appended after signing.
    ok("ON-13: signer received the unsigned canonical bytes", sg.spy.lastUnsigned!.equals(unsigned));
    ok("ON-13: served bytes are the signer output (no post-sign modification)", out.buffer.length > unsigned.length);
  }

  // ================= ON-5 / sign-once: second request serves canonical, no re-sign =========
  {
    const st = makeStore(unsignedRow());
    const storage = makeStorage();
    const sg = spySigner(signPdf);
    const res = spyResolver(realResolver);
    const deps = baseDeps({ isActive: () => true, store: st.store, storage: storage.port, sign: sg.sign, resolver: res.resolver });
    const first = await deliverFiscalBillingPdf(INPUT, deps);
    const second = await deliverFiscalBillingPdf(INPUT, deps);
    ok("ON-5: second call still signed", second.signed === true);
    ok("ON-5: signer invoked exactly once across two calls", sg.spy.calls === 1);
    ok("ON-5: second serves same canonical bytes", second.buffer.equals(first.buffer));
    ok("ON-5: second served from storage (read), not re-signed", storage.spy.write === 1);
  }

  // ================= ON-6 missing identity → fail closed =================
  {
    const st = makeStore(unsignedRow());
    const storage = makeStorage();
    const missingResolver: SigningIdentityResolver = {
      async resolveSigningIdentity() {
        throw new Error("platform signing secret is not configured");
      },
    };
    const deps = baseDeps({ isActive: () => true, store: st.store, storage: storage.port, resolver: missingResolver });
    const e = await catchErr(() => deliverFiscalBillingPdf(INPUT, deps));
    ok("ON-6: missing identity throws (fail closed)", e instanceof Error);
    ok("ON-6: no signed record", st.get().signedPdfStorageKey === null);
    ok("ON-6: no signed upload", storage.spy.write === 0);
  }

  // ================= ON-7 expired identity → fail closed =================
  {
    const expired = makeDisposableP12({ notBefore: new Date("2020-01-01T00:00:00Z"), notAfter: new Date("2021-01-01T00:00:00Z") });
    const expiredResolver = createPlatformSigningIdentityResolver(sourceFrom(expired), { now: () => NOW });
    const st = makeStore(unsignedRow());
    const storage = makeStorage();
    const deps = baseDeps({ isActive: () => true, store: st.store, storage: storage.port, resolver: expiredResolver });
    const e = await catchErr(() => deliverFiscalBillingPdf(INPUT, deps));
    ok("ON-7: expired identity fails closed", e instanceof Error);
    ok("ON-7: no signed record after expired", st.get().signedPdfStorageKey === null);
  }

  // ================= ON-8 signing failure → fail closed =================
  {
    const st = makeStore(unsignedRow());
    const storage = makeStorage();
    const deps = baseDeps({
      isActive: () => true,
      store: st.store,
      storage: storage.port,
      sign: async () => {
        throw new Error("signPdf boom");
      },
    });
    const e = await catchErr(() => deliverFiscalBillingPdf(INPUT, deps));
    ok("ON-8: signing failure fails closed", e instanceof Error);
    ok("ON-8: no signed upload/record", storage.spy.write === 0 && st.get().signedPdfStorageKey === null);
  }

  // ================= ON-9 upload failure → fail closed, no DB record =================
  {
    const st = makeStore(unsignedRow());
    const storage = makeStorage();
    const deps = baseDeps({
      isActive: () => true,
      store: st.store,
      storage: { ...storage.port, write: async () => { throw new Error("upload boom"); } },
    });
    const e = await catchErr(() => deliverFiscalBillingPdf(INPUT, deps));
    ok("ON-9: upload failure fails closed", e instanceof Error);
    ok("ON-9: no canonical DB record", st.get().signedPdfStorageKey === null);
  }

  // ================= ON-10 partial signed state → fail closed =================
  {
    const partial: Row = { ...unsignedRow(), signedPdfStorageKey: "biz/7/billing/42/deadbeef.pdf" }; // hash+signedAt null
    const st = makeStore(partial);
    const storage = makeStorage();
    const sg = spySigner(signPdf);
    const deps = baseDeps({ isActive: () => true, store: st.store, storage: storage.port, sign: sg.sign });
    const e = await catchErr(() => deliverFiscalBillingPdf(INPUT, deps));
    ok("ON-10: partial state fails closed", e instanceof FiscalSigningError && (e as FiscalSigningError).code === "partial_state");
    ok("ON-10: signer not called on partial state", sg.spy.calls === 0);
  }

  // ================= ON-11 concurrency → one canonical winner, loser rereads/serves winner ==
  {
    const winnerBytes = Buffer.concat([unsigned, Buffer.from("WINNER-SIGNED")]);
    const winnerHash = sha256Hex(winnerBytes);
    const winnerKey = buildSignedKey(INPUT.businessId, INPUT.billingDocumentId, winnerHash);
    const winner: SignedPdfArtifact = { storageKey: winnerKey, hash: winnerHash, signedAt: NOW };
    const st = makeStore(unsignedRow(), { concurrentWinner: winner });
    const storage = makeStorage({ [winnerKey]: winnerBytes });
    // our signer produces DIFFERENT bytes (non-determinism) than the winner
    const ourSigner = async () => ({ bytes: Buffer.concat([unsigned, Buffer.from("LOSER-SIGNED")]), digestAlgorithm: "sha256" as const });
    const deps = baseDeps({ isActive: () => true, store: st.store, storage: storage.port, sign: ourSigner });
    const out = await deliverFiscalBillingPdf(INPUT, deps);
    ok("ON-11: loser serves the canonical WINNER bytes", out.buffer.equals(winnerBytes));
    ok("ON-11: served hash is winner hash", out.servedHash === winnerHash);
    ok("ON-11: winner (not loser) is canonical in store", st.get().signedPdfHash === winnerHash);
    ok("ON-11: loser orphan object was unlinked", storage.spy.unlink >= 1);
  }

  // ================= ON-12 rotation: doc signed under A stays A; B never resolved =========
  {
    const aBytes = Buffer.concat([unsigned, Buffer.from("CERT-A-SIGNED")]);
    const aHash = sha256Hex(aBytes);
    const aKey = buildSignedKey(INPUT.businessId, INPUT.billingDocumentId, aHash);
    const signedRowA: Row = { ...unsignedRow(), signedPdfStorageKey: aKey, signedPdfHash: aHash, signedAt: NOW };
    const st = makeStore(signedRowA);
    const storage = makeStorage({ [aKey]: aBytes });
    const resB = spyResolver(createPlatformSigningIdentityResolver(sourceFrom(makeDisposableP12({ commonName: "Dubiz Platform TEST Signer B" })), { now: () => NOW }));
    const sg = spySigner(signPdf);
    const deps = baseDeps({ isActive: () => true, store: st.store, storage: storage.port, resolver: resB.resolver, sign: sg.sign });
    const out = await deliverFiscalBillingPdf(INPUT, deps);
    ok("ON-12: rotation serves original cert-A artifact", out.buffer.equals(aBytes));
    ok("ON-12: new cert B never resolved", resB.spy.calls === 0);
    ok("ON-12: no re-sign under rotation", sg.spy.calls === 0);
  }

  // ================= not_found → fail closed =================
  {
    // store with no row for the tenant
    const emptyStore: SignedArtifactStore = {
      async casRecordSignedArtifact() { return 0; },
      async readSignedFields() { return null; },
    };
    const deps = baseDeps({ isActive: () => true, store: emptyStore, storage: makeStorage().port });
    const e = await catchErr(() => deliverFiscalBillingPdf(INPUT, deps));
    ok("NF: unknown-tenant doc fails closed", e instanceof FiscalSigningError && (e as FiscalSigningError).code === "not_found");
  }

  // ================= §22 security: identity error carries no secret =================
  {
    const st = makeStore(unsignedRow());
    const deps = baseDeps({
      isActive: () => true,
      store: st.store,
      storage: makeStorage().port,
      resolver: { async resolveSigningIdentity() { throw new Error("platform signing PKCS#12 could not be opened"); } },
    });
    const e = await catchErr(() => deliverFiscalBillingPdf(INPUT, deps));
    const msg = String((e as Error)?.message ?? "") + String((e as Error)?.stack ?? "");
    ok("§22: error carries no p12/passphrase/key text", !/BEGIN RSA PRIVATE KEY|passphrase|p12=/.test(msg));
  }

  if (failed > 0) {
    console.error(`\n${failed} test(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll fiscal PDF delivery orchestrator tests passed.");
})();
