/**
 * HOME v3 view-model — run:
 *   npx tsx features/home/v3/home-v3-model.test.ts
 *
 * Guards the truth rules the approved Home design must keep:
 *   - no count is shown as exact when a source may have cut it;
 *   - net is computed only from real income and real expenses;
 *   - the hourly view never invents per-hour expenses;
 *   - a week is drawn only when all seven days are known;
 *   - the stock bar uses the threshold scale (full = 2 × minimum), clamped.
 */
import type { BusinessStatusItem } from "@/lib/business-status/types";
import type { BriefingApi } from "@/lib/obligations/secretary-client";

import {
  barPx,
  barScale,
  buildActivity,
  buildDaySeries,
  buildStockRows,
  buildUpcomingRows,
  buildWaiting,
  leadsWaitingClaim,
  buildWeekSeries,
  chartAxis,
  countText,
  formatShekel,
  netOf,
  shiftDateKey,
  waitingSentence,
  type CollectionWaitingWire,
} from "./home-v3-model";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else {
    failed += 1;
    console.error(`FAIL: ${name}`, extra ?? "");
  }
}

/* ---------------------------------------------------------------- money -- */
ok("shekel groups like the references", formatShekel(12700) === "₪12,700");
ok("negative net keeps its sign", formatShekel(-1200) === "−₪1,200");
ok("zero is never negative", formatShekel(-0.2) === "₪0");

/* ------------------------------------------------------------ day series -- */
const hours = Array.from({ length: 24 }, (_, h) => (h === 12 ? "2350.00" : h === 23 ? "500.00" : h >= 6 && h <= 21 ? "100.00" : "0"));
const noon = new Date("2026-10-05T09:30:00Z"); // 12:30 Israel (UTC+3)
const day = buildDaySeries({ hours, incomeTotal: "4450.00", expenseToday: "980.00", now: noon });
ok("16 hourly bars, 06:00 → 21:00", day.bars.length === 16 && day.bars[0].label === "06:00" && day.bars[15].label === "21:00");
ok("hour 12 carries its own income", day.bars[6].income === 2350);
ok("no bar invents an hourly expense", day.bars.every((b) => b.expense === null) && day.expenseByBar === false);
ok("the day total keeps money outside 06–21", day.income === 4450);
ok("net = income − expense, from the two real totals", netOf(day) === 4450 - 980);
ok("the current Israeli hour is selected", day.defaultIndex === 6);
const night = buildDaySeries({ hours, incomeTotal: "0", expenseToday: null, now: new Date("2026-10-05T01:00:00Z") });
ok("before 06:00 the first bar is selected", night.defaultIndex === 0);
ok("unknown expense → no net at all", netOf(night) === null);

/* ----------------------------------------------------------- week series -- */
const keys = Array.from({ length: 7 }, (_, i) => shiftDateKey("2026-10-05", i - 6));
ok("week keys end today", keys[6] === "2026-10-05" && keys[0] === "2026-09-29");
const week = buildWeekSeries({
  cumulativeIncome: ["100", "100", "350", "350", "1000", "1000", "1200"],
  incomeTotal: "1200",
  dayKeys: keys,
  expenses: ["0", "50", "0", "0", "300", "0", "20"],
});
ok("week bars are the exact daily differences", week !== null && week.bars.map((b) => b.income).join(",") === "100,0,250,0,650,0,200");
ok("week expenses sum the seven days", week?.expense === 370);
ok("a week with one unknown day is not drawn", buildWeekSeries({ cumulativeIncome: ["1", "1", "1", "1", "1", "1", "1"], incomeTotal: "1", dayKeys: keys, expenses: ["0", "0", "", "0", "0", "0", "0"] }) === null);

/* ----------------------------------------------------------- bar scaling -- */
const refBars = [200, 350, 600, 900, 1150, 1400, 2350, 1500].map((v, i) => ({ key: String(i), label: "", income: v, expense: [150, 300, 250, 400, 200, 350, 980, 500][i] }));
const s = barScale(refBars, 98, 48);
ok("mobile reference: ₪2,350 fills the income area (96px)", barPx(2350, s) === 96);
ok("mobile reference: ₪980 fits under zero (40px)", barPx(980, s) === 40);
ok("zero draws nothing", barPx(0, s) === 0 && barPx(null, s) === 0);
ok("a tiny value is still visible", barPx(1, s) === 4);

const axis = chartAxis(refBars, 162, 78);
ok("desktop axis: 2.5K / 1K / 0 / -1K", axis.ticks.map((t) => t.label).join(" ") === "2.5K 1K 0 -1K", axis.ticks);
ok("desktop reference: ₪2,350 → 152px", barPx(2350, axis.scale) === 152);
ok("desktop reference: ₪980 → 64px", barPx(980, axis.scale) === 64);
ok("an empty chart is just a zero line", chartAxis([{ key: "a", label: "", income: 0, expense: null }], 162, 78).ticks.length === 1);

