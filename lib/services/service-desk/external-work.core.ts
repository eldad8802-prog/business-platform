/**
 * Service Desk 1.1d — work at an external supplier. Pure: no database, no clock, no network, no input mutation.
 *
 * The case status machine stays the judge of the case: `planSendToExternal` and `planReturnFromExternal` run
 * `evaluateTransition` for SEND_TO_EXTERNAL / RETURN_FROM_EXTERNAL and add the work's own decision; both must be ok
 * and the service writes the case update, the case event, the work row and the work event in ONE transaction
 * (task 1.3). Everything that happens while the item is away — progress, the expected return date, costs, a
 * correction of the final cost — is `evaluateExternalWork`, which never touches the case.
 *
 * Owner decisions ח‑1 … ח‑9 (2026-11-05): see external-work.contracts.ts.
 */
import { evaluateTransition } from "./service-case.core";
import type { ServiceCaseAction, ServiceCaseActor, ServiceCaseContext, ServiceEventPayloadValue, ServiceTransitionDecision } from "./contracts";
import {
  EXTERNAL_PROGRESS_STAGES,
  EXTERNAL_REASON_MAX_LENGTH,
  EXTERNAL_RETURN_RESULTS,
  EXTERNAL_TEXT_MAX_LENGTH,
  SUPPLIER_REFERENCE_PATTERN,
  type ExternalProgressStage,
  type ExternalReturnInput,
  type ExternalSendFacts,
  type ExternalSendInput,
  type ExternalServerCheck,
  type ExternalWorkAction,
  type ExternalWorkDecision,
  type ExternalWorkEventKind,
  type ExternalWorkSnapshot,
  type ExternalWorkTexts,
  type ExternalWorkViolation,
  type ExternalWorkViolationCode,
} from "./external-work.contracts";

const v = (code: ExternalWorkViolationCode, detail: string): ExternalWorkViolation => ({ code, detail });
const isPositiveInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0;
const isNonNegativeInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;
const codePoints = (s: string) => Array.from(s).length;
const emptyTexts = (): ExternalWorkTexts => ({
  sendReason: null, requestedWork: null, conditionAtSend: null, operationalNote: null,
  workPerformed: null, unresolvedIssue: null, correctionReason: null,
});

/** A calendar date YYYY-MM-DD (no time, no zone) — the column is a DATE. */
export function isCalendarDate(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

export function stageIndex(stage: ExternalProgressStage): number {
  return EXTERNAL_PROGRESS_STAGES.indexOf(stage);
}

/** Text as it will be stored: trimmed, null when blank; over the limit is a violation (never truncated). */
function takeText(raw: unknown, field: string, max: number, out: ExternalWorkViolation[]): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") { out.push(v("INVALID_INPUT", field)); return null; }
  const t = raw.trim();
  if (!t) return null;
  if (codePoints(t) > max) out.push(v(max === EXTERNAL_REASON_MAX_LENGTH ? "REASON_TOO_LONG" : "TEXT_TOO_LONG", `${field} exceeds ${max} characters`));
  return t;
}

function ownerOnly(actor: ServiceCaseActor, out: ExternalWorkViolation[]) {
  if (actor?.kind !== "OWNER" || !isPositiveInt(actor.userId)) out.push(v("ACTOR_NOT_ALLOWED", `${String(actor?.kind)} may not act on external work`));
}

function decision(
  work: ExternalWorkSnapshot,
  kind: ExternalWorkEventKind,
  actor: ServiceCaseActor,
  payload: Record<string, ServiceEventPayloadValue>,
  extra: { texts?: ExternalWorkTexts; sets?: Record<string, string | number | boolean | null>; serverChecks?: ExternalServerCheck[]; amountAgorot?: number | null; previousAmountAgorot?: number | null } = {},
): ExternalWorkDecision {
  return {
    ok: true,
    work: { ...work },
    texts: { ...(extra.texts ?? emptyTexts()) },
    sets: { ...(extra.sets ?? {}) },
    serverChecks: [...(extra.serverChecks ?? [])],
    event: {
      kind,
      seq: work.version,
      progressStage: work.progressStage,
      amountAgorot: extra.amountAgorot ?? null,
      previousAmountAgorot: extra.previousAmountAgorot ?? null,
      expectedBackOn: work.expectedBackOn,
      actor: { ...actor },
      payload: { ...payload },
    },
  };
}

