/**
 * Business documents — stored PDF objects in the private storage domain business-docs. SERVER-ONLY.
 *
 * Every object has a row in "BusinessDocumentFile" BEFORE it is uploaded (the key is born in that row), so no
 * object can exist without a record of its key. Writes are create-once (putObjectIfAbsent) — the domain refuses
 * anything else.
 *
 * Deleting an object is FENCING it: delete, then create a data-free marker in the same key with a create-once
 * write. R2 may still commit an abandoned PUT after a delete (developers.cloudflare.com/r2/reference/consistency,
 * "Negative reads and in-flight writes"), but every upload here is itself create-once, so once the marker exists
 * a late upload is refused (412) and can never land. Only a CREATED marker moves the row to FENCED: a failed or
 * ambiguous marker write is never counted as a deletion — the row stays DELETING and is retried.
 *
 * The reconciler lists the business's prefix and repairs anything that is not what its row says (a late object
 * under a FENCED key is deleted and fenced again; an object with no row is only reported).
 */
import { createHash, randomUUID } from "node:crypto";

import { getStorageService, type StorageService } from "@/lib/storage";

import { bdTx, type BdTx } from "../bd-tx";

export const FENCE_MARKER = Buffer.from("dubiz:fenced\n", "utf8");
const FENCE_CONTENT_TYPE = "application/x-dubiz-fence";
export const UPLOAD_LEASE_SECONDS = 120;
const FENCE_ATTEMPTS = 6;

export type FilePurpose = "QUOTE_SHARE_COPY" | "LETTER";
export type FileState = "PENDING" | "COMMITTED" | "DELETING" | "FENCED";

export const sha256Hex = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

export function objectKeyFor(businessId: number, purpose: FilePurpose): string {
  const folder = purpose === "LETTER" ? "letters" : "quote-shares";
  return `biz/${businessId}/business-docs/${folder}/${randomUUID()}.pdf`;
}

/** Inside the caller's tenant transaction: the row comes first, PENDING, under a lease owned by `leaseOwner`. */
export async function createPendingFile(tx: BdTx, businessId: number, purpose: FilePurpose, leaseOwner: string): Promise<{ id: number; objectKey: string }> {
  const objectKey = objectKeyFor(businessId, purpose);
  const rows = await tx.$queryRaw<{ id: number }[]>`
    INSERT INTO "BusinessDocumentFile" ("businessId", "purpose", "objectKey", "leaseOwner", "leaseUntil")
    VALUES (${businessId}, ${purpose}::"BusinessDocumentFilePurpose", ${objectKey}, ${leaseOwner}::uuid,
            CURRENT_TIMESTAMP + make_interval(secs => ${UPLOAD_LEASE_SECONDS}::double precision))
    RETURNING "id"`;
  return { id: rows[0].id, objectKey };
}

/** The create-once upload. EXISTS means something already holds the key — never overwrite, never treat as success. */
export async function uploadCreateOnce(businessId: number, objectKey: string, bytes: Buffer, storage: StorageService = getStorageService()): Promise<"CREATED" | "EXISTS"> {
  const r = await storage.putObjectIfAbsent({
    key: objectKey,
    body: bytes,
    contentType: "application/pdf",
    metadata: { businessId, domain: "business-docs", visibility: "private" },
  });
  return r.status;
}

/** Inside the caller's tenant transaction: PENDING → COMMITTED, only by the lease holder. false = lost the lease. */
export async function commitFile(tx: BdTx, businessId: number, fileId: number, leaseOwner: string, bytes: Buffer): Promise<boolean> {
  const n = await tx.$executeRaw`
    UPDATE "BusinessDocumentFile"
       SET "state" = 'COMMITTED', "sha256" = ${sha256Hex(bytes)}, "bytes" = ${bytes.length}, "committedAt" = CURRENT_TIMESTAMP,
           "leaseOwner" = NULL, "leaseUntil" = NULL
     WHERE "businessId" = ${businessId} AND "id" = ${fileId} AND "state" = 'PENDING' AND "leaseOwner" = ${leaseOwner}::uuid`;
  return n === 1;
}

/** Inside the caller's tenant transaction: an abandoned PENDING file (lease taken over) goes to DELETING. */
export async function abandonPendingFile(tx: BdTx, businessId: number, fileId: number): Promise<void> {
  await tx.$executeRaw`
    UPDATE "BusinessDocumentFile" SET "state" = 'DELETING', "leaseOwner" = NULL, "leaseUntil" = NULL
     WHERE "businessId" = ${businessId} AND "id" = ${fileId} AND "state" = 'PENDING'`;
}

export class StoredFileUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoredFileUnavailableError";
  }
}

/** The stored bytes of a COMMITTED file, refused unless they still hash to the recorded digest. */
export async function readCommittedFile(businessId: number, fileId: number, storage: StorageService = getStorageService()): Promise<Buffer> {
  const row = await bdTx(businessId, (tx) =>
    tx.businessDocumentFile.findFirst({ where: { businessId, id: fileId }, select: { objectKey: true, state: true, sha256: true } })
  );
  if (!row || row.state !== "COMMITTED" || !row.sha256) throw new StoredFileUnavailableError("the stored file is not available");
  const got = await storage.getObject(row.objectKey);
  if (sha256Hex(got.body) !== row.sha256) throw new StoredFileUnavailableError("the stored file does not match its digest");
  return got.body;
}

