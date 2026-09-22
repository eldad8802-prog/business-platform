/**
 * HOMEPAGE v3 — reproducible capture of every real product object on the page.
 *
 *   - REAL app, REAL routes, REAL components and stylesheets. Nothing in the UI
 *     is mocked or restyled; what is captured is what Dubiz renders today.
 *   - DATA is substituted at the network layer (`/api/**` answered here), the
 *     pattern of `entity-list-runtime-qa.mjs` / `home-2b-states.mjs`. No
 *     database is read or written; no real business or customer can appear.
 *   - The clock is pinned, so greetings and "this month" are stable.
 *
 * Every output is a COMPLETE object — a full viewport, a full component, or a
 * full page. Nothing is cropped. Component captures hide only floating chrome
 * that is not part of the component (the fixed bottom bar, the accessibility
 * FAB).
 *
 * Demo-data rules: fictional, natural names; no "ישראל ישראלי" / example.co.il;
 * no government identifiers (the invoice profile carries none, and its detail
 * block stays collapsed); no emoji in data; lead fixtures carry
 * `intelligence: null` (nothing depends on CONVERSATION_STATE_WRITER_ENABLED);
 * document sources are uploads only (no Gmail). The numbers agree across the
 * page: 5 open collections (3 waiting + 2 needing care), 9 collected this
 * month, 7 documents to review, 1 payment due today.
 *
 *   npx next start -p 3147
 *   node scripts/qa/ui/homepage-proof-capture.mjs [--base http://localhost:3147] [--only <key>]
 *
 * Writes WebP (q85) to public/landing/v3/ and prints each asset's true size.
 */
import { mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";

const argv = process.argv.slice(2);
const argOf = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const BASE = argOf("--base", "http://localhost:3147");
const ONLY = argOf("--only", null);
const OUT = path.join(process.cwd(), "public", "landing", "v3");
mkdirSync(OUT, { recursive: true });

/** 09:40 Israel time — a working morning. */
const NOW = new Date("2026-09-21T06:40:00.000Z");
const iso = (daysFromNow, hh = 9, mm = 0) => {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  d.setUTCHours(hh - 3, mm, 0, 0);
  return d.toISOString();
};
const day = (daysFromNow) => iso(daysFromNow).slice(0, 10);

/* ── collection ─────────────────────────────────────────────────────────── */
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
  history: [
    { id: 309, description: "ארון אמבטיה — טל מזרחי", amount: "1850.00", currency: "ILS", state: "verified", stateLabel: "נגבה ואומת" },
  ],
};
const COLLECTION_DETAIL = {
  request: { id: 318, status: "PENDING", amount: "2450.00", currency: "ILS", description: "התקנת מטבח, יתרה — עומר שטרן", paymentUrl: null, createdAt: iso(-3, 15, 20), paidAt: null },
  transactions: [],
  audit: [{ id: 1, eventType: "CREATED", occurredAt: iso(-3, 15, 20) }],
};

/* ── documents (uploads only; whole-shekel amounts) ─────────────────────── */
const doc = (documentId, daysAgo, hh, vendorName, amount, category, kind, conf = "high") => ({
  documentId, createdAt: iso(-daysAgo, hh, 12), groupMonth: "2026-09", status: "needs_review",
  source: "upload", mimeType: kind === "pdf" ? "application/pdf" : "image/jpeg",
  preview: { kind, fileAvailable: true, thumbnailReady: false },
  extracted: { amount, vendorName, date: day(-daysAgo - 1), direction: "expense", category, confidenceScore: conf === "high" ? 0.94 : 0.78, amountConfidence: conf, vendorConfidence: "high", categoryConfidence: "medium" },
  confidenceDots: { amount: conf, vendor: "high", dateProxy: "high" },
  quickApprove: { eligible: conf === "high" },
});
const DOC_ITEMS = [
  doc(512, 0, 8, "חומרי בניין הגליל", 412, "supplies", "image"),
  doc(511, 1, 17, "תחנת דלק הצפון", 286, "fuel", "image"),
  doc(509, 2, 11, "דפוס קרני", 540, "services", "pdf", "medium"),
  doc(508, 3, 16, "מוסך הדר", 1320, "services", "pdf"),
  doc(507, 4, 9, "פרסום מקומי — עיתון הגליל", 480, "advertising", "image"),
  doc(505, 5, 13, "אינטרנט עסקי — קו פלוס", 219, "internet", "pdf"),
  doc(504, 6, 10, "מחסני עץ יוסף", 2680, "supplies", "pdf", "medium"),
];
const DOCUMENTS_INBOX = {
  success: true,
  scope: { month: "2026-09", timezone: "Asia/Jerusalem" },
  pendingMonths: ["2026-09"],
  financialPulse: {
    period: { month: "2026-09", from: "2026-08-31T21:00:00.000Z", toExclusive: "2026-09-30T21:00:00.000Z" },
    fromFinancialRecords: { income: 18740, expense: 6215, net: 12525, recordCount: 31 },
    inboxDocumentCounts: { pendingReview: 7, approvedDocuments: 28, totalPendingReview: 7 },
  },
  previousNet: 10980,
  nextPending: { documentId: 512, status: "needs_review", extracted: { amount: 412, vendorName: "חומרי בניין הגליל" } },
  items: DOC_ITEMS,
  pagination: { limit: 50, nextCursor: null, hasMore: false },
};

