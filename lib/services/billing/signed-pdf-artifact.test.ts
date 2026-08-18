/**
 * Canonical signed-PDF artifact — state + persistence tests (Phase 2B-1). Run:
 *   npx tsx lib/services/billing/signed-pdf-artifact.test.ts
 *
 * Pure/isolated: no DB, no Prisma, no env, no signing. Exercises the state machine
 * and the tenant-safe / sign-once / idempotent / conflict persistence logic through
 * an in-memory store that faithfully models the production compare-and-set:
 * "set the three fields ONLY if signedPdfStorageKey IS NULL, scoped to (doc,business)".
 */
import {
  hasCanonicalSignedPdf,
  isPartialSignedArtifactState,
  classifyRecording,
  recordSignedPdfArtifact,
  type SignedArtifactFields,
  type SignedArtifactStore,
  type SignedPdfArtifact,
} from "./signed-pdf-artifact";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else {
    failed += 1;
    console.error(`FAIL: ${name}`, extra ?? "");
  }
}
async function throwsAsync(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const artifactA: SignedPdfArtifact = {
  storageKey: "biz/1/billing/10/" + HASH_A + ".signed.pdf",
  hash: HASH_A,
  signedAt: new Date("2026-08-18T12:00:00.000Z"),
};
const artifactB: SignedPdfArtifact = {
  storageKey: "biz/1/billing/10/" + HASH_B + ".signed.pdf",
  hash: HASH_B,
  signedAt: new Date("2026-08-18T13:00:00.000Z"),
};

/**
 * In-memory store keyed by (businessId, documentId) — models tenant isolation and
 * the atomic single-writer CAS exactly like the Prisma `updateMany` conditional update.
 */
type Row = SignedArtifactFields & { readonly _legalMarker?: string };
function makeStore(seed: Array<{ businessId: number; documentId: number; row: Row }>): {
  store: SignedArtifactStore;
  get: (businessId: number, documentId: number) => Row | undefined;
} {
  const map = new Map<string, Row>();
  const key = (b: number, d: number) => `${b}:${d}`;
  for (const s of seed) map.set(key(s.businessId, s.documentId), { ...s.row });

  const store: SignedArtifactStore = {
    async casRecordSignedArtifact({ documentId, businessId, artifact }) {
      const row = map.get(key(businessId, documentId));
      if (!row) return 0; // not this tenant's doc / missing → 0 rows
      if (row.signedPdfStorageKey !== null) return 0; // CAS guard: only when NULL
      row.signedPdfStorageKey = artifact.storageKey;
      row.signedPdfHash = artifact.hash;
      row.signedAt = artifact.signedAt;
      return 1;
    },
    async readSignedFields({ documentId, businessId }) {
      const row = map.get(key(businessId, documentId));
      if (!row) return null;
      return {
        signedPdfStorageKey: row.signedPdfStorageKey,
        signedPdfHash: row.signedPdfHash,
        signedAt: row.signedAt,
      };
    },
  };
  return { store, get: (b, d) => map.get(key(b, d)) };
}

const unsignedRow = (): Row => ({
  signedPdfStorageKey: null,
  signedPdfHash: null,
  signedAt: null,
  _legalMarker: "issuedSnapshotHash:frozen",
});

(async () => {
  // ---- Test A — legacy: all-null is a valid UNSIGNED state ----
  {
    const legacy: SignedArtifactFields = { signedPdfStorageKey: null, signedPdfHash: null, signedAt: null };
    ok("A: all-null is NOT signed", hasCanonicalSignedPdf(legacy) === false);
    ok("A: all-null is NOT partial (valid unsigned)", isPartialSignedArtifactState(legacy) === false);
  }

  // ---- Test B — complete signed state is recognized ----
  {
    const signed: SignedArtifactFields = {
      signedPdfStorageKey: artifactA.storageKey,
      signedPdfHash: artifactA.hash,
      signedAt: artifactA.signedAt,
    };
    ok("B: complete + coherent state is signed", hasCanonicalSignedPdf(signed) === true);
    ok("B: complete state is not partial", isPartialSignedArtifactState(signed) === false);
  }

  // ---- Test C — partial state is NOT signed (fail closed), each combination ----
  {
    const perms: SignedArtifactFields[] = [
      { signedPdfStorageKey: artifactA.storageKey, signedPdfHash: null, signedAt: null },
      { signedPdfStorageKey: null, signedPdfHash: artifactA.hash, signedAt: null },
      { signedPdfStorageKey: null, signedPdfHash: null, signedAt: artifactA.signedAt },
      { signedPdfStorageKey: artifactA.storageKey, signedPdfHash: artifactA.hash, signedAt: null },
      { signedPdfStorageKey: artifactA.storageKey, signedPdfHash: null, signedAt: artifactA.signedAt },
      { signedPdfStorageKey: null, signedPdfHash: artifactA.hash, signedAt: artifactA.signedAt },
    ];
    ok("C: no partial permutation counts as signed", perms.every((p) => hasCanonicalSignedPdf(p) === false));
    ok("C: every partial permutation is flagged partial", perms.every((p) => isPartialSignedArtifactState(p) === true));
    // incoherent hash (present but not sha256) is also not signed
    const badHash: SignedArtifactFields = { signedPdfStorageKey: artifactA.storageKey, signedPdfHash: "not-a-hash", signedAt: artifactA.signedAt };
    ok("C: non-sha256 hash is not signed", hasCanonicalSignedPdf(badHash) === false);
  }

  // ---- Test D — atomic persistence: the three fields land together, once ----
  {
    const { store, get } = makeStore([{ businessId: 1, documentId: 10, row: unsignedRow() }]);
    const res = await recordSignedPdfArtifact(store, { businessId: 1, documentId: 10, artifact: artifactA });
    ok("D: first record returns 'recorded'", res.status === "recorded");
    const row = get(1, 10)!;
    ok(
      "D: all three fields set atomically to the artifact",
      row.signedPdfStorageKey === artifactA.storageKey &&
        row.signedPdfHash === artifactA.hash &&
        row.signedAt?.getTime() === artifactA.signedAt.getTime()
    );
    ok("D: recorded state is now canonical-signed", hasCanonicalSignedPdf(row) === true);
  }

  // ---- Test E — idempotent: recording the SAME artifact again is safe ----
  {
    const { store, get } = makeStore([{ businessId: 1, documentId: 10, row: unsignedRow() }]);
    await recordSignedPdfArtifact(store, { businessId: 1, documentId: 10, artifact: artifactA });
    const before = { ...get(1, 10)! };
    const res2 = await recordSignedPdfArtifact(store, { businessId: 1, documentId: 10, artifact: artifactA });
    const after = get(1, 10)!;
    ok("E: retry with same artifact returns 'idempotent'", res2.status === "idempotent");
    ok(
      "E: retry did not change any stored field",
      after.signedPdfStorageKey === before.signedPdfStorageKey &&
        after.signedPdfHash === before.signedPdfHash &&
        after.signedAt?.getTime() === before.signedAt?.getTime()
    );
  }

  // ---- Test F — conflicting SECOND artifact is rejected (sign-once, fail closed) ----
  {
    const { store, get } = makeStore([{ businessId: 1, documentId: 10, row: unsignedRow() }]);
    await recordSignedPdfArtifact(store, { businessId: 1, documentId: 10, artifact: artifactA });
    const rejected = await throwsAsync(() =>
      recordSignedPdfArtifact(store, { businessId: 1, documentId: 10, artifact: artifactB })
    );
    ok("F: a different second artifact is rejected", rejected === true);
    const row = get(1, 10)!;
    ok(
      "F: original artifact remains untouched after rejection",
      row.signedPdfStorageKey === artifactA.storageKey && row.signedPdfHash === artifactA.hash
    );
  }

  // ---- Test F2 — classifyRecording purity: partial existing is a conflict ----
  {
    const partial: SignedArtifactFields = { signedPdfStorageKey: artifactA.storageKey, signedPdfHash: null, signedAt: null };
    ok("F2: partial existing → conflict", classifyRecording(partial, artifactA) === "conflict");
    ok("F2: unsigned existing → record", classifyRecording({ signedPdfStorageKey: null, signedPdfHash: null, signedAt: null }, artifactA) === "record");
    const same: SignedArtifactFields = { signedPdfStorageKey: artifactA.storageKey, signedPdfHash: artifactA.hash, signedAt: artifactA.signedAt };
    ok("F2: identical existing → idempotent", classifyRecording(same, artifactA) === "idempotent");
    ok("F2: different existing → conflict", classifyRecording(same, artifactB) === "conflict");
  }

  // ---- Test G — tenant isolation: Business 2 cannot write Business 1's document ----
  {
    const { store, get } = makeStore([{ businessId: 1, documentId: 10, row: unsignedRow() }]);
    // Business 2 attempts to record for docId 10 (which belongs to Business 1).
    const blocked = await throwsAsync(() =>
      recordSignedPdfArtifact(store, { businessId: 2, documentId: 10, artifact: artifactB })
    );
    ok("G: cross-tenant record is blocked (tenant scope)", blocked === true);
    const row = get(1, 10)!;
    ok(
      "G: Business 1's document was not modified by Business 2",
      row.signedPdfStorageKey === null && row.signedPdfHash === null && row.signedAt === null
    );
    // And Business 1 can still legitimately record its own document afterwards.
    const res = await recordSignedPdfArtifact(store, { businessId: 1, documentId: 10, artifact: artifactA });
    ok("G: legitimate owner can still record afterwards", res.status === "recorded");
  }

  // ---- Test H — legal immutability: recording never touches legal/unsigned-pdf fields ----
  {
    const legalRow: Row = {
      ...unsignedRow(),
      _legalMarker: "issuedSnapshotHash=SNAP123|pdfHash=PDFHASH999|pdfStorageKey=biz/1/billing/10/PDFHASH999.pdf",
    };
    const { store, get } = makeStore([{ businessId: 1, documentId: 10, row: legalRow }]);
    const markerBefore = get(1, 10)!._legalMarker;
    await recordSignedPdfArtifact(store, { businessId: 1, documentId: 10, artifact: artifactA });
    const after = get(1, 10)!;
    ok("H: legal/pdf marker is byte-identical after recording", after._legalMarker === markerBefore);
    ok(
      "H: only the three signed-* fields changed",
      after.signedPdfStorageKey === artifactA.storageKey &&
        after.signedPdfHash === artifactA.hash &&
        after.signedAt?.getTime() === artifactA.signedAt.getTime()
    );
    ok("H: signedPdfHash differs from the unsigned pdfHash in the marker", !markerBefore!.includes(artifactA.hash));
  }

  // ---- Test I — historical compatibility: a pre-2B document reads as unsigned, then signable ----
  {
    // Simulates a row that existed before the migration semantics: all signed-* null.
    const historical: Row = { signedPdfStorageKey: null, signedPdfHash: null, signedAt: null };
    ok("I: historical row classifies as unsigned", hasCanonicalSignedPdf(historical) === false);
    ok("I: historical row is not partial", isPartialSignedArtifactState(historical) === false);
    const { store } = makeStore([{ businessId: 7, documentId: 42, row: historical }]);
    const res = await recordSignedPdfArtifact(store, { businessId: 7, documentId: 42, artifact: { ...artifactA, storageKey: "biz/7/billing/42/x.signed.pdf" } });
    ok("I: a historical document can later be signed once", res.status === "recorded");
  }

  // ---- Validation guard: incoherent proposed artifacts are rejected ----
  {
    const { store } = makeStore([{ businessId: 1, documentId: 10, row: unsignedRow() }]);
    const badHash = await throwsAsync(() =>
      recordSignedPdfArtifact(store, { businessId: 1, documentId: 10, artifact: { ...artifactA, hash: "short" } })
    );
    const emptyKey = await throwsAsync(() =>
      recordSignedPdfArtifact(store, { businessId: 1, documentId: 10, artifact: { ...artifactA, storageKey: "  " } })
    );
    const badDate = await throwsAsync(() =>
      recordSignedPdfArtifact(store, { businessId: 1, documentId: 10, artifact: { ...artifactA, signedAt: new Date("nope") } })
    );
    ok("V: bad hash rejected", badHash);
    ok("V: empty storageKey rejected", emptyKey);
    ok("V: invalid signedAt rejected", badDate);
  }

  if (failed > 0) {
    console.error(`\n${failed} test(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll signed-pdf-artifact tests passed.");
})();