// ── send ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The work a send opens (round = lastRound + 1, stage SENT, version 1), or every violation found. */
export function openExternalWork(input: ExternalSendInput, facts: ExternalSendFacts, actor: ServiceCaseActor): ExternalWorkDecision {
  const out: ExternalWorkViolation[] = [];
  ownerOnly(actor, out);
  if (!input || !isPositiveInt(input.supplierId)) out.push(v("INVALID_INPUT", "supplierId"));
  if (!facts || typeof facts.supplierActive !== "boolean" || !isNonNegativeInt(facts.lastRound)) out.push(v("INVALID_INPUT", "facts"));
  else {
    if (!facts.supplierActive) out.push(v("SUPPLIER_INACTIVE", "the supplier is not active"));
    if (facts.openWorkForCase) out.push(v("WORK_ALREADY_OPEN", "this case already has work at a supplier"));
    if (facts.openWorkForDevice) out.push(v("DEVICE_ALREADY_AT_SUPPLIER", "this device is already at a supplier"));
  }
  const texts = emptyTexts();
  texts.sendReason = takeText(input?.sendReason, "sendReason", EXTERNAL_REASON_MAX_LENGTH, out);
  if (texts.sendReason === null && !out.some((x) => x.code === "REASON_TOO_LONG")) out.push(v("REASON_REQUIRED", "a send needs its reason"));
  texts.requestedWork = takeText(input?.requestedWork, "requestedWork", EXTERNAL_TEXT_MAX_LENGTH, out);
  texts.conditionAtSend = takeText(input?.conditionAtSend, "conditionAtSend", EXTERNAL_TEXT_MAX_LENGTH, out);
  texts.operationalNote = takeText(input?.operationalNote, "operationalNote", EXTERNAL_TEXT_MAX_LENGTH, out);
  const ref = input?.supplierReference ?? null;
  if (ref !== null && (typeof ref !== "string" || !SUPPLIER_REFERENCE_PATTERN.test(ref))) {
    out.push(v("SUPPLIER_REFERENCE_INVALID", "an RMA-like token: letters, digits and . _ / # - only, at most 40, no spaces"));
  }
  const expected = input?.expectedBackOn ?? null;
  if (expected !== null && !isCalendarDate(expected)) out.push(v("INVALID_INPUT", "expectedBackOn"));
  if (out.length > 0) return { ok: false, violations: out };

  const work: ExternalWorkSnapshot = {
    state: "AT_SUPPLIER",
    round: facts.lastRound + 1,
    supplierId: input.supplierId,
    progressStage: "SENT",
    version: 1,
    supplierReference: ref,
    expectedBackOn: expected,
    estimatedCostAgorot: null,
    approvedCostAgorot: null,
    finalCostAgorot: null,
    returnResult: null,
  };
  return decision(work, "SENT", actor,
    { round: work.round, supplierId: work.supplierId, expectedBackOn: expected, hasSupplierReference: ref !== null },
    { texts, serverChecks: ["SUPPLIER_BELONGS_TO_BUSINESS", "SUPPLIER_ACTIVE", "NO_OPEN_WORK_FOR_DEVICE"] });
}

/** SEND_TO_EXTERNAL on the case plus the work it opens. Both must be ok; nothing is written by the core. */
export function planSendToExternal(
  context: ServiceCaseContext,
  input: ExternalSendInput,
  facts: ExternalSendFacts,
  actor: ServiceCaseActor,
): { ok: boolean; case: ServiceTransitionDecision; work: ExternalWorkDecision } {
  const kase = evaluateTransition(context, { type: "SEND_TO_EXTERNAL", supplierId: input?.supplierId }, actor);
  const work = openExternalWork(input, facts, actor);
  return { ok: kase.ok && work.ok, case: kase, work };
}

// ── while the item is away ───────────────────────────────────────────────────────────────────────────────────

