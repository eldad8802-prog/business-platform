/**
 * Business documents — server-issued idempotency keys. SERVER-ONLY.
 *
 * A key is issued by the server for ONE operation (POST /api/business-documents/requests) and may be used for 24 hours
 * from its issue (database clock). Within that window:
 *   - the first request with it claims it (a lease) and does the work;
 *   - the same request again returns the FIRST result (never a second artifact);
 *   - a different request body with the same key → IDEMPOTENCY_CONFLICT (409);
 *   - a concurrent request while the lease is live → IN_PROGRESS (409, retry);
 *   - after a lease expired (a crashed request), the next request takes over; the crashed request can no longer
 *     complete (its lease token no longer matches) and its pending file is abandoned to the janitor.
 * Outside the window, or with a key the server never issued (or has since purged), → EXPIRED / UNKNOWN (410):
 * the 24-hour window is far shorter than any purge, so an old key can never create anything.
 */
import { createHash, randomUUID } from "node:crypto";

import type { BdTx } from "../bd-tx";
import { abandonPendingFile } from "../files/business-docs-files";

export type RequestOperation = "QUOTE_SHARE_COPY" | "QUOTE_SHARE_EVENT" | "LETTER_SAVE";
export const REQUEST_OPERATIONS: readonly RequestOperation[] = ["QUOTE_SHARE_COPY", "QUOTE_SHARE_EVENT", "LETTER_SAVE"];
export const REQUEST_KEY_WINDOW_HOURS = 24;
export const REQUEST_LEASE_SECONDS = 120;

export type RequestErrorCode = "UNKNOWN_KEY" | "EXPIRED" | "IDEMPOTENCY_CONFLICT" | "IN_PROGRESS" | "LEASE_LOST";

export class BusinessDocumentsRequestError extends Error {
  constructor(readonly code: RequestErrorCode) {
    super(code);
    this.name = "BusinessDocumentsRequestError";
  }
  get status(): number {
    return this.code === "UNKNOWN_KEY" || this.code === "EXPIRED" ? 410 : 409;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isRequestKey(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** Canonical JSON (sorted keys) → sha256: the fingerprint of a request body. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}
export const requestHashOf = (body: unknown): string => createHash("sha256").update(canonicalJson(body)).digest("hex");

export async function issueRequestKey(tx: BdTx, businessId: number, userId: number, operation: RequestOperation): Promise<string> {
  const key = randomUUID();
  await tx.$executeRaw`
    INSERT INTO "BusinessDocumentRequest" ("businessId", "operation", "idempotencyKey", "issuedByUserId")
    VALUES (${businessId}, ${operation}::"BusinessDocumentOperation", ${key}::uuid, ${userId})`;
  return key;
}

export type Claim =
  | { kind: "CLAIMED"; requestId: number; leaseOwner: string }
  | { kind: "REPLAY"; resultId: number; fileId: number | null };

/** Inside the caller's tenant transaction. Throws BusinessDocumentsRequestError for every refusal. */
export async function claimRequest(tx: BdTx, businessId: number, operation: RequestOperation, key: string, requestHash: string): Promise<Claim> {
  if (!isRequestKey(key)) throw new BusinessDocumentsRequestError("UNKNOWN_KEY");
  const rows = await tx.$queryRaw<{ id: number; state: string; requestHash: string | null; fileId: number | null; resultId: number | null; fresh: boolean; leaseLive: boolean }[]>`
    SELECT "id", "state"::text AS "state", "requestHash", "fileId", "resultId",
           "issuedAt" > CURRENT_TIMESTAMP - make_interval(hours => ${REQUEST_KEY_WINDOW_HOURS}::int) AS "fresh",
           ("leaseUntil" IS NOT NULL AND "leaseUntil" >= CURRENT_TIMESTAMP) AS "leaseLive"
      FROM "BusinessDocumentRequest"
     WHERE "businessId" = ${businessId} AND "operation" = ${operation}::"BusinessDocumentOperation" AND "idempotencyKey" = ${key}::uuid
     FOR UPDATE`;
  const r = rows[0];
  if (!r) throw new BusinessDocumentsRequestError("UNKNOWN_KEY");
  if (!r.fresh) throw new BusinessDocumentsRequestError("EXPIRED");
  if (r.requestHash && r.requestHash !== requestHash) throw new BusinessDocumentsRequestError("IDEMPOTENCY_CONFLICT");
  if (r.state === "DONE") return { kind: "REPLAY", resultId: r.resultId as number, fileId: r.fileId };
  if (r.state === "IN_PROGRESS" && r.leaseLive) throw new BusinessDocumentsRequestError("IN_PROGRESS");
  if (r.state === "IN_PROGRESS" && r.fileId !== null) await abandonPendingFile(tx, businessId, r.fileId);
  const leaseOwner = randomUUID();
  await tx.$executeRaw`
    UPDATE "BusinessDocumentRequest"
       SET "state" = 'IN_PROGRESS', "requestHash" = ${requestHash}, "leaseOwner" = ${leaseOwner}::uuid,
           "leaseUntil" = CURRENT_TIMESTAMP + make_interval(secs => ${REQUEST_LEASE_SECONDS}::double precision), "fileId" = NULL
     WHERE "id" = ${r.id}`;
  return { kind: "CLAIMED", requestId: r.id, leaseOwner };
}

/** Record the pending file of a claimed request (so a takeover can abandon it). Only the lease holder. */
export async function attachRequestFile(tx: BdTx, requestId: number, leaseOwner: string, fileId: number): Promise<void> {
  const n = await tx.$executeRaw`
    UPDATE "BusinessDocumentRequest" SET "fileId" = ${fileId}
     WHERE "id" = ${requestId} AND "state" = 'IN_PROGRESS' AND "leaseOwner" = ${leaseOwner}::uuid`;
  if (n !== 1) throw new BusinessDocumentsRequestError("LEASE_LOST");
}

/** DONE with its result — only by the lease holder (a taken-over request can never complete). */
export async function completeRequest(tx: BdTx, requestId: number, leaseOwner: string, resultId: number): Promise<void> {
  const n = await tx.$executeRaw`
    UPDATE "BusinessDocumentRequest"
       SET "state" = 'DONE', "resultId" = ${resultId}, "completedAt" = CURRENT_TIMESTAMP, "leaseOwner" = NULL, "leaseUntil" = NULL
     WHERE "id" = ${requestId} AND "state" = 'IN_PROGRESS' AND "leaseOwner" = ${leaseOwner}::uuid`;
  if (n !== 1) throw new BusinessDocumentsRequestError("LEASE_LOST");
}

/** Give the key back (e.g. the quote changed during the render): the same request may be retried at once. */
export async function releaseRequest(tx: BdTx, requestId: number, leaseOwner: string): Promise<void> {
  await tx.$executeRaw`
    UPDATE "BusinessDocumentRequest" SET "state" = 'ISSUED', "leaseOwner" = NULL, "leaseUntil" = NULL, "fileId" = NULL
     WHERE "id" = ${requestId} AND "state" = 'IN_PROGRESS' AND "leaseOwner" = ${leaseOwner}::uuid`;
}
