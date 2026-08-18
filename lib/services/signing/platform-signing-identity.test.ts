/**
 * Platform signing identity resolver — tests (Phase 2B-2, validity-hardened). Run:
 *   npx tsx lib/services/signing/platform-signing-identity.test.ts
 *
 * Isolated: no DB, no Billing, no runtime signing wiring, no real secret. Uses
 * DISPOSABLE PKCS#12 fixtures through the REAL resolver code path. Proves: valid
 * identity resolves + signs + verifies; FAIL CLOSED on missing/malformed/wrong-
 * passphrase/mismatch AND on expired / not-yet-valid; no test fallback; tenant-neutral;
 * no secret exposure in errors; certificate identity/validity inspectable. Time is
 * injected (deterministic) — never depends on the real wall-clock.
 */
import {
  loadPlatformSigningIdentity,
  describePlatformSigningIdentity,
  createPlatformSigningIdentityResolver,
  assessCertificateValidity,
  SigningIdentityError,
  ENV_PLATFORM_SIGNING_P12_BASE64,
  ENV_PLATFORM_SIGNING_P12_PASSPHRASE,
} from "./platform-signing-identity";
import { PLATFORM_SIGNING_IDENTITY_KIND } from "./signing-identity.types";
import { signPdf } from "./pdf-signer.service";
import { verifySignedPdf } from "./pdf-signature-verify";
import { makeDisposableP12, sourceFrom, sourceWith } from "./__testutils__/platform-identity-fixtures";
import { PDFDocument } from "pdf-lib";

// Fixed "now" inside the default fixture window (2026-01-01 .. 2030-01-01).
const NOW = new Date("2026-08-19T12:00:00Z");

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else {
    failed += 1;
    console.error(`FAIL: ${name}`, extra ?? "");
  }
}
async function catchErr(fn: () => Promise<unknown> | unknown): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}
async function makePdf(text = "Dubiz 2B-2 identity test"): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([300, 200]).drawText(text, { x: 20, y: 100, size: 12 });
  return Buffer.from(await doc.save());
}

