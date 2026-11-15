/**
 * Service Desk loans — a temporary replacement item lent to the customer during service. The data service over the pure
 * core (loans.core.ts) and the tables of migration 20261201090000_service_desk_loans. SERVER-ONLY.
 *
 * Every command is ONE tenant transaction with the module's rules (service-case.service.ts):
 *   lock the CASE row (FOR UPDATE — the lock the cancel, the abandon, the handover and every loan write take, so they
 *   serialise per case) → then the loan row → an earlier answer for this Idempotency-Key? (the loan journal is the ledger:
 *   same key + same request → the stored result; same key + another request → IDEMPOTENCY_KEY_REUSED) → the version the
 *   client saw → the core → approvals resolved server-side (approvals.ts; never from the request) → the row + its journal
 *   event with the key and the request digest.
 *   - lend      a new loan of the case (LENT, version 1); outside the work statuses only as LEND_OUTSIDE_WORK;
 *   - return    OUT → RETURNED with the condition; allowed in any case status (also delivered / closed / cancelled);
 *   - close     OUT → CLOSED (LOST / KEPT_BY_CUSTOMER / WRITTEN_OFF) with a reason, approved (LOAN_CLOSE_UNRETURNED);
 *   - expected return date changed while OUT.
 * The cancel / abandon / handover side lives in service-case.service.ts (the core's OPEN_LOANER, CANCEL_OPEN_LOANER,
 * ABANDON_OPEN_LOANER, HANDOVER_OPEN_LOANER). The database re-checks every rule.
 *
 * NOT here, on purpose: no stock movement — a loan may name an inventory item READ-ONLY; the inventory movement contract
 * (M0) is not ready. No customer signature anywhere (owner decision 2026-11-11).
 */
import { Prisma } from "@prisma/client";

import { tenantTx } from "@/lib/tenant/tenant-tx";
import { checkIdempotencyKey, digestWithKeyId, sameDigest } from "@/lib/services/tasks/task-idempotency";

import { approverFor, resolveApprovals } from "./approvals";
import { loansReady } from "./loan-exit";
import type { ServiceApprovalKind } from "./contracts";
import { LOAN_CLOSE_REASONS, LOAN_CONDITIONS, type LendInput, type LoanAction, type LoanCaseFacts, type LoanSnapshot, type LoanState, type LoanViolation } from "./loans.contracts";
import { checkLoanEnvelope, evaluateLoanAction, planLend } from "./loans.core";
import { guardRefusal, isPositiveInt, isUniqueViolation, prepare, type Prepared, type ServiceDeskPrincipal, type Tx, type WriteRequest } from "./service-case.service";
import { ServiceDeskError } from "./service-desk-errors";

// ── Availability ──────────────────────────────────────────────────────────────────────────────────────────────

async function requireLoans(tx: Tx) {
  if (!(await loansReady(tx))) throw new ServiceDeskError("NOT_AVAILABLE_UNTIL_MIGRATION", { migration: "20261201090000_service_desk_loans" });
}

// ── Views ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type LoanView = {
  id: number; caseId: number; caseNumber: number | null; state: LoanState; version: number; lastEventKind: string;
  itemName: string | null; itemIdentifier: string | null; inventoryItemId: number | null; inventoryItemName: string | null;
  lentAt: string; lentByUserId: number | null; conditionAtLend: string; lendNote: string | null; expectedReturnOn: string | null;
  overdue: boolean;
  exception: { reason: string | null; approvedByUserId: number | null; approvedAt: string | null } | null;
  returnedAt: string | null; returnedByUserId: number | null; conditionAtReturn: string | null; returnNote: string | null;
  closedAt: string | null; closedByUserId: number | null; closeReason: string | null; closeNote: string | null;
  closeApprovedByUserId: number | null; closeApprovedAt: string | null;
};
export type LoanEventView = {
  seq: number; kind: string; stateAfter: string; expectedReturnOn: string | null; condition: string | null;
  approvalKind: string | null; approvedByUserId: number | null; reason: string | null; caseSeq: number | null;
  actorUserId: number | null; occurredAt: string;
};

