/**
 * Service Desk — the ServiceCase state machine. Pure: no database, no clock, no network, no input mutation.
 *
 * Every change of status, hold reason or outcome is a named action judged by `evaluateTransition`; there is no
 * "set status". The core judges only the facts in `ServiceCaseContext` and lists, per decision, the facts the
 * service must still verify in the database (`serverChecks`). Locking, the version compare, idempotency and the
 * journal write belong to the command service (task 1.3) — see SERVICE_COMMAND_SERVER_DUTIES.
 *
 * Status graph (spec part B; CANCEL per the reading documented below):
 *   OPEN          → SCHEDULED | CHECKED_IN | CANCELLED
 *   SCHEDULED     → CHECKED_IN | CANCELLED
 *   CHECKED_IN    → DIAGNOSING | READY (cancel, item held) | CANCELLED (cancel, FIELD)
 *   DIAGNOSING    → QUOTE_PENDING | IN_REPAIR | EXTERNAL | READY
 *   QUOTE_PENDING → IN_REPAIR | READY | CANCELLED
 *   IN_REPAIR     → QA | EXTERNAL | QUOTE_PENDING | READY   (+ hold set / cleared in place)
 *   EXTERNAL      → IN_REPAIR | QA | READY
 *   QA            → READY | IN_REPAIR
 *   READY         → DELIVERED | ABANDONED
 *   DELIVERED     → CLOSED
 *   ABANDONED     → DELIVERED | CLOSED
 *   CLOSED, CANCELLED → (terminal; a repeat repair is a new linked case)
 *
 * CANCEL — the spec's status table allows it from OPEN, SCHEDULED, CHECKED_IN and QUOTE_PENDING, and requires an
 * item the business holds to go out through READY → DELIVERED. So a cancel of an IN_SHOP case that holds the item
 * ends in READY with outcome CANCELLED, never in CANCELLED. Cancelling from IN_REPAIR / EXTERNAL / QA (the
 * alternative-path table says "any stage") is NOT implemented: it needs an owner decision.
 */

import {
  TERMINAL_STATUSES,
  SERVICE_HOLD_REASONS,
  type RepeatCaseDecision,
  type RepeatCaseInput,
  type ServiceCaseAction,
  type ServiceCaseActionType,
  type ServiceCaseActor,
  type ServiceCaseCommand,
  type ServiceCaseContext,
  type ServiceCaseEffect,
  type ServiceCaseEventType,
  type ServiceCaseKind,
  type ServiceCaseStatus,
  type ServiceCaseViolation,
  type ServiceCaseViolationCode,
  type ServiceEventPayloadValue,
  type ServiceHoldReason,
  type ServiceOutcome,
  type ServiceServerCheck,
  type ServiceTransitionDecision,
} from "./contracts";

export const TRANSITION_GRAPH: Readonly<Record<ServiceCaseStatus, readonly ServiceCaseStatus[]>> = {
  OPEN: ["SCHEDULED", "CHECKED_IN", "CANCELLED"],
  SCHEDULED: ["CHECKED_IN", "CANCELLED"],
  CHECKED_IN: ["DIAGNOSING", "READY", "CANCELLED"],
  DIAGNOSING: ["QUOTE_PENDING", "IN_REPAIR", "EXTERNAL", "READY"],
  QUOTE_PENDING: ["IN_REPAIR", "READY", "CANCELLED"],
  IN_REPAIR: ["QA", "EXTERNAL", "QUOTE_PENDING", "READY"],
  EXTERNAL: ["IN_REPAIR", "QA", "READY"],
  QA: ["READY", "IN_REPAIR"],
  READY: ["DELIVERED", "ABANDONED"],
  DELIVERED: ["CLOSED"],
  CLOSED: [],
  CANCELLED: [],
  ABANDONED: ["DELIVERED", "CLOSED"],
};

