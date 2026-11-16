/**
 * Service Desk 1d-A (stage 1, owner-approved 2026-11-10) — work at an external supplier: the data service over the
 * existing core (external-work.core.ts) and the existing tables of migration 20261113090000. SERVER-ONLY.
 *
 * Three commands, each ONE tenant transaction with the module's rules (service-case.service.ts):
 *   - send       lock the case → an earlier answer? → expectedVersion → planSendToExternal (the case machine + the work)
 *                → server checks against the database → case IN_REPAIR/DIAGNOSING → EXTERNAL + the case event, the work
 *                row (round n, SENT, version 1) + its event, all with the same Idempotency-Key and digest;
 *   - work action  progress, expected return date, a cost, a correction of the final cost — lock the work → an earlier
 *                answer? → expectedVersion → evaluateExternalWork → the work row + its event; the case is untouched;
 *   - return     lock the case, then the work → planReturnFromExternal → the case leaves EXTERNAL + its event, the work
 *                closes (RETURNED) + its event.
 * The database guards of 20261113090000 re-check every write (insert guard, one change kind per event, the event mirrors
 * the work, no silent change, the case cannot leave EXTERNAL with the work still out).
 *
 * Not here, on purpose: no stock movement (parts that went with a supplier block the return instead); no purchase
 * order; no customer charge — supplier cost is documentation only (ע‑8 A); an outcome REPLACED (it needs the
 * replacement device link, 1.3c) is refused as out of scope.
 *
 * CLOSED TO USERS (owner, 2026-11-10): the routes refuse before calling this service while EXTERNAL_WORK_OPEN is false
 * — until the intake confirmation path (1.3b, owner-confirmed, no customer signature) is complete and tested. The service itself is exercised by the lab.
 */
import { Prisma } from "@prisma/client";

import { tenantTx } from "@/lib/tenant/tenant-tx";
import { checkIdempotencyKey, digestWithKeyId, sameDigest } from "@/lib/services/tasks/task-idempotency";

import type { ServiceCaseAction, ServiceCaseContext } from "./contracts";
import {
  EXTERNAL_PROGRESS_STAGES,
  EXTERNAL_RETURN_RESULTS,
  type ExternalReturnInput,
  type ExternalSendInput,
  type ExternalServerCheck,
  type ExternalWorkAction,
  type ExternalWorkDecision,
  type ExternalWorkSnapshot,
} from "./external-work.contracts";
import { checkExternalEnvelope, evaluateExternalWork, planReturnFromExternal, planSendToExternal } from "./external-work.core";
import { checkCommandEnvelope } from "./service-case.core";
import {
  appendEvent,
  guardRefusal,
  isNonNegativeInt,
  isPositiveInt,
  isUniqueViolation,
  journaled,
  lockCase,
  prepare,
  stampsFor,
  staffOfBusiness,
  summaryOf,
  type CaseSummary,
  type Prepared,
  type ServiceDeskPrincipal,
  type Tx,
  type WriteRequest,
} from "./service-case.service";
import { ServiceDeskError } from "./service-desk-errors";

/**
 * Owner decision 2026-11-10: users cannot reach these actions before the intake confirmation path (1.3b, owner-confirmed, no customer signature) is done.
 * A code constant, not a flag: opening it is a reviewed change in a later PR. Every external-work route checks it first.
 */
// OPENED (this PR, for the owner's explicit approval): the 1.3b intake confirmation path is merged (#1088, #1094).
// Merging this PR is the decision.
export const EXTERNAL_WORK_OPEN = true;

export function assertExternalWorkOpen(): void {
  if (!EXTERNAL_WORK_OPEN) throw new ServiceDeskError("ACTION_NOT_IN_SCOPE", { capability: "external_work", until: "intake_confirmation_1_3b" });
}

// ── Views ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type ExternalWorkView = {
  id: number; caseId: number; round: number; supplierId: number; supplierName: string | null; deviceId: number | null;
  state: "AT_SUPPLIER" | "RETURNED"; progressStage: string; version: number; lastEventKind: string;
  supplierReference: string | null; expectedBackOn: string | null;
  estimatedCostAgorot: number | null; approvedCostAgorot: number | null; finalCostAgorot: number | null;
  sendReason: string | null; requestedWork: string | null; conditionAtSend: string | null; operationalNote: string | null;
  returnResult: string | null; workPerformed: string | null; unresolvedIssue: string | null; followUpRequired: boolean;
  receivedByStaffMemberId: number | null; sentAt: string; returnedAt: string | null;
};

export type ExternalWorkEventView = {
  seq: number; kind: string; progressStage: string; amountAgorot: number | null; previousAmountAgorot: number | null;
  expectedBackOn: string | null; actor: string; actorUserId: number | null; occurredAt: string; payload: unknown;
};

