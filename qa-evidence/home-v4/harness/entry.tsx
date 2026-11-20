/**
 * HOME v4 browser harness — renders the REAL components (ShellChrome + floating BottomBar + HomeV4 with its real
 * data hook, MyToolsScreen, MoreCapabilitiesScreen) against a mocked `fetch`. Each "state" is an isolated,
 * synthetic API world (no database, no Production data). Selected by ?state=…&screen=home|tools|more.
 */
import { createRoot } from "react-dom/client";

import { ShellChrome } from "@/components/navigation/shell-chrome";
import { AccessibilityFab } from "@/components/ui/accessibility/accessibility-fab";
import { HomeV4 } from "@/features/home/v4/home-v4";
import { useHomeV4Data } from "@/features/home/v4/use-home-v4-data";
import { MyToolsScreen } from "@/features/tools/my-tools-screen";
import { MoreCapabilitiesScreen } from "@/features/tools/more-capabilities-screen";

type W = Window & { __nav: string[]; __path: string; __requests: string[] };
const w = window as unknown as W;
w.__nav = [];
w.__requests = [];

const params = new URLSearchParams(location.search);
const STATE = params.get("state") ?? "hero";
const SCREEN = params.get("screen") ?? "home";
w.__path = SCREEN === "tools" ? "/tools" : SCREEN === "more" ? "/tools/more" : "/app";
try { localStorage.clear(); localStorage.setItem("token", "harness-token"); } catch { /* */ }

/* ---------------------------------------------------------------- time -- */
const NOW = new Date();
const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit" }).format(NOW);
/** An instant today at HH:MM Israel time (Israel is UTC+2 in November). */
const at = (hh: number, mm = 0) => new Date(`${dayKey}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+02:00`).toISOString();

/* ------------------------------------------------------------ builders -- */
const DEFAULT_ON = ["documents", "billing", "inbox", "inventory", "content", "pricing", "revenue", "whatsapp", "starter_bot", "reports", "daily_tasks", "appointments"];
const caps = (on: string[]) => ({
  businessId: 4242,
  features: Object.fromEntries(
    [...DEFAULT_ON, "service_desk", "business_documents", "owner_recommendations"].map((k) => [k, { allowed: on.includes(k), reasonCode: "CATALOG_DEFAULT", reasonLabel: "" }]),
  ),
});
const history = (any: boolean) => ({
  income: any, expenses: any, obligations: any, collection: any, documents: any, leads: any, conversations: any,
  inventory: any, insights: any, identityDescription: any, whatsapp: "NEVER",
});
const briefingEmpty = { state: "CALM", oriented: true, attention: [], watching: [], counts: { open: 0, attention: 0, breakToday: 0, watching: 0 }, generatedAt: NOW.toISOString() };
const leadItems = (n: number) => Array.from({ length: n }, (_, i) => ({
  itemId: `leads:new_unhandled:${i + 1}`, domain: "leads", semanticCategory: "lead", title: `פנייה חדשה ${i + 1}`, summary: "ממתינה למענה",
  severity: "MEDIUM", priorityScore: 50, entityRef: { type: "lead", id: i + 1 }, primaryAction: { href: `/leads/${i + 1}`, label: "צפייה" },
}));
const payableItems = (n: number) => Array.from({ length: n }, (_, i) => ({
  itemId: `payables:overdue:${i + 1}`, domain: "payables", semanticCategory: "payment", title: `תשלום לספק ${i + 1}`, summary: "מועד התשלום עבר",
  severity: "HIGH", priorityScore: 90, entityRef: null, primaryAction: { href: `/payables/${i + 1}`, label: "טיפול" },
}));
const waitingCollection = (n: number) => Array.from({ length: n }, (_, i) => ({ requestId: i + 1, customerName: `לקוח ${i + 1}`, invoiceNumber: null, amount: "450.00", currency: "ILS", createdAt: at(8) }));
const appt = (id: number, hh: number, mm: number, title: string, customer: string | null = null) => ({
  id, status: "CONFIRMED", kind: "CUSTOMER", startsAt: at(hh, mm), endsAt: at(hh + 1, mm), durationMinutes: 60, title, customerName: customer,
});
const agenda = (n: number) => ({
  buckets: [{ bucket: "TODAY", title: "היום", rows: Array.from({ length: n }, (_, i) => ({ type: "TASK", key: `t${i}`, bucket: "TODAY", pinned: false, tags: [], task: { id: i + 1, title: `משימה ${i + 1}`, dueOn: dayKey, link: null } })) }],
  count: n, countPartial: false,
});
const quotes = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1, number: 100 + i, customerName: `לקוח ${i + 1}`, total: "1200", currency: "ILS", validUntil: null, convertedToInvoice: false }));
const cases = (open: number, closed = 2) => ({
  cases: [...Array.from({ length: open }, (_, i) => ({ id: 100 - i, status: i % 2 ? "IN_REPAIR" : "OPEN" })), ...Array.from({ length: closed }, (_, i) => ({ id: 50 - i, status: "DELIVERED" }))],
  nextBeforeId: null,
});

