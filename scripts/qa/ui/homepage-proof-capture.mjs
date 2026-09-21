/**
 * HOMEPAGE PRODUCT PROOF — reproducible capture of the four marketing screens.
 *
 * The public homepage shows four real Dubiz screens. Before this script they
 * were hand-captured once (2026-08-02/03, before Dubiz Mist) from an ad-hoc
 * demo business, with no record of how. This makes the capture repeatable:
 *
 *   - REAL app, REAL routes, REAL components and stylesheets — nothing is
 *     mocked in the UI, so what is captured is what the product renders today.
 *   - DATA is substituted at the network layer (`/api/**` is fulfilled here),
 *     the same pattern as `entity-list-runtime-qa.mjs`. No database is read or
 *     written, and no real customer or business can appear in a frame.
 *   - The clock is pinned, so time-of-day greetings and "this month" labels are
 *     the same on every run.
 *
 * Demo data rules (owner decision): fictional, natural, varied names; no
 * "ישראל ישראלי" / "חברת דוגמה" / example.co.il; no identical timestamps; no
 * emoji; no government identifiers at all (the invoice profile deliberately
 * carries NO tax id, and the crop keeps the business-identity block out of
 * frame). Lead fixtures carry `intelligence: null`, so nothing that depends on
 * CONVERSATION_STATE_WRITER_ENABLED (temperature, waiting time) can render.
 *
 *   npx next start -p 3123            # any build; no env or DB required
 *   node scripts/qa/ui/homepage-proof-capture.mjs [--base http://localhost:3123] [--out <dir>]
 *
 * Output: full-page PNG per screen at 390 CSS px × DPR 3 (1170 px wide). The
 * semantic crops that become `public/landing/proof/*.webp` are cut from these
 * by `--crop` (see CROPS) so a re-capture reproduces the published assets.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const argv = process.argv.slice(2);
const argOf = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const BASE = argOf("--base", "http://localhost:3123");
const OUT = argOf("--out", path.join(process.cwd(), ".homepage-qa-capture"));
const CROP_DIR = argv.includes("--crop") ? argOf("--crop", null) : null;
mkdirSync(OUT, { recursive: true });

/** 09:40 Israel time — a working morning, mid-month. */
const NOW = new Date("2026-09-21T06:40:00.000Z");
const iso = (daysAgo, hh = 9, mm = 0) => {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  d.setUTCHours(hh - 3, mm, 0, 0);
  return d.toISOString();
};

/* ───────────────────────────── 01 · collection ───────────────────────────── */

const COLLECTION = {
  summary: {
    pending: { amount: "4610.00", count: 3 },
    collectedThisMonth: { amount: "12640.00", count: 9 },
    expired: { amount: "620.00", count: 1 },
  },
  attention: [
    { id: 311, description: "שיפוץ חדר רחצה — יעל ברק", amount: "3200.00", currency: "ILS", state: "failed", stateLabel: "התשלום לא הושלם" },
    { id: 305, description: "תיקון דוד שמש — משפחת נחום", amount: "620.00", currency: "ILS", state: "expired", stateLabel: "פג תוקף" },
  ],
  active: [
    { id: 318, description: "התקנת מטבח, יתרה — עומר שטרן", amount: "2450.00", currency: "ILS", state: "waiting", stateLabel: "ממתין לתשלום" },
    { id: 316, description: "החלפת ברזים — רונית חדד", amount: "890.00", currency: "ILS", state: "waiting", stateLabel: "ממתין לתשלום" },
    { id: 314, description: "ביקור טכנאי — גלעד אשכנזי", amount: "1270.00", currency: "ILS", state: "waiting", stateLabel: "ממתין לתשלום" },
  ],
  history: [],
};

/* ───────────────────────────── 02 · documents ────────────────────────────── */