/* ── billing: an ISSUED tax invoice, nothing paid, no payment request yet ── */
const line = (id, idx, description, quantity, unitPrice) => {
  const sub = quantity * unitPrice;
  const vat = Math.round(sub * 0.18 * 100) / 100;
  return { id, lineIndex: idx, description, quantity: String(quantity), unitPrice: unitPrice.toFixed(2), vatRatePercent: "18.00", lineSubtotal: sub.toFixed(2), vatAmount: vat.toFixed(2), lineTotal: (sub + vat).toFixed(2) };
};
const LINES = [line(1, 0, "התקנת ארון מטבח עליון", 1, 2400), line(2, 1, "משטח שיש — חיתוך והתאמה", 1, 950), line(3, 2, "שעות עבודה נוספות", 3, 180)];
const sum = (k) => LINES.reduce((a, l) => a + Number(l[k]), 0).toFixed(2);
const INVOICE = {
  id: 1042, documentType: "TAX_INVOICE", status: "ISSUED", documentNumber: 1042, documentNumberFormatted: "001042",
  customerId: 88, customerNameSnapshot: "מיכל ורד", validUntil: null, convertedToInvoiceId: null,
  subtotalAmount: sum("lineSubtotal"), vatAmount: sum("vatAmount"), totalAmount: sum("lineTotal"), currency: "ILS",
  issuedAt: iso(-2, 11, 20), createdAt: iso(-2, 10, 5), updatedAt: iso(-2, 11, 20), lines: LINES,
};

/* ── leads ──────────────────────────────────────────────────────────────── */
const lead = (id, name, status, sourceChannel, extra = {}) => ({
  id, name, phone: null, email: null, status, sourceChannel, followUpNote: null,
  lastActivityAt: iso(-1, 16, 10), createdAt: iso(-6, 12, 0), followUp: { kind: "none" },
  needsAttention: false, customer: null, intelligence: null,
  priority: { score: 30, reason: "NONE", label: "אין דחיפות", contributing: [] },
  ...extra,
});
const LEADS = [
  lead(71, "שירן גולן", "OPEN", "REFERRAL", { followUpNote: "שלחה תמונות של המטבח, מחכה להצעה", lastActivityAt: iso(-3, 14, 35), followUp: { kind: "overdue", at: iso(-1, 10, 0), overdueDays: 1 }, needsAttention: true, priority: { score: 92, reason: "FOLLOWUP_OVERDUE", label: "מעקב שעבר את הזמן", contributing: [] } }),
  lead(74, "דניאל פרץ", "QUOTED", "PHONE", { followUpNote: "לחזור אליו לגבי ההצעה", lastActivityAt: iso(-2, 17, 5), followUp: { kind: "due_today", at: iso(0, 12, 0) }, needsAttention: true, priority: { score: 80, reason: "FOLLOWUP_DUE_TODAY", label: "מעקב להיום", contributing: [] } }),
  lead(77, "הילה סויסה", "NEW", "WEBSITE", { lastActivityAt: iso(0, 8, 50), needsAttention: true, priority: { score: 75, reason: "NEW_UNHANDLED", label: "ליד חדש", contributing: [] } }),
  lead(69, "נועם בירנבאום", "OPEN", "PHONE", { lastActivityAt: iso(-4, 11, 15), followUp: { kind: "scheduled", at: iso(2, 10, 0), inDays: 2 } }),
  lead(66, "רוני אברהם", "QUALIFIED", "REFERRAL", { lastActivityAt: iso(-5, 9, 30), followUp: { kind: "scheduled", at: iso(4, 11, 0), inDays: 4 } }),
  lead(63, "אורית קדוש", "WON", "REFERRAL", { lastActivityAt: iso(-5, 13, 40), customer: { id: 90, name: "אורית קדוש" } }),
];
const leadCard = (id) => {
  const l = LEADS.find((x) => x.id === id) ?? LEADS[0];
  return {
    lead: { id: l.id, name: l.name, phone: l.phone, email: l.email, status: l.status, sourceChannel: l.sourceChannel, intentSnapshot: "שיפוץ מטבח — ארונות עליונים ומשטח", followUpNote: l.followUpNote, nextFollowUpAt: l.followUp.at ?? null, lastActivityAt: l.lastActivityAt, closedAt: null, lostReason: null, createdAt: l.createdAt, updatedAt: l.lastActivityAt },
    followUp: l.followUp, needsAttention: l.needsAttention, customer: null,
    conversations: { total: 0, items: [] }, intelligence: null, priority: l.priority,
  };
};
const NOTES = [
  { id: 2, body: "שלחה 4 תמונות של הקיר. לבדוק מידות לפני שמכינים הצעה.", createdAt: iso(-3, 14, 40), updatedAt: iso(-3, 14, 40), author: { id: 1, name: "ארז" }, canEdit: true, canDelete: true },
  { id: 1, body: "הגיעה דרך המלצה של אורית קדוש. מעוניינת בארונות עליונים ומשטח.", createdAt: iso(-6, 12, 10), updatedAt: iso(-6, 12, 10), author: { id: 1, name: "ארז" }, canEdit: true, canDelete: true },
];

