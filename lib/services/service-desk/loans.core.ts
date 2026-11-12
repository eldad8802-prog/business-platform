/**
 * Service Desk loans — the pure rules (loans.contracts.ts). No database, no clock, no network, no input mutation. The
 * database (migration 20261201090000) re-checks every rule; the service (loans.service.ts) loads the facts under the case
 * lock, resolves approvals server-side and writes the row + its journal event in one transaction.
 */
import type { ServiceCaseActor } from "./contracts";
import {
  LOAN_CLOSE_REASONS,
  LOAN_CONDITIONS,
  LOAN_EXCEPTION_STATUSES,
  LOAN_LIMITS,
  LOAN_WORK_STATUSES,
  normalizeLoanIdentifier,
  type LendDecision,
  type LendInput,
  type LoanAction,
  type LoanActionDecision,
  type LoanCaseFacts,
  type LoanSnapshot,
  type LoanViolation,
  type LoanViolationCode,
} from "./loans.contracts";
import { isCalendarDate } from "./external-work.core";

const v = (code: LoanViolationCode, detail: string): LoanViolation => ({ code, detail });
const codePoints = (s: string) => Array.from(s).length;
const isPositiveInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0;

/** Text as it will be stored: trimmed, null when blank / absent; over the limit is a violation (never truncated). */
function text(raw: unknown, field: string, max: number, out: LoanViolation[]): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") { out.push(v("INVALID_INPUT", field)); return null; }
  const t = raw.trim();
  if (t === "") return null;
  if (codePoints(t) > max) { out.push(v("TEXT_TOO_LONG", `${field} ≤ ${max}`)); return null; }
  return t;
}

function ownerOnly(actor: ServiceCaseActor, out: LoanViolation[]) {
  if (actor.kind !== "OWNER" || !isPositiveInt(actor.userId)) out.push(v("ACTOR_NOT_ALLOWED", "only the signed-in owner / authorized user lends and records returns"));
}

/** Where the case stands for a loan: the normal path, an approved exception, or refused. */
export function loanStatusClass(c: LoanCaseFacts): "WORK" | "EXCEPTION" | "REFUSED" | "CANCELLING" {
  const work = (LOAN_WORK_STATUSES as readonly string[]).includes(c.status);
  const exception = (LOAN_EXCEPTION_STATUSES as readonly string[]).includes(c.status);
  if (!work && !exception) return "REFUSED";
  if (c.cancellationRequested || c.outcome === "CANCELLED") return "CANCELLING";
  return work ? "WORK" : "EXCEPTION";
}

export function planLend(c: LoanCaseFacts, input: LendInput, actor: ServiceCaseActor): LendDecision {
  const out: LoanViolation[] = [];
  ownerOnly(actor, out);
  const cls = loanStatusClass(c);
  if (cls === "CANCELLING") out.push(v("CASE_CANCELLING", "nothing is lent on a case being cancelled"));
  if (cls === "REFUSED") out.push(v("CASE_STATUS_NOT_ALLOWED", `nothing is lent on a ${c.status} case`));
  const itemName = text(input.itemName, "itemName", LOAN_LIMITS.itemName, out);
  if (itemName === null && !out.some((x) => x.detail.startsWith("itemName"))) out.push(v("INVALID_INPUT", "itemName"));
  const itemIdentifier = text(input.itemIdentifier, "itemIdentifier", LOAN_LIMITS.itemIdentifier, out);
  const normalized = itemIdentifier === null ? null : normalizeLoanIdentifier(itemIdentifier);
  if (normalized === "") out.push(v("IDENTIFIER_EMPTY", "the identifier has no letter or digit"));
  const inv = input.inventoryItemId ?? null;
  if (inv !== null && !isPositiveInt(inv)) out.push(v("INVALID_INPUT", "inventoryItemId"));
  if (!(LOAN_CONDITIONS as readonly string[]).includes(input.conditionAtLend as string)) out.push(v("INVALID_INPUT", "conditionAtLend"));
  const lendNote = text(input.lendNote, "lendNote", LOAN_LIMITS.note, out);
  const exp = input.expectedReturnOn ?? null;
  if (exp !== null && !isCalendarDate(exp)) out.push(v("INVALID_INPUT", "expectedReturnOn"));
  const reason = text(input.exceptionReason, "exceptionReason", LOAN_LIMITS.reason, out);
  if (cls === "EXCEPTION" && reason === null && !out.some((x) => x.detail.startsWith("exceptionReason"))) {
    out.push(v("EXCEPTION_REASON_REQUIRED", `lending on a ${c.status} case is an exception: the owner approves it with a reason`));
  }
  if (cls === "WORK" && reason !== null) out.push(v("NO_EXCEPTION_NEEDED", "lending while the work is under way needs no exception"));
  if (out.length > 0) return { ok: false, violations: out };
  const exception = cls === "EXCEPTION";
  return {
    ok: true,
    row: {
      itemName: itemName as string, itemIdentifier, itemIdentifierNormalized: normalized, inventoryItemId: inv,
      conditionAtLend: input.conditionAtLend, lendNote, expectedReturnOn: exp, exceptionReason: exception ? reason : null,
    },
    approvals: exception ? ["LEND_OUTSIDE_WORK"] : [],
    // tokens only (the journal payload is closed): never the item name, identifier, note or reason
    payload: { identified: normalized !== null, inventoryLinked: inv !== null, exception, expectedReturnSet: exp !== null, caseStatus: c.status },
  };
}

