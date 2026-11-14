/**
 * State producers A–E — pure checks (no database, no network, no clock of its own).
 *
 *   npx tsx lib/notifications/producers/state-producers.test.ts
 *
 *  A obligations.due              stages (due, 1, 3, 7, weekly) and their keys; MET / RELEASED / postponed / not yet
 *                                 due ⇒ nothing; the due DAY in the business time zone (incl. the October DST change)
 *  B payments.request_failed      only a terminal state (FAILED on a sent link, expired > 24 h with no verification
 *                                 pending); never when paid, paid by another request / a receipt allocation, re-asked
 *                                 or cancelled; an old terminal request is present (resolvable) but never announced
 *  C billing.allocation_failed    FAILED / REJECTED / uncertain / HELD undecided / stuck past 60 min — never a merely
 *                                 slow one; the integration gate (SANDBOX, unset, pilot not admitting ⇒ off)
 *  D documents.processing_failed  `failed`; STUCK = `processing` more than 30 min after the attempt started (never
 *                                 during an attempt, never on an unstamped historical row); a retry is a new attempt
 *                                 (new key); the threshold is 6 × the longest attempt window (maxDuration 300 s)
 *  E appointments.upcoming        per user, at THEIR lead (30 / 60 / 120 / the day before): created one sweep interval
 *                                 ahead with the owed push due at the exact moment (nextAttemptAt) and expiring at the
 *                                 start; too early / too late / started ⇒ none; cancelled / BLOCK / erased ⇒ nothing;
 *                                 a move or a lead change ⇒ a new key; precision with a 15-min sweep + 5-min worker;
 *                                 the day before = the same local time across both 2026 Asia/Jerusalem clock changes
 *  catalog / privacy              the five categories: defaults, no quiet-hours bypass, generic lock-screen text, the
 *                                 push names nobody and carries no digit; every event's href passes the prefixes
 *  runner                         feature off ⇒ nothing read; lock busy ⇒ nothing read; one failing producer rolls
 *                                 back to its savepoint and the others still run; an incomplete read resolves nothing;
 *                                 the resolve touches only that category, with that producer's present keys
 *  static                         no domain write in the producers (only notify() and Notification.resolvedAt)
 */
import fs from "node:fs";
import path from "node:path";