const DOCUMENTS_HUB = {
  success: true,
  scope: { month: "2026-09", timezone: "Asia/Jerusalem" },
  financialPulse: {
    period: { month: "2026-09", from: "2026-08-31T21:00:00.000Z", toExclusive: "2026-09-30T21:00:00.000Z" },
    fromFinancialRecords: { income: 18740, expense: 6215, net: 12525, recordCount: 31 },
    inboxDocumentCounts: { pendingReview: 3, approvedDocuments: 28, totalPendingReview: 3 },
  },
  previousNet: 10980,
  nextPending: { documentId: 512, status: "needs_review", extracted: { amount: 412.5, vendorName: "חומרי בניין הגליל" } },
  items: [],
  pagination: { limit: 0, nextCursor: null, hasMore: false },
};

/* ───────────────────────────── 03 · billing ──────────────────────────────── */

const line = (id, idx, description, quantity, unitPrice) => {
  const sub = Number(quantity) * Number(unitPrice);
  const vat = Math.round(sub * 0.18 * 100) / 100;
  return {
    id, lineIndex: idx, description,
    quantity: String(quantity), unitPrice: unitPrice.toFixed(2), vatRatePercent: "18.00",
    lineSubtotal: sub.toFixed(2), vatAmount: vat.toFixed(2), lineTotal: (sub + vat).toFixed(2),
  };
};
const INVOICE_LINES = [
  line(1, 0, "התקנת ארון מטבח עליון", 1, 2400),
  line(2, 1, "משטח שיש — חיתוך והתאמה", 1, 950),
  line(3, 2, "שעות עבודה נוספות", 3, 180),
];
const sum = (k) => INVOICE_LINES.reduce((a, l) => a + Number(l[k]), 0).toFixed(2);
const INVOICE = {
  id: 1042,
  documentType: "TAX_INVOICE",
  status: "ISSUED",
  documentNumber: 1042,
  documentNumberFormatted: "001042",
  customerId: 88,
  customerNameSnapshot: "מיכל ורד",
  validUntil: null,
  convertedToInvoiceId: null,
  subtotalAmount: sum("lineSubtotal"),
  vatAmount: sum("vatAmount"),
  totalAmount: sum("lineTotal"),
  currency: "ILS",
  issuedAt: iso(2, 11, 20),
  createdAt: iso(2, 10, 5),
  updatedAt: iso(2, 11, 20),
  lines: INVOICE_LINES,
};

/* ───────────────────────────── 04 · leads ────────────────────────────────── */

const lead = (id, name, status, sourceChannel, extra = {}) => ({
  id, name, phone: null, email: null, status, sourceChannel,
  followUpNote: null, lastActivityAt: iso(1, 16, 10), createdAt: iso(6, 12, 0),
  followUp: { kind: "none" }, needsAttention: false, customer: null,
  intelligence: null, // never render anything that depends on the state writer
  priority: { score: 30, reason: "NONE", label: "אין דחיפות", contributing: [] },
  ...extra,
});
const LEADS = [
  lead(71, "שירן גולן", "OPEN", "REFERRAL", {
    followUpNote: "שלחה תמונות של המטבח, מחכה להצעה",
    lastActivityAt: iso(3, 14, 35),
    followUp: { kind: "overdue", at: iso(1, 10, 0), overdueDays: 1 },
    needsAttention: true,
    priority: { score: 92, reason: "FOLLOWUP_OVERDUE", label: "מעקב שעבר את הזמן", contributing: [] },
  }),
  lead(74, "דניאל פרץ", "QUOTED", "PHONE", {
    followUpNote: "לחזור אליו לגבי ההצעה",
    lastActivityAt: iso(2, 17, 5),
    followUp: { kind: "due_today", at: iso(0, 12, 0) },
    needsAttention: true,
    priority: { score: 80, reason: "FOLLOWUP_DUE_TODAY", label: "מעקב להיום", contributing: [] },
  }),
  lead(77, "הילה סויסה", "NEW", "WEBSITE", {
    lastActivityAt: iso(0, 8, 50),
    needsAttention: true,
    priority: { score: 75, reason: "NEW_UNHANDLED", label: "ליד חדש", contributing: [] },
  }),
  lead(69, "נועם בירנבאום", "OPEN", "PHONE", {
    lastActivityAt: iso(4, 11, 15),
    followUp: { kind: "scheduled", at: iso(-2, 10, 0), inDays: 2 },
  }),
  lead(63, "אורית קדוש", "WON", "REFERRAL", { lastActivityAt: iso(5, 13, 40), customer: { id: 90, name: "אורית קדוש" } }),
];