/* ── the day: obligations briefing (owner-entered), status, home ────────── */
const obligation = (id, name, amount, dueAt) => ({ id, obligeeName: name, amount, currency: "ILS", dueAt, state: "OPEN", source: "MANUAL", recurrence: "MONTHLY", recurrenceSeriesId: null, note: null, followUpAt: null, settlementAssertedBy: null, metAt: null, releasedAt: null, createdAt: iso(-40), updatedAt: iso(-40) });
const BRIEFING = {
  state: "BUSY", oriented: true,
  attention: [
    { obligation: obligation(31, "שכר דירה לסדנה", "6400.00", iso(0, 15)), reason: "DUE_TODAY" },
    { obligation: obligation(32, "ביטוח לאומי", "980.00", iso(3)), reason: "DUE_SOON" },
  ],
  watching: [obligation(33, "ליסינג רכב", "2150.00", iso(12))],
  counts: { open: 3, attention: 2, breakToday: 1, watching: 1 },
  generatedAt: iso(0),
};
const statusItem = (id, domain, severity, title) => ({ itemId: id, domain, semanticCategory: "ACTION_REQUIRED", title, summary: null, severity, priorityScore: 10, entityRef: { type: domain, id: 1 }, state: "open", createdAt: iso(-1), primaryAction: { kind: "navigate", label: "פתח", href: "/attention" }, sourceEngine: "capture" });
const STATUS = {
  items: [
    statusItem("l1", "leads", "HIGH", "מעקב שעבר את הזמן: שירן גולן"),
    statusItem("d1", "documents", "MEDIUM", "7 מסמכים ממתינים לבדיקה"),
    statusItem("i1", "inventory", "MEDIUM", "מלאי נמוך: ברגי עץ 4×40"),
    statusItem("s1", "supplier", "MEDIUM", "הזמנה ממחסני עץ יוסף ממתינה לקליטה"),
  ],
};
const HOME = { heroAction: { actionKey: "x", title: "", description: "", ctaLabel: "", ctaHref: "/app" }, quickActions: [], businessSnapshot: { businessName: "נגרות ארז", ownerName: "ארז" }, leadsAttention: { count: 3, href: "/leads?view=needsAction" } };

