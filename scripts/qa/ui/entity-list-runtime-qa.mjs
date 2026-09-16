/**
 * Entity-list runtime QA — the REAL app, the REAL components.
 *
 * The companion harness (`entity-list-overflow.mjs`) renders markup that mirrors
 * the components against the real stylesheets. This one drives the actual
 * Next.js app: real routes, real React components, real client fetching, real
 * Master–Detail selection. Only the DATA is substituted, at the network layer —
 * which is deliberate on two counts:
 *
 *  - it guarantees QA/SYNTHETIC-only content, with no customer data anywhere
 *    near the run, and
 *  - it lets the run pin the exact hostile values the layout has to survive
 *    (a 66-character unbroken name, a 72-character email, mixed RTL/LTR in one
 *    record, empty fields) instead of hoping a seeded database happens to
 *    contain them.
 *
 * WHAT IT MEASURES. Boxes, not scrollbars. The app ships
 * `body { overflow-x: hidden }`, so overflowing content is CLIPPED rather than
 * scrolled and a page can look clean while text sits outside its card. Every
 * assertion here compares a rendered rectangle against its container's content
 * box. As a cross-check the run also re-measures document width with the app's
 * own `overflow-x` forced back to `visible`, which reveals exactly the overflow
 * that the shipped rule hides.
 *
 *   node scripts/qa/ui/entity-list-runtime-qa.mjs [--base http://localhost:3111] [--shots <dir>] [--json <file>]
 *
 * Requires the app running locally (npm run dev) — it never touches a database.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const argv = process.argv.slice(2);
const argOf = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const BASE = argOf("--base", "http://localhost:3111");
const SHOTS = argOf("--shots", null);
const JSON_OUT = argOf("--json", null);
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const WIDTHS = [
  { w: 320, tier: "mobile" },
  { w: 360, tier: "mobile" },
  { w: 390, tier: "mobile" },
  { w: 768, tier: "tablet" },
  { w: 1024, tier: "tablet" },
  { w: 1280, tier: "desktop" },
  { w: 1920, tier: "desktop" },
];

/* ───────────────────────────── synthetic data ─────────────────────────────
 * Every value below is fabricated for this harness. The QA- prefixed strings
 * are the deliberately hostile ones; the rest are ordinary-looking records so
 * the run also shows what a normal row does, not only the pathological case.
 */

const QA = {
  longHebrew: "מרכז השיווק והפצת מוצרי הבנייה והתשתיות בע״מ סניף ראשי דרום",
  mixed: "Globex Industries גלובקס תעשיות 2024 LTD",
  unbroken: "QASYNTHETICCUSTOMERRECORD00000000000000000000000000000000000000001",
  longEmail: "qa.synthetic.fixture.address.000000000000001@qa-synthetic-tenant.example",
  hebrewEmail: "mercaz.hashivuk.vehafatzat@binyan-vetashtiyot-darom.co.il",
  unbrokenCity: "QASYNTHETICCITYNAMEWITHNOSPACES0000001",
};

const CUSTOMERS = [
  { id: 1, name: QA.longHebrew, phone: "972501234567", email: QA.hebrewEmail, city: "באר שבע", isActive: true },
  { id: 2, name: QA.mixed, phone: "97237654321", email: "accounts.payable+invoices@globex-industries-international.com", city: "Tel Aviv תל אביב", isActive: true },
  { id: 3, name: QA.unbroken, phone: "+1-415-555-0100", email: QA.longEmail, city: QA.unbrokenCity, isActive: false },
  { id: 4, name: "דנה", phone: null, email: null, city: null, isActive: true },
  { id: 5, name: "ספק ללא פרטים", phone: "972529876543", email: null, city: null, isActive: true },
];

