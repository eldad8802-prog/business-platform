/**
 * Cryptographic PDF signer (Phase 2A substrate).
 *
 * ONE job: take an unsigned PDF Buffer + SigningMaterial and return a
 * cryptographically signed PDF Buffer. It is renderer-agnostic (works on any valid
 * PDF, incl. pdfmake and HTML/Chromium output) and deliberately knows NOTHING about
 * Billing, Prisma, BusinessProfile, storage, env, audit, or document lifecycle.
 *
 * Signature: PKCS#7 (CMS) with a **SHA-256** digest, embedded via a PAdES-style
 * signature dictionary (/Type /Sig, /ByteRange, /Contents). Server-only.
 *
 * Fail-closed: any invalid input or signing failure throws — the function NEVER
 * returns the original (unsigned) PDF disguised as signed, and error messages
 * never include private-key/passphrase material.
 */
import { PDFDocument } from "pdf-lib";
import { pdflibAddPlaceholder } from "@signpdf/placeholder-pdf-lib";
import signpdf from "@signpdf/signpdf";
import { P12Signer } from "@signpdf/signer-p12";
import type { SigningMaterial, SignedPdf } from "./signing-types";

const PDF_MAGIC = Buffer.from("%PDF-");

function assertLooksLikePdf(input: Buffer): void {
  if (!Buffer.isBuffer(input) || input.length < PDF_MAGIC.length) {
    throw new Error("signPdf: input is not a PDF buffer");
  }
  // %PDF- must appear at (or very near) the start of the file.
  if (input.subarray(0, 1024).indexOf(PDF_MAGIC) === -1) {
    throw new Error("signPdf: input does not begin with a %PDF- header");
  }
}

function assertMaterial(material: SigningMaterial): void {
  if (!material || !Buffer.isBuffer(material.p12) || material.p12.length === 0) {
    throw new Error("signPdf: signing material (p12) is missing or empty");
  }
}

/**
 * Sign an unsigned PDF with the given material. Returns the signed PDF bytes.
 * @throws on invalid PDF, invalid/absent material, or any signing failure.
 */
export async function signPdf(
  unsignedPdf: Buffer,
  material: SigningMaterial
): Promise<SignedPdf> {
  assertLooksLikePdf(unsignedPdf);
  assertMaterial(material);

  // 1) Add a signature placeholder (/ByteRange + /Contents + AcroForm sig field)
  //    to the arbitrary input PDF via pdf-lib. Throws on a malformed PDF.
  let withPlaceholder: Buffer;
  try {
    const pdfDoc = await PDFDocument.load(unsignedPdf, { updateMetadata: false });
    pdflibAddPlaceholder({
      pdfDoc,
      reason: "Integrity signature (Dubiz)",
      contactInfo: "",
      name: "Dubiz",
      location: "",
    });
    // @signpdf cannot process cross-reference streams — save without object streams.
    withPlaceholder = Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
  } catch (err) {
    throw new Error(
      `signPdf: failed to prepare PDF for signing (${(err as Error).message})`
    );
  }

  // 2) Sign the placeholder with the P12 material (SHA-256).
  let signed: Buffer;
  try {
    const signer = new P12Signer(
      material.p12,
      material.passphrase !== undefined ? { passphrase: material.passphrase } : undefined
    );
    signed = await signpdf.sign(withPlaceholder, signer);
  } catch {
    // Never surface key/passphrase material in the error.
    throw new Error("signPdf: cryptographic signing failed (invalid material or PDF)");
  }

  if (!Buffer.isBuffer(signed) || signed.subarray(0, 1024).indexOf(PDF_MAGIC) === -1) {
    throw new Error("signPdf: signer did not return a valid signed PDF");
  }

  return { bytes: signed, digestAlgorithm: "sha256" };
}
