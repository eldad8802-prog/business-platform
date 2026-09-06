/**
 * Does this file actually contain what it claims to?
 *
 * The existing upload path trusts `file.type` — the Content-Type the browser
 * put in the multipart part. That is a claim by the client, not a fact about
 * the bytes, so today `evil.bin` renamed and labelled `application/pdf` passes
 * acceptance. On the single-upload screen that is one file at a time, chosen by
 * the owner from their own machine. A batch import multiplies it.
 *
 * More to the point for THIS increment: a preview exists to tell the owner what
 * will happen. A file that is not really a PDF should be shown as unsupported
 * BEFORE they confirm, not fail afterwards. Checking the declared type only
 * would make the preview confidently wrong.
 *
 * # What this is and is not
 *
 * This reads the first few bytes and compares them to well-known container
 * signatures. It proves the file *starts like* the format it claims. It is NOT
 * malware scanning, it does not validate the rest of the structure, and it
 * cannot tell a benign PDF from a malicious one. Nothing here should be quoted
 * as evidence that the platform scans uploads, because it does not.
 *
 * What it does buy: a file whose declared type and actual container disagree is
 * caught at the boundary instead of reaching storage and a parser.
 */

/** Signature check result, kept separate from the declared type. */
export type SignatureVerdict =
  | { ok: true; detected: "pdf" | "jpeg" | "png" }
  | { ok: false; reason: "EMPTY" | "UNRECOGNISED" | "MISMATCH" };

function startsWith(buffer: Buffer, bytes: readonly number[]): boolean {
  if (buffer.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buffer[i] !== bytes[i]) return false;
  }
  return true;
}

/** `%PDF-` */
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d];
/** JPEG SOI marker. Every JPEG variant starts with it. */
const JPEG = [0xff, 0xd8, 0xff];
/** The 8-byte PNG signature. */
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** What the bytes say this is, independent of any declared type. */
export function detectFileSignature(
  buffer: Buffer
): "pdf" | "jpeg" | "png" | null {
  if (buffer.length === 0) return null;
  if (startsWith(buffer, PDF)) return "pdf";
  if (startsWith(buffer, JPEG)) return "jpeg";
  if (startsWith(buffer, PNG)) return "png";
  return null;
}

/** The container families a declared MIME is allowed to correspond to. */
function expectedFor(mimeType: string): ReadonlySet<string> {
  const m = String(mimeType || "").toLowerCase().trim();
  if (m === "application/pdf") return new Set(["pdf"]);
  if (m === "image/jpeg" || m === "image/jpg") return new Set(["jpeg"]);
  if (m === "image/png") return new Set(["png"]);
  // Any other image/* that reached here is not one of the three the batch
  // import accepts; the caller's MIME allowlist decides that separately.
  return new Set<string>();
}

/**
 * Verify the bytes against the declared type.
 *
 * `MISMATCH` is the interesting one: the file is a recognisable container, just
 * not the one it claimed. That is the case worth showing the owner in words,
 * because it is usually a renamed file rather than an attack.
 */
export function verifyFileSignature(
  buffer: Buffer,
  declaredMimeType: string
): SignatureVerdict {
  if (buffer.length === 0) return { ok: false, reason: "EMPTY" };

  const detected = detectFileSignature(buffer);
  if (detected === null) return { ok: false, reason: "UNRECOGNISED" };

  const expected = expectedFor(declaredMimeType);
  if (!expected.has(detected)) return { ok: false, reason: "MISMATCH" };

  return { ok: true, detected };
}
