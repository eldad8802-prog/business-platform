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
 *   - opening (1.1c): OPEN / version 1 / one case.opened at seq 1, no "from" status, never a second opening;
 *   - inputs are never mutated, the same input gives the same output, the core imports nothing impure.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import {
  SERVICE_CASE_INITIAL_VERSION,
  SERVICE_CASE_OPENING_SEQ,
  SERVICE_REASON_MAX_LENGTH,
  SERVICE_CASE_KINDS,
  SERVICE_CASE_STATUSES,
  TERMINAL_STATUSES,
  type ServiceCaseAction,
  type ServiceCaseActionType,
  type ServiceCaseActor,
  type ServiceCaseContext,
  type ServiceCaseOpenDecision,
  type ServiceCaseOpenInput,
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
  openServiceCase,
  reasonLength,
  supersedeQuote,
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
/** M1: a T3 case (on site, nothing handed back, QA optional, D15) — finished work goes to WORK_DONE. */
const T3_FACTS: NonNullable<ServiceCaseContext["track"]> = {
  track: "T3",
  workType: "REPAIR",
  location: "AT_CUSTOMER",
  itemAtBusiness: false,
  requirements: { intakeConfirmation: "NONE", workApproval: "BY_D15", qa: { mode: "OPTIONAL", template: "FIELD.v1" }, completion: "OWNER_CONFIRMATION", handoverByOwner: false },
  afterSaleResolution: null,
  siteAddressSet: true,
  moneyCommitment: false,
  creditDocumentLinked: false,
};
const NO_BLOCKERS = { binding: false, intakeStarted: false, appointmentStarted: false };
function sentQuote(version = 1, totalAgorot = 45_000, docHash = "h1"): ServiceQuoteSnapshot {
  return { version, totalAgorot, docHash, state: "SENT", approval: null };
}
function approvedQuote(version = 1, totalAgorot = 45_000, docHash = "h1"): ServiceQuoteSnapshot {
  return { version, totalAgorot, docHash, state: "APPROVED", approval: { version, totalAgorot, docHash, method: "PHONE" } };
}
const RECEIPT = { handoverConfirmed: true, receivedByName: "ישראל ישראלי" };
// Every decision any test produces is kept, so §8 can prove the journal payload rule over all of them.
type OkDecision = Extract<ServiceTransitionDecision, { ok: true }>;
const OK_DECISIONS: OkDecision[] = [];
const REFUSED_DECISIONS: Extract<ServiceTransitionDecision, { ok: false }>[] = [];
const ev = (c: ServiceCaseContext, a: ServiceCaseAction, actor: ServiceCaseActor): ServiceTransitionDecision => {
  const d = evaluateTransition(c, a, actor);
  if (d.ok) OK_DECISIONS.push(d);
  else REFUSED_DECISIONS.push(d);
  return d;
};

// ── 1. Status matrix ───────────────────────────────────────────────────────────────────────────────────────
// Expectation changed by M1 (migration 20261127090000): WORK_DONE is the 14th status; edges into it from every place
// finished work can come from, WORK_DONE → CLOSED (COMPLETE), and SCHEDULED → OPEN (CHANGE_DETAILS UNSCHEDULE, D13).
console.log("— 1. the 14 × 14 status matrix (spec part B + M1)");
const EXPECTED: Record<ServiceCaseStatus, ServiceCaseStatus[]> = {
  OPEN: ["SCHEDULED", "CHECKED_IN", "CANCELLED"],
  SCHEDULED: ["CHECKED_IN", "CANCELLED", "OPEN"], // M1 D13
  CHECKED_IN: ["DIAGNOSING", "READY", "CANCELLED"],
  DIAGNOSING: ["QUOTE_PENDING", "IN_REPAIR", "EXTERNAL", "READY", "WORK_DONE", "CANCELLED"], // owner decision 11-03: cancel from any stage
  QUOTE_PENDING: ["IN_REPAIR", "READY", "WORK_DONE", "CANCELLED"],
  IN_REPAIR: ["QA", "EXTERNAL", "QUOTE_PENDING", "READY", "WORK_DONE", "CANCELLED"], // owner decision 11-03
  EXTERNAL: ["IN_REPAIR", "QA", "READY", "WORK_DONE"],
  QA: ["READY", "WORK_DONE", "IN_REPAIR"],
  READY: ["DELIVERED", "ABANDONED", "CANCELLED"], // owner decision 11-03 (nothing held)
  WORK_DONE: ["CLOSED"], // M1: only COMPLETE
  DELIVERED: ["CLOSED"],
  CLOSED: [],
  CANCELLED: [],
  ABANDONED: ["DELIVERED", "CLOSED"],
};
check("14 statuses", SERVICE_CASE_STATUSES.length === 14);
let matrixOk = 0;
for (const from of SERVICE_CASE_STATUSES) {
  for (const to of SERVICE_CASE_STATUSES) {
    if (canMove(from, to) === EXPECTED[from].includes(to)) matrixOk += 1;
    else check(`pair ${from} → ${to}`, false, `graph says ${canMove(from, to)}`);
  }
}
check("all 196 pairs match the spec matrix", matrixOk === 196, `${matrixOk}/196`);
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
  REVISE_QUOTE: ["QUOTE_PENDING"], // ז-1 A (1.1b)
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
  RESCHEDULE: ["SCHEDULED"], // M1
  COMPLETE: ["WORK_DONE"], // M1
  CHANGE_DETAILS: ["OPEN", "SCHEDULED"], // M1 D3
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
    { action: { type: "CHECK_IN", intakeConfirmed: true }, actor: OWNER },
    { action: { type: "START_DIAGNOSIS" }, actor: OWNER },
    { action: { type: "SEND_QUOTE", quote: { version: 2, totalAgorot: 1000, docHash: "h2" } }, actor: OWNER, over: authorized },
    { action: { type: "APPROVE_QUOTE", approval: { version: 1, totalAgorot: 45_000, docHash: "h1", method: "PHONE" } }, actor: OWNER, over: { currentQuote: sentQuote() } },
    { action: { type: "APPROVE_QUOTE", approval: { version: 1, totalAgorot: 45_000, docHash: "h1", method: "LINK" } }, actor: CUSTOMER, over: { currentQuote: sentQuote() } },
    { action: { type: "REJECT_QUOTE", version: 1 }, actor: CUSTOMER, over: { currentQuote: sentQuote() } },
    { action: { type: "REVISE_QUOTE", replaces: { version: 1 }, quote: { version: 2, totalAgorot: 40_000, docHash: "h2" } }, actor: OWNER, over: { currentQuote: sentQuote() } },
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
    // M1: the same finishing actions on a track that hands nothing back (→ WORK_DONE), and the three new actions
    { action: { type: "FINISH_REPAIR", outcome: "REPAIRED" }, actor: OWNER, over: { track: T3_FACTS } },
    { action: { type: "PASS_QA", outcome: "REPAIRED" }, actor: OWNER, over: { track: T3_FACTS } },
    { action: { type: "MARK_NOT_REPAIRABLE" }, actor: OWNER, over: { track: T3_FACTS } },
    { action: { type: "REJECT_QUOTE", version: 1 }, actor: CUSTOMER, over: { currentQuote: sentQuote(), track: T3_FACTS } },
    { action: { type: "RETURN_FROM_EXTERNAL", next: "WORK_DONE", outcome: "REPAIRED" }, actor: OWNER, over: { ...authorized, track: T3_FACTS } },
    { action: { type: "COMPLETE", completion: { completionType: "OWNER_CONFIRMED_ON_SITE", ownerConfirmed: true } }, actor: OWNER, over: { track: T3_FACTS, outcome: "REPAIRED" } },
    { action: { type: "RESCHEDULE", appointmentId: 12 }, actor: OWNER, over: { appointmentId: 11 } },
    {
      action: { type: "CHANGE_DETAILS", next: { kind: kind === "IN_SHOP" ? "FIELD" : "IN_SHOP", workType: null, serviceLocation: null, siteAddress: null, returnReason: null }, appointmentImpact: "UNSCHEDULE" },
      actor: OWNER,
      over: { details: { kind, workType: null, serviceLocation: null, siteAddress: null, returnReason: null }, detailBlockers: NO_BLOCKERS },
    },
  ];
}
const realised = new Set<string>();
const sweepActions = new Set<ServiceCaseActionType>();
for (const kind of SERVICE_CASE_KINDS) {
  for (const status of SERVICE_CASE_STATUSES) {
    const problems: string[] = [];
    for (const s of samples(kind)) {
      sweepActions.add(s.action.type);
      const outcome = ["READY", "WORK_DONE", "DELIVERED", "ABANDONED"].includes(status) ? s.over?.outcome ?? "REPAIRED" : null;
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
      const needsOutcome = ["READY", "WORK_DONE", "DELIVERED", "CLOSED", "ABANDONED", "CANCELLED"].includes(d.to);
      if (needsOutcome !== (d.outcome !== null)) problems.push(`${s.action.type}: outcome ${d.outcome} at ${d.to}`);
      if (d.event.fromStatus !== status || d.event.toStatus !== d.to) problems.push(`${s.action.type}: event statuses`);
      if (typeof d.cancellationRequestedAfter !== "boolean") problems.push(`${s.action.type}: no explicit cancellationRequestedAfter`);
      // the sweep never starts with a pending request, so only a cancel AT the supplier may raise it
      const raises = s.action.type === "CANCEL" && status === "EXTERNAL";
      if (d.cancellationRequestedAfter !== raises) problems.push(`${s.action.type}: cancellationRequestedAfter ${d.cancellationRequestedAfter}`);
      if (d.event.cancellationRequestedBefore !== false || d.event.cancellationRequestedAfter !== d.cancellationRequestedAfter) {
        problems.push(`${s.action.type}: event cancel flags disagree with the decision`);
      }
    }
    check(`${kind} from ${status}: only allowed actions pass, results stay on the graph`, problems.length === 0, problems.join("; "));
  }
}
const graphEdges = SERVICE_CASE_STATUSES.flatMap((f) => TRANSITION_GRAPH[f].map((t) => `${f}>${t}`));
const unrealised = graphEdges.filter((e) => !realised.has(e));
check("every graph edge is reachable by some action (no dead rule)", unrealised.length === 0, unrealised.join(", "));
check("no action realises an edge outside the graph", [...realised].every((e) => graphEdges.includes(e)));
// Expectation changed by 1.1b: REVISE_QUOTE is the 20th action (was 19); by M1: RESCHEDULE, COMPLETE, CHANGE_DETAILS (23).
check("the sweep exercised all 23 actions", sweepActions.size === Object.keys(ACTION_FROM).length && sweepActions.size === 23);