const ISO = (col: string) => Prisma.raw(`to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);
const LOAN_COLUMNS = Prisma.sql`l.id, l."caseId", c."caseNumber", l.state::text AS state, l.version, l."lastEventKind"::text AS "lastEventKind",
  l."itemName", l."itemIdentifier", l."inventoryItemId", i.name AS "inventoryItemName", ${ISO('l."lentAt"')} AS "lentAt", l."lentByUserId",
  l."conditionAtLend"::text AS "conditionAtLend", l."lendNote", to_char(l."expectedReturnOn", 'YYYY-MM-DD') AS "expectedReturnOn",
  (l.state = 'OUT' AND l."expectedReturnOn" IS NOT NULL AND l."expectedReturnOn" < (now() AT TIME ZONE 'Asia/Jerusalem')::date) AS overdue,
  l."lendExceptionReason", l."lendApprovedByUserId", ${ISO('l."lendApprovedAt"')} AS "lendApprovedAt",
  ${ISO('l."returnedAt"')} AS "returnedAt", l."returnedByUserId", l."conditionAtReturn"::text AS "conditionAtReturn", l."returnNote",
  ${ISO('l."closedAt"')} AS "closedAt", l."closedByUserId", l."closeReason"::text AS "closeReason", l."closeNote",
  l."closeApprovedByUserId", ${ISO('l."closeApprovedAt"')} AS "closeApprovedAt"`;
const LOAN_FROM = Prisma.sql`"ServiceLoan" l
  LEFT JOIN "ServiceCase" c ON c.id = l."caseId" AND c."businessId" = l."businessId"
  LEFT JOIN "InventoryItem" i ON i.id = l."inventoryItemId" AND i."businessId" = l."businessId"`;

const num = (x: unknown) => (x === null || x === undefined ? null : Number(x));
const str = (x: unknown) => (x === null || x === undefined ? null : String(x));
const toLoan = (r: Record<string, unknown>): LoanView => ({
  id: Number(r.id), caseId: Number(r.caseId), caseNumber: num(r.caseNumber), state: r.state as LoanState, version: Number(r.version),
  lastEventKind: String(r.lastEventKind), itemName: str(r.itemName), itemIdentifier: str(r.itemIdentifier), inventoryItemId: num(r.inventoryItemId),
  inventoryItemName: str(r.inventoryItemName), lentAt: String(r.lentAt), lentByUserId: num(r.lentByUserId), conditionAtLend: String(r.conditionAtLend),
  lendNote: str(r.lendNote), expectedReturnOn: str(r.expectedReturnOn), overdue: r.overdue === true,
  exception: r.lendApprovedAt === null || r.lendApprovedAt === undefined ? null
    : { reason: str(r.lendExceptionReason), approvedByUserId: num(r.lendApprovedByUserId), approvedAt: str(r.lendApprovedAt) },
  returnedAt: str(r.returnedAt), returnedByUserId: num(r.returnedByUserId), conditionAtReturn: str(r.conditionAtReturn), returnNote: str(r.returnNote),
  closedAt: str(r.closedAt), closedByUserId: num(r.closedByUserId), closeReason: str(r.closeReason), closeNote: str(r.closeNote),
  closeApprovedByUserId: num(r.closeApprovedByUserId), closeApprovedAt: str(r.closeApprovedAt),
});

async function loanOf(tx: Tx, b: number, loanId: number): Promise<LoanView> {
  const rows = await tx.$queryRaw<Record<string, unknown>[]>`SELECT ${LOAN_COLUMNS} FROM ${LOAN_FROM} WHERE l.id = ${loanId}::int AND l."businessId" = ${b}::int`;
  if (!rows[0]) throw new ServiceDeskError("NOT_FOUND");
  return toLoan(rows[0]);
}

async function eventsOf(tx: Tx, b: number, where: Prisma.Sql): Promise<(LoanEventView & { loanId: number })[]> {
  const rows = await tx.$queryRaw<Record<string, unknown>[]>`
    SELECT "loanId", seq, kind::text AS kind, "stateAfter"::text AS "stateAfter", to_char("expectedReturnOn", 'YYYY-MM-DD') AS "expectedReturnOn",
           condition::text AS condition, "approvalKind"::text AS "approvalKind", "approvedByUserId", reason, "caseSeq", "actorUserId", ${ISO('"occurredAt"')} AS "occurredAt"
      FROM "ServiceLoanEvent" WHERE "businessId" = ${b}::int AND ${where} ORDER BY "loanId", seq`;
  return rows.map((e) => ({
    loanId: Number(e.loanId), seq: Number(e.seq), kind: String(e.kind), stateAfter: String(e.stateAfter), expectedReturnOn: str(e.expectedReturnOn),
    condition: str(e.condition), approvalKind: str(e.approvalKind), approvedByUserId: num(e.approvedByUserId), reason: str(e.reason),
    caseSeq: num(e.caseSeq), actorUserId: num(e.actorUserId), occurredAt: String(e.occurredAt),
  }));
}

/** The case's loans, newest first, each with its journal (oldest first). FULL and READ_ONLY. */
export async function listCaseLoans(businessId: number, caseId: unknown): Promise<{ loans: (LoanView & { events: LoanEventView[] })[] }> {
  if (!isPositiveInt(caseId)) throw new ServiceDeskError("NOT_FOUND");
  return tenantTx(businessId, async (tx) => {
    await requireLoans(tx);
    const exists = await tx.$queryRaw<{ ok: boolean }[]>`SELECT EXISTS (SELECT 1 FROM "ServiceCase" WHERE id = ${caseId}::int AND "businessId" = ${businessId}::int) AS ok`;
    if (exists[0]?.ok !== true) throw new ServiceDeskError("NOT_FOUND");
    const loans = (await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT ${LOAN_COLUMNS} FROM ${LOAN_FROM} WHERE l."caseId" = ${caseId}::int AND l."businessId" = ${businessId}::int ORDER BY l.id DESC`).map(toLoan);
    const events = loans.length === 0 ? [] : await eventsOf(tx, businessId, Prisma.sql`"caseId" = ${caseId}::int`);
    return { loans: loans.map((l) => ({ ...l, events: events.filter((e) => e.loanId === l.id).map(({ loanId: _l, ...e }) => e) })) };
  });
}

