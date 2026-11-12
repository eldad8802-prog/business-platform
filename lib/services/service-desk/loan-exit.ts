/**
 * Service Desk loans — what the CASE commands need of the loans (migration 20261201090000), kept apart from loans.service so
 * service-case.service can use it without an import cycle. SERVER-ONLY.
 *   - caseHasOpenLoan: the core's openLoaner, read under the case lock (every loan write locks the case row first);
 *   - recordLoanerExitApproval: CANCEL / ABANDON with a loan OUT — the approval recorded on every OUT loan, bound to the case
 *     event; the loan itself stays OUT (a case exit never releases, returns or deletes equipment at the customer).
 */
import { ServiceDeskError } from "./service-desk-errors";
import type { Prepared, Tx } from "./service-case.service";

/** Migration 20261201090000 is applied (fail closed: without it nothing is written or read). */
export async function loansReady(tx: Tx): Promise<boolean> {
  const r = await tx.$queryRaw<{ ok: boolean }[]>`SELECT (to_regclass('public."ServiceLoan"') IS NOT NULL AND to_regclass('public."ServiceLoanEvent"') IS NOT NULL) AS ok`;
  return r[0]?.ok === true;
}
/** For the case lock of service-case.service: is a loan of this case OUT? (false while the migration is not applied — no loan can exist). */
export async function caseHasOpenLoan(tx: Tx, businessId: number, caseId: number): Promise<boolean> {
  if (!(await loansReady(tx))) return false;
  const r = await tx.$queryRaw<{ ok: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM "ServiceLoan" WHERE "businessId" = ${businessId}::int AND "caseId" = ${caseId}::int AND state = 'OUT') AS ok`;
  return r[0]?.ok === true;
}

// ── The case exit (CANCEL / ABANDON with a loan OUT) — called by service-case.service commitTransition ──────────

/**
 * AFTER the case update and its event (seq = caseSeq) in the same transaction: every OUT loan of the case gets its
 * CASE_EXIT_APPROVED journal event (version + 1, nothing else changes) with the approval kind, the approver (the
 * server-resolved grant = the acting user), the reason, and the case seq it approves. The loan stays OUT. Each event has
 * its own key derived from the request's key (deriveIdempotencyKey) so a replay finds it.
 */
export async function recordLoanerExitApproval(
  tx: Tx, b: number, caseId: number, caseSeq: number, kind: "CANCEL_OPEN_LOANER" | "ABANDON_OPEN_LOANER",
  approver: number, reason: string, userId: number, prepared: Prepared, deriveKey: (step: string) => string,
): Promise<number> {
  const loans = await tx.$queryRaw<{ id: number; version: number; e: string | null }[]>`
    SELECT id, version, to_char("expectedReturnOn", 'YYYY-MM-DD') AS e FROM "ServiceLoan"
     WHERE "businessId" = ${b}::int AND "caseId" = ${caseId}::int AND state = 'OUT' ORDER BY id FOR UPDATE`;
  for (const l of loans) {
    const next = Number(l.version) + 1;
    const n = await tx.$executeRaw`
      UPDATE "ServiceLoan" SET version = ${next}::int, "lastEventKind" = 'CASE_EXIT_APPROVED', "updatedAt" = now()
       WHERE id = ${l.id}::int AND "businessId" = ${b}::int AND version = ${Number(l.version)}::int AND state = 'OUT'`;
    if (n !== 1) throw new ServiceDeskError("VERSION_CONFLICT");
    await tx.$executeRaw`
      INSERT INTO "ServiceLoanEvent" ("businessId", "loanId", "caseId", seq, kind, "stateAfter", "expectedReturnOn", "approvalKind", "approvedByUserId",
        reason, "caseSeq", actor, "actorUserId", payload, "idempotencyKey", "requestDigest", "digestKeyId")
      VALUES (${b}::int, ${l.id}::int, ${caseId}::int, ${next}::int, 'CASE_EXIT_APPROVED', 'OUT', ${l.e}::date, ${kind}::"ServiceLoanApprovalKind", ${approver}::int,
        ${reason}::text, ${caseSeq}::int, 'OWNER_USER', ${userId}::int, ${JSON.stringify({ caseAction: kind === "CANCEL_OPEN_LOANER" ? "CANCEL" : "ABANDON" })}::jsonb,
        ${deriveKey(`loanexit${l.id}`)}::text, ${prepared.digest.value}::text, ${prepared.digest.keyId}::text)`;
  }
  return loans.length;
}