const customerCard = (id) => {
  const c = CUSTOMERS.find((x) => x.id === id) ?? CUSTOMERS[0];
  return {
    customer: {
      ...c,
      legalName: c.id === 3 ? QA.unbroken : "שם משפטי לדוגמה בע״מ",
      taxId: "514123456",
      taxIdType: "LTD_COMPANY",
      notes: c.id === 3 ? QA.unbroken : "הערה כללית סינתטית לבדיקת פריסה.",
      createdAt: "2026-01-04T08:00:00.000Z",
      updatedAt: "2026-09-12T08:00:00.000Z",
    },
    billingDocuments: {
      total: 2,
      items: [
        { id: 1, documentType: "TAX_INVOICE", status: "ISSUED", documentNumberFormatted: "QASYNTHETICDOCNUMBER00000000000000000012345", totalAmount: "12480.00", currency: "ILS", issuedAt: "2026-09-12T08:00:00.000Z", createdAt: "2026-09-12T08:00:00.000Z" },
        { id: 2, documentType: "TAX_INVOICE_RECEIPT", status: "PENDING_REVIEW", documentNumberFormatted: null, totalAmount: "1203940.55", currency: "ILS", issuedAt: null, createdAt: "2026-09-01T08:00:00.000Z" },
      ],
    },
    paymentRequests: {
      total: 1,
      items: [{ id: 1, provider: "QA_SYNTHETIC", status: "PENDING", amount: "980.00", currency: "ILS", paymentUrl: null, billingDocumentId: null, createdAt: "2026-09-10T08:00:00.000Z", paidAt: null }],
    },
    conversations: {
      total: 1,
      items: [{ id: 1, channel: "WHATSAPP", status: "OPEN", startedAt: "2026-09-09T08:00:00.000Z", lastMessageAt: "2026-09-12T08:00:00.000Z", closedAt: null }],
    },
    appointments: {
      total: 1,
      items: [{ id: 1, status: "CONFIRMED", title: QA.unbroken, startsAt: "2026-09-20T08:00:00.000Z", createdAt: "2026-09-01T08:00:00.000Z" }],
    },
    activity: { lastActivityAt: "2026-09-12T08:00:00.000Z", hasAnyActivity: true },
  };
};

const intelligence = (n) => ({
  conversationId: n,
  conversationCount: 2,
  conversationStage: "NEGOTIATION",
  temperatureBucket: "hot",
  temperatureScore: 88,
  primarySignal: "CUSTOMER_WAITING",
  signalLabel: "הלקוח ממתין לתשובה",
  signalSeverity: "high",
  waitingMinutes: 18,
  unansweredInboundCount: 3,
  lastMessageAt: "2026-09-15T08:00:00.000Z",
  nextBestAction: { kind: "REPLY", label: "להחזיר תשובה על המחיר שהוצע", reason: "QA synthetic" },
  businessSituation: { kind: "NEGOTIATION", label: "משא ומתן" },
});

const LEADS = CUSTOMERS.map((c, i) => ({
  id: c.id,
  name: c.name,
  phone: c.phone,
  email: c.email,
  status: ["NEW", "IN_PROGRESS", "QUOTED", "WON", "LOST"][i],
  sourceChannel: ["WHATSAPP", "INSTAGRAM", "PHONE", "EMAIL", "OTHER"][i],
  followUpNote: i === 0 ? QA.unbroken : null,
  lastActivityAt: "2026-09-13T08:00:00.000Z",
  createdAt: "2026-09-01T08:00:00.000Z",
  followUp: i === 0 ? { kind: "overdue", at: "2026-09-12T08:00:00.000Z", overdueDays: 3 } : { kind: "none" },
  needsAttention: i === 0,
  customer: i === 1 ? { id: 2, name: QA.mixed } : null,
  intelligence: i < 3 ? intelligence(c.id) : null,
  priority: { score: i === 0 ? 92 : 40, reason: i === 0 ? "FOLLOWUP_OVERDUE" : "NONE", label: i === 0 ? "מעקב שעבר את הזמן" : "אין דחיפות", contributing: [] },
}));

const leadCard = (id) => {
  const l = LEADS.find((x) => x.id === id) ?? LEADS[0];
  return {
    lead: {
      id: l.id, name: l.name, phone: l.phone, email: l.email, status: l.status,
      sourceChannel: l.sourceChannel, intentSnapshot: QA.unbroken,
      followUpNote: l.followUpNote, nextFollowUpAt: "2026-09-12T08:00:00.000Z",
      lastActivityAt: l.lastActivityAt, closedAt: null, lostReason: l.status === "LOST" ? QA.unbroken : null,
      createdAt: l.createdAt, updatedAt: l.createdAt,
    },
    followUp: l.followUp,
    needsAttention: l.needsAttention,
    customer: l.customer ? { ...l.customer, phone: "972501234567", email: QA.longEmail, city: QA.unbrokenCity, isActive: true } : null,
    conversations: { total: 1, items: [{ id: 1, channel: "WHATSAPP", status: "OPEN", startedAt: "2026-09-09T08:00:00.000Z", lastMessageAt: "2026-09-13T08:00:00.000Z" }] },
    intelligence: l.intelligence,
    priority: l.priority,
  };
};