import { getCategory, safeHref, type CategoryDefinition } from "../catalog";
import type { BusinessGates } from "../engine/engine-gate";
import type { NotifyEvent } from "../engine/notify";
import { buildPushMessage } from "../push/push-content";
import {
  ALLOCATION_STUCK_MS,
  allocationFacts,
  allocationProblem,
  APPOINTMENT_READ_HORIZON_MS,
  APPOINTMENT_SWEEP_INTERVAL_MS,
  DOCUMENT_STUCK_MS,
  appointmentFacts,
  appointmentReminderMoment,
  appointmentReminderPlan,
  documentFacts,
  documentStuck,
  obligationFacts,
  obligationStage,
  paymentFacts,
  paymentVerdict,
  type AllocationSubmissionFact,
  type AppointmentFact,
  type DocumentFact,
  type ReminderRecipient,
  type ObligationFact,
  type PaymentContext,
  type PaymentRequestFact,
} from "./state-facts";
import { allocationIntegrationOn, producerAvailable, runStateProducers, STATE_PRODUCERS, type StateProducer, type StateProducerDeps } from "./state-producers";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed += 1; console.log(`  [PASS] ${name}`); }
  else { failed += 1; console.log(`  [FAIL] ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 600)); }
}
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const B = 77;
const TZ = "Asia/Jerusalem";
const NOW = new Date("2026-12-10T10:00:00.000Z"); // 12:00 in Jerusalem

/* ── A ─────────────────────────────────────────────────────────────────────────────────────────────────────── */
function partA() {
  console.log("A. obligations.due");
  const table: [number, string | null][] = [[-1, null], [0, "due"], [1, "late1"], [2, "late1"], [3, "late3"], [6, "late3"], [7, "late7"], [13, "late7"], [14, "late14"], [20, "late14"], [21, "late21"], [70, "late70"]];
  ok("stage table: due, 1, 3, 7, then weekly", table.every(([d, s]) => obligationStage(d) === s), table.map(([d]) => obligationStage(d)));
  const ob = (over: Partial<ObligationFact>): ObligationFact => ({ entityType: "business_obligation", id: 5, state: "OPEN", dueAt: new Date("2026-12-10T06:00:00Z"), followUpAt: null, href: "/secretary", ...over });
  const at = (d: number) => new Date(NOW.getTime() + d * DAY);
  const keyAt = (d: number) => obligationFacts(B, [ob({})], at(d), TZ).present[0];
  const due = obligationFacts(B, [ob({})], NOW, TZ);
  ok("due today: one event, whole business, under /secretary", due.events.length === 1 && due.events[0]!.userId === null && due.events[0]!.href === "/secretary" && due.events[0]!.category === "obligations.due");
  ok("the key encodes entity, id, due day and stage", due.present[0] === "st:obligations.due:business_obligation:5:2026-12-10:due", due.present);
  ok("days 1 and 2 share a key (no re-send without reason)", keyAt(1) === keyAt(2) && keyAt(1)!.endsWith(":late1"));
  ok("day 3 is a new stage; 3–6 one key", keyAt(3) !== keyAt(2) && keyAt(3) === keyAt(6));
  ok("day 7, then weekly (14, 21) — each a new key", keyAt(7) !== keyAt(6) && keyAt(7) === keyAt(13) && keyAt(14) !== keyAt(13) && keyAt(21) !== keyAt(20));
  ok("not yet due ⇒ nothing", obligationFacts(B, [ob({ dueAt: at(1) })], NOW, TZ).present.length === 0);
  ok("MET (paid / handled) ⇒ not present (resolved)", obligationFacts(B, [ob({ state: "MET" })], at(3), TZ).present.length === 0);
  ok("RELEASED ⇒ not present", obligationFacts(B, [ob({ state: "RELEASED" })], at(3), TZ).present.length === 0);
  ok("postponed (followUpAt in the future) ⇒ not present", obligationFacts(B, [ob({ followUpAt: at(5) })], at(3), TZ).present.length === 0);
  ok("…and back once the postponement ended", obligationFacts(B, [ob({ followUpAt: at(2) })], at(3), TZ).present.length === 1);
  // 2026-10-24T22:30Z is already 25 October in Jerusalem (01:30, the night the clocks go back at 02:00).
  const dst = ob({ dueAt: new Date("2026-10-24T22:30:00Z") });
  ok("due DAY in the business zone across the October DST change (UTC says the 24th, Jerusalem the 25th)",
    obligationFacts(B, [dst], new Date("2026-10-25T08:00:00Z"), TZ).present[0]?.endsWith(":2026-10-25:due") === true &&
    obligationFacts(B, [dst], new Date("2026-10-24T20:00:00Z"), TZ).present.length === 0);
  ok("another zone: the same instant is still the 24th in New York (due on the 24th there)",
    obligationFacts(B, [dst], new Date("2026-10-24T23:00:00Z"), "America/New_York").present[0]?.endsWith(":2026-10-24:due") === true);
  ok("installment rows carry their own type and href", obligationFacts(B, [ob({ entityType: "installment", href: "/payables" })], NOW, TZ).events[0]!.href === "/payables");
  ok("generic stored text: no name, no amount", due.events.every((e) => !/[0-9₪]/.test(`${e.title} ${e.summary}`)));
}

/* ── B ─────────────────────────────────────────────────────────────────────────────────────────────────────── */
function partB() {
  console.log("B. payments.request_failed");
  const req = (over: Partial<PaymentRequestFact>): PaymentRequestFact => ({
    id: 9, status: "FAILED", paymentUrl: "https://pay.example/x", expiresAt: null, createdAt: new Date(NOW.getTime() - 2 * DAY),
    updatedAt: new Date(NOW.getTime() - HOUR), billingDocumentId: 300, customerId: 12, amount: "100.00", transactionStatuses: ["FAILED"], ...over,
  });
  const none: PaymentContext = { siblings: [], allocatedDocumentIds: new Set() };
  const v = (r: PaymentRequestFact, ctx = none) => paymentVerdict(r, ctx, NOW);
  ok("FAILED on a sent link ⇒ notify (failed)", v(req({})).kind === "notify");
  ok("FAILED without a link (creation failed on screen) ⇒ nothing", v(req({ paymentUrl: null })).kind === "none");
  ok("PAID ⇒ nothing", v(req({ status: "PAID" })).kind === "none");
  ok("a PAID transaction on a FAILED request (late success) ⇒ nothing", v(req({ transactionStatuses: ["FAILED", "PAID"] })).kind === "none");
  ok("CANCELLED by the owner ⇒ nothing (handled)", v(req({ status: "CANCELLED" })).kind === "none");
  ok("PENDING, link not yet expired ⇒ nothing (not terminal)", v(req({ status: "PENDING", expiresAt: new Date(NOW.getTime() + HOUR), transactionStatuses: [] })).kind === "none");
  ok("PENDING, expired 2 h ago ⇒ nothing yet (24 h grace for a late callback)", v(req({ status: "PENDING", expiresAt: new Date(NOW.getTime() - 2 * HOUR), transactionStatuses: [] })).kind === "none");
  const exp = v(req({ status: "PENDING", expiresAt: new Date(NOW.getTime() - 25 * HOUR), transactionStatuses: [] }));
  ok("PENDING, expired 25 h ago, nothing pending ⇒ notify (expired)", exp.kind === "notify" && exp.terminal === "expired", exp);
  ok("…but a verification still PENDING ⇒ nothing", v(req({ status: "PENDING", expiresAt: new Date(NOW.getTime() - 25 * HOUR), transactionStatuses: ["PENDING"] })).kind === "none");
  const sib = (over: Partial<PaymentContext["siblings"][number]>) => ({ id: 10, status: "PENDING" as const, createdAt: new Date(NOW.getTime() - DAY), billingDocumentId: 300, customerId: 12, amount: "100.00", expiresAt: null, ...over });
  ok("another request of the same document PAID ⇒ nothing (paid elsewhere)", v(req({}), { siblings: [sib({ status: "PAID" })], allocatedDocumentIds: new Set() }).kind === "none");
  ok("a newer PENDING request for the same document ⇒ nothing (the owner already re-asked)", v(req({}), { siblings: [sib({})], allocatedDocumentIds: new Set() }).kind === "none");
  ok("an OLDER pending sibling does not hide it", v(req({}), { siblings: [sib({ createdAt: new Date(NOW.getTime() - 5 * DAY) })], allocatedDocumentIds: new Set() }).kind === "notify");
  ok("a receipt allocation covering the document ⇒ nothing (money recorded another way)", v(req({}), { siblings: [], allocatedDocumentIds: new Set([300]) }).kind === "none");
  ok("no document: a newer PAID request of the same customer and amount ⇒ nothing",
    v(req({ billingDocumentId: null }), { siblings: [sib({ billingDocumentId: null, status: "PAID" })], allocatedDocumentIds: new Set() }).kind === "none");
  ok("no document: a different amount does not count", v(req({ billingDocumentId: null }), { siblings: [sib({ billingDocumentId: null, status: "PAID", amount: "7.00" })], allocatedDocumentIds: new Set() }).kind === "notify");
  const facts = paymentFacts(B, [req({}), req({ id: 11, updatedAt: new Date(NOW.getTime() - 10 * DAY) })], none, NOW);
  ok("a terminal request older than 7 days: present (resolvable) but never announced", facts.present.length === 2 && facts.events.length === 1 && facts.events[0]!.entity.id === 9, facts.present);
  ok("deep link to the request itself", facts.events[0]!.href === "/payments/9");
}

/* ── C ─────────────────────────────────────────────────────────────────────────────────────────────────────── */
function partC() {
  console.log("C. billing.allocation_failed");
  const sub = (over: Partial<AllocationSubmissionFact>): AllocationSubmissionFact => ({
    id: 4, billingDocumentId: 88, status: "FAILED", outcomeUncertain: false, heldDecisionReportedAt: null,
    createdAt: new Date(NOW.getTime() - 3 * HOUR), submittedAt: null, lastAttemptAt: null, ...over,
  });
  const p = (o: Partial<AllocationSubmissionFact>) => allocationProblem(sub(o), NOW);
  ok("FAILED ⇒ failed; REJECTED ⇒ rejected", p({}) === "failed" && p({ status: "REJECTED" }) === "rejected");
  ok("SUBMITTED with the outcome-uncertain code ⇒ uncertain", p({ status: "SUBMITTED", outcomeUncertain: true, lastAttemptAt: NOW }) === "uncertain");
  ok("HELD with no decision reported ⇒ decision; reported ⇒ nothing", p({ status: "HELD" }) === "decision" && p({ status: "HELD", heldDecisionReportedAt: NOW }) === null);
  ok("APPROVED / NOT_REQUIRED ⇒ nothing", p({ status: "APPROVED" }) === null && p({ status: "NOT_REQUIRED" }) === null);
  const recent = new Date(NOW.getTime() - ALLOCATION_STUCK_MS + MIN);
  const old = new Date(NOW.getTime() - ALLOCATION_STUCK_MS - MIN);
  ok("a request moving within the last 60 min is NOT stuck (transient delay)", ["READY", "PENDING", "SUBMITTED"].every((s) => p({ status: s as never, createdAt: old, lastAttemptAt: recent }) === null));
  ok("…past 60 min since its last movement it is stuck", ["READY", "PENDING", "SUBMITTED"].every((s) => p({ status: s as never, createdAt: old, lastAttemptAt: old }) === "stuck"));
  const f = allocationFacts(B, [sub({}), sub({ id: 5, status: "APPROVED" })], NOW);
  ok("one event, keyed by submission and problem, linking the invoice", f.events.length === 1 && f.present[0] === "st:billing.allocation_failed:billing_authority_submission:4:failed" && f.events[0]!.href === "/billing/88");
  ok("stuck → failed is a new key (a new fact)", allocationFacts(B, [sub({ status: "SUBMITTED", createdAt: old })], NOW).present[0] !== f.present[0]);
  ok("integration: unset runtime environment ⇒ off", allocationIntegrationOn(B, {}) === false);
  ok("integration: SANDBOX ⇒ off", allocationIntegrationOn(B, { BILLING_AUTHORITY_RUNTIME_ENVIRONMENT: "SANDBOX", BILLING_AUTHORITY_PRODUCTION_PILOT_BUSINESS_IDS: String(B), BILLING_AUTHORITY_PRODUCTION_PILOT_OPERATIONS: "oauth,submissions" }) === false);
  ok("integration: PRODUCTION without the pilot list ⇒ off", allocationIntegrationOn(B, { BILLING_AUTHORITY_RUNTIME_ENVIRONMENT: "PRODUCTION" }) === false);
  ok("integration: PRODUCTION, listed, OAuth-only stage ⇒ off", allocationIntegrationOn(B, { BILLING_AUTHORITY_RUNTIME_ENVIRONMENT: "PRODUCTION", BILLING_AUTHORITY_PRODUCTION_PILOT_BUSINESS_IDS: String(B), BILLING_AUTHORITY_PRODUCTION_PILOT_OPERATIONS: "oauth" }) === false);
  ok("integration: PRODUCTION, another business listed ⇒ off", allocationIntegrationOn(B, { BILLING_AUTHORITY_RUNTIME_ENVIRONMENT: "PRODUCTION", BILLING_AUTHORITY_PRODUCTION_PILOT_BUSINESS_IDS: "1", BILLING_AUTHORITY_PRODUCTION_PILOT_OPERATIONS: "oauth,submissions" }) === false);
  ok("integration: PRODUCTION, listed, submissions ⇒ on", allocationIntegrationOn(B, { BILLING_AUTHORITY_RUNTIME_ENVIRONMENT: "production", BILLING_AUTHORITY_PRODUCTION_PILOT_BUSINESS_IDS: String(B), BILLING_AUTHORITY_PRODUCTION_PILOT_OPERATIONS: "oauth,submissions" }) === true);
  ok("integration: PRODUCTION, listed, approval selected ⇒ on", allocationIntegrationOn(B, { BILLING_AUTHORITY_RUNTIME_ENVIRONMENT: "PRODUCTION", BILLING_AUTHORITY_PRODUCTION_PILOT_BUSINESS_IDS: String(B), BILLING_AUTHORITY_PRODUCTION_PILOT_OPERATIONS: "oauth,refresh,approval" }) === true);
  const gates = gatesOf(true);
  ok("producerAvailable: allocation off ⇒ the producer does not run", !producerAvailable({ id: "allocation", category: "billing.allocation_failed" }, gates, false) && producerAvailable({ id: "allocation", category: "billing.allocation_failed" }, gates, true));
}

/* ── D ─────────────────────────────────────────────────────────────────────────────────────────────────────── */
function partD() {
  console.log("D. documents.processing_failed (failed + stuck)");
  const doc = (over: Partial<DocumentFact>): DocumentFact => ({ id: 1, status: "failed", statusChangedAt: null, ...over });
  const f = documentFacts(B, [doc({}), doc({ id: 2, status: "processing", statusChangedAt: new Date(NOW.getTime() - 2 * MIN) }), doc({ id: 3, status: "needs_review" })], NOW);
  ok("`failed` ⇒ one fact; a processing document inside its attempt and needs_review ⇒ nothing", f.present.length === 1 && f.events.length === 1 && f.events[0]!.entity.id === 1);
  ok("deep link to the document's own handling screen", f.events[0]!.href === "/documents/review/1");
  ok("the failed key is unchanged (rows written before this change stay the same fact)", f.present[0] === "st:documents.processing_failed:document_processing:1");
  ok("threshold = 30 min = 6 × the longest attempt window (bulk import maxDuration 300 s)", DOCUMENT_STUCK_MS === 30 * MIN && DOCUMENT_STUCK_MS >= 6 * 300_000);
  const at = (minutesAgo: number) => doc({ id: 9, status: "processing", statusChangedAt: new Date(NOW.getTime() - minutesAgo * MIN) });
  ok("processing for 1 / 5 (a whole bulk-import window) / 30 min ⇒ NOT stuck (a normal attempt is never flagged)", [1, 5, 30].every((m) => !documentStuck(at(m), NOW)));
  ok("processing for 31 min ⇒ stuck", documentStuck(at(31), NOW));
  ok("a historical row (statusChangedAt NULL), processing since forever ⇒ never stuck", !documentStuck(doc({ status: "processing", statusChangedAt: null }), NOW)
    && documentFacts(B, [doc({ status: "processing", statusChangedAt: null })], NOW).present.length === 0);
  const stuck = documentFacts(B, [at(45)], NOW);
  ok("stuck ⇒ one event, generic text, same deep link, in the same category", stuck.events.length === 1 && stuck.events[0]!.category === "documents.processing_failed"
    && stuck.events[0]!.href === "/documents/review/9" && !/[0-9]/.test(stuck.events[0]!.title + (stuck.events[0]!.summary ?? "")), stuck.events[0]);
  ok("the stuck key carries the attempt's start (distinct from the failed key)", stuck.present[0] === `st:documents.processing_failed:document_processing:9:stuck:${at(45).statusChangedAt!.toISOString()}`);
  const retried = documentFacts(B, [doc({ id: 9, status: "processing", statusChangedAt: new Date(NOW.getTime() - 3 * MIN) })], NOW);
  ok("retried (a new attempt restamped by the database) ⇒ absent ⇒ the stuck one resolves", retried.present.length === 0);
  const stuckAgain = documentFacts(B, [doc({ id: 9, status: "processing", statusChangedAt: new Date(NOW.getTime() - 40 * MIN) })], NOW);
  ok("stuck again later ⇒ a NEW key (a new fact, not the cooled-down old one)", stuckAgain.present[0] !== stuck.present[0]);
  ok("succeeded (needs_review / approved) ⇒ absent ⇒ resolved", documentFacts(B, [doc({ id: 9, status: "needs_review", statusChangedAt: NOW })], NOW).present.length === 0);
}

/* ── E ─────────────────────────────────────────────────────────────────────────────────────────────────────── */
function partE() {
  console.log("E. appointments.upcoming (per-user lead time)");
  const ap = (over: Partial<AppointmentFact>): AppointmentFact => ({ id: 3, status: "CONFIRMED", kind: "CUSTOMER", startsAt: new Date(NOW.getTime() + 45 * MIN), erasedAt: null, ...over });
  const U60: ReminderRecipient = { userId: 11, leadMinutes: 60 };
  const f = (a: AppointmentFact, now = NOW, rec: ReminderRecipient[] = [U60], tz = TZ) => appointmentFacts(B, [a], rec, now, tz);
  ok("sweep interval 15 min; horizon covers a 25-hour day before + one interval", APPOINTMENT_SWEEP_INTERVAL_MS === 15 * MIN && APPOINTMENT_READ_HORIZON_MS === 25 * HOUR + 15 * MIN);

  // Plan: created one interval ahead, owed for the exact moment, expiring at the start.
  const start = new Date("2026-12-10T12:00:00Z");
  const plan = (now: string, lead = 60) => appointmentReminderPlan(start, lead, new Date(now), TZ);
  ok("lead 60, 70 min before the start (> moment + 0, < moment − 15) ⇒ too early", plan("2026-12-10T10:44:00Z").kind === "too_early");
  const p1 = plan("2026-12-10T10:46:00Z");
  ok("lead 60, 74 min before ⇒ created now, owed push due at 11:00 exactly, expiring at the start",
    p1.kind === "create" && p1.notBefore.toISOString() === "2026-12-10T11:00:00.000Z" && p1.expiresAt.toISOString() === start.toISOString(), p1);
  const p2 = plan("2026-12-10T11:20:00Z");
  ok("lead 60, created late (20 min after the moment, inside the 30-min grace) ⇒ due now", p2.kind === "create" && p2.notBefore.toISOString() === "2026-12-10T11:20:00.000Z", p2);
  ok("lead 60, 31 min after the moment ⇒ too late (none created)", plan("2026-12-10T11:31:00Z").kind === "too_late");
  ok("started ⇒ too late", plan("2026-12-10T12:00:00Z").kind === "too_late");
  const p30 = plan("2026-12-10T11:20:00Z", 30), p120 = plan("2026-12-10T09:50:00Z", 120), pd = plan("2026-12-09T11:50:00Z", 1440);
  ok("lead 30 / 120 / the day before: moments 11:30, 10:00, the previous day 12:00Z (same local time)",
    p30.kind === "create" && p30.notBefore.toISOString() === "2026-12-10T11:30:00.000Z"
    && p120.kind === "create" && p120.notBefore.toISOString() === "2026-12-10T10:00:00.000Z"
    && pd.kind === "create" && pd.notBefore.toISOString() === "2026-12-09T12:00:00.000Z", { p30, p120, pd });
  ok("the day before, two days ahead ⇒ too early (the bell is not filled days ahead)", plan("2026-12-08T12:00:00Z", 1440).kind === "too_early");

  // Precision: a sweep every 15 minutes (any phase) + a worker every 5 minutes ⇒ delivered within [moment, moment + 5 min).
  let worst = 0;
  for (const lead of [30, 60, 120, 1440]) {
    for (let phase = 0; phase < 15; phase += 1) {
      const moment = appointmentReminderMoment(start, lead, TZ).getTime();
      let created: number | null = null;
      for (let t = moment - 3 * HOUR + phase * MIN; t < start.getTime(); t += 15 * MIN) {
        const pl = appointmentReminderPlan(start, lead, new Date(t), TZ);
        if (pl.kind === "create") { created = pl.notBefore.getTime(); break; }
      }
      if (created === null) { worst = Infinity; break; }
      for (let wphase = 0; wphase < 5; wphase += 1) {
        // the first 5-minute worker tick (at any phase) at or after nextAttemptAt
        const delivered = Math.ceil((created - wphase * MIN) / (5 * MIN)) * 5 * MIN + wphase * MIN;
        worst = Math.max(worst, delivered - moment);
        if (delivered < moment) worst = Infinity;
      }
    }
  }
  ok("precision: 15-min sweep at any phase + 5-min worker ⇒ every lead delivered within 5 min of its moment, never before", worst >= 0 && worst < 5 * MIN, worst / MIN);

  // Facts: per user, one key per (appointment, start, user, lead).
  const two = f(ap({ startsAt: start }), new Date("2026-12-10T10:50:00Z"), [U60, { userId: 12, leadMinutes: 120 }]);
  ok("two users (60 / 120 min), one business, at 10:50Z: both keys present, one event each (120: late but inside its grace, due now)",
    two.present.length === 2 && two.events.length === 2 && two.events.every((e) => e.userId === 11 || e.userId === 12), two.events.map((e) => [e.userId, e.push?.notBefore]));
  const ev = two.events.find((e) => e.userId === 11)!;
  ok("…the event targets ONE user and carries the moment + expiry; deep link /calendar",
    ev.push?.notBefore.toISOString() === "2026-12-10T11:00:00.000Z" && ev.push?.expiresAt.toISOString() === start.toISOString() && ev.href === "/calendar", ev);
  const mixed = f(ap({ startsAt: start }), new Date("2026-12-10T09:00:00Z"), [U60, { userId: 12, leadMinutes: 120 }, { userId: 13, leadMinutes: 1440 }]);
  ok("three users (60 / 120 / the day before) at 09:00Z: no event (60 and 120 too early, the day before past its grace), all three present", mixed.events.length === 0 && mixed.present.length === 3);
  ok("the key names appointment, start, user and lead", ev.dedupeKey === `st:appointments.upcoming:appointment:3:${start.toISOString()}:u11:l60`);
  ok("same appointment, same start, same user ⇒ the same key every pass (one reminder; the engine's cooldown holds it)",
    f(ap({ startsAt: start }), new Date("2026-12-10T10:50:00Z")).present[0] === f(ap({ startsAt: start }), new Date("2026-12-10T11:05:00Z")).present[0]);
  ok("a far-ahead appointment is PRESENT (kept) but creates nothing", f(ap({ startsAt: new Date(NOW.getTime() + 20 * HOUR) })).present.length === 1 && f(ap({ startsAt: new Date(NOW.getTime() + 20 * HOUR) })).events.length === 0);
  ok("CANCELED / PROPOSED / COMPLETED / NO_SHOW ⇒ absent (resolved)", ["CANCELED", "PROPOSED", "COMPLETED", "NO_SHOW"].every((st) => f(ap({ status: st as never })).present.length === 0));
  ok("BLOCK / erased / no start / started ⇒ absent", [ap({ kind: "BLOCK" }), ap({ erasedAt: NOW }), ap({ startsAt: null }), ap({ startsAt: new Date(NOW.getTime() - MIN) })].every((a) => f(a).present.length === 0));
  ok("INTERNAL appointments are reminded too", f(ap({ kind: "INTERNAL", startsAt: new Date(NOW.getTime() + 55 * MIN) })).events.length === 1);
  const moved = f(ap({ startsAt: new Date(start.getTime() + 30 * MIN) }), new Date("2026-12-10T10:50:00Z"));
  ok("rescheduled ⇒ a new key; the old key is absent (resolves, its owed push is suppressed)", !moved.present.includes(ev.dedupeKey!));
  const leadChanged = f(ap({ startsAt: start }), new Date("2026-12-10T10:50:00Z"), [{ userId: 11, leadMinutes: 30 }]);
  ok("the user changed the lead before the moment ⇒ the old key is absent, the new one waits for its own window", !leadChanged.present.includes(ev.dedupeKey!) && leadChanged.events.length === 0);
  ok("no recipients ⇒ nothing", f(ap({}), NOW, []).present.length === 0);

  // Time zones and DST.
  // 25 Oct 2026, Jerusalem leaves summer time at 02:00 (UTC+3 → UTC+2). 08:30 local = 06:30Z.
  const oct = new Date("2026-10-25T06:30:00Z");
  const octDay = appointmentReminderMoment(oct, 1440, TZ);
  ok("October change: the day before = 24 Oct 08:30 local = 05:30Z (25 real hours before)", octDay.toISOString() === "2026-10-24T05:30:00.000Z", octDay.toISOString());
  ok("October change: 60 / 120 min stay real minutes (05:30Z, 04:30Z)",
    appointmentReminderMoment(oct, 60, TZ).toISOString() === "2026-10-25T05:30:00.000Z" && appointmentReminderMoment(oct, 120, TZ).toISOString() === "2026-10-25T04:30:00.000Z");
  const octF = f(ap({ startsAt: oct }), new Date("2026-10-25T05:20:00Z"));
  ok("October change: the summary reads the local start 08:30", octF.events[0]?.summary?.includes("08:30") === true, octF.events[0]?.summary);
  // 27 Mar 2026: Jerusalem moves to UTC+3 at 02:00. 09:00 local on the 27th = 06:00Z; the day before 09:00 = 07:00Z.
  const mar = new Date("2026-03-27T06:00:00Z");
  ok("March change: the day before = 26 Mar 09:00 local = 07:00Z (23 real hours before)", appointmentReminderMoment(mar, 1440, TZ).toISOString() === "2026-03-26T07:00:00.000Z");
  const marD = f(ap({ startsAt: mar }), new Date("2026-03-26T06:50:00Z"), [{ userId: 11, leadMinutes: 1440 }]);
  ok("March change: the day-before reminder names the date and local time (27.3, 09:00)", marD.events[0]?.summary === "התור ב-27.3 בשעה 09:00.", marD.events[0]?.summary);
  const ny = new Date("2026-11-01T14:00:00Z"); // 09:00 in New York after its 1 Nov change (EST)
  ok("America/New_York across its change: the day before = 31 Oct 09:00 EDT = 13:00Z", appointmentReminderMoment(ny, 1440, "America/New_York").toISOString() === "2026-10-31T13:00:00.000Z");
}

/* ── catalog / privacy ─────────────────────────────────────────────────────────────────────────────────────── */
function partCatalog() {
  console.log("catalog / privacy");
  const want: Record<string, { push: boolean; delivery: string; feature: string | null }> = {
    "obligations.due": { push: false, delivery: "digest", feature: null },
    "payments.request_failed": { push: true, delivery: "instant", feature: null },
    "billing.allocation_failed": { push: true, delivery: "instant", feature: "billing" },
    "documents.processing_failed": { push: false, delivery: "digest", feature: "documents" },
    "appointments.upcoming": { push: true, delivery: "instant", feature: "appointments" },
  };
  for (const p of STATE_PRODUCERS) {
    const cat = getCategory(p.category)!;
    const w = want[p.category]!;
    ok(`${p.category}: in the catalog with the decided defaults`, cat !== null && cat.defaults.inApp && cat.defaults.push === w.push && cat.defaults.delivery === w.delivery && cat.featureKey === w.feature, cat?.defaults);
    ok(`${p.category}: never breaks quiet hours or the rate limit`, !cat.quietBypass && !cat.rateExempt);
    ok(`${p.category}: generic lock-screen text (no digit / placeholder)`, !/[0-9{}$<>]/.test(cat.lockScreen.title + cat.lockScreen.body));
    ok(`${p.category}: user may change in-app, push and delivery`, cat.userMutable.inApp && cat.userMutable.push && cat.userMutable.delivery);
    ok(`${p.category}: a cooldown and a TTL`, cat.cooldownHours > 0 && cat.ttlMinutes > 0);
  }
  const events: NotifyEvent[] = [
    ...obligationFacts(B, [{ entityType: "business_obligation", id: 1, state: "OPEN", dueAt: NOW, followUpAt: null, href: "/secretary" }], NOW, TZ).events,
    ...paymentFacts(B, [{ id: 2, status: "FAILED", paymentUrl: "u", expiresAt: null, createdAt: NOW, updatedAt: NOW, billingDocumentId: null, customerId: null, amount: "1", transactionStatuses: [] }], { siblings: [], allocatedDocumentIds: new Set() }, NOW).events,
    ...allocationFacts(B, [{ id: 3, billingDocumentId: 30, status: "FAILED", outcomeUncertain: false, heldDecisionReportedAt: null, createdAt: NOW, submittedAt: null, lastAttemptAt: null }], NOW).events,
    ...documentFacts(B, [{ id: 4, status: "failed", statusChangedAt: null }], NOW).events,
    ...documentFacts(B, [{ id: 6, status: "processing", statusChangedAt: new Date(NOW.getTime() - HOUR) }], NOW).events,
    ...appointmentFacts(B, [{ id: 5, status: "CONFIRMED", kind: "CUSTOMER", startsAt: new Date(NOW.getTime() + 45 * MIN), erasedAt: null }], [{ userId: 8, leadMinutes: 60 }], NOW, TZ).events,
  ];
  ok("one event per producer (+ the stuck document)", events.length === 6);
  for (const e of events) {
    const cat = getCategory(e.category)!;
    ok(`${e.category}: href ${e.href} passes the category's prefixes`, safeHref(e.href, cat.hrefPrefixes) !== null);
    const msg = buildPushMessage(cat, { id: 1, title: `${e.title} יוסי כהן 1,234 ₪ INV-0042`, summary: e.summary ?? null, href: e.href, entityType: e.entity.type, entityId: e.entity.id }, { lockScreenDetails: false, ttlSeconds: 60 });
    ok(`${e.category}: the lock-screen push names nobody and carries no digit`, !/יוסי|[0-9₪]|INV/.test(`${msg.title} ${msg.body}`), `${msg.title} ${msg.body}`);
    const perUser = e.category === "appointments.upcoming";
    ok(`${e.category}: ${perUser ? "one user (the reminder is personal)" : "whole business (userId NULL)"}, explicit dedupe key`,
      (perUser ? e.userId === 8 && e.dedupeKey!.endsWith(":u8:l60") : e.userId === null) && typeof e.dedupeKey === "string" && e.dedupeKey.startsWith(`st:${e.category}:`));
  }
}

