/**
 * Which file types Documents accepts, and whether a file really is one.
 *
 * This module owns BOTH halves of that question on purpose, because keeping
 * them apart is what created the bug it closes: the acceptance list said "PDF
 * or any image", while the only validator able to check the bytes knew three
 * containers. The two could disagree, and did — the Import Center refused a
 * WebP that the upload screen accepted.
 *
 * One declared-type table, one detector, one comparison. A type cannot be
 * accepted here without a signature to check it against.
 *
 * # Why the declared type is not enough
 *
 * `file.type` on an upload is the Content-Type the client put in the multipart
 * part. It is a claim, not a fact about the bytes, so `evil.bin` renamed and
 * labelled `application/pdf` used to pass acceptance on the single-upload path.
 *
 * # What this is and is not
 *
 * This reads the first few bytes and compares them to well-known container
 * signatures. It proves a file *starts like* the format it claims. It is NOT
 * malware scanning, it does not validate the rest of the structure, and it
 * cannot tell a benign PDF from a malicious one. Nothing here should be quoted
 * as evidence that the platform scans uploads, because it does not.
 *
 * What it does buy: a file whose declared type and actual container disagree is
 * caught at the boundary, before storage and before any parser.
 *
 * # Where it lives, and why it moved
 *
 * It began under the Import Center because that is where it was first needed.
 * That became the wrong home the moment the normal upload route needed it too:
 * the core Documents path must not depend on a settings feature. It now sits
 * beside the other acceptance rules in the Documents service, and both callers
 * share this one copy.
 */

/** The container families Documents can accept. */
export type DocumentContainer = "pdf" | "jpeg" | "png";

/**
 * Declared media type -> the container it names.
 *
 * The supported set is CLOSED and deliberately small. It used to be
 * `application/pdf` or any `image/*`, which is an unbounded set and therefore
 * one no validator can ever fully check — declaring `image/webp` was enough to
 * get arbitrary bytes accepted. Production held 177 documents spanning four
 * months and every one was one of these three containers, so closing the set
 * removes nothing anyone has ever uploaded and makes the rest verifiable.
 *
 * `image/jpg` is a non-standard spelling some clients send. It names the same
 * container and its bytes are checked identically, so honouring it costs
 * nothing and avoids refusing a real photo over a spelling.
 */
const DECLARED_TO_CONTAINER: ReadonlyMap<string, DocumentContainer> = new Map([
  ["application/pdf", "pdf"],
  ["image/jpeg", "jpeg"],
  ["image/jpg", "jpeg"],
  ["image/png", "png"],
]);

/** Every declared type Documents accepts. Owner-facing lists derive from this. */
export const SUPPORTED_DOCUMENT_MIME_TYPES: readonly string[] = Object.freeze([
  ...DECLARED_TO_CONTAINER.keys(),
]);

export function normalizeDeclaredMime(mimeType: string): string {
  return String(mimeType || "").toLowerCase().trim();
}

/** The container a declared type names, or null when it names none we accept. */
export function containerForDeclaredMime(
  mimeType: string
): DocumentContainer | null {
  return DECLARED_TO_CONTAINER.get(normalizeDeclaredMime(mimeType)) ?? null;
}

/**
 * The media type Dubiz records for a container.
 *
 * Needed where no declared type exists at all — an inbound channel whose
 * provider omitted it. Reading the container from the bytes is the only
 * authority available there, and it is a better one than a declaration: it
 * cannot be asserted by whoever sent the file.
 */
export function canonicalMimeForContainer(container: DocumentContainer): string {
  if (container === "pdf") return "application/pdf";
  if (container === "jpeg") return "image/jpeg";
  return "image/png";
}

/** Signature check result, kept separate from the declared type. */
export type SignatureVerdict =
  | { ok: true; detected: DocumentContainer }
  | { ok: false; reason: "EMPTY" | "UNRECOGNISED" | "MISMATCH" };

export type SignatureRejection = Extract<SignatureVerdict, { ok: false }>["reason"];

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
export function detectFileSignature(buffer: Buffer): DocumentContainer | null {
  if (buffer.length === 0) return null;
  if (startsWith(buffer, PDF)) return "pdf";
  if (startsWith(buffer, JPEG)) return "jpeg";
  if (startsWith(buffer, PNG)) return "png";
  return null;
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

  const expected = containerForDeclaredMime(declaredMimeType);
  if (expected === null || expected !== detected) {
    return { ok: false, reason: "MISMATCH" };
  }

  return { ok: true, detected };
}

/**
 * The owner-facing reason a file was refused on its contents.
 *
 * Shared so the upload screen and the import centre say the same thing about
 * the same file. No parser vocabulary and no talk of signatures or magic bytes:
 * what the owner needs is what to do next, which is to send a real PDF or photo.
 */
export function signatureRejectionMessage(reason: SignatureRejection): string {
  if (reason === "EMPTY") return "הקובץ ריק.";
  if (reason === "MISMATCH") {
    return "תוכן הקובץ אינו תואם לסוג שלו. ייתכן ששם הקובץ שונה. נסו להעלות קובץ PDF, JPG או PNG תקין.";
  }
  return "לא ניתן לזהות את תוכן הקובץ. נסו להעלות קובץ PDF, JPG או PNG תקין.";
}