export const LOAN_LIST_MAX = 100;
/** The business's loans (default: every loan still OUT, oldest first — "what is at customers now"). FULL and READ_ONLY. */
export async function listLoans(businessId: number, q: { state?: unknown; overdue?: unknown; limit?: unknown } = {}): Promise<{ loans: LoanView[] }> {
  const state = q.state === undefined || q.state === null || q.state === "" ? "OUT" : q.state;
  if (state !== "OUT" && state !== "RETURNED" && state !== "CLOSED" && state !== "ALL") throw new ServiceDeskError("INVALID_INPUT", { field: "state" });
  const overdue = q.overdue === "true" || q.overdue === true;
  const limit = q.limit === undefined || q.limit === null || q.limit === "" ? 50 : Number(q.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > LOAN_LIST_MAX) throw new ServiceDeskError("INVALID_INPUT", { field: "limit" });
  return tenantTx(businessId, async (tx) => {
    await requireLoans(tx);
    const rows = await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT ${LOAN_COLUMNS} FROM ${LOAN_FROM}
       WHERE l."businessId" = ${businessId}::int AND (${state}::text = 'ALL' OR l.state::text = ${state}::text)
         AND (NOT ${overdue}::boolean OR (l.state = 'OUT' AND l."expectedReturnOn" < (now() AT TIME ZONE 'Asia/Jerusalem')::date))
       ORDER BY l."lentAt", l.id LIMIT ${limit}::int`;
    return { loans: rows.map(toLoan) };
  });
}

// ── Commands ──────────────────────────────────────────────────────────────────────────────────────────────────

function refusedBy(violations: readonly LoanViolation[]): ServiceDeskError {
  const codes = [...new Set(violations.map((x) => x.code))];
  if (codes.length === 1 && codes[0] === "VERSION_CONFLICT") return new ServiceDeskError("VERSION_CONFLICT");
  return new ServiceDeskError("REFUSED", { violations: codes });
}

/** The case row FOR UPDATE (first, always) and what a loan needs of it. */
async function lockCaseForLoan(tx: Tx, b: number, caseId: number): Promise<LoanCaseFacts> {
  const r = (await tx.$queryRaw<{ status: string; outcome: string | null; cr: boolean }[]>`
    SELECT status::text AS status, outcome::text AS outcome, "cancellationRequested" AS cr
      FROM "ServiceCase" WHERE id = ${caseId}::int AND "businessId" = ${b}::int FOR UPDATE`)[0];
  if (!r) throw new ServiceDeskError("NOT_FOUND");
  return { status: r.status, outcome: r.outcome, cancellationRequested: r.cr === true };
}

/** An earlier answer for this key: the loan journal is the ledger. */
async function findPriorLoanEvent(tx: Tx, b: number, prepared: Prepared): Promise<{ loanId: number; caseId: number } | null> {
  const origin = (await tx.$queryRaw<{ loanId: number; caseId: number; d: string | null; k: string | null }[]>`
    SELECT "loanId", "caseId", "requestDigest" AS d, "digestKeyId" AS k FROM "ServiceLoanEvent" WHERE "businessId" = ${b}::int AND "idempotencyKey" = ${prepared.key}::text`)[0];
  if (!origin) return null;
  if (!origin.d || !origin.k) throw new ServiceDeskError("IDEMPOTENCY_KEY_REUSED");
  const expected = digestWithKeyId(prepared.keys, origin.k, prepared.ident);
  if (!expected || !sameDigest(expected, origin.d)) throw new ServiceDeskError("IDEMPOTENCY_KEY_REUSED");
  return { loanId: Number(origin.loanId), caseId: Number(origin.caseId) };
}

/** lock the case → migration present → earlier answer? → key young enough → work; a unique race is retried once. */
async function loanCommand<T>(
  p: ServiceDeskPrincipal, prepared: Prepared, caseId: number,
  run: (tx: Tx, facts: LoanCaseFacts) => Promise<T>,
  replay: (tx: Tx, prior: { loanId: number; caseId: number }) => Promise<T>,
): Promise<T> {
  const b = p.businessId;
  const attempt = () => tenantTx(b, async (tx) => {
    await requireLoans(tx);
    const facts = await lockCaseForLoan(tx, b, caseId);
    const prior = await findPriorLoanEvent(tx, b, prepared);
    if (prior) {
      if (prior.caseId !== caseId) throw new ServiceDeskError("IDEMPOTENCY_KEY_REUSED");
      return replay(tx, prior);
    }
    const verdict = checkIdempotencyKey(prepared.key, prepared.now);
    if (!verdict.ok) throw new ServiceDeskError(verdict.code);
    return run(tx, facts);
  }, { timeoutMs: 15_000 });
  const mapped = (e: unknown): unknown => {
    if (e instanceof ServiceDeskError) return e;
    return guardRefusal(e) ?? e;
  };
  try {
    return await attempt();
  } catch (e) {
    if (!(e instanceof ServiceDeskError) && isUniqueViolation(e)) {
      // A concurrent request committed first: the same key (the retry answers from its event), or the same identified
      // item lent by the double-loan index (the retry's check, under the case lock, sees it OUT → LOAN_ITEM_ALREADY_OUT).
      try { return await attempt(); } catch (e2) {
        if (!(e2 instanceof ServiceDeskError) && isUniqueViolation(e2)) throw new ServiceDeskError("CONFLICT");
        throw mapped(e2);
      }
    }
    throw mapped(e);
  }
}

const optText = (x: unknown, field: string): string | null => {
  if (x === undefined || x === null) return null;
  if (typeof x !== "string") throw new ServiceDeskError("INVALID_INPUT", { field });
  return x;
};

export type LoanCommandResult = { loan: LoanView; replayed: boolean };

/** POST /cases/[id]/loans — lend an item to the customer of the case. */
export async function lendLoaner(
  p: ServiceDeskPrincipal,
  caseId: unknown,
  body: { itemName?: unknown; itemIdentifier?: unknown; inventoryItemId?: unknown; conditionAtLend?: unknown; lendNote?: unknown; expectedReturnOn?: unknown; exceptionReason?: unknown },
  req: WriteRequest,
): Promise<LoanCommandResult> {
  if (!isPositiveInt(caseId)) throw new ServiceDeskError("NOT_FOUND");
  if (typeof body.itemName !== "string") throw new ServiceDeskError("INVALID_INPUT", { field: "itemName" });
  if (!(LOAN_CONDITIONS as readonly string[]).includes(body.conditionAtLend as string)) throw new ServiceDeskError("INVALID_INPUT", { field: "conditionAtLend" });
  if (body.inventoryItemId !== undefined && body.inventoryItemId !== null && !isPositiveInt(body.inventoryItemId)) throw new ServiceDeskError("INVALID_INPUT", { field: "inventoryItemId" });
  const input: LendInput = {
    itemName: body.itemName,
    itemIdentifier: optText(body.itemIdentifier, "itemIdentifier"),
    inventoryItemId: (body.inventoryItemId ?? null) as number | null,
    conditionAtLend: body.conditionAtLend as LendInput["conditionAtLend"],
    lendNote: optText(body.lendNote, "lendNote"),
    expectedReturnOn: optText(body.expectedReturnOn, "expectedReturnOn"),
    exceptionReason: optText(body.exceptionReason, "exceptionReason"),
  };
  const prepared = prepare(p, req, "service-desk/loans:lend", { caseId, ...input });
  const b = p.businessId;
  return loanCommand<LoanCommandResult>(p, prepared, caseId, async (tx, facts) => {
    const d = planLend(facts, input, { kind: "OWNER", userId: p.userId });
    if (!d.ok) throw refusedBy(d.violations);
    const approvals = resolveApprovals(p, d.approvals as ServiceApprovalKind[]);
    const approver = approverFor(approvals, d.approvals as ServiceApprovalKind[], "LEND_OUTSIDE_WORK", { businessId: b, userId: p.userId });
    if ((approver !== null) !== (d.row.exceptionReason !== null)) throw new ServiceDeskError("SERVER_CHECK_FAILED", { check: "LEND_EXCEPTION_DECIDED" });
    // server checks against the database (the FK and the index decide as well)
    if (d.row.inventoryItemId !== null) {
      const r = await tx.$queryRaw<{ ok: boolean }[]>`SELECT EXISTS (SELECT 1 FROM "InventoryItem" WHERE id = ${d.row.inventoryItemId}::int AND "businessId" = ${b}::int) AS ok`;
      if (r[0]?.ok !== true) throw new ServiceDeskError("SERVER_CHECK_FAILED", { check: "INVENTORY_ITEM_BELONGS_TO_BUSINESS" });
    }
    // A second OUT loan of the same identified item: refused here when it is already committed; a concurrent one is
    // decided by the partial UNIQUE index (race-safe), and loanCommand's retry then answers LOAN_ITEM_ALREADY_OUT from here.
    if (d.row.itemIdentifierNormalized !== null) {
      const r = await tx.$queryRaw<{ ok: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM "ServiceLoan" WHERE "businessId" = ${b}::int AND "itemIdentifierNormalized" = ${d.row.itemIdentifierNormalized}::text AND state = 'OUT') AS ok`;
      if (r[0]?.ok === true) throw new ServiceDeskError("REFUSED", { violations: ["LOAN_ITEM_ALREADY_OUT"] });
    }
    const row = d.row;
    // the database stamps lentAt / lendApprovedAt and normalizes the identifier itself (service_loan_insert_guard)
    const loanId = Number((await tx.$queryRaw<{ id: number }[]>`
      INSERT INTO "ServiceLoan" ("businessId", "caseId", "itemName", "itemIdentifier", "inventoryItemId", "lentByUserId", "conditionAtLend",
        "lendNote", "expectedReturnOn", "lendExceptionReason", "lendApprovedByUserId", "updatedAt")
      VALUES (${b}::int, ${caseId}::int, ${row.itemName}::text, ${row.itemIdentifier}::text, ${row.inventoryItemId}::int, ${p.userId}::int,
        ${row.conditionAtLend}::"ServiceLoanCondition", ${row.lendNote}::text, ${row.expectedReturnOn}::date, ${row.exceptionReason}::text, ${approver}::int, now())
      RETURNING id`)[0].id);
    await tx.$executeRaw`
      INSERT INTO "ServiceLoanEvent" ("businessId", "loanId", "caseId", seq, kind, "stateAfter", "expectedReturnOn", condition, "approvalKind",
        "approvedByUserId", reason, actor, "actorUserId", payload, "idempotencyKey", "requestDigest", "digestKeyId")
      VALUES (${b}::int, ${loanId}::int, ${caseId}::int, 1, 'LENT', 'OUT', ${row.expectedReturnOn}::date, ${row.conditionAtLend}::"ServiceLoanCondition",
        ${approver === null ? null : "LEND_OUTSIDE_WORK"}::"ServiceLoanApprovalKind", ${approver}::int, ${row.exceptionReason}::text,
        'OWNER_USER', ${p.userId}::int, ${JSON.stringify(d.payload)}::jsonb, ${prepared.key}::text, ${prepared.digest.value}::text, ${prepared.digest.keyId}::text)`;
    return { loan: await loanOf(tx, b, loanId), replayed: false };
  }, async (tx, prior) => ({ loan: await loanOf(tx, b, prior.loanId), replayed: true }));
}