/* ─────────────────────────────── routing ─────────────────────────────────── */

const json = (body) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

async function installRoutes(page, log) {
  await page.route("**/api/**", async (route) => {
    const p = new URL(route.request().url()).pathname;
    log.push(p);
    if (p === "/api/payments/collection-workspace") return route.fulfill(json(COLLECTION));
    if (p === "/api/documents/inbox") return route.fulfill(json(DOCUMENTS_HUB));
    if (p === "/api/billing/documents/1042") return route.fulfill(json({ document: INVOICE }));
    if (p === "/api/billing/invoice-profile") {
      // A business name only — deliberately NO tax id (never invent one).
      return route.fulfill(json({ profile: { businessName: "נגרות ארז", billingTaxId: null } }));
    }
    if (p === "/api/payments/requests") {
      // No payment request yet: the invoice is issued and nothing is paid, so
      // the collection card's "יתרה פתוחה" (it shows the document total) is
      // literally true, and the owner's next action — sending it for payment —
      // is the real button the screen offers.
      return route.fulfill(json({ requests: [] }));
    }
    if (p === "/api/leads") return route.fulfill(json({ leads: LEADS, rankingTruncated: false }));
    return route.fulfill(json({}));
  });
}

/* ──────────────────────────────── crops ──────────────────────────────────────
 * Every crop edge is derived from the RENDERED DOM, never typed in pixels: it is
 * the midpoint of the gap between two named components, so it can only ever
 * fall between components — never through a line of text or an amount row.
 * `cardOf(text)` climbs from the element holding `text` to its nearest rounded
 * container (the component that visually owns it).
 */
function measureCrop(spec) {
  const byText = (t, nth = 0) => {
    const hits = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const el = walker.currentNode.parentElement;
      // Only what is actually on screen: some pages keep a hidden (0-height)
      // desktop copy of a block in the DOM.
      if (walker.currentNode.textContent.trim() === t && el.getBoundingClientRect().height > 0) hits.push(el);
    }
    if (!hits[nth]) throw new Error(`crop anchor not found: "${t}" #${nth}`);
    return hits[nth];
  };
  const cardOf = (t, nth = 0) => {
    let el = byText(t, nth);
    while (el && el !== document.body) {
      const cs = getComputedStyle(el);
      // > 50px: a component, not a single control inside one.
      if (parseFloat(cs.borderTopLeftRadius) >= 8 && el.getBoundingClientRect().height > 50) return el;
      el = el.parentElement;
    }
    throw new Error(`no rounded container around "${t}"`);
  };
  const box = (el) => el.getBoundingClientRect();
  const gap = (upper, lower) => Math.round((box(upper).bottom + box(lower).top) / 2);
  const resolve = (edge) => {
    if (edge === 0) return 0;
    const [kind, a, b] = edge;
    const pick = (x) => (x.card ? cardOf(x.card, x.nth) : x.button ? byText(x.button, x.nth).closest("button") : x.closest ? byText(x.text, x.nth).closest(x.closest) : byText(x.text, x.nth));
    if (kind === "gap") return gap(pick(a), pick(b));
    throw new Error(`unknown edge ${kind}`);
  };
  return { top: resolve(spec.top), bottom: resolve(spec.bottom), width: document.documentElement.clientWidth };
}