// ── 3. Business validations ────────────────────────────────────────────────────────────────────────────────
console.log("— 3. validations");
refusedWith("missing data: schedule without an appointment", ev(ctx(), { type: "SCHEDULE", appointmentId: 0 }, OWNER), "INVALID_INPUT");
{
  // Owner decision 2 (1.3a): no technician → the signed-in owner handles it; an assigned one is a server check.
  const own = ev(ctx({ status: "CHECKED_IN", staffMemberId: null }), { type: "START_DIAGNOSIS" }, OWNER);
  allowedTo("diagnosis with no technician assigned → the owner handles it", own, "DIAGNOSING");
  check("  …the event says the owner handled it, and asks no staff check", own.ok && own.event.payload.handledByOwner === true && !own.serverChecks.includes("STAFF_BELONGS_TO_BUSINESS"));
  check("  …and the journal names the acting owner", own.ok && own.event.actor.kind === "OWNER" && (own.event.actor as { userId: number }).userId === OWNER.userId);
  const staffed = ev(ctx({ status: "CHECKED_IN", staffMemberId: 7 }), { type: "START_DIAGNOSIS" }, OWNER);
  check("diagnosis with an assigned technician asks the service to verify them (STAFF_BELONGS_TO_BUSINESS)", staffed.ok && staffed.serverChecks.includes("STAFF_BELONGS_TO_BUSINESS") && staffed.event.payload.handledByOwner === false);
  refusedWith("a malformed technician id is refused, never read as \"none\"", ev(ctx({ status: "CHECKED_IN", staffMemberId: 0 }), { type: "START_DIAGNOSIS" }, OWNER), "INVALID_INPUT");
}
{
  const d = ev(ctx({ intake: { conditionRecorded: true, accessoriesRecorded: false, customerSigned: false } }), { type: "CHECK_IN", intakeConfirmed: true }, OWNER);
  refusedWith("missing data: IN_SHOP check-in without accessories and signature", d, "INTAKE_INCOMPLETE");
  check("  …the refusal names what is missing — the accessories record, never a customer signature", !d.ok && /accessories/.test(d.violations[0].detail) && !/ignature/.test(d.violations[0].detail));
}
refusedWith("missing data: IN_SHOP check-in with no intake at all", ev(ctx({ intake: null }), { type: "CHECK_IN", intakeConfirmed: true }, OWNER), "INTAKE_INCOMPLETE");
allowedTo("IN_SHOP check-in with a full intake, confirmed by the owner", ev(ctx(), { type: "CHECK_IN", intakeConfirmed: true }, OWNER), "CHECKED_IN");
// Owner decision 2026-11-11: no customer signature anywhere. The owner's explicit confirmation replaces it.
allowedTo("no signature: a documented intake that was never signed checks in on the owner's confirmation",
  ev(ctx({ intake: { conditionRecorded: true, accessoriesRecorded: true, customerSigned: false } }), { type: "CHECK_IN", intakeConfirmed: true }, OWNER), "CHECKED_IN");