(async () => {
  const valid = makeDisposableP12();

  // ---- A — valid platform identity resolves to usable material ----
  {
    const { material, metadata } = loadPlatformSigningIdentity(sourceFrom(valid), { now: NOW });
    ok("A: returns a non-empty PKCS#12 buffer", Buffer.isBuffer(material.p12) && material.p12.length > 0);
    ok("A: passphrase passed through", material.passphrase === valid.passphrase);
    ok("A: identity kind is platform", metadata.kind === PLATFORM_SIGNING_IDENTITY_KIND);
    const resolver = createPlatformSigningIdentityResolver(sourceFrom(valid), { now: () => NOW });
    const m2 = await resolver.resolveSigningIdentity(1);
    ok("A: resolver returns SigningMaterial", Buffer.isBuffer(m2.p12) && m2.p12.length > 0);
  }

  // ---- B — resolver output actually signs and verifies (isolated, no wiring) ----
  {
    const resolver = createPlatformSigningIdentityResolver(sourceFrom(valid), { now: () => NOW });
    const material = await resolver.resolveSigningIdentity(1);
    const unsigned = await makePdf();
    const signed = await signPdf(unsigned, material);
    ok("B: produced a signed PDF larger than input", signed.bytes.length > unsigned.length);
    const v = verifySignedPdf(signed.bytes);
    ok("B: signature verifies", v.valid === true, v.reason);
    ok("B: digest is sha256", v.digestAlgorithm === "sha256");
  }

  // ---- C — missing secret fails closed ----
  {
    const e = await catchErr(() => loadPlatformSigningIdentity(sourceWith(undefined, undefined), { now: NOW }));
    ok("C: missing secret throws SigningIdentityError", e instanceof SigningIdentityError);
    ok("C: code is 'missing'", (e as SigningIdentityError)?.code === "missing");
    const e2 = await catchErr(() => loadPlatformSigningIdentity(sourceWith("   ", undefined), { now: NOW }));
    ok("C: blank secret also fails closed", (e2 as SigningIdentityError)?.code === "missing");
  }

  // ---- D — malformed secret fails closed ----
  {
    const e = await catchErr(() => loadPlatformSigningIdentity(sourceWith("!!!not base64!!!", "x"), { now: NOW }));
    ok("D: non-base64 throws", e instanceof SigningIdentityError);
    ok("D: code is 'malformed'", (e as SigningIdentityError)?.code === "malformed");
    const junk = Buffer.from("this is not a pkcs12 container").toString("base64");
    const e2 = await catchErr(() => loadPlatformSigningIdentity(sourceWith(junk, "x"), { now: NOW }));
    ok("D: base64 non-PKCS12 fails closed", e2 instanceof SigningIdentityError);
  }

  // ---- E — wrong passphrase fails closed ----
  {
    const e = await catchErr(() => loadPlatformSigningIdentity(sourceWith(valid.p12Base64, "WRONG-passphrase"), { now: NOW }));
    ok("E: wrong passphrase throws SigningIdentityError", e instanceof SigningIdentityError);
    ok("E: code is 'invalid_passphrase'", (e as SigningIdentityError)?.code === "invalid_passphrase");
  }

  // ---- F — no test fallback: production default source never yields test identity ----
  {
    const priorB64 = process.env[ENV_PLATFORM_SIGNING_P12_BASE64];
    const priorPass = process.env[ENV_PLATFORM_SIGNING_P12_PASSPHRASE];
    delete process.env[ENV_PLATFORM_SIGNING_P12_BASE64];
    delete process.env[ENV_PLATFORM_SIGNING_P12_PASSPHRASE];
    const resolver = createPlatformSigningIdentityResolver(); // default env source + wall-clock
    const e = await catchErr(() => resolver.resolveSigningIdentity(1));
    ok("F: default resolver with no env fails closed (no test fallback)", (e as SigningIdentityError)?.code === "missing");
    if (priorB64 !== undefined) process.env[ENV_PLATFORM_SIGNING_P12_BASE64] = priorB64;
    if (priorPass !== undefined) process.env[ENV_PLATFORM_SIGNING_P12_PASSPHRASE] = priorPass;
  }

  // ---- G — tenant-neutral v1: same platform identity for different businesses ----
  {
    const resolver = createPlatformSigningIdentityResolver(sourceFrom(valid), { now: () => NOW });
    const a = await resolver.resolveSigningIdentity(1);
    const b = await resolver.resolveSigningIdentity(999);
    ok("G: Business 1 and 999 get identical platform material", a.p12.equals(b.p12) && a.passphrase === b.passphrase);
    const fpA = describePlatformSigningIdentity(sourceFrom(valid)).certificateFingerprintSha256;
    ok("G: same certificate fingerprint across tenants", fpA === valid.fingerprintSha256);
    const bad = await catchErr(() => resolver.resolveSigningIdentity(0));
    ok("G: invalid businessId rejected", (bad as SigningIdentityError)?.code === "invalid_business");
  }

  // ---- H — private material never exposed in errors (incl. validity errors) ----
  {
    const expiredForH = makeDisposableP12({
      notBefore: new Date("2020-01-01T00:00:00Z"),
      notAfter: new Date("2021-01-01T00:00:00Z"),
    });
    const secretBits = [
      valid.p12Base64.slice(0, 24),
      valid.passphrase,
      expiredForH.p12Base64.slice(0, 24),
      "BEGIN RSA PRIVATE KEY",
    ];
    const errors: string[] = [];
    for (const load of [
      () => loadPlatformSigningIdentity(sourceWith(valid.p12Base64, "WRONG"), { now: NOW }), // invalid_passphrase
      () => loadPlatformSigningIdentity(sourceWith("!!!bad!!!", valid.passphrase), { now: NOW }), // malformed
      () => loadPlatformSigningIdentity(sourceFrom(expiredForH), { now: NOW }), // certificate_expired
    ]) {
      const e = await catchErr(load);
      errors.push(String((e as Error)?.message ?? ""), String((e as Error)?.stack ?? ""));
    }
    const leaked = errors.some((msg) => secretBits.some((s) => s && msg.includes(s)));
    ok("H: no error message/stack contains p12 bytes, passphrase, or key", leaked === false);
  }

  // ---- I — certificate identity (subject/issuer/fingerprint) parsed consistently ----
  {
    const md = describePlatformSigningIdentity(sourceFrom(valid));
    ok("I: subject CN parsed", md.certificateSubjectCommonName === valid.commonName);
    ok("I: issuer CN equals subject (self-signed)", md.certificateIssuerCommonName === valid.commonName);
    ok("I: fingerprint matches independent computation", md.certificateFingerprintSha256 === valid.fingerprintSha256);
    ok("I: fingerprint is 64-hex sha256", /^[a-f0-9]{64}$/.test(md.certificateFingerprintSha256));
  }

  // ---- J — HARDENED policy: expired / not-yet-valid FAIL CLOSED before signing ----
  {
    // valid still works
    ok(
      "J: valid cert loads material",
      Buffer.isBuffer(loadPlatformSigningIdentity(sourceFrom(valid), { now: NOW }).material.p12)
    );

    const expired = makeDisposableP12({
      notBefore: new Date("2020-01-01T00:00:00Z"),
      notAfter: new Date("2021-01-01T00:00:00Z"),
    });
    const eLoad = await catchErr(() => loadPlatformSigningIdentity(sourceFrom(expired), { now: NOW }));
    ok("J: expired cert throws certificate_expired (load)", (eLoad as SigningIdentityError)?.code === "certificate_expired");
    const expResolver = createPlatformSigningIdentityResolver(sourceFrom(expired), { now: () => NOW });
    const eRes = await catchErr(() => expResolver.resolveSigningIdentity(1));
    ok("J: expired cert throws certificate_expired (resolver, before signing)", (eRes as SigningIdentityError)?.code === "certificate_expired");
    // but metadata is still INSPECTABLE for an expired cert (describe is ungated)
    const expMd = describePlatformSigningIdentity(sourceFrom(expired));
    ok("J: expired cert metadata still inspectable", assessCertificateValidity(expMd, NOW) === "expired");

    const future = makeDisposableP12({
      notBefore: new Date("2099-01-01T00:00:00Z"),
      notAfter: new Date("2100-01-01T00:00:00Z"),
    });
    const fLoad = await catchErr(() => loadPlatformSigningIdentity(sourceFrom(future), { now: NOW }));
    ok("J: not-yet-valid cert throws certificate_not_yet_valid (load)", (fLoad as SigningIdentityError)?.code === "certificate_not_yet_valid");
    const futResolver = createPlatformSigningIdentityResolver(sourceFrom(future), { now: () => NOW });
    const fRes = await catchErr(() => futResolver.resolveSigningIdentity(1));
    ok("J: not-yet-valid cert throws certificate_not_yet_valid (resolver)", (fRes as SigningIdentityError)?.code === "certificate_not_yet_valid");
  }

  // ---- Boundary — inclusive [notBefore, notAfter] window (X.509 semantics) ----
  {
    const md = describePlatformSigningIdentity(sourceFrom(valid));
    const nb = md.notBefore.getTime();
    const na = md.notAfter.getTime();
    ok("BND: now == notBefore is valid (inclusive)", assessCertificateValidity(md, new Date(nb)) === "valid");
    ok("BND: now == notAfter is valid (inclusive)", assessCertificateValidity(md, new Date(na)) === "valid");
    ok("BND: 1s before notBefore is not_yet_valid", assessCertificateValidity(md, new Date(nb - 1000)) === "not_yet_valid");
    ok("BND: 1s after notAfter is expired", assessCertificateValidity(md, new Date(na + 1000)) === "expired");
    // and the load gate agrees at the boundaries
    ok(
      "BND: load succeeds exactly at notBefore",
      Buffer.isBuffer(loadPlatformSigningIdentity(sourceFrom(valid), { now: new Date(nb) }).material.p12)
    );
    const justExpired = await catchErr(() => loadPlatformSigningIdentity(sourceFrom(valid), { now: new Date(na + 1000) }));
    ok("BND: load fails 1s after notAfter", (justExpired as SigningIdentityError)?.code === "certificate_expired");
  }

  // ---- K — key/cert mismatch fails closed ----
  {
    const mm = makeDisposableP12({ mismatchKey: true });
    const e = await catchErr(() => loadPlatformSigningIdentity(sourceFrom(mm), { now: NOW }));
    ok("K: key/cert mismatch fails closed", (e as SigningIdentityError)?.code === "invalid_material");
  }

  if (failed > 0) {
    console.error(`\n${failed} test(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll platform signing identity tests passed.");
})();