/** Progress, the expected date, a cost, a correction of the final cost. Every ok decision bumps the version by one. */
export function evaluateExternalWork(work: ExternalWorkSnapshot, action: ExternalWorkAction, actor: ServiceCaseActor): ExternalWorkDecision {
  const out: ExternalWorkViolation[] = [];
  ownerOnly(actor, out);
  if (!work || !isPositiveInt(work.version)) return { ok: false, violations: [...out, v("INVALID_INPUT", "work")] };
  const open = work.state === "AT_SUPPLIER";
  const next: ExternalWorkSnapshot = { ...work, version: work.version + 1 };

  switch (action?.type) {
    case "RECORD_PROGRESS": {
      if (!open) out.push(v("WORK_NOT_OPEN", "the item is back; progress is closed"));
      if (!EXTERNAL_PROGRESS_STAGES.includes(action.stage)) return { ok: false, violations: [...out, v("INVALID_INPUT", "stage")] };
      const from = stageIndex(work.progressStage), to = stageIndex(action.stage);
      if (to === from) out.push(v("PROGRESS_UNCHANGED", `already ${action.stage}`));
      else if (to < from) out.push(v("PROGRESS_NOT_FORWARD", `${work.progressStage} → ${action.stage} goes back`));
      const sets: Record<string, string> = {};
      if (action.supplierReference !== undefined) {
        if (work.supplierReference !== null) out.push(v("SUPPLIER_REFERENCE_ALREADY_SET", "the supplier reference is set once"));
        else if (typeof action.supplierReference !== "string" || !SUPPLIER_REFERENCE_PATTERN.test(action.supplierReference)) {
          out.push(v("SUPPLIER_REFERENCE_INVALID", "an RMA-like token only"));
        } else { next.supplierReference = action.supplierReference; sets.supplierReference = action.supplierReference; }
      }
      if (out.length > 0) return { ok: false, violations: out };
      next.progressStage = action.stage;
      return decision(next, "PROGRESS", actor,
        { from: work.progressStage, to: action.stage, skipped: to - from - 1, hasSupplierReference: next.supplierReference !== null }, { sets });
    }
    case "CHANGE_EXPECTED_BACK": {
      if (!open) out.push(v("WORK_NOT_OPEN", "the item is back"));
      const d = action.expectedBackOn;
      if (d !== null && !isCalendarDate(d)) out.push(v("INVALID_INPUT", "expectedBackOn"));
      else if (d === work.expectedBackOn) out.push(v("EXPECTED_BACK_UNCHANGED", "same date"));
      if (out.length > 0) return { ok: false, violations: out };
      next.expectedBackOn = d;
      return decision(next, "EXPECTED_BACK_CHANGED", actor, { previous: work.expectedBackOn, expectedBackOn: d });
    }
    case "RECORD_COST": {
      if (!isNonNegativeInt(action.amountAgorot)) out.push(v("INVALID_INPUT", "amountAgorot is an integer ≥ 0"));
      if (action.kind === "FINAL") {
        if (work.finalCostAgorot !== null) out.push(v("FINAL_COST_ALREADY_RECORDED", "correct it with CORRECT_FINAL_COST"));
      } else if (action.kind === "ESTIMATED" || action.kind === "APPROVED") {
        if (!open) out.push(v("COST_NOT_ALLOWED_AFTER_RETURN", "after the return only the final cost is recorded"));
      } else out.push(v("INVALID_INPUT", "kind"));
      if (out.length > 0) return { ok: false, violations: out };
      const column = action.kind === "FINAL" ? "finalCostAgorot" : action.kind === "APPROVED" ? "approvedCostAgorot" : "estimatedCostAgorot";
      const previous = work[column];
      next[column] = action.amountAgorot;
      const kind: ExternalWorkEventKind = action.kind === "FINAL" ? "COST_FINAL" : action.kind === "APPROVED" ? "COST_APPROVED" : "COST_ESTIMATED";
      return decision(next, kind, actor, { amountAgorot: action.amountAgorot, previousAgorot: previous },
        { amountAgorot: action.amountAgorot, previousAmountAgorot: previous });
    }
    case "CORRECT_FINAL_COST": {
      // Correction 1: a mistaken final cost is corrected by a NEW event that keeps the previous value, the new value,
      // the reason and the user; the original event stays. It is never a charge, a refund or an accounting change.
      if (work.finalCostAgorot === null) out.push(v("FINAL_COST_NOT_RECORDED", "there is no final cost to correct"));
      if (!isNonNegativeInt(action.amountAgorot)) out.push(v("INVALID_INPUT", "amountAgorot is an integer ≥ 0"));
      else if (action.amountAgorot === work.finalCostAgorot) out.push(v("CORRECTION_UNCHANGED", "the corrected value equals the current one"));
      const texts = emptyTexts();
      texts.correctionReason = takeText(action.reason, "reason", EXTERNAL_REASON_MAX_LENGTH, out);
      if (texts.correctionReason === null && !out.some((x) => x.code === "REASON_TOO_LONG")) out.push(v("REASON_REQUIRED", "a correction needs its reason"));
      if (out.length > 0) return { ok: false, violations: out };
      const previous = work.finalCostAgorot;
      next.finalCostAgorot = action.amountAgorot;
      return decision(next, "COST_FINAL_CORRECTED", actor, { amountAgorot: action.amountAgorot, previousAgorot: previous, reasonRecorded: true },
        { texts, amountAgorot: action.amountAgorot, previousAmountAgorot: previous });
    }
    default:
      return { ok: false, violations: [...out, v("INVALID_INPUT", `unknown action ${String((action as { type?: unknown })?.type)}`)] };
  }
}

// ── return ───────────────────────────────────────────────────────────────────────────────────────────────────

