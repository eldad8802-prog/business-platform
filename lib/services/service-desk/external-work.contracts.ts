/**
 * Service Desk 1.1d — the contracts of work at an external supplier (שליחה לספק חיצוני).
 *
 * Owner decisions 2026-11-05 (ח‑1 … ח‑9, with three binding corrections):
 *   - one ServiceExternalWork row per send (a `round` per case); one open work per case AND per device;
 *   - seven progress stages that live on the work, NOT in the 13 case statuses: forward only, skipping allowed,
 *     information only — the return is allowed from any stage and no stage gates a case action;
 *   - three supplier costs (estimated / approved / final) in agorot, each change an append-only event; no "paid";
 *     the final cost may be recorded after the return, once, and corrected only by a COST_FINAL_CORRECTED event
 *     that keeps the previous value, the new value, the reason and the acting user (correction 1);
 *   - four return results; the receiving staff member is optional; REPLACED_BY_SUPPLIER never changes the device;
 *   - supplierReference is a short operational token (an RMA number), never a name, address or e-mail — and it is
 *     cleared on account erasure anyway, because a digits-only token cannot be told apart from a phone number
 *     (correction 3);
 *   - supplier cost is documentation only (ע‑8 A): it never creates a commitment, expense, payment, customer charge
 *     or refund, a cancel never clears it, and it is unrelated to the customer's ServiceQuote.
 *
 * The case status machine (service-case.core.ts) is unchanged: SEND_TO_EXTERNAL opens a work, RETURN_FROM_EXTERNAL
 * closes it, CANCEL at EXTERNAL only requests. Pure: no database, clock, network or randomness.
 */
import type { ServiceCaseActor, ServiceEventPayloadValue } from "./contracts";

export const EXTERNAL_PROGRESS_STAGES = [
  "SENT", // נשלח
  "RECEIVED_BY_SUPPLIER", // התקבל אצל הספק
  "AWAITING_DIAGNOSIS", // ממתין לאבחון
  "ESTIMATE_RECEIVED", // התקבלה הערכת עלות
  "IN_REPAIR_AT_SUPPLIER", // בתיקון אצל הספק
  "REPAIR_DONE", // התיקון הושלם
  "READY_FOR_PICKUP", // מוכן להחזרה
] as const;
export type ExternalProgressStage = (typeof EXTERNAL_PROGRESS_STAGES)[number];

export const EXTERNAL_RETURN_RESULTS = ["REPAIRED", "NOT_REPAIRED", "REPLACED_BY_SUPPLIER", "RETURNED_UNWORKED"] as const;
export type ExternalReturnResult = (typeof EXTERNAL_RETURN_RESULTS)[number];

export const EXTERNAL_WORK_EVENT_KINDS = [
  "SENT",
  "PROGRESS",
  "EXPECTED_BACK_CHANGED",
  "COST_ESTIMATED",
  "COST_APPROVED",
  "COST_FINAL",
  "COST_FINAL_CORRECTED",
  "RETURNED",
] as const;
export type ExternalWorkEventKind = (typeof EXTERNAL_WORK_EVENT_KINDS)[number];

/** Free text: a reason is at most this many code points; descriptions at most the larger limit (PG char_length). */
export const EXTERNAL_REASON_MAX_LENGTH = 1000;
export const EXTERNAL_TEXT_MAX_LENGTH = 2000;
/**
 * The supplier's reference (RMA): letters, digits and . _ / # - only, no spaces, at most 40 — so it cannot carry a
 * name, an address or an e-mail. The same pattern is the database CHECK.
 */
export const SUPPLIER_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\/#-]{0,39}$/;

/** The work as the service layer loads it (under lock). Dates are YYYY-MM-DD; amounts are integer agorot. */
export interface ExternalWorkSnapshot {
  state: "AT_SUPPLIER" | "RETURNED";
  round: number;
  supplierId: number;
  progressStage: ExternalProgressStage;
  version: number;
  supplierReference: string | null;
  expectedBackOn: string | null;
  estimatedCostAgorot: number | null;
  approvedCostAgorot: number | null;
  finalCostAgorot: number | null;
  returnResult: ExternalReturnResult | null;
}

