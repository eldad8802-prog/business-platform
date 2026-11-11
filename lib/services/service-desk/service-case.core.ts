/**
 * Service Desk — the ServiceCase state machine. Pure: no database, no clock, no network, no input mutation.
 *
 * Every change of status, hold reason or outcome is a named action judged by `evaluateTransition`; there is no
 * "set status". The core judges only the facts in `ServiceCaseContext` and lists, per decision, the facts the
 * service must still verify in the database (`serverChecks`). Locking, the version compare, idempotency and the
 * journal write belong to the command service (task 1.3) — see SERVICE_COMMAND_SERVER_DUTIES.
 *
 * Status graph (spec part B + owner decision on cancel, 2026-11-03):
 *   OPEN          → SCHEDULED | CHECKED_IN | CANCELLED
 *   SCHEDULED     → CHECKED_IN | CANCELLED
 *   CHECKED_IN    → DIAGNOSING | READY (cancel, item held) | CANCELLED (cancel, nothing held)
 *   DIAGNOSING    → QUOTE_PENDING | IN_REPAIR | EXTERNAL | READY | CANCELLED (cancel, nothing held)
 *   QUOTE_PENDING → IN_REPAIR | READY | CANCELLED
 *   IN_REPAIR     → QA | EXTERNAL | QUOTE_PENDING | READY | CANCELLED (cancel, nothing held)
 *                   (+ hold set / cleared in place)
 *   EXTERNAL      → IN_REPAIR | QA | READY   (+ cancel REQUESTED in place)
 *   QA            → READY | IN_REPAIR
 *   READY         → DELIVERED | ABANDONED | CANCELLED (cancel, nothing held)   (+ cancel of a held item in place)
 *   DELIVERED     → CLOSED
 *   ABANDONED     → DELIVERED | CLOSED
 *   CLOSED, CANCELLED → (terminal; a repeat repair is a new linked case)
 *
 * CANCEL (owner decision): allowed from every status before the item is handed back — OPEN … READY.
 *   - the business holds the item (IN_SHOP, CHECKED_IN … READY): a documented reason is required and the case goes
 *     to READY with outcome CANCELLED. It is NOT delivered: the normal handover (signature, balance) still applies.
 *   - the item is at an external supplier (EXTERNAL): the cancel is only REQUESTED (reason required). The case stays
 *     EXTERNAL and the decision says `cancellationRequestedAfter: true`; the recorded return from the supplier must
 *     then lead to READY with outcome CANCELLED and `cancellationRequestedAfter: false`. No new status.
 *   - nothing to hand back (not yet received, or FIELD / MAINTENANCE): CANCELLED, final.
 *   A cancel never undoes parts used, work done, costs, payments or supplier commitments, and never refunds: the
 *   only effects are releasing still-open part reservations and withdrawing a still-open quote.
 *
 * REVISE_QUOTE (owner decision ז-1 A): while QUOTE_PENDING, the SENT version N is replaced by version N+1; N becomes
 * SUPERSEDED (not WITHDRAWN — that is only for a cancel), N+1 is the one SENT version, the status does not change.
 *
 * Free text (ט-1 A): reasons travel in `decision.texts` for the business columns, never in `event.payload`, which holds
 * only short tokens, numbers, booleans and nulls (the journal CHECK's alphabet).
 *
 * OPEN (1.1c): a case is created only by `openServiceCase` — status OPEN, version 1, and the journal's one
 * `case.opened` event at seq 1 with no "from" status. OPEN is not a transition: `evaluateTransition` refuses it on
 * every existing case, so a case can never be opened twice. Every transition after it is seq = the version it sets.
 */

import {
  SERVICE_CASE_INITIAL_VERSION,
  SERVICE_CASE_KINDS,
  SERVICE_CASE_OPENING_SEQ,
  TERMINAL_STATUSES,
  SERVICE_HOLD_REASONS,
  SERVICE_REASON_MAX_LENGTH,
  type RepeatCaseDecision,
  type RepeatCaseInput,
  type ServiceCaseAction,
  type ServiceCaseActionType,
  type ServiceCaseActor,
  type ServiceCaseCommand,
  type ServiceCaseContext,
  type ServiceCaseOpenDecision,
  type ServiceCaseOpenInput,
  type ServiceDecisionTexts,
  type ServiceCaseEffect,
  type ServiceCaseEventType,
  type ServiceCaseKind,
  type ServiceCaseStatus,
  type ServiceCaseViolation,
  type ServiceCaseViolationCode,
  type ServiceEventPayloadValue,
  type ServiceHoldReason,
  type ServiceOutcome,
  type QuoteWithdrawalDecision,
  type ServiceQuoteRef,
  type ServiceQuoteSnapshot,
  type ServiceServerCheck,
  type ServiceTransitionDecision,
} from "./contracts";