const ISO = (col: string) => Prisma.raw(`to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);
const WORK_COLUMNS = Prisma.sql`w.id, w."caseId", w.round, w."supplierId", s.name AS "supplierName", w."deviceId", w.state::text AS state,
  w."progressStage"::text AS "progressStage", w.version, w."lastEventKind"::text AS "lastEventKind", w."supplierReference",
  to_char(w."expectedBackOn", 'YYYY-MM-DD') AS "expectedBackOn", w."estimatedCostAgorot", w."approvedCostAgorot", w."finalCostAgorot",
  w."sendReason", w."requestedWork", w."conditionAtSend", w."operationalNote", w."returnResult"::text AS "returnResult",
  w."workPerformed", w."unresolvedIssue", w."followUpRequired", w."receivedByStaffMemberId",
  ${ISO('w."sentAt"')} AS "sentAt", ${ISO('w."returnedAt"')} AS "returnedAt"`;

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const toWork = (r: Record<string, unknown>): ExternalWorkView => ({
  id: Number(r.id), caseId: Number(r.caseId), round: Number(r.round), supplierId: Number(r.supplierId),
  supplierName: (r.supplierName as string) ?? null, deviceId: num(r.deviceId), state: r.state as ExternalWorkView["state"],
  progressStage: String(r.progressStage), version: Number(r.version), lastEventKind: String(r.lastEventKind),
  supplierReference: (r.supplierReference as string) ?? null, expectedBackOn: (r.expectedBackOn as string) ?? null,
  estimatedCostAgorot: num(r.estimatedCostAgorot), approvedCostAgorot: num(r.approvedCostAgorot), finalCostAgorot: num(r.finalCostAgorot),
  sendReason: (r.sendReason as string) ?? null, requestedWork: (r.requestedWork as string) ?? null,
  conditionAtSend: (r.conditionAtSend as string) ?? null, operationalNote: (r.operationalNote as string) ?? null,
  returnResult: (r.returnResult as string) ?? null, workPerformed: (r.workPerformed as string) ?? null,
  unresolvedIssue: (r.unresolvedIssue as string) ?? null, followUpRequired: r.followUpRequired === true,
  receivedByStaffMemberId: num(r.receivedByStaffMemberId), sentAt: String(r.sentAt), returnedAt: (r.returnedAt as string) ?? null,
});

async function workOf(tx: Tx, businessId: number, workId: number): Promise<ExternalWorkView> {
  const rows = await tx.$queryRaw<Record<string, unknown>[]>`
    SELECT ${WORK_COLUMNS} FROM "ServiceExternalWork" w
      LEFT JOIN "Supplier" s ON s.id = w."supplierId" AND s."businessId" = w."businessId"
     WHERE w.id = ${workId}::int AND w."businessId" = ${businessId}::int`;
  if (!rows[0]) throw new ServiceDeskError("NOT_FOUND");
  return toWork(rows[0]);
}

/** The case's supplier works, newest round first, each with its journal (oldest first). FULL and READ_ONLY. */
export async function listExternalWork(businessId: number, caseId: unknown): Promise<{ works: (ExternalWorkView & { events: ExternalWorkEventView[] })[] }> {
  if (!isPositiveInt(caseId)) throw new ServiceDeskError("NOT_FOUND");
  return tenantTx(businessId, async (tx) => {
    const exists = await tx.$queryRaw<{ ok: boolean }[]>`SELECT EXISTS (SELECT 1 FROM "ServiceCase" WHERE id = ${caseId}::int AND "businessId" = ${businessId}::int) AS ok`;
    if (exists[0]?.ok !== true) throw new ServiceDeskError("NOT_FOUND");
    const works = (await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT ${WORK_COLUMNS} FROM "ServiceExternalWork" w
        LEFT JOIN "Supplier" s ON s.id = w."supplierId" AND s."businessId" = w."businessId"
       WHERE w."caseId" = ${caseId}::int AND w."businessId" = ${businessId}::int ORDER BY w.round DESC`).map(toWork);
    const events = works.length === 0 ? [] : await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT "workId", seq, kind::text AS kind, "progressStage"::text AS "progressStage", "amountAgorot", "previousAmountAgorot",
             to_char("expectedBackOn", 'YYYY-MM-DD') AS "expectedBackOn", actor::text AS actor, "actorUserId", ${ISO('"occurredAt"')} AS "occurredAt", payload
        FROM "ServiceExternalWorkEvent" WHERE "businessId" = ${businessId}::int AND "caseId" = ${caseId}::int ORDER BY "workId", seq`;
    return {
      works: works.map((w) => ({
        ...w,
        events: events.filter((e) => Number(e.workId) === w.id).map((e) => ({
          seq: Number(e.seq), kind: String(e.kind), progressStage: String(e.progressStage), amountAgorot: num(e.amountAgorot),
          previousAmountAgorot: num(e.previousAmountAgorot), expectedBackOn: (e.expectedBackOn as string) ?? null, actor: String(e.actor),
          actorUserId: num(e.actorUserId), occurredAt: String(e.occurredAt), payload: e.payload,
        })),
      })),
    };
  });
}

// ── Shared writes ─────────────────────────────────────────────────────────────────────────────────────────────

/** The work's event, mirroring the row this transaction just wrote (the database checks it). */
async function appendWorkEvent(tx: Tx, b: number, workId: number, caseId: number, d: Extract<ExternalWorkDecision, { ok: true }>, userId: number, prepared: Prepared) {
  await tx.$executeRaw`
    INSERT INTO "ServiceExternalWorkEvent" ("businessId", "workId", "caseId", seq, kind, "progressStage", "amountAgorot", "previousAmountAgorot",
      "expectedBackOn", reason, actor, "actorUserId", payload, "idempotencyKey", "requestDigest", "digestKeyId")
    VALUES (${b}::int, ${workId}::int, ${caseId}::int, ${d.event.seq}::int, ${d.event.kind}::"ServiceExternalWorkEventKind",
      ${d.event.progressStage}::"ServiceExternalProgress", ${d.event.amountAgorot}::int, ${d.event.previousAmountAgorot}::int,
      ${d.event.expectedBackOn}::date, ${d.texts.correctionReason}::text, 'OWNER_USER'::"ServiceActor", ${userId}::int,
      ${JSON.stringify(d.event.payload)}::jsonb, ${prepared.key}::text, ${prepared.digest.value}::text, ${prepared.digest.keyId}::text)`;
}

async function verifyWorkChecks(tx: Tx, b: number, checks: readonly ExternalServerCheck[], f: { supplierId: number; deviceId: number | null; caseId: number; staffId: number | null }) {
  for (const check of checks) {
    switch (check) {
      case "SUPPLIER_BELONGS_TO_BUSINESS": {
        const r = await tx.$queryRaw<{ ok: boolean }[]>`SELECT EXISTS (SELECT 1 FROM "Supplier" WHERE id = ${f.supplierId}::int AND "businessId" = ${b}::int) AS ok`;
        if (r[0]?.ok !== true) throw new ServiceDeskError("SERVER_CHECK_FAILED", { check });
        break;
      }
      case "SUPPLIER_ACTIVE": {
        const r = await tx.$queryRaw<{ ok: boolean }[]>`SELECT EXISTS (SELECT 1 FROM "Supplier" WHERE id = ${f.supplierId}::int AND "businessId" = ${b}::int AND "isActive") AS ok`;
        if (r[0]?.ok !== true) throw new ServiceDeskError("SERVER_CHECK_FAILED", { check });
        break;
      }
      case "NO_OPEN_WORK_FOR_DEVICE": {
        if (f.deviceId === null) break;
        const r = await tx.$queryRaw<{ ok: boolean }[]>`
          SELECT NOT EXISTS (SELECT 1 FROM "ServiceExternalWork" WHERE "businessId" = ${b}::int AND "deviceId" = ${f.deviceId}::int AND state = 'AT_SUPPLIER') AS ok`;
        if (r[0]?.ok !== true) throw new ServiceDeskError("SERVER_CHECK_FAILED", { check });
        break;
      }
      case "STAFF_BELONGS_TO_BUSINESS":
        if (f.staffId === null || !(await staffOfBusiness(tx, b, f.staffId))) throw new ServiceDeskError("SERVER_CHECK_FAILED", { check });
        break;
      default:
        throw new ServiceDeskError("SERVER_CHECK_FAILED", { check });
    }
  }
}

function violationsError(violations: readonly { code: string }[]): ServiceDeskError {
  const codes = [...new Set(violations.map((x) => x.code))];
  if (codes.length === 1 && codes[0] === "VERSION_CONFLICT") return new ServiceDeskError("VERSION_CONFLICT");
  return new ServiceDeskError("REFUSED", { violations: codes });
}

const optionalText = (v: unknown, field: string) => {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new ServiceDeskError("INVALID_INPUT", { field });
  return v;
};

// ── Send ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type ExternalCommandResult = { case: CaseSummary; work: ExternalWorkView; replayed: boolean };

export async function sendToExternal(
  p: ServiceDeskPrincipal,
  caseId: unknown,
  body: { expectedVersion?: unknown; supplierId?: unknown; sendReason?: unknown; requestedWork?: unknown; conditionAtSend?: unknown; operationalNote?: unknown; supplierReference?: unknown; expectedBackOn?: unknown },
  req: WriteRequest,
): Promise<ExternalCommandResult> {
  if (!isPositiveInt(caseId)) throw new ServiceDeskError("NOT_FOUND");
  if (!isNonNegativeInt(body.expectedVersion)) throw new ServiceDeskError("INVALID_INPUT", { field: "expectedVersion" });
  if (!isPositiveInt(body.supplierId)) throw new ServiceDeskError("INVALID_INPUT", { field: "supplierId" });
  if (typeof body.sendReason !== "string") throw new ServiceDeskError("INVALID_INPUT", { field: "sendReason" });
  const input: ExternalSendInput = {
    supplierId: body.supplierId,
    sendReason: body.sendReason,
    requestedWork: optionalText(body.requestedWork, "requestedWork"),
    conditionAtSend: optionalText(body.conditionAtSend, "conditionAtSend"),
    operationalNote: optionalText(body.operationalNote, "operationalNote"),
    supplierReference: optionalText(body.supplierReference, "supplierReference"),
    expectedBackOn: optionalText(body.expectedBackOn, "expectedBackOn"),
  };
  const prepared = prepare(p, req, "service-desk/external-work:send", { caseId, expectedVersion: body.expectedVersion, ...input });
  const b = p.businessId;

  return journaled<ExternalCommandResult, Awaited<ReturnType<typeof lockCase>>>(p, prepared, (tx) => lockCase(tx, b, caseId), async (tx, { context }) => {
    const action: ServiceCaseAction = { type: "SEND_TO_EXTERNAL", supplierId: input.supplierId };
    const envelope = checkCommandEnvelope(context, { caseId, action, expectedVersion: body.expectedVersion as number, idempotencyKey: prepared.key });
    if (!envelope.ok) throw violationsError(envelope.violations);
    const facts = (await tx.$queryRaw<{ deviceId: number | null; active: boolean | null; lastRound: number; openCase: boolean; openDevice: boolean }[]>`
      SELECT c."deviceId",
             (SELECT s."isActive" FROM "Supplier" s WHERE s.id = ${input.supplierId}::int AND s."businessId" = ${b}::int) AS active,
             COALESCE((SELECT max(w.round) FROM "ServiceExternalWork" w WHERE w."caseId" = c.id AND w."businessId" = ${b}::int), 0)::int AS "lastRound",
             EXISTS (SELECT 1 FROM "ServiceExternalWork" w WHERE w."caseId" = c.id AND w."businessId" = ${b}::int AND w.state = 'AT_SUPPLIER') AS "openCase",
             (c."deviceId" IS NOT NULL AND EXISTS (SELECT 1 FROM "ServiceExternalWork" w WHERE w."deviceId" = c."deviceId" AND w."businessId" = ${b}::int AND w.state = 'AT_SUPPLIER')) AS "openDevice"
        FROM "ServiceCase" c WHERE c.id = ${caseId}::int AND c."businessId" = ${b}::int`)[0];
    const plan = planSendToExternal(context, input, {
      supplierActive: facts.active === true, lastRound: Number(facts.lastRound), openWorkForCase: facts.openCase, openWorkForDevice: facts.openDevice,
    }, { kind: "OWNER", userId: p.userId });
    if (!plan.case.ok) throw violationsError(plan.case.violations);
    if (!plan.work.ok) throw violationsError(plan.work.violations);
    const kase = plan.case, work = plan.work;
    if (kase.effects.length > 0) throw new ServiceDeskError("ACTION_NOT_IN_SCOPE", { effects: [...kase.effects] });
    // The case's own checks (SUPPLIER_BELONGS_TO_BUSINESS) and the work's, all against the database.
    await verifyWorkChecks(tx, b, [...new Set([...kase.serverChecks, ...work.serverChecks] as ExternalServerCheck[])],
      { supplierId: input.supplierId, deviceId: facts.deviceId === null ? null : Number(facts.deviceId), caseId, staffId: null });

    // 1. the case moves to EXTERNAL (the work's insert guard requires it in the same transaction). The hold is the core's
    //    holdReasonAfter (null: a hold exists only in IN_REPAIR, CHECK ServiceCase_hold_only_in_repair) — as the event says.
    const next = context.version + 1;
    const updated = await tx.$executeRaw`
      UPDATE "ServiceCase" SET status = ${kase.to}::"ServiceCaseStatus", "holdReason" = ${kase.holdReason}::"ServiceHoldReason", version = ${next}::int, "updatedAt" = now()
       WHERE id = ${caseId}::int AND "businessId" = ${b}::int AND version = ${context.version}::int`;
    if (updated !== 1) throw new ServiceDeskError("VERSION_CONFLICT");
    await appendEvent(tx, b, caseId, next, kase.event, p.userId, prepared);
    // 2. the work row and its first event
    const t = work.texts;
    const workId = Number((await tx.$queryRaw<{ id: number }[]>`
      INSERT INTO "ServiceExternalWork" ("businessId", "caseId", round, "supplierId", "sentByUserId", "sendReason", "requestedWork", "conditionAtSend",
        "operationalNote", "supplierReference", "expectedBackOn", "updatedAt")
      VALUES (${b}::int, ${caseId}::int, ${work.work.round}::int, ${work.work.supplierId}::int, ${p.userId}::int, ${t.sendReason}::text, ${t.requestedWork}::text,
        ${t.conditionAtSend}::text, ${t.operationalNote}::text, ${work.work.supplierReference}::text, ${work.work.expectedBackOn}::date, now())
      RETURNING id`)[0].id);
    await appendWorkEvent(tx, b, workId, caseId, work, p.userId, prepared);
    return { case: await summaryOf(tx, b, caseId), work: await workOf(tx, b, workId), replayed: false };
  }, async (tx, prior) => {
    if (prior.caseId !== caseId) throw new ServiceDeskError("IDEMPOTENCY_KEY_REUSED");
    const w = (await tx.$queryRaw<{ id: number }[]>`
      SELECT "workId" AS id FROM "ServiceExternalWorkEvent" WHERE "businessId" = ${b}::int AND "idempotencyKey" = ${prepared.key}::text AND kind = 'SENT'`)[0];
    if (!w) throw new ServiceDeskError("IDEMPOTENCY_KEY_REUSED");
    return { case: await summaryOf(tx, b, caseId), work: await workOf(tx, b, Number(w.id)), replayed: true };
  });
}

// ── While the item is away ───────────────────────────────────────────────────────────────────────────────────

type LockedWork = { id: number; caseId: number; snapshot: ExternalWorkSnapshot };

async function lockWork(tx: Tx, b: number, workId: number): Promise<LockedWork> {
  const r = (await tx.$queryRaw<Record<string, unknown>[]>`
    SELECT id, "caseId", state::text AS state, round, "supplierId", "progressStage"::text AS "progressStage", version, "supplierReference",
           to_char("expectedBackOn", 'YYYY-MM-DD') AS "expectedBackOn", "estimatedCostAgorot", "approvedCostAgorot", "finalCostAgorot", "returnResult"::text AS "returnResult"
      FROM "ServiceExternalWork" WHERE id = ${workId}::int AND "businessId" = ${b}::int FOR UPDATE`)[0];
  if (!r) throw new ServiceDeskError("NOT_FOUND");
  return {
    id: Number(r.id), caseId: Number(r.caseId),
    snapshot: {
      state: r.state as ExternalWorkSnapshot["state"], round: Number(r.round), supplierId: Number(r.supplierId),
      progressStage: r.progressStage as ExternalWorkSnapshot["progressStage"], version: Number(r.version),
      supplierReference: (r.supplierReference as string) ?? null, expectedBackOn: (r.expectedBackOn as string) ?? null,
      estimatedCostAgorot: num(r.estimatedCostAgorot), approvedCostAgorot: num(r.approvedCostAgorot), finalCostAgorot: num(r.finalCostAgorot),
      returnResult: (r.returnResult as ExternalWorkSnapshot["returnResult"]) ?? null,
    },
  };
}

/** An earlier answer for a work-only command: the work journal is its ledger (same key + same request → stored result). */
async function findPriorWorkEvent(tx: Tx, b: number, prepared: Prepared): Promise<{ workId: number } | null> {
  const origin = (await tx.$queryRaw<{ workId: number; d: string | null; k: string | null }[]>`
    SELECT "workId", "requestDigest" AS d, "digestKeyId" AS k FROM "ServiceExternalWorkEvent" WHERE "businessId" = ${b}::int AND "idempotencyKey" = ${prepared.key}::text`)[0];
  if (!origin) return null;
  if (!origin.d || !origin.k) throw new ServiceDeskError("IDEMPOTENCY_KEY_REUSED");
  const expected = digestWithKeyId(prepared.keys, origin.k, prepared.ident);
  if (!expected || !sameDigest(expected, origin.d)) throw new ServiceDeskError("IDEMPOTENCY_KEY_REUSED");
  return { workId: Number(origin.workId) };
}

function workActionFrom(raw: Record<string, unknown>): ExternalWorkAction {
  switch (raw.type) {
    case "RECORD_PROGRESS":
      if (!EXTERNAL_PROGRESS_STAGES.includes(raw.stage as never)) throw new ServiceDeskError("INVALID_INPUT", { field: "action.stage" });
      if (raw.supplierReference !== undefined && typeof raw.supplierReference !== "string") throw new ServiceDeskError("INVALID_INPUT", { field: "action.supplierReference" });
      return raw.supplierReference === undefined ? { type: "RECORD_PROGRESS", stage: raw.stage as never } : { type: "RECORD_PROGRESS", stage: raw.stage as never, supplierReference: raw.supplierReference as string };
    case "CHANGE_EXPECTED_BACK":
      if (raw.expectedBackOn !== null && typeof raw.expectedBackOn !== "string") throw new ServiceDeskError("INVALID_INPUT", { field: "action.expectedBackOn" });
      return { type: "CHANGE_EXPECTED_BACK", expectedBackOn: raw.expectedBackOn as string | null };
    case "RECORD_COST":
      if (!["ESTIMATED", "APPROVED", "FINAL"].includes(raw.kind as string)) throw new ServiceDeskError("INVALID_INPUT", { field: "action.kind" });
      if (!isNonNegativeInt(raw.amountAgorot)) throw new ServiceDeskError("INVALID_INPUT", { field: "action.amountAgorot" });
      return { type: "RECORD_COST", kind: raw.kind as "ESTIMATED" | "APPROVED" | "FINAL", amountAgorot: raw.amountAgorot };
    case "CORRECT_FINAL_COST":
      if (!isNonNegativeInt(raw.amountAgorot)) throw new ServiceDeskError("INVALID_INPUT", { field: "action.amountAgorot" });
      if (typeof raw.reason !== "string") throw new ServiceDeskError("INVALID_INPUT", { field: "action.reason" });
      return { type: "CORRECT_FINAL_COST", amountAgorot: raw.amountAgorot, reason: raw.reason };
    default:
      throw new ServiceDeskError("INVALID_INPUT", { field: "action.type" });
  }
}

export async function runExternalWorkAction(
  p: ServiceDeskPrincipal,
  workId: unknown,
  body: { action?: unknown; expectedVersion?: unknown },
  req: WriteRequest,
): Promise<{ work: ExternalWorkView; replayed: boolean }> {
  if (!isPositiveInt(workId)) throw new ServiceDeskError("NOT_FOUND");
  if (!body.action || typeof body.action !== "object" || Array.isArray(body.action)) throw new ServiceDeskError("INVALID_INPUT", { field: "action" });
  if (!isPositiveInt(body.expectedVersion)) throw new ServiceDeskError("INVALID_INPUT", { field: "expectedVersion" });
  const action = workActionFrom(body.action as Record<string, unknown>);
  const prepared = prepare(p, req, "service-desk/external-work:action", { workId, action, expectedVersion: body.expectedVersion });
  const b = p.businessId;

  const attempt = () => tenantTx(b, async (tx) => {
    const locked = await lockWork(tx, b, workId);
    const prior = await findPriorWorkEvent(tx, b, prepared);
    if (prior) {
      if (prior.workId !== workId) throw new ServiceDeskError("IDEMPOTENCY_KEY_REUSED");
      return { work: await workOf(tx, b, workId), replayed: true };
    }
    const verdict = checkIdempotencyKey(prepared.key, prepared.now);
    if (!verdict.ok) throw new ServiceDeskError(verdict.code);
    const env = checkExternalEnvelope(locked.snapshot, { workId, expectedVersion: body.expectedVersion as number, idempotencyKey: prepared.key });
    if (!env.ok) throw violationsError(env.violations);
    const d = evaluateExternalWork(locked.snapshot, action, { kind: "OWNER", userId: p.userId });
    if (!d.ok) throw violationsError(d.violations);
    const w = d.work;
    const n = await tx.$executeRaw`
      UPDATE "ServiceExternalWork" SET "progressStage" = ${w.progressStage}::"ServiceExternalProgress", "supplierReference" = ${w.supplierReference}::text,
             "expectedBackOn" = ${w.expectedBackOn}::date, "estimatedCostAgorot" = ${w.estimatedCostAgorot}::int, "approvedCostAgorot" = ${w.approvedCostAgorot}::int,
             "finalCostAgorot" = ${w.finalCostAgorot}::int, version = ${w.version}::int, "lastEventKind" = ${d.event.kind}::"ServiceExternalWorkEventKind", "updatedAt" = now()
       WHERE id = ${workId}::int AND "businessId" = ${b}::int AND version = ${locked.snapshot.version}::int`;
    if (n !== 1) throw new ServiceDeskError("VERSION_CONFLICT");
    await appendWorkEvent(tx, b, workId, locked.caseId, d, p.userId, prepared);
    return { work: await workOf(tx, b, workId), replayed: false };
  }, { timeoutMs: 15_000 });
  try {
    return await attempt();
  } catch (e) {
    if (e instanceof ServiceDeskError) throw e;
    if (isUniqueViolation(e)) {
      try { return await attempt(); } catch (e2) {
        if (e2 instanceof ServiceDeskError) throw e2;
        throw isUniqueViolation(e2) ? new ServiceDeskError("CONFLICT") : guardRefusal(e2) ?? e2;
      }
    }
    throw guardRefusal(e) ?? e;
  }
}

// ── Return ────────────────────────────────────────────────────────────────────────────────────────────────────

export async function returnFromExternal(
  p: ServiceDeskPrincipal,
  workId: unknown,
  body: {
    expectedVersion?: unknown; caseExpectedVersion?: unknown; next?: unknown; outcome?: unknown;
    result?: unknown; workPerformed?: unknown; unresolvedIssue?: unknown; followUpRequired?: unknown; finalCostAgorot?: unknown; receivedByStaffMemberId?: unknown;
  },
  req: WriteRequest,
): Promise<ExternalCommandResult> {
  if (!isPositiveInt(workId)) throw new ServiceDeskError("NOT_FOUND");
  if (!isPositiveInt(body.expectedVersion)) throw new ServiceDeskError("INVALID_INPUT", { field: "expectedVersion" });
  if (!isNonNegativeInt(body.caseExpectedVersion)) throw new ServiceDeskError("INVALID_INPUT", { field: "caseExpectedVersion" });
  // M1: WORK_DONE on a track that hands nothing back (the case machine refuses it on any other case, and READY there).
  if (!["IN_REPAIR", "QA", "READY", "WORK_DONE"].includes(body.next as string)) throw new ServiceDeskError("INVALID_INPUT", { field: "next" });
  // REPLACED needs the replacement device link (LINK_REPLACEMENT_DEVICE, 1.3c) — out of scope here.
  if (body.outcome === "REPLACED") throw new ServiceDeskError("ACTION_NOT_IN_SCOPE", { action: "RETURN_FROM_EXTERNAL:REPLACED" });
  if (body.outcome !== undefined && body.outcome !== null && body.outcome !== "REPAIRED" && body.outcome !== "NOT_REPAIRED") throw new ServiceDeskError("INVALID_INPUT", { field: "outcome" });
  if (!EXTERNAL_RETURN_RESULTS.includes(body.result as never)) throw new ServiceDeskError("INVALID_INPUT", { field: "result" });
  if (typeof body.followUpRequired !== "boolean") throw new ServiceDeskError("INVALID_INPUT", { field: "followUpRequired" });
  if (body.finalCostAgorot !== undefined && body.finalCostAgorot !== null && !isNonNegativeInt(body.finalCostAgorot)) throw new ServiceDeskError("INVALID_INPUT", { field: "finalCostAgorot" });
  if (body.receivedByStaffMemberId !== undefined && body.receivedByStaffMemberId !== null && !isPositiveInt(body.receivedByStaffMemberId)) throw new ServiceDeskError("INVALID_INPUT", { field: "receivedByStaffMemberId" });
  const caseAction = (body.outcome === undefined || body.outcome === null
    ? { type: "RETURN_FROM_EXTERNAL", next: body.next }
    : { type: "RETURN_FROM_EXTERNAL", next: body.next, outcome: body.outcome }) as Extract<ServiceCaseAction, { type: "RETURN_FROM_EXTERNAL" }>;
  const input: ExternalReturnInput = {
    result: body.result as ExternalReturnInput["result"],
    workPerformed: optionalText(body.workPerformed, "workPerformed"),
    unresolvedIssue: optionalText(body.unresolvedIssue, "unresolvedIssue"),
    followUpRequired: body.followUpRequired,
    finalCostAgorot: (body.finalCostAgorot ?? null) as number | null,
    receivedByStaffMemberId: (body.receivedByStaffMemberId ?? null) as number | null,
  };
  const prepared = prepare(p, req, "service-desk/external-work:return", { workId, expectedVersion: body.expectedVersion, caseExpectedVersion: body.caseExpectedVersion, caseAction, ...input });
  const b = p.businessId;

  // Lock order: the case, then the work (a work action locks only the work; a send locks only the case) — no cycle.
  const caseOfWork = async (tx: Tx) => {
    const r = (await tx.$queryRaw<{ caseId: number }[]>`SELECT "caseId" FROM "ServiceExternalWork" WHERE id = ${workId}::int AND "businessId" = ${b}::int`)[0];
    if (!r) throw new ServiceDeskError("NOT_FOUND");
    return Number(r.caseId);
  };
  return journaled<ExternalCommandResult, { caseId: number; context: ServiceCaseContext; work: LockedWork }>(p, prepared, async (tx) => {
    const caseId = await caseOfWork(tx);
    const { context } = await lockCase(tx, b, caseId);
    const work = await lockWork(tx, b, workId);
    return { caseId, context, work };
  }, async (tx, { caseId, context, work }) => {
    const env = checkExternalEnvelope(work.snapshot, { workId, expectedVersion: body.expectedVersion as number, idempotencyKey: prepared.key });
    if (!env.ok) throw violationsError(env.violations);
    const caseEnv = checkCommandEnvelope(context, { caseId, action: caseAction, expectedVersion: body.caseExpectedVersion as number, idempotencyKey: prepared.key });
    if (!caseEnv.ok) throw violationsError(caseEnv.violations);
    // Parts that went with this work and are still out keep the return open (parts.core: partsBlockingExternalReturn).
    const out = Number((await tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM "ServicePart" WHERE "businessId" = ${b}::int AND "externalWorkId" = ${workId}::int AND state = 'ISSUED'`)[0]?.n ?? 0);
    if (out > 0) throw new ServiceDeskError("REFUSED", { violations: ["PARTS_STILL_AT_SUPPLIER"] });
    const plan = planReturnFromExternal(context, caseAction, work.snapshot, input, { kind: "OWNER", userId: p.userId });
    if (!plan.case.ok) throw violationsError(plan.case.violations);
    if (!plan.work.ok) throw violationsError(plan.work.violations);
    const kase = plan.case, closed = plan.work;
    if (kase.effects.length > 0) throw new ServiceDeskError("ACTION_NOT_IN_SCOPE", { effects: [...kase.effects] });
    if (kase.serverChecks.length > 0) throw new ServiceDeskError("SERVER_CHECK_FAILED", { check: kase.serverChecks[0] });
    await verifyWorkChecks(tx, b, closed.serverChecks, { supplierId: work.snapshot.supplierId, deviceId: null, caseId, staffId: input.receivedByStaffMemberId ?? null });

    // 1. the work closes, with its event (the case cannot leave EXTERNAL while the work is still out)
    const w = closed.work, t = closed.texts;
    const n = await tx.$executeRaw`
      UPDATE "ServiceExternalWork" SET state = 'RETURNED', "returnedAt" = now(), "returnedByUserId" = ${p.userId}::int, "returnResult" = ${w.returnResult}::"ServiceExternalReturnResult",
             "workPerformed" = ${t.workPerformed}::text, "unresolvedIssue" = ${t.unresolvedIssue}::text, "followUpRequired" = ${input.followUpRequired}::boolean,
             "receivedByStaffMemberId" = ${input.receivedByStaffMemberId ?? null}::int, "finalCostAgorot" = ${w.finalCostAgorot}::int,
             version = ${w.version}::int, "lastEventKind" = 'RETURNED', "updatedAt" = now()
       WHERE id = ${workId}::int AND "businessId" = ${b}::int AND version = ${work.snapshot.version}::int`;
    if (n !== 1) throw new ServiceDeskError("VERSION_CONFLICT");
    await appendWorkEvent(tx, b, workId, caseId, closed, p.userId, prepared);
    // 2. the case leaves EXTERNAL
    const next = context.version + 1;
    const st = stampsFor(kase);
    const u = await tx.$executeRaw`
      UPDATE "ServiceCase" SET status = ${kase.to}::"ServiceCaseStatus", outcome = ${kase.outcome}::"ServiceOutcome",
             "cancellationRequested" = ${kase.cancellationRequestedAfter}::boolean, version = ${next}::int, "updatedAt" = now(),
             "readyAt" = CASE WHEN ${st.ready}::boolean THEN now() ELSE "readyAt" END,
             -- back into QA is a new QA round (as commitTransition): a stamp of an earlier checklist never lets PASS_QA through
             "qaCompletedAt" = CASE WHEN ${kase.statusChanged && kase.to === "QA"}::boolean THEN NULL ELSE "qaCompletedAt" END
       WHERE id = ${caseId}::int AND "businessId" = ${b}::int AND version = ${context.version}::int`;
    if (u !== 1) throw new ServiceDeskError("VERSION_CONFLICT");
    await appendEvent(tx, b, caseId, next, kase.event, p.userId, prepared);
    return { case: await summaryOf(tx, b, caseId), work: await workOf(tx, b, workId), replayed: false };
  }, async (tx, prior) => {
    const caseId = await caseOfWork(tx);
    if (prior.caseId !== caseId) throw new ServiceDeskError("IDEMPOTENCY_KEY_REUSED");
    return { case: await summaryOf(tx, b, caseId), work: await workOf(tx, b, workId), replayed: true };
  });
}
