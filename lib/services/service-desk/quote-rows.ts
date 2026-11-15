/**
 * Service Desk 1.3c — the ServiceQuote writes, inside a case command's transaction (the case row is already locked FOR
 * UPDATE by the caller). SERVER-ONLY. Kept apart from quote.service so the case service can apply the quote effects
 * (WITHDRAW_OPEN_QUOTE on a cancel, SUPERSEDE_OPEN_QUOTE on a revision) without importing the render path.
 *
 * The table's guards re-check every write (migration 20261112090000): content immutable, a decision leaves SENT exactly
 * once, one SENT version per case, the billing document a QUOTE of the same business, the key under biz/<b>/service/.
 */
import type { ServiceQuoteRef } from "./contracts";
import { supersedeQuote, withdrawQuote } from "./service-case.core";
import { ServiceDeskError, refused } from "./service-desk-errors";
import type { Tx } from "./service-case.service";

/** A version as the send / revise command prepared it: the frozen copy is already stored, the content hash computed. */
export type FrozenQuote = {
  version: number;
  billingDocumentId: number;
  totalAgorot: number;
  docHash: string;
  sentPdfKey: string;
  sentPdfSha256: string;
};

type Row = { version: number; totalAgorot: number; docHash: string; state: string };

async function sentRow(tx: Tx, b: number, caseId: number, version: number): Promise<Row | null> {
  const r = (await tx.$queryRaw<{ version: number; totalAgorot: number; docHash: string; state: string }[]>`
    SELECT version, "totalAgorot", "docHash", state::text AS state FROM "ServiceQuote"
     WHERE "businessId" = ${b}::int AND "caseId" = ${caseId}::int AND version = ${version}::int`)[0];
  return r ? { version: Number(r.version), totalAgorot: Number(r.totalAgorot), docHash: String(r.docHash), state: String(r.state) } : null;
}

/** Close the open version as WITHDRAWN (a cancel) or SUPERSEDED (a revision) — the core's rule, then the row, exactly once. */
async function closeOpen(tx: Tx, b: number, caseId: number, ref: ServiceQuoteRef, next: "WITHDRAWN" | "SUPERSEDED", userId: number) {
  const row = await sentRow(tx, b, caseId, ref.version);
  if (!row) throw new ServiceDeskError("SERVER_CHECK_FAILED", { check: "OPEN_QUOTE_PRESENT" });
  const snapshot = { version: row.version, totalAgorot: row.totalAgorot, docHash: row.docHash, state: row.state as never, approval: null };
  const d = next === "WITHDRAWN" ? withdrawQuote(snapshot, ref) : supersedeQuote(snapshot, ref);
  if (!d.ok) throw refused(d.violations);
  // decidedByActor OWNER_USER with the acting user (CHECK ServiceQuote_decided); no approval fields (…_approval_is_this_row).
  const n = await tx.$executeRaw`
    UPDATE "ServiceQuote" SET state = ${next}::"ServiceQuoteState", "decidedAt" = now(), "decidedByActor" = 'OWNER_USER'::"ServiceActor", "decidedByUserId" = ${userId}::int
     WHERE "businessId" = ${b}::int AND "caseId" = ${caseId}::int AND version = ${ref.version}::int AND state = 'SENT'
       AND "totalAgorot" = ${ref.totalAgorot}::int AND "docHash" = ${ref.docHash}::text`;
  if (n !== 1) throw new ServiceDeskError("STALE_STATE");
}

export const withdrawOpenQuote = (tx: Tx, b: number, caseId: number, ref: ServiceQuoteRef, userId: number) => closeOpen(tx, b, caseId, ref, "WITHDRAWN", userId);

/** Insert a SENT version (the one open version of the case — UNIQUE ServiceQuote_one_sent_per_case). */
export async function insertSentQuote(tx: Tx, b: number, caseId: number, q: FrozenQuote, userId: number) {
  await tx.$executeRaw`
    INSERT INTO "ServiceQuote" ("businessId", "caseId", version, "billingDocumentId", "totalAgorot", currency, "docHash", "sentPdfKey", "sentPdfSha256", "sentByUserId")
    VALUES (${b}::int, ${caseId}::int, ${q.version}::int, ${q.billingDocumentId}::int, ${q.totalAgorot}::int, 'ILS', ${q.docHash}::text,
            ${q.sentPdfKey}::text, ${q.sentPdfSha256}::text, ${userId}::int)`;
}

/** REVISE_QUOTE (ז-1 A): N → SUPERSEDED, then N+1 inserted as the one SENT version — both in the caller's transaction. */
export async function supersedeOpenQuote(tx: Tx, b: number, caseId: number, superseded: ServiceQuoteRef, next: ServiceQuoteRef, frozen: FrozenQuote | undefined, userId: number) {
  if (!frozen || frozen.version !== next.version || frozen.totalAgorot !== next.totalAgorot || frozen.docHash !== next.docHash) {
    // Only the revise command carries the prepared next version; any other path asking for it is refused.
    throw new ServiceDeskError("ACTION_NOT_IN_SCOPE", { effects: ["SUPERSEDE_OPEN_QUOTE"] });
  }
  await closeOpen(tx, b, caseId, superseded, "SUPERSEDED", userId);
  await insertSentQuote(tx, b, caseId, frozen, userId);
}