/** Facts the service establishes before a send (the database also enforces the last two). */
export interface ExternalSendFacts {
  supplierActive: boolean;
  /** The highest round of this case so far (0 when never sent). */
  lastRound: number;
  openWorkForCase: boolean;
  openWorkForDevice: boolean;
}

export interface ExternalSendInput {
  supplierId: number;
  sendReason: string;
  requestedWork?: string | null;
  conditionAtSend?: string | null;
  operationalNote?: string | null;
  supplierReference?: string | null;
  expectedBackOn?: string | null;
}

export type ExternalWorkAction =
  | { type: "RECORD_PROGRESS"; stage: ExternalProgressStage; supplierReference?: string }
  | { type: "CHANGE_EXPECTED_BACK"; expectedBackOn: string | null }
  | { type: "RECORD_COST"; kind: "ESTIMATED" | "APPROVED" | "FINAL"; amountAgorot: number }
  | { type: "CORRECT_FINAL_COST"; amountAgorot: number; reason: string };

export interface ExternalReturnInput {
  result: ExternalReturnResult;
  workPerformed?: string | null;
  unresolvedIssue?: string | null;
  followUpRequired: boolean;
  finalCostAgorot?: number | null;
  receivedByStaffMemberId?: number | null;
}

/** Free text for the work's business columns (and the correction reason) — never in an event payload. */
export interface ExternalWorkTexts {
  sendReason: string | null;
  requestedWork: string | null;
  conditionAtSend: string | null;
  operationalNote: string | null;
  workPerformed: string | null;
  unresolvedIssue: string | null;
  correctionReason: string | null;
}

export type ExternalServerCheck =
  | "SUPPLIER_BELONGS_TO_BUSINESS"
  | "SUPPLIER_ACTIVE"
  | "NO_OPEN_WORK_FOR_DEVICE"
  | "STAFF_BELONGS_TO_BUSINESS";

/** The journal row to append: seq = the work's version after the change. Payload: tokens, numbers, booleans, nulls. */
export interface ExternalWorkEventDraft {
  kind: ExternalWorkEventKind;
  seq: number;
  progressStage: ExternalProgressStage;
  amountAgorot: number | null;
  previousAmountAgorot: number | null;
  expectedBackOn: string | null;
  actor: ServiceCaseActor;
  payload: Readonly<Record<string, ServiceEventPayloadValue>>;
}

export type ExternalWorkDecision =
  | {
      ok: true;
      /** The work after the change, for the service to persist with the event in one transaction. */
      work: ExternalWorkSnapshot;
      texts: ExternalWorkTexts;
      /** Columns the change sets once (send / return) — absent keys stay as they are. */
      sets: Readonly<Record<string, string | number | boolean | null>>;
      serverChecks: readonly ExternalServerCheck[];
      event: ExternalWorkEventDraft;
    }
  | { ok: false; violations: readonly ExternalWorkViolation[] };

export type ExternalWorkViolationCode =
  | "INVALID_INPUT"
  | "ACTOR_NOT_ALLOWED"
  | "VERSION_CONFLICT"
  | "WORK_NOT_OPEN"
  | "WORK_ALREADY_OPEN"
  | "DEVICE_ALREADY_AT_SUPPLIER"
  | "SUPPLIER_INACTIVE"
  | "PROGRESS_NOT_FORWARD"
  | "PROGRESS_UNCHANGED"
  | "EXPECTED_BACK_UNCHANGED"
  | "COST_NOT_ALLOWED_AFTER_RETURN"
  | "FINAL_COST_ALREADY_RECORDED"
  | "FINAL_COST_NOT_RECORDED"
  | "CORRECTION_UNCHANGED"
  | "REASON_REQUIRED"
  | "REASON_TOO_LONG"
  | "TEXT_TOO_LONG"
  | "SUPPLIER_REFERENCE_INVALID"
  | "SUPPLIER_REFERENCE_ALREADY_SET"
  | "RESULT_CONTRADICTS_OUTCOME"
  | "CASE_TRANSITION_REFUSED";

export interface ExternalWorkViolation {
  code: ExternalWorkViolationCode;
  detail: string;
}