const SUPPLIERS = CUSTOMERS.map((c) => ({ id: c.id, name: c.name, isActive: c.isActive, phone: c.phone, email: c.email }));

const supplierDetail = (id) => {
  const s = SUPPLIERS.find((x) => x.id === id) ?? SUPPLIERS[0];
  return {
    ...s,
    notes: QA.unbroken,
    defaultLeadTimeDays: 14,
    legalName: QA.longHebrew,
    taxId: "514123456",
    taxIdType: "LTD_COMPANY",
    category: "חומרי בניין",
    website: "https://qa-synthetic-tenant.example/very/long/path/000000000000001",
    contactName: "QASYNTHETICCONTACTNAME000000001",
    contactRole: "מנהל רכש",
    contactPhone: "972541112233",
    contactEmail: QA.longEmail,
    addressStreet: "רחוב התעשייה והמלאכה 45 בניין ג׳ קומה 4",
    addressCity: QA.unbrokenCity,
    addressPostalCode: "8489312",
    paymentTermsDays: 30,
    preferredPaymentMethod: "BANK_TRANSFER",
    createdAt: "2026-01-04T08:00:00.000Z",
    updatedAt: "2026-09-12T08:00:00.000Z",
  };
};

const ITEMS = [
  { id: 1, name: "מסנן שמן מקורי לרכב מסחרי כבד דגם 2019-2024 כולל אטם וברגים תוצרת גרמניה", sku: "OEM-45-9920-XL-REV3", barcode: "7290001234567", unitType: "UNIT", currentQuantity: 4, minimumQuantity: 12, reorderPoint: 12, costPerUnit: 820, sellPricePerUnit: 1249.9, imageUrl: null, alerts: [] },
  { id: 2, name: "QASYNTHETICPRODUCT0000000000000000000000000000000000001", sku: "QASYNTHETICSKU0000000000000000000001", barcode: "QASYNTHETICBARCODE00000000000000001", unitType: "UNIT", currentQuantity: 0, minimumQuantity: 5, reorderPoint: 5, costPerUnit: null, sellPricePerUnit: null, imageUrl: null, alerts: [] },
  { id: 3, name: "דבק מגע 500 מ״ל", sku: "GLU-500", barcode: "7290009876543", unitType: "UNIT", currentQuantity: 42, minimumQuantity: 10, reorderPoint: 10, costPerUnit: 18, sellPricePerUnit: 38, imageUrl: null, alerts: [] },
  { id: 4, name: "ברגים Hex Bolt M8x40 גלוונים 2024 — אריזת 500 יח׳", sku: "HEX-M8-40", barcode: "7290005551234", unitType: "PACK", currentQuantity: 7, minimumQuantity: 20, reorderPoint: 20, costPerUnit: 95, sellPricePerUnit: 189.5, imageUrl: null, alerts: [] },
];

const NOTES = [
  { id: 1, body: QA.unbroken, createdAt: "2026-09-12T08:00:00.000Z", updatedAt: "2026-09-12T08:00:00.000Z", author: { id: 1, name: "QASYNTHETICUSERNAME0000000001" }, canEdit: true, canDelete: true },
  { id: 2, body: "הערה סינתטית רגילה לבדיקת פריסה בעברית.", createdAt: "2026-09-11T08:00:00.000Z", updatedAt: "2026-09-11T08:00:00.000Z", author: { id: 1, name: "דנה" }, canEdit: true, canDelete: true },
];

const ATTACHMENTS = [
  { id: 1, originalFileName: "QA-SYNTHETIC-very-long-attachment-file-name-000000000000001.pdf", mimeType: "application/pdf", sizeBytes: 1048576, createdAt: "2026-09-12T08:00:00.000Z", uploader: { id: 1, name: "QASYNTHETICUSERNAME0000000001" }, canDelete: true },
];

