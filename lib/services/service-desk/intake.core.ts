/**
 * Service Desk 1.3b — the intake signature path. PURE (no I/O, no clock): the decisions the intake service applies.
 *
 * An IN_SHOP case, before check-in, collects three things before the customer signs:
 *   - the intake data (recordIntake, 1.3a): condition and accessories recorded;
 *   - the terms snapshot: the business's ACTIVE terms and statutory notice, both LEGALLY_APPROVED, frozen once per case
 *     with their hashes (the database refuses anything else — service_intake_terms_guard, DZU04);
 *   - photos (optional, at most 10, frozen at signature — service_intake_photo_guard, DZU07).
 * Then the signature: one PNG drawn by the customer, stored content-addressed; the intake row becomes signed (customerSigned
 * + signedAt + signatureKey + termsVersion), which is what CHECK_IN already demands (the case machine is unchanged).
 *
 * Owner rule (2026-11-10): no signed intake without legally approved terms. This module refuses to sign without a
 * snapshot, and a snapshot exists only for approved texts. Nothing here approves a text.
 */
import type { ServiceCaseKind, ServiceCaseStatus } from "./contracts";
import { INTAKE_PHOTO_MAX_BYTES, INTAKE_PHOTOS_PER_CASE } from "./storage/service-storage-keys";

export type IntakeViolation =
  | "INTAKE_ONLY_IN_SHOP"
  | "INTAKE_ONLY_BEFORE_CHECK_IN"
  | "INTAKE_SIGNED"
  | "INTAKE_NOT_RECORDED"
  | "TERMS_NOT_CONFIGURED"
  | "TERMS_NOT_APPROVED"
  | "TERMS_ALREADY_PRESENTED"
  | "TERMS_NOT_PRESENTED"
  | "PHOTO_TYPE"
  | "PHOTO_TOO_LARGE"
  | "PHOTO_LIMIT"
  | "PHOTO_DUPLICATE"
  | "SIGNATURE_INVALID";

export type ImageMime = "image/png" | "image/jpeg" | "image/webp";

export const SIGNATURE_MIN_BYTES = 100;
export const SIGNATURE_MAX_BYTES = 512 * 1024;
export const SIGNATURE_MIN_WIDTH = 100;
export const SIGNATURE_MIN_HEIGHT = 40;
export const SIGNATURE_MAX_SIDE = 4000;

/** What the intake service knows about the case when it decides (read under the case lock). */
export type IntakeFacts = {
  kind: ServiceCaseKind;
  status: ServiceCaseStatus;
  intake: { conditionRecorded: boolean; accessoriesRecorded: boolean; signed: boolean } | null;
  termsSnapshot: { termsVersion: number; statutoryVersion: number } | null;
  photoCount: number;
};

/** One ServiceTextVersion row as the settings point at it (null = no active version configured). */
export type TextFact = {
  id: number;
  kind: "TERMS" | "STATUTORY_NOTICE";
  version: number;
  legalStatus: "DRAFT" | "LEGALLY_APPROVED";
  bodySha256: string;
} | null;

type Refused = { ok: false; violations: IntakeViolation[] };
const refuse = (violations: IntakeViolation[]): Refused => ({ ok: false, violations });

/** The image type by its first bytes — the declared type is never trusted alone. */
export function sniffImage(bytes: Uint8Array): ImageMime | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "image/webp";
  return null;
}

/** A PNG's width and height from its IHDR chunk (the first chunk, at byte 8), or null when it is not one. */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (sniffImage(bytes) !== "image/png" || bytes.length < 24) return null;
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** The rules every intake step shares: an IN_SHOP case, before check-in, not yet signed. */
function stepViolations(f: IntakeFacts): IntakeViolation[] {
  const v: IntakeViolation[] = [];
  if (f.kind !== "IN_SHOP") v.push("INTAKE_ONLY_IN_SHOP");
  if (f.status !== "OPEN" && f.status !== "SCHEDULED") v.push("INTAKE_ONLY_BEFORE_CHECK_IN");
  if (f.intake?.signed) v.push("INTAKE_SIGNED");
  return v;
}