const SCREENS = [
  {
    key: "collection",
    url: "/payments",
    wait: "text=מרכז הגבייה",
    // Title → daily sentence → the three amounts → the payment action → the
    // "needs attention" group, whole. Ends above "בעבודה".
    crop: { top: 0, bottom: ["gap", { card: "תיקון דוד שמש — משפחת נחום" }, { text: "בעבודה" }] },
  },
  {
    key: "documents",
    url: "/documents",
    wait: "text=נקלוט מסמך חדש?",
    // The month pulse, whole, and the capture card through its two manual
    // capture actions (upload / photo). Ends in the gap ABOVE the automatic-import
    // divider, so no import channel is shown (owner decision: no Gmail on the
    // public page until Google verification is closed).
    crop: { top: 0, bottom: ["gap", { button: "צילום" }, { text: "או ייבאו אוטומטית" }] },
  },
  {
    key: "billing",
    url: "/billing/1042",
    wait: "text=001042",
    // The issued-document card → the collection card (open balance + pending
    // payment link) → the quick check (customer, items, total). Starts below
    // the share action, ends above "פרטים נוספים" — the collapsed block that
    // holds business identity, which stays out of frame.
    crop: {
      top: ["gap", { card: "שיתוף המסמך" }, { card: "001042", nth: 1 }],
      bottom: ["gap", { card: "בדיקה קצרה" }, { text: "פרטים נוספים", closest: "details" }],
    },
  },
  {
    key: "leads",
    url: "/leads",
    wait: "text=שירן גולן",
    // Title, search, the work-queue filters, and the first two leads that need
    // handling, each with its one-tap actions. Ends above the third lead.
    crop: { top: 0, bottom: ["gap", { button: "דחה ל־3 ימים", nth: 1 }, { card: "הילה סויסה" }] },
  },
];

const only = argOf("--only", null);
const browser = await chromium.launch();
for (const s of SCREENS.filter((x) => !only || x.key === only)) {
  const ctx = await browser.newContext({
    // Tall enough that the fixed bottom nav sits far below every crop.
    viewport: { width: 390, height: 1600 },
    deviceScaleFactor: 3,
    locale: "he-IL",
    timezoneId: "Asia/Jerusalem",
    reducedMotion: "reduce",
  });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("token", "homepage-proof-capture");
      localStorage.setItem("sessionId", "homepage-proof-capture");
      localStorage.setItem("user", JSON.stringify({ id: 1, name: "ארז", email: null, businessId: 1 }));
    } catch {
      /* storage unavailable — surfaces as a wait timeout */
    }
  });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(NOW);
  const log = [];
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 160)));
  await installRoutes(page, log);
  await page.goto(`${BASE}${s.url}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(s.wait, { timeout: 30000 });
  await page.waitForLoadState("networkidle");
  // The accessibility FAB is a global overlay floating above every screen, not
  // part of the screen being shown — hidden for the capture only.
  await page.addStyleTag({ content: '[aria-label="פתח תפריט נגישות"]{display:none!important}' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  const file = path.join(OUT, `${s.key}.png`);
  await page.screenshot({ path: file });
  const crop = await page.evaluate(measureCrop, s.crop);
  console.log(`${s.key}: crop ${crop.top}→${crop.bottom} (${crop.bottom - crop.top} CSS px)  api=${[...new Set(log)].join(",")}${errors.length ? `  ERR=${errors.join(" | ")}` : ""}`);
  if (CROP_DIR) {
    const sharp = (await import("sharp")).default;
    mkdirSync(CROP_DIR, { recursive: true });
    const dpr = 3;
    const out = path.join(CROP_DIR, `${s.key}.webp`);
    const info = await sharp(file)
      .extract({ left: 0, top: crop.top * dpr, width: crop.width * dpr, height: (crop.bottom - crop.top) * dpr })
      .webp({ quality: 85 })
      .toFile(out);
    console.log(`   → ${out} ${info.width}×${info.height} ${Math.round(info.size / 1024)}KB`);
  }
  await ctx.close();
}
await browser.close();