const PURCHASE_HISTORY = {
  summary: { purchaseOrderCount: 3, openPurchaseOrderCount: 1, lastPurchaseOrderAt: "2026-09-10T08:00:00.000Z", receivedValue: 48200, orderedValue: 61000, linesWithoutCost: 0, totalLineCount: 9 },
  items: [
    { itemId: 1, name: ITEMS[0].name, totalQty: 120, orderCount: 3, firstUnitCost: 790, lastUnitCost: 820 },
    { itemId: 2, name: ITEMS[1].name, totalQty: 40, orderCount: 1, firstUnitCost: null, lastUnitCost: null },
  ],
  purchaseOrders: [
    { id: 1, status: "RECEIVED", createdAt: "2026-09-10T08:00:00.000Z", orderDate: "2026-09-08T08:00:00.000Z", lineCount: 5, orderedValue: 34000, supplierName: QA.unbroken },
    { id: 2, status: "OPEN", createdAt: "2026-08-30T08:00:00.000Z", orderDate: null, lineCount: 4, orderedValue: 27000, supplierName: null },
  ],
};

/* ─────────────────────────────── routing ────────────────────────────────── */

const json = (body) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

async function installRoutes(page) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const idOf = (re) => {
      const m = re.exec(p);
      return m ? Number(m[1]) : null;
    };

    if (p === "/api/customers") return route.fulfill(json({ customers: CUSTOMERS }));
    if (/^\/api\/customers\/\d+$/.test(p)) return route.fulfill(json(customerCard(idOf(/\/(\d+)$/))));

    if (p === "/api/leads") return route.fulfill(json({ leads: LEADS, rankingTruncated: false }));
    if (/^\/api\/leads\/\d+$/.test(p)) return route.fulfill(json(leadCard(idOf(/\/(\d+)$/))));

    if (p === "/api/inventory/suppliers") return route.fulfill(json({ suppliers: SUPPLIERS }));
    if (/^\/api\/inventory\/suppliers\/\d+\/purchase-orders$/.test(p)) return route.fulfill(json(PURCHASE_HISTORY));
    if (/^\/api\/inventory\/suppliers\/\d+$/.test(p)) return route.fulfill(json({ supplier: supplierDetail(idOf(/\/(\d+)$/)) }));

    if (p === "/api/inventory/items") return route.fulfill(json({ items: ITEMS }));
    if (/^\/api\/inventory\/items\/\d+$/.test(p)) return route.fulfill(json({ item: ITEMS[0] }));
    if (p === "/api/inventory/categories") return route.fulfill(json({ categories: [] }));
    if (p.startsWith("/api/inventory/alerts")) return route.fulfill(json({ alerts: [] }));
    if (p.startsWith("/api/inventory/movements")) return route.fulfill(json({ movements: [] }));
    if (p.startsWith("/api/inventory/unmatched")) return route.fulfill(json({ pending: [] }));

    if (/\/notes$/.test(p)) return route.fulfill(json({ notes: NOTES }));
    if (/\/attachments$/.test(p)) return route.fulfill(json({ attachments: ATTACHMENTS }));

    // Everything else (auth refresh, notifications, counts…) answers empty-OK so
    // no screen falls into an error state for an unrelated reason.
    return route.fulfill(json({}));
  });
}

/* ────────────────────────────── measurement ─────────────────────────────── */

