/**
 * Service Desk (שירות, תיקונים ואחריות) — the data contracts of the ServiceCase state machine.
 *
 * Task 1.1: contracts only. Nothing here touches the database, the clock or the network, and nothing here is a
 * Prisma model — the tables come in a separate, owner-approved migration (task 1.2). The pure rules that read
 * these contracts live in service-case.core.ts.
 *
 * Three fields, never one:
 *   status      — the stage of the life cycle (13 values);
 *   holdReason  — why an IN_REPAIR case is waiting (parts / customer); it never becomes a status;
 *   outcome     — how the case ended (repaired / not repaired / replaced / quote rejected / cancelled).
 *
 * What the core can NOT promise: atomicity, locking, idempotency, audit persistence, balances, stock or
 * permissions. It judges the facts it is handed; the future command service (task 1.3) must load those facts
 * under a row lock, compare the version, record the idempotency key and write the event in one transaction.
 */

// ── Status, kind, hold, outcome ────────────────────────────────────────────────────────────────────────────

export const SERVICE_CASE_STATUSES = [
  "OPEN", // נפתחה
  "SCHEDULED", // מתואם
  "CHECKED_IN", // התקבל
  "DIAGNOSING", // באבחון
  "QUOTE_PENDING", // ממתין לאישור הצעה
  "IN_REPAIR", // בתיקון
  "EXTERNAL", // אצל ספק חיצוני
  "QA", // בדיקת תקינות
  "READY", // מוכן למסירה
  "DELIVERED", // נמסר
  "CLOSED", // נסגר
  "CANCELLED", // בוטל
  "ABANDONED", // לא נאסף
] as const;
export type ServiceCaseStatus = (typeof SERVICE_CASE_STATUSES)[number];

/** Statuses no action may leave. ABANDONED is NOT terminal: the item may still be collected, or the case closed. */
export const TERMINAL_STATUSES: readonly ServiceCaseStatus[] = ["CLOSED", "CANCELLED"];

/** IN_SHOP = store / lab (the MVP). FIELD and MAINTENANCE are modelled only so the contract does not need to change. */
export const SERVICE_CASE_KINDS = ["IN_SHOP", "FIELD", "MAINTENANCE"] as const;
export type ServiceCaseKind = (typeof SERVICE_CASE_KINDS)[number];

/** Valid only while the case is IN_REPAIR. A supplier wait is the EXTERNAL status, not a hold. */
export const SERVICE_HOLD_REASONS = ["PARTS", "CUSTOMER"] as const;
export type ServiceHoldReason = (typeof SERVICE_HOLD_REASONS)[number];

export const SERVICE_OUTCOMES = ["REPAIRED", "NOT_REPAIRED", "REPLACED", "QUOTE_REJECTED", "CANCELLED"] as const;
export type ServiceOutcome = (typeof SERVICE_OUTCOMES)[number];

// ── Facts the core is handed ───────────────────────────────────────────────────────────────────────────────

/** Where a warranty or contract cover comes from. Covering is the technician's decision after diagnosis. */
export type ServiceCoverageSource = "MANUFACTURER" | "STORE" | "REPAIR" | "CONTRACT";
export interface ServiceCoverage {
  source: ServiceCoverageSource;
  decision: "PENDING" | "APPROVED" | "DENIED";
}

/** How a customer's quote decision reached the business. LINK = the secure customer link of M2 (contract only). */
export type QuoteApprovalMethod = "LINK" | "PHONE" | "IN_PERSON";

/** One approval is bound to exactly one quote version, its total and the hash of the issued quote document. */
export interface QuoteApproval {
  version: number;
  totalAgorot: number;
  docHash: string;
  method: QuoteApprovalMethod;
}

/**
 * The newest quote version of the case. Any change to a sent quote is a NEW version, which needs a new approval.
 * WITHDRAWN = a sent version taken back because the case was cancelled (owner-approved, service quotes ONLY).
 * SUPERSEDED = a sent version replaced by the next version while the case goes on (REVISE_QUOTE, decision ז-1).
 * Both are local to this module: no billing document status changes, and no global enum gains a value.
 * Neither can ever be approved or rejected.
 */
export interface ServiceQuoteSnapshot {
  version: number;
  totalAgorot: number;
  docHash: string;
  state: "SENT" | "APPROVED" | "REJECTED" | "WITHDRAWN" | "SUPERSEDED";
  approval: QuoteApproval | null;
}