refusedWith("the owner's confirmation is explicit: a CHECK_IN of a held item without it is refused",
  ev(ctx({ intake: { conditionRecorded: true, accessoriesRecorded: true, customerSigned: false } }), { type: "CHECK_IN" }, OWNER), "INTAKE_NOT_CONFIRMED");
{
  const d = ev(ctx({ intake: { conditionRecorded: true, accessoriesRecorded: true, customerSigned: false } }), { type: "CHECK_IN", intakeConfirmed: true }, OWNER);
  check("  …no stored-signature server check any more, and the journal payload records the confirmation",
    d.ok && !(d.serverChecks as readonly string[]).includes("INTAKE_ARTIFACTS_STORED") && (d.event.payload as Record<string, unknown>).intakeConfirmed === true);
}

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
  // Expectation changed by 1.1b (ט-1 A): the reason moved from event.payload to decision.texts.
  check("  …the event records the balance and that a decision was made; the reason is in texts", d.ok && d.event.payload.openBalanceAgorot === 5_000 && d.event.payload.debtOverride === true && d.texts.debtOverrideReason === "לקוח קבוע, ישלם ביום ראשון");
  check("  …and no effect touches the debt", d.ok && d.effects.every((e) => e === "ATTEMPT_AUTO_CLOSE"));
}
refusedWith("unknown balance: delivery refuses (fail closed)", ev(ready({ settlement: { known: false } }), { type: "DELIVER", receipt: RECEIPT, debtOverride: { reason: "x" } }, OWNER), "BALANCE_UNKNOWN");
// owner decision 2026-11-11 (the same rule for DELIVER and COMPLETE): a known balance is debt XOR overpayment, never negative
refusedWith("malformed balance: a negative open balance is refused (an overpayment is reported separately)", ev(ready({ settlement: { known: true, openBalanceAgorot: -100 } }), { type: "DELIVER", receipt: RECEIPT }, OWNER), "INVALID_INPUT");
refusedWith("malformed balance: a debt and an overpayment together are refused", ev(ready({ settlement: { known: true, openBalanceAgorot: 100, overpaidAgorot: 20 } }), { type: "DELIVER", receipt: RECEIPT, debtOverride: { reason: "x" } }, OWNER), "INVALID_INPUT");
refusedWith("malformed balance: a negative overpayment is refused", ev(ready({ settlement: { known: true, openBalanceAgorot: 0, overpaidAgorot: -5 } }), { type: "DELIVER", receipt: RECEIPT }, OWNER), "INVALID_INPUT");
refusedWith("delivery needs the owner's confirmation (no customer signature — owner decision 2026-11-11)", ev(ready(), { type: "DELIVER", receipt: { handoverConfirmed: false, receivedByName: "דנה" } }, OWNER), "HANDOVER_NOT_CONFIRMED");
allowedTo("delivery without a receiver's name, on the owner's confirmation", ev(ready(), { type: "DELIVER", receipt: { handoverConfirmed: true } }, OWNER), "DELIVERED");
refusedWith("a receiver's name over 200 characters is refused", ev(ready(), { type: "DELIVER", receipt: { handoverConfirmed: true, receivedByName: "א".repeat(201) } }, OWNER), "INVALID_INPUT");
{
  const d = ev(ready(), { type: "DELIVER", receipt: { handoverConfirmed: true } }, OWNER);
  check("  …the event records the confirmation and that no name was given; no signature field anywhere",
    d.ok && (d.event.payload as Record<string, unknown>).handoverConfirmed === true && (d.event.payload as Record<string, unknown>).receiverNamed === false
      && !JSON.stringify(d.event.payload).includes("ign"));
}
refusedWith("a blank receiver's name is not a name (send none instead)", ev(ready(), { type: "DELIVER", receipt: { handoverConfirmed: true, receivedByName: "  " } }, OWNER), "INVALID_INPUT");
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
refusedWith("a CLOSED case does not reopen", ev(ctx({ status: "CLOSED", outcome: "REPAIRED" }), { type: "CHECK_IN", intakeConfirmed: true }, OWNER), "TERMINAL_STATUS");

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
  // Owner decision ש4 (1.3a): the parent's LOCKED warranty end date, inclusive, as Israel calendar days.
  const rep = (deliveredOn: string | null, openedOn: string, ends: string | null, o: Partial<{ status: "CLOSED" | "DELIVERED" | "IN_REPAIR"; outcome: "REPAIRED" | "NOT_REPAIRED" | "REPLACED" | null }> = {}) =>
    evaluateRepeatCase({ parent: { status: o.status ?? "CLOSED", outcome: o.outcome === undefined ? "REPAIRED" : o.outcome, deliveredOn }, openedOn, parentWarrantyEndsOn: ends });
  const r = rep("2026-10-01", "2026-11-03", "2026-12-30");
  check("within the locked warranty (opened 2026-11-03, ends 2026-12-30)", r.ok && r.withinRepairWarranty && r.daysSinceDelivery === 33 && r.warrantyEndsOn === "2026-12-30");
  const lastDay = rep("2026-10-01", "2026-12-30", "2026-12-30");
  check("opened ON the end date → still within (the end date is inclusive)", lastDay.ok && lastDay.withinRepairWarranty);
  const dayAfter = rep("2026-10-01", "2026-12-31", "2026-12-30");
  check("opened the day after the end date → past the warranty, never extended", dayAfter.ok && !dayAfter.withinRepairWarranty);
  const leap = rep("2028-01-31", "2028-02-29", "2028-02-29");
  check("a leap-day end date is a real date and is honoured", leap.ok && leap.withinRepairWarranty);
  const late = rep("2026-01-01", "2026-11-03", "2026-03-31");
  check("past the locked warranty → a regular repeat, charged", late.ok && !late.withinRepairWarranty);
  const notRepaired = rep("2026-10-30", "2026-11-03", "2027-01-28", { outcome: "NOT_REPAIRED" });
  check("a parent that was not repaired carries no repair warranty, even with a locked offer", notRepaired.ok && !notRepaired.withinRepairWarranty);
  const open = rep(null, "2026-11-03", "2027-01-28", { status: "IN_REPAIR", outcome: null });
  check("a parent still in repair cannot have a repeat", !open.ok);
  check("an impossible date is refused", !rep("2026-02-30", "2026-11-03", "2026-12-30").ok);
  check("an impossible end date is refused", !rep("2026-10-01", "2026-11-03", "2026-02-30").ok);
  check("an end date before the delivery is refused", !rep("2026-10-01", "2026-11-03", "2026-09-30").ok);
  check("a repeat opened before the delivery is refused", !rep("2026-11-05", "2026-11-03", "2026-12-30").ok);
  check("the closed parent itself never reopens", !ev(ctx({ status: "CLOSED", outcome: "REPAIRED" }), { type: "START_DIAGNOSIS" }, OWNER).ok);
  check("a locked warranty is reported as set", r.ok && r.commercialWarrantySet === true);
  const none = rep("2026-11-01", "2026-11-03", null);
  check("no locked offer (null) → a valid repeat, never within a commercial warranty, no period guessed", none.ok && !none.withinRepairWarranty && none.daysSinceDelivery === 2 && none.warrantyEndsOn === null);
  check("… and the decision says none was RECORDED — not that the customer has no warranty", none.ok && none.commercialWarrantySet === false);
  const sameDay = rep("2026-11-03", "2026-11-03", "2026-11-03");
  check("delivered, ending and reopened the same day → within", sameDay.ok && sameDay.withinRepairWarranty);
  const missing = evaluateRepeatCase({ parent: { status: "CLOSED", outcome: "REPAIRED", deliveredOn: "2026-11-01" }, openedOn: "2026-11-03", parentWarrantyEndsOn: undefined as unknown as null });
  check("undefined is not null — an absent value is refused, never read as \"none recorded\"", !missing.ok);
  const numeric = evaluateRepeatCase({ parent: { status: "CLOSED", outcome: "REPAIRED", deliveredOn: "2026-11-01" }, openedOn: "2026-11-03", parentWarrantyEndsOn: 90 as unknown as string });
  check("a number of days is not an end date — refused", !numeric.ok);
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
  refusedWith("a CANCELLED case is final", ev(ctx({ status: "CANCELLED", outcome: "CANCELLED" }), { type: "CHECK_IN", intakeConfirmed: true }, OWNER), "TERMINAL_STATUS");
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
  // Expectation changed by the 11-03 contract fix (was: effect MARK_CANCELLATION_REQUESTED). The next value is now the
  // explicit decision field, the single source of that state.
  check("  …event case.cancellation_requested, cancellationRequestedAfter = true", req.ok && req.event.type === "case.cancellation_requested" && req.cancellationRequestedAfter === true);
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
  refusedWith("cancelled: delivery still needs the owner's confirmation", ev(ready({ outcome: "CANCELLED" }), { type: "DELIVER", receipt: { handoverConfirmed: false, receivedByName: "x" } }, OWNER), "HANDOVER_NOT_CONFIRMED");
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

