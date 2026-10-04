/* eslint-disable @typescript-eslint/no-explicit-any -- reads heterogeneous measure-detail JSON in assertions */
/**
 * All-Feature Learning Coverage · W3 — the funnel and operations rules, pure proofs. No database.
 *   node_modules/.bin/tsx lib/knowledge/rules/funnel-operations-rules.test.ts
 *
 * Each rule is proven on what it must learn and on what it must refuse: an app-posted "inbound" is not a
 * customer writing, a failed send is not a reply, a young message has not yet been "unanswered", a
 * CONFIRMED appointment in the past has no known outcome, generic data exports are not the accountant
 * habit, and owner-asserted closure is labelled as a claim. The rules the evidence manifest does not
 * support (reply-suggestion adoption, notification reads, content runs) are proven ABSENT.
 */
import {
  openingOf, deriveFirstHandling, deriveWinShare, deriveFollowUpPunctuality, deriveDaysToWin,
  deriveFirstReply, deriveUnanswered24h,
  type LeadObservation, type ConversationOpeningObservation, type OpeningMessage,
} from "./funnel";
import {
  deriveNoShowShare, deriveCancellationShare, deriveBookingLead, deriveRescheduleShare,
  deriveHandledToPaid, deriveObligationClosure, deriveDemandCadence, deriveExportCadence,
  type AppointmentObservation,
} from "./operations";
import { catalogueDescriptors } from "../registry";
import { SENSORS } from "../../sensors/catalogue";

