/**
 * HOME v4 view-model — run:
 *   npx tsx features/home/v4/home-v4-model.test.ts
 *
 * Pure (no DB / network / I/O). Guards the rules of the redesigned Home across the business states the owner
 * specified (A–H): plan/kind/person layering, no invented numbers, real zero vs failure, one item per area,
 * calm only when proven, no locked capabilities in the workspace, and a "+" limited to permitted actions.
 */
import { he } from "@/lib/i18n/messages/he";
import { createTranslator } from "@/lib/i18n/translate";
import type { HomeHistory } from "@/lib/services/home/home-history-model";

import { FAILED, LOADING, buildWaiting, ready, type WaitingModel } from "../v3/home-v3-model";
import { allows, businessKindOf, modulesFromCapabilities, resolveUserPermissions, type HomeAccess, type HomeModule } from "./home-access";
import {
  SIMPLE_TOOLS_MAX,
  availableTools,
  buildForYou,
  buildSecretary,
  buildToday,
  countMetric,
  createActionsFor,
  inactiveTools,
  metricOrder,
  moneyMetric,
  openCasesClaim,
  favoriteTools,
  pruneDismissals,
  simpleToolOrder,
  restOfDayLine,
  waitingQuotes,
} from "./home-v4-model";
import { agendaToToday } from "./use-home-v4-data";
import { TOOLS } from "@/lib/navigation/home-routes";
import { DAY_CALENDAR_FALLBACK, isResolvedActive } from "@/components/navigation/use-nav-href";
import { isNavActive } from "@/components/navigation/nav-destinations";

const t = createTranslator(he);
let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else {
    failed += 1;
    console.error(`FAIL: ${name}`, extra ?? "");
  }
}

// 2026-11-18 09:00 Israel (UTC+2).
const NOW = new Date("2026-11-18T07:00:00Z");

function access(modules: HomeModule[], kind: HomeAccess["kind"] = "general"): HomeAccess {
  return { businessId: 7, modules: new Set(modules), kind, permissions: resolveUserPermissions() };
}
const ALL: HomeModule[] = ["billing", "documents", "inventory", "inbox", "daily_tasks", "appointments", "service_desk", "business_documents", "owner_recommendations", "starter_bot", "revenue"];
const DEFAULTS: HomeModule[] = ["billing", "documents", "inventory", "inbox", "daily_tasks", "appointments", "starter_bot", "revenue"];

const NEVER: HomeHistory = {
  income: false, expenses: false, obligations: false, collection: false, documents: false, leads: false,
  conversations: false, inventory: false, insights: false, identityDescription: false, whatsapp: "NEVER",
};
const ACTIVE: HomeHistory = { ...NEVER, income: true, collection: true, documents: true, leads: true, conversations: true };

const emptyWaiting = (): WaitingModel => buildWaiting({ briefing: { state: "CALM", oriented: true, attention: [], watching: [], counts: { open: 0, attention: 0, breakToday: 0, watching: 0 }, generatedAt: NOW.toISOString() }, status: [], collectionWaiting: [], now: NOW, t });

function leadStatus(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    itemId: `leads:new_unhandled:${i + 1}`, domain: "leads", semanticCategory: "x", title: `ליד ${i + 1}`, summary: "s",
    severity: "MEDIUM", priorityScore: 1, entityRef: null, primaryAction: { href: `/leads/${i + 1}`, label: "x" },
  })) as never;
}

/* ---------------------------------------------------------- layers -- */
ok("capabilities: only allowed:true modules are ON (fail-closed)", (() => {
  const m = modulesFromCapabilities({ features: { billing: { allowed: true }, service_desk: { allowed: false }, documents: {} } });
  return m.has("billing") && !m.has("service_desk") && !m.has("documents");
})());
ok("capabilities: a missing answer means nothing is ON", modulesFromCapabilities(null).size === 0);
ok("kind: Device Repair is a service business", businessKindOf({ profile: { category: "Device Repair" } }) === "service");
ok("kind: Beauty books appointments", businessKindOf({ profile: { category: "Beauty" } }) === "booking");
ok("kind: unknown / missing → general (emphasis only)", businessKindOf(null) === "general" && businessKindOf({ profile: { category: "???" } }) === "general");
ok("person scope is required even with the module ON", !allows({ ...access(ALL), permissions: { scopes: new Set(["customers"]) } }, { modules: ["billing"], scope: "money" }));

