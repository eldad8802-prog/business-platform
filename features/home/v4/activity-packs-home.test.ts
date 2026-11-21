/**
 * Activity packs × HOME v4 — run:
 *   npx tsx features/home/v4/activity-packs-home.test.ts
 *
 * Pure (no DB / network / I/O). The owner-approved phase 2 rules:
 *   P1  no selection (feature OFF, or never chose) = the pre-packs Home, byte for byte (accounts unchanged);
 *   P2  each of the five packs puts its own pair, "+" order, tools and bar slot first;
 *   P3  a pack only REORDERS what feature access and the person's scope already allow — it never adds;
 *   P4  a business with several packs: the primary decides the frame, each additional pack adds one of each;
 *   P5  the bar's second slot follows the primary pack and the capabilities (service → קריאות only while ON);
 *   P6  FREE_LIMITED: one status line + one plan card, only allowed "+" actions with one note (test data only);
 *   P7  the secretary: packs rank kinds only among items of the SAME urgency; ready-for-pickup only with packs.
 */
import { he } from "@/lib/i18n/messages/he";
import { en } from "@/lib/i18n/messages/en";
import { createTranslator } from "@/lib/i18n/translate";
import type { HomeHistory } from "@/lib/services/home/home-history-model";
import {
  ACTIVITY_PACK_KEYS,
  businessModelFor,
  parseActivitySelection,
  selectionFromRow,
  suggestionFor,
  type ActivitySelection,
} from "@/lib/activity-packs/activity-packs";
import { BUSINESS_CATEGORY_OPTIONS } from "@/lib/business/business-categories";
import { TOOLS } from "@/lib/navigation/home-routes";
import { NAV_DESTINATIONS, PRIMARY_DESTINATIONS, primaryDestinationsFor } from "@/components/navigation/nav-destinations";

import { LOADING, ready, type WaitingItem, type WaitingModel } from "../v3/home-v3-model";
import {
  activityFromCapabilities,
  planHrefFromCapabilities,
  resolveUserPermissions,
  subscriptionFromCapabilities,
  type HomeAccess,
  type HomeModule,
  type HomeScope,
} from "./home-access";
import { PACK_HOME, barSlotFor } from "./activity-packs-home";
import {
  CREATE_ACTIONS,
  METRICS,
  availableTools,
  buildForYou,
  buildSecretary,
  createActionsFor,
  createLimitedNote,
  favoriteTools,
  metricLabelKey,
  metricOrder,
  serviceCasesSummary,
} from "./home-v4-model";

const t = createTranslator(he);
const tEn = createTranslator(en);
let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else {
    failed += 1;
    console.error(`FAIL: ${name}`, extra ?? "");
  }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const NOW = new Date("2026-11-18T07:00:00Z");
const ALL: HomeModule[] = ["billing", "documents", "inventory", "inbox", "daily_tasks", "appointments", "service_desk", "business_documents", "owner_recommendations", "starter_bot", "revenue"];
const DEFAULTS: HomeModule[] = ["billing", "documents", "inventory", "inbox", "daily_tasks", "appointments", "starter_bot", "revenue"];
const KINDS: HomeAccess["kind"][] = ["service", "booking", "sales", "general"];

function sel(primary: ActivitySelection["primary"], ...additional: ActivitySelection["additional"][number][]): ActivitySelection {
  return { primary, additional };
}
function access(modules: HomeModule[], activity: ActivitySelection | null = null, extra: Partial<HomeAccess> = {}): HomeAccess {
  return { businessId: 7, modules: new Set(modules), kind: "general", permissions: resolveUserPermissions(), activity, ...extra };
}

/* ----------------------------------------------------- selection basics -- */