/** Runs in the page. Containers and text come from the real rendered DOM. */
function measureInPage() {
  const TOL = 1.0;
  const findings = [];
  const px = (v) => parseFloat(v) || 0;

  function contentBox(el) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      left: r.left + px(cs.borderLeftWidth) + px(cs.paddingLeft),
      right: r.right - px(cs.borderRightWidth) - px(cs.paddingRight),
      top: r.top + px(cs.borderTopWidth) + px(cs.paddingTop),
      bottom: r.bottom - px(cs.borderBottomWidth) - px(cs.paddingBottom),
    };
  }

  const CARD_SEL =
    ".crm-row, .crm-item, .crm-id, .crm-att-card, .crm-note-card, .inv-row, .inv-oline";
  const TEXT_SEL = [
    ".crm-row__name", ".crm-row__meta", ".crm-row__meta-part", ".crm-row__badges",
    ".crm-id__name", ".crm-id__value", ".crm-item__title", ".crm-item__meta",
    ".crm-item__amount", ".crm-att-card__name", ".crm-att-card__meta",
    ".crm-note-card__author", ".crm-note-card__body",
    ".inv-row__nm", ".inv-row__meta", ".inv-row__pill", ".inv-row__qty",
    ".inv-oline__nm", ".inv-oline__sub", ".inv-dname",
  ].join(",");

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  };

  /**
   * Is the element laid out at all? Below the two-pane breakpoint the master
   * region is `display: none`, so everything inside it has a zero rect. That is
   * the layout working as designed, not content being clipped — without this
   * distinction every detail view would "fail" purely for the pane it is
   * replacing. A box clipped by an overflow ancestor is different: it and its
   * ancestors are all still displayed, so it stays in scope.
   */
  const isRendered = (el) => {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      if (getComputedStyle(n).display === "none") return false;
    }
    return true;
  };

  // 1 — text inside its card.
  for (const el of document.querySelectorAll(TEXT_SEL)) {
    const card = el.closest(CARD_SEL);
    if (!card || !visible(el)) continue;
    const r = el.getBoundingClientRect();
    const box = contentBox(card);
    const over = Math.max(r.right - box.right, box.left - r.left);
    if (over > TOL) {
      findings.push({
        kind: "text-escapes-card",
        selector: String(el.className).split(" ")[0],
        overflowPx: Math.round(over * 10) / 10,
        text: (el.textContent || "").trim().slice(0, 44),
      });
    }
  }

  // 2 — card inside its scrolling/pane container.
  for (const card of document.querySelectorAll(CARD_SEL)) {
    const pane = card.closest(".wsl-region, .crm-page, .inv-rows");
    if (!pane || !visible(card)) continue;
    const r = card.getBoundingClientRect();
    const box = contentBox(pane);
    const over = Math.max(r.right - box.right, box.left - r.left);
    if (over > TOL) {
      findings.push({
        kind: "card-escapes-pane",
        selector: String(card.className).split(" ")[0],
        overflowPx: Math.round(over * 10) / 10,
      });
    }
  }

  // 3 — nothing escapes the viewport.
  for (const el of document.querySelectorAll(`${CARD_SEL}, ${TEXT_SEL}`)) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.right > window.innerWidth + TOL || r.left < -TOL) {
      findings.push({
        kind: "escapes-viewport",
        selector: String(el.className).split(" ")[0],
        overflowPx: Math.round(Math.max(r.right - window.innerWidth, -r.left) * 10) / 10,
        text: (el.textContent || "").trim().slice(0, 44),
      });
    }
  }

  // 4 — controls keep their footprint.
  for (const el of document.querySelectorAll(".crm-row__avatar")) {
    const r = el.getBoundingClientRect();
    if (visible(el) && (r.width < 41 || r.height < 41)) {
      findings.push({ kind: "control-crushed", selector: "crm-row__avatar", w: Math.round(r.width) });
    }
  }
  for (const el of document.querySelectorAll(".crm-row__chevron")) {
    if (visible(el) && el.getBoundingClientRect().width < 4) {
      findings.push({ kind: "control-crushed", selector: "crm-row__chevron", w: 0 });
    }
  }
  for (const el of document.querySelectorAll(".crm-id__actions .crm-btn, .crm-hd > .crm-btn")) {
    const r = el.getBoundingClientRect();
    if (visible(el) && r.width < 55) {
      findings.push({ kind: "control-crushed", selector: "crm-btn", w: Math.round(r.width), text: (el.textContent || "").trim() });
    }
  }

  // 5 — badges are not clipped away by a clamp.
  for (const badge of document.querySelectorAll(".crm-row .crm-badge, .inv-status-badge, .crm-id .crm-badge")) {
    if (!isRendered(badge)) continue;
    let clip = badge.parentElement;
    while (clip && clip !== document.body) {
      const cs = getComputedStyle(clip);
      if (cs.overflow !== "visible" || cs.overflowY !== "visible") break;
      clip = clip.parentElement;
    }
    if (!clip || clip === document.body) continue;
    const b = badge.getBoundingClientRect();
    const c = clip.getBoundingClientRect();
    if (b.height === 0 || b.bottom > c.bottom + TOL || b.top < c.top - TOL) {
      findings.push({ kind: "badge-clipped-away", text: (badge.textContent || "").trim() });
    }
  }

  // 6 — RTL reading order of the meta values matches the order they were given.
  for (const line of document.querySelectorAll(".crm-row__meta")) {
    const parts = [...line.querySelectorAll(".crm-row__meta-part")];
    for (let i = 1; i < parts.length; i += 1) {
      const a = parts[i - 1].getBoundingClientRect();
      const b = parts[i].getBoundingClientRect();
      const sameLine = Math.abs(a.top - b.top) < 2;
      const ok = sameLine ? b.right <= a.left + TOL : b.top >= a.top - TOL;
      if (!ok) {
        findings.push({
          kind: "bidi-order-broken",
          text: `"${(parts[i - 1].textContent || "").trim()}" then "${(parts[i].textContent || "").trim()}"`,
        });
      }
    }
  }

  // Inventory: the live row keeps its status pill and quantity at every width —
  // counted rather than assumed, so "nothing was hidden on mobile" is evidence.
  const invRows = document.querySelectorAll(".inv-row").length;
  const shown = (sel) =>
    [...document.querySelectorAll(sel)].filter(
      (el) => isRendered(el) && el.getBoundingClientRect().height > 0,
    ).length;
  const invPillShown = shown(".inv-row__pill");
  const invQtyShown = shown(".inv-row__qty");

  // Ellipsised block boxes — reported, not failed.
  const truncated = [];
  for (const el of document.querySelectorAll(TEXT_SEL)) {
    if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) {
      truncated.push(String(el.className).split(" ")[0]);
    }
  }

  return {
    findings,
    truncated: [...new Set(truncated)],
    counts: {
      rows: document.querySelectorAll(".crm-row").length,
      metaParts: document.querySelectorAll(".crm-row__meta-part").length,
      badgeRows: document.querySelectorAll(".crm-row__badges").length,
      invRows,
      invPillShown,
      invQtyShown,
      cards: document.querySelectorAll(".crm-id").length,
    },
  };
}

