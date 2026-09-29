/**
 * Runtime visual QA for Desktop UX Phase 2 slice 4:
 * home, attention, notifications, and financial-record search.
 * Mocks /api. Does not mark notifications read or open a live document action.
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.QA_BASE || "http://localhost:3010";
const ROOT = path.resolve("qa-evidence/desktop-ux-phase-2");
const now = "2026-09-28T08:00:00.000+03:00";

let mode = "busy";

function obligation(id, name, amount, dueAt) {
  return {
    id,
    obligeeName: name,
    amount,
    currency: "ILS",
    dueAt,
    state: "OPEN",
    source: "manual",
    recurrence: "NONE",
    recurrenceSeriesId: null,
    note: null,
    followUpAt: null,
    settlementAssertedBy: null,
    metAt: null,
    releasedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function statusItem(partial) {
  return {
    semanticCategory: "ACTION_REQUIRED",
    priorityScore: 50,
    entityRef: { type: "item", id: 1 },
    state: "open",
    createdAt: now,
    sourceEngine: "status",
    ...partial,
  };
}

const busyItems = [
  statusItem({
    itemId: "doc-1",
    domain: "documents",
    title: "חשבונית דלק ממתינה",
    summary: "פז · ₪320 · לבדיקה",
    severity: "HIGH",
    priorityScore: 80,
    primaryAction: { kind: "navigate", label: "לבדיקה", href: "/documents/review/11" },
  }),
  statusItem({
    itemId: "inv-1",
    domain: "inventory",
    title: "חלב 3% אזל",
    summary: "נשארו 0 יחידות",
    severity: "CRITICAL",
    priorityScore: 90,
    primaryAction: { kind: "navigate", label: "לפריט", href: "/inventory/items/1" },
  }),
  statusItem({
    itemId: "lead-1",
    domain: "leads",
    title: "יוסי כהן לא חזר",
    summary: "מעקב שנקבע לשבוע הזה",
    severity: "MEDIUM",
    priorityScore: 40,
    primaryAction: { kind: "navigate", label: "לליד", href: "/leads/4" },
    quickActions: [
      { kind: "lead_followup_complete", label: "טופל", leadId: 4 },
      { kind: "lead_followup_snooze", label: "בעוד 3 ימים", leadId: 4, days: 3 },
    ],
  }),
];

function briefing(attention) {
  return {
    state: attention.length ? "BUSY" : "CALM",
    oriented: true,
    attention,
    watching: [],
    counts: { open: attention.length, attention: attention.length, breakToday: 0, watching: 0 },
    generatedAt: now,
  };
}

function collection(total) {
  const points = total === "0" ? ["0"] : ["0", "120", "340"];
  return {
    timezone: "Asia/Jerusalem",
    period: "today",
    granularity: "hour",
    current: { points, elapsedPoints: points.length, total, count: total === "0" ? 0 : 2 },
    previous: { points: total === "0" ? ["0"] : ["0", "80", "200"], elapsedPoints: total === "0" ? 1 : 3, total: total === "0" ? "0" : "200", count: total === "0" ? 0 : 1 },
    previousAtSamePoint: total === "0" ? "0" : "200",
    changePct: total === "0" ? null : 70,
    cutoffLabel: "10:00",
    window: { from: "2026-09-28", to: "2026-09-28" },
    previousWindow: { from: "2026-09-27", to: "2026-09-27" },
    month: total === "0" ? null : { key: "2026-09", amount: "1200", count: 4, previousAmount: "900", changePct: 33 },
  };
}

const homeBody = {
  heroAction: { actionKey: "none", title: "", description: "", ctaLabel: "", ctaHref: "/app" },
  quickActions: [],
  businessSnapshot: { businessName: "מכולת השכונה", ownerName: "נועה" },
  leadsAttention: { count: 0, href: "/leads" },
};

const dueObligation = {
  obligation: obligation(7, "שכירות המחסן", "4500", "2026-09-28T09:00:00+03:00"),
  reason: "DUE_TODAY",
};

function notification(partial) {
  return {
    domain: "inventory",
    semanticCategory: "ALERT",
    severity: "HIGH",
    entityType: "item",
    entityId: 1,
    summary: null,
    href: "/inventory/items/1",
    firstSurfacedAt: now,
    lastSurfacedAt: now,
    readAt: null,
    resolvedAt: null,
    ...partial,
  };
}

const notifications = [
  notification({ id: 1, severity: "CRITICAL", title: "חלב 3% ירד מתחת לסף", summary: "נשארו 0 יחידות. המלאי עדיין פתוח.", readAt: null }),
  notification({ id: 2, domain: "billing", severity: "MEDIUM", title: "התקבלה קבלה על חשבונית 1008", summary: "יוסי כהן שילם ₪450.", href: "/collection/c/1", readAt: "2026-09-27T10:00:00+03:00" }),
  notification({ id: 3, title: "ספירת המלאי נסגרה", summary: "הפער תוקן אתמול.", readAt: "2026-09-20T10:00:00+03:00", resolvedAt: "2026-09-20T12:00:00+03:00", lastSurfacedAt: "2026-09-20T12:00:00+03:00" }),
];

const searchRows = [
  { id: 1, documentId: 11, vendorName: "פז", category: "fuel", amount: 320, date: "2026-09-20", direction: "expense", document: { status: "needs_review" } },
  { id: 2, documentId: 12, vendorName: "חברת החשמל", category: "utilities", amount: 860, date: "2026-09-18", direction: "expense", document: { status: "approved" } },
  { id: 3, documentId: 13, vendorName: "לקוח עם שם ארוך מאוד שממשיך מעבר לשורה אחת כדי לבדוק גלישה", category: "services", amount: 1500, date: "2026-09-12", direction: "income", document: { status: "approved" } },
];

function json(route, body) {
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

async function fulfill(route) {
  const url = new URL(route.request().url());
  const p = url.pathname;
  if (p === "/api/home") return json(route, homeBody);
  if (p === "/api/home/collection") return json(route, collection(mode === "sparse" || mode === "calm" ? "0" : "340"));
  if (p === "/api/obligations/briefing") {
    const attention = mode === "busy" || mode === "attention" ? [dueObligation] : [];
    return json(route, briefing(attention));
  }
  if (p === "/api/business-status") {
    const items = mode === "busy" || mode === "attention" ? busyItems : mode === "attention-one" ? [busyItems[0]] : [];
    return json(route, { generatedAt: now, businessId: 1, items, paperworkInsight: null });
  }
  if (p === "/api/billing/collection/awaiting") {
    const quiet = mode === "sparse" || mode === "calm";
    return json(route, { totalOutstanding: quiet ? "0" : "890", customerCount: quiet ? 0 : 2 });
  }
  if (p === "/api/billing/invoice-profile") return json(route, { profile: null });
  if (p === "/api/notifications/unread-count") {
    return json(route, { unreadCount: mode === "notifications-empty" ? 0 : 1 });
  }
  if (p === "/api/notifications") {
    if (mode === "notifications-empty") return json(route, { notifications: [], unreadCount: 0, nextCursor: null });
    const unreadOnly = url.searchParams.get("unreadOnly") === "true";
    const list = unreadOnly ? notifications.filter((n) => n.readAt === null) : notifications;
    return json(route, { notifications: list, unreadCount: 1, nextCursor: null });
  }
  if (p === "/api/search") {
    if (mode === "search-empty") return json(route, { results: [] });
    if (mode === "search-one") return json(route, { results: [searchRows[0]] });
    const q = (url.searchParams.get("q") || "").trim();
    const results = q ? searchRows.filter((row) => `${row.vendorName} ${row.category}`.includes(q)) : searchRows;
    return json(route, { results });
  }
  return json(route, {});
}

async function snap(page, domain, file) {
  const dir = path.join(ROOT, domain);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, file);
  await page.screenshot({ path: target, fullPage: false });
  const metrics = await page.evaluate(() => {
    const de = document.documentElement;
    return {
      overflow: de.scrollWidth > de.clientWidth + 2,
      text: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 240),
    };
  });
  return { file: `${domain}/${file}`, ...metrics };
}

const shots = [];

async function shoot(page, domain, label, width) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForTimeout(350);
  const result = await snap(page, domain, `${label}-${width}.png`);
  shots.push({ domain, label, width, ...result });
  console.log(domain, label, width, result.overflow ? "OVERFLOW" : "ok", result.text.slice(0, 90));
}

async function open(page, routePath, readyText) {
  await page.goto(BASE + routePath, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(
    (needle) => {
      const overlay = document.querySelector("[data-dubiz-intro-overlay]");
      const fading = overlay && getComputedStyle(overlay).opacity === "0";
      const text = document.body.innerText || "";
      return (!overlay || fading) && text.includes(needle);
    },
    readyText,
    { timeout: 25000 },
  );
  await page.waitForTimeout(400);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  locale: "he-IL",
  timezoneId: "Asia/Jerusalem",
  reducedMotion: "reduce",
});
await context.addInitScript(() => {
  localStorage.setItem("token", "desktop-ux-qa");
  localStorage.setItem("user", JSON.stringify({ id: 1, name: "נועה", businessId: 1 }));
  localStorage.setItem("dubiz.home.identity.v1", "dubiz");
});
await context.route("**/api/**", fulfill);
const page = await context.newPage();

mode = "sparse";
await open(page, "/app", "גבייה");
for (const w of [390, 1440]) await shoot(page, "home", "sparse", w);

mode = "calm";
await open(page, "/app", "גבייה");
await shoot(page, "home", "calm", 1280);

mode = "busy";
await open(page, "/app", "שכירות");
for (const w of [390, 768, 1024, 1280, 1600, 1920]) await shoot(page, "home", "busy", w);

mode = "attention";
await open(page, "/attention", "דורש תשומת לב");
await shoot(page, "attention", "mixed", 390);
await shoot(page, "attention", "mixed", 768);
await shoot(page, "attention", "mixed-none", 1440);
await page.locator(".attn-table tbody tr").first().click();
await page.waitForTimeout(200);
await shoot(page, "attention", "selected", 1440);
await shoot(page, "attention", "selected", 1920);

mode = "attention-one";
await open(page, "/attention", "חשבונית דלק");
await shoot(page, "attention", "one", 1280);

mode = "sparse";
await open(page, "/attention", "אין דברים");
await shoot(page, "attention", "empty", 1440);

mode = "notifications-empty";
await open(page, "/notifications", "אין התראות");
await shoot(page, "notifications", "empty", 390);
await shoot(page, "notifications", "empty", 1440);

mode = "busy";
await open(page, "/notifications", "חלב");
await shoot(page, "notifications", "mixed", 390);
await shoot(page, "notifications", "mixed", 1024);
await shoot(page, "notifications", "mixed-none", 1440);
await page.locator(".notif-row").first().click();
await page.waitForTimeout(200);
await shoot(page, "notifications", "selected", 1440);
await shoot(page, "notifications", "selected", 1600);
await page.getByRole("button", { name: "לא נקראו" }).click();
await page.waitForTimeout(300);
await shoot(page, "notifications", "unread", 1280);

mode = "busy";
await open(page, "/search", "חיפוש");
await shoot(page, "search", "recent", 390);
await shoot(page, "search", "recent", 768);
await shoot(page, "search", "recent", 1440);
await page.locator("input[aria-label='חיפוש לפי ספק או קטגוריה']").press("ArrowDown");
await page.waitForTimeout(150);
await shoot(page, "search", "keyboard", 1440);
await page.locator("input[aria-label='חיפוש לפי ספק או קטגוריה']").fill("שם ארוך");
await page.waitForTimeout(400);
await shoot(page, "search", "long", 1920);

mode = "search-one";
await open(page, "/search", "פז");
await shoot(page, "search", "one", 1280);

mode = "search-empty";
await open(page, "/search", "אין רשומות");
await page.locator("input[aria-label='חיפוש לפי ספק או קטגוריה']").fill("איןכזה");
await page.waitForTimeout(400);
await shoot(page, "search", "none", 1440);

fs.writeFileSync(path.join(ROOT, "slice4-metrics.json"), JSON.stringify(shots, null, 2));
await browser.close();
console.log("SHOTS", shots.length, "OVERFLOW", shots.filter((s) => s.overflow).length);