/** Identifies one quote version exactly — what a withdrawal instruction names. */
export interface ServiceQuoteRef {
  version: number;
  totalAgorot: number;
  docHash: string;
}

export type QuoteWithdrawalDecision =
  | { ok: true; quote: ServiceQuoteSnapshot }
  | { ok: false; violations: readonly ServiceCaseViolation[] };

/**
 * IN_SHOP check-in record (the core sees booleans). Owner decision 2026-11-11: no customer signature anywhere —
 * customerSigned is kept for records written before the decision and is no longer required by any rule.
 */
export interface ServiceIntakeFacts {
  conditionRecorded: boolean;
  accessoriesRecorded: boolean;
  customerSigned: boolean;
}

/**
 * The balance of the case's billing documents, as the billing services report it. The core never computes it.
 * `known: false` (the service could not establish it) makes delivery refuse — fail closed.
 */
export type ServiceSettlementFacts = { known: true; openBalanceAgorot: number } | { known: false };

/** Everything the core judges a transition by. The service layer loads it, under lock, per command. */
export interface ServiceCaseContext {
  kind: ServiceCaseKind;
  status: ServiceCaseStatus;
  holdReason: ServiceHoldReason | null;
  outcome: ServiceOutcome | null;
  version: number;
  staffMemberId: number | null;
  /** FIELD / MAINTENANCE: the customer site. Unused for IN_SHOP. */
  siteId: number | null;
  coverage: ServiceCoverage | null;
  currentQuote: ServiceQuoteSnapshot | null;
  intake: ServiceIntakeFacts | null;
  qaChecklistCompleted: boolean;
  /** Parts reserved for this case and neither consumed nor released. */
  openPartReservations: number;
  /** A temporary replacement item lent to the customer and not yet returned. */
  openLoaner: boolean;
  /**
   * A cancel was requested while the item was at an external supplier (EXTERNAL). There is no extra status for it:
   * the case stays EXTERNAL until the return is recorded, and that return must lead to READY / CANCELLED.
   * Valid only with status EXTERNAL — `true` anywhere else is refused as INCONSISTENT_CASE_STATE, never repaired.
   * Its next value is in every ok decision (`cancellationRequestedAfter`): the service persists THAT, never infers it.
   */
  cancellationRequested: boolean;
  /** Pickup reminders already sent while READY. */
  pickupRemindersSent: number;
  settlement: ServiceSettlementFacts;
}

// ── Who acts ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * No new permission system (owner decision ש2): the business has one user, the OWNER. A customer acts only
 * through the M2 secure link (CUSTOMER_LINK, contract only for now); SYSTEM is the future sweep / auto-close.
 * An owner-only decision is an explicit override object with a reason, carried by an OWNER actor.
 */
export type ServiceCaseActor =
  | { kind: "OWNER"; userId: number }
  | { kind: "CUSTOMER_LINK" }
  | { kind: "SYSTEM" };

export interface OwnerOverride {
  reason: string;
}

/**
 * Free-text reasons are never journal data (decision ט-1 A): the journal payload holds only short tokens, numbers
 * and booleans. A reason is trimmed, must be non-empty where it is required, and is at most this many Unicode code
 * points — the same unit PostgreSQL's char_length() counts, so a future CHECK can enforce the identical rule.
 */
export const SERVICE_REASON_MAX_LENGTH = 1000;

/**
 * The free text a successful decision carries for the service layer to store in its business columns
 * (ServiceCase.cancelReason / abandonReason, ServiceHandover.debtOverrideReason / loanerOverrideReason).
 * All four are always present; a reason the action does not carry is null.
 */
export interface ServiceDecisionTexts {
  cancelReason: string | null;
  abandonReason: string | null;
  debtOverrideReason: string | null;
  loanerOverrideReason: string | null;
}

// ── Actions ────────────────────────────────────────────────────────────────────────────────────────────────

export interface HandoverReceipt {
  receivedByName: string;
  signatureCaptured: boolean;
}