console.log("  4.5c the cancel request is an explicit part of every decision (contract fix 11-03)");
{
  const ext = (o: Partial<ServiceCaseContext> = {}) => ctx({ status: "EXTERNAL", currentQuote: approvedQuote(), ...o });
  const hasNoDecision = (d: ServiceTransitionDecision) => !d.ok && !("to" in d) && !("cancellationRequestedAfter" in d);

  // state 1 → 2: requested
  const req = ev(ext(), { type: "CANCEL", reason: "הלקוח ביטל" }, OWNER);
  check("EXTERNAL, not requested + CANCEL with a reason → cancellationRequestedAfter = true", req.ok && req.cancellationRequestedAfter === true);
  check("  …to EXTERNAL, not READY, not DELIVERED, no outcome", req.ok && req.to === "EXTERNAL" && req.outcome === null);
  // Expectation changed by 1.1b (ט-1 A): the reason is kept in decision.texts; the payload only says one was given.
  check("  …event before/after = false/true and the reason kept (texts, not payload)", req.ok && req.event.cancellationRequestedBefore === false && req.event.cancellationRequestedAfter === true && req.texts.cancelReason === "הלקוח ביטל" && req.event.payload.reasonRecorded === true && !("reason" in req.event.payload));
  check("  …no money, stock or delivery effect", req.ok && req.effects.length === 0);
  const noReason = ev(ext(), { type: "CANCEL" }, OWNER);
  check("request without a reason → refused, and no transition decision at all", !noReason.ok && codes(noReason).includes("REASON_REQUIRED") && hasNoDecision(noReason));
  const dup = ev(ext({ cancellationRequested: true }), { type: "CANCEL", reason: "שוב" }, OWNER);
  check("a second request → refused (ALREADY_CANCELLED), no decision", !dup.ok && codes(dup).includes("ALREADY_CANCELLED") && hasNoDecision(dup));

  // state 2 → 3: completed by the documented return
  const requested = ext({ cancellationRequested: true });
  const back = ev(requested, { type: "RETURN_FROM_EXTERNAL", next: "READY" }, OWNER);
  check("requested + return → READY / CANCELLED / cancellationRequestedAfter = false", back.ok && back.to === "READY" && back.outcome === "CANCELLED" && back.cancellationRequestedAfter === false);
  check("  …event external.returned, before/after = true/false, completion documented", back.ok && back.event.type === "external.returned" && back.event.cancellationRequestedBefore === true && back.event.cancellationRequestedAfter === false && back.event.payload.cancellationCompleted === true);
  for (const next of ["IN_REPAIR", "QA"] as const) {
    const d = ev(requested, { type: "RETURN_FROM_EXTERNAL", next }, OWNER);
    check(`requested + return to ${next} → refused, no decision`, !d.ok && codes(d).includes("CANCELLATION_REQUESTED") && hasNoDecision(d));
  }
  for (const outcome of ["REPAIRED", "REPLACED", "NOT_REPAIRED"] as const) {
    const d = ev(requested, { type: "RETURN_FROM_EXTERNAL", next: "READY", outcome, replacementDeviceId: 9 }, OWNER);
    check(`requested + return claiming ${outcome} → refused`, !d.ok && codes(d).includes("OUTCOME_NOT_ALLOWED"));
  }
  const plain = ev(ext({ coverage: { source: "MANUFACTURER", decision: "APPROVED" } }), { type: "RETURN_FROM_EXTERNAL", next: "READY", outcome: "REPAIRED" }, OWNER);
  check("a normal return (no request) is not turned into a cancel", plain.ok && plain.outcome === "REPAIRED" && plain.cancellationRequestedAfter === false && plain.event.payload.cancellationCompleted === undefined);

  // state 3: the normal handover still applies
  const done = ready({ outcome: "CANCELLED" });
  refusedWith("after the completed cancel, delivery still needs the owner's confirmation", ev(done, { type: "DELIVER", receipt: { handoverConfirmed: false, receivedByName: "x" } }, OWNER), "HANDOVER_NOT_CONFIRMED");
  const delivered3 = ev(done, { type: "DELIVER", receipt: RECEIPT }, OWNER);
  check("after the completed cancel, the normal delivery → DELIVERED, request stays false", delivered3.ok && delivered3.to === "DELIVERED" && delivered3.cancellationRequestedAfter === false);

  // carried over, never reset wholesale
  const hold = ev(ctx({ status: "IN_REPAIR" }), { type: "SET_HOLD", reason: "PARTS" }, OWNER);
  check("an unrelated action carries the value over (false → false)", hold.ok && hold.cancellationRequestedAfter === false && hold.event.cancellationRequestedBefore === false);

  // inconsistent input is refused, never silently repaired
  for (const s of ["IN_REPAIR", "READY", "QA", "OPEN"] as ServiceCaseStatus[]) {
    const d = ev(ctx({ status: s, cancellationRequested: true, outcome: s === "READY" ? "REPAIRED" : null }), { type: "CANCEL", reason: "x" }, OWNER);
    check(`cancellationRequested = true while ${s} → INCONSISTENT_CASE_STATE`, !d.ok && codes(d).includes("INCONSISTENT_CASE_STATE") && hasNoDecision(d));
  }
  const closedFlag = ev(ctx({ status: "CLOSED", outcome: "REPAIRED", cancellationRequested: true }), { type: "CLOSE" }, SYSTEM);
  check("a flagged CLOSED case → INCONSISTENT_CASE_STATE (checked before anything else)", !closedFlag.ok && codes(closedFlag).includes("INCONSISTENT_CASE_STATE"));
  const notBool = ev({ ...ext(), cancellationRequested: undefined as unknown as boolean }, { type: "RETURN_FROM_EXTERNAL", next: "IN_REPAIR" }, OWNER);
  check("a missing flag is refused, not read as false", !notBool.ok && codes(notBool).includes("INCONSISTENT_CASE_STATE"));

  // the decision alone is enough to persist the transition
  const frozen = deepFreeze(ext());
  const snap = JSON.stringify(frozen);
  const fd = ev(frozen, { type: "CANCEL", reason: "x" }, OWNER);
  check("frozen input untouched by the request", fd.ok && JSON.stringify(frozen) === snap && frozen.cancellationRequested === false);
  check("decision and event agree on status, outcome and request", fd.ok && fd.event.toStatus === fd.to && fd.event.outcome === fd.outcome && fd.event.cancellationRequestedAfter === fd.cancellationRequestedAfter);
  check("no effect can set the request any more (single source)", fd.ok && !(fd.effects as readonly string[]).includes("MARK_CANCELLATION_REQUESTED"));

  // nothing else moved
  const qp = ev(ctx({ status: "QUOTE_PENDING", currentQuote: sentQuote() }), { type: "CANCEL", reason: "x" }, OWNER);
  check("WITHDRAWN instruction unchanged by the fix", qp.ok && qp.withdrawQuote !== null && qp.effects.includes("WITHDRAW_OPEN_QUOTE") && qp.cancellationRequestedAfter === false);
  refusedWith("debt rule unchanged by the fix", ev(ready({ settlement: { known: true, openBalanceAgorot: 1 } }), { type: "DELIVER", receipt: RECEIPT }, OWNER), "OPEN_BALANCE_NEEDS_OWNER_DECISION");
  allowedTo("quote approval unchanged by the fix", ev(ctx({ status: "QUOTE_PENDING", currentQuote: sentQuote() }), { type: "APPROVE_QUOTE", approval: { version: 1, totalAgorot: 45_000, docHash: "h1", method: "PHONE" } }, OWNER), "IN_REPAIR");
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
  {
    // Owner decision 3 (1.3a): the owner may schedule and make the visit with no technician assigned.
    const own = ev(f({ staffMemberId: null }), { type: "SCHEDULE", appointmentId: 11 }, OWNER);
    allowedTo("an on-site visit with no technician → the owner makes it", own, "SCHEDULED");
    check("  …marked as handled by the owner", own.ok && own.event.payload.handledByOwner === true);
    allowedTo("on-site check-in with no technician → the owner", ev(f({ status: "SCHEDULED", staffMemberId: null }), { type: "CHECK_IN", intakeConfirmed: true }, OWNER), "CHECKED_IN");
  }
  allowedTo("technician on site → CHECKED_IN without a shop intake", ev(f({ status: "SCHEDULED" }), { type: "CHECK_IN", intakeConfirmed: true }, OWNER), "CHECKED_IN");
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
console.log("  4.13 free-text reasons live in decision.texts, never in the payload (1.1b, ט-1 A)");
{
  const NO_TEXTS = { cancelReason: null, abandonReason: null, debtOverrideReason: null, loanerOverrideReason: null };
  const sameTexts = (d: ServiceTransitionDecision, t: Partial<typeof NO_TEXTS>) =>
    d.ok && JSON.stringify(d.texts) === JSON.stringify({ ...NO_TEXTS, ...t });
  const noFreeTextIn = (d: ServiceTransitionDecision, text: string) => d.ok && !JSON.stringify(d.event).includes(text);

  // cancel, held item
  const c1 = ev(ctx({ status: "IN_REPAIR" }), { type: "CANCEL", reason: "  הלקוח החליט לוותר  " }, OWNER);
  check("cancel with a reason → texts.cancelReason (trimmed), the other three null", sameTexts(c1, { cancelReason: "הלקוח החליט לוותר" }));
  check("  …payload: reasonRecorded true, no reason key, no text anywhere in the event", c1.ok && c1.event.payload.reasonRecorded === true && !("reason" in c1.event.payload) && noFreeTextIn(c1, "הלקוח החליט"));
  // cancel at the supplier
  const c2 = ev(ctx({ status: "EXTERNAL", currentQuote: approvedQuote() }), { type: "CANCEL", reason: "ביטול אצל היבואן" }, OWNER);
  check("cancel request at the supplier → same texts.cancelReason, request true", sameTexts(c2, { cancelReason: "ביטול אצל היבואן" }) && c2.ok && c2.cancellationRequestedAfter === true && noFreeTextIn(c2, "היבואן"));
  const c3 = ev(ctx({ status: "EXTERNAL", cancellationRequested: true }), { type: "RETURN_FROM_EXTERNAL", next: "READY" }, OWNER);
  check("the return that completes it carries no new reason (one source: the request's)", sameTexts(c3, {}) && c3.ok && c3.outcome === "CANCELLED");
  const c4 = ev(ctx({ status: "EXTERNAL", cancellationRequested: true }), { type: "CANCEL", reason: "שוב" }, OWNER);
  check("a repeated request → refused, and a refusal carries no texts", !c4.ok && codes(c4).includes("ALREADY_CANCELLED") && !("texts" in c4));
  // nothing held: reason optional
  const c5 = ev(ctx({ status: "OPEN" }), { type: "CANCEL" }, OWNER);
  check("cancel with nothing held and no reason → cancelReason null, reasonRecorded false", sameTexts(c5, {}) && c5.ok && c5.event.payload.reasonRecorded === false);
  // abandon
  const a1 = ev(ready({ pickupRemindersSent: 2 }), { type: "ABANDON", reason: "לא נאסף אחרי שתי תזכורות" }, OWNER);
  check("not collected → texts.abandonReason, payload reasonRecorded only", sameTexts(a1, { abandonReason: "לא נאסף אחרי שתי תזכורות" }) && a1.ok && a1.event.payload.reasonRecorded === true && noFreeTextIn(a1, "תזכורות"));
  refusedWith("not collected without a reason", ev(ready({ pickupRemindersSent: 2 }), { type: "ABANDON", reason: "" }, OWNER), "REASON_REQUIRED");
  // delivery with debt / loaner
  const d1 = ev(ready({ settlement: { known: true, openBalanceAgorot: 9_000 } }), { type: "DELIVER", receipt: RECEIPT, debtOverride: { reason: "ישלם בהעברה מחר" } }, OWNER);
  check("delivery with debt → texts.debtOverrideReason, payload debtOverride true", sameTexts(d1, { debtOverrideReason: "ישלם בהעברה מחר" }) && d1.ok && d1.event.payload.debtOverride === true && noFreeTextIn(d1, "בהעברה"));
  const d2 = ev(ready({ openLoaner: true }), { type: "DELIVER", receipt: RECEIPT, loanerOverride: { reason: "יחזיר את החלופי ביום שני" } }, OWNER);
  check("delivery with the loaner out → texts.loanerOverrideReason, payload loanerOverride true", sameTexts(d2, { loanerOverrideReason: "יחזיר את החלופי ביום שני" }) && d2.ok && d2.event.payload.loanerOverride === true && !("debtOverride" in d2.event.payload));
  const d3 = ev(ready({ openLoaner: true, settlement: { known: true, openBalanceAgorot: 1 } }), { type: "DELIVER", receipt: RECEIPT, debtOverride: { reason: "חוב" }, loanerOverride: { reason: "חלופי" } }, OWNER);
  check("both overrides → both texts", sameTexts(d3, { debtOverrideReason: "חוב", loanerOverrideReason: "חלופי" }));
  const d4 = ev(ready(), { type: "DELIVER", receipt: RECEIPT }, OWNER);
  check("a paid-up delivery → four nulls, no override flags", sameTexts(d4, {}) && d4.ok && !("debtOverride" in d4.event.payload) && !("loanerOverride" in d4.event.payload));
  refusedWith("debt override with blank reason", ev(ready({ settlement: { known: true, openBalanceAgorot: 1 } }), { type: "DELIVER", receipt: RECEIPT, debtOverride: { reason: " \t " } }, OWNER), "OVERRIDE_REASON_REQUIRED");
  refusedWith("held-item cancel with a blank reason", ev(ctx({ status: "QA" }), { type: "CANCEL", reason: "   " }, OWNER), "REASON_REQUIRED");
  refusedWith("held-item cancel with Unicode spaces only (NBSP, tab, newline)", ev(ctx({ status: "QA" }), { type: "CANCEL", reason: " \t\n " }, OWNER), "REASON_REQUIRED");
  check("an unrelated decision → four nulls", sameTexts(ev(ctx({ status: "CHECKED_IN" }), { type: "START_DIAGNOSIS" }, OWNER), {}));

  // length: code points, after trim, 1000 allowed, 1001 refused — never truncated
  const heb1000 = "א".repeat(SERVICE_REASON_MAX_LENGTH);
  const heb1001 = "א".repeat(SERVICE_REASON_MAX_LENGTH + 1);
  const emoji1000 = "🔧".repeat(SERVICE_REASON_MAX_LENGTH); // 2000 UTF-16 units, 1000 code points
  const emoji1001 = "🔧".repeat(SERVICE_REASON_MAX_LENGTH + 1);
  check("SERVICE_REASON_MAX_LENGTH = 1000", SERVICE_REASON_MAX_LENGTH === 1000);
  check("length counts code points, not UTF-16 units", reasonLength("🔧") === 1 && reasonLength(emoji1000) === 1000 && emoji1000.length === 2000);
  const cases: [string, (r: string) => ServiceTransitionDecision][] = [
    ["cancel", (r) => ev(ctx({ status: "IN_REPAIR" }), { type: "CANCEL", reason: r }, OWNER)],
    ["abandon", (r) => ev(ready({ pickupRemindersSent: 1 }), { type: "ABANDON", reason: r }, OWNER)],
    ["debt override", (r) => ev(ready({ settlement: { known: true, openBalanceAgorot: 1 } }), { type: "DELIVER", receipt: RECEIPT, debtOverride: { reason: r } }, OWNER)],
    ["loaner override", (r) => ev(ready({ openLoaner: true }), { type: "DELIVER", receipt: RECEIPT, loanerOverride: { reason: r } }, OWNER)],
  ];
  for (const [name, run] of cases) {
    const at = run(heb1000);
    check(`${name}: 1000 Hebrew characters accepted, unchanged`, at.ok && Object.values(at.texts).includes(heb1000));
    const over = run(heb1001);
    check(`${name}: 1001 characters → REASON_TOO_LONG, not truncated`, !over.ok && codes(over).includes("REASON_TOO_LONG"));
    check(`${name}: the refusal never echoes the text`, !over.ok && over.violations.every((v) => !v.detail.includes("אאא")));
    check(`${name}: 1000 emoji (2000 UTF-16 units) accepted`, run(emoji1000).ok);
    check(`${name}: 1001 emoji → REASON_TOO_LONG`, !run(emoji1001).ok);
    check(`${name}: surrounding spaces do not count (trim first)`, run(`  ${heb1000}  `).ok);
  }

  // cancel that withdraws a quote names the version
  const w1 = ev(ctx({ status: "QUOTE_PENDING", currentQuote: sentQuote(4, 80_000, "h4") }), { type: "CANCEL", reason: "x" }, OWNER);
  check("cancel withdrawing a quote → payload.withdrawnQuoteVersion = 4", w1.ok && w1.event.payload.withdrawnQuoteVersion === 4 && w1.withdrawQuote?.version === 4);
  const w2 = ev(ctx({ status: "IN_REPAIR", currentQuote: approvedQuote(2) }), { type: "CANCEL", reason: "x" }, OWNER);
  check("cancel with no open quote → no withdrawnQuoteVersion", w2.ok && !("withdrawnQuoteVersion" in w2.event.payload));
}

console.log("  4.14 REVISE_QUOTE — a pending quote replaced by the next version (1.1b, ז-1 A)");
{
  const pending = (q: ServiceQuoteSnapshot, o: Partial<ServiceCaseContext> = {}) => ctx({ status: "QUOTE_PENDING", currentQuote: q, ...o });
  const revise = (from: number, to: number, total = 39_000, hash = `h${to}`) =>
    ({ type: "REVISE_QUOTE", replaces: { version: from }, quote: { version: to, totalAgorot: total, docHash: hash } }) as ServiceCaseAction;

  const r12 = ev(pending(sentQuote(1, 45_000, "h1")), revise(1, 2, 39_000, "h2"), OWNER);
  check("v1 → v2: allowed, the case stays QUOTE_PENDING, no status change", r12.ok && r12.to === "QUOTE_PENDING" && !r12.statusChanged && r12.outcome === null);
  check("  …effect SUPERSEDE_OPEN_QUOTE only; no withdrawal", r12.ok && r12.effects.length === 1 && r12.effects[0] === "SUPERSEDE_OPEN_QUOTE" && r12.withdrawQuote === null);
  check("  …supersedeQuote names old v1 (its own total + hash) and new v2", r12.ok && JSON.stringify(r12.supersedeQuote) === JSON.stringify({ superseded: { version: 1, totalAgorot: 45_000, docHash: "h1" }, next: { version: 2, totalAgorot: 39_000, docHash: "h2" } }));
  check("  …event quote.revised with supersededQuoteVersion 1, quoteVersion 2, total", r12.ok && r12.event.type === "quote.revised" && r12.event.payload.supersededQuoteVersion === 1 && r12.event.payload.quoteVersion === 2 && r12.event.payload.totalAgorot === 39_000);
  check("  …the new document must be checked like any sent quote", r12.ok && r12.serverChecks.includes("QUOTE_DOCUMENT_MATCHES_HASH"));
  const r23 = ev(pending(sentQuote(2, 39_000, "h2")), revise(2, 3, 36_000), OWNER);
  check("v2 → v3: allowed the same way", r23.ok && r23.supersedeQuote?.superseded.version === 2 && r23.supersedeQuote?.next.version === 3);

  // the replaced version, as the service will persist it
  const old = deepFreeze(sentQuote(1, 45_000, "h1"));
  const s = supersedeQuote(old, { version: 1, totalAgorot: 45_000, docHash: "h1" });
  check("supersedeQuote(v1) → SUPERSEDED, version / total / hash kept, input untouched", s.ok && s.quote.state === "SUPERSEDED" && s.quote.version === 1 && s.quote.totalAgorot === 45_000 && s.quote.docHash === "h1" && old.state === "SENT");
  const s2 = s.ok ? supersedeQuote(s.quote, { version: 1, totalAgorot: 45_000, docHash: "h1" }) : null;
  check("superseding twice → QUOTE_SUPERSEDED", s2 !== null && !s2.ok && s2.violations[0].code === "QUOTE_SUPERSEDED");
  check("withdrawing a superseded version → QUOTE_SUPERSEDED", (() => { const w = s.ok ? withdrawQuote(s.quote, { version: 1, totalAgorot: 45_000, docHash: "h1" }) : null; return w !== null && !w.ok && w.violations[0].code === "QUOTE_SUPERSEDED"; })());

  // refusals
  refusedWith("new version skips one (1 → 3)", ev(pending(sentQuote(1)), revise(1, 3), OWNER), "QUOTE_VERSION_NOT_NEXT");
  refusedWith("new version equals the current (1 → 1)", ev(pending(sentQuote(1)), revise(1, 1), OWNER), "QUOTE_VERSION_NOT_NEXT");
  refusedWith("revising an old version instead of the current", ev(pending(sentQuote(2)), revise(1, 3), OWNER), "QUOTE_VERSION_MISMATCH");
  refusedWith("no current quote", ev(ctx({ status: "QUOTE_PENDING", currentQuote: null }), revise(1, 2), OWNER), "QUOTE_NOT_AWAITING_DECISION");
  refusedWith("current quote already APPROVED", ev(pending(approvedQuote(1)), revise(1, 2), OWNER), "QUOTE_NOT_AWAITING_DECISION");
  refusedWith("current quote REJECTED", ev(pending({ ...sentQuote(1), state: "REJECTED" }), revise(1, 2), OWNER), "QUOTE_NOT_AWAITING_DECISION");
  refusedWith("current quote WITHDRAWN", ev(pending({ ...sentQuote(1), state: "WITHDRAWN" }), revise(1, 2), OWNER), "QUOTE_WITHDRAWN");
  refusedWith("current quote SUPERSEDED", ev(pending({ ...sentQuote(1), state: "SUPERSEDED" }), revise(1, 2), OWNER), "QUOTE_SUPERSEDED");
  refusedWith("case not QUOTE_PENDING (DIAGNOSING)", ev(ctx({ status: "DIAGNOSING", currentQuote: sentQuote(1) }), revise(1, 2), OWNER), "INVALID_TRANSITION");
  refusedWith("case not QUOTE_PENDING (IN_REPAIR)", ev(ctx({ status: "IN_REPAIR", currentQuote: approvedQuote(1) }), revise(1, 2), OWNER), "INVALID_TRANSITION");
  refusedWith("negative total", ev(pending(sentQuote(1)), revise(1, 2, -1), OWNER), "INVALID_INPUT");
  refusedWith("fractional total", ev(pending(sentQuote(1)), revise(1, 2, 10.5), OWNER), "INVALID_INPUT");
  refusedWith("empty document hash", ev(pending(sentQuote(1)), revise(1, 2, 1000, ""), OWNER), "INVALID_INPUT");
  refusedWith("₪0 revision without a cover", ev(pending(sentQuote(1)), revise(1, 2, 0), OWNER), "QUOTE_TOTAL_REQUIRES_COVERAGE");
  allowedTo("₪0 revision under an approved cover", ev(pending(sentQuote(1), { coverage: covered }), revise(1, 2, 0), OWNER), "QUOTE_PENDING");
  refusedWith("the customer link may not revise", ev(pending(sentQuote(1)), revise(1, 2), CUSTOMER), "ACTOR_NOT_ALLOWED");
  refusedWith("the system may not revise", ev(pending(sentQuote(1)), revise(1, 2), SYSTEM), "ACTOR_NOT_ALLOWED");
  check("a revision never yields two current quotes: one superseded, exactly the next one SENT", r12.ok && r12.supersedeQuote !== null && r12.supersedeQuote.next.version === r12.supersedeQuote.superseded.version + 1 && r12.withdrawQuote === null);

  // approval after a revision
  const afterRevise = pending(sentQuote(2, 39_000, "h2"));
  refusedWith("approving the old v1 after the revision", ev(afterRevise, { type: "APPROVE_QUOTE", approval: { version: 1, totalAgorot: 45_000, docHash: "h1", method: "PHONE" } }, OWNER), "APPROVAL_MISMATCH");
  allowedTo("approving the current v2 still works", ev(afterRevise, { type: "APPROVE_QUOTE", approval: { version: 2, totalAgorot: 39_000, docHash: "h2", method: "LINK" } }, CUSTOMER), "IN_REPAIR");
  refusedWith("approving a SUPERSEDED quote", ev(pending({ ...sentQuote(1), state: "SUPERSEDED" }), { type: "APPROVE_QUOTE", approval: { version: 1, totalAgorot: 45_000, docHash: "h1", method: "PHONE" } }, OWNER), "QUOTE_SUPERSEDED");
  refusedWith("rejecting a SUPERSEDED quote", ev(pending({ ...sentQuote(1), state: "SUPERSEDED" }), { type: "REJECT_QUOTE", version: 1 }, CUSTOMER), "QUOTE_SUPERSEDED");
  refusedWith("approving a WITHDRAWN quote (unchanged)", ev(pending({ ...sentQuote(1), state: "WITHDRAWN" }), { type: "APPROVE_QUOTE", approval: { version: 1, totalAgorot: 45_000, docHash: "h1", method: "PHONE" } }, OWNER), "QUOTE_WITHDRAWN");
  check("a SUPERSEDED quote authorises no repair", !isRepairAuthorized(pending({ ...approvedQuote(1), state: "SUPERSEDED" })));
  const cancelAfter = ev(afterRevise, { type: "CANCEL", reason: "x" }, OWNER);
  check("cancel after a revision withdraws the current v2 (WITHDRAWN ≠ SUPERSEDED)", cancelAfter.ok && cancelAfter.withdrawQuote?.version === 2 && cancelAfter.event.payload.withdrawnQuoteVersion === 2 && cancelAfter.supersedeQuote === null);
  const frozenCase = deepFreeze(pending(sentQuote(1)));
  const snap = JSON.stringify(frozenCase);
  const fr = ev(frozenCase, revise(1, 2), OWNER);
  check("a revision mutates nothing it is given", fr.ok && JSON.stringify(frozenCase) === snap);
}

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
  const cmd = { caseId: 12, action: { type: "CHECK_IN", intakeConfirmed: true } as ServiceCaseAction, expectedVersion: 7, idempotencyKey: "0192f4b2-7c1e-7a3b-9f00-1a2b3c4d5e6f" };
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
  const r1 = evaluateRepeatCase({ parent: { status: "CLOSED", outcome: "REPAIRED", deliveredOn: "2026-10-01" }, openedOn: "2026-11-03", parentWarrantyEndsOn: "2026-10-31" });
  const r2 = evaluateRepeatCase({ parent: { status: "CLOSED", outcome: "REPAIRED", deliveredOn: "2026-10-01" }, openedOn: "2026-11-03", parentWarrantyEndsOn: "2026-10-31" });
  check("repeat evaluation is deterministic (no clock)", JSON.stringify(r1) === JSON.stringify(r2) && r1.ok && !r1.withinRepairWarranty);

  const dir = path.join(process.cwd(), "lib/services/service-desk");
  // Expectation changed by M1: the core also reads the two pure track modules, which are held to the same rule here.
  const PURE_SIBLINGS = ["./contracts", "./tracks.core", "./service-profiles"];
  for (const f of ["service-case.core.ts", "contracts.ts", "tracks.core.ts", "service-profiles.ts"]) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    check(`${f} imports only the pure siblings (${PURE_SIBLINGS.join(", ")})`, imports.every((i) => PURE_SIBLINGS.includes(i)), imports.join(","));
    const impure = /Date\.now|new Date\(\)|Math\.random|process\.env|fetch\(|prisma|setTimeout|crypto/.exec(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""));
    check(`${f} uses no clock, randomness, env, network or database`, impure === null, impure?.[0] ?? "");
  }
  check("itemHeldByBusiness: IN_SHOP holds from CHECKED_IN, FIELD never", itemHeldByBusiness("IN_SHOP", "CHECKED_IN") && !itemHeldByBusiness("IN_SHOP", "OPEN") && !itemHeldByBusiness("IN_SHOP", "EXTERNAL") && !itemHeldByBusiness("FIELD", "IN_REPAIR"));
}