ok("five packs, fixed order", eq(ACTIVITY_PACK_KEYS, ["APPOINTMENTS", "SERVICE", "INVENTORY", "LEADS", "ORDERS"]));
ok("parse: valid", eq(parseActivitySelection({ primary: "SERVICE", additional: ["INVENTORY"] }), { ok: true, value: sel("SERVICE", "INVENTORY") }));
ok("parse: primary and duplicates dropped from additional", eq(parseActivitySelection({ primary: "LEADS", additional: ["LEADS", "ORDERS", "ORDERS"] }), { ok: true, value: sel("LEADS", "ORDERS") }));
ok("parse: missing additional = none", eq(parseActivitySelection({ primary: "ORDERS" }), { ok: true, value: sel("ORDERS") }));
ok("parse: unknown primary refused", parseActivitySelection({ primary: "GYM" }).ok === false);
ok("parse: unknown additional refuses the whole input", parseActivitySelection({ primary: "LEADS", additional: ["X"] }).ok === false);
ok("parse: non-array additional refused", parseActivitySelection({ primary: "LEADS", additional: "ORDERS" }).ok === false);
ok("parse: null / array refused", parseActivitySelection(null).ok === false && parseActivitySelection([]).ok === false);
ok("row → selection; malformed row → null", eq(selectionFromRow({ primaryPack: "INVENTORY", additionalPacks: [] }), sel("INVENTORY")) && selectionFromRow({ primaryPack: "?", additionalPacks: [] }) === null && selectionFromRow(null) === null);

// Suggestions: every suggested category exists in the onboarding map; "Other" suggests nothing.
const categoryValues = new Set(BUSINESS_CATEGORY_OPTIONS.map((c) => c.value));
ok("suggestions only for real categories", ["Beauty", "Fitness", "Food", "Home Services", "Events", "Retail", "Automotive", "Device Repair", "Installations", "IT Services", "Professional Services"].every((c) => categoryValues.has(c) && suggestionFor(c) !== null));
ok("Other / unknown / empty suggests nothing", suggestionFor("Other") === null && suggestionFor("Nope") === null && suggestionFor(null) === null);
ok("Beauty → appointments", eq(suggestionFor("Beauty"), sel("APPOINTMENTS")));
ok("Automotive → service + inventory", eq(suggestionFor("Automotive"), sel("SERVICE", "INVENTORY")));
ok("Food / Catering → orders + inventory (sub-category wins)", eq(suggestionFor("Food", "Catering"), sel("ORDERS", "INVENTORY")) && eq(suggestionFor("Food", "Bakery"), sel("INVENTORY")));
ok("business model derived only from packs", businessModelFor(sel("INVENTORY")) === "product" && businessModelFor(sel("APPOINTMENTS")) === "service" && businessModelFor(sel("SERVICE", "INVENTORY")) === "hybrid");

/* ------------------------------------------- capabilities → access layer -- */

const capsOn = (activity: unknown) => ({ features: { activity_packs: { allowed: true } }, activity });
ok("feature OFF → no selection even if a selection is sent", activityFromCapabilities({ features: { activity_packs: { allowed: false } }, activity: { primary: "LEADS", additional: [] } }) === null);
ok("feature absent → no selection", activityFromCapabilities({ features: {} }) === null && activityFromCapabilities(null) === null);
ok("feature ON + never chose → no selection", activityFromCapabilities(capsOn(null)) === null);
ok("feature ON + garbage → no selection (fail closed)", activityFromCapabilities(capsOn({ primary: "X" })) === null);
ok("feature ON + valid → selection", eq(activityFromCapabilities(capsOn({ primary: "SERVICE", additional: ["INVENTORY"] })), sel("SERVICE", "INVENTORY")));
ok("subscription: only FREE_LIMITED is read", subscriptionFromCapabilities({ subscription: { state: "FREE_LIMITED" } }) === "FREE_LIMITED" && subscriptionFromCapabilities({ subscription: { state: "ACTIVE" } }) === null && subscriptionFromCapabilities({}) === null);
ok("plan link: in-app path only", planHrefFromCapabilities({ subscription: { manageHref: "/settings/plan" } } as never) === "/settings/plan" && planHrefFromCapabilities({ subscription: { manageHref: "https://x" } } as never) === null && planHrefFromCapabilities({ subscription: { manageHref: "//x" } } as never) === null);

/* ------------------------------------------------ P1: accounts unchanged -- */