export type ServiceCaseAction =
  | { type: "SCHEDULE"; appointmentId: number }
  /** IN_SHOP: the owner (or an authorized user) confirms the documented intake explicitly — no customer signature. */
  | { type: "CHECK_IN"; intakeConfirmed?: boolean }
  | { type: "START_DIAGNOSIS" }
  | { type: "SEND_QUOTE"; quote: { version: number; totalAgorot: number; docHash: string } }
  /** Replace the SENT version `replaces` with the next version, while the case stays QUOTE_PENDING (ז-1 A). */
  | { type: "REVISE_QUOTE"; replaces: { version: number }; quote: { version: number; totalAgorot: number; docHash: string } }
  | { type: "APPROVE_QUOTE"; approval: QuoteApproval }
  | { type: "REJECT_QUOTE"; version: number }
  | { type: "START_REPAIR" }
  | { type: "SET_HOLD"; reason: ServiceHoldReason }
  | { type: "CLEAR_HOLD" }
  | { type: "SEND_TO_EXTERNAL"; supplierId: number }
  | {
      type: "RETURN_FROM_EXTERNAL";
      next: "IN_REPAIR" | "QA" | "READY";
      outcome?: "REPAIRED" | "NOT_REPAIRED" | "REPLACED";
      replacementDeviceId?: number;
    }
  | { type: "FINISH_REPAIR"; outcome?: "REPAIRED" | "REPLACED"; replacementDeviceId?: number }
  | { type: "PASS_QA"; outcome: "REPAIRED" | "REPLACED"; replacementDeviceId?: number }
  | { type: "FAIL_QA" }
  | { type: "MARK_NOT_REPAIRABLE" }
  | { type: "DELIVER"; receipt: HandoverReceipt; debtOverride?: OwnerOverride; loanerOverride?: OwnerOverride }
  | { type: "CLOSE" }
  | { type: "CANCEL"; reason?: string }
  | { type: "ABANDON"; reason: string };

export type ServiceCaseActionType = ServiceCaseAction["type"];

/**
 * Task 1.1c — opening a case. OPEN is NOT a transition: it has no "from" status, it never applies to an existing case
 * (evaluateTransition refuses it), and it is judged only by openServiceCase. Every case starts at OPEN, version 1,
 * and its journal starts with exactly one `case.opened` event at seq 1; each later transition is seq = version.
 */
export interface ServiceCaseOpenAction {
  type: "OPEN";
}

/** What a new case is opened with. Ids only — the problem description is a business column, never journal data. */
export interface ServiceCaseOpenInput {
  kind: ServiceCaseKind;
  customerId: number;
  deviceId: number | null;
  /** A repeat repair (evaluateRepeatCase) names its parent; otherwise null. */
  parentCaseId: number | null;
}

/** Every action a journal row may name: OPEN + the 20 transition actions (the database enum's 21 values). */
export type ServiceJournalActionType = ServiceCaseOpenAction["type"] | ServiceCaseActionType;

export const SERVICE_CASE_INITIAL_VERSION = 1;
export const SERVICE_CASE_OPENING_SEQ = 1;

/** The future command (task 1.3). The core only checks its shape and the version; the service enforces it. */
export interface ServiceCaseCommand {
  caseId: number;
  action: ServiceCaseAction;
  expectedVersion: number;
  idempotencyKey: string;
}

// ── Results ────────────────────────────────────────────────────────────────────────────────────────────────

export type ServiceCaseViolationCode =
  | "INVALID_TRANSITION"
  | "TERMINAL_STATUS"
  | "ACTOR_NOT_ALLOWED"
  | "INVALID_INPUT"
  | "VERSION_CONFLICT"
  | "STAFF_REQUIRED"
  | "SITE_REQUIRED"
  | "INTAKE_INCOMPLETE"
  | "INTAKE_NOT_CONFIRMED"
  | "QUOTE_TOTAL_REQUIRES_COVERAGE"
  | "QUOTE_VERSION_NOT_NEWER"
  | "QUOTE_NOT_AWAITING_DECISION"
  | "QUOTE_VERSION_MISMATCH"
  | "QUOTE_WITHDRAWN"
  | "QUOTE_SUPERSEDED"
  | "QUOTE_VERSION_NOT_NEXT"
  | "REASON_TOO_LONG"
  | "ALREADY_CANCELLED"
  | "CANCELLATION_REQUESTED"
  | "INCONSISTENT_CASE_STATE"
  | "APPROVAL_MISMATCH"
  | "APPROVAL_METHOD_NOT_ALLOWED"
  | "REPAIR_NOT_AUTHORIZED"
  | "COVERAGE_NOT_APPROVED"
  | "HOLD_UNCHANGED"
  | "NO_HOLD"
  | "QA_NOT_FOR_KIND"
  | "QA_INCOMPLETE"
  | "OUTCOME_REQUIRED"
  | "OUTCOME_NOT_ALLOWED"
  | "REPLACEMENT_DEVICE_REQUIRED"
  | "RECEIPT_INCOMPLETE"
  | "BALANCE_UNKNOWN"
  | "OPEN_BALANCE_NEEDS_OWNER_DECISION"
  | "OPEN_LOANER"
  | "OVERRIDE_REASON_REQUIRED"
  | "OPEN_PART_RESERVATIONS"
  | "OPEN_QUOTE"
  | "REASON_REQUIRED"
  | "PICKUP_REMINDERS_REQUIRED";