export type FenceOutcome = "FENCED" | "NOT_DELETING" | "RETRY_LATER";

const isMarker = (contentType: string | undefined) => contentType === FENCE_CONTENT_TYPE;

/**
 * Close a key: delete what is there, then create the marker create-once. A 412 (something landed in between —
 * e.g. an abandoned upload committing late) goes round again. true only when the marker is in place (created now,
 * or found from an earlier attempt). Any storage error → false (the caller keeps the row DELETING).
 */
export async function closeKey(businessId: number, objectKey: string, storage: StorageService = getStorageService()): Promise<boolean> {
  for (let attempt = 0; attempt < FENCE_ATTEMPTS; attempt++) {
    try {
      const head = await storage.headObject(objectKey);
      if (head.exists && isMarker(head.metadata?.contentType)) return true;
      if (head.exists) await storage.deleteObject(objectKey);
      const marker = await storage.putObjectIfAbsent({
        key: objectKey,
        body: FENCE_MARKER,
        contentType: FENCE_CONTENT_TYPE,
        metadata: { businessId, domain: "business-docs", visibility: "private", custom: { fence: "1" } },
      });
      if (marker.status === "CREATED") return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** DELETING → FENCED, only once closeKey has put the marker in place. Never on a failed or ambiguous write. */
export async function fenceFile(businessId: number, fileId: number, storage: StorageService = getStorageService()): Promise<FenceOutcome> {
  const row = await bdTx(businessId, (tx) =>
    tx.businessDocumentFile.findFirst({ where: { businessId, id: fileId }, select: { objectKey: true, state: true } })
  );
  if (!row || row.state !== "DELETING") return "NOT_DELETING";
  if (!(await closeKey(businessId, row.objectKey, storage))) return "RETRY_LATER";
  return (await markFenced(businessId, fileId)) ? "FENCED" : "RETRY_LATER";
}

async function markFenced(businessId: number, fileId: number): Promise<boolean> {
  const n = await bdTx(businessId, (tx) => tx.$executeRaw`
    UPDATE "BusinessDocumentFile" SET "state" = 'FENCED', "fencedAt" = CURRENT_TIMESTAMP
     WHERE "businessId" = ${businessId} AND "id" = ${fileId} AND "state" = 'DELETING'`);
  return n === 1;
}

/** Janitor, step 1: PENDING files whose lease has expired → DELETING (rows locked by a live commit are skipped). */
export async function reapExpiredPending(businessId: number): Promise<number[]> {
  const rows = await bdTx(businessId, (tx) => tx.$queryRaw<{ id: number }[]>`
    UPDATE "BusinessDocumentFile" SET "state" = 'DELETING', "leaseOwner" = NULL, "leaseUntil" = NULL
     WHERE "id" IN (SELECT "id" FROM "BusinessDocumentFile"
                     WHERE "businessId" = ${businessId} AND "state" = 'PENDING' AND "leaseUntil" < CURRENT_TIMESTAMP
                     FOR UPDATE SKIP LOCKED)
    RETURNING "id"`);
  return rows.map((r) => r.id);
}

/** Janitor, step 2: try to fence every DELETING file of the business. */
export async function fenceAllDeleting(businessId: number, storage: StorageService = getStorageService()): Promise<{ fenced: number; pending: number }> {
  const rows = await bdTx(businessId, (tx) =>
    tx.businessDocumentFile.findMany({ where: { businessId, state: "DELETING" }, select: { id: true }, orderBy: { id: "asc" } })
  );
  let fenced = 0;
  for (const r of rows) if ((await fenceFile(businessId, r.id, storage)) === "FENCED") fenced++;
  return { fenced, pending: rows.length - fenced };
}

export type ReconcileReport = { listed: number; refenced: string[]; refenceFailed: string[]; unknownObjects: string[]; missingCommitted: string[] };

/**
 * Reconciler: the business's prefix against its rows.
 *   - an object that is not the marker under a FENCED key → deleted and fenced again (DELETING keys are the
 *     janitor's: fenceAllDeleting);
 *   - a COMMITTED row whose object is missing → reported (never silently recreated);
 *   - an object with no row → reported only (nothing creates keys outside a row; a report means investigate).
 */
export async function reconcileBusiness(businessId: number, storage: StorageService = getStorageService()): Promise<ReconcileReport> {
  const rows = await bdTx(businessId, (tx) =>
    tx.businessDocumentFile.findMany({ where: { businessId }, select: { id: true, objectKey: true, state: true } })
  );
  const byKey = new Map(rows.map((r) => [r.objectKey, r]));
  const listed = await storage.listObjects(`biz/${businessId}/business-docs/`);
  const report: ReconcileReport = { listed: listed.length, refenced: [], refenceFailed: [], unknownObjects: [], missingCommitted: [] };
  const present = new Set(listed.map((o) => o.key));
  for (const o of listed) {
    const row = byKey.get(o.key);
    if (!row) {
      report.unknownObjects.push(o.key);
      continue;
    }
    if (row.state === "FENCED") {
      const head = await storage.headObject(o.key);
      if (head.exists && !isMarker(head.metadata?.contentType)) {
        if (await closeKey(businessId, o.key, storage)) report.refenced.push(o.key);
        else report.refenceFailed.push(o.key);
      }
    }
  }
  for (const r of rows) if (r.state === "COMMITTED" && !present.has(r.objectKey)) report.missingCommitted.push(r.objectKey);
  return report;
}