/** The statuses each action may start from. Anything else is INVALID_TRANSITION. */
export const ACTION_FROM: Readonly<Record<ServiceCaseActionType, readonly ServiceCaseStatus[]>> = {
  SCHEDULE: ["OPEN"],
  CHECK_IN: ["OPEN", "SCHEDULED"],
  START_DIAGNOSIS: ["CHECKED_IN"],
  SEND_QUOTE: ["DIAGNOSING", "IN_REPAIR"],
  APPROVE_QUOTE: ["QUOTE_PENDING"],
  REJECT_QUOTE: ["QUOTE_PENDING"],
  START_REPAIR: ["DIAGNOSING"],
  SET_HOLD: ["IN_REPAIR"],
  CLEAR_HOLD: ["IN_REPAIR"],
  SEND_TO_EXTERNAL: ["DIAGNOSING", "IN_REPAIR"],
  RETURN_FROM_EXTERNAL: ["EXTERNAL"],
  FINISH_REPAIR: ["IN_REPAIR"],
  PASS_QA: ["QA"],
  FAIL_QA: ["QA"],
  MARK_NOT_REPAIRABLE: ["DIAGNOSING", "IN_REPAIR"],
  DELIVER: ["READY", "ABANDONED"],
  CLOSE: ["DELIVERED", "ABANDONED"],
  CANCEL: ["OPEN", "SCHEDULED", "CHECKED_IN", "QUOTE_PENDING"],
  ABANDON: ["READY"],
};

const EVENT_TYPE: Readonly<Record<ServiceCaseActionType, ServiceCaseEventType>> = {
  SCHEDULE: "case.scheduled",
  CHECK_IN: "case.checked_in",
  START_DIAGNOSIS: "case.diagnosis_started",
  SEND_QUOTE: "quote.sent",
  APPROVE_QUOTE: "quote.approved",
  REJECT_QUOTE: "quote.rejected",
  START_REPAIR: "repair.started",
  SET_HOLD: "hold.set",
  CLEAR_HOLD: "hold.cleared",
  SEND_TO_EXTERNAL: "external.sent",
  RETURN_FROM_EXTERNAL: "external.returned",
  FINISH_REPAIR: "repair.finished",
  PASS_QA: "qa.passed",
  FAIL_QA: "qa.failed",
  MARK_NOT_REPAIRABLE: "case.not_repairable",
  DELIVER: "case.delivered",
  CLOSE: "case.closed",
  CANCEL: "case.cancelled",
  ABANDON: "case.abandoned",
};

/** A customer acts only on a quote, through the M2 link; the system only auto-closes. */
const CUSTOMER_ACTIONS: readonly ServiceCaseActionType[] = ["APPROVE_QUOTE", "REJECT_QUOTE"];
const SYSTEM_ACTIONS: readonly ServiceCaseActionType[] = ["CLOSE"];

/** Statuses in which an outcome exists (it is decided on entering READY, or by a cancel). */
const OUTCOME_STATUSES: readonly ServiceCaseStatus[] = ["READY", "DELIVERED", "CLOSED", "ABANDONED", "CANCELLED"];

const IN_PLACE_ACTIONS: readonly ServiceCaseActionType[] = ["SET_HOLD", "CLEAR_HOLD"];

export function isTerminal(status: ServiceCaseStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function canMove(from: ServiceCaseStatus, to: ServiceCaseStatus): boolean {
  return TRANSITION_GRAPH[from].includes(to);
}

/** Only an IN_SHOP case holds the customer's item, from check-in until it is handed back (EXTERNAL = the supplier). */
export function itemHeldByBusiness(kind: ServiceCaseKind, status: ServiceCaseStatus): boolean {
  if (kind !== "IN_SHOP") return false;
  return ["CHECKED_IN", "DIAGNOSING", "QUOTE_PENDING", "IN_REPAIR", "QA", "READY", "ABANDONED"].includes(status);
}

/** A paid repair needs an approval of the CURRENT quote version, total and document; a cover replaces the quote. */
export function isRepairAuthorized(context: ServiceCaseContext): boolean {
  if (context.coverage?.decision === "APPROVED") return true;
  const q = context.currentQuote;
  if (!q || q.state !== "APPROVED" || !q.approval) return false;
  return q.approval.version === q.version && q.approval.totalAgorot === q.totalAgorot && q.approval.docHash === q.docHash;
}

// ── evaluateTransition ─────────────────────────────────────────────────────────────────────────────────────

interface Resolution {
  to: ServiceCaseStatus;
  holdReason: ServiceHoldReason | null;
  outcome: ServiceOutcome | null;
  effects: ServiceCaseEffect[];
  serverChecks: ServiceServerCheck[];
  payload: Record<string, ServiceEventPayloadValue>;
  violations: ServiceCaseViolation[];
}

function violation(code: ServiceCaseViolationCode, detail: string): ServiceCaseViolation {
  return { code, detail };
}

function refuse(
  action: ServiceCaseActionType,
  from: ServiceCaseStatus,
  violations: readonly ServiceCaseViolation[],
): ServiceTransitionDecision {
  return { ok: false, action, from, violations: violations.map((v) => ({ ...v })) };
}

function isPositiveInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n > 0;
}

function isNonNegativeInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0;
}

function hasText(s: unknown): s is string {
  return typeof s === "string" && s.trim().length > 0;
}

function actorAllowed(actor: ServiceCaseActor, action: ServiceCaseActionType): boolean {
  switch (actor.kind) {
    case "OWNER":
      return isPositiveInt(actor.userId);
    case "CUSTOMER_LINK":
      return CUSTOMER_ACTIONS.includes(action);
    case "SYSTEM":
      return SYSTEM_ACTIONS.includes(action);
    default:
      return false;
  }
}

/**
 * Judges one action against the case as it stands. Returns either the resulting status / hold / outcome with the
 * event to append, or every violation found. Never throws for a business refusal; never mutates its inputs.
 */
export function evaluateTransition(
  context: ServiceCaseContext,
  action: ServiceCaseAction,
  actor: ServiceCaseActor,
): ServiceTransitionDecision {
  const from = context.status;
  const type = action.type;

  if (!(type in ACTION_FROM)) return refuse(type, from, [violation("INVALID_INPUT", `unknown action ${String(type)}`)]);
  if (isTerminal(from)) return refuse(type, from, [violation("TERMINAL_STATUS", `${from} is final`)]);
  if (!ACTION_FROM[type].includes(from)) {
    return refuse(type, from, [violation("INVALID_TRANSITION", `${type} is not allowed from ${from}`)]);
  }
  if (!actorAllowed(actor, type)) {
    return refuse(type, from, [violation("ACTOR_NOT_ALLOWED", `${actor.kind} may not ${type}`)]);
  }

  const r = resolve(context, action, actor);
  if (r.violations.length > 0) return refuse(type, from, r.violations);

  // Invariants: whatever an action resolved, the result must respect the graph and the three-field separation.
  const statusChanged = r.to !== from;
  const broken: ServiceCaseViolation[] = [];
  if (statusChanged ? !canMove(from, r.to) : !IN_PLACE_ACTIONS.includes(type)) {
    broken.push(violation("INVALID_TRANSITION", `${from} → ${r.to} is not in the graph`));
  }
  if (r.holdReason !== null && r.to !== "IN_REPAIR") {
    broken.push(violation("INVALID_TRANSITION", "a hold reason exists only in IN_REPAIR"));
  }
  if (OUTCOME_STATUSES.includes(r.to) ? r.outcome === null : r.outcome !== null) {
    broken.push(violation("OUTCOME_REQUIRED", `${r.to} ${r.outcome === null ? "needs" : "may not carry"} an outcome`));
  }
  if (broken.length > 0) return refuse(type, from, broken);

  return {
    ok: true,
    action: type,
    from,
    to: r.to,
    statusChanged,
    holdReason: r.holdReason,
    outcome: r.outcome,
    effects: [...r.effects],
    serverChecks: [...r.serverChecks],
    event: {
      type: EVENT_TYPE[type],
      action: type,
      fromStatus: from,
      toStatus: r.to,
      holdReasonBefore: context.holdReason,
      holdReasonAfter: r.holdReason,
      outcome: r.outcome,
      actor: { ...actor },
      payload: { ...r.payload },
    },
  };
}