export interface ServiceCaseViolation {
  code: ServiceCaseViolationCode;
  detail: string;
}

/**
 * Facts the core cannot know and the service MUST verify against the database before committing. Listed per
 * decision so a caller can never forget one; the core's "ok" is conditional on them.
 */
export type ServiceServerCheck =
  | "STAFF_BELONGS_TO_BUSINESS"
  | "APPOINTMENT_BELONGS_TO_CASE"
  | "SITE_BELONGS_TO_CUSTOMER"
  | "INTAKE_ARTIFACTS_STORED"
  | "QUOTE_DOCUMENT_MATCHES_HASH"
  | "SUPPLIER_BELONGS_TO_BUSINESS"
  | "REPLACEMENT_DEVICE_BELONGS_TO_BUSINESS"
  | "SETTLEMENT_READ_IN_SAME_TRANSACTION"
  | "PART_RESERVATIONS_COUNTED_UNDER_LOCK"
  // 1.1c — opening a case
  | "CUSTOMER_BELONGS_TO_BUSINESS"
  | "DEVICE_BELONGS_TO_CUSTOMER"
  | "PARENT_CASE_BELONGS_TO_BUSINESS";

/** Every command, whatever its action: the service layer's job, never the core's. */
export const SERVICE_COMMAND_SERVER_DUTIES = [
  "authenticate the actor and resolve the business from the session",
  "lock the case row and compare expectedVersion before evaluating",
  "record the idempotency key with the event (a replay returns the first result)",
  "write status / hold / outcome, bump version and append the event in ONE transaction",
] as const;

/** Instructions for the service layer that follow from a decision. The core performs none of them. */
export type ServiceCaseEffect =
  | "RELEASE_PART_RESERVATIONS"
  | "WITHDRAW_OPEN_QUOTE"
  | "SUPERSEDE_OPEN_QUOTE"
  | "ATTEMPT_AUTO_CLOSE"
  | "LINK_REPLACEMENT_DEVICE";

export type ServiceCaseEventType =
  | "case.scheduled"
  | "case.checked_in"
  | "case.diagnosis_started"
  | "quote.sent"
  | "quote.approved"
  | "quote.rejected"
  | "quote.revised"
  | "repair.started"
  | "hold.set"
  | "hold.cleared"
  | "external.sent"
  | "external.returned"
  | "repair.finished"
  | "qa.passed"
  | "qa.failed"
  | "case.not_repairable"
  | "case.delivered"
  | "case.closed"
  | "case.cancelled"
  | "case.cancellation_requested"
  | "case.abandoned";

/** Every event a journal row may carry: `case.opened` (seq 1 only) + the 21 transition events. */
export type ServiceJournalEventType = "case.opened" | ServiceCaseEventType;

export type ServiceEventPayloadValue = string | number | boolean | null;

/** The journal row the service will append (task 1.2 / 1.3). seq, ids and timestamps are the service's. */
export interface ServiceCaseEventDraft {
  type: ServiceCaseEventType;
  action: ServiceCaseActionType;
  fromStatus: ServiceCaseStatus;
  toStatus: ServiceCaseStatus;
  holdReasonBefore: ServiceHoldReason | null;
  holdReasonAfter: ServiceHoldReason | null;
  cancellationRequestedBefore: boolean;
  cancellationRequestedAfter: boolean;
  outcome: ServiceOutcome | null;
  actor: ServiceCaseActor;
  payload: Readonly<Record<string, ServiceEventPayloadValue>>;
}