/* ── runner ────────────────────────────────────────────────────────────────────────────────────────────────── */
function gatesOf(engineOn: boolean, off: string[] = []): BusinessGates {
  return { engineOn, cutoverAt: null, categoryAvailable: (c: CategoryDefinition) => !(c.featureKey && off.includes(c.featureKey)) };
}

async function partRunner() {
  console.log("runner");
  type Log = { sql: string[]; reads: string[]; notified: string[]; resolves: { category: string; notIn: string[] }[] };
  const make = (opts: { locked?: boolean; failId?: string; incompleteId?: string } = {}) => {
    const log: Log = { sql: [], reads: [], notified: [], resolves: [] };
    const tx = {
      $queryRaw: async (s: TemplateStringsArray) => { log.sql.push(s.join("?")); return [{ locked: opts.locked ?? true }]; },
      $executeRaw: async (s: TemplateStringsArray) => { log.sql.push(s.join("?")); return 0; },
      bookingSettings: { findFirst: async () => null },
      notification: { updateMany: async (a: { where: { semanticCategory: string; dedupeKey: { notIn: string[] } } }) => { log.resolves.push({ category: a.where.semanticCategory, notIn: a.where.dedupeKey.notIn }); return { count: 1 }; } },
    };
    const producers: StateProducer[] = STATE_PRODUCERS.map((p) => ({
      ...p,
      read: async (_tx, businessId, now) => {
        log.reads.push(p.id);
        if (opts.failId === p.id) throw new Error("read failed");
        const k = `st:${p.category}:x:1`;
        return { facts: { events: [{ businessId, category: p.category, entity: { type: "x", id: 1 }, dedupeKey: k, title: "t", summary: null, href: getCategory(p.category)!.hrefPrefixes[0]!, userId: null, now }], present: [k] }, complete: opts.incompleteId !== p.id };
      },
    }));
    const deps: StateProducerDeps = {
      tenantTx: async (_b, fn) => fn(tx as never),
      notify: async (_tx, e) => { log.notified.push(e.category); return { notificationId: 1, created: true, notified: true, owedDeliveryId: getCategory(e.category)!.defaults.push ? 1 : null }; },
      allocationOn: () => false,
      producers,
    };
    return { log, deps };
  };
  {
    const { log, deps } = make();
    const r = await runStateProducers(B, gatesOf(true), NOW, deps);
    ok("lock taken first (pg_try_advisory_xact_lock on namespace + business)", /pg_try_advisory_xact_lock/.test(log.sql[0] ?? ""), log.sql[0]);
    ok("integration off: the allocation producer is not even read", !log.reads.includes("allocation") && r.unavailable === 1, log.reads);
    ok("the four others ran, each in a savepoint, notified and resolved within its own category",
      r.ran === 4 && log.sql.filter((s) => s.includes("SAVEPOINT state_producer") && !s.includes("RELEASE") && !s.includes("ROLLBACK")).length === 4 &&
      JSON.stringify(log.resolves.map((x) => x.category).sort()) === JSON.stringify(["appointments.upcoming", "documents.processing_failed", "obligations.due", "payments.request_failed"]), { r, resolves: log.resolves });
    ok("…with that producer's present keys", log.resolves.every((x) => x.notIn.length === 1 && x.notIn[0]!.startsWith(`st:${x.category}:`)));
    ok("owed pushes counted (payments + appointments push by default)", r.owedPush === 2, r);
  }
  {
    const { log, deps } = make({ locked: false });
    const r = await runStateProducers(B, gatesOf(true), NOW, deps);
    ok("lock busy (another sweep of this business): nothing read, nothing written", r.leaseBusy && log.reads.length === 0 && log.notified.length === 0 && log.resolves.length === 0, r);
  }
  {
    const { log, deps } = make({ failId: "payments" });
    const r = await runStateProducers(B, gatesOf(true), NOW, deps);
    ok("one failing read rolls back to its savepoint; the others still run", r.failed === 1 && r.ran === 3 && log.sql.some((s) => s.includes("ROLLBACK TO SAVEPOINT state_producer")) && !log.resolves.some((x) => x.category === "payments.request_failed"), r);
  }
  {
    const { log, deps } = make({ incompleteId: "documents" });
    const r = await runStateProducers(B, gatesOf(true), NOW, deps);
    ok("an incomplete read writes its events but resolves nothing", r.incomplete === 1 && log.notified.includes("documents.processing_failed") && !log.resolves.some((x) => x.category === "documents.processing_failed"), r);
  }
  {
    const { log, deps } = make();
    const r = await runStateProducers(B, gatesOf(true, ["documents", "appointments", "billing"]), NOW, deps);
    ok("feature off (documents, appointments, billing): those producers read nothing", !log.reads.includes("documents") && !log.reads.includes("appointments") && r.unavailable === 3, log.reads);
  }
  {
    const { log, deps } = make();
    deps.allocationOn = () => true;
    await runStateProducers(B, gatesOf(true), NOW, deps);
    ok("integration on + billing available: the allocation producer runs", log.reads.includes("allocation"));
  }
}