function resolve(context: ServiceCaseContext, action: ServiceCaseAction, actor: ServiceCaseActor): Resolution {
  const r: Resolution = {
    to: context.status,
    holdReason: null,
    outcome: OUTCOME_STATUSES.includes(context.status) ? context.outcome : null,
    effects: [],
    serverChecks: [],
    payload: {},
    violations: [],
  };
  const fail = (code: ServiceCaseViolationCode, detail: string) => r.violations.push(violation(code, detail));
  const onSite = context.kind !== "IN_SHOP";
  const requireStaff = () => {
    if (!isPositiveInt(context.staffMemberId)) fail("STAFF_REQUIRED", "assign a staff member first");
    else r.serverChecks.push("STAFF_BELONGS_TO_BUSINESS");
  };
  const requireReplacement = (outcome: ServiceOutcome | undefined, deviceId: number | undefined) => {
    if (outcome !== "REPLACED") return;
    if (!isPositiveInt(deviceId)) {
      fail("REPLACEMENT_DEVICE_REQUIRED", "a replacement names the new device");
      return;
    }
    r.effects.push("LINK_REPLACEMENT_DEVICE");
    r.serverChecks.push("REPLACEMENT_DEVICE_BELONGS_TO_BUSINESS");
    r.payload.replacementDeviceId = deviceId;
  };
  const requireRepairAuthorization = () => {
    if (!isRepairAuthorized(context)) {
      fail("REPAIR_NOT_AUTHORIZED", "no approved current quote and no approved cover");
    }
  };

  switch (action.type) {
    case "SCHEDULE": {
      r.to = "SCHEDULED";
      if (!isPositiveInt(action.appointmentId)) fail("INVALID_INPUT", "appointmentId");
      else r.payload.appointmentId = action.appointmentId;
      r.serverChecks.push("APPOINTMENT_BELONGS_TO_CASE");
      if (onSite) {
        requireStaff();
        if (!isPositiveInt(context.siteId)) fail("SITE_REQUIRED", "an on-site visit needs the customer site");
        else r.serverChecks.push("SITE_BELONGS_TO_CUSTOMER");
      }
      break;
    }
    case "CHECK_IN": {
      r.to = "CHECKED_IN";
      if (onSite) {
        requireStaff();
      } else {
        const i = context.intake;
        const missing = !i
          ? ["condition", "accessories", "customerSignature"]
          : [
              ...(i.conditionRecorded ? [] : ["condition"]),
              ...(i.accessoriesRecorded ? [] : ["accessories"]),
              ...(i.customerSigned ? [] : ["customerSignature"]),
            ];
        if (missing.length > 0) fail("INTAKE_INCOMPLETE", `missing: ${missing.join(", ")}`);
        else r.serverChecks.push("INTAKE_ARTIFACTS_STORED");
      }
      break;
    }
    case "START_DIAGNOSIS": {
      r.to = "DIAGNOSING";
      requireStaff();
      break;
    }
    case "SEND_QUOTE": {
      r.to = "QUOTE_PENDING";
      const q = action.quote;
      if (!q || !isPositiveInt(q.version) || !isNonNegativeInt(q.totalAgorot) || !hasText(q.docHash)) {
        fail("INVALID_INPUT", "quote needs version ≥ 1, an integer total in agorot ≥ 0 and the document hash");
        break;
      }
      if (q.totalAgorot === 0 && context.coverage?.decision !== "APPROVED") {
        fail("QUOTE_TOTAL_REQUIRES_COVERAGE", "a ₪0 quote is only for an approved cover");
      }
      if (context.currentQuote && q.version <= context.currentQuote.version) {
        fail("QUOTE_VERSION_NOT_NEWER", `version ${q.version} ≤ current ${context.currentQuote.version}`);
      }
      if (context.currentQuote?.state === "SENT") {
        fail("QUOTE_NOT_AWAITING_DECISION", "the previous version is still awaiting a decision");
      }
      r.serverChecks.push("QUOTE_DOCUMENT_MATCHES_HASH");
      r.payload.quoteVersion = q.version;
      r.payload.totalAgorot = q.totalAgorot;
      break;
    }
    case "APPROVE_QUOTE": {
      r.to = "IN_REPAIR";
      const q = context.currentQuote;
      const a = action.approval;
      if (!q || q.state !== "SENT") {
        fail("QUOTE_NOT_AWAITING_DECISION", "no sent quote awaits a decision");
        break;
      }
      if (!a || a.version !== q.version || a.totalAgorot !== q.totalAgorot || a.docHash !== q.docHash) {
        fail("APPROVAL_MISMATCH", "the approval must name the current version, its exact total and its document");
      }
      const method = a?.method;
      const methodOk = actor.kind === "CUSTOMER_LINK" ? method === "LINK" : method === "PHONE" || method === "IN_PERSON";
      if (!methodOk) {
        fail("APPROVAL_METHOD_NOT_ALLOWED", `${actor.kind} cannot record an approval by ${String(method)}`);
      }
      r.serverChecks.push("QUOTE_DOCUMENT_MATCHES_HASH");
      r.payload.quoteVersion = q.version;
      r.payload.totalAgorot = q.totalAgorot;
      r.payload.method = method ?? null;
      break;
    }
    case "REJECT_QUOTE": {
      r.to = "READY";
      r.outcome = "QUOTE_REJECTED";
      const q = context.currentQuote;
      if (!q || q.state !== "SENT") fail("QUOTE_NOT_AWAITING_DECISION", "no sent quote awaits a decision");
      else if (action.version !== q.version) fail("QUOTE_VERSION_MISMATCH", `current version is ${q.version}`);
      else r.payload.quoteVersion = q.version;
      break;
    }
    case "START_REPAIR": {
      r.to = "IN_REPAIR";
      if (context.coverage?.decision !== "APPROVED") {
        fail("COVERAGE_NOT_APPROVED", "starting without a quote needs an approved warranty or contract cover");
      } else {
        r.payload.coverageSource = context.coverage.source;
      }
      break;
    }
    case "SET_HOLD": {
      r.to = "IN_REPAIR";
      if (!SERVICE_HOLD_REASONS.includes(action.reason)) {
        fail("INVALID_INPUT", "hold reason");
        break;
      }
      if (context.holdReason === action.reason) fail("HOLD_UNCHANGED", `already on hold for ${action.reason}`);
      r.holdReason = action.reason;
      r.payload.holdReason = action.reason;
      break;
    }
    case "CLEAR_HOLD": {
      r.to = "IN_REPAIR";
      if (context.holdReason === null) fail("NO_HOLD", "the case is not on hold");
      break;
    }
    case "SEND_TO_EXTERNAL": {
      r.to = "EXTERNAL";
      if (!isPositiveInt(action.supplierId)) fail("INVALID_INPUT", "supplierId");
      else {
        r.payload.supplierId = action.supplierId;
        r.serverChecks.push("SUPPLIER_BELONGS_TO_BUSINESS");
      }
      break;
    }
    case "RETURN_FROM_EXTERNAL": {
      r.to = action.next;
      r.payload.next = action.next;
      if (action.next === "READY") {
        if (!action.outcome) {
          fail("OUTCOME_REQUIRED", "READY needs the outcome of the external work");
          break;
        }
        r.outcome = action.outcome;
        r.payload.outcome = action.outcome;
        if (action.outcome !== "NOT_REPAIRED") requireRepairAuthorization();
        requireReplacement(action.outcome, action.replacementDeviceId);
        break;
      }
      if (action.outcome !== undefined) fail("OUTCOME_NOT_ALLOWED", "the outcome is decided on entering READY");
      if (action.next === "QA" && onSite) fail("QA_NOT_FOR_KIND", "QA is an IN_SHOP step");
      if (action.next !== "IN_REPAIR" && action.next !== "QA") fail("INVALID_INPUT", "next");
      else requireRepairAuthorization();
      break;
    }
    case "FINISH_REPAIR": {
      if (!onSite) {
        r.to = "QA";
        if (action.outcome !== undefined) fail("OUTCOME_NOT_ALLOWED", "IN_SHOP decides the outcome at QA");
        break;
      }
      // FIELD / MAINTENANCE skip QA: the visit closes the repair and the case is READY for the on-site handover.
      r.to = "READY";
      if (action.outcome !== "REPAIRED" && action.outcome !== "REPLACED") {
        fail("OUTCOME_REQUIRED", "an on-site repair ends with REPAIRED or REPLACED");
        break;
      }
      r.outcome = action.outcome;
      r.payload.outcome = action.outcome;
      requireReplacement(action.outcome, action.replacementDeviceId);
      break;
    }
    case "PASS_QA": {
      r.to = "READY";
      if (!context.qaChecklistCompleted) fail("QA_INCOMPLETE", "complete the QA checklist");
      if (action.outcome !== "REPAIRED" && action.outcome !== "REPLACED") {
        fail("OUTCOME_REQUIRED", "QA passes with REPAIRED or REPLACED");
        break;
      }
      r.outcome = action.outcome;
      r.payload.outcome = action.outcome;
      requireReplacement(action.outcome, action.replacementDeviceId);
      break;
    }
    case "FAIL_QA": {
      r.to = "IN_REPAIR";
      break;
    }
    case "MARK_NOT_REPAIRABLE": {
      r.to = "READY";
      r.outcome = "NOT_REPAIRED";
      break;
    }
    case "DELIVER": {
      r.to = "DELIVERED";
      const receipt = action.receipt;
      if (!receipt || !hasText(receipt.receivedByName) || receipt.signatureCaptured !== true) {
        fail("RECEIPT_INCOMPLETE", "the receiver's name and signature are required");
      }
      r.payload.receiptSigned = receipt?.signatureCaptured === true;
      const s = context.settlement;
      if (!s.known) {
        fail("BALANCE_UNKNOWN", "the balance could not be established — delivery waits for it");
      } else if (!Number.isInteger(s.openBalanceAgorot)) {
        fail("INVALID_INPUT", "openBalanceAgorot");
      } else {
        r.payload.openBalanceAgorot = s.openBalanceAgorot;
        if (s.openBalanceAgorot > 0) {
          // Owner decision ש4: allowed only as the owner's explicit decision, with a reason. The debt itself stays.
          if (!action.debtOverride) fail("OPEN_BALANCE_NEEDS_OWNER_DECISION", "an open balance needs the owner's decision");
          else if (!hasText(action.debtOverride.reason)) fail("OVERRIDE_REASON_REQUIRED", "debt decision reason");
          else r.payload.debtOverrideReason = action.debtOverride.reason.trim();
        }
        r.serverChecks.push("SETTLEMENT_READ_IN_SAME_TRANSACTION");
      }
      if (context.openLoaner) {
        if (!action.loanerOverride) fail("OPEN_LOANER", "the temporary replacement item has not been returned");
        else if (!hasText(action.loanerOverride.reason)) fail("OVERRIDE_REASON_REQUIRED", "loaner decision reason");
        else r.payload.loanerOverrideReason = action.loanerOverride.reason.trim();
      }
      r.effects.push("ATTEMPT_AUTO_CLOSE");
      break;
    }
    case "CLOSE": {
      r.to = "CLOSED";
      if (!isNonNegativeInt(context.openPartReservations)) fail("INVALID_INPUT", "openPartReservations");
      else if (context.openPartReservations > 0) {
        fail("OPEN_PART_RESERVATIONS", `${context.openPartReservations} reserved part(s) still open`);
      }
      if (context.currentQuote?.state === "SENT") fail("OPEN_QUOTE", "a sent quote still awaits a decision");
      r.serverChecks.push("PART_RESERVATIONS_COUNTED_UNDER_LOCK");
      break;
    }
    case "CANCEL": {
      const held = itemHeldByBusiness(context.kind, context.status);
      // An item the business holds is not "returned" by a cancel: it leaves through READY → DELIVERED.
      r.to = held ? "READY" : "CANCELLED";
      r.outcome = "CANCELLED";
      r.payload.itemHeldByBusiness = held;
      r.payload.reason = hasText(action.reason) ? action.reason.trim() : null;
      if (context.openPartReservations > 0) r.effects.push("RELEASE_PART_RESERVATIONS");
      if (context.currentQuote?.state === "SENT") r.effects.push("WITHDRAW_OPEN_QUOTE");
      break;
    }
    case "ABANDON": {
      r.to = "ABANDONED";
      if (!hasText(action.reason)) fail("REASON_REQUIRED", "marking an item as not collected needs a reason");
      else r.payload.reason = action.reason.trim();
      if (!isNonNegativeInt(context.pickupRemindersSent) || context.pickupRemindersSent < 1) {
        fail("PICKUP_REMINDERS_REQUIRED", "at least one documented pickup reminder must precede it");
      } else {
        r.payload.pickupRemindersSent = context.pickupRemindersSent;
      }
      break;
    }
    default: {
      const never: never = action;
      fail("INVALID_INPUT", `unknown action ${JSON.stringify(never)}`);
    }
  }

  return r;
}