function loanActionFrom(raw: Record<string, unknown>): LoanAction {
  switch (raw.type) {
    case "RETURN":
      if (!(LOAN_CONDITIONS as readonly string[]).includes(raw.conditionAtReturn as string)) throw new ServiceDeskError("INVALID_INPUT", { field: "action.conditionAtReturn" });
      return { type: "RETURN", conditionAtReturn: raw.conditionAtReturn as never, returnNote: optText(raw.returnNote, "action.returnNote") };
    case "CLOSE_UNRETURNED":
      if (!(LOAN_CLOSE_REASONS as readonly string[]).includes(raw.closeReason as string)) throw new ServiceDeskError("INVALID_INPUT", { field: "action.closeReason" });
      if (typeof raw.reason !== "string") throw new ServiceDeskError("INVALID_INPUT", { field: "action.reason" });
      return { type: "CLOSE_UNRETURNED", closeReason: raw.closeReason as never, reason: raw.reason };
    case "CHANGE_EXPECTED_RETURN":
      if (raw.expectedReturnOn !== null && typeof raw.expectedReturnOn !== "string") throw new ServiceDeskError("INVALID_INPUT", { field: "action.expectedReturnOn" });
      return { type: "CHANGE_EXPECTED_RETURN", expectedReturnOn: raw.expectedReturnOn as string | null };
    default:
      throw new ServiceDeskError("INVALID_INPUT", { field: "action.type" });
  }
}