export type PresentTermsDecision = Refused | {
  ok: true;
  termsVersionId: number; termsSha256: string; termsVersion: number;
  statutoryVersionId: number; statutorySha256: string; statutoryVersion: number;
};

/** Freeze the active approved texts for this case, once. Both must exist, be of their kind, and be LEGALLY_APPROVED. */
export function evaluatePresentTerms(f: IntakeFacts, terms: TextFact, statutory: TextFact): PresentTermsDecision {
  const v = stepViolations(f);
  if (f.termsSnapshot) v.push("TERMS_ALREADY_PRESENTED");
  if (!terms || !statutory || terms.kind !== "TERMS" || statutory.kind !== "STATUTORY_NOTICE") v.push("TERMS_NOT_CONFIGURED");
  else if (terms.legalStatus !== "LEGALLY_APPROVED" || statutory.legalStatus !== "LEGALLY_APPROVED") v.push("TERMS_NOT_APPROVED");
  if (v.length > 0 || !terms || !statutory) return refuse(v);
  return {
    ok: true,
    termsVersionId: terms.id, termsSha256: terms.bodySha256, termsVersion: terms.version,
    statutoryVersionId: statutory.id, statutorySha256: statutory.bodySha256, statutoryVersion: statutory.version,
  };
}

export type AddPhotoDecision = Refused | { ok: true; mimeType: ImageMime; byteSize: number; photoNumber: number };

/** One more intake photo: a real JPEG / PNG / WebP whose bytes match the declared type, within size and count. */
export function evaluateAddPhoto(f: IntakeFacts, photo: { declaredMime: unknown; bytes: Uint8Array }): AddPhotoDecision {
  const v = stepViolations(f);
  const sniffed = sniffImage(photo.bytes);
  if (sniffed === null || sniffed !== photo.declaredMime) v.push("PHOTO_TYPE");
  if (photo.bytes.length < 1 || photo.bytes.length > INTAKE_PHOTO_MAX_BYTES) v.push("PHOTO_TOO_LARGE");
  if (f.photoCount >= INTAKE_PHOTOS_PER_CASE) v.push("PHOTO_LIMIT");
  if (v.length > 0 || sniffed === null) return refuse(v);
  return { ok: true, mimeType: sniffed, byteSize: photo.bytes.length, photoNumber: f.photoCount + 1 };
}

export type SignDecision = Refused | { ok: true; termsVersionLabel: string; width: number; height: number };

/**
 * The customer signs: the intake data recorded (condition + accessories), the approved texts frozen for this case, and
 * a PNG of a plausible signature size. termsVersionLabel is what ServiceCaseIntake.termsVersion keeps (≤ 64 chars); the
 * snapshot row keeps the version ids and hashes.
 */
export function evaluateSign(f: IntakeFacts, signature: Uint8Array): SignDecision {
  const v = stepViolations(f);
  if (!f.intake || !f.intake.conditionRecorded || !f.intake.accessoriesRecorded) v.push("INTAKE_NOT_RECORDED");
  if (!f.termsSnapshot) v.push("TERMS_NOT_PRESENTED");
  const dim = pngDimensions(signature);
  if (!dim || signature.length < SIGNATURE_MIN_BYTES || signature.length > SIGNATURE_MAX_BYTES
    || dim.width < SIGNATURE_MIN_WIDTH || dim.height < SIGNATURE_MIN_HEIGHT || dim.width > SIGNATURE_MAX_SIDE || dim.height > SIGNATURE_MAX_SIDE) {
    v.push("SIGNATURE_INVALID");
  }
  if (v.length > 0 || !dim || !f.termsSnapshot) return refuse(v);
  return { ok: true, termsVersionLabel: `T${f.termsSnapshot.termsVersion}-S${f.termsSnapshot.statutoryVersion}`, width: dim.width, height: dim.height };
}