/* ── inventory ──────────────────────────────────────────────────────────── */
const item = (id, name, sku, qty, min, cost, unitType = "UNIT") => ({ id, name, sku, barcode: null, unitType, currentQuantity: qty, minimumQuantity: min, reorderPoint: min, costPerUnit: cost, sellPricePerUnit: 0, imageUrl: null, alerts: [] });
const ITEMS = [
  item(1, "לוח סנדוויץ׳ 18 מ״מ", "PLY-18", 24, 10, 145),
  item(2, "ברגי עץ 4×40 (אריזת 200)", "SCR-440", 2, 8, 38, "PACK"),
  item(3, "ציר מטבח טריקה שקטה", "HNG-SC", 60, 20, 22),
  item(4, "פורמייקה לבנה מט", "FRM-WM", 9, 6, 210),
  item(5, "דבק מגע 500 מ״ל", "GLU-500", 5, 6, 18),
  item(6, "ידיות אלומיניום 160 מ״מ", "HDL-160", 48, 20, 14),
];

/* ── routing ────────────────────────────────────────────────────────────── */
const json = (b, s = 200) => ({ status: s, contentType: "application/json", body: JSON.stringify(b) });
async function routes(page, log) {
  await page.route("**/api/**", (route) => {
    const p = new URL(route.request().url()).pathname;
    log.push(p);
    if (p === "/api/payments/collection-workspace") return route.fulfill(json(COLLECTION));
    if (p === "/api/payments/requests/318") return route.fulfill(json(COLLECTION_DETAIL));
    if (p === "/api/payments/requests") return route.fulfill(json({ requests: [] }));
    if (p.startsWith("/api/documents/inbox")) return route.fulfill(json(DOCUMENTS_INBOX));
    if (p === "/api/billing/documents/1042") return route.fulfill(json({ document: INVOICE }));
    // A business name only — deliberately NO tax id (never invent one).
    if (p === "/api/billing/invoice-profile") return route.fulfill(json({ profile: { businessName: "נגרות ארז", billingLegalName: "נגרות ארז", billingTaxId: null } }));
    if (p === "/api/leads") return route.fulfill(json({ leads: LEADS, rankingTruncated: false }));
    const m = /^\/api\/leads\/(\d+)$/.exec(p);
    if (m) return route.fulfill(json(leadCard(Number(m[1]))));
    if (/\/notes$/.test(p)) return route.fulfill(json({ notes: NOTES }));
    if (/\/attachments$/.test(p)) return route.fulfill(json({ attachments: [] }));
    if (p === "/api/home") return route.fulfill(json(HOME));
    if (p === "/api/notifications/unread-count") return route.fulfill(json({ unreadCount: 2 }));
    if (p === "/api/obligations/briefing") return route.fulfill(json(BRIEFING));
    if (p === "/api/obligations") return route.fulfill(json({ obligations: [...BRIEFING.attention.map((a) => a.obligation), ...BRIEFING.watching], hasMore: false }));
    if (p === "/api/business-status") return route.fulfill(json(STATUS));
    if (p === "/api/inventory/items") return route.fulfill(json({ items: ITEMS }));
    if (p === "/api/inventory/categories") return route.fulfill(json({ categories: [] }));
    if (p.startsWith("/api/inventory/")) return route.fulfill(json({ alerts: [], movements: [], pending: [] }));
    return route.fulfill(json({}));
  });
}

const DESK = { width: 1440, height: 900, dpr: 2 };
const PHONE = { width: 390, height: 844, dpr: 3 };
/*
 * kind: "viewport" | "page" | "text" (smallest rounded container around the
 * text) | "common" (lowest element containing all the texts).
 */