type World = Record<string, unknown | { __status: number } | { __pending: true }>;
const FAIL = { __status: 500 };
const PENDING = { __pending: true };

function world(opts: {
  on: string[]; category: string; history: boolean; month?: string; today?: string; status?: unknown[]; collection?: unknown[];
  appointments?: unknown[]; agenda?: unknown; quotes?: unknown[]; cases?: unknown; docsPending?: number; insight?: unknown[];
}): World {
  return {
    "/api/home": { businessSnapshot: { businessName: "העסק שלי", ownerName: "דנה" } },
    "/api/business/capabilities": caps(opts.on),
    "/api/business/profile": { success: true, hasProfile: true, profile: { category: opts.category, businessModel: "service" } },
    "/api/home/collection": { current: { total: opts.today ?? "0.00", isMixedCurrency: false }, month: { amount: opts.month ?? "0.00", isMixedCurrency: false } },
    "/api/obligations/briefing": briefingEmpty,
    "/api/business-status": { items: opts.status ?? [] },
    "/api/collection/inbox": { waiting: opts.collection ?? [], paid: [] },
    "/api/leads": { leads: [] },
    "/api/documents/inbox": { items: [], financialPulse: { inboxDocumentCounts: { totalPendingReview: opts.docsPending ?? 0 } } },
    "/api/tasks/agenda": opts.agenda ?? agenda(0),
    "/api/appointments": { appointments: opts.appointments ?? [] },
    "/api/service-desk/cases": opts.cases ?? cases(0, 0),
    "/api/business-documents/quotes": { quotes: opts.quotes ?? [] },
    "/api/outcomes/recommendations": { enabled: false },
    "/api/insights": { insights: opts.insight ?? [] },
    "/api/business-cost/summary": { insights: [], periods: { today: { cashOut: "0" } }, upcoming: { overdue: [], next30Days: [] } },
    "/api/home/history": history(opts.history),
    "/api/business/setup": { needsSetup: false },
    "/api/notifications/unread-count": { unreadCount: opts.history ? 3 : 0 },
    "/api/inbox/attention": { waitingForReply: [] },
    "/api/auth/me": { id: 1, email: "x", name: "דנה", businessId: 4242, businessName: "העסק שלי" },
  };
}