let failures = 0;
let total = 0;
function ok(name: string, cond: boolean, extra: unknown = ""): void {
  total += 1;
  if (!cond) failures += 1;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${cond || extra === "" ? "" : " — " + JSON.stringify(extra)}`);
}
const section = (t: string) => console.log(`\n${t}`);

const BIZ = 9;
const NOW = new Date("2026-10-01T09:00:00Z");
const H = 3_600_000;
const DAY = 24 * H;
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);
let id = 0;

section("LEAD-01..04");
{
  const lead = (p: Partial<LeadObservation> & { created: number }): LeadObservation =>
    ({ recordId: ++id, businessId: BIZ, createdAt: ago(p.created), firstHandledAt: null, status: "OPEN", closedAt: null, ...p });
  const rows = [
    lead({ created: 50, firstHandledAt: ago(49.5), status: "WON", closedAt: ago(40) }),
    lead({ created: 45, firstHandledAt: ago(44), status: "LOST", closedAt: ago(30) }),
    lead({ created: 40, firstHandledAt: ago(39.75), status: "WON", closedAt: ago(20) }),
    lead({ created: 35, firstHandledAt: ago(33), status: "DROPPED", closedAt: ago(25) }),
    lead({ created: 30, firstHandledAt: ago(29.5), status: "WON", closedAt: ago(26) }),
    lead({ created: 10 }), // never handled
    lead({ created: 8, status: "QUOTED" }),
  ];
  const [fh] = deriveFirstHandling(rows, NOW, BIZ);
  ok("first handling: median of 0.5, 1, 0.25, 2, 0.5 days = 0.5; unhandled leads not counted", fh.valueNumeric === 0.5 && fh.observationCount === 5, fh);
  const [win] = deriveWinShare(rows, NOW, BIZ);
  ok("win share = 3 of 5 closed (DROPPED is closed, open leads are not)", win.valueNumeric === 0.6 && win.observationCount === 5, win);
  const [dtw] = deriveDaysToWin(rows, NOW, BIZ);
  ok("days to win: median of 10, 20, 4 = 10", dtw.valueNumeric === 10 && dtw.observationCount === 3, dtw);
  const fu = [1, -1, 0, 2, 3].map((late, i) => ({ recordId: 100 + i, businessId: BIZ, completedAt: new Date(ago(60 - i * 5).getTime() + late * DAY), dueAt: ago(60 - i * 5) }));
  const [p] = deriveFollowUpPunctuality(fu, NOW, BIZ);
  ok("follow-up punctuality median 1 day late", p.status === "ACTIVE" && p.valueNumeric === 1, p);
}

section("CONV-01 / CONV-02 — real inbound only; senderType is never trusted");
{
  const t0 = ago(4).getTime();
  const m = (at: number, direction: OpeningMessage["direction"], fromProvider = false, sendFailed = false): OpeningMessage =>
    ({ at: new Date(at), direction, fromProvider, sendFailed });
  const o = openingOf([
    m(ago(5).getTime(), "OUTBOUND"),              // owner-opened: not a reply to anything
    m(t0 - 2 * H, "INBOUND", false),              // posted through the app route: not a real delivery
    m(t0, "INBOUND", true),                       // the first real customer message
    m(t0 + 1 * H, "OUTBOUND", false, true),       // a failed send is not a reply
    m(t0 + 6 * H, "OUTBOUND"),
  ]);
  ok("opening: app-posted inbound, a pre-inbound outbound and a failed send are all ignored",
    !!o && o.firstInboundAt.getTime() === t0 && o.firstReplyAt!.getTime() - t0 === 6 * H, o);
  ok("no real inbound → no opening", openingOf([m(t0, "INBOUND", false), m(t0 + H, "OUTBOUND")]) === null);
  const c = (inboundDaysAgo: number, replyHours: number | null): ConversationOpeningObservation =>
    ({ recordId: ++id, businessId: BIZ, firstInboundAt: ago(inboundDaysAgo), firstReplyAt: replyHours === null ? null : new Date(ago(inboundDaysAgo).getTime() + replyHours * H) });
  const rows = [c(30, 2), c(25, 6), c(20, 12), c(15, 30), c(10, null), c(5, 1), c(0.5, null)];
  const [fr] = deriveFirstReply(rows, NOW, BIZ);
  ok("first reply median = 6h = 0.25 days over 5 replied", fr.valueNumeric === 0.25 && fr.observationCount === 5, fr);
  const [un] = deriveUnanswered24h(rows, NOW, BIZ);
  ok("unanswered-24h: 2 of 6 matured (a 12-hour-old message waits)", un.observationCount === 6 && un.valueNumeric === 0.33, un);
}

section("APPT-01..04 — outcomes only where an outcome exists");
{
  const a = (status: AppointmentObservation["status"], startDaysAgo: number, createdDaysAgo: number, rescheduled = false): AppointmentObservation =>
    ({ recordId: ++id, businessId: BIZ, status, startsAt: ago(startDaysAgo), createdAt: ago(createdDaysAgo), rescheduled });
  const rows = [
    ...Array.from({ length: 8 }, (_, i) => a("COMPLETED", 10 + i, 17 + i, i < 2)),
    a("NO_SHOW", 30, 33), a("NO_SHOW", 31, 35, true),
    a("CANCELED", 40, 50), a("CANCELED", 41, 45),
    a("CONFIRMED", 5, 9), // past start, outcome unknown
    a("CONFIRMED", -5, 2), // future
    a("PROPOSED", 20, 25),
  ];
  const [ns] = deriveNoShowShare(rows, NOW, BIZ);
  ok("no-show = 2 of 10 resolved (CONFIRMED-in-the-past is unknown, not 'showed')", ns.observationCount === 10 && ns.valueNumeric === 0.2, ns);
  const [cx] = deriveCancellationShare(rows, NOW, BIZ);
  ok("cancellation = 2 of 12 resolved bookings", cx.observationCount === 12 && cx.valueNumeric === 0.17, cx);
  const [lead] = deriveBookingLead(rows, NOW, BIZ);
  ok("booking lead time: PROPOSED excluded, median 7 days", lead.observationCount === 14 && lead.valueNumeric === 7, lead);
  const [rs] = deriveRescheduleShare(rows, NOW, BIZ);
  ok("reschedule share from the observation sensor: 3 of 13 due bookings", rs.observationCount === 13 && rs.valueNumeric === 0.23, rs);
}

section("SEC-01 / SEC-02 — handled is not paid; closure is a claim");
{
  const h = [0, 1, 2, 3, 5].map((lag, i) => ({ recordId: 200 + i, businessId: BIZ, handledAt: ago(80 - i * 10), paidAt: new Date(ago(80 - i * 10).getTime() + lag * DAY) }));
  const [hp] = deriveHandledToPaid([...h, { recordId: 299, businessId: BIZ, handledAt: ago(3), paidAt: null }], NOW, BIZ);
  ok("handled → paid median 2 days; an unpaid handled installment is not evidence", hp.valueNumeric === 2 && hp.observationCount === 5, hp);
  const ob = [-2, 0, 1, 1, 4].map((late, i) => ({ recordId: 300 + i, businessId: BIZ, dueAt: ago(90 - i * 10), metAt: new Date(ago(90 - i * 10).getTime() + late * DAY) }));
  const [oc] = deriveObligationClosure(ob, NOW, BIZ);
  ok("obligation closure median 1 day late, labelled OWNER_ASSERTED", oc.valueNumeric === 1 && (oc.detail as any).authority === "OWNER_ASSERTED", oc);
}

section("OFF-01 / REP-01");
{
  const sig = (svc: number, d: number) => ({ recordId: ++id, businessId: BIZ, businessServiceId: svc, at: ago(d) });
  const dm = deriveDemandCadence([sig(5, 50), sig(5, 43), sig(5, 36), sig(5, 29), sig(5, 22), sig(6, 10), sig(6, 3)], NOW, BIZ);
  ok("demand cadence per service: service 5 weekly, service 6 insufficient",
    dm.length === 2 && dm[0].entityType === "business-service" && dm[0].valueNumeric === 7 && dm[1].status === "INSUFFICIENT_EVIDENCE", dm.map((m) => [m.entityId, m.status, m.valueNumeric]));
  const acts = (ds: number[]) => ds.map((d) => ({ recordId: ++id, businessId: BIZ, at: ago(d) }));
  const [ex] = deriveExportCadence(acts([120, 90, 60, 30]), NOW, BIZ);
  ok("accountant export cadence: monthly (30 days)", ex.valueNumeric === 30 && ex.status === "ACTIVE", ex);
  const [few] = deriveExportCadence(acts([20, 14]), NOW, BIZ);
  ok("one gap stays INSUFFICIENT_EVIDENCE (thresholds are never lowered)", few.status === "INSUFFICIENT_EVIDENCE");
}

section("catalogue ↔ sensors — the first two observation sources are real consumers");
{
  const d = catalogueDescriptors();
  const ids = ["LEAD-01", "LEAD-02", "LEAD-03", "LEAD-04", "CONV-01", "CONV-02", "APPT-01", "APPT-02", "APPT-03", "APPT-04",
    "SEC-01", "SEC-02", "OFF-01", "REP-01"];
  ok("all 14 W3 rules registered exactly once", ids.every((i) => d.filter((x) => x.ruleId === i).length === 1));
  ok("no rule learns from evidence the manifest does not vouch for (suggestions, notification reads, content)",
    !d.some((x) => /^(BOT|NOTIF|CONT)-/.test(x.ruleId) || /^(replies|notifications|content)\./.test(x.measureKey)));
  ok("measure-key prefix = domain", d.every((x) => x.measureKey.startsWith(`${x.domain}.`)), d.filter((x) => !x.measureKey.startsWith(`${x.domain}.`)).map((x) => x.ruleId));
  ok("policy and measure keys unique across the whole catalogue", new Set(d.map((x) => x.policyKey)).size === d.length && new Set(d.map((x) => x.measureKey)).size === d.length);
  const s = Object.values(SENSORS);
  const consumers = s.filter((x) => x.learning.role === "OBSERVATION_SOURCE");
  ok("exactly APPOINTMENT_RESCHEDULED and DATA_EXPORTED are observation sources", consumers.map((x) => x.eventType).sort().join() === "APPOINTMENT_RESCHEDULED,DATA_EXPORTED");
  ok("and both carry ACTION_TIME", consumers.every((x) => x.timeSemantics === "ACTION_TIME"));
}

console.log(`\n${total - failures}/${total} passed`);
if (failures > 0) { console.error(`${failures} FAILED`); process.exit(1); }
console.log("Funnel & operations rules: owner behaviour from ledgers, outcomes only where they exist, claims labelled. ✔");
