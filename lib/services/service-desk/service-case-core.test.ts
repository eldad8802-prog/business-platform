/**
 * Service Desk — the ServiceCase state machine, pure proofs (no database, no network, no clock). Run:
 *   npx tsx lib/services/service-desk/service-case-core.test.ts
 *
 *   - the 13 × 13 status matrix equals the spec, and no action reaches a pair outside it;
 *   - every action from every status, for IN_SHOP / FIELD / MAINTENANCE: allowed only where the spec allows it;
 *   - the business rules: quote approval bound to version + total + document, cover instead of a quote,
 *     delivery with an open balance only as the owner's decision with a reason, closing blocked by open
 *     commitments, a cancelled item the business holds is still handed back;
 *   - all 12 alternative paths, positive and negative;
 *   - status / holdReason / outcome stay separate;
 *   - inputs are never mutated, the same input gives the same output, the core imports nothing impure.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import {
  SERVICE_CASE_KINDS,
  SERVICE_CASE_STATUSES,
  TERMINAL_STATUSES,
  type ServiceCaseAction,
  type ServiceCaseActionType,
  type ServiceCaseActor,
  type ServiceCaseContext,
  type ServiceCaseKind,
  type ServiceCaseStatus,
  type ServiceCaseViolationCode,
  type ServiceQuoteSnapshot,
  type ServiceTransitionDecision,
} from "./contracts";
import {
  ACTION_FROM,
  TRANSITION_GRAPH,
  canMove,
  checkCommandEnvelope,
  evaluateRepeatCase,
  evaluateTransition,
  isRepairAuthorized,
  isTerminal,
  itemHeldByBusiness,
  withdrawQuote,
} from "./service-case.core";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, extra = ""): void {
  total += 1;
  if (!cond) failures += 1;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
}
function codes(d: ServiceTransitionDecision): ServiceCaseViolationCode[] {
  return d.ok ? [] : d.violations.map((v) => v.code);
}
function refusedWith(name: string, d: ServiceTransitionDecision, code: ServiceCaseViolationCode): void {
  check(name, !d.ok && codes(d).includes(code), d.ok ? `allowed → ${d.to}` : codes(d).join(","));
}
function allowedTo(name: string, d: ServiceTransitionDecision, to: ServiceCaseStatus): void {
  check(name, d.ok && d.to === to, d.ok ? `→ ${d.to}` : codes(d).join(","));
}
function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

const OWNER: ServiceCaseActor = { kind: "OWNER", userId: 70 };
const CUSTOMER: ServiceCaseActor = { kind: "CUSTOMER_LINK" };
const SYSTEM: ServiceCaseActor = { kind: "SYSTEM" };

function ctx(o: Partial<ServiceCaseContext> = {}): ServiceCaseContext {
  return {
    kind: "IN_SHOP",
    status: "OPEN",
    holdReason: null,
    outcome: null,
    version: 3,
    staffMemberId: 5,
    siteId: null,
    coverage: null,
    currentQuote: null,
    intake: { conditionRecorded: true, accessoriesRecorded: true, customerSigned: true },
    qaChecklistCompleted: true,
    openPartReservations: 0,
    openLoaner: false,
    pickupRemindersSent: 0,
    cancellationRequested: false,
    settlement: { known: true, openBalanceAgorot: 0 },
    ...o,
  };
}
function sentQuote(version = 1, totalAgorot = 45_000, docHash = "h1"): ServiceQuoteSnapshot {
  return { version, totalAgorot, docHash, state: "SENT", approval: null };
}
function approvedQuote(version = 1, totalAgorot = 45_000, docHash = "h1"): ServiceQuoteSnapshot {
  return { version, totalAgorot, docHash, state: "APPROVED", approval: { version, totalAgorot, docHash, method: "PHONE" } };
}
const RECEIPT = { receivedByName: "ישראל ישראלי", signatureCaptured: true };
const ev = evaluateTransition;

// ── 1. Status matrix ───────────────────────────────────────────────────────────────────────────────────────
console.log("— 1. the 13 × 13 status matrix (spec part B)");
const EXPECTED: Record<ServiceCaseStatus, ServiceCaseStatus[]> = {
  OPEN: ["SCHEDULED", "CHECKED_IN", "CANCELLED"],
  SCHEDULED: ["CHECKED_IN", "CANCELLED"],
  CHECKED_IN: ["DIAGNOSING", "READY", "CANCELLED"],
  DIAGNOSING: ["QUOTE_PENDING", "IN_REPAIR", "EXTERNAL", "READY", "CANCELLED"], // owner decision 11-03: cancel from any stage
  QUOTE_PENDING: ["IN_REPAIR", "READY", "CANCELLED"],
  IN_REPAIR: ["QA", "EXTERNAL", "QUOTE_PENDING", "READY", "CANCELLED"], // owner decision 11-03
  EXTERNAL: ["IN_REPAIR", "QA", "READY"],
  QA: ["READY", "IN_REPAIR"],
  READY: ["DELIVERED", "ABANDONED", "CANCELLED"], // owner decision 11-03 (nothing held)
  DELIVERED: ["CLOSED"],
  CLOSED: [],
  CANCELLED: [],
  ABANDONED: ["DELIVERED", "CLOSED"],
};
check("13 statuses", SERVICE_CASE_STATUSES.length === 13);
let matrixOk = 0;
for (const from of SERVICE_CASE_STATUSES) {
  for (const to of SERVICE_CASE_STATUSES) {
    if (canMove(from, to) === EXPECTED[from].includes(to)) matrixOk += 1;
    else check(`pair ${from} → ${to}`, false, `graph says ${canMove(from, to)}`);
  }
}
check("all 169 pairs match the spec matrix", matrixOk === 169, `${matrixOk}/169`);
check("no status moves to itself", SERVICE_CASE_STATUSES.every((s) => !canMove(s, s)));
check("terminal = CLOSED and CANCELLED only", TERMINAL_STATUSES.length === 2 && isTerminal("CLOSED") && isTerminal("CANCELLED"));
check("ABANDONED is not terminal", !isTerminal("ABANDONED"));
check("terminal statuses have no outgoing edge", TERMINAL_STATUSES.every((s) => TRANSITION_GRAPH[s].length === 0));

// ── 2. Every action from every status, every kind ──────────────────────────────────────────────────────────
console.log("— 2. sweep: every action × every status × every kind");
// Written from the spec, independently of ACTION_FROM, so a widened start set fails here and not only in §4.
const EXPECTED_FROM: Record<ServiceCaseActionType, ServiceCaseStatus[]> = {
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
  CANCEL: ["OPEN", "SCHEDULED", "CHECKED_IN", "DIAGNOSING", "QUOTE_PENDING", "IN_REPAIR", "EXTERNAL", "QA", "READY"], // owner decision 11-03
  ABANDON: ["READY"],
};
for (const [type, froms] of Object.entries(EXPECTED_FROM) as [ServiceCaseActionType, ServiceCaseStatus[]][]) {
  const actual = ACTION_FROM[type];
  check(`${type} starts only from ${froms.join(" | ")}`, actual.length === froms.length && froms.every((s) => actual.includes(s)), actual.join(" | "));
}
type Sample = { action: ServiceCaseAction; actor: ServiceCaseActor; over?: Partial<ServiceCaseContext> };
function samples(kind: ServiceCaseKind): Sample[] {
  const onSite = kind !== "IN_SHOP";
  const authorized = { coverage: { source: "MANUFACTURER" as const, decision: "APPROVED" as const }, currentQuote: approvedQuote() };
  return [
    { action: { type: "SCHEDULE", appointmentId: 11 }, actor: OWNER, over: { siteId: 4 } },
    { action: { type: "CHECK_IN" }, actor: OWNER },
    { action: { type: "START_DIAGNOSIS" }, actor: OWNER },
    { action: { type: "SEND_QUOTE", quote: { version: 2, totalAgorot: 1000, docHash: "h2" } }, actor: OWNER, over: authorized },
    { action: { type: "APPROVE_QUOTE", approval: { version: 1, totalAgorot: 45_000, docHash: "h1", method: "PHONE" } }, actor: OWNER, over: { currentQuote: sentQuote() } },
    { action: { type: "APPROVE_QUOTE", approval: { version: 1, totalAgorot: 45_000, docHash: "h1", method: "LINK" } }, actor: CUSTOMER, over: { currentQuote: sentQuote() } },
    { action: { type: "REJECT_QUOTE", version: 1 }, actor: CUSTOMER, over: { currentQuote: sentQuote() } },
    { action: { type: "START_REPAIR" }, actor: OWNER, over: authorized },
    { action: { type: "SET_HOLD", reason: "PARTS" }, actor: OWNER },
    { action: { type: "CLEAR_HOLD" }, actor: OWNER, over: { holdReason: "CUSTOMER" } },
    { action: { type: "SEND_TO_EXTERNAL", supplierId: 8 }, actor: OWNER },
    { action: { type: "RETURN_FROM_EXTERNAL", next: "IN_REPAIR" }, actor: OWNER, over: authorized },
    { action: { type: "RETURN_FROM_EXTERNAL", next: "QA" }, actor: OWNER, over: authorized },
    { action: { type: "RETURN_FROM_EXTERNAL", next: "READY", outcome: "REPAIRED" }, actor: OWNER, over: authorized },
    { action: onSite ? { type: "FINISH_REPAIR", outcome: "REPAIRED" } : { type: "FINISH_REPAIR" }, actor: OWNER },
    { action: { type: "PASS_QA", outcome: "REPAIRED" }, actor: OWNER },
    { action: { type: "FAIL_QA" }, actor: OWNER, over: authorized },
    { action: { type: "MARK_NOT_REPAIRABLE" }, actor: OWNER },
    { action: { type: "DELIVER", receipt: RECEIPT }, actor: OWNER, over: { outcome: "REPAIRED" } },
    { action: { type: "CLOSE" }, actor: SYSTEM, over: { outcome: "REPAIRED" } },
    { action: { type: "CANCEL", reason: "הלקוח ביטל" }, actor: OWNER },
    { action: { type: "ABANDON", reason: "לא נאסף אחרי 3 תזכורות" }, actor: OWNER, over: { outcome: "REPAIRED", pickupRemindersSent: 3 } },
  ];
}
const realised = new Set<string>();
const sweepActions = new Set<ServiceCaseActionType>();
for (const kind of SERVICE_CASE_KINDS) {
  for (const status of SERVICE_CASE_STATUSES) {
    const problems: string[] = [];
    for (const s of samples(kind)) {
      sweepActions.add(s.action.type);
      const outcome = ["READY", "DELIVERED", "ABANDONED"].includes(status) ? s.over?.outcome ?? "REPAIRED" : null;
      const d = ev(ctx({ kind, status, staffMemberId: 5, siteId: 4, ...s.over, outcome }), s.action, s.actor);
      const startsHere = EXPECTED_FROM[s.action.type].includes(status);
      if (!startsHere || isTerminal(status)) {
        if (d.ok) problems.push(`${s.action.type} allowed from ${status}`);
        else if (!codes(d).some((c) => c === "INVALID_TRANSITION" || c === "TERMINAL_STATUS")) {
          problems.push(`${s.action.type}: wrong refusal ${codes(d).join(",")}`);
        }
        continue;
      }
      if (!d.ok) continue; // a legitimate business refusal for this sample (e.g. QA for FIELD) — judged in §3–§5
      if (d.statusChanged ? !canMove(status, d.to) : d.to !== status) problems.push(`${s.action.type} → ${d.to} off-graph`);
      if (d.statusChanged) realised.add(`${status}>${d.to}`);
      if (d.holdReason !== null && d.to !== "IN_REPAIR") problems.push(`${s.action.type}: hold outside IN_REPAIR`);
      const needsOutcome = ["READY", "DELIVERED", "CLOSED", "ABANDONED", "CANCELLED"].includes(d.to);
      if (needsOutcome !== (d.outcome !== null)) problems.push(`${s.action.type}: outcome ${d.outcome} at ${d.to}`);
      if (d.event.fromStatus !== status || d.event.toStatus !== d.to) problems.push(`${s.action.type}: event statuses`);
    }
    check(`${kind} from ${status}: only allowed actions pass, results stay on the graph`, problems.length === 0, problems.join("; "));
  }
}
const graphEdges = SERVICE_CASE_STATUSES.flatMap((f) => TRANSITION_GRAPH[f].map((t) => `${f}>${t}`));
const unrealised = graphEdges.filter((e) => !realised.has(e));
check("every graph edge is reachable by some action (no dead rule)", unrealised.length === 0, unrealised.join(", "));
check("no action realises an edge outside the graph", [...realised].every((e) => graphEdges.includes(e)));
check("the sweep exercised all 19 actions", sweepActions.size === Object.keys(ACTION_FROM).length && sweepActions.size === 19);

// ── 3. Business validations ────────────────────────────────────────────────────────────────────────────────
console.log("— 3. validations");
refusedWith("missing data: schedule without an appointment", ev(ctx(), { type: "SCHEDULE", appointmentId: 0 }, OWNER), "INVALID_INPUT");
refusedWith("missing data: diagnosis without a staff member", ev(ctx({ status: "CHECKED_IN", staffMemberId: null }), { type: "START_DIAGNOSIS" }, OWNER), "STAFF_REQUIRED");
{
  const d = ev(ctx({ intake: { conditionRecorded: true, accessoriesRecorded: false, customerSigned: false } }), { type: "CHECK_IN" }, OWNER);
  refusedWith("missing data: IN_SHOP check-in without accessories and signature", d, "INTAKE_INCOMPLETE");
  check("  …the refusal names what is missing", !d.ok && /accessories, customerSignature/.test(d.violations[0].detail));
}
refusedWith("missing data: IN_SHOP check-in with no intake at all", ev(ctx({ intake: null }), { type: "CHECK_IN" }, OWNER), "INTAKE_INCOMPLETE");
allowedTo("IN_SHOP check-in with a full intake", ev(ctx(), { type: "CHECK_IN" }, OWNER), "CHECKED_IN");

// unapproved quote
refusedWith("unapproved quote: back from the supplier into repair", ev(ctx({ status: "EXTERNAL", currentQuote: sentQuote() }), { type: "RETURN_FROM_EXTERNAL", next: "IN_REPAIR" }, OWNER), "REPAIR_NOT_AUTHORIZED");
refusedWith("unapproved quote: start repair without a cover", ev(ctx({ status: "DIAGNOSING", currentQuote: sentQuote() }), { type: "START_REPAIR" }, OWNER), "COVERAGE_NOT_APPROVED");
refusedWith("approve when no quote was sent", ev(ctx({ status: "QUOTE_PENDING", currentQuote: approvedQuote() }), { type: "APPROVE_QUOTE", approval: { version: 1, totalAgorot: 45_000, docHash: "h1", method: "PHONE" } }, OWNER), "QUOTE_NOT_AWAITING_DECISION");

// version / total / document bound
const qp = ctx({ status: "QUOTE_PENDING", currentQuote: sentQuote(2, 52_000, "h2") });
refusedWith("approval of an older version", ev(qp, { type: "APPROVE_QUOTE", approval: { version: 1, totalAgorot: 52_000, docHash: "h2", method: "PHONE" } }, OWNER), "APPROVAL_MISMATCH");
refusedWith("approval of another total", ev(qp, { type: "APPROVE_QUOTE", approval: { version: 2, totalAgorot: 45_000, docHash: "h2", method: "PHONE" } }, OWNER), "APPROVAL_MISMATCH");
refusedWith("approval of another document", ev(qp, { type: "APPROVE_QUOTE", approval: { version: 2, totalAgorot: 52_000, docHash: "h1", method: "PHONE" } }, OWNER), "APPROVAL_MISMATCH");
allowedTo("approval of the exact current version, total and document", ev(qp, { type: "APPROVE_QUOTE", approval: { version: 2, totalAgorot: 52_000, docHash: "h2", method: "IN_PERSON" } }, OWNER), "IN_REPAIR");
check("an APPROVED quote whose approval names an older version does not authorise a repair", !isRepairAuthorized(ctx({ currentQuote: { ...approvedQuote(2, 52_000, "h2"), approval: { version: 1, totalAgorot: 45_000, docHash: "h1", method: "PHONE" } } })));
check("an APPROVED quote matching its approval authorises a repair", isRepairAuthorized(ctx({ currentQuote: approvedQuote() })));
refusedWith("a changed quote must be a newer version", ev(ctx({ status: "IN_REPAIR", currentQuote: approvedQuote(2) }), { type: "SEND_QUOTE", quote: { version: 2, totalAgorot: 60_000, docHash: "h3" } }, OWNER), "QUOTE_VERSION_NOT_NEWER");
{
  const d = ev(ctx({ status: "IN_REPAIR", currentQuote: approvedQuote(1) }), { type: "SEND_QUOTE", quote: { version: 2, totalAgorot: 60_000, docHash: "h2" } }, OWNER);
  allowedTo("a supplement is a new version → QUOTE_PENDING (re-approval required)", d, "QUOTE_PENDING");
}
refusedWith("a new version while the previous one awaits a decision", ev(ctx({ status: "DIAGNOSING", currentQuote: sentQuote(1) }), { type: "SEND_QUOTE", quote: { version: 2, totalAgorot: 1, docHash: "h2" } }, OWNER), "QUOTE_NOT_AWAITING_DECISION");
refusedWith("a quote with a fractional total", ev(ctx({ status: "DIAGNOSING" }), { type: "SEND_QUOTE", quote: { version: 1, totalAgorot: 10.5, docHash: "h1" } }, OWNER), "INVALID_INPUT");
refusedWith("the owner may not record a LINK approval", ev(ctx({ status: "QUOTE_PENDING", currentQuote: sentQuote() }), { type: "APPROVE_QUOTE", approval: { version: 1, totalAgorot: 45_000, docHash: "h1", method: "LINK" } }, OWNER), "APPROVAL_METHOD_NOT_ALLOWED");
refusedWith("the customer link may not claim a PHONE approval", ev(ctx({ status: "QUOTE_PENDING", currentQuote: sentQuote() }), { type: "APPROVE_QUOTE", approval: { version: 1, totalAgorot: 45_000, docHash: "h1", method: "PHONE" } }, CUSTOMER), "APPROVAL_METHOD_NOT_ALLOWED");

// outcome not decided
refusedWith("QA passes only with an outcome", ev(ctx({ status: "QA" }), { type: "PASS_QA" } as unknown as ServiceCaseAction, OWNER), "OUTCOME_REQUIRED");
refusedWith("QA passes only with a completed checklist", ev(ctx({ status: "QA", qaChecklistCompleted: false }), { type: "PASS_QA", outcome: "REPAIRED" }, OWNER), "QA_INCOMPLETE");
refusedWith("back from the supplier to READY without an outcome", ev(ctx({ status: "EXTERNAL" }), { type: "RETURN_FROM_EXTERNAL", next: "READY" }, OWNER), "OUTCOME_REQUIRED");
refusedWith("IN_SHOP finish-repair may not decide the outcome early", ev(ctx({ status: "IN_REPAIR", currentQuote: approvedQuote() }), { type: "FINISH_REPAIR", outcome: "REPAIRED" }, OWNER), "OUTCOME_NOT_ALLOWED");

// open balance (owner decision ש4)
const ready = (o: Partial<ServiceCaseContext> = {}) => ctx({ status: "READY", outcome: "REPAIRED", ...o });
refusedWith("open balance: delivery without the owner's decision", ev(ready({ settlement: { known: true, openBalanceAgorot: 5_000 } }), { type: "DELIVER", receipt: RECEIPT }, OWNER), "OPEN_BALANCE_NEEDS_OWNER_DECISION");
refusedWith("open balance: owner decision without a reason", ev(ready({ settlement: { known: true, openBalanceAgorot: 5_000 } }), { type: "DELIVER", receipt: RECEIPT, debtOverride: { reason: "  " } }, OWNER), "OVERRIDE_REASON_REQUIRED");
{
  const d = ev(ready({ settlement: { known: true, openBalanceAgorot: 5_000 } }), { type: "DELIVER", receipt: RECEIPT, debtOverride: { reason: "לקוח קבוע, ישלם ביום ראשון" } }, OWNER);
  allowedTo("open balance: delivery with the owner's decision and a reason", d, "DELIVERED");
  check("  …the event records the balance and the reason", d.ok && d.event.payload.openBalanceAgorot === 5_000 && d.event.payload.debtOverrideReason === "לקוח קבוע, ישלם ביום ראשון");
  check("  …and no effect touches the debt", d.ok && d.effects.every((e) => e === "ATTEMPT_AUTO_CLOSE"));
}
refusedWith("unknown balance: delivery refuses (fail closed)", ev(ready({ settlement: { known: false } }), { type: "DELIVER", receipt: RECEIPT, debtOverride: { reason: "x" } }, OWNER), "BALANCE_UNKNOWN");
refusedWith("delivery needs the receiver's signature", ev(ready(), { type: "DELIVER", receipt: { receivedByName: "דנה", signatureCaptured: false } }, OWNER), "RECEIPT_INCOMPLETE");
refusedWith("delivery needs the receiver's name", ev(ready(), { type: "DELIVER", receipt: { receivedByName: "", signatureCaptured: true } }, OWNER), "RECEIPT_INCOMPLETE");
refusedWith("the customer link may not deliver", ev(ready(), { type: "DELIVER", receipt: RECEIPT }, CUSTOMER), "ACTOR_NOT_ALLOWED");
{
  const d = ev(ready(), { type: "DELIVER", receipt: RECEIPT }, OWNER);
  allowedTo("a paid-up delivery", d, "DELIVERED");
  check("  …asks the service to attempt the automatic close", d.ok && d.effects.includes("ATTEMPT_AUTO_CLOSE"));
  check("  …and the settlement must be read in the same transaction", d.ok && d.serverChecks.includes("SETTLEMENT_READ_IN_SAME_TRANSACTION"));
}

// open commitments at close
const delivered = (o: Partial<ServiceCaseContext> = {}) => ctx({ status: "DELIVERED", outcome: "REPAIRED", ...o });
refusedWith("close with reserved parts still open", ev(delivered({ openPartReservations: 2 }), { type: "CLOSE" }, SYSTEM), "OPEN_PART_RESERVATIONS");
refusedWith("close with a quote awaiting a decision", ev(delivered({ currentQuote: sentQuote() }), { type: "CLOSE" }, SYSTEM), "OPEN_QUOTE");
allowedTo("close with nothing open (system auto-close)", ev(delivered(), { type: "CLOSE" }, SYSTEM), "CLOSED");
allowedTo("close by the owner", ev(delivered(), { type: "CLOSE" }, OWNER), "CLOSED");
refusedWith("early close from READY", ev(ready(), { type: "CLOSE" }, OWNER), "INVALID_TRANSITION");
refusedWith("early close from IN_REPAIR", ev(ctx({ status: "IN_REPAIR" }), { type: "CLOSE" }, OWNER), "INVALID_TRANSITION");
refusedWith("the system may not deliver", ev(ready(), { type: "DELIVER", receipt: RECEIPT }, SYSTEM), "ACTOR_NOT_ALLOWED");
refusedWith("an owner without a user is not an actor", ev(ready(), { type: "DELIVER", receipt: RECEIPT }, { kind: "OWNER", userId: 0 }), "ACTOR_NOT_ALLOWED");
refusedWith("a CLOSED case does not reopen", ev(ctx({ status: "CLOSED", outcome: "REPAIRED" }), { type: "CHECK_IN" }, OWNER), "TERMINAL_STATUS");

// ── 4. The 12 alternative paths ────────────────────────────────────────────────────────────────────────────
console.log("— 4. alternative paths");
const covered = { source: "MANUFACTURER" as const, decision: "APPROVED" as const };

console.log("  4.1 warranty repair");
allowedTo("approved manufacturer cover → repair without a quote", ev(ctx({ status: "DIAGNOSING", coverage: covered }), { type: "START_REPAIR" }, OWNER), "IN_REPAIR");
refusedWith("cover still pending → no repair without a quote", ev(ctx({ status: "DIAGNOSING", coverage: { source: "MANUFACTURER", decision: "PENDING" } }), { type: "START_REPAIR" }, OWNER), "COVERAGE_NOT_APPROVED");
refusedWith("cover denied (physical damage) → no repair without a quote", ev(ctx({ status: "DIAGNOSING", coverage: { source: "STORE", decision: "DENIED" } }), { type: "START_REPAIR" }, OWNER), "COVERAGE_NOT_APPROVED");
allowedTo("a ₪0 quote under an approved cover", ev(ctx({ status: "DIAGNOSING", coverage: covered }), { type: "SEND_QUOTE", quote: { version: 1, totalAgorot: 0, docHash: "h0" } }, OWNER), "QUOTE_PENDING");
refusedWith("a ₪0 quote without a cover", ev(ctx({ status: "DIAGNOSING" }), { type: "SEND_QUOTE", quote: { version: 1, totalAgorot: 0, docHash: "h0" } }, OWNER), "QUOTE_TOTAL_REQUIRES_COVERAGE");

console.log("  4.2 repeat repair");
{
  const r = evaluateRepeatCase({ parent: { status: "CLOSED", outcome: "REPAIRED", deliveredOn: "2026-10-01" }, openedOn: "2026-11-03", repairWarrantyDays: 90 });
  check("within the repair warranty (33 days of 90)", r.ok && r.withinRepairWarranty && r.daysSinceDelivery === 33);
  const late = evaluateRepeatCase({ parent: { status: "CLOSED", outcome: "REPAIRED", deliveredOn: "2026-01-01" }, openedOn: "2026-11-03", repairWarrantyDays: 90 });
  check("past the repair warranty → a regular repeat, charged", late.ok && !late.withinRepairWarranty);
  const notRepaired = evaluateRepeatCase({ parent: { status: "CLOSED", outcome: "NOT_REPAIRED", deliveredOn: "2026-10-30" }, openedOn: "2026-11-03", repairWarrantyDays: 90 });
  check("a parent that was not repaired carries no repair warranty", notRepaired.ok && !notRepaired.withinRepairWarranty);
  const open = evaluateRepeatCase({ parent: { status: "IN_REPAIR", outcome: null, deliveredOn: null }, openedOn: "2026-11-03", repairWarrantyDays: 90 });
  check("a parent still in repair cannot have a repeat", !open.ok);
  const bad = evaluateRepeatCase({ parent: { status: "CLOSED", outcome: "REPAIRED", deliveredOn: "2026-02-30" }, openedOn: "2026-11-03", repairWarrantyDays: 90 });
  check("an impossible date is refused", !bad.ok);
  const backwards = evaluateRepeatCase({ parent: { status: "CLOSED", outcome: "REPAIRED", deliveredOn: "2026-11-05" }, openedOn: "2026-11-03", repairWarrantyDays: 90 });
  check("a repeat opened before the delivery is refused", !backwards.ok);
  check("the closed parent itself never reopens", !ev(ctx({ status: "CLOSED", outcome: "REPAIRED" }), { type: "START_DIAGNOSIS" }, OWNER).ok);
}

console.log("  4.3 not repairable");
allowedTo("diagnosis → READY", ev(ctx({ status: "DIAGNOSING" }), { type: "MARK_NOT_REPAIRABLE" }, OWNER), "READY");
check("  …with outcome NOT_REPAIRED", (() => { const d = ev(ctx({ status: "IN_REPAIR" }), { type: "MARK_NOT_REPAIRABLE" }, OWNER); return d.ok && d.outcome === "NOT_REPAIRED"; })());
allowedTo("  …and still goes through an orderly handover", ev(ready({ outcome: "NOT_REPAIRED" }), { type: "DELIVER", receipt: RECEIPT }, OWNER), "DELIVERED");
refusedWith("not repairable is not a QA step", ev(ctx({ status: "QA" }), { type: "MARK_NOT_REPAIRABLE" }, OWNER), "INVALID_TRANSITION");

console.log("  4.4 rejected quote");
{
  const d = ev(ctx({ status: "QUOTE_PENDING", currentQuote: sentQuote() }), { type: "REJECT_QUOTE", version: 1 }, CUSTOMER);
  allowedTo("the customer rejects → READY", d, "READY");
  check("  …outcome QUOTE_REJECTED", d.ok && d.outcome === "QUOTE_REJECTED");
}
allowedTo("the owner records a rejection by phone", ev(ctx({ status: "QUOTE_PENDING", currentQuote: sentQuote() }), { type: "REJECT_QUOTE", version: 1 }, OWNER), "READY");
refusedWith("rejecting a version that is not current", ev(ctx({ status: "QUOTE_PENDING", currentQuote: sentQuote(2) }), { type: "REJECT_QUOTE", version: 1 }, OWNER), "QUOTE_VERSION_MISMATCH");
allowedTo("the rejected item is handed back", ev(ready({ outcome: "QUOTE_REJECTED" }), { type: "DELIVER", receipt: RECEIPT }, OWNER), "DELIVERED");

console.log("  4.5 cancelled");
{
  const open = ev(ctx({ status: "OPEN" }), { type: "CANCEL", reason: "הלקוח התחרט" }, OWNER);
  allowedTo("cancel before the item arrives → CANCELLED", open, "CANCELLED");
  check("  …outcome CANCELLED, item not held", open.ok && open.outcome === "CANCELLED" && open.event.payload.itemHeldByBusiness === false);
  const held = ev(ctx({ status: "CHECKED_IN" }), { type: "CANCEL", reason: "הלקוח ביטל" }, OWNER);
  allowedTo("cancel while the shop holds the item → READY, not CANCELLED", held, "READY");
  check("  …outcome CANCELLED and the item is recorded as still held", held.ok && held.outcome === "CANCELLED" && held.event.payload.itemHeldByBusiness === true);
  const withOpen = ev(ctx({ status: "QUOTE_PENDING", currentQuote: sentQuote(), openPartReservations: 1 }), { type: "CANCEL", reason: "x" }, OWNER);
  check("cancel with a sent quote and a reservation → withdraw + release", withOpen.ok && withOpen.effects.includes("WITHDRAW_OPEN_QUOTE") && withOpen.effects.includes("RELEASE_PART_RESERVATIONS"));
  allowedTo("a FIELD case holds nothing → CANCELLED", ev(ctx({ kind: "FIELD", status: "CHECKED_IN" }), { type: "CANCEL" }, OWNER), "CANCELLED");
  // Expectation changed by the owner decision of 11-03 (was: INVALID_TRANSITION — cancel during repair not implemented).
  allowedTo("cancel during repair (owner decision 11-03) → READY", ev(ctx({ status: "IN_REPAIR", currentQuote: approvedQuote() }), { type: "CANCEL", reason: "x" }, OWNER), "READY");
  refusedWith("a CANCELLED case is final", ev(ctx({ status: "CANCELLED", outcome: "CANCELLED" }), { type: "CHECK_IN" }, OWNER), "TERMINAL_STATUS");
  check("cancelling never deletes: it is an event like any other", open.ok && open.event.type === "case.cancelled");
}

console.log("  4.5a cancel from every stage before handover (owner decision 11-03)");
{
  type Expect = { to: ServiceCaseStatus; outcome: "CANCELLED" | null; reasonRequired: boolean };
  // IN_SHOP: from check-in on, the shop holds the item → READY; at the supplier → requested, stays EXTERNAL.
  const IN_SHOP_EXPECT: Partial<Record<ServiceCaseStatus, Expect>> = {
    OPEN: { to: "CANCELLED", outcome: "CANCELLED", reasonRequired: false },
    SCHEDULED: { to: "CANCELLED", outcome: "CANCELLED", reasonRequired: false },
    CHECKED_IN: { to: "READY", outcome: "CANCELLED", reasonRequired: true },
    DIAGNOSING: { to: "READY", outcome: "CANCELLED", reasonRequired: true },
    QUOTE_PENDING: { to: "READY", outcome: "CANCELLED", reasonRequired: true },
    IN_REPAIR: { to: "READY", outcome: "CANCELLED", reasonRequired: true },
    EXTERNAL: { to: "EXTERNAL", outcome: null, reasonRequired: true },
    QA: { to: "READY", outcome: "CANCELLED", reasonRequired: true },
    READY: { to: "READY", outcome: "CANCELLED", reasonRequired: true },
  };
  // FIELD: nothing is held at the business, except an item a supplier has.
  const FIELD_EXPECT: Partial<Record<ServiceCaseStatus, Expect>> = {
    OPEN: { to: "CANCELLED", outcome: "CANCELLED", reasonRequired: false },
    SCHEDULED: { to: "CANCELLED", outcome: "CANCELLED", reasonRequired: false },
    CHECKED_IN: { to: "CANCELLED", outcome: "CANCELLED", reasonRequired: false },
    DIAGNOSING: { to: "CANCELLED", outcome: "CANCELLED", reasonRequired: false },
    QUOTE_PENDING: { to: "CANCELLED", outcome: "CANCELLED", reasonRequired: false },
    IN_REPAIR: { to: "CANCELLED", outcome: "CANCELLED", reasonRequired: false },
    EXTERNAL: { to: "EXTERNAL", outcome: null, reasonRequired: true },
    READY: { to: "CANCELLED", outcome: "CANCELLED", reasonRequired: false },
  };
  for (const [kind, table] of [["IN_SHOP", IN_SHOP_EXPECT], ["FIELD", FIELD_EXPECT]] as const) {
    for (const [status, e] of Object.entries(table) as [ServiceCaseStatus, Expect][]) {
      const base = ctx({ kind, status, outcome: status === "READY" ? "REPAIRED" : null, intake: kind === "FIELD" ? null : undefined });
      const d = ev(base, { type: "CANCEL", reason: "בקשת הלקוח" }, OWNER);
      check(`${kind} ${status}: cancel → ${e.to} / outcome ${e.outcome}`, d.ok && d.to === e.to && d.outcome === e.outcome && d.holdReason === null, d.ok ? `${d.to}/${d.outcome}` : codes(d).join(","));
      const bare = ev(base, { type: "CANCEL" }, OWNER);
      check(`${kind} ${status}: reason ${e.reasonRequired ? "required" : "optional"}`, e.reasonRequired ? !bare.ok && codes(bare).includes("REASON_REQUIRED") : bare.ok);
    }
  }
  for (const s of ["DELIVERED", "CLOSED", "CANCELLED", "ABANDONED"] as ServiceCaseStatus[]) {
    const d = ev(ctx({ status: s, outcome: "REPAIRED" }), { type: "CANCEL", reason: "x" }, OWNER);
    check(`no cancel from ${s}`, !d.ok && codes(d).some((c) => c === "INVALID_TRANSITION" || c === "TERMINAL_STATUS"), codes(d).join(","));
  }
  refusedWith("a READY item already cancelled is not cancelled twice", ev(ready({ outcome: "CANCELLED" }), { type: "CANCEL", reason: "x" }, OWNER), "ALREADY_CANCELLED");
  refusedWith("a CANCELLED case cannot be cancelled again", ev(ctx({ status: "CANCELLED", outcome: "CANCELLED" }), { type: "CANCEL", reason: "x" }, OWNER), "TERMINAL_STATUS");
  refusedWith("a CLOSED case cannot be cancelled (nor reopened)", ev(ctx({ status: "CLOSED", outcome: "REPAIRED" }), { type: "CANCEL", reason: "x" }, OWNER), "TERMINAL_STATUS");
  refusedWith("the customer link may not cancel", ev(ctx({ status: "OPEN" }), { type: "CANCEL" }, CUSTOMER), "ACTOR_NOT_ALLOWED");

  // the item at an external supplier
  const atSup = ctx({ status: "EXTERNAL", currentQuote: approvedQuote() });
  const req = ev(atSup, { type: "CANCEL", reason: "הלקוח לא מעוניין" }, OWNER);
  check("at the supplier: the cancel is REQUESTED, the case stays EXTERNAL", req.ok && !req.statusChanged && req.to === "EXTERNAL" && req.outcome === null);
  check("  …event case.cancellation_requested, effect MARK_CANCELLATION_REQUESTED", req.ok && req.event.type === "case.cancellation_requested" && req.effects.includes("MARK_CANCELLATION_REQUESTED"));
  check("  …and records that the item is at the supplier", req.ok && req.event.payload.itemAtSupplier === true);
  const requested = { ...atSup, cancellationRequested: true };
  refusedWith("the item still at the supplier cannot be delivered", ev(requested, { type: "DELIVER", receipt: RECEIPT }, OWNER), "INVALID_TRANSITION");
  refusedWith("…nor marked READY by any cancel", ev(requested, { type: "CANCEL", reason: "x" }, OWNER), "ALREADY_CANCELLED");
  refusedWith("back from the supplier into repair after a cancel → refused", ev(requested, { type: "RETURN_FROM_EXTERNAL", next: "IN_REPAIR" }, OWNER), "CANCELLATION_REQUESTED");
  refusedWith("back from the supplier into QA after a cancel → refused", ev(requested, { type: "RETURN_FROM_EXTERNAL", next: "QA" }, OWNER), "CANCELLATION_REQUESTED");
  refusedWith("a cancelled return cannot claim REPAIRED", ev(requested, { type: "RETURN_FROM_EXTERNAL", next: "READY", outcome: "REPAIRED" }, OWNER), "OUTCOME_NOT_ALLOWED");
  const back = ev(requested, { type: "RETURN_FROM_EXTERNAL", next: "READY" }, OWNER);
  check("documented return from the supplier completes the cancel → READY / CANCELLED", back.ok && back.to === "READY" && back.outcome === "CANCELLED" && back.event.payload.cancellationCompleted === true);
  check("  …and needs no repair authorisation", ev({ ...requested, currentQuote: null }, { type: "RETURN_FROM_EXTERNAL", next: "READY" }, OWNER).ok);

  // nothing is undone, nothing is refunded
  const afterParts = ev(ctx({ status: "IN_REPAIR", currentQuote: approvedQuote(), openPartReservations: 0, holdReason: "PARTS" }), { type: "CANCEL", reason: "x" }, OWNER);
  check("cancel after parts were used: no stock, money or refund effect", afterParts.ok && afterParts.effects.length === 0 && afterParts.withdrawQuote === null);
  check("  …the hold ends with the repair stage", afterParts.ok && afterParts.holdReason === null);
  const withRes = ev(ctx({ status: "QA", openPartReservations: 2 }), { type: "CANCEL", reason: "x" }, OWNER);
  check("cancel with open reservations: only RELEASE_PART_RESERVATIONS", withRes.ok && withRes.effects.length === 1 && withRes.effects[0] === "RELEASE_PART_RESERVATIONS" && withRes.event.payload.openPartReservations === 2);
  const approved = ev(ctx({ status: "IN_REPAIR", currentQuote: approvedQuote() }), { type: "CANCEL", reason: "x" }, OWNER);
  check("cancel with an APPROVED quote: no withdrawal, the approval is history", approved.ok && !approved.effects.includes("WITHDRAW_OPEN_QUOTE") && approved.event.payload.quoteStateAtCancel === "APPROVED");
  const readyCancel = ev(ready({ outcome: "REPAIRED" }), { type: "CANCEL", reason: "x" }, OWNER);
  check("cancel at READY keeps the earlier outcome in the event", readyCancel.ok && readyCancel.event.payload.previousOutcome === "REPAIRED" && readyCancel.outcome === "CANCELLED");

  // after a cancel the handover rules are the normal ones
  const cancelledReady = ready({ outcome: "CANCELLED", settlement: { known: true, openBalanceAgorot: 12_000 } });
  refusedWith("cancelled + open balance: delivery still needs the owner's decision", ev(cancelledReady, { type: "DELIVER", receipt: RECEIPT }, OWNER), "OPEN_BALANCE_NEEDS_OWNER_DECISION");
  refusedWith("cancelled: delivery still needs the receiver's signature", ev(ready({ outcome: "CANCELLED" }), { type: "DELIVER", receipt: { receivedByName: "x", signatureCaptured: false } }, OWNER), "RECEIPT_INCOMPLETE");
  allowedTo("cancelled: handed back with the owner's decision on the balance", ev(cancelledReady, { type: "DELIVER", receipt: RECEIPT, debtOverride: { reason: "יקוזז" } }, OWNER), "DELIVERED");
  const balCancel = ev(ctx({ status: "IN_REPAIR", settlement: { known: true, openBalanceAgorot: 12_000 } }), { type: "CANCEL", reason: "x" }, OWNER);
  check("cancel with an open balance is not blocked and changes no money", balCancel.ok && balCancel.effects.length === 0);

  // history and inputs are kept
  const frozen = deepFreeze(ctx({ status: "QUOTE_PENDING", currentQuote: sentQuote(3, 70_000, "h3"), openPartReservations: 1 }));
  const snapshot = JSON.stringify(frozen);
  const fd = ev(frozen, { type: "CANCEL", reason: "x" }, OWNER);
  check("cancel does not mutate the case it judges", fd.ok && JSON.stringify(frozen) === snapshot);
  check("cancel is an appended event (from, to, action), never a delete", fd.ok && fd.event.fromStatus === "QUOTE_PENDING" && fd.event.toStatus === "READY" && fd.event.action === "CANCEL");
}

console.log("  4.5b WITHDRAWN — service quotes only (owner decision 11-03)");
{
  const sent = sentQuote(3, 70_000, "h3");
  const d = ev(ctx({ status: "QUOTE_PENDING", currentQuote: sent }), { type: "CANCEL", reason: "x" }, OWNER);
  check("a cancel with a sent quote returns a structured withdrawal instruction", d.ok && d.effects.includes("WITHDRAW_OPEN_QUOTE") && d.withdrawQuote !== null && d.withdrawQuote.version === 3 && d.withdrawQuote.totalAgorot === 70_000 && d.withdrawQuote.docHash === "h3");
  const frozenQuote = deepFreeze({ ...sent });
  const w = withdrawQuote(frozenQuote, { version: 3, totalAgorot: 70_000, docHash: "h3" });
  check("withdrawQuote → WITHDRAWN, version / total / document kept", w.ok && w.quote.state === "WITHDRAWN" && w.quote.version === 3 && w.quote.totalAgorot === 70_000 && w.quote.docHash === "h3");
  check("  …the input quote is untouched", frozenQuote.state === "SENT");
  const twice = w.ok ? withdrawQuote(w.quote, { version: 3, totalAgorot: 70_000, docHash: "h3" }) : null;
  check("no double withdrawal", twice !== null && !twice.ok && twice.violations[0].code === "QUOTE_WITHDRAWN");
  const ap = approvedQuote(2, 52_000, "h2");
  const wa = withdrawQuote(ap, { version: 2, totalAgorot: 52_000, docHash: "h2" });
  check("an approved quote is not withdrawn (its approval stays history)", !wa.ok && ap.approval !== null && ap.state === "APPROVED");
  const wr = withdrawQuote({ ...sent, state: "REJECTED" }, { version: 3, totalAgorot: 70_000, docHash: "h3" });
  check("a rejected quote is not withdrawn", !wr.ok);
  const wm = withdrawQuote(sent, { version: 2, totalAgorot: 70_000, docHash: "h3" });
  check("an instruction naming another version is refused", !wm.ok && wm.violations[0].code === "QUOTE_VERSION_MISMATCH");
  const withdrawnCase = ctx({ status: "QUOTE_PENDING", currentQuote: { ...sent, state: "WITHDRAWN" } });
  refusedWith("a withdrawn quote cannot be approved (owner)", ev(withdrawnCase, { type: "APPROVE_QUOTE", approval: { version: 3, totalAgorot: 70_000, docHash: "h3", method: "PHONE" } }, OWNER), "QUOTE_WITHDRAWN");
  refusedWith("a withdrawn quote cannot be approved (customer link)", ev(withdrawnCase, { type: "APPROVE_QUOTE", approval: { version: 3, totalAgorot: 70_000, docHash: "h3", method: "LINK" } }, CUSTOMER), "QUOTE_WITHDRAWN");
  refusedWith("a withdrawn quote cannot be rejected either", ev(withdrawnCase, { type: "REJECT_QUOTE", version: 3 }, CUSTOMER), "QUOTE_WITHDRAWN");
  check("a withdrawn quote does not authorise a repair", !isRepairAuthorized(withdrawnCase));
  const noOpen = ev(ctx({ status: "IN_REPAIR", currentQuote: { ...sent, state: "WITHDRAWN" } }), { type: "CANCEL", reason: "x" }, OWNER);
  check("no withdrawal instruction when nothing is open", noOpen.ok && noOpen.withdrawQuote === null && !noOpen.effects.includes("WITHDRAW_OPEN_QUOTE"));
  allowedTo("a cancelled case with a withdrawn quote can close", ev(ctx({ status: "DELIVERED", outcome: "CANCELLED", currentQuote: { ...sent, state: "WITHDRAWN" } }), { type: "CLOSE" }, SYSTEM), "CLOSED");
  const coreSrc = fs.readFileSync(path.join(process.cwd(), "lib/services/service-desk/service-case.core.ts"), "utf8");
  check("WITHDRAWN stays local: the core touches no billing module", !/billing|BillingDocument|@prisma/.test(coreSrc.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")));
}

console.log("  4.6 waiting for a part");
{
  const repair = ctx({ status: "IN_REPAIR", currentQuote: approvedQuote() });
  const d = ev(repair, { type: "SET_HOLD", reason: "PARTS" }, OWNER);
  check("hold for parts keeps IN_REPAIR and sets holdReason", d.ok && !d.statusChanged && d.to === "IN_REPAIR" && d.holdReason === "PARTS");
  refusedWith("the same hold twice", ev({ ...repair, holdReason: "PARTS" }, { type: "SET_HOLD", reason: "PARTS" }, OWNER), "HOLD_UNCHANGED");
  const clear = ev({ ...repair, holdReason: "PARTS" }, { type: "CLEAR_HOLD" }, OWNER);
  check("part received → hold cleared, status unchanged", clear.ok && clear.to === "IN_REPAIR" && clear.holdReason === null);
  refusedWith("clear with no hold", ev(repair, { type: "CLEAR_HOLD" }, OWNER), "NO_HOLD");
  refusedWith("a hold is only for IN_REPAIR", ev(ctx({ status: "DIAGNOSING" }), { type: "SET_HOLD", reason: "PARTS" }, OWNER), "INVALID_TRANSITION");
}

console.log("  4.7 sent to an importer / external lab");
allowedTo("diagnosis → supplier", ev(ctx({ status: "DIAGNOSING" }), { type: "SEND_TO_EXTERNAL", supplierId: 8 }, OWNER), "EXTERNAL");
refusedWith("no supplier named", ev(ctx({ status: "IN_REPAIR" }), { type: "SEND_TO_EXTERNAL", supplierId: 0 }, OWNER), "INVALID_INPUT");
allowedTo("returned under an approved cover → QA", ev(ctx({ status: "EXTERNAL", coverage: covered }), { type: "RETURN_FROM_EXTERNAL", next: "QA" }, OWNER), "QA");
refusedWith("returned repaired without authorisation", ev(ctx({ status: "EXTERNAL" }), { type: "RETURN_FROM_EXTERNAL", next: "READY", outcome: "REPAIRED" }, OWNER), "REPAIR_NOT_AUTHORIZED");
allowedTo("returned not repaired → READY (no authorisation needed)", ev(ctx({ status: "EXTERNAL" }), { type: "RETURN_FROM_EXTERNAL", next: "READY", outcome: "NOT_REPAIRED" }, OWNER), "READY");
refusedWith("an outcome may not be decided before READY", ev(ctx({ status: "EXTERNAL", coverage: covered }), { type: "RETURN_FROM_EXTERNAL", next: "QA", outcome: "REPAIRED" }, OWNER), "OUTCOME_NOT_ALLOWED");

console.log("  4.8 replacement");
{
  const d = ev(ctx({ status: "QA" }), { type: "PASS_QA", outcome: "REPLACED", replacementDeviceId: 41 }, OWNER);
  check("replaced → READY, links the new device", d.ok && d.outcome === "REPLACED" && d.effects.includes("LINK_REPLACEMENT_DEVICE") && d.serverChecks.includes("REPLACEMENT_DEVICE_BELONGS_TO_BUSINESS"));
  refusedWith("replaced without naming the new device", ev(ctx({ status: "QA" }), { type: "PASS_QA", outcome: "REPLACED" }, OWNER), "REPLACEMENT_DEVICE_REQUIRED");
  allowedTo("the importer replaced it", ev(ctx({ status: "EXTERNAL", coverage: covered }), { type: "RETURN_FROM_EXTERNAL", next: "READY", outcome: "REPLACED", replacementDeviceId: 42 }, OWNER), "READY");
}

console.log("  4.9 temporary replacement item");
refusedWith("final delivery with the loaner still out", ev(ready({ openLoaner: true }), { type: "DELIVER", receipt: RECEIPT }, OWNER), "OPEN_LOANER");
refusedWith("loaner override without a reason", ev(ready({ openLoaner: true }), { type: "DELIVER", receipt: RECEIPT, loanerOverride: { reason: "" } }, OWNER), "OVERRIDE_REASON_REQUIRED");
allowedTo("loaner override by the owner with a reason", ev(ready({ openLoaner: true }), { type: "DELIVER", receipt: RECEIPT, loanerOverride: { reason: "יחזיר מחר" } }, OWNER), "DELIVERED");

console.log("  4.10 not collected");
{
  const d = ev(ready({ pickupRemindersSent: 3 }), { type: "ABANDON", reason: "3 תזכורות ללא מענה" }, OWNER);
  allowedTo("READY → ABANDONED by the owner after documented reminders", d, "ABANDONED");
  check("  …keeps the outcome", d.ok && d.outcome === "REPAIRED");
  refusedWith("no reminder documented", ev(ready({ pickupRemindersSent: 0 }), { type: "ABANDON", reason: "x" }, OWNER), "PICKUP_REMINDERS_REQUIRED");
  refusedWith("no reason", ev(ready({ pickupRemindersSent: 2 }), { type: "ABANDON", reason: " " }, OWNER), "REASON_REQUIRED");
  refusedWith("the system may not abandon", ev(ready({ pickupRemindersSent: 2 }), { type: "ABANDON", reason: "x" }, SYSTEM), "ACTOR_NOT_ALLOWED");
  const ab = ctx({ status: "ABANDONED", outcome: "REPAIRED" });
  allowedTo("collected after all → DELIVERED", ev(ab, { type: "DELIVER", receipt: RECEIPT }, OWNER), "DELIVERED");
  allowedTo("or closed with the item still held", ev(ab, { type: "CLOSE" }, OWNER), "CLOSED");
}

console.log("  4.11 field visit not finished on the first visit (contract compatibility)");
{
  const f = (o: Partial<ServiceCaseContext>) => ctx({ kind: "FIELD", intake: null, siteId: 4, ...o });
  refusedWith("an on-site visit needs the site", ev(f({ siteId: null }), { type: "SCHEDULE", appointmentId: 11 }, OWNER), "SITE_REQUIRED");
  refusedWith("an on-site visit needs a technician", ev(f({ staffMemberId: null }), { type: "SCHEDULE", appointmentId: 11 }, OWNER), "STAFF_REQUIRED");
  allowedTo("technician on site → CHECKED_IN without a shop intake", ev(f({ status: "SCHEDULED" }), { type: "CHECK_IN" }, OWNER), "CHECKED_IN");
  const wait = ev(f({ status: "IN_REPAIR", currentQuote: approvedQuote() }), { type: "SET_HOLD", reason: "PARTS" }, OWNER);
  check("first visit ends waiting for a part: the case stays open in IN_REPAIR", wait.ok && wait.to === "IN_REPAIR" && wait.holdReason === "PARTS");
  allowedTo("the follow-up visit finishes → READY (no QA on site)", ev(f({ status: "IN_REPAIR", holdReason: "PARTS" }), { type: "FINISH_REPAIR", outcome: "REPAIRED" }, OWNER), "READY");
  refusedWith("finishing on site needs the outcome", ev(f({ status: "IN_REPAIR" }), { type: "FINISH_REPAIR" }, OWNER), "OUTCOME_REQUIRED");
  refusedWith("QA is not an on-site step", ev(f({ status: "EXTERNAL", coverage: covered }), { type: "RETURN_FROM_EXTERNAL", next: "QA" }, OWNER), "QA_NOT_FOR_KIND");
  allowedTo("signature on site → DELIVERED", ev(f({ status: "READY", outcome: "REPAIRED" }), { type: "DELIVER", receipt: RECEIPT }, OWNER), "DELIVERED");
}

console.log("  4.12 maintenance under a contract (contract compatibility)");
{
  const m = (o: Partial<ServiceCaseContext>) => ctx({ kind: "MAINTENANCE", intake: null, siteId: 4, ...o });
  allowedTo("approved contract cover → repair without a quote", ev(m({ status: "DIAGNOSING", coverage: { source: "CONTRACT", decision: "APPROVED" } }), { type: "START_REPAIR" }, OWNER), "IN_REPAIR");
  refusedWith("work outside the contract needs a quote", ev(m({ status: "DIAGNOSING", coverage: { source: "CONTRACT", decision: "DENIED" } }), { type: "START_REPAIR" }, OWNER), "COVERAGE_NOT_APPROVED");
  allowedTo("the visit closes the work → READY", ev(m({ status: "IN_REPAIR", coverage: { source: "CONTRACT", decision: "APPROVED" } }), { type: "FINISH_REPAIR", outcome: "REPAIRED" }, OWNER), "READY");
}

// ── 5. status / holdReason / outcome ───────────────────────────────────────────────────────────────────────
console.log("— 5. three separate fields");
{
  const hold = ev(ctx({ status: "IN_REPAIR" }), { type: "SET_HOLD", reason: "CUSTOMER" }, OWNER);
  check("a hold changes neither status nor outcome", hold.ok && hold.to === "IN_REPAIR" && hold.outcome === null && hold.holdReason === "CUSTOMER");
  const leave = ev(ctx({ status: "IN_REPAIR", holdReason: "PARTS" }), { type: "FINISH_REPAIR" }, OWNER);
  check("leaving IN_REPAIR clears the hold", leave.ok && leave.to === "QA" && leave.holdReason === null);
  const out = ev(ctx({ status: "IN_REPAIR", holdReason: "PARTS" }), { type: "SEND_TO_EXTERNAL", supplierId: 8 }, OWNER);
  check("a supplier wait is a status (EXTERNAL), not a hold", out.ok && out.to === "EXTERNAL" && out.holdReason === null);
  const fail = ev(ctx({ status: "QA" }), { type: "FAIL_QA" }, OWNER);
  check("back to repair carries no outcome", fail.ok && fail.outcome === null);
  const many = new Set([
    ev(ctx({ status: "DIAGNOSING" }), { type: "MARK_NOT_REPAIRABLE" }, OWNER),
    ev(ctx({ status: "QUOTE_PENDING", currentQuote: sentQuote() }), { type: "REJECT_QUOTE", version: 1 }, OWNER),
    ev(ctx({ status: "CHECKED_IN" }), { type: "CANCEL", reason: "x" }, OWNER),
    ev(ctx({ status: "QA" }), { type: "PASS_QA", outcome: "REPAIRED" }, OWNER),
  ].map((d) => (d.ok ? `${d.to}:${d.outcome}` : "refused")));
  check("four different outcomes share the one READY status", many.size === 4 && [...many].every((k) => k.startsWith("READY:")), [...many].join(" "));
}

// ── 6. Command envelope and event contract ─────────────────────────────────────────────────────────────────
console.log("— 6. command envelope, event");
{
  const c = ctx({ version: 7 });
  const cmd = { caseId: 12, action: { type: "CHECK_IN" } as ServiceCaseAction, expectedVersion: 7, idempotencyKey: "0192f4b2-7c1e-7a3b-9f00-1a2b3c4d5e6f" };
  check("a well-formed command at the current version", checkCommandEnvelope(c, cmd).ok);
  const stale = checkCommandEnvelope(c, { ...cmd, expectedVersion: 6 });
  check("a stale version → VERSION_CONFLICT", !stale.ok && stale.violations.some((v) => v.code === "VERSION_CONFLICT"));
  const noKey = checkCommandEnvelope(c, { ...cmd, idempotencyKey: "" });
  check("no idempotency key → INVALID_INPUT", !noKey.ok && noKey.violations.some((v) => v.code === "INVALID_INPUT"));
  const noCase = checkCommandEnvelope(c, { ...cmd, caseId: 0 });
  check("no case id → INVALID_INPUT", !noCase.ok);

  const actor: ServiceCaseActor = { kind: "OWNER", userId: 70 };
  const d = ev(ctx({ status: "CHECKED_IN" }), { type: "START_DIAGNOSIS" }, actor);
  check("event: type, action, from, to, actor", d.ok && d.event.type === "case.diagnosis_started" && d.event.action === "START_DIAGNOSIS" && d.event.fromStatus === "CHECKED_IN" && d.event.toStatus === "DIAGNOSING" && d.event.actor.kind === "OWNER");
  check("event actor is a copy, not the caller's object", d.ok && d.event.actor !== actor);
  check("every ok decision lists its server checks", d.ok && d.serverChecks.includes("STAFF_BELONGS_TO_BUSINESS"));
  const delivered2 = ev(ready(), { type: "DELIVER", receipt: RECEIPT }, OWNER);
  check("the journal payload carries no receiver name (PII)", delivered2.ok && !Object.values(delivered2.event.payload).includes(RECEIPT.receivedByName));
}

// ── 7. Quality ─────────────────────────────────────────────────────────────────────────────────────────────
console.log("— 7. purity, immutability, determinism");
{
  const frozen = deepFreeze(ctx({ status: "QUOTE_PENDING", currentQuote: sentQuote(), openPartReservations: 2 }));
  const before = JSON.stringify(frozen);
  const action = deepFreeze<ServiceCaseAction>({ type: "CANCEL", reason: "x" });
  let threw = false;
  let a: ServiceTransitionDecision | null = null;
  let b: ServiceTransitionDecision | null = null;
  try {
    a = ev(frozen, action, OWNER);
    b = ev(frozen, action, OWNER);
  } catch {
    threw = true;
  }
  check("frozen inputs are accepted (nothing writes to them)", !threw);
  check("inputs are unchanged", JSON.stringify(frozen) === before);
  check("same input → same output", a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b));
  check("two results do not share objects", a !== null && b !== null && a.ok && b.ok && a.event !== b.event && a.effects !== b.effects);
  const r1 = evaluateRepeatCase({ parent: { status: "CLOSED", outcome: "REPAIRED", deliveredOn: "2026-10-01" }, openedOn: "2026-11-03", repairWarrantyDays: 30 });
  const r2 = evaluateRepeatCase({ parent: { status: "CLOSED", outcome: "REPAIRED", deliveredOn: "2026-10-01" }, openedOn: "2026-11-03", repairWarrantyDays: 30 });
  check("repeat evaluation is deterministic (no clock)", JSON.stringify(r1) === JSON.stringify(r2) && r1.ok && !r1.withinRepairWarranty);

  const dir = path.join(process.cwd(), "lib/services/service-desk");
  for (const f of ["service-case.core.ts", "contracts.ts"]) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    check(`${f} imports only ./contracts`, imports.every((i) => i === "./contracts"), imports.join(","));
    const impure = /Date\.now|new Date\(\)|Math\.random|process\.env|fetch\(|prisma|setTimeout|crypto/.exec(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""));
    check(`${f} uses no clock, randomness, env, network or database`, impure === null, impure?.[0] ?? "");
  }
  check("itemHeldByBusiness: IN_SHOP holds from CHECKED_IN, FIELD never", itemHeldByBusiness("IN_SHOP", "CHECKED_IN") && !itemHeldByBusiness("IN_SHOP", "OPEN") && !itemHeldByBusiness("IN_SHOP", "EXTERNAL") && !itemHeldByBusiness("FIELD", "IN_REPAIR"));
}

console.log(`\n${total - failures} passed, ${failures} failed, ${total} checks`);
if (failures > 0) process.exit(1);