for (const kind of KINDS) {
  for (const mods of [ALL, DEFAULTS, ["billing"] as HomeModule[], [] as HomeModule[]]) {
    const legacy: HomeAccess = { businessId: 7, modules: new Set(mods), kind, permissions: resolveUserPermissions() };
    const withNull: HomeAccess = { ...legacy, activity: null, subscription: null };
    ok(`P1 metrics unchanged (${kind}, ${mods.length})`, eq(metricOrder(legacy, null), metricOrder(withNull, null)));
    ok(`P1 no pack-only metric (${kind}, ${mods.length})`, !metricOrder(withNull, null).some((k) => k === "lowStock" || k === "readyForPickup"));
    ok(`P1 "+" unchanged (${kind}, ${mods.length})`, eq(createActionsFor(legacy).map((a) => a.key), createActionsFor(withNull).map((a) => a.key)));
    ok(`P1 no "קריאה חדשה" without packs (${kind}, ${mods.length})`, !createActionsFor(withNull).some((a) => a.key === "service-case"));
    const av = availableTools(TOOLS, legacy);
    ok(`P1 favourites unchanged (${kind}, ${mods.length})`, eq(favoriteTools(av, kind, null).map((x) => x.key), favoriteTools(av, kind, null, null).map((x) => x.key)));
  }
}
ok("P1 bar without packs = today's bar", barSlotFor(null, new Set(ALL)) === "calendar" && primaryDestinationsFor("calendar") === PRIMARY_DESTINATIONS);
ok("P1 label without packs = פגישות היום", t(metricLabelKey("todayAppointments", access(DEFAULTS)) as never) === "פגישות היום");

/* -------------------------------------------------- P2: the five packs -- */

const pair = (a: HomeAccess) => metricOrder(a, null).slice(0, 2);
ok("P2 appointments: תורים היום + תקבולים היום", eq(pair(access(DEFAULTS, sel("APPOINTMENTS"))), ["todayAppointments", "receiptsToday"]));
ok("P2 appointments label = תורים היום", t(metricLabelKey("todayAppointments", access(DEFAULTS, sel("APPOINTMENTS"))) as never) === "תורים היום");
ok("P2 appointments label has English", tEn(metricLabelKey("todayAppointments", access(DEFAULTS, sel("APPOINTMENTS"))) as never) === "Bookings today");
ok("P2 leads keeps פגישות היום (consultant)", t(metricLabelKey("todayAppointments", access(DEFAULTS, sel("LEADS"))) as never) === "פגישות היום");
ok("P2 service (desk ON): קריאות פתוחות + מוכנים למסירה", eq(pair(access(ALL, sel("SERVICE"))), ["openService", "readyForPickup"]));
ok("P2 service (desk OFF): falls to תקבולים היום + מלאי נמוך", eq(pair(access(DEFAULTS, sel("SERVICE"))), ["receiptsToday", "lowStock"]));
ok("P2 inventory: תקבולים היום + מלאי נמוך", eq(pair(access(DEFAULTS, sel("INVENTORY"))), ["receiptsToday", "lowStock"]));
ok("P2 leads: פניות ממתינות + ממתין לגבייה", eq(pair(access(DEFAULTS, sel("LEADS"))), ["waitingLeads", "toCollect"]));
ok("P2 orders: פניות ממתינות + ממתין לגבייה (no events model)", eq(pair(access(DEFAULTS, sel("ORDERS"))), ["waitingLeads", "toCollect"]));

const first = (a: HomeAccess) => createActionsFor(a)[0]?.key;
ok("P2 '+' appointments starts with קביעת תור", first(access(DEFAULTS, sel("APPOINTMENTS"))) === "appointment");
ok("P2 '+' service (desk ON) starts with קריאה חדשה", first(access(ALL, sel("SERVICE"))) === "service-case");
ok("P2 '+' inventory starts with חשבונית חדשה then מוצר חדש", eq(createActionsFor(access(DEFAULTS, sel("INVENTORY"))).slice(0, 2).map((a) => a.key), ["invoice", "product"]));
ok("P2 '+' leads starts with ליד חדש", first(access(DEFAULTS, sel("LEADS"))) === "lead");
ok("P2 '+' orders: ליד, חשבונית, בקשת תשלום (no orders action)", eq(createActionsFor(access(DEFAULTS, sel("ORDERS"))).slice(0, 3).map((a) => a.key), ["lead", "invoice", "payment-request"]));

const favs = (a: HomeAccess) => favoriteTools(availableTools(TOOLS, a), a.kind, null, a.activity ?? null).map((x) => x.key);
ok("P2 tools: the bar leavers first, then the pack's", eq(favs(access(DEFAULTS, sel("APPOINTMENTS"))).slice(0, 3), ["conversations", "documents", "calendar"]));
ok("P2 tools service (desk ON) put שירות ואחריות first", favs(access(ALL, sel("SERVICE")))[2] === "service-desk");
ok("P2 tools: the owner's own favourites still win", eq(favoriteTools(availableTools(TOOLS, access(DEFAULTS, sel("LEADS"))), "general", ["invoices"], sel("LEADS")).map((x) => x.key), ["invoices"]));