/**
 * The app hides horizontal overflow on <body>, so scrollWidth can never exceed
 * clientWidth no matter how far content spills. Forcing overflow-x back to
 * visible for one measurement exposes what the shipped rule is covering up.
 */
function measureHiddenOverflow() {
  const html = document.documentElement;
  const body = document.body;
  const prevH = html.style.overflowX;
  const prevB = body.style.overflowX;
  html.style.overflowX = "visible";
  body.style.overflowX = "visible";
  void body.offsetWidth;
  const out = { scrollWidth: html.scrollWidth, innerWidth: window.innerWidth };
  html.style.overflowX = prevH;
  body.style.overflowX = prevB;
  return out;
}

/* ──────────────────────────────── screens ───────────────────────────────── */

const SCREENS = [
  { key: "customers", label: "Customers", list: "/customers", wait: ".crm-row", detail: "/customers/3", detailWait: ".crm-id__name" },
  { key: "leads", label: "Leads", list: "/leads", wait: ".crm-row", detail: "/leads/3", detailWait: ".crm-id__name" },
  { key: "suppliers", label: "Suppliers", list: "/suppliers", wait: ".crm-row", detail: "/suppliers/3", detailWait: ".crm-id__name" },
  { key: "inventory", label: "Inventory", list: "/inventory/items", wait: ".inv-row", detail: "/inventory/items/2", detailWait: ".inv-dname" },
];

const browser = await chromium.launch();
const results = [];
let failures = 0;

console.log(`\nEntity-list RUNTIME QA — real app at ${BASE}`);
console.log("Data: QA/SYNTHETIC fixtures injected at the network layer (no database touched)\n");