const ALL = [...DEFAULT_ON, "service_desk", "business_documents"];
const WORLDS: Record<string, () => World> = {
  // The reference image, on real-shaped data: a service business with leads, meetings and quotes.
  hero: () => world({
    on: ALL, category: "Device Repair", history: true, month: "12450.00", today: "860.00",
    status: leadItems(2), collection: waitingCollection(1),
    appointments: [appt(1, 11, 30, "פגישה עם לקוח"), appt(2, 13, 0, "מסירת מכשיר", "יוסי כהן"), appt(3, 16, 0, "בדיקת מזגן", "רינה לוי")],
    agenda: agenda(3), quotes: quotes(3), cases: cases(8),
  }),
  // A — brand new business: nothing ever happened.
  A: () => world({ on: DEFAULT_ON, category: "Beauty", history: false }),
  // B — limited plan: documents + inbox only (no billing, tasks, calendar, inventory).
  B: () => {
    const wld = world({ on: ["documents", "inbox"], category: "Other", history: true, status: leadItems(1), docsPending: 2 });
    return wld;
  },
  // C — service & repairs: service desk ON; open calls, payments overdue, collection waiting.
  C: () => world({
    on: ALL, category: "Automotive", history: true, month: "8320.00", status: payableItems(2), collection: waitingCollection(3),
    appointments: [appt(1, 10, 0, "מסירת רכב", "משה לוי")], agenda: agenda(2), cases: cases(5),
  }),
  // D — customers, leads and meetings (no service desk).
  D: () => world({
    on: [...DEFAULT_ON, "business_documents"], category: "Professional Services", history: true, month: "21900.00",
    status: leadItems(4), appointments: [appt(1, 12, 0, "פגישת היכרות", "נועה ברק"), appt(2, 15, 30, "פגישת המשך", "אבי מור")], agenda: agenda(1), quotes: quotes(2),
  }),
  // E — very busy, broad plan.
  E: () => world({
    on: [...ALL, "owner_recommendations"], category: "Home Services", history: true, month: "148230.00",
    status: [...payableItems(6), ...leadItems(8)], collection: waitingCollection(24),
    appointments: Array.from({ length: 9 }, (_, i) => appt(i + 1, 10 + i, 0, `ביקור טכנאי ${i + 1}`, `לקוח ${i + 1}`)),
    agenda: agenda(17), quotes: quotes(11), cases: { ...cases(100, 0), nextBeforeId: 1 }, docsPending: 14,
    insight: [{ title: "ההכנסות בנובמבר גבוהות ב־12% מאוקטובר", interpretation: "רוב הגידול מקריאות שירות חוזרות." }],
  }),
  // F — an active business on a day with nothing planned.
  F: () => world({ on: DEFAULT_ON, category: "Fitness", history: true, month: "6400.00", status: leadItems(1), appointments: [], agenda: agenda(0) }),
  // G — nothing for the secretary (all sources answered, nothing waiting).
  G: () => world({ on: DEFAULT_ON, category: "Retail", history: true, month: "3150.00", appointments: [appt(1, 14, 0, "קבלת סחורה")], agenda: agenda(2) }),
  // H — partial failure: receipts, briefing and the calendar fail; the rest still works.
  H: () => ({
    ...world({ on: DEFAULT_ON, category: "Food", history: true, status: leadItems(2), agenda: agenda(2) }),
    "/api/home/collection": FAIL, "/api/obligations/briefing": FAIL, "/api/appointments": FAIL, "/api/insights": FAIL, "/api/business-cost/summary": FAIL,
  }),
  // H2 — first load: nothing has answered yet.
  loading: () => {
    const wld = world({ on: DEFAULT_ON, category: "Food", history: true });
    for (const k of Object.keys(wld)) if (k !== "/api/home") wld[k] = PENDING;
    return wld;
  },
  // H3 — capabilities unknown: everything module-bound fails closed.
  capsfail: () => ({ ...world({ on: DEFAULT_ON, category: "Food", history: true, status: leadItems(1) }), "/api/business/capabilities": FAIL }),
  // tools: broad plan
  broad: () => world({ on: [...ALL, "owner_recommendations"], category: "Home Services", history: true }),
};

const W0 = (WORLDS[STATE] ?? WORLDS.hero)();
const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
  const i = url.pathname.indexOf("/api/");
  if (i < 0) return realFetch(input as RequestInfo, init);
  const pathname = url.pathname.slice(i);
  w.__requests.push(pathname + url.search);
  const body = W0[pathname];
  if (body === undefined) return new Response(JSON.stringify({ error: "not mocked" }), { status: 404 });
  if (body && typeof body === "object" && "__pending" in body) return new Promise<Response>(() => undefined);
  if (body && typeof body === "object" && "__status" in body) return new Response(JSON.stringify({ error: "boom" }), { status: (body as { __status: number }).__status });
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
};

function HomeHarness() {
  const { data, retry } = useHomeV4Data(true);
  return <HomeV4 data={data} retry={retry} businessName="העסק שלי" />;
}

function App() {
  return (
    <>
      <ShellChrome>
        {SCREEN === "tools" ? <MyToolsScreen /> : SCREEN === "more" ? <MoreCapabilitiesScreen /> : <HomeHarness />}
      </ShellChrome>
      {/* As in app/layout.tsx: the floating accessibility button, which keeps itself clear of the bar. */}
      <AccessibilityFab />
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