/* --------------------------------------- P3: packs never add capability -- */

for (const p of ACTIVITY_PACK_KEYS) {
  for (const mods of [ALL, DEFAULTS, ["billing"] as HomeModule[], [] as HomeModule[]]) {
    const a = access(mods, sel(p));
    ok(`P3 ${p}/${mods.length}: every metric is permitted`, metricOrder(a, null).every((k) => (METRICS[k].req.modules ?? []).every((m) => a.modules.has(m))));
    ok(`P3 ${p}/${mods.length}: every action is permitted`, createActionsFor(a).every((x) => (x.req.modules ?? []).every((m) => a.modules.has(m))));
    ok(`P3 ${p}/${mods.length}: same set of actions as feature access allows`, eq(createActionsFor(a).map((x) => x.key).sort(), CREATE_ACTIONS.filter((x) => (x.req.modules ?? []).every((m) => a.modules.has(m))).map((x) => x.key).sort()));
  }
}
ok("P3 desk OFF: no service metric / action / slot", !metricOrder(access(DEFAULTS, sel("SERVICE")), null).some((k) => k === "openService" || k === "readyForPickup") && !createActionsFor(access(DEFAULTS, sel("SERVICE"))).some((x) => x.key === "service-case") && barSlotFor(sel("SERVICE"), new Set(DEFAULTS)) === "calendar");
// Missing permissions: a person without the operations scope never gets operations metrics, actions or slots.
const noOps: HomeAccess = { ...access(ALL, sel("SERVICE", "INVENTORY")), permissions: { scopes: new Set<HomeScope>(["money", "customers", "documents"]) } };
ok("P3 no operations scope: no operations metric", !metricOrder(noOps, null).some((k) => METRICS[k].req.scope === "operations"));
ok("P3 no operations scope: no operations action", !createActionsFor(noOps).some((x) => x.req.scope === "operations"));
ok("P3 no operations scope: slot falls back to יומן", barSlotFor(sel("SERVICE", "INVENTORY"), new Set(ALL), noOps.permissions.scopes) === "calendar");

/* --------------------------------------------- P4: several packs at once -- */

const mixed = access(DEFAULTS, sel("APPOINTMENTS", "INVENTORY"));
ok("P4 appointments + inventory: primary keeps the pair", eq(pair(mixed), ["todayAppointments", "receiptsToday"]));
ok("P4 the additional pack adds מלאי נמוך right after the pair", metricOrder(mixed, null)[2] === "lowStock");
ok("P4 '+' gets מוצר חדש from the additional pack, after the primary's", createActionsFor(mixed).findIndex((a) => a.key === "product") > createActionsFor(mixed).findIndex((a) => a.key === "appointment"));
ok("P4 tools get מלאי from the additional pack", favs(mixed).includes("inventory"));
ok("P4 bar follows the primary only", barSlotFor(sel("APPOINTMENTS", "INVENTORY"), new Set(DEFAULTS)) === "calendar");
ok("P4 no duplicates anywhere", new Set(metricOrder(mixed, null)).size === metricOrder(mixed, null).length && new Set(createActionsFor(mixed).map((a) => a.key)).size === createActionsFor(mixed).length);
const three = access(ALL, sel("LEADS", "APPOINTMENTS", "ORDERS"));
ok("P4 three packs: pair still the primary's", eq(pair(three), ["waitingLeads", "toCollect"]));

/* ------------------------------------------------------ P5: the bar slot -- */