// ── Command envelope ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Shape and version of a future command. A pure pre-check only: the binding version compare happens again under
 * the row lock, and the idempotency key is validated (UUIDv7, age, digest) and recorded by the service.
 */
export function checkCommandEnvelope(
  context: ServiceCaseContext,
  command: ServiceCaseCommand,
): { ok: true } | { ok: false; violations: readonly ServiceCaseViolation[] } {
  const violations: ServiceCaseViolation[] = [];
  if (!isPositiveInt(command.caseId)) violations.push(violation("INVALID_INPUT", "caseId"));
  if (!hasText(command.idempotencyKey) || command.idempotencyKey.length > 200) {
    violations.push(violation("INVALID_INPUT", "idempotencyKey"));
  }
  if (!isNonNegativeInt(command.expectedVersion)) violations.push(violation("INVALID_INPUT", "expectedVersion"));
  else if (command.expectedVersion !== context.version) {
    violations.push(violation("VERSION_CONFLICT", `expected ${command.expectedVersion}, case is at ${context.version}`));
  }
  return violations.length > 0 ? { ok: false, violations } : { ok: true };
}

// ── Repeat repair ──────────────────────────────────────────────────────────────────────────────────────────

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function dayNumber(iso: string): number | null {
  const m = ISO_DAY.exec(iso);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return t / 86_400_000;
}