export const TRANSITION_GRAPH: Readonly<Record<ServiceCaseStatus, readonly ServiceCaseStatus[]>> = {
  OPEN: ["SCHEDULED", "CHECKED_IN", "CANCELLED"],
  SCHEDULED: ["CHECKED_IN", "CANCELLED"],
  CHECKED_IN: ["DIAGNOSING", "READY", "CANCELLED"],
  DIAGNOSING: ["QUOTE_PENDING", "IN_REPAIR", "EXTERNAL", "READY", "CANCELLED"],
  QUOTE_PENDING: ["IN_REPAIR", "READY", "CANCELLED"],
  IN_REPAIR: ["QA", "EXTERNAL", "QUOTE_PENDING", "READY", "CANCELLED"],
  EXTERNAL: ["IN_REPAIR", "QA", "READY"],
  QA: ["READY", "IN_REPAIR"],
  READY: ["DELIVERED", "ABANDONED", "CANCELLED"],
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
  REVISE_QUOTE: ["QUOTE_PENDING"],
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
  CANCEL: ["OPEN", "SCHEDULED", "CHECKED_IN", "DIAGNOSING", "QUOTE_PENDING", "IN_REPAIR", "EXTERNAL", "QA", "READY"],
  ABANDON: ["READY"],
};

const EVENT_TYPE: Readonly<Record<ServiceCaseActionType, ServiceCaseEventType>> = {
  SCHEDULE: "case.scheduled",
  CHECK_IN: "case.checked_in",
  START_DIAGNOSIS: "case.diagnosis_started",
  SEND_QUOTE: "quote.sent",
  REVISE_QUOTE: "quote.revised",
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

/**
 * Actions that may leave the status unchanged: holds, a cancel at EXTERNAL (requested) or of a held READY item, and
 * a quote revision (QUOTE_PENDING stays QUOTE_PENDING).
 */
const IN_PLACE_ACTIONS: readonly ServiceCaseActionType[] = ["SET_HOLD", "CLEAR_HOLD", "CANCEL", "REVISE_QUOTE"];

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
  cancellationRequestedAfter: boolean;
  effects: ServiceCaseEffect[];
  withdrawQuote: ServiceQuoteRef | null;
  supersedeQuote: { superseded: ServiceQuoteRef; next: ServiceQuoteRef } | null;
  texts: ServiceDecisionTexts;
  eventType: ServiceCaseEventType | null;
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

/** Unicode code points — what PostgreSQL char_length() counts for UTF-8 text (not UTF-16 units, not bytes). */
export function reasonLength(text: string): number {
  return Array.from(text).length;
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

  if ((type as string) === "OPEN") {
    // 1.1c: opening creates a case (openServiceCase); it never applies to one that exists — no second opening.
    return refuse(type, from, [violation("INVALID_TRANSITION", "OPEN creates a case; it never applies to an existing one")]);
  }
  if (!(type in ACTION_FROM)) return refuse(type, from, [violation("INVALID_INPUT", `unknown action ${String(type)}`)]);
  if (typeof context.cancellationRequested !== "boolean") {
    return refuse(type, from, [violation("INCONSISTENT_CASE_STATE", "cancellationRequested must be a boolean")]);
  }
  if (context.cancellationRequested && from !== "EXTERNAL") {
    // A request exists only while a supplier has the item; anything else is corrupt input — refused, never repaired.
    return refuse(type, from, [violation("INCONSISTENT_CASE_STATE", `cancellationRequested is set while ${from}`)]);
  }
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
  // The cancel request, the target status and the event type must tell the same story.
  if (r.cancellationRequestedAfter && r.to !== "EXTERNAL") {
    broken.push(violation("INCONSISTENT_CASE_STATE", "a pending cancel request exists only in EXTERNAL"));
  }
  const requestedNow = !context.cancellationRequested && r.cancellationRequestedAfter;
  if (requestedNow !== (r.eventType === "case.cancellation_requested")) {
    broken.push(violation("INCONSISTENT_CASE_STATE", "event type and cancel request disagree"));
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
    cancellationRequestedAfter: r.cancellationRequestedAfter,
    effects: [...r.effects],
    withdrawQuote: r.withdrawQuote ? { ...r.withdrawQuote } : null,
    supersedeQuote: r.supersedeQuote
      ? { superseded: { ...r.supersedeQuote.superseded }, next: { ...r.supersedeQuote.next } }
      : null,
    texts: { ...r.texts },
    serverChecks: [...r.serverChecks],
    event: {
      type: r.eventType ?? EVENT_TYPE[type],
      action: type,
      fromStatus: from,
      toStatus: r.to,
      holdReasonBefore: context.holdReason,
      holdReasonAfter: r.holdReason,
      cancellationRequestedBefore: context.cancellationRequested,
      cancellationRequestedAfter: r.cancellationRequestedAfter,
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
    // Carried over unless the action changes it (CANCEL at EXTERNAL → true; the return that completes it → false).
    cancellationRequestedAfter: context.cancellationRequested,
    effects: [],
    withdrawQuote: null,
    supersedeQuote: null,
    texts: { cancelReason: null, abandonReason: null, debtOverrideReason: null, loanerOverrideReason: null },
    eventType: null,
    serverChecks: [],
    payload: {},
    violations: [],
  };
  const fail = (code: ServiceCaseViolationCode, detail: string) => r.violations.push(violation(code, detail));
  /**
   * A reason as it will be stored: trimmed, or null when blank. Over the limit → REASON_TOO_LONG (never truncated).
   * The detail names the field and the limit, never the text itself.
   */
  const takeReason = (raw: unknown, field: string): string | null => {
    if (!hasText(raw)) return null;
    const text = raw.trim();
    if (reasonLength(text) > SERVICE_REASON_MAX_LENGTH) {
      fail("REASON_TOO_LONG", `${field} exceeds ${SERVICE_REASON_MAX_LENGTH} characters`);
    }
    return text;
  };
  const onSite = context.kind !== "IN_SHOP";
  /**
   * Owner decisions 2–3 (1.3a, 2026-11-09): a technician is optional. With none assigned the signed-in owner handles
   * the case (diagnosis, repair, an on-site visit) — the journal names the acting user on every event. An assigned
   * technician must belong to the business (a server check). Nothing is created in the staff model.
   */
  const technician = () => {
    if (context.staffMemberId === null) {
      r.payload.handledByOwner = true;
      return;
    }
    if (!isPositiveInt(context.staffMemberId)) fail("INVALID_INPUT", "staffMemberId");
    else {
      r.payload.handledByOwner = false;
      r.serverChecks.push("STAFF_BELONGS_TO_BUSINESS");
    }
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
        technician();
        if (!isPositiveInt(context.siteId)) fail("SITE_REQUIRED", "an on-site visit needs the customer site");
        else r.serverChecks.push("SITE_BELONGS_TO_CUSTOMER");
      }
      break;
    }
    case "CHECK_IN": {
      r.to = "CHECKED_IN";
      if (onSite) {
        technician();
      } else {
        // Owner decision 2026-11-11: no customer signature. The intake is documented (condition; accessories — "none
        // handed over" is a valid record) and the acting owner / authorized user confirms it explicitly; the journal
        // event names who, when, the case and the status change.
        const i = context.intake;
        const missing = !i
          ? ["condition", "accessories"]
          : [...(i.conditionRecorded ? [] : ["condition"]), ...(i.accessoriesRecorded ? [] : ["accessories"])];
        if (missing.length > 0) fail("INTAKE_INCOMPLETE", `missing: ${missing.join(", ")}`);
        if ((action as { intakeConfirmed?: boolean }).intakeConfirmed !== true) fail("INTAKE_NOT_CONFIRMED", "the owner confirms the documented intake");
        r.payload.intakeConfirmed = true;
      }
      break;
    }
    case "START_DIAGNOSIS": {
      r.to = "DIAGNOSING";
      technician();
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
    case "REVISE_QUOTE": {
      // ז-1 A: replace the version awaiting the customer with the next one; the case stays QUOTE_PENDING.
      r.to = "QUOTE_PENDING";
      const cur = context.currentQuote;
      const q = action.quote;
      if (!cur) {
        fail("QUOTE_NOT_AWAITING_DECISION", "there is no quote to revise");
        break;
      }
      if (cur.state === "WITHDRAWN") {
        fail("QUOTE_WITHDRAWN", `version ${cur.version} was withdrawn`);
        break;
      }
      if (cur.state === "SUPERSEDED") {
        fail("QUOTE_SUPERSEDED", `version ${cur.version} was already replaced`);
        break;
      }
      if (cur.state !== "SENT") {
        fail("QUOTE_NOT_AWAITING_DECISION", `version ${cur.version} is ${cur.state}, not awaiting a decision`);
        break;
      }
      if (!action.replaces || action.replaces.version !== cur.version) {
        fail("QUOTE_VERSION_MISMATCH", `only the current version ${cur.version} can be revised`);
      }
      if (!q || !isPositiveInt(q.version) || !isNonNegativeInt(q.totalAgorot) || !hasText(q.docHash)) {
        fail("INVALID_INPUT", "quote needs version ≥ 1, an integer total in agorot ≥ 0 and the document hash");
        break;
      }
      if (q.version !== cur.version + 1) {
        fail("QUOTE_VERSION_NOT_NEXT", `the new version must be ${cur.version + 1}`);
      }
      if (q.totalAgorot === 0 && context.coverage?.decision !== "APPROVED") {
        fail("QUOTE_TOTAL_REQUIRES_COVERAGE", "a ₪0 quote is only for an approved cover");
      }
      r.effects.push("SUPERSEDE_OPEN_QUOTE");
      r.supersedeQuote = {
        superseded: { version: cur.version, totalAgorot: cur.totalAgorot, docHash: cur.docHash },
        next: { version: q.version, totalAgorot: q.totalAgorot, docHash: q.docHash },
      };
      r.serverChecks.push("QUOTE_DOCUMENT_MATCHES_HASH");
      r.payload.supersededQuoteVersion = cur.version;
      r.payload.quoteVersion = q.version;
      r.payload.totalAgorot = q.totalAgorot;
      break;
    }
    case "APPROVE_QUOTE": {
      r.to = "IN_REPAIR";
      const q = context.currentQuote;
      const a = action.approval;
      if (q?.state === "WITHDRAWN") {
        fail("QUOTE_WITHDRAWN", `version ${q.version} was withdrawn and can no longer be approved`);
        break;
      }
      if (q?.state === "SUPERSEDED") {
        fail("QUOTE_SUPERSEDED", `version ${q.version} was replaced and can no longer be approved`);
        break;
      }
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
      if (q?.state === "WITHDRAWN") fail("QUOTE_WITHDRAWN", `version ${q.version} was withdrawn`);
      else if (q?.state === "SUPERSEDED") fail("QUOTE_SUPERSEDED", `version ${q.version} was replaced`);
      else if (!q || q.state !== "SENT") fail("QUOTE_NOT_AWAITING_DECISION", "no sent quote awaits a decision");
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
      if (context.cancellationRequested) {
        // The cancel requested while the item was away completes here: back from the supplier, ready to hand back.
        if (action.next !== "READY") {
          fail("CANCELLATION_REQUESTED", "the case was cancelled: the returned item goes to READY");
          break;
        }
        if (action.outcome !== undefined) {
          fail("OUTCOME_NOT_ALLOWED", "a cancelled case returns with outcome CANCELLED");
          break;
        }
        r.outcome = "CANCELLED";
        r.cancellationRequestedAfter = false; // completed — no longer pending
        r.payload.outcome = "CANCELLED";
        r.payload.cancellationCompleted = true;
        break;
      }
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
          else {
            const reason = takeReason(action.debtOverride.reason, "debtOverride.reason");
            if (reason === null) fail("OVERRIDE_REASON_REQUIRED", "debt decision reason");
            else {
              r.texts.debtOverrideReason = reason;
              r.payload.debtOverride = true;
            }
          }
        }
        r.serverChecks.push("SETTLEMENT_READ_IN_SAME_TRANSACTION");
      }
      if (context.openLoaner) {
        if (!action.loanerOverride) fail("OPEN_LOANER", "the temporary replacement item has not been returned");
        else {
          const reason = takeReason(action.loanerOverride.reason, "loanerOverride.reason");
          if (reason === null) fail("OVERRIDE_REASON_REQUIRED", "loaner decision reason");
          else {
            r.texts.loanerOverrideReason = reason;
            r.payload.loanerOverride = true;
          }
        }
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
      const atSupplier = context.status === "EXTERNAL";
      const held = itemHeldByBusiness(context.kind, context.status);
      if (context.outcome === "CANCELLED" || context.cancellationRequested) {
        fail("ALREADY_CANCELLED", "this case is already cancelled");
        break;
      }
      const reason = takeReason(action.reason, "reason");
      if ((held || atSupplier) && reason === null) {
        fail("REASON_REQUIRED", "cancelling while the item is with the business or a supplier needs a reason");
        break;
      }
      // One reason column for the case, whether the cancel completes now or (at a supplier) on the item's return.
      r.texts.cancelReason = reason;
      r.payload.reasonRecorded = reason !== null;
      r.payload.itemHeldByBusiness = held;
      r.payload.itemAtSupplier = atSupplier;
      r.payload.quoteStateAtCancel = context.currentQuote?.state ?? null;
      r.payload.openPartReservations = isNonNegativeInt(context.openPartReservations) ? context.openPartReservations : null;
      if (context.status === "READY") r.payload.previousOutcome = context.outcome;
      if (atSupplier) {
        // Requested only: the item cannot be "ready" while a supplier has it. The return completes the cancel.
        r.to = "EXTERNAL";
        r.outcome = null;
        r.eventType = "case.cancellation_requested";
        r.cancellationRequestedAfter = true;
      } else {
        // A held item is not "returned" by a cancel: it leaves through READY → DELIVERED with the normal handover.
        r.to = held ? "READY" : "CANCELLED";
        r.outcome = "CANCELLED";
      }
      if (context.openPartReservations > 0) r.effects.push("RELEASE_PART_RESERVATIONS");
      const q = context.currentQuote;
      if (q?.state === "SENT") {
        r.effects.push("WITHDRAW_OPEN_QUOTE");
        r.withdrawQuote = { version: q.version, totalAgorot: q.totalAgorot, docHash: q.docHash };
        r.payload.withdrawnQuoteVersion = q.version;
      }
      break;
    }
    case "ABANDON": {
      r.to = "ABANDONED";
      const reason = takeReason(action.reason, "reason");
      if (reason === null) fail("REASON_REQUIRED", "marking an item as not collected needs a reason");
      else {
        r.texts.abandonReason = reason;
        r.payload.reasonRecorded = true;
      }
      if (!isNonNegativeInt(context.pickupRemindersSent) || context.pickupRemindersSent < 1) {
        fail("PICKUP_REMINDERS_REQUIRED", "at least one documented pickup reminder must precede it");
      } else {
        r.payload.pickupRemindersSent = context.pickupRemindersSent;
      }
      break;
    }
    default: {
      const never: never = action;
      // Only the action's type, never the action's content (it may carry free text).
      fail("INVALID_INPUT", `unknown action ${String((never as { type?: unknown }).type)}`);
    }
  }

  return r;
}