ok("P5 appointments → יומן", barSlotFor(sel("APPOINTMENTS"), new Set(DEFAULTS)) === "calendar");
ok("P5 service + desk ON → קריאות", barSlotFor(sel("SERVICE"), new Set(ALL)) === "service-desk");
ok("P5 service + desk OFF + inventory pack → מלאי", barSlotFor(sel("SERVICE", "INVENTORY"), new Set(DEFAULTS)) === "inventory");
ok("P5 service + desk OFF, no inventory pack → יומן", barSlotFor(sel("SERVICE"), new Set(DEFAULTS)) === "calendar");
ok("P5 service + desk OFF + inventory pack but inventory OFF → יומן", barSlotFor(sel("SERVICE", "INVENTORY"), new Set<HomeModule>(["billing"])) === "calendar");
ok("P5 inventory → מלאי; inventory OFF → יומן", barSlotFor(sel("INVENTORY"), new Set(DEFAULTS)) === "inventory" && barSlotFor(sel("INVENTORY"), new Set<HomeModule>(["billing"])) === "calendar");
ok("P5 leads → לידים", barSlotFor(sel("LEADS"), new Set(DEFAULTS)) === "leads");
ok("P5 orders → יומן (until an orders tool exists)", barSlotFor(sel("ORDERS"), new Set(ALL)) === "calendar");
for (const slot of ["service-desk", "inventory", "leads"] as const) {
  const tabs = primaryDestinationsFor(slot);
  ok(`P5 bar for ${slot}: בית · ${slot} · עדכונים · כלים`, eq(tabs.map((d) => d.key), ["home", slot, "notifications", "tools"]));
  ok(`P5 ${slot} has a short bar label in he + en`, !!tabs[1].barLabelKey && t(tabs[1].barLabelKey!) !== tabs[1].barLabelKey && tEn(tabs[1].barLabelKey!) !== tabs[1].barLabelKey);
}
ok("P5 short labels: קריאות / מלאי / לידים", t("nav.bar.serviceDesk") === "קריאות" && t("nav.bar.inventory") === "מלאי" && t("nav.bar.leads") === "לידים");
ok("P5 every pack's bar candidates are real destinations", Object.values(PACK_HOME).every((p) => p.bar.every((s) => s === "calendar" || NAV_DESTINATIONS.some((d) => d.key === s))));

/* ------------------------------------------------------- P6: FREE_LIMITED -- */

const fl = access(DEFAULTS, sel("APPOINTMENTS"), { subscription: "FREE_LIMITED" });
ok("P6 '+' only לקוח חדש + משימה חדשה", eq(createActionsFor(fl).map((a) => a.key).sort(), ["customer", "task"]));
ok("P6 '+' shows its one note", createLimitedNote(fl) === true && createLimitedNote(access(DEFAULTS, sel("APPOINTMENTS"))) === false);
ok("P6 the note has text in he + en", t("home.v4.create.limitedNote").length > 10 && tEn("home.v4.create.limitedNote").length > 10);
const NEVER: HomeHistory = { income: true, expenses: false, obligations: false, collection: true, documents: true, leads: true, conversations: false, inventory: false, insights: false, identityDescription: false, whatsapp: "NEVER" };
const fyIn = (a: HomeAccess) =>
  buildForYou({ access: a, quotes: { state: "off" }, recommendation: { state: "off" }, insight: ready(null), activity: ready([]), history: ready(NEVER), secretaryKind: null, hasAppointmentsToday: false, prefs: { hiddenTypes: [], dismissedIds: [] }, now: NOW, t });
ok("P6 בשבילך = the one plan card", fyIn(fl).state === "plan");
ok("P6 no plan card when not FREE_LIMITED", fyIn(access(DEFAULTS, sel("APPOINTMENTS"))).state !== "plan" && fyIn(access(DEFAULTS)).state !== "plan");
ok("P6 plan texts exist in he + en", ["statusLine", "statusLink", "eyebrow", "title", "body", "cta"].every((k) => t(`home.v4.plan.${k}` as never) !== `home.v4.plan.${k}` && tEn(`home.v4.plan.${k}` as never) !== `home.v4.plan.${k}`));

/* ------------------------------------------------------- P7: secretary -- */

function item(kind: WaitingItem["kind"], id: string, rank: number): WaitingItem {
  return { id, kind, tone: "todo", tag: { label: "", style: "todo" }, title: "", subtitle: null, amount: null, href: `/x/${id}`, actionLabel: "", rank };
}
function waiting(items: WaitingItem[]): WaitingModel {
  const c = (k: WaitingItem["kind"]) => ({ n: items.filter((i) => i.kind === k).length, exact: true });
  return { items, total: { n: items.length, exact: true }, byKind: { payment: c("payment"), stock: c("stock"), collection: c("collection"), lead: c("lead"), intake: c("intake") } };
}
const sec = (a: HomeAccess, items: WaitingItem[], serviceReady?: { ids: number[]; exact: boolean }) =>
  buildSecretary({ waiting: ready(waiting(items)), partial: false, access: a, history: null, dismissals: {}, now: NOW, t, serviceReady });