/**
 * A repeat repair opens a NEW case linked to the parent (a closed case is never reopened). It is within the repair
 * warranty only when the parent was REPAIRED and handed back no more than `repairWarrantyDays` days earlier.
 */
export function evaluateRepeatCase(input: RepeatCaseInput): RepeatCaseDecision {
  const violations: ServiceCaseViolation[] = [];
  const { parent } = input;
  if (parent.status !== "DELIVERED" && parent.status !== "CLOSED") {
    violations.push(violation("INVALID_TRANSITION", "only a case handed back (DELIVERED / CLOSED) can have a repeat"));
  }
  const delivered = parent.deliveredOn === null ? null : dayNumber(parent.deliveredOn);
  const opened = dayNumber(input.openedOn);
  if (delivered === null) violations.push(violation("INVALID_INPUT", "parent.deliveredOn"));
  if (opened === null) violations.push(violation("INVALID_INPUT", "openedOn"));
  if (!isNonNegativeInt(input.repairWarrantyDays)) violations.push(violation("INVALID_INPUT", "repairWarrantyDays"));
  if (delivered !== null && opened !== null && opened < delivered) {
    violations.push(violation("INVALID_INPUT", "openedOn precedes the parent's delivery"));
  }
  if (violations.length > 0 || delivered === null || opened === null) return { ok: false, violations };

  const daysSinceDelivery = opened - delivered;
  return {
    ok: true,
    daysSinceDelivery,
    withinRepairWarranty: parent.outcome === "REPAIRED" && daysSinceDelivery <= input.repairWarrantyDays,
  };
}
