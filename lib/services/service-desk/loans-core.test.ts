/**
 * Service Desk loans — pure proofs (no database, no network, no clock). Run:
 *   npx tsx lib/services/service-desk/loans-core.test.ts
 *
 *   L  planLend: every case status (work statuses = normal; OPEN / SCHEDULED / READY = an exception with a reason and the
 *      LEND_OUTSIDE_WORK approval; every other status refused; a case being cancelled refused); texts trimmed, limits by
 *      code points; the identifier normalized exactly like the database; the journal payload holds tokens only
 *   A  evaluateLoanAction: RETURN once (any further action on a RETURNED / CLOSED loan refused), CLOSE_UNRETURNED needs a
 *      reason and the LOAN_CLOSE_UNRETURNED approval, CHANGE_EXPECTED_RETURN must change; the version envelope
 *   C  the case machine: CANCEL / ABANDON with a loan OUT → OPEN_LOANER without the owner's override; with it → the
 *      CANCEL_OPEN_LOANER / ABANDON_OPEN_LOANER approval + the RECORD_LOANER_EXIT_APPROVAL effect; CLOSE and COMPLETE
 *      refused while a loan is OUT; nothing changes without a loan; DELIVER keeps HANDOVER_OPEN_LOANER
 *   P  purity: inputs never mutated; the same input → the same output; loans.core imports nothing impure
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { SERVICE_APPROVAL_KINDS, SERVICE_CASE_STATUSES, type ServiceCaseAction, type ServiceCaseContext, type ServiceTransitionDecision } from "./contracts";
import { LOAN_EXCEPTION_STATUSES, LOAN_WORK_STATUSES, normalizeLoanIdentifier, type LendInput, type LoanCaseFacts } from "./loans.contracts";
import { checkLoanEnvelope, evaluateLoanAction, loanStatusClass, planLend } from "./loans.core";
import { evaluateTransition } from "./service-case.core";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, extra = ""): void {
  total += 1;
  if (!cond) failures += 1;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
}
const OWNER = { kind: "OWNER", userId: 70 } as const;
const facts = (status: string, o: Partial<LoanCaseFacts> = {}): LoanCaseFacts => ({ status, outcome: null, cancellationRequested: false, ...o });
const LEND: LendInput = { itemName: "  טלפון חלופי  ", itemIdentifier: " imei 35-67/89.01 ", conditionAtLend: "GOOD", lendNote: " שריטה ", expectedReturnOn: "2026-12-20" };
const codesOf = (d: { ok: boolean; violations?: readonly { code: string }[] }) => (d.ok ? [] : (d.violations ?? []).map((x) => x.code));

console.log("L — planLend");
{
  for (const s of SERVICE_CASE_STATUSES) {
    const d = planLend(facts(s), LEND, OWNER);
    const de = planLend(facts(s), { ...LEND, exceptionReason: "הלקוח צריך את המכשיר" }, OWNER);
    if ((LOAN_WORK_STATUSES as readonly string[]).includes(s)) {
      check(`L ${s}: lent with no exception; an exception reason is refused (NO_EXCEPTION_NEEDED)`, d.ok && d.approvals.length === 0 && d.row.exceptionReason === null && codesOf(de).includes("NO_EXCEPTION_NEEDED"));
    } else if ((LOAN_EXCEPTION_STATUSES as readonly string[]).includes(s)) {
      check(`L ${s}: refused without a reason (EXCEPTION_REASON_REQUIRED); with one → LEND_OUTSIDE_WORK`, codesOf(d).includes("EXCEPTION_REASON_REQUIRED")
        && de.ok && de.approvals.join() === "LEND_OUTSIDE_WORK" && de.row.exceptionReason === "הלקוח צריך את המכשיר");
    } else {
      check(`L ${s}: refused with or without an exception (CASE_STATUS_NOT_ALLOWED)`, codesOf(d).includes("CASE_STATUS_NOT_ALLOWED") && codesOf(de).includes("CASE_STATUS_NOT_ALLOWED"));
    }
  }
  check("L every status is classified exactly once (14 = 6 work + 3 exception + 5 refused)", SERVICE_CASE_STATUSES.length === 14
    && SERVICE_CASE_STATUSES.filter((s) => loanStatusClass(facts(s)) === "WORK").length === 6
    && SERVICE_CASE_STATUSES.filter((s) => loanStatusClass(facts(s)) === "EXCEPTION").length === 3
    && SERVICE_CASE_STATUSES.filter((s) => loanStatusClass(facts(s)) === "REFUSED").length === 5);
  check("L a cancel requested at the supplier → CASE_CANCELLING", codesOf(planLend(facts("EXTERNAL", { cancellationRequested: true }), LEND, OWNER)).includes("CASE_CANCELLING"));
  check("L a cancelled held item (READY + CANCELLED) → CASE_CANCELLING even with a reason",
    codesOf(planLend(facts("READY", { outcome: "CANCELLED" }), { ...LEND, exceptionReason: "x" }, OWNER)).includes("CASE_CANCELLING"));
  const d = planLend(facts("IN_REPAIR"), LEND, OWNER);
  check("L the row: texts trimmed, the identifier normalized like the database (upper, no blanks . _ / -)", d.ok && d.row.itemName === "טלפון חלופי"
    && d.row.itemIdentifier === "imei 35-67/89.01" && d.row.itemIdentifierNormalized === "IMEI35678901" && d.row.lendNote === "שריטה" && d.row.expectedReturnOn === "2026-12-20");
  check("L normalizeLoanIdentifier matches the CHECK's regexp ('[[:space:]._/-]+' removed, upper)", normalizeLoanIdentifier("ab-12.34 x/_y") === "AB1234XY");
  check("L the payload holds tokens only — never the name, identifier, note or reason", d.ok && !JSON.stringify(d.payload).match(/טלפון|imei|IMEI|שריטה/) && d.payload.identified === true);
  check("L an identifier with no letter or digit → IDENTIFIER_EMPTY", codesOf(planLend(facts("IN_REPAIR"), { ...LEND, itemIdentifier: " -./ " }, OWNER)).includes("IDENTIFIER_EMPTY"));
  check("L a blank name → INVALID_INPUT; 201 code points → TEXT_TOO_LONG; 200 emoji (400 UTF-16 units) accepted",
    codesOf(planLend(facts("IN_REPAIR"), { ...LEND, itemName: "  " }, OWNER)).includes("INVALID_INPUT")
    && codesOf(planLend(facts("IN_REPAIR"), { ...LEND, itemName: "א".repeat(201) }, OWNER)).includes("TEXT_TOO_LONG")
    && planLend(facts("IN_REPAIR"), { ...LEND, itemName: "📱".repeat(200) }, OWNER).ok);
  check("L an impossible date / a bad condition / a bad inventory id → INVALID_INPUT",
    codesOf(planLend(facts("IN_REPAIR"), { ...LEND, expectedReturnOn: "2026-02-30" }, OWNER)).includes("INVALID_INPUT")
    && codesOf(planLend(facts("IN_REPAIR"), { ...LEND, conditionAtLend: "NEW" as never }, OWNER)).includes("INVALID_INPUT")
    && codesOf(planLend(facts("IN_REPAIR"), { ...LEND, inventoryItemId: 0 }, OWNER)).includes("INVALID_INPUT"));
  check("L only the owner actor lends (CUSTOMER_LINK / SYSTEM refused)", codesOf(planLend(facts("IN_REPAIR"), LEND, { kind: "CUSTOMER_LINK" })).includes("ACTOR_NOT_ALLOWED")
    && codesOf(planLend(facts("IN_REPAIR"), LEND, { kind: "SYSTEM" })).includes("ACTOR_NOT_ALLOWED"));
  check("L the inventory reference is carried read-only (no movement intent exists in the decision)", (() => {
    const x = planLend(facts("IN_REPAIR"), { ...LEND, inventoryItemId: 12 }, OWNER);
    return x.ok && x.row.inventoryItemId === 12 && !("movement" in x) && x.payload.inventoryLinked === true;
  })());
}

console.log("A — evaluateLoanAction");
{
  const out = { state: "OUT" as const, version: 1, expectedReturnOn: "2026-12-20" };
  const r = evaluateLoanAction(out, { type: "RETURN", conditionAtReturn: "DAMAGED", returnNote: " סדק " }, OWNER);
  check("A1 RETURN: RETURNED, version 2, the condition and the trimmed note, no approval", r.ok && r.kind === "RETURNED" && r.stateAfter === "RETURNED" && r.version === 2
    && r.conditionAtReturn === "DAMAGED" && r.returnNote === "סדק" && r.approvals.length === 0);
  for (const st of ["RETURNED", "CLOSED"] as const) {
    const fin = { state: st, version: 2, expectedReturnOn: null };
    check(`A2 a ${st} loan: a second return / a close / a date change → LOAN_NOT_OUT`,
      codesOf(evaluateLoanAction(fin, { type: "RETURN", conditionAtReturn: "GOOD" }, OWNER)).includes("LOAN_NOT_OUT")
      && codesOf(evaluateLoanAction(fin, { type: "CLOSE_UNRETURNED", closeReason: "LOST", reason: "x" }, OWNER)).includes("LOAN_NOT_OUT")
      && codesOf(evaluateLoanAction(fin, { type: "CHANGE_EXPECTED_RETURN", expectedReturnOn: "2027-01-01" }, OWNER)).includes("LOAN_NOT_OUT"));
  }
  const c = evaluateLoanAction(out, { type: "CLOSE_UNRETURNED", closeReason: "KEPT_BY_CUSTOMER", reason: " הלקוח רכש את המכשיר " }, OWNER);
  check("A3 CLOSE_UNRETURNED: CLOSED with the reason and the LOAN_CLOSE_UNRETURNED approval", c.ok && c.kind === "CLOSED" && c.closeReason === "KEPT_BY_CUSTOMER"
    && c.closeNote === "הלקוח רכש את המכשיר" && c.approvals.join() === "LOAN_CLOSE_UNRETURNED");
  check("A4 CLOSE_UNRETURNED without a reason → REASON_REQUIRED; an unknown close reason → INVALID_INPUT",
    codesOf(evaluateLoanAction(out, { type: "CLOSE_UNRETURNED", closeReason: "LOST", reason: "  " }, OWNER)).includes("REASON_REQUIRED")
    && codesOf(evaluateLoanAction(out, { type: "CLOSE_UNRETURNED", closeReason: "SOLD" as never, reason: "x" }, OWNER)).includes("INVALID_INPUT"));
  check("A5 CHANGE_EXPECTED_RETURN: to another date or to none; the same date → NO_CHANGE",
    (() => { const x = evaluateLoanAction(out, { type: "CHANGE_EXPECTED_RETURN", expectedReturnOn: "2026-12-31" }, OWNER); return x.ok && x.expectedReturnOn === "2026-12-31" && x.stateAfter === "OUT"; })()
    && evaluateLoanAction(out, { type: "CHANGE_EXPECTED_RETURN", expectedReturnOn: null }, OWNER).ok
    && codesOf(evaluateLoanAction(out, { type: "CHANGE_EXPECTED_RETURN", expectedReturnOn: "2026-12-20" }, OWNER)).includes("NO_CHANGE"));
  check("A6 an unknown action type → INVALID_INPUT", codesOf(evaluateLoanAction(out, { type: "DELETE" } as never, OWNER)).includes("INVALID_INPUT"));
  check("A7 the envelope: the version the client saw, else VERSION_CONFLICT; a non-positive version → INVALID_INPUT",
    checkLoanEnvelope(out, 1).length === 0 && checkLoanEnvelope(out, 2)[0]?.code === "VERSION_CONFLICT" && checkLoanEnvelope(out, 0)[0]?.code === "INVALID_INPUT");
}

console.log("C — the case machine with a loan OUT");
{
  const ctx = (o: Partial<ServiceCaseContext> = {}): ServiceCaseContext => ({
    kind: "IN_SHOP", status: "IN_REPAIR", holdReason: null, outcome: null, version: 5, staffMemberId: 5, siteId: null, coverage: { source: "STORE", decision: "APPROVED" },
    currentQuote: null, intake: { conditionRecorded: true, accessoriesRecorded: true, customerSigned: false }, qaChecklistCompleted: true, openPartReservations: 0,
    openLoaner: false, cancellationRequested: false, pickupRemindersSent: 1, settlement: { known: true, openBalanceAgorot: 0 }, ...o,
  });
  const ev = (c: ServiceCaseContext, a: ServiceCaseAction): ServiceTransitionDecision => evaluateTransition(c, a, OWNER);
  const codes = (d: ServiceTransitionDecision) => (d.ok ? [] : d.violations.map((x) => x.code));
  check("C1 CANCEL with a loan OUT, no override → OPEN_LOANER", codes(ev(ctx({ openLoaner: true }), { type: "CANCEL", reason: "הלקוח ביטל" })).includes("OPEN_LOANER"));
  check("C2 … with an override but no reason → OVERRIDE_REASON_REQUIRED", codes(ev(ctx({ openLoaner: true }), { type: "CANCEL", reason: "ביטול", loanerOverride: { reason: " " } })).includes("OVERRIDE_REASON_REQUIRED"));
  const c3 = ev(ctx({ openLoaner: true }), { type: "CANCEL", reason: "ביטול", loanerOverride: { reason: " יחזיר ביום שני " } });
  check("C3 … with the override: READY (held item) + CANCEL_OPEN_LOANER + RECORD_LOANER_EXIT_APPROVAL; the reason in texts, a token in the payload",
    c3.ok && c3.to === "READY" && c3.approvals.join() === "CANCEL_OPEN_LOANER" && c3.effects.includes("RECORD_LOANER_EXIT_APPROVAL")
    && c3.texts.loanerOverrideReason === "יחזיר ביום שני" && c3.event.payload.loanerOverride === true && !JSON.stringify(c3.event.payload).includes("יחזיר"), JSON.stringify(c3));
  const c4 = ev(ctx({ openLoaner: true, status: "OPEN", kind: "IN_SHOP" }), { type: "CANCEL", loanerOverride: { reason: "חריג" } });
  check("C4 a not-held case (OPEN) cancelled with the override → CANCELLED + the approval", c4.ok && c4.to === "CANCELLED" && c4.approvals.join() === "CANCEL_OPEN_LOANER");
  const c5 = ev(ctx({ openLoaner: true, status: "EXTERNAL" }), { type: "CANCEL", reason: "ביטול", loanerOverride: { reason: "יחזיר" } });
  check("C5 a cancel REQUEST at the supplier with the override → requested + the approval (the request is the exit)", c5.ok && c5.cancellationRequestedAfter && c5.approvals.join() === "CANCEL_OPEN_LOANER");
  check("C6 ABANDON with a loan OUT, no override → OPEN_LOANER", codes(ev(ctx({ openLoaner: true, status: "READY", outcome: "REPAIRED" }), { type: "ABANDON", reason: "לא נאסף" })).includes("OPEN_LOANER"));
  const c7 = ev(ctx({ openLoaner: true, status: "READY", outcome: "REPAIRED" }), { type: "ABANDON", reason: "לא נאסף", loanerOverride: { reason: "הלקוח לא עונה" } });
  check("C7 … with the override → ABANDONED + ABANDON_OPEN_LOANER + the effect", c7.ok && c7.to === "ABANDONED" && c7.approvals.join() === "ABANDON_OPEN_LOANER" && c7.effects.includes("RECORD_LOANER_EXIT_APPROVAL"));
  check("C8 CLOSE with a loan OUT → OPEN_LOANER", codes(ev(ctx({ openLoaner: true, status: "DELIVERED", outcome: "REPAIRED" }), { type: "CLOSE" })).includes("OPEN_LOANER"));
  check("C9 without a loan: CANCEL / ABANDON / CLOSE exactly as before (no approval, no effect); an override is ignored",
    (() => { const x = ev(ctx(), { type: "CANCEL", reason: "ביטול", loanerOverride: { reason: "x" } }); return x.ok && x.approvals.length === 0 && !x.effects.includes("RECORD_LOANER_EXIT_APPROVAL") && x.texts.loanerOverrideReason === null; })()
    && ev(ctx({ status: "DELIVERED", outcome: "REPAIRED" }), { type: "CLOSE" }).ok);
  const t3 = { track: "T3" as const, workType: "INSTALLATION" as const, location: "AT_CUSTOMER" as const, itemAtBusiness: false,
    requirements: { intakeConfirmation: "NONE", workApproval: "NONE", qa: { mode: "OFF" }, completion: "OWNER_CONFIRMATION", handoverByOwner: false } as never,
    afterSaleResolution: null, siteAddressSet: true, moneyCommitment: false, creditDocumentLinked: false };
  const complete: ServiceCaseAction = { type: "COMPLETE", completion: { completionType: "OWNER_CONFIRMED_ON_SITE", ownerConfirmed: true } };
  check("C10 COMPLETE (WORK_DONE → CLOSED) with a loan OUT → OPEN_LOANER; without one it completes",
    codes(ev(ctx({ openLoaner: true, status: "WORK_DONE", outcome: "COMPLETED", kind: "FIELD", track: t3 }), complete)).includes("OPEN_LOANER")
    && ev(ctx({ status: "WORK_DONE", outcome: "COMPLETED", kind: "FIELD", track: t3 }), complete).ok);
  const dl = ev(ctx({ openLoaner: true, status: "READY", outcome: "REPAIRED" }), { type: "DELIVER", receipt: { handoverConfirmed: true }, loanerOverride: { reason: "יחזיר" } });
  check("C11 DELIVER with a loan OUT keeps HANDOVER_OPEN_LOANER (the #1128 record); no loan-exit effect", dl.ok && dl.approvals.join() === "HANDOVER_OPEN_LOANER" && !dl.effects.includes("RECORD_LOANER_EXIT_APPROVAL"));
  check("C12 the approval kinds include the four loan kinds", ["CANCEL_OPEN_LOANER", "ABANDON_OPEN_LOANER", "LEND_OUTSIDE_WORK", "LOAN_CLOSE_UNRETURNED"].every((k) => (SERVICE_APPROVAL_KINDS as readonly string[]).includes(k)));
}

console.log("P — purity");
{
  const input = Object.freeze({ ...LEND });
  const f = Object.freeze(facts("IN_REPAIR"));
  const a = JSON.stringify(planLend(f, input, OWNER)), b = JSON.stringify(planLend(f, input, OWNER));
  check("P1 frozen inputs are never mutated and the same input gives the same output", a === b);
  const src = fs.readFileSync(path.join(process.cwd(), "lib/services/service-desk/loans.core.ts"), "utf8");
  check("P2 loans.core imports nothing impure (no prisma, tenant, fetch, Date.now, node:)", !/from "@prisma|tenant|node:|fetch\(|Date\.now|new Date\(/.test(src));
}

console.log(`\nloans-core: ${total - failures} passed, ${failures} failed, ${total} checks`);
if (failures > 0) process.exit(1);
