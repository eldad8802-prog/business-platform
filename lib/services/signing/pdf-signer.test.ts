/**
 * Cryptographic PDF signing substrate — core tests (Phase 2A). Run:
 *   npx tsx lib/services/signing/pdf-signer.test.ts
 *
 * Pure/isolated: no Billing, no DB, no env. Uses a disposable TEST certificate and
 * pdf-lib-generated PDFs. Proves: sign → signed, real signature structure, SHA-256,
 * cryptographic verification, tamper detection, certificate identity, fail-closed.
 */
import { PDFDocument } from "pdf-lib";
import { signPdf } from "./pdf-signer.service";
import { verifySignedPdf } from "./pdf-signature-verify";
import {
  generateTestSigningMaterial,
  TestSigningIdentityResolver,
} from "./__testutils__/test-signing-identity";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else {
    failed += 1;
    console.error(`FAIL: ${name}`, extra ?? "");
  }
}

async function makePdf(text = "Dubiz substrate test"): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([300, 200]).drawText(text, { x: 20, y: 100, size: 12 });
  return Buffer.from(await doc.save());
}

(async () => {
  const material = generateTestSigningMaterial();
  const unsigned = await makePdf();

  // ---- Test A — unsigned → signed ----
  const signed = await signPdf(unsigned, material);
  ok("A: signPdf returns a valid PDF buffer", Buffer.isBuffer(signed.bytes) && signed.bytes.subarray(0, 5).toString() === "%PDF-");
  ok("A: signed differs from and is larger than the unsigned input", signed.bytes.length > unsigned.length && !signed.bytes.equals(unsigned));
  ok("A: digest algorithm is sha256 (never sha1)", signed.digestAlgorithm === "sha256");

  // ---- Test B — signature structure ----
  const hasSigType = signed.bytes.includes("/Type /Sig") || signed.bytes.includes("/Type/Sig");
  const hasByteRange = signed.bytes.includes("/ByteRange");
  const hasContents = /\/Contents\s*<[0-9A-Fa-f]+>/.test(signed.bytes.toString("latin1"));
  ok("B: PDF has a signature dictionary (/Type /Sig)", hasSigType);
  ok("B: PDF has /ByteRange", hasByteRange);
  ok("B: PDF has /Contents CMS blob", hasContents);

  // ---- Test C — cryptographic verification of the untouched file ----
  const v = verifySignedPdf(signed.bytes);
  ok("C: verification passes on the original signed file", v.valid === true, v.reason);
  ok("C: reported digest algorithm is sha256", v.digestAlgorithm === "sha256");
  ok("C: reported signature algorithm is RSA", v.signatureAlgorithm === "RSA");
  ok("C: ByteRange parsed (4 numbers)", Array.isArray(v.byteRange) && v.byteRange.length === 4);

  // ---- Test D — tamper detection (flip a byte inside the signed range) ----
  const tampered = Buffer.from(signed.bytes);
  const [a, b] = v.byteRange!;
  const idx = a + Math.min(b - 1, 80);
  tampered[idx] = tampered[idx] ^ 0xff;
  const vt = verifySignedPdf(tampered);
  ok("D: verification FAILS after a covered byte is changed", vt.valid === false, vt.reason);

  // ---- Test E — certificate identity ----
  ok("E: verifier reports the signer certificate CN", v.signerCommonName === "Dubiz TEST Signing - NOT FOR PRODUCTION", v.signerCommonName);
  const norm = (s: string) => s.replace(/\s+/g, "");
  ok("E: verifier certificate matches the material's certificate", !!v.certificatePem && norm(v.certificatePem) === norm(material.certificatePem));

  // ---- Test E2 — identity resolver seam (signer takes injected material) ----
  const resolver = new TestSigningIdentityResolver(material);
  const resolved = await resolver.resolveSigningIdentity(123);
  const signedViaResolver = await signPdf(await makePdf("via resolver"), resolved);
  ok("E2: signer signs with resolver-provided material (no identity ownership)", verifySignedPdf(signedViaResolver.bytes).valid === true);

  // ---- Test F — malformed / missing material → fail closed ----
  let threwBadP12 = false;
  try { await signPdf(unsigned, { p12: Buffer.from("not a real p12"), passphrase: "x" }); }
  catch { threwBadP12 = true; }
  ok("F: invalid p12 material throws (fail closed)", threwBadP12);

  let threwEmpty = false;
  try { await signPdf(unsigned, { p12: Buffer.alloc(0) }); } catch { threwEmpty = true; }
  ok("F: empty material throws (fail closed)", threwEmpty);

  let threwWrongPass = false;
  try { await signPdf(unsigned, { p12: material.p12, passphrase: "wrong-passphrase" }); }
  catch { threwWrongPass = true; }
  ok("F: wrong passphrase throws (fail closed)", threwWrongPass);

  // ---- Test G — malformed / non-PDF input → fail safely, no fake-signed artifact ----
  let threwNotPdf = false;
  try { await signPdf(Buffer.from("this is not a pdf at all"), material); }
  catch { threwNotPdf = true; }
  ok("G: non-PDF input throws (no artifact presented as signed)", threwNotPdf);

  let threwTruncated = false;
  try { await signPdf(Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from("garbage")]), material); }
  catch { threwTruncated = true; }
  ok("G: malformed PDF (has header but unparseable) throws", threwTruncated);

  // ---- Security — signer never returns the original disguised as signed ----
  ok("SEC: a successful sign is structurally a signature (not the input echoed)", signed.bytes.includes("/ByteRange") && !unsigned.includes("/ByteRange"));

  if (failed > 0) { console.error(`\n${failed} test(s) failed.`); process.exit(1); }
  console.log("\nAll PDF signer substrate tests passed.");
})().catch((e) => { console.error("TEST RUNNER ERROR:", (e as Error).stack || (e as Error).message); process.exit(1); });