// ── 7b. Opening a case (1.1c) ──────────────────────────────────────────────────────────────────────────────
console.log("— 7b. opening a case: OPEN, version 1, one case.opened at seq 1");
type OpenOk = Extract<ServiceCaseOpenDecision, { ok: true }>;
const OPEN_OK: OpenOk[] = [];
const op = (input: ServiceCaseOpenInput, actor: ServiceCaseActor): ServiceCaseOpenDecision => {
  const d = openServiceCase(input, actor);
  if (d.ok) OPEN_OK.push(d);
  return d;
};
const OPEN_INPUT: ServiceCaseOpenInput = { kind: "IN_SHOP", customerId: 41, deviceId: 7, parentCaseId: null };
{
  const d = op(OPEN_INPUT, OWNER);
  check("the owner opens a case: status OPEN, version 1, seq 1", d.ok && d.status === "OPEN" && d.version === 1 && d.seq === 1 && SERVICE_CASE_INITIAL_VERSION === 1 && SERVICE_CASE_OPENING_SEQ === 1);
  check("  …no hold, no outcome, no cancel request", d.ok && d.holdReason === null && d.outcome === null && d.cancellationRequested === false);
  check("  …event case.opened / action OPEN", d.ok && d.event.type === "case.opened" && d.event.action === "OPEN");
  check("  …creation is explicit: fromStatus null (not OPEN → OPEN), toStatus OPEN", d.ok && d.event.fromStatus === null && d.event.toStatus === "OPEN");
  check("  …hold before/after null, cancel request before/after false, no outcome", d.ok && d.event.holdReasonBefore === null && d.event.holdReasonAfter === null && d.event.cancellationRequestedBefore === false && d.event.cancellationRequestedAfter === false && d.event.outcome === null);
  check("  …payload = kind + ids only", d.ok && JSON.stringify(Object.keys(d.event.payload).sort()) === JSON.stringify(["customerId", "deviceId", "kind", "parentCaseId"]) && d.event.payload.kind === "IN_SHOP" && d.event.payload.customerId === 41 && d.event.payload.deviceId === 7 && d.event.payload.parentCaseId === null);
  check("  …server checks: customer, device (no parent named)", d.ok && JSON.stringify(d.serverChecks) === JSON.stringify(["CUSTOMER_BELONGS_TO_BUSINESS", "DEVICE_BELONGS_TO_CUSTOMER"]));
  const noDevice = op({ kind: "FIELD", customerId: 41, deviceId: null, parentCaseId: null }, OWNER);
  check("no device yet → only the customer check, deviceId null in the payload", noDevice.ok && JSON.stringify(noDevice.serverChecks) === JSON.stringify(["CUSTOMER_BELONGS_TO_BUSINESS"]) && noDevice.event.payload.deviceId === null);
  const repeat = op({ kind: "IN_SHOP", customerId: 41, deviceId: 7, parentCaseId: 300 }, OWNER);
  check("a repeat repair names its parent → PARENT_CASE_BELONGS_TO_BUSINESS", repeat.ok && repeat.serverChecks.includes("PARENT_CASE_BELONGS_TO_BUSINESS") && repeat.event.payload.parentCaseId === 300);
  for (const kind of SERVICE_CASE_KINDS) {
    // M1: REMOTE exists only with a track (T6 here); every other kind opens with or without one.
    const k = op({ ...OPEN_INPUT, kind, ...(kind === "REMOTE" ? { track: "T6" as const } : {}) }, OWNER);
    check(`${kind}: opens at OPEN / version 1 / seq 1`, k.ok && k.status === "OPEN" && k.version === 1 && k.seq === 1 && k.event.payload.kind === kind);
  }
  {
    const noTrack = op({ ...OPEN_INPUT, kind: "REMOTE" }, OWNER);
    check("M1: REMOTE without a track → TRACK_REQUIRED", !noTrack.ok && noTrack.violations.some((v) => v.code === "TRACK_REQUIRED"));
    const withTrack = op({ ...OPEN_INPUT, kind: "FIELD", track: "T3" }, OWNER);
    check("M1: a track case's opening event names its track (a token)", withTrack.ok && withTrack.event.payload.track === "T3");
    const badTrack = op({ ...OPEN_INPUT, track: "T9" as never }, OWNER);
    check("M1: an unknown track → INVALID_INPUT", !badTrack.ok && badTrack.violations.some((v) => v.code === "INVALID_INPUT"));
  }

  // who may open
  const openCodes = (x: ServiceCaseOpenDecision) => (x.ok ? [] : x.violations.map((v) => v.code));
  check("the customer link may not open a case", openCodes(op(OPEN_INPUT, CUSTOMER)).includes("ACTOR_NOT_ALLOWED"));
  check("the system may not open a case", openCodes(op(OPEN_INPUT, SYSTEM)).includes("ACTOR_NOT_ALLOWED"));
  check("an owner without a user id may not open a case", openCodes(op(OPEN_INPUT, { kind: "OWNER", userId: 0 })).includes("ACTOR_NOT_ALLOWED"));
  // input shape
  const bad = (name: string, input: unknown) => {
    const x = op(input as ServiceCaseOpenInput, OWNER);
    check(name, !x.ok && openCodes(x).includes("INVALID_INPUT"), x.ok ? "opened" : openCodes(x).join(","));
  };
  bad("unknown kind → INVALID_INPUT", { ...OPEN_INPUT, kind: "AIRBORNE" }); // M1: REMOTE is a kind now
  bad("no customer → INVALID_INPUT", { ...OPEN_INPUT, customerId: 0 });
  bad("deviceId must be an id or an explicit null", { ...OPEN_INPUT, deviceId: undefined });
  bad("fractional deviceId → INVALID_INPUT", { ...OPEN_INPUT, deviceId: 1.5 });
  bad("negative parentCaseId → INVALID_INPUT", { ...OPEN_INPUT, parentCaseId: -1 });
  const refusedOpen = op({ ...OPEN_INPUT, customerId: -3, deviceId: 0 }, CUSTOMER);
  check("a refused opening has no event, status or version", !refusedOpen.ok && !("event" in refusedOpen) && !("status" in refusedOpen) && !("version" in refusedOpen) && refusedOpen.violations.length === 3);

  // no second opening: OPEN never applies to an existing case, from any status, of any kind
  let refusedEverywhere = true;
  for (const kind of SERVICE_CASE_KINDS) {
    for (const status of SERVICE_CASE_STATUSES) {
      const x = evaluateTransition(ctx({ kind, status }), { type: "OPEN" } as unknown as ServiceCaseAction, OWNER);
      if (x.ok || !codes(x).includes("INVALID_TRANSITION")) refusedEverywhere = false;
    }
  }
  check("OPEN on an existing case is refused (INVALID_TRANSITION) — every status × every kind", refusedEverywhere);
  check("OPEN is not a transition: absent from ACTION_FROM, which keeps its 23 actions (M1: +3)", !("OPEN" in ACTION_FROM) && Object.keys(ACTION_FROM).length === 23);
  check("no transition decision of this file is an opening event", OK_DECISIONS.length >= 200 && OK_DECISIONS.every((x) => (x.event.type as string) !== "case.opened" && (x.event.action as string) !== "OPEN" && x.event.fromStatus !== null));

  // the journal: one case.opened at seq 1, then seq = the version each transition sets
  if (d.ok) {
    type Row = { seq: number; type: string };
    const journal: Row[] = [{ seq: d.seq, type: d.event.type }];
    let c = ctx({ status: d.status, version: d.version });
    const steps: ServiceCaseAction[] = [{ type: "CHECK_IN", intakeConfirmed: true }, { type: "START_DIAGNOSIS" }, { type: "MARK_NOT_REPAIRABLE" }, { type: "DELIVER", receipt: RECEIPT }, { type: "CLOSE" }];
    let chainOk = true;
    for (const a of steps) {
      const t = ev(c, a, OWNER);
      if (!t.ok) {
        chainOk = false;
        break;
      }
      const version = c.version + 1;
      journal.push({ seq: version, type: t.event.type });
      c = { ...c, status: t.to, outcome: t.outcome, holdReason: t.holdReason, version };
    }
    check("a full life after opening: every step allowed", chainOk && c.status === "CLOSED");
    check("  …seq runs 1, 2, 3 … with no gap and equals the case version", journal.length === 6 && journal.every((r, i) => r.seq === i + 1) && journal[journal.length - 1].seq === c.version);
    check("  …exactly one case.opened, and it is seq 1", journal.filter((r) => r.type === "case.opened").length === 1 && journal[0].type === "case.opened");
    const reopen = evaluateTransition(c, { type: "OPEN" } as unknown as ServiceCaseAction, OWNER);
    check("  …the closed case cannot be opened again", !reopen.ok);
    const first = ev(ctx({ status: "OPEN", version: 1 }), { type: "SCHEDULE", appointmentId: 9 }, OWNER);
    check("the first transition from a freshly opened case is a transition, not an opening", first.ok && first.event.type === "case.scheduled" && first.event.fromStatus === "OPEN");
  }

  // purity of the opening judgment
  const frozenIn = deepFreeze<ServiceCaseOpenInput>({ ...OPEN_INPUT });
  const frozenActor = deepFreeze<ServiceCaseActor>({ kind: "OWNER", userId: 70 });
  let threw = false;
  let o1: ServiceCaseOpenDecision | null = null;
  let o2: ServiceCaseOpenDecision | null = null;
  try {
    o1 = op(frozenIn, frozenActor);
    o2 = op(frozenIn, frozenActor);
  } catch {
    threw = true;
  }
  check("opening: frozen inputs accepted, same input → same output", !threw && o1 !== null && o2 !== null && JSON.stringify(o1) === JSON.stringify(o2));
  check("opening: event, actor and payload are fresh objects", o1 !== null && o2 !== null && o1.ok && o2.ok && o1.event !== o2.event && o1.event.payload !== o2.event.payload && o1.event.actor !== frozenActor);
}