/* ------------------------------------------------- snapshot metrics -- */
ok("state C (service + service_desk): main pair is receipts + open service calls", metricOrder(access(ALL, "service"), null).slice(0, 2).join() === "receiptsMonth,openService");
ok("state D (sales, no service_desk): no service metric anywhere", !metricOrder(access(DEFAULTS, "sales"), null).includes("openService"));
ok("state D: main pair is receipts + waiting enquiries", metricOrder(access(DEFAULTS, "sales"), null).slice(0, 2).join() === "receiptsMonth,waitingLeads");
ok("state B (billing OFF): no money metric at all", metricOrder(access([], "general"), null).every((k) => !k.startsWith("receipts") && k !== "toCollect"));
ok("state B (nothing but core): still at least one real metric, no empty tiles", metricOrder(access([], "general"), null).length >= 1);
ok("owner choice wins when still available", metricOrder(access(DEFAULTS, "general"), ["docsReview", "todayTasks"]).slice(0, 2).join() === "docsReview,todayTasks");
ok("owner choice of an OFF metric is ignored (no locked tile)", !metricOrder(access(DEFAULTS, "general"), ["openService"]).includes("openService"));
ok("money: real zero is a zero", (() => { const v = moneyMetric(ready({ amount: "0.00", mixed: false }), "he"); return v.state === "ready" && v.zero && v.text === "₪0"; })());
ok("money: ₪12,450 formatting", (() => { const v = moneyMetric(ready({ amount: "12450.00", mixed: false }), "he"); return v.state === "ready" && v.text === "₪12,450"; })());
ok("money: a failed source is FAILED, never ₪0", moneyMetric(FAILED, "he").state === "failed");
ok("count: a capped count reads N+ and is not a zero", (() => { const v = countMetric(ready({ n: 8, exact: false })); return v.state === "ready" && v.text === "8+" && !v.zero; })());
ok("count: loading stays loading", countMetric(LOADING).state === "loading");
ok("service cases: open statuses only; exact only when the page held all", (() => {
  const c = openCasesClaim({ cases: [{ status: "OPEN" }, { status: "IN_REPAIR" }, { status: "DELIVERED" }, { status: "CLOSED" }], nextBeforeId: null });
  const capped = openCasesClaim({ cases: [{ status: "OPEN" }], nextBeforeId: 9 });
  return c.n === 2 && c.exact && !capped.exact;
})());

/* --------------------------------------------------------- secretary -- */
const sec = (waiting: WaitingModel, opts: Partial<Parameters<typeof buildSecretary>[0]> = {}) =>
  buildSecretary({ waiting: ready(waiting), partial: false, access: access(DEFAULTS), history: ACTIVE, dismissals: {}, now: NOW, t, ...opts });

const twoLeads = buildWaiting({ briefing: null, status: leadStatus(2), collectionWaiting: [], now: NOW, t });
const leadView = sec(twoLeads);
ok("one recommendation: '2 פניות ממתינות למענה' + 'טיפול בפניות'", leadView.state === "ready" && leadView.title === "2 פניות ממתינות למענה" && leadView.cta === "טיפול בפניות", leadView);
ok("two leads open the needs-action list", leadView.state === "ready" && leadView.href === "/leads?view=needsAction");
ok("state A (brand new, nothing waiting): first action, not a fake recommendation", sec(emptyWaiting(), { history: NEVER }).state === "first");
ok("state G (active business, nothing waiting, all sources answered): calm, exact", (() => { const v = sec(emptyWaiting()); return v.state === "calm" && v.exact; })());
ok("state G is NOT claimed when a source failed (partial) → unsure", (() => { const v = sec(emptyWaiting(), { partial: true }); return v.state === "calm" && !v.exact; })());
ok("state H: a failed waiting read is FAILED, not calm", buildSecretary({ waiting: FAILED, partial: false, access: access(DEFAULTS), history: ACTIVE, dismissals: {}, now: NOW, t }).state === "failed");
ok("dismissed group gives way to calm (no repeat)", (() => {
  const first = sec(twoLeads);
  if (first.state !== "ready") return false;
  const v = sec(twoLeads, { dismissals: { [first.groupKey]: { mode: "dismiss" } } });
  return v.state === "calm";
})());
ok("a dismissal stops holding when the waiting items change", (() => {
  const first = sec(twoLeads);
  if (first.state !== "ready") return false;
  const three = buildWaiting({ briefing: null, status: leadStatus(3), collectionWaiting: [], now: NOW, t });
  return sec(three, { dismissals: { [first.groupKey]: { mode: "dismiss" } } }).state === "ready";
})());
ok("stock items are not shown without inventory", (() => {
  const stock = buildWaiting({ briefing: null, status: [{ itemId: "inventory:low:1", domain: "inventory", inventoryAlertType: "LOW_STOCK", semanticCategory: "x", title: "מלאי נמוך: x", summary: "s", severity: "MEDIUM", priorityScore: 1, entityRef: null, primaryAction: { href: "/inventory/1", label: "x" } }] as never, collectionWaiting: [], now: NOW, t });
  return sec(stock, { access: access(["billing"]) }).state !== "ready" && sec(stock).state === "ready";
})());
ok("state E (lots waiting): still ONE recommendation; the chip counts every visible update", (() => {
  const many = buildWaiting({ briefing: null, status: leadStatus(6), collectionWaiting: [{ requestId: 1, customerName: "א", invoiceNumber: null, amount: "100", currency: "ILS", createdAt: NOW.toISOString() }], now: NOW, t });
  const v = sec(many);
  return v.state === "ready" && v.updates.n === 7;
})());