const JOBS = [
  { key: "collection-desktop", url: "/payments/318", vp: DESK, wait: "text=מרכז הגבייה", kind: "viewport" },
  { key: "collection-phone", url: "/payments", vp: PHONE, wait: "text=מרכז הגבייה", kind: "viewport" },
  { key: "leads-desktop", url: "/leads/71", vp: DESK, wait: "text=שירן גולן", kind: "viewport" },
  { key: "leads-phone", url: "/leads", vp: PHONE, wait: "text=שירן גולן", kind: "viewport" },
  { key: "invoice-page", url: "/billing/1042", vp: PHONE, wait: "text=001042", kind: "page" },
  { key: "today-numbers", url: "/app", vp: PHONE, wait: "text=היום במספרים", kind: "common", anchors: ["ממתינים לגבייה", "מסמכים לבדיקה", "תשלומים למועד"] },
  // Section 06 ("המזכירה"). /secretary itself was rejected for the homepage: its
  // home screen greets with an emoji and promises "אזכיר לך בזמן", which no
  // delivery backs. /attention — the list the secretary card opens — passes.
  { key: "attention-phone", url: "/attention", vp: PHONE, wait: "text=7 מסמכים ממתינים לבדיקה", kind: "viewport" },
  { key: "doc-1", url: "/documents/inbox", vp: PHONE, wait: "text=תור אימות", kind: "text", anchors: ["חומרי בניין הגליל"] },
  { key: "doc-2", url: "/documents/inbox", vp: PHONE, wait: "text=תור אימות", kind: "text", anchors: ["מוסך הדר"] },
  { key: "doc-3", url: "/documents/inbox", vp: PHONE, wait: "text=תור אימות", kind: "text", anchors: ["מחסני עץ יוסף"] },
  { key: "doc-4", url: "/documents/inbox", vp: PHONE, wait: "text=תור אימות", kind: "text", anchors: ["דפוס קרני"] },
  { key: "doc-5", url: "/documents/inbox", vp: PHONE, wait: "text=תור אימות", kind: "text", anchors: ["תחנת דלק הצפון"] },
  { key: "inventory-value", url: "/inventory", vp: PHONE, wait: "text=בריאות המלאי", kind: "text", anchors: ["שווי מלאי"] },
  { key: "inventory-health", url: "/inventory", vp: PHONE, wait: "text=בריאות המלאי", kind: "text", anchors: ["בריאות המלאי"] },
];

function locate({ kind, anchors }) {
  const find = (t) => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) {
      const el = w.currentNode.parentElement;
      if (w.currentNode.textContent.trim() === t && el.getBoundingClientRect().height > 0) return el;
    }
    return null;
  };
  if (kind === "common") {
    const els = anchors.map(find);
    if (els.some((e) => !e)) return null;
    let a = els[0];
    while (a && !els.every((e) => a.contains(e))) a = a.parentElement;
    return a;
  }
  let el = find(anchors[0]);
  while (el && el !== document.body) {
    const cs = getComputedStyle(el);
    if (parseFloat(cs.borderTopLeftRadius) >= 8 && el.getBoundingClientRect().height > 80) return el;
    el = el.parentElement;
  }
  return null;
}

const browser = await chromium.launch();
for (const j of JOBS.filter((x) => !ONLY || x.key === ONLY)) {
  const ctx = await browser.newContext({ viewport: { width: j.vp.width, height: j.vp.height }, deviceScaleFactor: j.vp.dpr, locale: "he-IL", timezoneId: "Asia/Jerusalem", reducedMotion: "reduce" });
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
  page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 140)));
  await routes(page, log);
  await page.goto(BASE + j.url, { waitUntil: "domcontentloaded" });
  let ok = true;
  try {
    await page.waitForSelector(j.wait, { timeout: 25000 });
  } catch {
    ok = false;
  }
  await page.waitForLoadState("networkidle");
  // The accessibility FAB floats over every screen; it is not part of any screen.
  await page.addStyleTag({ content: '[aria-label="פתח תפריט נגישות"]{display:none!important}' });
  if (j.kind === "text" || j.kind === "common") {
    await page.addStyleTag({ content: '[data-component="shell-bottom-bar"]{display:none!important}' });
  }
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
  const png = path.join(OUT, `${j.key}.png`);
  if (j.kind === "text" || j.kind === "common") {
    const handle = await page.evaluateHandle(locate, { kind: j.kind, anchors: j.anchors });
    const el = handle.asElement();
    if (!el) {
      console.log(`${j.key}: COMPONENT NOT FOUND`);
      await ctx.close();
      continue;
    }
    await el.screenshot({ path: png });
  } else {
    await page.screenshot({ path: png, fullPage: j.kind === "page" });
  }
  const text = await page.evaluate(() => document.body.innerText);
  const webp = path.join(OUT, `${j.key}.webp`);
  const info = await sharp(png).webp({ quality: 85 }).toFile(webp);
  await unlink(png);
  console.log(
    `${j.key}: ${info.width}×${info.height} ${Math.round(info.size / 1024)}KB` +
      `${ok ? "" : " WAIT-FAILED"} emoji=${/\p{Extended_Pictographic}/u.test(text)} gmail=${/gmail/i.test(text)}` +
      ` api=${[...new Set(log)].join(",")}${errors.length ? ` ERR=${errors.join(" | ")}` : ""}`
  );
  await ctx.close();
}
await browser.close();