/* --------------------------------------------------------------- waiting -- */
const now = new Date("2026-10-05T09:00:00Z");
const briefing: BriefingApi = {
  state: "BUSY",
  oriented: true,
  attention: [
    { reason: "OVERDUE", obligation: { id: 1, obligeeName: "גולן טלקום", amount: "120.00", currency: "ILS", dueAt: "2026-10-01T09:00:00Z" } },
    { reason: "DUE_SOON", obligation: { id: 2, obligeeName: "דירה", amount: "4000.00", currency: "ILS", dueAt: "2026-10-06T09:00:00Z" } },
  ],
  watching: [],
  counts: { open: 2, attention: 2, breakToday: 1, watching: 0 },
  generatedAt: now.toISOString(),
} as unknown as BriefingApi;

function statusItem(itemId: string, domain: string, title: string, href = "/x"): BusinessStatusItem {
  return {
    itemId,
    domain,
    title,
    summary: null,
    severity: "MEDIUM",
    priorityScore: 1,
    primaryAction: { kind: "navigate", label: "", href },
  } as unknown as BusinessStatusItem;
}

const status = [
  statusItem("inventory:alert:9", "inventory", "מלאי קריטי — טישו", "/inventory"),
  statusItem("inventory:alert:10", "inventory", "מוצר POS לא מזוהה במלאי"),
  statusItem("leads:new_unhandled:5", "leads", "דני — ליד חדש שלא טופל", "/leads/5"),
  statusItem("documents:needs_review:3", "documents", "מסמך לבדיקה"),
];
const waitingRow: CollectionWaitingWire = { requestId: 7, customerName: "כהן ובני בע״מ", invoiceNumber: "4521", amount: "5320.00", currency: "ILS", createdAt: now.toISOString() };

const w = buildWaiting({ briefing, status, collectionWaiting: [waitingRow], now });
ok("only the four real kinds are listed", w.items.every((i) => ["payment", "stock", "collection", "lead"].includes(i.kind)) && w.items.length === 5);
ok("the overdue obligation leads, tagged דחוף", w.items[0].id === "obligation:1" && w.items[0].tag.label === "דחוף");
ok("critical stock comes before the rest", w.items[1].kind === "stock");
ok("a new lead is tagged חדש", w.items.find((i) => i.kind === "lead")?.tag.label === "חדש");
ok("a waiting payment request is ממתין, never דחוף", w.items.find((i) => i.kind === "collection")?.tag.label === "ממתין");
ok("collection carries the customer and amount", w.items.find((i) => i.kind === "collection")?.subtitle === "לקוח: כהן ובני בע״מ" && w.items.find((i) => i.kind === "collection")?.amount === "₪5,320");
ok("complete sources → exact count", w.total.exact && countText(w.total) === "5");
ok("sentence counts payments", waitingSentence(w) === "5 דברים מחכים לך, 2 מהם תשלומים");

const capped = Array.from({ length: 50 }, (_, i) => statusItem(`documents:needs_review:${i}`, "documents", "x"));
const wCapped = buildWaiting({ briefing, status: [...capped], collectionWaiting: [], now });
ok("a status list at its global cap is never exact", !wCapped.total.exact && countText(wCapped.total) === "2+");
ok("…and the sentence says 'more than'", waitingSentence(wCapped) === "יותר מ-2 דברים מחכים לך");

const manyLeads = Array.from({ length: 8 }, (_, i) => statusItem(`leads:new_unhandled:${i}`, "leads", "ליד"));
ok("leads at their domain cap are not exact", !buildWaiting({ briefing, status: manyLeads, collectionWaiting: [], now }).byKind.lead.exact);

const manyWaiting = Array.from({ length: 200 }, (_, i) => ({ ...waitingRow, requestId: i }));
ok("collection at the 200 read cap is not exact", !buildWaiting({ briefing, status: [], collectionWaiting: manyWaiting, now }).byKind.collection.exact);
ok("a failed source makes the total inexact", !buildWaiting({ briefing: null, status: [], collectionWaiting: [], now }).total.exact);
ok("nothing waiting, proven", waitingSentence(buildWaiting({ briefing: { ...briefing, attention: [] } as BriefingApi, status: [], collectionWaiting: [], now })) === "אין כרגע דברים שמחכים לך");

