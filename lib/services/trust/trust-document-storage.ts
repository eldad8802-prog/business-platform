import { createHash, randomBytes } from "node:crypto";
import { getStorageService } from "@/lib/storage";
import { assertSafeStorageKey } from "@/lib/storage/key-validation";
import { TrustClaimInputError } from "./trust-claim-catalogue";

/**
 * P3-A · Private supporting documents of trust claims (a licence or certificate scan).
 *
 * Objects live in the PRIVATE "trust" storage domain under a server-built key
 *   biz/{businessId}/trust/claim-{claimId}/doc-{random}.{ext}
 * — no user input reaches the key, there is never a public URL, and the sha256 / MIME are computed
 * and checked here from the real bytes. The MIME allowlist equals the database CHECK on
 * BusinessTrustClaim.verificationAttachmentMimeType.
 */

export const MAX_TRUST_DOCUMENT_BYTES = 10 * 1024 * 1024; // 10MB

const ALLOWED: Record<string, { ext: string; magic: (b: Buffer) => boolean }> = {
  "application/pdf": { ext: "pdf", magic: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-" },
  "image/jpeg": { ext: "jpg", magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  "image/png": { ext: "png", magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  "image/webp": { ext: "webp", magic: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
};

export const TRUST_DOCUMENT_MIME_TYPES = Object.keys(ALLOWED);

/** Validate the real bytes (size, declared MIME, file signature) and build the server-side key. */
export function prepareTrustDocument(input: { businessId: number; claimId: number; mimeType: unknown; body: Buffer }) {
  if (!Number.isInteger(input.businessId) || input.businessId <= 0) throw new TrustClaimInputError("Invalid business");
  if (!Number.isInteger(input.claimId) || input.claimId <= 0) throw new TrustClaimInputError("Invalid claim");
  const mime = typeof input.mimeType === "string" ? input.mimeType.toLowerCase().trim() : "";
  const rule = ALLOWED[mime];
  if (!rule) throw new TrustClaimInputError("Only PDF, JPEG, PNG or WEBP documents are accepted");
  if (!input.body.length) throw new TrustClaimInputError("The file is empty");
  if (input.body.length > MAX_TRUST_DOCUMENT_BYTES) throw new TrustClaimInputError("The file is too large (up to 10MB)");
  if (!rule.magic(input.body)) throw new TrustClaimInputError("The file content does not match its type");
  const key = assertSafeStorageKey(`biz/${input.businessId}/trust/claim-${input.claimId}/doc-${Date.now()}-${randomBytes(6).toString("hex")}.${rule.ext}`);
  const sha256 = createHash("sha256").update(input.body).digest("hex");
  return { storageKey: key, sha256, mimeType: mime };
}

export async function putTrustDocument(input: { businessId: number; storageKey: string; body: Buffer; mimeType: string }): Promise<void> {
  if (!input.storageKey.startsWith(`biz/${input.businessId}/trust/`)) throw new TrustClaimInputError("Invalid document");
  await getStorageService().putObject({
    key: assertSafeStorageKey(input.storageKey),
    body: input.body,
    contentType: input.mimeType,
    metadata: { businessId: input.businessId, domain: "trust", visibility: "private" },
  });
}

export async function readTrustDocument(input: { businessId: number; storageKey: string }): Promise<{ body: Buffer; contentType: string }> {
  if (!input.storageKey.startsWith(`biz/${input.businessId}/trust/`)) throw new TrustClaimInputError("Invalid document");
  const result = await getStorageService().getObject(assertSafeStorageKey(input.storageKey));
  return { body: result.body, contentType: result.metadata.contentType };
}