/* ------------------------------------------------------------- today -- */
const appt = (id: number, iso: string, extra: Record<string, unknown> = {}) => ({ id, status: "CONFIRMED", kind: "CUSTOMER", startsAt: iso, endsAt: new Date(new Date(iso).getTime() + 3600_000).toISOString(), title: "פגישה עם לקוח", ...extra });
ok("hidden when neither calendar nor tasks are active (state B: no empty card)", buildToday({ appointments: { state: "off" }, tasks: { state: "off" }, now: NOW, t }).state === "hidden");
ok("next = earliest upcoming; rest = 2 meetings and 3 tasks", (() => {
  const v = buildToday({
    appointments: ready([appt(1, "2026-11-18T09:30:00Z"), appt(2, "2026-11-18T12:00:00Z"), appt(3, "2026-11-18T14:00:00Z"), appt(4, "2026-11-18T05:00:00Z")]),
    tasks: ready([1, 2, 3].map((i) => ({ id: i, title: `משימה ${i}`, dueOn: "2026-11-18", bucket: "TODAY" }))),
    now: NOW, t,
  });
  return v.state === "ready" && v.next?.time === "11:30" && v.restMeetings === 2 && v.restTasks === 3
    && restOfDayLine(v.restMeetings, v.restTasks, t) === "בהמשך: עוד 2 פגישות ו־3 משימות";
})());
ok("cancelled / other-day appointments never appear", (() => {
  const v = buildToday({ appointments: ready([appt(1, "2026-11-18T09:30:00Z", { status: "CANCELED" }), appt(2, "2026-11-19T09:30:00Z")]), tasks: { state: "off" }, now: NOW, t });
  return v.state === "ready" && v.next === null;
})());
ok("state F (nothing planned): ready with no next (compact empty state)", (() => { const v = buildToday({ appointments: ready([]), tasks: ready([]), now: NOW, t }); return v.state === "ready" && v.next === null; })());
ok("one source failed → partial, the other still shows", (() => { const v = buildToday({ appointments: FAILED, tasks: ready([{ id: 1, title: "x", dueOn: null, bucket: "TODAY" }]), now: NOW, t }); return v.state === "ready" && v.partial && v.next?.type === "task"; })());
ok("all sources failed → failed (never 'nothing planned')", buildToday({ appointments: FAILED, tasks: FAILED, now: NOW, t }).state === "failed");
ok("agenda: lead follow-ups are not counted as the owner's tasks", agendaToToday({ buckets: [{ bucket: "TODAY", rows: [{ type: "TASK", task: { id: 1, title: "a", dueOn: null } }, { type: "TASK", task: { id: 2, title: "b", dueOn: null, link: { kind: "lead" } } }] }], count: 2 }).tasks.length === 1);
ok("agenda: a partial count is not exact", agendaToToday({ buckets: [], count: 4, countPartial: true }).count.exact === false);

/* ----------------------------------------------------------- for you -- */
const fy = (o: Partial<Parameters<typeof buildForYou>[0]> = {}) =>
  buildForYou({
    access: access(ALL), quotes: ready([]), recommendation: ready(null), insight: ready(null), activity: ready([]), history: ready(ACTIVE),
    secretaryKind: null, hasAppointmentsToday: true, prefs: { hiddenTypes: [], dismissedIds: [] }, now: NOW, t, ...o,
  });