function partStatic() {
  console.log("static");
  const code = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const prod = code("lib/notifications/producers/state-producers.ts");
  const writes = prod.match(/\.\w+\.(create|update|upsert|delete)(Many)?\(/g) ?? [];
  ok("the producers' only table write is Notification.updateMany (resolve)", JSON.stringify(writes) === JSON.stringify([".notification.updateMany("]), writes);
  ok("no raw write: the only raw statements are the lock and the savepoints", (prod.match(/\$executeRaw`([^`]*)`/g) ?? []).every((s) => /SAVEPOINT state_producer/.test(s)) && !/\$executeRawUnsafe|\$queryRawUnsafe/.test(prod));
  const scoped = (prod.match(/findMany\(\{\s*where: \{\s*businessId/g) ?? []).length;
  ok("every domain read is scoped by businessId (8 reads: + the users' lead times)", scoped === 8 && (prod.match(/findMany\(/g) ?? []).length === 8, scoped);
  ok("pure module: no database, no clock", !/prisma|new Date\(\)|Date\.now/.test(code("lib/notifications/producers/state-facts.ts")));
}

async function main() {
  partA();
  partB();
  partC();
  partD();
  partE();
  partCatalog();
  await partRunner();
  partStatic();
  console.log(`\n[state-producers] PASS=${passed} FAIL=${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
