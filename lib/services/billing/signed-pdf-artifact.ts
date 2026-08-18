/**
 * Canonical signed-PDF artifact — state semantics + persistence (Phase 2B-1).
 *
 * Records the metadata of a document's ONE canonical cryptographically-signed PDF
 * (`signedPdfStorageKey` / `signedPdfHash` / `signedAt`). This module owns only the
 * STATE + PERSISTENCE semantics — it does NOT sign, read certificates, load secrets,
 * generate or upload PDFs, or change any legal snapshot. Phase 2B-1 does not wire
 * this into any runtime path.
 *
 * Invariants:
 *  - Signed = ALL three fields present and coherent (partial state is NOT signed).
 *  - Sign-once: an existing canonical artifact is never silently overwritten.
 *  - Tenant-safe: every operation is scoped to (documentId, businessId).
 */

export type SignedArtifactFields = {
  signedPdfStorageKey: string | null;
  signedPdfHash: string | null;
  signedAt: Date | null;
};

export type SignedPdfArtifact = {
  storageKey: string;
  /** sha256 hex of the signed PDF bytes (distinct from the unsigned `pdfHash`). */
  hash: string;
  signedAt: Date;
};

const SHA256_HEX = /^[a-f0-9]{64}$/i;

function isNonEmpty(v: string | null | undefined): v is string {
  return typeof v === "string" && v.trim().length > 0;
}
function isValidDate(d: Date | null | undefined): d is Date {
  return d instanceof Date && !Number.isNaN(d.getTime());
}

/** True only when all three signed-artifact fields are present and coherent. */
export function hasCanonicalSignedPdf(fields: SignedArtifactFields): boolean {
  return (
    isNonEmpty(fields.signedPdfStorageKey) &&
    isNonEmpty(fields.signedPdfHash) &&
    SHA256_HEX.test(fields.signedPdfHash) &&
    isValidDate(fields.signedAt)
  );
}

/** True when SOME (but not all/coherent) signed fields are set — an incomplete state. */
export function isPartialSignedArtifactState(fields: SignedArtifactFields): boolean {
  const anySet =
    fields.signedPdfStorageKey != null ||
    fields.signedPdfHash != null ||
    fields.signedAt != null;
  return anySet && !hasCanonicalSignedPdf(fields);
}

/** Validate a proposed artifact; throw (fail closed) if it is not coherent. */
export function assertValidSignedPdfArtifact(a: SignedPdfArtifact): void {
  if (!a || !isNonEmpty(a.storageKey)) {
    throw new Error("signed-artifact: storageKey is required");
  }
  if (!isNonEmpty(a.hash) || !SHA256_HEX.test(a.hash)) {
    throw new Error("signed-artifact: hash must be a 64-char sha256 hex");
  }
  if (!isValidDate(a.signedAt)) {
    throw new Error("signed-artifact: signedAt must be a valid Date");
  }
}

export type RecordingDecision = "record" | "idempotent" | "conflict";

/**
 * Pure decision for what to do when a compare-and-set found an existing value.
 * Never mutates. Fail-closed: any non-matching or incoherent existing state is a
 * conflict (we refuse to overwrite).
 */
export function classifyRecording(
  existing: SignedArtifactFields,
  proposed: SignedPdfArtifact
): RecordingDecision {
  if (existing.signedPdfStorageKey == null && existing.signedPdfHash == null && existing.signedAt == null) {
    return "record"; // fully unsigned
  }
  if (!hasCanonicalSignedPdf(existing)) {
    return "conflict"; // partial / incoherent existing state — do not touch
  }
  if (existing.signedPdfStorageKey === proposed.storageKey && existing.signedPdfHash === proposed.hash) {
    return "idempotent"; // same canonical artifact recorded again
  }
  return "conflict"; // a DIFFERENT signed artifact already exists — never overwrite
}

/**
 * Storage port (tenant-scoped). The production adapter wires these to the sanctioned
 * billing mutation gateway + Prisma; tests use an in-memory implementation.
 */
export interface SignedArtifactStore {
  /**
   * Atomic compare-and-set: set the three fields ONLY if the document is currently
   * unsigned (`signedPdfStorageKey IS NULL`), scoped to (documentId, businessId).
   * Returns the number of rows updated (0 or 1). This is what makes ONE artifact win.
   */
  casRecordSignedArtifact(args: {
    documentId: number;
    businessId: number;
    artifact: SignedPdfArtifact;
  }): Promise<number>;
  /** Tenant-scoped read of the current signed fields, or null if the doc is not this tenant's. */
  readSignedFields(args: {
    documentId: number;
    businessId: number;
  }): Promise<SignedArtifactFields | null>;
}

export type RecordResult = { status: "recorded" | "idempotent" };

/**
 * Record the canonical signed artifact for a document. Sign-once + tenant-safe +
 * idempotent; refuses to overwrite a different existing artifact (fail closed).
 * Metadata only — does not sign, upload, or touch legal fields.
 */
export async function recordSignedPdfArtifact(
  store: SignedArtifactStore,
  args: { documentId: number; businessId: number; artifact: SignedPdfArtifact }
): Promise<RecordResult> {
  const { documentId, businessId, artifact } = args;
  if (!Number.isInteger(documentId) || documentId <= 0) throw new Error("signed-artifact: invalid documentId");
  if (!Number.isInteger(businessId) || businessId <= 0) throw new Error("signed-artifact: invalid businessId");
  assertValidSignedPdfArtifact(artifact);

  const updated = await store.casRecordSignedArtifact({ documentId, businessId, artifact });
  if (updated === 1) return { status: "recorded" };

  // CAS did not apply: the doc already had a value, is not this tenant's, or is missing.
  const existing = await store.readSignedFields({ documentId, businessId });
  if (existing == null) {
    throw new Error("signed-artifact: document not found for this business (tenant scope)");
  }
  const decision = classifyRecording(existing, artifact);
  if (decision === "idempotent") return { status: "idempotent" };
  throw new Error("signed-artifact: refusing to overwrite an existing canonical signed artifact");
}
