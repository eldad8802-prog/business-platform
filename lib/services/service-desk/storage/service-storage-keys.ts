/**
 * Service Desk — object keys in the private "service" storage domain. PURE (no I/O).
 *
 * Every Service table that holds an object key binds it by CHECK to `biz/{businessId}/service/…`
 * (migrations 20261112090000 and 20261120090000). This module builds and checks those keys in code, so a writer
 * (1.3a+) can never compose one the database would refuse, and so the account erasure lists exactly ONE business's
 * prefix: `biz/{id}/service/` WITH the trailing slash — `biz/1/service/` never matches `biz/10/service/`.
 */

export const SERVICE_STORAGE_DOMAIN = "service" as const;

/** The intake photo types the database accepts (CHECK ServiceIntakePhoto_mime) and their key extension. */
export const INTAKE_PHOTO_EXTENSION = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const;

export type IntakePhotoMime = keyof typeof INTAKE_PHOTO_EXTENSION;

/** CHECK ServiceIntakePhoto_size. */
export const INTAKE_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
/** service_intake_photo_guard (DZU07). */
export const INTAKE_PHOTOS_PER_CASE = 10;

const SHA256 = /^[0-9a-f]{64}$/;

function positiveId(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

/** The one prefix a business's Service objects live under, trailing slash included. */
export function serviceBusinessPrefix(businessId: number): string {
  return `biz/${positiveId(businessId, "businessId")}/${SERVICE_STORAGE_DOMAIN}/`;
}

/** True only for a key under this business's Service prefix (no traversal, no other business, no other domain). */
export function isServiceKeyOfBusiness(key: string, businessId: number): boolean {
  if (typeof key !== "string" || key.length > 512 || key.includes("\0") || key.includes("..") || key.includes("\\")) return false;
  const prefix = serviceBusinessPrefix(businessId);
  return key.startsWith(prefix) && key.length > prefix.length;
}

export function isIntakePhotoMime(mime: string): mime is IntakePhotoMime {
  return Object.prototype.hasOwnProperty.call(INTAKE_PHOTO_EXTENSION, mime);
}

/** CHECK ServiceIntakePhoto_key: biz/{b}/service/cases/{c}/intake/photos/{sha256}.{jpg|png|webp}. */
export function intakePhotoKey(input: { businessId: number; caseId: number; sha256: string; mimeType: string }): string {
  const caseId = positiveId(input.caseId, "caseId");
  if (!SHA256.test(input.sha256)) throw new RangeError("sha256 must be 64 lowercase hex characters");
  if (!isIntakePhotoMime(input.mimeType)) throw new RangeError("mimeType must be image/jpeg, image/png or image/webp");
  return `${serviceBusinessPrefix(input.businessId)}cases/${caseId}/intake/photos/${input.sha256}.${INTAKE_PHOTO_EXTENSION[input.mimeType]}`;
}
