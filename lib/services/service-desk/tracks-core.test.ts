/**
 * Service Desk M1 — the case machine on the seven tracks (T1–T7), pure. Run:
 *   node node_modules/tsx/dist/cli.mjs lib/services/service-desk/tracks-core.test.ts
 *
 * Every track is walked end to end through evaluateTransition with facts built by buildTrackFacts from a REAL profile
 * snapshot (buildProfileSnapshot), exactly as the service builds them. Then the M1 actions' edges: COMPLETE (owner
 * confirmation, place, credit note, balance), CHANGE_DETAILS (D3 blockers, D12, D13, D16, T7), RESCHEDULE, and the
 * regression that a case without a track keeps today's rules.
 */
import { evaluateTransition, openServiceCase } from "./service-case.core";
import { buildTrackFacts, decideAfterSale, planTrackOpening } from "./tracks.core";
import { buildProfileSnapshot, type ProfileSnapshot, type ServiceProfileKey } from "./service-profiles";
import type {
  ServiceCaseAction,
  ServiceCaseActor,
  ServiceCaseContext,
  ServiceCaseStatus,
  ServiceCaseViolationCode,
  ServiceTrackFacts,
  ServiceTransitionDecision,
} from "./contracts";

let total = 0;
let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  total += 1;
  if (cond) console.log(`  [PASS] ${name}`);
  else {
    failures += 1;
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const codes = (d: ServiceTransitionDecision): ServiceCaseViolationCode[] => (d.ok ? [] : d.violations.map((v) => v.code));
const refused = (name: string, d: ServiceTransitionDecision, code: ServiceCaseViolationCode) =>
  check(name, !d.ok && codes(d).includes(code), d.ok ? `allowed → ${d.to}` : codes(d).join(","));
const allowed = (name: string, d: ServiceTransitionDecision, to: ServiceCaseStatus) =>
  check(name, d.ok && d.to === to, d.ok ? `→ ${d.to}` : codes(d).join(","));

const OWNER: ServiceCaseActor = { kind: "OWNER", userId: 70 };
const CUSTOMER: ServiceCaseActor = { kind: "CUSTOMER_LINK" };

function snap(key: ServiceProfileKey): ProfileSnapshot {
  const r = buildProfileSnapshot(key);
  if (!r.ok) throw new Error(`snapshot ${key}`);
  return r.snapshot;
}
type FactsOver = Partial<Parameters<typeof buildTrackFacts>[0]>;
function facts(base: Parameters<typeof buildTrackFacts>[0], over: FactsOver = {}): ServiceTrackFacts {
  return buildTrackFacts({ ...base, ...over });
}
const BASE = { afterSaleResolution: null, siteAddressSet: false, moneyCommitment: false, creditDocumentLinked: false };
const T1 = { snapshot: snap("device_lab"), kind: "IN_SHOP" as const, workType: "REPAIR" as const, serviceLocation: "AT_BUSINESS" as const, subjectKind: "ITEM" as const, ...BASE };
const T2 = { snapshot: snap("garage"), kind: "IN_SHOP" as const, workType: "REPAIR" as const, serviceLocation: "AT_BUSINESS" as const, subjectKind: "VEHICLE" as const, ...BASE };
const T3 = { snapshot: snap("home_technician"), kind: "FIELD" as const, workType: "REPAIR" as const, serviceLocation: "AT_CUSTOMER" as const, subjectKind: "SYSTEM" as const, ...BASE, siteAddressSet: true };
const T4 = { snapshot: snap("installer"), kind: "FIELD" as const, workType: "INSTALLATION" as const, serviceLocation: "FIELD_SITE" as const, subjectKind: "SYSTEM" as const, ...BASE, siteAddressSet: true };
const T5 = { snapshot: snap("professional"), kind: "IN_SHOP" as const, workType: "PROFESSIONAL" as const, serviceLocation: "AT_BUSINESS" as const, subjectKind: "NONE" as const, ...BASE };
const T6 = { snapshot: snap("remote_it"), kind: "REMOTE" as const, workType: "REMOTE_SUPPORT" as const, serviceLocation: "REMOTE" as const, subjectKind: "NONE" as const, ...BASE };
const T7 = { snapshot: snap("device_lab"), kind: "IN_SHOP" as const, workType: "AFTER_SALE" as const, serviceLocation: "AT_BUSINESS" as const, subjectKind: "ITEM" as const, ...BASE };

function ctx(o: Partial<ServiceCaseContext> = {}): ServiceCaseContext {
  return {
    kind: "IN_SHOP",
    status: "OPEN",
    holdReason: null,
    outcome: null,
    version: 2,
    staffMemberId: null,
    siteId: null,
    coverage: null,
    currentQuote: null,
    intake: { conditionRecorded: true, accessoriesRecorded: true, customerSigned: false },
    qaChecklistCompleted: true,
    openPartReservations: 0,
    openLoaner: false,
    pickupRemindersSent: 0,
    cancellationRequested: false,
    settlement: { known: true, openBalanceAgorot: 0, basis: "NO_CHARGE" },
    ...o,
  };
}
/** Applies a successful decision to the context, as the service writes it (status, hold, outcome, version). */
function apply(c: ServiceCaseContext, d: ServiceTransitionDecision): ServiceCaseContext {
  if (!d.ok) return c;
  return { ...c, status: d.to, holdReason: d.holdReason, outcome: d.outcome, cancellationRequested: d.cancellationRequestedAfter, version: c.version + 1 };
}
/** Walks a whole path; every step must pass; returns the statuses visited. */
function walk(name: string, start: ServiceCaseContext, steps: { a: ServiceCaseAction; actor?: ServiceCaseActor; over?: Partial<ServiceCaseContext> }[], expected: ServiceCaseStatus[]): ServiceCaseContext {
  let c = start;
  const seen: ServiceCaseStatus[] = [c.status];
  let broken = "";
  for (const s of steps) {
    c = { ...c, ...s.over };
    const d = evaluateTransition(c, s.a, s.actor ?? OWNER);
    if (!d.ok) {
      broken = `${s.a.type} from ${c.status}: ${codes(d).join(",")}`;
      break;
    }
    c = apply(c, d);
    seen.push(c.status);
  }
  check(name, broken === "" && seen.join(">") === expected.join(">"), broken || seen.join(">"));
  return c;
}
const ON_SITE_DONE = { completionType: "OWNER_CONFIRMED_ON_SITE" as const, ownerConfirmed: true };
const QUOTE = { version: 1, totalAgorot: 45_000, docHash: "h1" };
const SENT = { ...QUOTE, state: "SENT" as const, approval: null };

// ── 1. buildTrackFacts reads the case's own snapshot ─────────────────────────────────────────────────────────
console.log("— 1. buildTrackFacts");
{
  check("T1: device lab, item at the business, QA required, handover", (() => { const f = facts(T1); return f.track === "T1" && f.itemAtBusiness && f.requirements.qa.mode === "REQUIRED" && f.requirements.handoverByOwner && f.requirements.workApproval === "ALWAYS"; })());
  check("T2: a vehicle at the business derives T2 (garage: approval ALWAYS)", (() => { const f = facts(T2); return f.track === "T2" && f.requirements.qa.template === "VEHICLE.v1" && f.requirements.workApproval === "ALWAYS"; })());
  check("T3: on site, no intake, QA optional, no handover", (() => { const f = facts(T3); return f.track === "T3" && !f.itemAtBusiness && f.requirements.intakeConfirmation === "NONE" && f.requirements.qa.mode === "OPTIONAL" && !f.requirements.handoverByOwner; })());
  check("T4: installation, QA required, no handover", (() => { const f = facts(T4); return f.track === "T4" && f.requirements.qa.mode === "REQUIRED" && !f.requirements.handoverByOwner; })());
  check("T5: professional at the business — no intake, QA off, nothing held", (() => { const f = facts(T5); return f.track === "T5" && f.location === "AT_BUSINESS" && !f.itemAtBusiness && f.requirements.qa.mode === "OFF" && f.requirements.intakeConfirmation === "NONE"; })());
  check("T6: remote kind derives T6 and place REMOTE", (() => { const f = facts(T6); return f.track === "T6" && f.location === "REMOTE"; })());
  check("T7: no resolution yet → the repair row", (() => { const f = facts(T7); return f.track === "T7" && f.requirements.handoverByOwner && f.requirements.qa.mode === "REQUIRED"; })());
  check("T7: CREDIT reads the credit row (no approval, no QA, credit document, no handover)", (() => { const f = facts(T7, { afterSaleResolution: "CREDIT" }); return f.requirements.workApproval === "NONE" && f.requirements.qa.mode === "OFF" && f.requirements.completion === "OWNER_WITH_CREDIT_DOCUMENT" && !f.requirements.handoverByOwner; })());
  check("NULL work type / place are derived from kind (a FIELD case → T3)", facts({ ...T3, workType: null, serviceLocation: null }).track === "T3");
  check("a resolution on a non-T7 case is ignored", facts(T3, { afterSaleResolution: "CREDIT" }).afterSaleResolution === null);
}

// ── 2. The seven tracks, end to end ─────────────────────────────────────────────────────────────────────────
console.log("— 2. the seven tracks, end to end");
{
  // T1 — repair at the business, D15 ALWAYS (device lab): quote → approval → QA → handover
  walk("T1: intake → diagnosis → quote → approval → QA → READY → handover", ctx({ track: facts(T1) }), [
    { a: { type: "CHECK_IN", intakeConfirmed: true } },
    { a: { type: "START_DIAGNOSIS" } },
    { a: { type: "SEND_QUOTE", quote: QUOTE } },
    { a: { type: "APPROVE_QUOTE", approval: { ...QUOTE, method: "PHONE" } }, over: { currentQuote: SENT } },
    { a: { type: "FINISH_REPAIR" }, over: { currentQuote: { ...SENT, state: "APPROVED", approval: { ...QUOTE, method: "PHONE" } } } },
    { a: { type: "PASS_QA", outcome: "REPAIRED" } },
    { a: { type: "DELIVER", receipt: { handoverConfirmed: true } } },
  ], ["OPEN", "CHECKED_IN", "DIAGNOSING", "QUOTE_PENDING", "IN_REPAIR", "QA", "READY", "DELIVERED"]);
  refused("T1: the intake still needs the owner's confirmation", evaluateTransition(ctx({ track: facts(T1) }), { type: "CHECK_IN" }, OWNER), "INTAKE_NOT_CONFIRMED");
  refused("T1 (ALWAYS): START_REPAIR without a cover is refused even with no commitment", evaluateTransition(ctx({ status: "DIAGNOSING", track: facts(T1) }), { type: "START_REPAIR" }, OWNER), "COVERAGE_NOT_APPROVED");
  refused("T1: a repair never ends COMPLETED", evaluateTransition(ctx({ status: "QA", track: facts(T1) }), { type: "PASS_QA", outcome: "COMPLETED" }, OWNER), "OUTCOME_REQUIRED");

  // T2 — vehicle at the business (garage): cover → repair → QA (VEHICLE.v1) → handover
  walk("T2: intake → diagnosis → cover → QA → READY → handover", ctx({ track: facts(T2), coverage: { source: "MANUFACTURER", decision: "APPROVED" } }), [
    { a: { type: "CHECK_IN", intakeConfirmed: true } },
    { a: { type: "START_DIAGNOSIS" } },
    { a: { type: "START_REPAIR" } },
    { a: { type: "FINISH_REPAIR" } },
    { a: { type: "PASS_QA", outcome: "REPLACED", replacementDeviceId: 9 } },
    { a: { type: "DELIVER", receipt: { handoverConfirmed: true, receivedByName: "דנה" } } },
  ], ["OPEN", "CHECKED_IN", "DIAGNOSING", "IN_REPAIR", "QA", "READY", "DELIVERED"]);

  // T3 — on site, BY_D15 without a commitment: no approval, QA skipped, owner-confirmed completion
  const t3done = walk("T3: visit → diagnosis → repair (no approval needed) → WORK_DONE → COMPLETE → CLOSED", ctx({ kind: "FIELD", track: facts(T3) }), [
    { a: { type: "CHECK_IN" } },
    { a: { type: "START_DIAGNOSIS" } },
    { a: { type: "START_REPAIR" } },
    { a: { type: "FINISH_REPAIR", outcome: "REPAIRED" } },
    { a: { type: "COMPLETE", completion: ON_SITE_DONE } },
  ], ["OPEN", "CHECKED_IN", "DIAGNOSING", "IN_REPAIR", "WORK_DONE", "CLOSED"]);
  check("T3: CLOSED keeps the outcome", t3done.outcome === "REPAIRED");
  {
    const d = evaluateTransition(ctx({ kind: "FIELD", status: "DIAGNOSING", track: facts(T3) }), { type: "START_REPAIR" }, OWNER);
    check("T3: START_REPAIR without approval journals workApproval NOT_REQUIRED", d.ok && d.event.payload.workApproval === "NOT_REQUIRED" && d.event.payload.track === "T3");
  }
  refused("T3 D15: a money commitment (customer-priced part) → the cover / approved quote is required", evaluateTransition(ctx({ kind: "FIELD", status: "DIAGNOSING", track: facts(T3, { moneyCommitment: true }) }), { type: "START_REPAIR" }, OWNER), "COVERAGE_NOT_APPROVED");
  walk("T3: OPTIONAL QA chosen (qa: true) → QA → WORK_DONE", ctx({ kind: "FIELD", status: "IN_REPAIR", track: facts(T3) }), [
    { a: { type: "FINISH_REPAIR", qa: true } },
    { a: { type: "PASS_QA", outcome: "REPAIRED" } },
  ], ["IN_REPAIR", "QA", "WORK_DONE"]);
  {
    const d = evaluateTransition(ctx({ kind: "FIELD", status: "IN_REPAIR", track: facts(T3) }), { type: "FINISH_REPAIR", outcome: "REPAIRED" }, OWNER);
    check("T3: skipping the optional QA is journaled (qa SKIPPED)", d.ok && d.event.payload.qa === "SKIPPED");
  }
  allowed("T3: a rejected quote ends the visit at WORK_DONE (COMPLETE follows)", evaluateTransition(ctx({ kind: "FIELD", status: "QUOTE_PENDING", currentQuote: SENT, track: facts(T3) }), { type: "REJECT_QUOTE", version: 1 }, CUSTOMER), "WORK_DONE");
  allowed("T3: not repairable on site → WORK_DONE (nothing to hand back)", evaluateTransition(ctx({ kind: "FIELD", status: "DIAGNOSING", track: facts(T3) }), { type: "MARK_NOT_REPAIRABLE" }, OWNER), "WORK_DONE");
  allowed("T3: a cancel on site → CANCELLED (nothing held)", evaluateTransition(ctx({ kind: "FIELD", status: "IN_REPAIR", track: facts(T3) }), { type: "CANCEL" }, OWNER), "CANCELLED");

  // T4 — installation: QA required, COMPLETED
  walk("T4: visit → install → QA (required) → COMPLETED → COMPLETE on site", ctx({ kind: "FIELD", track: facts(T4) }), [
    { a: { type: "CHECK_IN" } },
    { a: { type: "START_DIAGNOSIS" } },
    { a: { type: "START_REPAIR" } },
    { a: { type: "FINISH_REPAIR" } },
    { a: { type: "PASS_QA", outcome: "COMPLETED" } },
    { a: { type: "COMPLETE", completion: ON_SITE_DONE } },
  ], ["OPEN", "CHECKED_IN", "DIAGNOSING", "IN_REPAIR", "QA", "WORK_DONE", "CLOSED"]);
  refused("T4: QA required — FINISH_REPAIR may not decide the outcome", evaluateTransition(ctx({ kind: "FIELD", status: "IN_REPAIR", track: facts(T4) }), { type: "FINISH_REPAIR", outcome: "COMPLETED" }, OWNER), "OUTCOME_NOT_ALLOWED");

  // T5 — professional service at the business: no intake, no QA, nothing held
  walk("T5: arrival (no intake) → work → COMPLETED (no QA) → COMPLETE at the business", ctx({ track: facts(T5), intake: null }), [
    { a: { type: "CHECK_IN" } },
    { a: { type: "START_DIAGNOSIS" } },
    { a: { type: "START_REPAIR" } },
    { a: { type: "FINISH_REPAIR", outcome: "COMPLETED" } },
    { a: { type: "COMPLETE", completion: { completionType: "OWNER_CONFIRMED_AT_BUSINESS", ownerConfirmed: true } } },
  ], ["OPEN", "CHECKED_IN", "DIAGNOSING", "IN_REPAIR", "WORK_DONE", "CLOSED"]);
  refused("T5: QA is off — qa: true is refused", evaluateTransition(ctx({ status: "IN_REPAIR", track: facts(T5) }), { type: "FINISH_REPAIR", outcome: "COMPLETED", qa: true }, OWNER), "QA_NOT_FOR_KIND");
  allowed("T5 at the business: a cancel → CANCELLED (no item held, unlike T1)", evaluateTransition(ctx({ status: "DIAGNOSING", track: facts(T5) }), { type: "CANCEL" }, OWNER), "CANCELLED");
  allowed("T1 at the business: the same cancel → READY (the item goes back through a handover)", evaluateTransition(ctx({ status: "DIAGNOSING", track: facts(T1) }), { type: "CANCEL", reason: "בוטל" }, OWNER), "READY");

  // T6 — remote support
  walk("T6: schedule (no site) → session → COMPLETED → COMPLETE remotely", ctx({ kind: "REMOTE", track: facts(T6) }), [
    { a: { type: "SCHEDULE", appointmentId: 31 } },
    { a: { type: "CHECK_IN" } },
    { a: { type: "START_DIAGNOSIS" } },
    { a: { type: "START_REPAIR" } },
    { a: { type: "FINISH_REPAIR", outcome: "COMPLETED" } },
    { a: { type: "COMPLETE", completion: { completionType: "OWNER_CONFIRMED_REMOTE", ownerConfirmed: true } } },
  ], ["OPEN", "SCHEDULED", "CHECKED_IN", "DIAGNOSING", "IN_REPAIR", "WORK_DONE", "CLOSED"]);

  // T7 — after-sale: the three resolutions that exist; EXCHANGE waits for inventory
  walk("T7 REPAIR: like T1 (QA, READY, handover)", ctx({ track: facts(T7, { afterSaleResolution: "REPAIR" }), coverage: { source: "STORE", decision: "APPROVED" } }), [
    { a: { type: "CHECK_IN", intakeConfirmed: true } },
    { a: { type: "START_DIAGNOSIS" } },
    { a: { type: "START_REPAIR" } },
    { a: { type: "FINISH_REPAIR" } },
    { a: { type: "PASS_QA", outcome: "REPAIRED" } },
    { a: { type: "DELIVER", receipt: { handoverConfirmed: true } } },
  ], ["OPEN", "CHECKED_IN", "DIAGNOSING", "IN_REPAIR", "QA", "READY", "DELIVERED"]);
  {
    const credit = decideAfterSale({ track: "T7", status: "DIAGNOSING", current: null, resolution: "CREDIT" });
    check("T7 CREDIT: decideAfterSale runs START_REPAIR + FINISH_REPAIR COMPLETED", credit.ok && credit.steps.map((s) => s.type).join(",") === "START_REPAIR,FINISH_REPAIR");
    const base = ctx({ status: "DIAGNOSING", track: facts(T7, { afterSaleResolution: "CREDIT" }) });
    const end = walk("T7 CREDIT: no approval, no QA → WORK_DONE", base, (credit.ok ? credit.steps : []).map((a) => ({ a })), ["DIAGNOSING", "IN_REPAIR", "WORK_DONE"]);
    refused("T7 CREDIT: COMPLETE needs the linked credit note", evaluateTransition(end, { type: "COMPLETE", completion: { completionType: "OWNER_CONFIRMED_AT_BUSINESS", ownerConfirmed: true } }, OWNER), "CREDIT_DOCUMENT_REQUIRED");
    const linked = { ...end, track: facts(T7, { afterSaleResolution: "CREDIT", creditDocumentLinked: true }) };
    const d = evaluateTransition(linked, { type: "COMPLETE", completion: { completionType: "OWNER_CONFIRMED_AT_BUSINESS", ownerConfirmed: true } }, OWNER);
    check("T7 CREDIT: with the credit note linked → CLOSED, server re-checks the link", d.ok && d.to === "CLOSED" && d.serverChecks.includes("CREDIT_DOCUMENT_LINKED"));
  }
  {
    const back = decideAfterSale({ track: "T7", status: "DIAGNOSING", current: null, resolution: "RETURN_ORIGINAL" });
    const c = ctx({ status: "DIAGNOSING", track: facts(T7, { afterSaleResolution: "RETURN_ORIGINAL" }) });
    const d = back.ok ? evaluateTransition(c, back.steps[0], OWNER) : null;
    check("T7 RETURN_ORIGINAL: MARK_NOT_REPAIRABLE → READY (handover of the item as is)", d !== null && d.ok && d.to === "READY" && d.outcome === "NOT_REPAIRED");
  }
  check("T7 EXCHANGE: refused until the inventory contract exists", (() => { const e = decideAfterSale({ track: "T7", status: "DIAGNOSING", current: null, resolution: "EXCHANGE" }); return !e.ok && e.code === "EXCHANGE_NEEDS_INVENTORY"; })());
  check("T7: a chosen resolution is not chosen again", (() => { const e = decideAfterSale({ track: "T7", status: "IN_REPAIR", current: "CREDIT", resolution: "REPAIR" }); return !e.ok && e.code === "RESOLUTION_ALREADY_CHOSEN"; })());
}

// ── 3. COMPLETE ──────────────────────────────────────────────────────────────────────────────────────────────
console.log("— 3. COMPLETE (WORK_DONE → CLOSED, the owner's confirmation)");
{
  const done = (o: Partial<ServiceCaseContext> = {}) => ctx({ kind: "FIELD", status: "WORK_DONE", outcome: "REPAIRED", track: facts(T3), ...o });
  const complete = (o: Partial<ServiceCaseContext> = {}, extra: Partial<Extract<ServiceCaseAction, { type: "COMPLETE" }>> = {}, actor = OWNER) =>
    evaluateTransition(done(o), { type: "COMPLETE", completion: ON_SITE_DONE, ...extra }, actor);
  const ok = complete({}, { completion: { ...ON_SITE_DONE, confirmedByName: "  יוסי כהן ", note: "הותקן ונבדק" } });
  check("ok: → CLOSED, outcome kept, effect RECORD_COMPLETION", ok.ok && ok.to === "CLOSED" && ok.outcome === "REPAIRED" && ok.effects.includes("RECORD_COMPLETION"));
  check("the completion record holds the trimmed name and the note", ok.ok && ok.completion?.confirmedByName === "יוסי כהן" && ok.completion?.note === "הותקן ונבדק" && ok.completion?.completionType === "OWNER_CONFIRMED_ON_SITE");
  check("no free text in the event: only tokens / flags", ok.ok && !JSON.stringify(ok.event).includes("יוסי") && !JSON.stringify(ok.event).includes("הותקן") && ok.event.payload.confirmerNamed === true && ok.event.payload.completionType === "OWNER_CONFIRMED_ON_SITE");
  refused("not confirmed by the owner", complete({}, { completion: { ...ON_SITE_DONE, ownerConfirmed: false } }), "COMPLETION_NOT_CONFIRMED");
  refused("the completion type must be the place of the work", complete({}, { completion: { ...ON_SITE_DONE, completionType: "OWNER_CONFIRMED_REMOTE" } }), "COMPLETION_TYPE_MISMATCH");
  refused("a name over 200 characters", complete({}, { completion: { ...ON_SITE_DONE, confirmedByName: "א".repeat(201) } }), "INVALID_INPUT");
  refused("the customer link may not complete", complete({}, {}, CUSTOMER), "ACTOR_NOT_ALLOWED");
  refused("a case without a track never completes this way", evaluateTransition(ctx({ kind: "FIELD", status: "WORK_DONE", outcome: "REPAIRED" }), { type: "COMPLETE", completion: ON_SITE_DONE }, OWNER), "TRACK_REQUIRED");
  refused("only from WORK_DONE", evaluateTransition(ctx({ kind: "FIELD", status: "READY", outcome: "REPAIRED", track: facts(T3) }), { type: "COMPLETE", completion: ON_SITE_DONE }, OWNER), "INVALID_TRANSITION");
  refused("open part reservations block the closing", complete({ openPartReservations: 2 }), "OPEN_PART_RESERVATIONS");
  refused("a sent quote awaiting a decision blocks the closing", complete({ currentQuote: SENT }), "OPEN_QUOTE");
  // the balance — exactly the handover rule (owner decisions 3, 4, ש4)
  refused("UNKNOWN balance blocks (never read as zero)", complete({ settlement: { known: false } }), "BALANCE_UNKNOWN");
  refused("an open balance needs the owner's explicit decision", complete({ settlement: { known: true, openBalanceAgorot: 5000, basis: "DOCUMENTED" } }), "OPEN_BALANCE_NEEDS_OWNER_DECISION");
  refused("…with a reason", complete({ settlement: { known: true, openBalanceAgorot: 5000, basis: "DOCUMENTED" } }, { debtOverride: { reason: "  " } }), "OVERRIDE_REASON_REQUIRED");
  const debt = complete({ settlement: { known: true, openBalanceAgorot: 5000, basis: "UNDOCUMENTED" } }, { debtOverride: { reason: "לקוח קבוע, ישלם בסוף החודש" } });
  check("an open balance with the owner's reason → CLOSED; the reason in texts only, the debt journaled", debt.ok && debt.texts.debtOverrideReason === "לקוח קבוע, ישלם בסוף החודש" && debt.event.payload.debtOverride === true && debt.event.payload.openBalanceAgorot === 5000 && debt.event.payload.chargeBasis === "UNDOCUMENTED" && !JSON.stringify(debt.event).includes("לקוח קבוע"));
  const over = complete({ settlement: { known: true, openBalanceAgorot: 0, basis: "DOCUMENTED", overpaidAgorot: 300 } });
  check("an overpayment is shown in the journal (never hidden)", over.ok && over.event.payload.overpaidAgorot === 300);
  check("the settlement is re-read in the same transaction", ok.ok && ok.serverChecks.includes("SETTLEMENT_READ_IN_SAME_TRANSACTION"));
  // owner decision 2026-11-11: the record stores what was judged — balance, overpayment, approval (CHECKs in M1)
  check("record: a settled case stores 0 / 0, no approval", ok.ok && ok.completion?.openBalanceAgorot === 0 && ok.completion?.overpaidAgorot === 0 && ok.completion?.debtApproved === false);
  check("record: an approved debt stores the balance and debtApproved (the reason stays in texts)", debt.ok && debt.completion?.openBalanceAgorot === 5000 && debt.completion?.overpaidAgorot === 0 && debt.completion?.debtApproved === true);
  check("record: an overpayment is stored with the completion, not only journaled", over.ok && over.completion?.overpaidAgorot === 300 && over.completion?.openBalanceAgorot === 0 && over.completion?.debtApproved === false);
  const unknown = complete({ settlement: { known: false } });
  check("record: an UNKNOWN balance produces no record and no RECORD_COMPLETION (never stored as 0)", !unknown.ok);
  refused("a negative balance is malformed (an overpayment is reported separately) → refused", complete({ settlement: { known: true, openBalanceAgorot: -300, basis: "DOCUMENTED" } }), "INVALID_INPUT");
  refused("a debt AND an overpayment together are malformed → refused", complete({ settlement: { known: true, openBalanceAgorot: 100, basis: "DOCUMENTED", overpaidAgorot: 50 } }, { debtOverride: { reason: "x" } }), "INVALID_INPUT");
  refused("a negative / fractional overpayment → refused", complete({ settlement: { known: true, openBalanceAgorot: 0, basis: "DOCUMENTED", overpaidAgorot: 1.5 } }), "INVALID_INPUT");
  const noDebtOverride = complete({}, { debtOverride: { reason: "לא נדרש" } });
  check("a debt decision without a debt is ignored: no reason stored, not approved", noDebtOverride.ok && noDebtOverride.texts.debtOverrideReason === null && noDebtOverride.completion?.debtApproved === false && noDebtOverride.event.payload.debtOverride === undefined);
}

// ── 4. CHANGE_DETAILS (D3) ───────────────────────────────────────────────────────────────────────────────────
console.log("— 4. CHANGE_DETAILS (D3 / D11 / D12 / D13 / D16)");
{
  const NONE = { binding: false, intakeStarted: false, appointmentStarted: false };
  const t3Details = { kind: "FIELD" as const, workType: "REPAIR" as const, serviceLocation: "AT_CUSTOMER" as const, siteAddress: "הרצל 1, חיפה", returnReason: null };
  const open3 = (o: Partial<ServiceCaseContext> = {}) => ctx({ kind: "FIELD", track: facts(T3), details: t3Details, detailBlockers: NONE, ...o });
  const change = (c: ServiceCaseContext, next: Partial<typeof t3Details> | Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    evaluateTransition(c, { type: "CHANGE_DETAILS", next: { ...(c.details as typeof t3Details), ...next }, ...extra } as ServiceCaseAction, OWNER);

  const addr = change(open3(), { siteAddress: " הרצל 7, חיפה " }, { reason: "הלקוח עבר דירה" });
  check("OPEN: a new address → in place, journaled by field name only", addr.ok && addr.to === "OPEN" && !addr.statusChanged && addr.event.payload.changedFields === "siteAddress" && addr.effects.includes("RECORD_DETAIL_CHANGE"));
  check("…before / after / reason travel in decision.detailChange, never in the event", addr.ok && addr.detailChange?.before.siteAddress === "הרצל 1, חיפה" && addr.detailChange?.after.siteAddress === "הרצל 7, חיפה" && addr.detailChange?.reason === "הלקוח עבר דירה" && !JSON.stringify(addr.event).includes("הרצל"));
  check("…the server re-counts the blockers under the lock and re-checks the track", addr.ok && addr.serverChecks.includes("DETAIL_BLOCKERS_COUNTED_UNDER_LOCK") && addr.serverChecks.includes("SUBJECT_FITS_TRACK"));
  const toShop = change(open3(), { kind: "IN_SHOP", serviceLocation: "AT_BUSINESS", siteAddress: null });
  check("OPEN: on site → at the business (T3 → T1): kind follows the place", toShop.ok && toShop.event.payload.changedFields === "kind:serviceLocation:siteAddress");
  refused("the kind must follow the place", change(open3(), { kind: "IN_SHOP" }), "INVALID_INPUT");
  refused("an address belongs only to work on site", change(open3(), { kind: "IN_SHOP", serviceLocation: "AT_BUSINESS" }), "INVALID_INPUT");
  refused("an address over 500 characters", change(open3(), { siteAddress: "א".repeat(501) }), "INVALID_INPUT");
  refused("nothing changes → NO_CHANGE", change(open3(), {}), "NO_CHANGE");
  refused("a reason over 1000 characters", change(open3(), { workType: "MAINTENANCE" }, { reason: "א".repeat(1001) }), "REASON_TOO_LONG");
  // blockers
  refused("a binding action fixes the details (blockers 2, 4, 6–9)", change(open3({ detailBlockers: { ...NONE, binding: true } }), { workType: "MAINTENANCE" }), "DETAILS_FIXED");
  refused("a recorded cover fixes the details (blocker 5)", change(open3({ coverage: { source: "MANUFACTURER", decision: "APPROVED" } }), { workType: "MAINTENANCE" }), "DETAILS_FIXED");
  refused("past OPEN / SCHEDULED nothing changes (blocker 1)", change(open3({ status: "CHECKED_IN" }), { workType: "MAINTENANCE" }), "INVALID_TRANSITION");
  refused("missing blocker counts → refused, never assumed clear", change(open3({ detailBlockers: null }), { workType: "MAINTENANCE" }), "INCONSISTENT_CASE_STATE");
  const t1Details = { kind: "IN_SHOP" as const, workType: "REPAIR" as const, serviceLocation: "AT_BUSINESS" as const, siteAddress: null, returnReason: null };
  const open1 = (b = NONE) => ctx({ track: facts(T1), details: t1Details, detailBlockers: b });
  refused("D12: an intake started at the business — the case may not leave", change(open1({ ...NONE, intakeStarted: true }), { kind: "FIELD", serviceLocation: "AT_CUSTOMER" }), "INTAKE_STARTED_AT_BUSINESS");
  allowed("D12: …but the work type may still change there", change(open1({ ...NONE, intakeStarted: true }), { workType: "MAINTENANCE" }), "OPEN");
  // scheduled visits (D13, D16)
  const sch = (o: Partial<ServiceCaseContext> = {}) => open3({ status: "SCHEDULED", appointmentId: 31, ...o });
  refused("SCHEDULED: the visit moves → the owner chooses KEEP_TIME or UNSCHEDULE", change(sch(), { siteAddress: "הרצל 9, חיפה" }), "APPOINTMENT_IMPACT_REQUIRED");
  allowed("SCHEDULED + KEEP_TIME → stays SCHEDULED", change(sch(), { siteAddress: "הרצל 9, חיפה" }, { appointmentImpact: "KEEP_TIME" }), "SCHEDULED");
  const un = change(sch(), { siteAddress: "הרצל 9, חיפה" }, { appointmentImpact: "UNSCHEDULE" });
  check("SCHEDULED + UNSCHEDULE → OPEN and the appointment is unlinked (D13)", un.ok && un.to === "OPEN" && un.effects.includes("UNLINK_APPOINTMENT") && un.event.payload.appointmentImpact === "UNSCHEDULE");
  allowed("SCHEDULED: a work-type change alone does not move the visit", change(sch(), { workType: "MAINTENANCE" }), "SCHEDULED");
  refused("…and then an appointment impact is refused", change(sch(), { workType: "MAINTENANCE" }, { appointmentImpact: "KEEP_TIME" }), "INVALID_INPUT");
  refused("D16: a visit that already started fixes the details", change(sch({ detailBlockers: { ...NONE, appointmentStarted: true } }), { workType: "MAINTENANCE" }), "APPOINTMENT_ALREADY_STARTED");
  refused("KEEP_TIME on site needs an address or a customer site", change(sch(), { siteAddress: null }, { appointmentImpact: "KEEP_TIME" }), "SITE_REQUIRED");
  // T7
  const t7Details = { kind: "IN_SHOP" as const, workType: "AFTER_SALE" as const, serviceLocation: "AT_BUSINESS" as const, siteAddress: null, returnReason: "DEFECT" as const };
  const open7 = ctx({ track: facts(T7), details: t7Details, detailBlockers: NONE });
  allowed("T7: the return reason is a detail (section כב)", change(open7, { returnReason: "WRONG_ITEM" }), "OPEN");
  refused("T7: an after-sale case stays after-sale", change(open7, { workType: "REPAIR", returnReason: null }), "AFTER_SALE_FIELDS");
  refused("T7: it keeps its return reason", change(open7, { returnReason: null }), "AFTER_SALE_FIELDS");
  refused("a case does not become after-sale", change(open3(), { workType: "AFTER_SALE", returnReason: "DEFECT", kind: "IN_SHOP", serviceLocation: "AT_BUSINESS", siteAddress: null }), "AFTER_SALE_FIELDS");
  // a case opened without a track
  const legacy = ctx({ details: { kind: "IN_SHOP", workType: null, serviceLocation: null, siteAddress: null, returnReason: null }, detailBlockers: NONE });
  allowed("no track: the kind may change among today's kinds", change(legacy, { kind: "FIELD" }), "OPEN");
  refused("no track: it never gains a work type here", change(legacy, { workType: "INSTALLATION" }), "TRACK_REQUIRED");
  refused("no track: never REMOTE", change(legacy, { kind: "REMOTE" }), "TRACK_REQUIRED");
}

// ── 5. RESCHEDULE, RETURN_FROM_EXTERNAL, opening ─────────────────────────────────────────────────────────────
console.log("— 5. RESCHEDULE, return from a supplier, opening");
{
  const r = evaluateTransition(ctx({ kind: "FIELD", status: "SCHEDULED", appointmentId: 31, track: facts(T3) }), { type: "RESCHEDULE", appointmentId: 32 }, OWNER);
  check("RESCHEDULE: SCHEDULED in place, LINK_APPOINTMENT, both ids journaled", r.ok && r.to === "SCHEDULED" && !r.statusChanged && r.effects.includes("LINK_APPOINTMENT") && r.event.payload.appointmentId === 32 && r.event.payload.previousAppointmentId === 31 && r.serverChecks.includes("APPOINTMENT_BELONGS_TO_CASE"));
  refused("RESCHEDULE to the same appointment → NO_CHANGE", evaluateTransition(ctx({ status: "SCHEDULED", appointmentId: 31 }), { type: "RESCHEDULE", appointmentId: 31 }, OWNER), "NO_CHANGE");
  refused("RESCHEDULE only from SCHEDULED", evaluateTransition(ctx({ status: "OPEN" }), { type: "RESCHEDULE", appointmentId: 31 }, OWNER), "INVALID_TRANSITION");
  refused("SCHEDULE on site (track): no address and no customer site → SITE_REQUIRED", evaluateTransition(ctx({ kind: "FIELD", track: facts(T3, { siteAddressSet: false }) }), { type: "SCHEDULE", appointmentId: 31 }, OWNER), "SITE_REQUIRED");
  allowed("SCHEDULE on site (track): the case's own address is enough", evaluateTransition(ctx({ kind: "FIELD", track: facts(T3) }), { type: "SCHEDULE", appointmentId: 31 }, OWNER), "SCHEDULED");
  const ext = (track: ServiceTrackFacts, next: "READY" | "WORK_DONE") =>
    evaluateTransition(ctx({ status: "EXTERNAL", coverage: { source: "MANUFACTURER", decision: "APPROVED" }, track }), { type: "RETURN_FROM_EXTERNAL", next, outcome: "REPAIRED" }, OWNER);
  refused("back from a supplier on T3: READY is not where its work ends", ext(facts(T3), "READY"), "INVALID_INPUT");
  allowed("…WORK_DONE is", ext(facts(T3), "WORK_DONE"), "WORK_DONE");
  refused("back from a supplier on T1: WORK_DONE is refused (the item is handed back)", ext(facts(T1), "WORK_DONE"), "INVALID_INPUT");
  // planTrackOpening
  const p5 = planTrackOpening({ track: "T5" });
  check("opening T5 needs the place chosen", !p5.ok && p5.field === "serviceLocation");
  const p7 = planTrackOpening({ track: "T7" });
  check("opening T7 needs a return reason", !p7.ok && p7.code === "RETURN_REASON_REQUIRED");
  const p1 = planTrackOpening({ track: "T1", siteAddress: "הרצל 1" });
  check("opening at the business with an address is refused", !p1.ok && p1.field === "siteAddress");
  const p6 = planTrackOpening({ track: "T6" });
  check("opening T6 → kind REMOTE, place REMOTE", p6.ok && p6.opening.kind === "REMOTE" && p6.opening.serviceLocation === "REMOTE");
  const o = openServiceCase({ kind: "REMOTE", customerId: 4, deviceId: null, parentCaseId: null, track: "T6" }, OWNER);
  check("openServiceCase accepts the planned T6 opening", o.ok && o.event.payload.track === "T6");
}

// ── 6. A case without a track keeps today's rules ────────────────────────────────────────────────────────────
console.log("— 6. regression: no track = today's kind rules");
{
  allowed("IN_SHOP FINISH_REPAIR → QA", evaluateTransition(ctx({ status: "IN_REPAIR" }), { type: "FINISH_REPAIR" }, OWNER), "QA");
  allowed("FIELD FINISH_REPAIR REPAIRED → READY (on-site handover, as before)", evaluateTransition(ctx({ kind: "FIELD", status: "IN_REPAIR" }), { type: "FINISH_REPAIR", outcome: "REPAIRED" }, OWNER), "READY");
  refused("FIELD: COMPLETED needs a track", evaluateTransition(ctx({ kind: "FIELD", status: "IN_REPAIR" }), { type: "FINISH_REPAIR", outcome: "COMPLETED" }, OWNER), "TRACK_REQUIRED");
  refused("FIELD: qa: true → QA_NOT_FOR_KIND", evaluateTransition(ctx({ kind: "FIELD", status: "IN_REPAIR" }), { type: "FINISH_REPAIR", outcome: "REPAIRED", qa: true }, OWNER), "QA_NOT_FOR_KIND");
  refused("START_REPAIR without a cover → COVERAGE_NOT_APPROVED (D15 does not apply without a track)", evaluateTransition(ctx({ status: "DIAGNOSING" }), { type: "START_REPAIR" }, OWNER), "COVERAGE_NOT_APPROVED");
  refused("IN_SHOP CHECK_IN without the confirmation", evaluateTransition(ctx(), { type: "CHECK_IN" }, OWNER), "INTAKE_NOT_CONFIRMED");
  allowed("MARK_NOT_REPAIRABLE → READY", evaluateTransition(ctx({ status: "DIAGNOSING" }), { type: "MARK_NOT_REPAIRABLE" }, OWNER), "READY");
  refused("DELIVER with an UNKNOWN balance is still refused", evaluateTransition(ctx({ status: "READY", outcome: "REPAIRED", settlement: { known: false } }), { type: "DELIVER", receipt: { handoverConfirmed: true } }, OWNER), "BALANCE_UNKNOWN");
  const noTrackPayload = evaluateTransition(ctx({ status: "IN_REPAIR" }), { type: "FINISH_REPAIR" }, OWNER);
  check("no track: no track token in the journal", noTrackPayload.ok && !("track" in noTrackPayload.event.payload));
}

console.log(`\n${total - failures} passed, ${failures} failed, ${total} checks`);
if (failures > 0) process.exit(1);
