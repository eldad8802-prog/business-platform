/**
 * Service Desk 1.1d — work at an external supplier, pure proofs (no database, no network, no clock). Run:
 *   npx tsx lib/services/service-desk/external-work-core.test.ts
 *
 * Owner decisions ח‑1 … ח‑9 with the three binding corrections (2026-11-05): send / progress / expected date / costs /
 * final-cost correction / return / cancel at the supplier, against the unchanged case status machine.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ServiceCaseActor, ServiceCaseContext, ServiceEventPayloadValue } from "./contracts";
import {
  EXTERNAL_PROGRESS_STAGES,
  EXTERNAL_RETURN_RESULTS,
  type ExternalSendFacts,
  type ExternalSendInput,
  type ExternalWorkDecision,
  type ExternalWorkSnapshot,
  type ExternalWorkViolationCode,
} from "./external-work.contracts";
import {
  checkExternalEnvelope,
  closeExternalWork,
  evaluateExternalWork,
  isCalendarDate,
  openExternalWork,
  planReturnFromExternal,
  planSendToExternal,
} from "./external-work.core";
import { evaluateTransition } from "./service-case.core";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = ""): void {
  if (cond) pass++; else fail++;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
}
const OK: Extract<ExternalWorkDecision, { ok: true }>[] = [];
const keep = (d: ExternalWorkDecision) => { if (d.ok) OK.push(d); return d; };
const codes = (d: ExternalWorkDecision) => (d.ok ? [] : d.violations.map((x) => x.code));
const refused = (name: string, d: ExternalWorkDecision, code: ExternalWorkViolationCode) =>
  check(name, !d.ok && codes(d).includes(code), d.ok ? "allowed" : codes(d).join(","));
function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") { Object.freeze(o); for (const x of Object.values(o as object)) deepFreeze(x); }
  return o;
}

const OWNER: ServiceCaseActor = { kind: "OWNER", userId: 70 };
const CUSTOMER: ServiceCaseActor = { kind: "CUSTOMER_LINK" };
const SYSTEM: ServiceCaseActor = { kind: "SYSTEM" };
function ctx(o: Partial<ServiceCaseContext> = {}): ServiceCaseContext {
  return {
    kind: "IN_SHOP", status: "IN_REPAIR", holdReason: null, outcome: null, version: 5, staffMemberId: 5, siteId: null,
    coverage: null, currentQuote: { version: 1, totalAgorot: 45_000, docHash: "h1", state: "APPROVED", approval: { version: 1, totalAgorot: 45_000, docHash: "h1", method: "PHONE" } },
    intake: { conditionRecorded: true, accessoriesRecorded: true, customerSigned: true }, qaChecklistCompleted: true,
    openPartReservations: 0, openLoaner: false, cancellationRequested: false, pickupRemindersSent: 0,
    settlement: { known: true, openBalanceAgorot: 0 }, ...o,
  };
}
const FACTS: ExternalSendFacts = { supplierActive: true, lastRound: 0, openWorkForCase: false, openWorkForDevice: false };
const SEND: ExternalSendInput = { supplierId: 12, sendReason: "אין לנו ציוד להחלפת מסך", requestedWork: "החלפת מסך", conditionAtSend: "סדק בפינה", supplierReference: null, expectedBackOn: "2026-11-20" };
function work(o: Partial<ExternalWorkSnapshot> = {}): ExternalWorkSnapshot {
  return { state: "AT_SUPPLIER", round: 1, supplierId: 12, progressStage: "SENT", version: 1, supplierReference: null, expectedBackOn: "2026-11-20",
    estimatedCostAgorot: null, approvedCostAgorot: null, finalCostAgorot: null, returnResult: null, ...o };
}

// ── 1. send ────────────────────────────────────────────────────────────────────────────────────────────────
console.log("— 1. send to a supplier");
{
  const p = planSendToExternal(ctx(), SEND, FACTS, OWNER);
  keep(p.work);
  check("IN_REPAIR → EXTERNAL and a work opens", p.ok && p.case.ok && p.case.to === "EXTERNAL" && p.work.ok);
  check("  …round 1, stage SENT, version 1, AT_SUPPLIER, no costs", p.work.ok && p.work.work.round === 1 && p.work.work.progressStage === "SENT" && p.work.work.version === 1 && p.work.work.state === "AT_SUPPLIER" && p.work.work.finalCostAgorot === null);
  check("  …event SENT at seq 1; texts carry the reason, the work and the condition", p.work.ok && p.work.event.kind === "SENT" && p.work.event.seq === 1 && p.work.texts.sendReason === SEND.sendReason && p.work.texts.requestedWork === "החלפת מסך" && p.work.texts.conditionAtSend === "סדק בפינה");
  check("  …server checks: supplier of this business, active, device not already away", p.work.ok && ["SUPPLIER_BELONGS_TO_BUSINESS", "SUPPLIER_ACTIVE", "NO_OPEN_WORK_FOR_DEVICE"].every((c) => p.work.ok && p.work.serverChecks.includes(c as never)));
  check("the case event is the existing external.sent (status machine unchanged)", p.case.ok && p.case.event.type === "external.sent" && p.case.event.payload.supplierId === 12);
  check("from DIAGNOSING as well", planSendToExternal(ctx({ status: "DIAGNOSING", currentQuote: null }), SEND, FACTS, OWNER).ok);
  const fromReady = planSendToExternal(ctx({ status: "READY", outcome: "REPAIRED" }), SEND, FACTS, OWNER);
  check("not from READY (the case refuses; the plan is not ok)", !fromReady.ok && !fromReady.case.ok);
  const again = keep(openExternalWork({ ...SEND, supplierId: 12 }, { ...FACTS, lastRound: 1 }, OWNER));
  check("the same supplier again later: round 2", again.ok && again.work.round === 2);
  const other = keep(openExternalWork({ ...SEND, supplierId: 13 }, { ...FACTS, lastRound: 2 }, OWNER));
  check("another supplier after that: round 3", other.ok && other.work.round === 3 && other.work.supplierId === 13);
  refused("an inactive supplier", openExternalWork(SEND, { ...FACTS, supplierActive: false }, OWNER), "SUPPLIER_INACTIVE");
  refused("a second open work on the case", openExternalWork(SEND, { ...FACTS, openWorkForCase: true }, OWNER), "WORK_ALREADY_OPEN");
  refused("the device already away through another case", openExternalWork(SEND, { ...FACTS, openWorkForDevice: true }, OWNER), "DEVICE_ALREADY_AT_SUPPLIER");
  refused("no reason", openExternalWork({ ...SEND, sendReason: "   " }, FACTS, OWNER), "REASON_REQUIRED");
  refused("a reason over 1000 code points", openExternalWork({ ...SEND, sendReason: "א".repeat(1001) }, FACTS, OWNER), "REASON_TOO_LONG");
  check("a reason of exactly 1000 emoji is accepted", openExternalWork({ ...SEND, sendReason: "🔧".repeat(1000) }, FACTS, OWNER).ok);
  refused("a description over 2000", openExternalWork({ ...SEND, requestedWork: "x".repeat(2001) }, FACTS, OWNER), "TEXT_TOO_LONG");
  for (const bad of ["RMA 123", "dana@shop.co.il", "דנה כהן", "x".repeat(41), "-123", ""]) {
    refused(`supplierReference ${JSON.stringify(bad.slice(0, 16))} is refused (RMA token only)`, openExternalWork({ ...SEND, supplierReference: bad }, FACTS, OWNER), "SUPPLIER_REFERENCE_INVALID");
  }
  check("supplierReference RMA-2026/114#3 is accepted", openExternalWork({ ...SEND, supplierReference: "RMA-2026/114#3" }, FACTS, OWNER).ok);
  refused("an impossible expected date", openExternalWork({ ...SEND, expectedBackOn: "2026-02-30" }, FACTS, OWNER), "INVALID_INPUT");
  refused("the customer link may not send", openExternalWork(SEND, FACTS, CUSTOMER), "ACTOR_NOT_ALLOWED");
  refused("the system may not send", openExternalWork(SEND, FACTS, SYSTEM), "ACTOR_NOT_ALLOWED");
  refused("no supplier id", openExternalWork({ ...SEND, supplierId: 0 }, FACTS, OWNER), "INVALID_INPUT");
}

// ── 2. progress ────────────────────────────────────────────────────────────────────────────────────────────
console.log("— 2. progress stages (forward only, skipping allowed, information only)");
{
  let w = work();
  for (const stage of EXTERNAL_PROGRESS_STAGES.slice(1)) {
    const d = keep(evaluateExternalWork(w, { type: "RECORD_PROGRESS", stage }, OWNER));
    check(`→ ${stage}`, d.ok && d.work.progressStage === stage && d.event.kind === "PROGRESS" && d.event.seq === w.version + 1);
    if (d.ok) w = d.work;
  }
  const skip = keep(evaluateExternalWork(work(), { type: "RECORD_PROGRESS", stage: "REPAIR_DONE" }, OWNER));
  check("SENT → REPAIR_DONE skips four stages", skip.ok && skip.event.payload.skipped === 4);
  refused("back from REPAIR_DONE to AWAITING_DIAGNOSIS", evaluateExternalWork(work({ progressStage: "REPAIR_DONE" }), { type: "RECORD_PROGRESS", stage: "AWAITING_DIAGNOSIS" }, OWNER), "PROGRESS_NOT_FORWARD");
  refused("the same stage again", evaluateExternalWork(work({ progressStage: "ESTIMATE_RECEIVED" }), { type: "RECORD_PROGRESS", stage: "ESTIMATE_RECEIVED" }, OWNER), "PROGRESS_UNCHANGED");
  refused("progress after the return", evaluateExternalWork(work({ state: "RETURNED", returnResult: "REPAIRED" }), { type: "RECORD_PROGRESS", stage: "READY_FOR_PICKUP" }, OWNER), "WORK_NOT_OPEN");
  refused("an unknown stage", evaluateExternalWork(work(), { type: "RECORD_PROGRESS", stage: "SHIPPED" as never }, OWNER), "INVALID_INPUT");
  const ref = keep(evaluateExternalWork(work(), { type: "RECORD_PROGRESS", stage: "RECEIVED_BY_SUPPLIER", supplierReference: "RMA77" }, OWNER));
  check("the RMA can arrive with a progress update (set once)", ref.ok && ref.work.supplierReference === "RMA77" && ref.sets.supplierReference === "RMA77");
  refused("…not a second time", evaluateExternalWork(work({ supplierReference: "RMA77" }), { type: "RECORD_PROGRESS", stage: "AWAITING_DIAGNOSIS", supplierReference: "RMA78" }, OWNER), "SUPPLIER_REFERENCE_ALREADY_SET");
  refused("…nor a non-RMA token", evaluateExternalWork(work(), { type: "RECORD_PROGRESS", stage: "AWAITING_DIAGNOSIS", supplierReference: "052 1234567" }, OWNER), "SUPPLIER_REFERENCE_INVALID");
}

// ── 3. expected return date ────────────────────────────────────────────────────────────────────────────────
console.log("— 3. expected return date");
{
  const d = keep(evaluateExternalWork(work(), { type: "CHANGE_EXPECTED_BACK", expectedBackOn: "2026-11-27" }, OWNER));
  check("moved: the new date, the previous one in the event", d.ok && d.work.expectedBackOn === "2026-11-27" && d.event.payload.previous === "2026-11-20" && d.event.expectedBackOn === "2026-11-27");
  check("cleared (unknown again)", keep(evaluateExternalWork(work(), { type: "CHANGE_EXPECTED_BACK", expectedBackOn: null }, OWNER)).ok);
  refused("the same date", evaluateExternalWork(work(), { type: "CHANGE_EXPECTED_BACK", expectedBackOn: "2026-11-20" }, OWNER), "EXPECTED_BACK_UNCHANGED");
  refused("not a date", evaluateExternalWork(work(), { type: "CHANGE_EXPECTED_BACK", expectedBackOn: "20/11/2026" }, OWNER), "INVALID_INPUT");
  refused("after the return", evaluateExternalWork(work({ state: "RETURNED", returnResult: "REPAIRED" }), { type: "CHANGE_EXPECTED_BACK", expectedBackOn: "2026-12-01" }, OWNER), "WORK_NOT_OPEN");
  check("isCalendarDate: 2028-02-29 yes, 2026-02-29 no", isCalendarDate("2028-02-29") && !isCalendarDate("2026-02-29"));
}

// ── 4. costs ───────────────────────────────────────────────────────────────────────────────────────────────
console.log("— 4. supplier costs (documentation only)");
{
  const e1 = keep(evaluateExternalWork(work(), { type: "RECORD_COST", kind: "ESTIMATED", amountAgorot: 30_000 }, OWNER));
  check("an estimate: COST_ESTIMATED with the amount", e1.ok && e1.work.estimatedCostAgorot === 30_000 && e1.event.kind === "COST_ESTIMATED" && e1.event.amountAgorot === 30_000 && e1.event.previousAmountAgorot === null);
  const e2 = keep(evaluateExternalWork(work({ estimatedCostAgorot: 30_000, version: 2 }), { type: "RECORD_COST", kind: "ESTIMATED", amountAgorot: 34_000 }, OWNER));
  check("a revised estimate keeps the previous value in its event (history, never overwritten)", e2.ok && e2.event.previousAmountAgorot === 30_000 && e2.event.payload.previousAgorot === 30_000);
  check("an approved cost", keep(evaluateExternalWork(work(), { type: "RECORD_COST", kind: "APPROVED", amountAgorot: 32_000 }, OWNER)).ok);
  const f = keep(evaluateExternalWork(work(), { type: "RECORD_COST", kind: "FINAL", amountAgorot: 31_500 }, OWNER));
  check("a final cost while away", f.ok && f.work.finalCostAgorot === 31_500 && f.event.kind === "COST_FINAL");
  check("a final cost after the return", keep(evaluateExternalWork(work({ state: "RETURNED", returnResult: "REPAIRED" }), { type: "RECORD_COST", kind: "FINAL", amountAgorot: 31_500 }, OWNER)).ok);
  refused("a second final cost (use the correction)", evaluateExternalWork(work({ finalCostAgorot: 31_500 }), { type: "RECORD_COST", kind: "FINAL", amountAgorot: 30_000 }, OWNER), "FINAL_COST_ALREADY_RECORDED");
  refused("an estimate after the return", evaluateExternalWork(work({ state: "RETURNED", returnResult: "REPAIRED" }), { type: "RECORD_COST", kind: "ESTIMATED", amountAgorot: 1 }, OWNER), "COST_NOT_ALLOWED_AFTER_RETURN");
  refused("a negative amount", evaluateExternalWork(work(), { type: "RECORD_COST", kind: "ESTIMATED", amountAgorot: -1 }, OWNER), "INVALID_INPUT");
  refused("a fractional amount", evaluateExternalWork(work(), { type: "RECORD_COST", kind: "APPROVED", amountAgorot: 10.5 }, OWNER), "INVALID_INPUT");
  check("a cost never touches the case or creates a money effect (only the work's columns)", f.ok && Object.keys(f.sets).length === 0 && !("effects" in f));
}

// ── 5. correction of the final cost (correction 1) ─────────────────────────────────────────────────────────
console.log("— 5. correcting a mistaken final cost");
{
  const c = keep(evaluateExternalWork(work({ finalCostAgorot: 31_500, version: 4 }), { type: "CORRECT_FINAL_COST", amountAgorot: 13_500, reason: "הוקלד 315 במקום 135" }, OWNER));
  check("COST_FINAL_CORRECTED: new value, previous value, reason recorded", c.ok && c.event.kind === "COST_FINAL_CORRECTED" && c.work.finalCostAgorot === 13_500 && c.event.previousAmountAgorot === 31_500 && c.event.payload.reasonRecorded === true);
  check("  …the reason is a business column (texts), never in the payload", c.ok && c.texts.correctionReason === "הוקלד 315 במקום 135" && !JSON.stringify(c.event).includes("315 במקום"));
  check("  …version bumps by one and the event is the new seq", c.ok && c.work.version === 5 && c.event.seq === 5);
  check("  …the acting user is the event's actor", c.ok && c.event.actor.kind === "OWNER" && (c.event.actor as { userId: number }).userId === 70);
  check("a second correction is again a new event (chain kept)", keep(evaluateExternalWork(work({ finalCostAgorot: 13_500, version: 5 }), { type: "CORRECT_FINAL_COST", amountAgorot: 14_000, reason: "חשבונית סופית" }, OWNER)).ok);
  check("a correction after the return", keep(evaluateExternalWork(work({ state: "RETURNED", returnResult: "REPAIRED", finalCostAgorot: 9_000 }), { type: "CORRECT_FINAL_COST", amountAgorot: 9_900, reason: "תיקון" }, OWNER)).ok);
  refused("no final cost yet", evaluateExternalWork(work(), { type: "CORRECT_FINAL_COST", amountAgorot: 1, reason: "x" }, OWNER), "FINAL_COST_NOT_RECORDED");
  refused("the same value", evaluateExternalWork(work({ finalCostAgorot: 100 }), { type: "CORRECT_FINAL_COST", amountAgorot: 100, reason: "x" }, OWNER), "CORRECTION_UNCHANGED");
  refused("no reason", evaluateExternalWork(work({ finalCostAgorot: 100 }), { type: "CORRECT_FINAL_COST", amountAgorot: 90, reason: " " }, OWNER), "REASON_REQUIRED");
  refused("a reason over 1000", evaluateExternalWork(work({ finalCostAgorot: 100 }), { type: "CORRECT_FINAL_COST", amountAgorot: 90, reason: "א".repeat(1001) }, OWNER), "REASON_TOO_LONG");
  refused("the customer link may not correct", evaluateExternalWork(work({ finalCostAgorot: 100 }), { type: "CORRECT_FINAL_COST", amountAgorot: 90, reason: "x" }, CUSTOMER), "ACTOR_NOT_ALLOWED");
}

// ── 6. return ──────────────────────────────────────────────────────────────────────────────────────────────
console.log("— 6. the return (from any stage)");
{
  const RET = { result: "REPAIRED" as const, workPerformed: "הוחלף מסך", followUpRequired: false };
  for (const stage of EXTERNAL_PROGRESS_STAGES) {
    const d = keep(closeExternalWork(work({ progressStage: stage }), RET, OWNER));
    check(`a return from ${stage}`, d.ok && d.work.state === "RETURNED" && d.event.kind === "RETURNED" && d.event.payload.fromStage === stage);
  }
  for (const result of EXTERNAL_RETURN_RESULTS) check(`result ${result} is accepted`, keep(closeExternalWork(work(), { ...RET, result }, OWNER)).ok);
  const ext = ctx({ status: "EXTERNAL", version: 6 });
  const rep = planReturnFromExternal(ext, { type: "RETURN_FROM_EXTERNAL", next: "READY", outcome: "REPAIRED" }, work(), RET, OWNER);
  keep(rep.work);
  check("REPAIRED → case READY / REPAIRED and the work RETURNED", rep.ok && rep.case.ok && rep.case.to === "READY" && rep.work.ok && rep.work.work.returnResult === "REPAIRED");
  const nr = planReturnFromExternal(ext, { type: "RETURN_FROM_EXTERNAL", next: "READY", outcome: "NOT_REPAIRED" }, work(), { ...RET, result: "NOT_REPAIRED" }, OWNER);
  check("NOT_REPAIRED → case READY / NOT_REPAIRED", nr.ok);
  const contra = planReturnFromExternal(ext, { type: "RETURN_FROM_EXTERNAL", next: "READY", outcome: "REPAIRED" }, work(), { ...RET, result: "NOT_REPAIRED" }, OWNER);
  check("NOT_REPAIRED cannot close the case as REPAIRED", !contra.ok && !contra.work.ok && codes(contra.work).includes("RESULT_CONTRADICTS_OUTCOME"));
  const unworked = planReturnFromExternal(ext, { type: "RETURN_FROM_EXTERNAL", next: "IN_REPAIR" }, work(), { ...RET, result: "RETURNED_UNWORKED" }, OWNER);
  check("RETURNED_UNWORKED → back to our own repair (IN_REPAIR)", unworked.ok && unworked.case.ok && unworked.case.to === "IN_REPAIR");
  const repl = planReturnFromExternal(ext, { type: "RETURN_FROM_EXTERNAL", next: "READY", outcome: "REPLACED" }, work(), { ...RET, result: "REPLACED_BY_SUPPLIER" }, OWNER);
  check("REPLACED_BY_SUPPLIER never changes the device: the case still needs the replacement device named", !repl.case.ok && repl.work.ok && !("deviceId" in repl.work.sets));
  const final = keep(closeExternalWork(work(), { ...RET, finalCostAgorot: 31_500 }, OWNER));
  check("the final cost may be recorded with the return", final.ok && final.work.finalCostAgorot === 31_500 && final.event.amountAgorot === 31_500);
  refused("…but not when one is already recorded", closeExternalWork(work({ finalCostAgorot: 1 }), { ...RET, finalCostAgorot: 2 }, OWNER), "FINAL_COST_ALREADY_RECORDED");
  const staff = keep(closeExternalWork(work(), { ...RET, receivedByStaffMemberId: 9 }, OWNER));
  check("the receiving staff member is optional and checked server-side", staff.ok && staff.sets.receivedByStaffMemberId === 9 && staff.serverChecks.includes("STAFF_BELONGS_TO_BUSINESS"));
  refused("a second return", closeExternalWork(work({ state: "RETURNED", returnResult: "REPAIRED" }), RET, OWNER), "WORK_NOT_OPEN");
  refused("an unknown result", closeExternalWork(work(), { ...RET, result: "LOST" as never }, OWNER), "INVALID_INPUT");
  check("unresolved issue and follow-up: texts + booleans in the payload", (() => { const d = closeExternalWork(work(), { ...RET, unresolvedIssue: "רמקול עדיין חלש", followUpRequired: true }, OWNER); return d.ok && d.texts.unresolvedIssue === "רמקול עדיין חלש" && d.event.payload.hasUnresolvedIssue === true && d.event.payload.followUpRequired === true; })());
  const notExternal = planReturnFromExternal(ctx(), { type: "RETURN_FROM_EXTERNAL", next: "IN_REPAIR" }, work(), RET, OWNER);
  check("a return when the case is not EXTERNAL is refused by the case", !notExternal.ok && !notExternal.case.ok);
}

// ── 7. cancel while the item is at the supplier (existing rule kept) ───────────────────────────────────────
console.log("— 7. cancel at the supplier");
{
  const ext = ctx({ status: "EXTERNAL", version: 6 });
  const cancel = evaluateTransition(ext, { type: "CANCEL", reason: "הלקוח ביטל" }, OWNER);
  check("the cancel is only REQUESTED: the case stays EXTERNAL", cancel.ok && cancel.to === "EXTERNAL" && cancel.cancellationRequestedAfter === true);
  check("the work is untouched by a cancel (no work decision exists for it)", cancel.ok && cancel.effects.every((e) => e !== ("CLOSE_EXTERNAL_WORK" as never)));
  const w = work({ estimatedCostAgorot: 30_000, approvedCostAgorot: 30_000 });
  const back = planReturnFromExternal(ctx({ status: "EXTERNAL", cancellationRequested: true, version: 7 }), { type: "RETURN_FROM_EXTERNAL", next: "READY" }, w,
    { result: "RETURNED_UNWORKED", followUpRequired: false }, OWNER);
  keep(back.work);
  check("the documented return completes it: case READY / CANCELLED, work RETURNED", back.ok && back.case.ok && back.case.to === "READY" && back.case.outcome === "CANCELLED" && back.work.ok && back.work.work.state === "RETURNED");
  check("  …the supplier costs stay (a cancel never clears them, ח‑1)", back.work.ok && back.work.work.estimatedCostAgorot === 30_000 && back.work.work.approvedCostAgorot === 30_000);
  const repairedAnyway = planReturnFromExternal(ctx({ status: "EXTERNAL", cancellationRequested: true, version: 7 }), { type: "RETURN_FROM_EXTERNAL", next: "READY" }, w,
    { result: "REPAIRED", followUpRequired: false }, OWNER);
  check("the supplier may have repaired it before the cancel: still READY / CANCELLED", repairedAnyway.ok && repairedAnyway.case.ok && repairedAnyway.case.outcome === "CANCELLED");
  const deliverAway = evaluateTransition(ext, { type: "DELIVER", receipt: { receivedByName: "ישראל", signatureCaptured: true } }, OWNER);
  check("no delivery while the item is away (case refuses DELIVER at EXTERNAL)", !deliverAway.ok);
  check("no second send while away (case refuses SEND_TO_EXTERNAL at EXTERNAL)", !planSendToExternal(ext, SEND, FACTS, OWNER).ok);
}

// ── 8. envelope, versions, payload rule, purity ────────────────────────────────────────────────────────────
console.log("— 8. envelope, versions, payloads, purity");
{
  const w = work({ version: 4 });
  check("a well-formed command at the current version", checkExternalEnvelope(w, { workId: 3, expectedVersion: 4, idempotencyKey: "0192f4b2-7c1e-7a3b" }).ok);
  const stale = checkExternalEnvelope(w, { workId: 3, expectedVersion: 3, idempotencyKey: "0192f4b2-7c1e-7a3b" });
  check("a stale version → VERSION_CONFLICT", !stale.ok && stale.violations.some((x) => x.code === "VERSION_CONFLICT"));
  check("a malformed idempotency key → INVALID_INPUT", !checkExternalEnvelope(w, { workId: 3, expectedVersion: 4, idempotencyKey: "short" }).ok);

  check(`every ok decision kept (${OK.length}): its event seq is the work's new version`, OK.length >= 30 && OK.every((d) => d.event.seq === d.work.version));
  const bumps = [
    evaluateExternalWork(work({ version: 7 }), { type: "RECORD_PROGRESS", stage: "REPAIR_DONE" }, OWNER),
    evaluateExternalWork(work({ version: 7 }), { type: "CHANGE_EXPECTED_BACK", expectedBackOn: null }, OWNER),
    evaluateExternalWork(work({ version: 7 }), { type: "RECORD_COST", kind: "FINAL", amountAgorot: 1 }, OWNER),
    evaluateExternalWork(work({ version: 7, finalCostAgorot: 1 }), { type: "CORRECT_FINAL_COST", amountAgorot: 2, reason: "x" }, OWNER),
    closeExternalWork(work({ version: 7 }), { result: "REPAIRED", followUpRequired: false }, OWNER),
  ];
  check("every kind of change bumps the version by exactly one (7 → 8)", bumps.every((d) => d.ok && d.work.version === 8 && d.event.seq === 8));
  const TOKEN = /^[A-Za-z0-9_:.-]{0,64}$/;
  const bad = OK.filter((d) => Object.values(d.event.payload).some((x: ServiceEventPayloadValue) =>
    !(x === null || typeof x === "boolean" || (typeof x === "number" && Number.isFinite(x)) || (typeof x === "string" && TOKEN.test(x)))) || Buffer.byteLength(JSON.stringify(d.event.payload)) > 4000);
  check("every payload: short tokens, numbers, booleans, nulls; under 4 KB", bad.length === 0, bad.slice(0, 2).map((d) => JSON.stringify(d.event.payload)).join(" | "));
  check("no text of any decision appears in its event", OK.every((d) => Object.values(d.texts).every((t) => t === null || !JSON.stringify(d.event).includes(t))));

  const frozenW = deepFreeze(work({ version: 2 }));
  const frozenIn = deepFreeze({ ...SEND });
  let threw = false;
  let a: ExternalWorkDecision | null = null, b: ExternalWorkDecision | null = null;
  try {
    a = evaluateExternalWork(frozenW, { type: "RECORD_COST", kind: "ESTIMATED", amountAgorot: 5 }, OWNER);
    b = evaluateExternalWork(frozenW, { type: "RECORD_COST", kind: "ESTIMATED", amountAgorot: 5 }, OWNER);
    openExternalWork(frozenIn, deepFreeze({ ...FACTS }), OWNER);
  } catch { threw = true; }
  check("frozen inputs accepted; same input → same output; fresh objects", !threw && JSON.stringify(a) === JSON.stringify(b) && a !== null && b !== null && a.ok && b.ok && a.work !== b.work);
  const src = fs.readFileSync(path.join(process.cwd(), "lib/services/service-desk/external-work.core.ts"), "utf8");
  const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  check("external-work.core.ts imports only the service-desk core and contracts", imports.every((i) => ["./contracts", "./external-work.contracts", "./service-case.core"].includes(i)), imports.join(","));
  const impure = /Date\.now|new Date\(\)|Math\.random|process\.env|fetch\(|prisma|setTimeout|crypto/.exec(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""));
  check("external-work.core.ts uses no clock, randomness, env, network or database", impure === null, impure?.[0] ?? "");
}

console.log(`\n${pass} passed, ${fail} failed, ${pass + fail} checks`);
if (fail > 0) process.exit(1);