// ── Opening a case (1.1c) ──────────────────────────────────────────────────────────────────────────────────

/**
 * Judges the creation of a case. On success the service inserts the case (status OPEN, version 1, no hold, no
 * outcome, no cancel request) and then the `case.opened` event with seq 1, in ONE transaction. Only the owner opens
 * a case (ש2; the customer link of M2 does not). The payload holds ids and the kind only — never free text.
 */
export function openServiceCase(input: ServiceCaseOpenInput, actor: ServiceCaseActor): ServiceCaseOpenDecision {
  const violations: ServiceCaseViolation[] = [];
  if (actor.kind !== "OWNER" || !isPositiveInt(actor.userId)) {
    violations.push(violation("ACTOR_NOT_ALLOWED", `${String(actor?.kind)} may not OPEN`));
  }
  if (!input || !SERVICE_CASE_KINDS.includes(input.kind)) violations.push(violation("INVALID_INPUT", "kind"));
  if (!isPositiveInt(input?.customerId)) violations.push(violation("INVALID_INPUT", "customerId"));
  if (input?.deviceId !== null && !isPositiveInt(input?.deviceId)) violations.push(violation("INVALID_INPUT", "deviceId"));
  if (input?.parentCaseId !== null && !isPositiveInt(input?.parentCaseId)) {
    violations.push(violation("INVALID_INPUT", "parentCaseId"));
  }
  if (violations.length > 0) return { ok: false, action: "OPEN", violations };

  const serverChecks: ServiceServerCheck[] = ["CUSTOMER_BELONGS_TO_BUSINESS"];
  if (input.deviceId !== null) serverChecks.push("DEVICE_BELONGS_TO_CUSTOMER");
  if (input.parentCaseId !== null) serverChecks.push("PARENT_CASE_BELONGS_TO_BUSINESS");
  return {
    ok: true,
    action: "OPEN",
    status: "OPEN",
    version: SERVICE_CASE_INITIAL_VERSION,
    seq: SERVICE_CASE_OPENING_SEQ,
    holdReason: null,
    outcome: null,
    cancellationRequested: false,
    serverChecks,
    event: {
      type: "case.opened",
      action: "OPEN",
      fromStatus: null,
      toStatus: "OPEN",
      holdReasonBefore: null,
      holdReasonAfter: null,
      cancellationRequestedBefore: false,
      cancellationRequestedAfter: false,
      outcome: null,
      actor: { ...actor },
      payload: {
        kind: input.kind,
        customerId: input.customerId,
        deviceId: input.deviceId,
        parentCaseId: input.parentCaseId,
      },
    },
  };
}

