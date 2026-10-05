import { createHash, randomBytes } from "node:crypto";
import { getStorageService, type StorageService } from "@/lib/storage";
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

/** The storage operations this module needs (the real StorageService, or a test double). */
export type TrustDocumentStorage = Pick<StorageService, "putObject" | "getObject" | "deleteObject">;

function ownKey(businessId: number, storageKey: string): string {
  if (!storageKey.startsWith(`biz/${businessId}/trust/`)) throw new TrustClaimInputError("Invalid document");
  return assertSafeStorageKey(storageKey);
}

export async function putTrustDocument(
  input: { businessId: number; storageKey: string; body: Buffer; mimeType: string },
  storage: TrustDocumentStorage = getStorageService(),
): Promise<void> {
  await storage.putObject({
    key: ownKey(input.businessId, input.storageKey),
    body: input.body,
    contentType: input.mimeType,
    metadata: { businessId: input.businessId, domain: "trust", visibility: "private" },
  });
}

export async function readTrustDocument(
  input: { businessId: number; storageKey: string },
  storage: TrustDocumentStorage = getStorageService(),
): Promise<{ body: Buffer; contentType: string }> {
  const result = await storage.getObject(ownKey(input.businessId, input.storageKey));
  return { body: result.body, contentType: result.metadata.contentType };
}

/** Delete one of THIS business's trust documents. A key outside its private prefix is refused. */
export async function deleteTrustDocument(
  input: { businessId: number; storageKey: string },
  storage: TrustDocumentStorage = getStorageService(),
): Promise<void> {
  await storage.deleteObject(ownKey(input.businessId, input.storageKey));
}

/**
 * A storage-lifecycle failure that left an object behind. It is never silent: the default sink is a
 * structured server error log (keys stay server-side; nothing here reaches a client).
 *   NEW_OBJECT_AFTER_FAILED_ATTACH   the attach failed and the just-stored object could not be deleted
 *   OLD_OBJECT_AFTER_REPLACEMENT     the replacement is canonical, but the replaced object could not be deleted
 *   ATTACH_OUTCOME_AMBIGUOUS         the attach reported failure, yet the claim already points at the new
 *                                    object (e.g. commit acknowledged late) — it is kept, not deleted
 */
export type TrustDocumentLeak = {
  event: "trust_document_cleanup_failed";
  phase: "NEW_OBJECT_AFTER_FAILED_ATTACH" | "OLD_OBJECT_AFTER_REPLACEMENT" | "ATTACH_OUTCOME_AMBIGUOUS";
  businessId: number;
  claimId: number;
  storageKey: string;
  error: string;
};

function logLeak(leak: TrustDocumentLeak): void {
  console.error(JSON.stringify(leak));
}

const message = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

/**
 * Store a claim's private document with a safe lifecycle:
 *
 *   validate bytes → store NEW → attach in the database (row locked, returns the replaced key)
 *     attach FAILS     → delete NEW, rethrow the ORIGINAL error (a cleanup failure is reported, never hidden)
 *     attach SUCCEEDS  → delete the replaced OLD object; if that fails the request still succeeds — the
 *                        database already points at NEW and is never rolled back — and the leak is reported
 *
 * The database (attachVerificationDocument, under RLS) is the authority for whether the claim may take
 * the document; the route's earlier ownership read only avoids storing bytes for an obviously wrong id.
 */
export async function storeVerificationDocument<C>(
  input: { businessId: number; claimId: number; mimeType: unknown; body: Buffer },
  deps: {
    attach: (doc: { storageKey: string; sha256: string; mimeType: string }) => Promise<{ claim: C; previousDocumentRef: { storageKey: string } | null }>;
    /** Re-reads the key the claim points at, to resolve an attach whose outcome is unknown. */
    currentKey?: () => Promise<string | null>;
    storage?: TrustDocumentStorage;
    onLeak?: (leak: TrustDocumentLeak) => void;
  },
): Promise<{ claim: C; oldDocument: "NONE" | "DELETED" | "DELETE_FAILED" }> {
  const storage = deps.storage ?? getStorageService();
  const onLeak = deps.onLeak ?? logLeak;
  const doc = prepareTrustDocument(input);
  const leak = (phase: TrustDocumentLeak["phase"], storageKey: string, error: unknown) =>
    onLeak({ event: "trust_document_cleanup_failed", phase, businessId: input.businessId, claimId: input.claimId, storageKey, error: message(error) });

  await putTrustDocument({ businessId: input.businessId, storageKey: doc.storageKey, body: input.body, mimeType: doc.mimeType }, storage);

  let attached: Awaited<ReturnType<typeof deps.attach>>;
  try {
    attached = await deps.attach({ storageKey: doc.storageKey, sha256: doc.sha256, mimeType: doc.mimeType });
  } catch (attachError) {
    let canonical = false;
    if (deps.currentKey) {
      try {
        canonical = (await deps.currentKey()) === doc.storageKey;
      } catch {
        canonical = false; // cannot prove the database points at it → it is an orphan; delete it
      }
    }
    if (canonical) {
      leak("ATTACH_OUTCOME_AMBIGUOUS", doc.storageKey, attachError);
    } else {
      try {
        await deleteTrustDocument({ businessId: input.businessId, storageKey: doc.storageKey }, storage);
      } catch (cleanupError) {
        leak("NEW_OBJECT_AFTER_FAILED_ATTACH", doc.storageKey, cleanupError);
      }
    }
    throw attachError;
  }

  const previous = attached.previousDocumentRef;
  if (!previous || previous.storageKey === doc.storageKey) return { claim: attached.claim, oldDocument: "NONE" };
  try {
    await deleteTrustDocument({ businessId: input.businessId, storageKey: previous.storageKey }, storage);
    return { claim: attached.claim, oldDocument: "DELETED" };
  } catch (cleanupError) {
    leak("OLD_OBJECT_AFTER_REPLACEMENT", previous.storageKey, cleanupError);
    return { claim: attached.claim, oldDocument: "DELETE_FAILED" };
  }
}