ok("quotes: '3 הצעות מחיר ממתינות לתשובה'", (() => {
  const v = fy({ quotes: ready([{ id: 1 }, { id: 2, validUntil: "2026-12-01" }, { id: 3 }, { id: 4, convertedToInvoice: true }, { id: 5, validUntil: "2026-11-01" }]) });
  return v.state === "ready" && v.item.title === "3 הצעות מחיר ממתינות לתשובה";
})());
ok("quotes not shown without business_documents", (() => { const v = fy({ access: access(DEFAULTS), quotes: ready([{ id: 1 }]) }); return v.state !== "ready" || v.item.type !== "quotes"; })());
ok("never repeats the secretary: a lead activity is skipped while the secretary shows leads", (() => {
  const v = fy({ secretaryKind: "lead", activity: ready([{ id: "lead:1", kind: "lead", title: "ליד חדש", detail: null, at: NOW.toISOString(), href: "/leads/1" }]) });
  return v.state !== "ready" || v.item.type !== "activity";
})());
ok("state A: a brand-new business is introduced to a tool it already has", (() => { const v = fy({ history: ready(NEVER) }); return v.state === "ready" && v.item.type === "tool"; })());
ok("a hidden type is never shown; nothing true → none (no filler)", fy({ prefs: { hiddenTypes: ["tool"], dismissedIds: [] }, history: ready(NEVER) }).state === "none");
ok("waits for its sources (no item swap under the finger)", fy({ insight: LOADING }).state === "loading");
ok("waitingQuotes ignores converted and expired", waitingQuotes([{ id: 1, convertedToInvoice: true }, { id: 2, validUntil: "2026-01-01" }, { id: 3 }], NOW) === 1);

/* ------------------------------------------------------ create sheet -- */
ok("state B: '+' lists only permitted actions (no billing → no invoice / payment request)", (() => {
  const keys = createActionsFor(access([], "general")).map((a) => a.key);
  return !keys.includes("invoice") && !keys.includes("payment-request") && !keys.includes("task") && keys.includes("lead");
})());
ok("'+' leads with what the business kind creates most", createActionsFor(access(ALL, "booking"))[0].key === "appointment");
ok("'+' never lists coming-soon entries", createActionsFor(access(ALL)).every((a) => !a.href.startsWith("/content")));

/* -------------------------------------------------------------- tools -- */
ok("tools: OFF features and coming-soon tools are not 'available'", (() => {
  const keys = availableTools(TOOLS, access(DEFAULTS)).map((t) => t.key);
  return !keys.includes("service-desk") && !keys.includes("content") && keys.includes("calendar");
})());
ok("tools: billing OFF hides invoices and collection", (() => { const keys = availableTools(TOOLS, access(["documents"])).map((t) => t.key); return !keys.includes("invoices") && !keys.includes("collection"); })());
ok("state B: a limited business gets the simple grid", availableTools(TOOLS, access(["documents"])).length <= SIMPLE_TOOLS_MAX);
ok("state E: a broad business gets favourites + search + categories", availableTools(TOOLS, access(ALL)).length > SIMPLE_TOOLS_MAX);
ok("'יכולות נוספות' = exactly the tools not available", (() => {
  const a = access(DEFAULTS);
  return availableTools(TOOLS, a).length + inactiveTools(TOOLS, a).length === TOOLS.length;
})());

/* ------------------------------------------- owner decisions 18.11 -- */
ok("decision 1: without appointments the יומן tab opens the Secretary calendar (tasks + due dates), never 'not active'", DAY_CALENDAR_FALLBACK === "/secretary?screen=calendar");
ok("decision 1: the tab is active on that calendar, and only there", isResolvedActive("/secretary", "?screen=calendar", DAY_CALENDAR_FALLBACK, isNavActive) && !isResolvedActive("/secretary", "", DAY_CALENDAR_FALLBACK, isNavActive));
ok("decision 1: with appointments the tab is active on /calendar sub-screens", isResolvedActive("/calendar/manage", "", "/calendar", isNavActive));
ok("decision 3: conversations and documents lead the simple grid", (() => { const o = simpleToolOrder(availableTools(TOOLS, access(["documents", "inbox"]))).map((t) => t.key); return o[0] === "conversations" && o[1] === "documents"; })());
ok("decision 3: conversations and documents lead the default favourites of every kind", (["service", "booking", "sales", "general"] as const).every((k) => {
  const f = favoriteTools(availableTools(TOOLS, access(ALL, k)), k, null).map((t) => t.key);
  return f[0] === "conversations" && f[1] === "documents";
}));
ok("decision 3: an OFF inbox is never a favourite", !favoriteTools(availableTools(TOOLS, access(["documents"])), "general", null).some((t) => t.key === "conversations"));
ok("decision 4: a 'later' from a past day is dropped; 'not relevant' kept; size capped", (() => {
  const d = pruneDismissals({ a: { mode: "later", day: "2026-11-17" }, b: { mode: "later", day: "2026-11-18" }, c: { mode: "dismiss" } }, "2026-11-18");
  const big = pruneDismissals(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, { mode: "dismiss" as const }])), "2026-11-18");
  return !("a" in d) && "b" in d && "c" in d && Object.keys(big).length === 30 && "k39" in big;
})());

if (failed > 0) {
  console.error(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll HOME v4 model tests passed.");