// ── Quote withdrawal (service quotes only) ─────────────────────────────────────────────────────────────────

/**
 * The quote after a withdrawal, for the service layer to persist when it applies WITHDRAW_OPEN_QUOTE. Only a SENT
 * version can be withdrawn — never twice, and never an approved or rejected one (its history and approval stay).
 * Version, total, document hash and any earlier approval are carried over unchanged; the input is not mutated.
 */
export function withdrawQuote(quote: ServiceQuoteSnapshot, ref: ServiceQuoteRef): QuoteWithdrawalDecision {
  return closeOpenQuote(quote, ref, "WITHDRAWN");
}

/**
 * The replaced quote after REVISE_QUOTE (effect SUPERSEDE_OPEN_QUOTE), for the service layer to persist. Same rules
 * as withdrawQuote: only a SENT version, exactly the one named, once; its content and history are kept.
 */
export function supersedeQuote(quote: ServiceQuoteSnapshot, ref: ServiceQuoteRef): QuoteWithdrawalDecision {
  return closeOpenQuote(quote, ref, "SUPERSEDED");
}

function closeOpenQuote(
  quote: ServiceQuoteSnapshot,
  ref: ServiceQuoteRef,
  next: "WITHDRAWN" | "SUPERSEDED",
): QuoteWithdrawalDecision {
  if (quote.state !== "SENT") {
    const code: ServiceCaseViolationCode =
      quote.state === "WITHDRAWN" ? "QUOTE_WITHDRAWN" : quote.state === "SUPERSEDED" ? "QUOTE_SUPERSEDED" : "QUOTE_NOT_AWAITING_DECISION";
    return { ok: false, violations: [violation(code, `version ${quote.version} is ${quote.state}, not open`)] };
  }
  if (ref.version !== quote.version || ref.totalAgorot !== quote.totalAgorot || ref.docHash !== quote.docHash) {
    return { ok: false, violations: [violation("QUOTE_VERSION_MISMATCH", "the instruction names another version")] };
  }
  return {
    ok: true,
    quote: { ...quote, state: next, approval: quote.approval ? { ...quote.approval } : null },
  };
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
 * warranty only when the parent was REPAIRED and the new case opens ON OR BEFORE the end date of the parent's LOCKED
 * commercial warranty offer (owner decision ש4, 1.3a): the exact date that was printed for the customer, compared as
 * Israel calendar days — never a guessed number of days, never extended. With no locked offer (null) it is never
 * within one and the decision says so (commercialWarrantySet: false) — that is "no commercial warranty was recorded",
 * not "the customer has no warranty": statutory rights are outside this decision.
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
  const endsOnRaw = input.parentWarrantyEndsOn;
  const endsOn = endsOnRaw === null ? null : typeof endsOnRaw === "string" ? dayNumber(endsOnRaw) : null;
  if (endsOnRaw !== null && endsOn === null) violations.push(violation("INVALID_INPUT", "parentWarrantyEndsOn"));
  if (delivered !== null && endsOn !== null && endsOn < delivered) {
    violations.push(violation("INVALID_INPUT", "the warranty cannot end before the parent was handed back"));
  }
  if (delivered !== null && opened !== null && opened < delivered) {
    violations.push(violation("INVALID_INPUT", "openedOn precedes the parent's delivery"));
  }
  if (violations.length > 0 || delivered === null || opened === null) return { ok: false, violations };

  const daysSinceDelivery = opened - delivered;
  return {
    ok: true,
    daysSinceDelivery,
    commercialWarrantySet: endsOn !== null,
    warrantyEndsOn: endsOn === null ? null : (endsOnRaw as string),
    withinRepairWarranty: endsOn !== null && parent.outcome === "REPAIRED" && opened <= endsOn,
  };
}