/** The work closed by a documented return — allowed from any progress stage. */
export function closeExternalWork(work: ExternalWorkSnapshot, input: ExternalReturnInput, actor: ServiceCaseActor): ExternalWorkDecision {
  const out: ExternalWorkViolation[] = [];
  ownerOnly(actor, out);
  if (!work || work.state !== "AT_SUPPLIER") out.push(v("WORK_NOT_OPEN", "there is no open work to close"));
  if (!input || !EXTERNAL_RETURN_RESULTS.includes(input.result)) out.push(v("INVALID_INPUT", "result"));
  if (typeof input?.followUpRequired !== "boolean") out.push(v("INVALID_INPUT", "followUpRequired"));
  const final = input?.finalCostAgorot ?? null;
  if (final !== null) {
    if (!isNonNegativeInt(final)) out.push(v("INVALID_INPUT", "finalCostAgorot"));
    else if (work?.finalCostAgorot !== null && work?.finalCostAgorot !== undefined) out.push(v("FINAL_COST_ALREADY_RECORDED", "correct it with CORRECT_FINAL_COST"));
  }
  const staff = input?.receivedByStaffMemberId ?? null;
  if (staff !== null && !isPositiveInt(staff)) out.push(v("INVALID_INPUT", "receivedByStaffMemberId"));
  const texts = emptyTexts();
  texts.workPerformed = takeText(input?.workPerformed, "workPerformed", EXTERNAL_TEXT_MAX_LENGTH, out);
  texts.unresolvedIssue = takeText(input?.unresolvedIssue, "unresolvedIssue", EXTERNAL_TEXT_MAX_LENGTH, out);
  if (out.length > 0) return { ok: false, violations: out };

  const next: ExternalWorkSnapshot = { ...work, state: "RETURNED", version: work.version + 1, returnResult: input.result };
  if (final !== null) next.finalCostAgorot = final;
  const serverChecks: ExternalServerCheck[] = staff !== null ? ["STAFF_BELONGS_TO_BUSINESS"] : [];
  return decision(next, "RETURNED", actor,
    { result: input.result, fromStage: work.progressStage, followUpRequired: input.followUpRequired, hasUnresolvedIssue: texts.unresolvedIssue !== null, finalCostAgorot: final },
    { texts, sets: { followUpRequired: input.followUpRequired, receivedByStaffMemberId: staff }, serverChecks, amountAgorot: final });
}

/**
 * RETURN_FROM_EXTERNAL on the case plus the work it closes. A result that says nothing was repaired cannot come with
 * a case outcome that says it was (REPAIRED / REPLACED); REPLACED_BY_SUPPLIER never changes the device by itself —
 * a case outcome REPLACED still names the replacement device explicitly (the core requires it).
 */
export function planReturnFromExternal(
  context: ServiceCaseContext,
  caseAction: Extract<ServiceCaseAction, { type: "RETURN_FROM_EXTERNAL" }>,
  work: ExternalWorkSnapshot,
  input: ExternalReturnInput,
  actor: ServiceCaseActor,
): { ok: boolean; case: ServiceTransitionDecision; work: ExternalWorkDecision } {
  const kase = evaluateTransition(context, caseAction, actor);
  let closed = closeExternalWork(work, input, actor);
  const claimsRepair = caseAction?.outcome === "REPAIRED" || caseAction?.outcome === "REPLACED";
  if (closed.ok && claimsRepair && (input.result === "NOT_REPAIRED" || input.result === "RETURNED_UNWORKED")) {
    closed = { ok: false, violations: [v("RESULT_CONTRADICTS_OUTCOME", `${input.result} cannot close a case as ${caseAction.outcome}`)] };
  }
  return { ok: kase.ok && closed.ok, case: kase, work: closed };
}

// ── command envelope ─────────────────────────────────────────────────────────────────────────────────────────

/** Shape and version of a command on a work. The binding compare runs again under the row lock (task 1.3). */
export function checkExternalEnvelope(
  work: ExternalWorkSnapshot,
  command: { workId: number; expectedVersion: number; idempotencyKey: string },
): { ok: true } | { ok: false; violations: readonly ExternalWorkViolation[] } {
  const out: ExternalWorkViolation[] = [];
  if (!isPositiveInt(command?.workId)) out.push(v("INVALID_INPUT", "workId"));
  if (typeof command?.idempotencyKey !== "string" || !/^[A-Za-z0-9:_#-]{8,200}$/.test(command.idempotencyKey)) out.push(v("INVALID_INPUT", "idempotencyKey"));
  if (!isPositiveInt(command?.expectedVersion)) out.push(v("INVALID_INPUT", "expectedVersion"));
  else if (command.expectedVersion !== work?.version) out.push(v("VERSION_CONFLICT", `expected ${command.expectedVersion}, work is at ${work?.version}`));
  return out.length > 0 ? { ok: false, violations: out } : { ok: true };
}