/**
 * The first journal row of every case (1.1c). Creation is explicit: there is no "from" status (null), not an
 * artificial OPEN → OPEN. Hold, outcome and the cancel request start empty. The service writes it with seq 1, in the
 * same transaction as the case row (version 1).
 */
export interface ServiceCaseOpenedEventDraft {
  type: "case.opened";
  action: "OPEN";
  fromStatus: null;
  toStatus: "OPEN";
  holdReasonBefore: null;
  holdReasonAfter: null;
  cancellationRequestedBefore: false;
  cancellationRequestedAfter: false;
  outcome: null;
  actor: ServiceCaseActor;
  payload: Readonly<Record<string, ServiceEventPayloadValue>>;
}

/** Any journal row: the opening event or a transition event. */
export type ServiceJournalEventDraft = ServiceCaseOpenedEventDraft | ServiceCaseEventDraft;

export type ServiceCaseOpenDecision =
  | {
      ok: true;
      action: "OPEN";
      status: "OPEN";
      version: typeof SERVICE_CASE_INITIAL_VERSION;
      /** The opening event's seq — always 1; the service never computes it. */
      seq: typeof SERVICE_CASE_OPENING_SEQ;
      holdReason: null;
      outcome: null;
      cancellationRequested: false;
      serverChecks: readonly ServiceServerCheck[];
      event: ServiceCaseOpenedEventDraft;
    }
  | { ok: false; action: "OPEN"; violations: readonly ServiceCaseViolation[] };

export type ServiceTransitionDecision =
  | {
      ok: true;
      action: ServiceCaseActionType;
      from: ServiceCaseStatus;
      to: ServiceCaseStatus;
      statusChanged: boolean;
      holdReason: ServiceHoldReason | null;
      outcome: ServiceOutcome | null;
      /**
       * The value of `cancellationRequested` AFTER this transition — always present, carried over when the action
       * does not touch it. It is the only source of that state: no effect or event name sets it.
       */
      cancellationRequestedAfter: boolean;
      effects: readonly ServiceCaseEffect[];
      /** Set with effect WITHDRAW_OPEN_QUOTE: the exact sent version the service must mark WITHDRAWN. */
      withdrawQuote: ServiceQuoteRef | null;
      /**
       * Set with effect SUPERSEDE_OPEN_QUOTE (REVISE_QUOTE): mark `superseded` SUPERSEDED and create `next` as the one
       * SENT version — both, with the case update and the event, in one transaction (task 1.3).
       */
      supersedeQuote: { superseded: ServiceQuoteRef; next: ServiceQuoteRef } | null;
      /** Free text for the business columns — never in `event.payload`. */
      texts: ServiceDecisionTexts;
      serverChecks: readonly ServiceServerCheck[];
      event: ServiceCaseEventDraft;
    }
  | {
      ok: false;
      action: ServiceCaseActionType;
      from: ServiceCaseStatus;
      violations: readonly ServiceCaseViolation[];
    };

// ── Repeat repair ──────────────────────────────────────────────────────────────────────────────────────────

/** A repeat repair is a NEW case linked to its parent; a closed case is never reopened. Dates are YYYY-MM-DD. */
export interface RepeatCaseInput {
  parent: { status: ServiceCaseStatus; outcome: ServiceOutcome | null; deliveredOn: string | null };
  /** The day the new case opens, as an Israel calendar day (YYYY-MM-DD). */
  openedOn: string;
  /**
   * The end date (YYYY-MM-DD, inclusive) of the parent case's LOCKED commercial warranty offer of the same business
   * (ServiceWarrantyOffer, state LOCKED) — or null when the parent has none. The core has no default and never derives a
   * period from settings (owner decision ש4, 1.3a). null never means "no warranty": the customer's rights under the law
   * apply whatever this says, and no wording may present a repeat as carrying no warranty at all.
   */
  parentWarrantyEndsOn: string | null;
}

export type RepeatCaseDecision =
  | {
      ok: true;
      /** Opened on or before the locked end date, parent REPAIRED. Always false with no locked offer — statutory rights unaffected. */
      withinRepairWarranty: boolean;
      /** false: no locked commercial warranty was recorded for the parent — not "the customer has none". */
      commercialWarrantySet: boolean;
      /** The locked end date the decision used, or null. */
      warrantyEndsOn: string | null;
      daysSinceDelivery: number;
    }
  | { ok: false; violations: readonly ServiceCaseViolation[] };