// ── 8. Journal payload rule over EVERY decision this file produced (1.1b) ───────────────────────────────────
console.log("— 8. payload sweep: every ok decision of every section above");
{
  // The journal CHECK of the appointments template: strings are short tokens; at most 4096 bytes of jsonb text.
  const TOKEN = /^[A-Za-z0-9_:.-]{0,64}$/;
  const problemsOf = (p: unknown): string[] => {
    const out: string[] = [];
    if (p === null || typeof p !== "object" || Array.isArray(p)) return ["payload is not a plain object"];
    for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
      if (!TOKEN.test(k)) out.push(`key ${k}`);
      if (v === null || typeof v === "boolean") continue;
      if (typeof v === "number") {
        if (!Number.isFinite(v)) out.push(`${k}: non-finite number`);
        continue;
      }
      if (typeof v === "string") {
        if (!TOKEN.test(v)) out.push(`${k}: free text`);
        continue;
      }
      out.push(`${k}: ${Array.isArray(v) ? "array" : typeof v} (only scalars allowed)`);
    }
    // jsonb::text writes ", " and ": " — at most two more bytes per key than compact JSON.
    const bytes = Buffer.byteLength(JSON.stringify(p), "utf8") + 2 * Object.keys(p as object).length;
    if (bytes > 4096) out.push(`payload ${bytes} bytes > 4096`);
    return out;
  };
  const failing = OK_DECISIONS.map((d) => ({ d, problems: problemsOf(d.event.payload) })).filter((x) => x.problems.length > 0);
  check(`all ${OK_DECISIONS.length} ok decisions: payload = tokens / numbers / booleans / nulls within 4096 bytes`, OK_DECISIONS.length >= 200 && failing.length === 0, failing.slice(0, 3).map((x) => `${x.d.action}: ${x.problems.join("; ")}`).join(" | "));
  const actionsSeen = new Set(OK_DECISIONS.map((d) => d.action));
  check("the sweep saw an ok decision of all 23 actions", actionsSeen.size === 23, [...Object.keys(ACTION_FROM)].filter((a) => !actionsSeen.has(a as ServiceCaseActionType)).join(","));
  const textKeys = ["cancelReason", "abandonReason", "debtOverrideReason", "loanerOverrideReason"];
  check("every ok decision carries the four texts, each string or null", OK_DECISIONS.every((d) => JSON.stringify(Object.keys(d.texts).sort()) === JSON.stringify([...textKeys].sort()) && Object.values(d.texts).every((t) => t === null || typeof t === "string")));
  check("no text of any decision appears anywhere in its event", OK_DECISIONS.every((d) => Object.values(d.texts).every((t) => t === null || !JSON.stringify(d.event).includes(t))));
  check("a reason text exists only on the actions that carry one", OK_DECISIONS.every((d) => (d.texts.cancelReason === null || d.action === "CANCEL") && (d.texts.abandonReason === null || d.action === "ABANDON") && (d.texts.debtOverrideReason === null || d.action === "DELIVER" || d.action === "COMPLETE") && (d.texts.loanerOverrideReason === null || d.action === "DELIVER")));
  check("no refusal carries texts or a transition", REFUSED_DECISIONS.every((d) => !("texts" in d) && !("to" in d)));
  // 1.1c: the opening events obey the same journal rule
  const openFailing = OPEN_OK.map((d) => problemsOf(d.event.payload)).filter((p) => p.length > 0);
  check(`all ${OPEN_OK.length} opening events: payload = tokens / numbers / nulls within 4096 bytes`, OPEN_OK.length >= 8 && openFailing.length === 0, openFailing.slice(0, 2).flat().join(" | "));
  // the detector itself must catch a free-text regression
  check("the detector flags free text, nested objects and oversize payloads", problemsOf({ reason: "הלקוח ביטל" }).length === 1 && problemsOf({ a: { b: 1 } }).length === 1 && problemsOf({ x: "a".repeat(64), y: "b".repeat(65) }).length === 1);
}

console.log(`\n${total - failures} passed, ${failures} failed, ${total} checks`);
if (failures > 0) process.exit(1);