/* ------------------------------------------- one lead count, everywhere -- */
// The sidebar's לידים badge and "מה מחכה" must say the same thing: both read
// /api/business-status's lead items through leadsWaitingClaim().
const leadItems = [
  statusItem("leads:new_unhandled:1", "leads", "א — ליד חדש שלא טופל"),
  statusItem("leads:followup_overdue:2", "leads", "ב — מעקב באיחור"),
  statusItem("leads:customer_wrote:3", "leads", "ג — הלקוח כתב"),
];
const withLeads = [...status, ...leadItems.slice(1)];
const badgeClaim = leadsWaitingClaim(withLeads);
const panelClaim = buildWaiting({ briefing, status: withLeads, collectionWaiting: [], now }).byKind.lead;
ok("badge and 'מה מחכה' count the same leads", badgeClaim.n === panelClaim.n && badgeClaim.exact === panelClaim.exact && badgeClaim.n === 3, { badgeClaim, panelClaim });
ok("every lead reason counts, not only 'new'", leadsWaitingClaim(leadItems).n === 3);
ok("an unreadable source is never a confident 0", !leadsWaitingClaim(null).exact);
ok("the leads cap makes the badge N+", countText(leadsWaitingClaim(manyLeads)) === "8+" && countText(buildWaiting({ briefing, status: manyLeads, collectionWaiting: [], now }).byKind.lead) === "8+");

/* --------------------------------------------------- upcoming payments -- */
const upcoming = buildUpcomingRows(
  {
    asOf: "2026-10-05",
    upcoming: {
      overdue: { items: [{ title: "גולן טלקום", dueDate: "2026-09-10", amount: "15" }] },
      next30Days: {
        items: [
          { title: "דירה", dueDate: "2026-10-05", amount: "3500" },
          { title: "ביטוח", dueDate: "2026-10-20", amount: "820" },
        ],
      },
    },
  },
  3,
);
ok("a payment past its date is marked overdue", upcoming[0].overdue === true && upcoming[0].title === "גולן טלקום");
ok("due today is not overdue", upcoming[1].overdue === false);
ok("a future payment is not overdue", upcoming[2].overdue === false);
ok("overdue payments come first", upcoming.map((r) => r.title).join(",") === "גולן טלקום,דירה,ביטוח");

/* -------------------------------------------------------------- activity -- */
const activity = buildActivity({
  paid: [
    { requestId: 1, customerName: "כהן", invoiceNumber: "4521", amount: "100", currency: "ILS", paidAt: "2026-10-05T07:00:00Z" },
    { requestId: 2, customerName: "לוי", invoiceNumber: null, amount: "50", currency: "ILS", paidAt: null },
  ],
  leads: [{ id: 3, name: "דני", status: "NEW", sourceChannel: null, phone: null, createdAt: "2026-10-05T08:00:00Z" }],
  documents: [{ documentId: 4, createdAt: "2026-10-04T08:00:00Z", status: "needs_review", source: "email", extracted: { amount: 80, vendorName: "חשמל" } }],
  limit: 3,
});
ok("newest first", activity.map((a) => a.id).join(",") === "lead:3,paid:1,doc:4");
ok("unpaid rows never become 'התקבל תשלום'", !activity.some((a) => a.id === "paid:2"));
ok("a document awaiting review links to its review", activity.find((a) => a.id === "doc:4")?.href === "/documents/review/4");
ok("the limit holds", buildActivity({ paid: null, leads: Array.from({ length: 9 }, (_, i) => ({ id: i, name: null, status: "NEW", sourceChannel: null, phone: null, createdAt: now.toISOString() })), documents: null, limit: 3 }).length === 3);

/* ----------------------------------------------------------------- stock -- */
const stock = buildStockRows(
  [
    { id: 1, name: "טישו", currentQuantity: 1, minimumQuantity: 10, unitType: "UNIT", isActive: true, updatedAt: now.toISOString(), alerts: [{ type: "CRITICAL_STOCK", isResolved: false }] },
    { id: 2, name: "ברגים", currentQuantity: 50, minimumQuantity: 10, unitType: "UNIT", isActive: true, updatedAt: now.toISOString() },
    { id: 3, name: "ללא סף", currentQuantity: 5, minimumQuantity: 0, unitType: "UNIT", isActive: true, updatedAt: now.toISOString() },
    { id: 4, name: "לא פעיל", currentQuantity: 0, minimumQuantity: 5, unitType: "UNIT", isActive: false, updatedAt: now.toISOString() },
  ],
  now,
  3,
);
ok("items without a threshold are not drawn on the threshold scale", stock.every((r) => r.id !== 3 && r.id !== 4));
ok("most pressing first", stock[0].id === 1 && stock[0].state === "critical");
ok("bar = current / (2 × minimum)", Math.abs(stock[0].fill - 0.05) < 1e-9);
ok("bar is clamped at full", stock[1].fill === 1);

if (failed > 0) {
  console.error(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll HOME v3 model tests passed.");
