/**
 * Service Desk — a temporary replacement item lent to the customer during service (loaner, "פריט חלופי"). The contracts
 * of the pure core (loans.core.ts); the tables are migration 20261201090000_service_desk_loans. Generic: any business
 * that lends something while it serves (a phone, a car, a tool, a router, a heater …).
 *
 * Owner rules (2026-11-12):
 *   - a loan is its own record (ServiceLoan + its append-only journal ServiceLoanEvent), never a case status;
 *   - lent while the work is under way (LOAN_WORK_STATUSES); in OPEN / SCHEDULED / READY only as an approved exception
 *     with a reason (LEND_OUTSIDE_WORK); never on a finished, cancelled or closed case, nor one being cancelled;
 *   - one identified item is never out twice (the database's partial UNIQUE index on the normalized identifier decides);
 *   - returned once, in any case status — also after the repaired item was handed back, or the case closed / cancelled;
 *   - a loan that will not come back is closed only by an approved action with a reason (LOAN_CLOSE_UNRETURNED);
 *   - INVENTORY: a loan may name an inventory item, READ-ONLY. No stock movement is written or implied — the inventory
 *     movement contract (M0) is not ready; moving stock for a loan is a separate, later decision.
 */

export const LOAN_CONDITIONS = ["GOOD", "WORN", "DAMAGED", "NOT_WORKING"] as const;
export type LoanCondition = (typeof LOAN_CONDITIONS)[number];

export const LOAN_CLOSE_REASONS = ["LOST", "KEPT_BY_CUSTOMER", "WRITTEN_OFF"] as const;
export type LoanCloseReason = (typeof LOAN_CLOSE_REASONS)[number];

export const LOAN_STATES = ["OUT", "RETURNED", "CLOSED"] as const;
export type LoanState = (typeof LOAN_STATES)[number];

export const LOAN_EVENT_KINDS = ["LENT", "EXPECTED_RETURN_CHANGED", "RETURNED", "CLOSED", "CASE_EXIT_APPROVED"] as const;
export type LoanEventKind = (typeof LOAN_EVENT_KINDS)[number];

/** The case statuses in which lending is the normal path (the work is under way). */
export const LOAN_WORK_STATUSES = ["CHECKED_IN", "DIAGNOSING", "QUOTE_PENDING", "IN_REPAIR", "EXTERNAL", "QA"] as const;
/** The case statuses in which lending is an approved EXCEPTION with a reason (LEND_OUTSIDE_WORK). */
export const LOAN_EXCEPTION_STATUSES = ["OPEN", "SCHEDULED", "READY"] as const;
// Every other status (WORK_DONE, DELIVERED, ABANDONED, CLOSED, CANCELLED) refuses a loan.

/** The CHECK limits of migration 20261201090000 (code points, as char_length counts). */
export const LOAN_LIMITS = { itemName: 200, itemIdentifier: 100, note: 1000, reason: 1000 } as const;

/** The database's normalization of an identifier (CHECK ServiceLoan_identifier_normalized) — upper case, no blanks . _ / -. */
export function normalizeLoanIdentifier(raw: string): string {
  return raw.replace(/[\s._/-]+/gu, "").toUpperCase();
}

/** What the case looks like to a loan, read under the case lock. */
export interface LoanCaseFacts {
  status: string;
  outcome: string | null;
  cancellationRequested: boolean;
}

export interface LendInput {
  itemName: string;
  itemIdentifier?: string | null;
  inventoryItemId?: number | null;
  conditionAtLend: LoanCondition;
  lendNote?: string | null;
  expectedReturnOn?: string | null;
  /** Required (and only allowed) when the case is in an exception status. */
  exceptionReason?: string | null;
}

export interface LoanSnapshot {
  state: LoanState;
  version: number;
  expectedReturnOn: string | null;
}

export type LoanAction =
  | { type: "RETURN"; conditionAtReturn: LoanCondition; returnNote?: string | null }
  | { type: "CLOSE_UNRETURNED"; closeReason: LoanCloseReason; reason: string }
  | { type: "CHANGE_EXPECTED_RETURN"; expectedReturnOn: string | null };

export type LoanViolationCode =
  | "INVALID_INPUT"
  | "TEXT_TOO_LONG"
  | "CASE_STATUS_NOT_ALLOWED"
  | "CASE_CANCELLING"
  | "EXCEPTION_REASON_REQUIRED"
  | "NO_EXCEPTION_NEEDED"
  | "IDENTIFIER_EMPTY"
  | "LOAN_NOT_OUT"
  | "REASON_REQUIRED"
  | "NO_CHANGE"
  | "VERSION_CONFLICT"
  | "ACTOR_NOT_ALLOWED";

export interface LoanViolation {
  code: LoanViolationCode;
  detail: string;
}

/** The approvals a loan decision needs (resolved server-side by approvals.ts — never from the request). */
export type LoanApprovalKind = "LEND_OUTSIDE_WORK" | "LOAN_CLOSE_UNRETURNED";

export interface LendRow {
  itemName: string;
  itemIdentifier: string | null;
  itemIdentifierNormalized: string | null;
  inventoryItemId: number | null;
  conditionAtLend: LoanCondition;
  lendNote: string | null;
  expectedReturnOn: string | null;
  exceptionReason: string | null;
}

export type LendDecision =
  | { ok: true; row: LendRow; approvals: LoanApprovalKind[]; payload: Record<string, string | number | boolean | null> }
  | { ok: false; violations: LoanViolation[] };

export type LoanActionDecision =
  | {
      ok: true;
      kind: Exclude<LoanEventKind, "LENT" | "CASE_EXIT_APPROVED">;
      version: number;
      stateAfter: LoanState;
      expectedReturnOn: string | null;
      conditionAtReturn: LoanCondition | null;
      returnNote: string | null;
      closeReason: LoanCloseReason | null;
      closeNote: string | null;
      approvals: LoanApprovalKind[];
      payload: Record<string, string | number | boolean | null>;
    }
  | { ok: false; violations: LoanViolation[] };