export function evaluateLoanAction(loan: LoanSnapshot, action: LoanAction, actor: ServiceCaseActor): LoanActionDecision {
  const out: LoanViolation[] = [];
  ownerOnly(actor, out);
  if (loan.state !== "OUT") out.push(v("LOAN_NOT_OUT", `the loan is ${loan.state}; its record never changes again`));
  const base = { version: loan.version + 1, expectedReturnOn: loan.expectedReturnOn, conditionAtReturn: null, returnNote: null, closeReason: null, closeNote: null, approvals: [] as never[] };
  switch (action?.type) {
    case "RETURN": {
      if (!(LOAN_CONDITIONS as readonly string[]).includes(action.conditionAtReturn as string)) out.push(v("INVALID_INPUT", "conditionAtReturn"));
      const note = text(action.returnNote, "returnNote", LOAN_LIMITS.note, out);
      if (out.length > 0) return { ok: false, violations: out };
      return { ok: true, ...base, kind: "RETURNED", stateAfter: "RETURNED", conditionAtReturn: action.conditionAtReturn, returnNote: note,
        payload: { condition: action.conditionAtReturn, noteRecorded: note !== null } };
    }
    case "CLOSE_UNRETURNED": {
      if (!(LOAN_CLOSE_REASONS as readonly string[]).includes(action.closeReason as string)) out.push(v("INVALID_INPUT", "closeReason"));
      const reason = text(action.reason, "reason", LOAN_LIMITS.reason, out);
      if (reason === null && !out.some((x) => x.detail.startsWith("reason"))) out.push(v("REASON_REQUIRED", "closing a loan that did not come back needs a reason"));
      if (out.length > 0) return { ok: false, violations: out };
      return { ok: true, ...base, kind: "CLOSED", stateAfter: "CLOSED", closeReason: action.closeReason, closeNote: reason, approvals: ["LOAN_CLOSE_UNRETURNED"],
        payload: { closeReason: action.closeReason } };
    }
    case "CHANGE_EXPECTED_RETURN": {
      const d = action.expectedReturnOn;
      if (d !== null && !isCalendarDate(d)) out.push(v("INVALID_INPUT", "expectedReturnOn"));
      else if (d === loan.expectedReturnOn) out.push(v("NO_CHANGE", "the expected return date is the same"));
      if (out.length > 0) return { ok: false, violations: out };
      return { ok: true, ...base, kind: "EXPECTED_RETURN_CHANGED", stateAfter: "OUT", expectedReturnOn: d, payload: { expectedReturnSet: d !== null } };
    }
    default:
      return { ok: false, violations: [...out, v("INVALID_INPUT", "action.type")] };
  }
}

/** The loan command envelope: the version the client saw. */
export function checkLoanEnvelope(loan: LoanSnapshot, expectedVersion: unknown): LoanViolation[] {
  if (!isPositiveInt(expectedVersion)) return [v("INVALID_INPUT", "expectedVersion")];
  return expectedVersion === loan.version ? [] : [v("VERSION_CONFLICT", `the loan is at version ${loan.version}`)];
}