for (const screen of SCREENS) {
  for (const { w, tier } of WIDTHS) {
    const ctx = await browser.newContext({
      viewport: { width: w, height: 900 },
      deviceScaleFactor: 1,
      locale: "he-IL",
    });
    // A session the client code will accept; the token never reaches a server,
    // because every /api/** request is fulfilled locally.
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem("token", "qa-synthetic-runtime-token");
        localStorage.setItem("sessionId", "qa-synthetic-session");
        localStorage.setItem(
          "user",
          JSON.stringify({ id: 1, name: "QA SYNTHETIC", email: "qa@qa-synthetic-tenant.example", businessId: 1 }),
        );
      } catch {
        /* storage unavailable — the run will surface it as a load failure */
      }
    });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e.message).slice(0, 120)));
    await installRoutes(page);

    const phases = [{ name: "list", url: screen.list, wait: screen.wait }];
    if (screen.detail) phases.push({ name: "detail", url: screen.detail, wait: screen.detailWait });

    for (const phase of phases) {
      let loadError = null;
      try {
        await page.goto(`${BASE}${phase.url}`, { waitUntil: "domcontentloaded", timeout: 45000 });
        await page.waitForSelector(phase.wait, { timeout: 30000 });
        // let fonts + the CRM theme settle before measuring
        await page.evaluate(() => document.fonts?.ready);
        await page.waitForTimeout(250);
      } catch (e) {
        loadError = String(e.message).split("\n")[0].slice(0, 100);
      }

      const r = loadError ? { findings: [], truncated: [], counts: {} } : await page.evaluate(measureInPage);
      const ov = loadError ? { scrollWidth: 0, innerWidth: w } : await page.evaluate(measureHiddenOverflow);
      const hiddenOverflow = ov.scrollWidth > ov.innerWidth + 1;

      if (SHOTS && !loadError) {
        await page.screenshot({
          path: path.join(SHOTS, `rt-${screen.key}-${phase.name}-${w}.png`),
          fullPage: true,
        });
      }

      const ok = !loadError && r.findings.length === 0 && !hiddenOverflow && pageErrors.length === 0;
      if (!ok) failures += 1;
      results.push({ screen: screen.key, phase: phase.name, width: w, tier, ok, loadError, hiddenOverflow, ...r, pageErrors: [...pageErrors] });

      const head = `${ok ? "PASS" : "FAIL"}  ${screen.label.padEnd(10)} ${phase.name.padEnd(6)} ${String(w).padStart(4)}px ${tier}`;
      console.log(head);
      if (loadError) console.log(`        load: ${loadError}`);
      if (hiddenOverflow) console.log(`        HIDDEN horizontal overflow: ${ov.scrollWidth} > ${ov.innerWidth} (masked by body{overflow-x:hidden})`);
      if (pageErrors.length) console.log(`        page error: ${pageErrors[0]}`);
      const byKind = new Map();
      for (const f of r.findings) byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1);
      for (const [kind, n] of byKind) {
        const worst = Math.max(...r.findings.filter((f) => f.kind === kind).map((f) => f.overflowPx ?? 0));
        const sample = r.findings.find((f) => f.kind === kind);
        console.log(
          `        ${kind} ×${n}` +
            (worst > 0 ? ` — worst ${worst}px out` : "") +
            (sample.text ? ` — e.g. "${sample.text}"` : "") +
            (sample.selector && !sample.text ? ` — ${sample.selector}` : ""),
        );
      }
      pageErrors.length = 0;
    }

    await ctx.close();
  }
}

await browser.close();

/**
 * Inventory on a phone must still state stock health in words and show the
 * quantity — colour alone is not a label. Counted, and an EMPTY sample fails:
 * "no rows were measured" must never read the same as "every row was fine".
 */
const invMobile = results.filter(
  (r) => r.screen === "inventory" && r.phase === "list" && r.width <= 720,
);
const invMobileMeasured = invMobile.filter((r) => (r.counts?.invRows ?? 0) > 0);
const invMobileOk =
  invMobileMeasured.length === invMobile.length &&
  invMobile.length > 0 &&
  invMobileMeasured.every(
    (r) => r.counts.invPillShown === r.counts.invRows && r.counts.invQtyShown === r.counts.invRows,
  );
console.log(
  `\nInventory mobile — status pill + quantity rendered on every row: ${invMobileOk ? "YES" : "NO"}` +
    (invMobileMeasured.length
      ? ` (${invMobileMeasured.map((r) => `${r.width}px ${r.counts.invPillShown}/${r.counts.invRows}`).join(", ")})`
      : " — NO ROWS MEASURED"),
);
if (!invMobileOk) failures += 1;

if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ base: BASE, results }, null, 2));

const total = results.length;
console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${total - failures}/${total} screen×width checks clean\n`);
process.exit(failures === 0 ? 0 : 1);