const sameRank = [item("collection", "c1", 2), item("lead", "l1", 2)];
const kindOf = (v: ReturnType<typeof sec>) => (v.state === "ready" ? v.kind : v.state);
ok("P7 without packs: source order (collection first)", kindOf(sec(access(DEFAULTS), sameRank)) === "collection");
ok("P7 leads pack: lead first among the same urgency", kindOf(sec(access(DEFAULTS, sel("LEADS")), sameRank)) === "lead");
ok("P7 appointments pack: collection first", kindOf(sec(access(DEFAULTS, sel("APPOINTMENTS")), sameRank)) === "collection");
ok("P7 a more urgent item is never pushed down by a pack", kindOf(sec(access(DEFAULTS, sel("LEADS")), [item("payment", "p1", 0), ...sameRank])) === "payment");
ok("P7 ready-for-pickup only with packs + desk ON", kindOf(sec(access(ALL, sel("SERVICE")), [], { ids: [5], exact: true })) === "serviceReady" && kindOf(sec(access(ALL), [], { ids: [5], exact: true })) !== "serviceReady" && kindOf(sec(access(DEFAULTS, sel("SERVICE")), [], { ids: [5], exact: true })) !== "serviceReady");
const ready1 = sec(access(ALL, sel("SERVICE")), [], { ids: [5], exact: true });
ok("P7 one ready case opens that case", ready1.state === "ready" && ready1.href === "/service-desk/cases/5" && ready1.title === "קריאה אחת מוכנה למסירה");
const ready2 = sec(access(ALL, sel("SERVICE")), [], { ids: [5, 6], exact: true });
ok("P7 several open the Service Desk", ready2.state === "ready" && ready2.href === "/service-desk" && ready2.title === "2 קריאות מוכנות למסירה");
const flSec = sec(access(DEFAULTS, sel("APPOINTMENTS"), { subscription: "FREE_LIMITED" }), [item("collection", "c1", 2)]);
ok("P7 FREE_LIMITED collection says the reminder returns with a plan", flSec.state === "ready" && flSec.body === t("home.v4.secretary.kind.collection.bodyLimited") && flSec.cta === t("home.v4.secretary.kind.collection.ctaLimited"));
ok("P7 loading stays loading", sec(access(DEFAULTS, sel("LEADS")), []).state === "calm" && buildSecretary({ waiting: LOADING, partial: false, access: access(DEFAULTS, sel("LEADS")), history: null, dismissals: {}, now: NOW, t }).state === "loading");

const summary = serviceCasesSummary({ cases: [{ id: 1, status: "READY" }, { id: 2, status: "OPEN" }, { id: 3, status: "DELIVERED" }, { id: 4, status: "READY" }], nextBeforeId: null });
ok("cases summary: open counts READY too (unchanged rule), ready = READY only", summary.open.n === 3 && summary.ready.n === 2 && eq(summary.readyIds, [1, 4]) && summary.ready.exact);
ok("cases summary: a cut page is not exact", serviceCasesSummary({ cases: [], nextBeforeId: 9 }).ready.exact === false);

/* ------------------------------------------------------------- i18n -- */

for (const k of ["lowStock", "readyForPickup"] as const) {
  ok(`i18n metric ${k} he + en`, ["label", "meaning", "zero"].every((p) => t(`home.v4.snapshot.metric.${k}.${p}` as never) !== `home.v4.snapshot.metric.${k}.${p}` && tEn(`home.v4.snapshot.metric.${k}.${p}` as never) !== `home.v4.snapshot.metric.${k}.${p}`));
}
ok("i18n '+' קריאה חדשה he + en", t("home.v4.create.action.serviceCase") === "קריאה חדשה" && tEn("home.v4.create.action.serviceCase") !== "home.v4.create.action.serviceCase");
for (const p of [...ACTIVITY_PACK_KEYS, "SERVICE_OFF"]) {
  ok(`i18n pack ${p} he + en`, ["name", "desc"].every((part) => t(`account.settings.activityPacks.pack.${p}.${part}` as never) !== `account.settings.activityPacks.pack.${p}.${part}` && tEn(`account.settings.activityPacks.pack.${p}.${part}` as never) !== `account.settings.activityPacks.pack.${p}.${part}`));
}

if (failed > 0) {
  console.error(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\nactivity-packs-home: all checks passed");