/** POST /cases/[id]/loans/[loanId]/actions — RETURN, CLOSE_UNRETURNED (approved), CHANGE_EXPECTED_RETURN. */
export async function runLoanAction(
  p: ServiceDeskPrincipal,
  caseId: unknown,
  loanId: unknown,
  body: { action?: unknown; expectedVersion?: unknown },
  req: WriteRequest,
): Promise<LoanCommandResult> {
  if (!isPositiveInt(caseId) || !isPositiveInt(loanId)) throw new ServiceDeskError("NOT_FOUND");
  if (!body.action || typeof body.action !== "object" || Array.isArray(body.action)) throw new ServiceDeskError("INVALID_INPUT", { field: "action" });
  if (!isPositiveInt(body.expectedVersion)) throw new ServiceDeskError("INVALID_INPUT", { field: "expectedVersion" });
  const action = loanActionFrom(body.action as Record<string, unknown>);
  const prepared = prepare(p, req, "service-desk/loans:action", { caseId, loanId, action, expectedVersion: body.expectedVersion });
  const b = p.businessId;
  return loanCommand<LoanCommandResult>(p, prepared, caseId, async (tx) => {
    // lock order: the case (loanCommand), then the loan — the same order as the cancel / abandon
    const r = (await tx.$queryRaw<{ state: string; version: number; e: string | null; caseId: number }[]>`
      SELECT state::text AS state, version, to_char("expectedReturnOn", 'YYYY-MM-DD') AS e, "caseId"
        FROM "ServiceLoan" WHERE id = ${loanId}::int AND "businessId" = ${b}::int FOR UPDATE`)[0];
    if (!r || Number(r.caseId) !== caseId) throw new ServiceDeskError("NOT_FOUND");
    const snap: LoanSnapshot = { state: r.state as LoanState, version: Number(r.version), expectedReturnOn: r.e ?? null };
    const env = checkLoanEnvelope(snap, body.expectedVersion);
    if (env.length > 0) throw refusedBy(env);
    const d = evaluateLoanAction(snap, action, { kind: "OWNER", userId: p.userId });
    if (!d.ok) throw refusedBy(d.violations);
    const approvals = resolveApprovals(p, d.approvals as ServiceApprovalKind[]);
    const approver = approverFor(approvals, d.approvals as ServiceApprovalKind[], "LOAN_CLOSE_UNRETURNED", { businessId: b, userId: p.userId });
    if ((approver !== null) !== (d.kind === "CLOSED")) throw new ServiceDeskError("SERVER_CHECK_FAILED", { check: "LOAN_CLOSE_APPROVED" });
    const returned = d.kind === "RETURNED", closed = d.kind === "CLOSED";
    // the database stamps returnedAt / closedAt / closeApprovedAt (service_loan_guard)
    const n = await tx.$executeRaw`
      UPDATE "ServiceLoan" SET state = ${d.stateAfter}::"ServiceLoanState", version = ${d.version}::int, "lastEventKind" = ${d.kind}::"ServiceLoanEventKind",
             "expectedReturnOn" = ${d.expectedReturnOn}::date,
             "returnedAt" = CASE WHEN ${returned}::boolean THEN now() ELSE "returnedAt" END,
             "returnedByUserId" = CASE WHEN ${returned}::boolean THEN ${p.userId}::int ELSE "returnedByUserId" END,
             "conditionAtReturn" = CASE WHEN ${returned}::boolean THEN ${d.conditionAtReturn}::"ServiceLoanCondition" ELSE "conditionAtReturn" END,
             "returnNote" = CASE WHEN ${returned}::boolean THEN ${d.returnNote}::text ELSE "returnNote" END,
             "closedAt" = CASE WHEN ${closed}::boolean THEN now() ELSE "closedAt" END,
             "closedByUserId" = CASE WHEN ${closed}::boolean THEN ${p.userId}::int ELSE "closedByUserId" END,
             "closeReason" = CASE WHEN ${closed}::boolean THEN ${d.closeReason}::"ServiceLoanCloseReason" ELSE "closeReason" END,
             "closeNote" = CASE WHEN ${closed}::boolean THEN ${d.closeNote}::text ELSE "closeNote" END,
             "closeApprovedByUserId" = CASE WHEN ${closed}::boolean THEN ${approver}::int ELSE "closeApprovedByUserId" END,
             "closeApprovedAt" = CASE WHEN ${closed}::boolean THEN now() ELSE "closeApprovedAt" END,
             "updatedAt" = now()
       WHERE id = ${loanId}::int AND "businessId" = ${b}::int AND version = ${snap.version}::int`;
    if (n !== 1) throw new ServiceDeskError("VERSION_CONFLICT");
    await tx.$executeRaw`
      INSERT INTO "ServiceLoanEvent" ("businessId", "loanId", "caseId", seq, kind, "stateAfter", "expectedReturnOn", condition, "approvalKind",
        "approvedByUserId", reason, actor, "actorUserId", payload, "idempotencyKey", "requestDigest", "digestKeyId")
      VALUES (${b}::int, ${loanId}::int, ${caseId}::int, ${d.version}::int, ${d.kind}::"ServiceLoanEventKind", ${d.stateAfter}::"ServiceLoanState",
        ${d.expectedReturnOn}::date, ${d.conditionAtReturn}::"ServiceLoanCondition", ${closed ? "LOAN_CLOSE_UNRETURNED" : null}::"ServiceLoanApprovalKind",
        ${approver}::int, ${d.closeNote}::text, 'OWNER_USER', ${p.userId}::int, ${JSON.stringify(d.payload)}::jsonb,
        ${prepared.key}::text, ${prepared.digest.value}::text, ${prepared.digest.keyId}::text)`;
    return { loan: await loanOf(tx, b, loanId), replayed: false };
  }, async (tx, prior) => {
    if (prior.loanId !== loanId) throw new ServiceDeskError("IDEMPOTENCY_KEY_REUSED");
    return { loan: await loanOf(tx, b, loanId), replayed: true };
  });
}

