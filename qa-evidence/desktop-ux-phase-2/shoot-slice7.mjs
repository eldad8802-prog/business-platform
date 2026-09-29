/**
 * Runtime visual QA for Desktop UX Phase 2 slice 7 and the final audit:
 * inbox, tools, slice 6 carry-forward, and whole-product desktop samples.
 *
 * Every /api call is mocked. Nothing sends a message, publishes a coupon,
 * connects a provider, generates content, or writes anywhere.
 *
 *   node qa-evidence/desktop-ux-phase-2/shoot-slice7.mjs
 *   ONLY=inbox,tools node qa-evidence/desktop-ux-phase-2/shoot-slice7.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.QA_BASE || "http://localhost:3010";
const ROOT = path.resolve("qa-evidence/desktop-ux-phase-2");
const ALL = [390, 768, 1024, 1280, 1440, 1600, 1920];
const DESK = [1280, 1440, 1920];
const ONLY = (process.env.ONLY || "").split(",").filter(Boolean);

let mode = "populated";

function json(body, status = 200) {
  return { status, contentType: "application/json", body: JSON.stringify(body) };
}

const NOW = Date.parse("2026-09-29T10:00:00.000+03:00");
const ago = (minutes) => new Date(NOW - minutes * 60_000).toISOString();

// ── Inbox fixtures ─────────────────────────────────────────────────────────
function item(id, partial) {
  return {
    conversationId: id,
    customerName: null,
    customerPhone: null,
    channel: "WHATSAPP",
    status: "OPEN",
    currentStage: "NEW",
    stageLabel: "חדש",
    primarySignal: "neutral",
    signalLabel: "",
    signalSeverity: "info",
    temperatureBucket: "warm",
    waitingMinutes: null,
    lastActivityAt: ago(30),
    hasPendingSuggestion: false,
    lastMessage: null,
    suggestedAction: "none",
    suggestedActionLabel: "",
    priorityScore: 10,
    ...partial,
  };
}

const ITEMS = [
  item(11, {
    customerName: "יוסי כהן", currentStage: "QUOTED", stageLabel: "הצעת מחיר",
    primarySignal: "customer_waiting", signalLabel: "הלקוח מחכה לתשובה", signalSeverity: "high",
    temperatureBucket: "hot", waitingMinutes: 42, lastActivityAt: ago(42), hasPendingSuggestion: true,
    lastMessage: { snippet: "אז כמה זה יוצא בסוף עם ההובלה?", senderType: "CUSTOMER", at: ago(42) },
    suggestedAction: "reply_now", suggestedActionLabel: "לענות עכשיו", priorityScore: 90,
  }),
  item(12, {
    customerName: "מאפיית השכונה — הזמנות אירועים ומגשי אירוח", currentStage: "NEGOTIATION", stageLabel: "משא ומתן",
    primarySignal: "hot_negotiation", signalLabel: "משא ומתן חם", signalSeverity: "medium",
    temperatureBucket: "hot", lastActivityAt: ago(120),
    lastMessage: { snippet: "נשמע טוב, תשלחו לי סיכום ונסגור", senderType: "CUSTOMER", at: ago(120) },
    suggestedAction: "send_followup", suggestedActionLabel: "לשלוח סיכום", priorityScore: 70,
  }),
  item(13, {
    customerPhone: "+972 52-555-0199", currentStage: "NEW", stageLabel: "חדש",
    primarySignal: "fresh_lead", signalLabel: "פנייה חדשה", signalSeverity: "low",
    lastActivityAt: ago(300), channel: "INSTAGRAM",
    lastMessage: { snippet: "היי, אתם פתוחים בשבת?", senderType: "CUSTOMER", at: ago(300) },
    priorityScore: 40,
  }),
  item(14, {
    customerName: "דנה לוי", status: "CLOSED", currentStage: "WON", stageLabel: "נסגר", temperatureBucket: "cold",
    lastActivityAt: ago(2880),
    lastMessage: { snippet: "תודה רבה, היה מושלם!", senderType: "CUSTOMER", at: ago(2880) },
    priorityScore: 5,
  }),
];
const CONVERSATIONS = ITEMS.map((i) => ({
  id: i.conversationId, channel: i.channel, status: i.status, currentStage: i.currentStage ?? "NEW",
  startedAt: ago(5000), lastMessageAt: i.lastActivityAt, updatedAt: i.lastActivityAt, customerId: i.conversationId,
}));

function messagesFor(id) {
  if (id === 11) {
    const long = [];
    const lines = [
      ["CUSTOMER", "שלום, רציתי לשאול על ארון הזזה לחדר השינה"],
      ["BUSINESS_USER", "היי יוסי! בשמחה. מה הרוחב של הקיר?"],
      ["CUSTOMER", "בערך 2.40 מטר, גובה עד התקרה"],
      ["BUSINESS_USER", "מעולה. יש לנו שתי אפשרויות — פורמייקה או עץ מלא. שלחתי תמונות"],
      ["CUSTOMER", "הפורמייקה הלבנה נראית טוב"],
      ["BUSINESS_USER", "בחירה מצוינת. ההצעה: 6,800 ש״ח כולל התקנה"],
      ["CUSTOMER", "אז כמה זה יוצא בסוף עם ההובלה?"],
    ];
    lines.forEach(([senderType, contentText], i) => long.push({ id: 100 + i, senderType, contentText, createdAt: ago(300 - i * 40) }));
    return {
      messages: long,
      suggestions: [{ id: 501, text: "ההובלה כלולה במחיר — 6,800 ש״ח סופי, כולל התקנה. מתי נוח לך למדידה?", status: "GENERATED", createdAt: ago(40), suggestionType: "reply" }],
    };
  }
  return {
    messages: [
      { id: 200 + id, senderType: "CUSTOMER", contentText: ITEMS.find((i) => i.conversationId === id)?.lastMessage?.snippet ?? "שלום", createdAt: ago(120) },
    ],
    suggestions: [],
  };
}

async function fulfill(route) {
  const req = route.request();
  const url = new URL(req.url());
  const p = url.pathname;
  if (p.includes("/api/auth/me")) {
    return route.fulfill(json({ user: { name: "נועה לוי", email: "noa@example.com", businessName: "קפה נועה" } }));
  }
  if (p.includes("/api/integrations/whatsapp/connection")) {
    if (mode === "wa-never") return route.fulfill(json({ connection: null }));
    const status = mode === "wa-broken" ? "DISCONNECTED" : "CONNECTED";
    return route.fulfill(json({ connection: {
      status, displayPhoneNumber: "+972 50-000-0000", phoneNumberId: "pn", wabaId: "waba",
      lastVerifiedAt: ago(600), updatedAt: ago(600),
    } }));
  }
  if (p === "/api/conversations" && req.method() === "GET") {
    if (mode === "inbox-error") return route.fulfill(json({ error: "unavailable" }, 500));
    if (mode === "inbox-empty") return route.fulfill(json({ conversations: [], items: [] }));
    return route.fulfill(json({ conversations: CONVERSATIONS, items: ITEMS }));
  }
  if (p === "/api/message" && req.method() === "GET") {
    return route.fulfill(json(messagesFor(Number(url.searchParams.get("conversationId")))));
  }
  if (p.includes("/api/business-status")) {
    if (mode === "tools-clear") return route.fulfill(json({ items: [] }));
    const st = (itemId, domain, severity, title, href) => ({
      itemId, domain, semanticCategory: "ACTION_REQUIRED", title, summary: null, severity, priorityScore: 50,
      entityRef: { type: domain, id: 1 }, state: "open", createdAt: ago(60),
      primaryAction: { kind: "navigate", label: "פתח", href }, sourceEngine: "qa",
    });
    return route.fulfill(json({ items: [
      st("b1", "billing", "HIGH", "2 חשבוניות באיחור", "/billing"),
      st("d1", "documents", "MEDIUM", "3 מסמכים מחכים לבדיקה", "/documents/inbox"),
      st("i1", "inbox", "HIGH", "לקוח מחכה לתשובה", "/inbox"),
      st("v1", "inventory", "MEDIUM", "חלב 3% עומד להיגמר", "/inventory"),
    ] }));
  }
  // Content studio generation, answered locally: no model or render provider is called.
  if (p === "/api/video/plan" && req.method() === "POST") {
    if (mode === "plan-error") return route.fulfill(json({ error: "failed_to_build_plan" }, 500));
    return route.fulfill(json({ success: true, variants: VARIANTS }));
  }
  if (p === "/api/content/decisions") return route.fulfill(json({ success: true }));
  if (p === "/api/content/render" && req.method() === "POST") {
    return route.fulfill(json({ renderId: "r-qa", status: "processing", url: null }));
  }
  if (p.startsWith("/api/content/render/status/")) {
    return route.fulfill(json({ id: "r-qa", status: "processing", url: null }));
  }
  // ── Carry-forward mocks ──
  if (p === "/api/data-transfer/import/analyze") {
    // A file analysis answered in the browser; nothing is stored or imported.
    return route.fulfill(json({
      ok: true, sheetName: null, availableSheets: [], headers: ["שם", "טלפון"], rowCount: 1,
      proposals: [
        { sourceIndex: 0, sourceHeader: "שם", field: "name", status: "EXACT", candidates: ["name"], samples: ["יוסי כהן"] },
        { sourceIndex: 1, sourceHeader: "טלפון", field: "phone", status: "EXACT", candidates: ["phone"], samples: ["0500000000"] },
      ],
      requiredFields: ["name"],
      importableFields: [{ field: "name", required: true, help: null }, { field: "phone", required: false, help: null }],
    }));
  }
  if (p.includes("/api/revenue/coupons/my-business")) {
    return route.fulfill(json({ business: {
      id: 1, name: "קפה נועה", city: "תל אביב", address: "דיזנגוף 100", phone: "050-000-0000",
      openingHours: null, category: "אוכל", subCategory: "בית קפה", businessModel: null,
      nameMissing: false, incomplete: [],
    } }));
  }
  if (p.includes("/api/revenue/coupons/mine") || p.includes("/api/revenue/coupons/active")) {
    return route.fulfill(json({ coupons: [] }));
  }
  if (p === "/api/revenue/coupons" && req.method() === "POST") {
    // Answered in the browser: the request never reaches a server, nothing is published.
    return route.fulfill(json({ coupon: {
      offerId: 901, publicId: "qa-coupon", token: "QA-TOKEN", qrValue: "https://example.com/c/qa-coupon",
      benefit: "20% הנחה", description: null, expiresAt: "2026-10-31T21:59:59.000Z", status: "ACTIVE",
    } }, 201));
  }
  const detail = p.match(/^\/api\/data-transfer\/historical\/records\/(\d+)$/);
  if (detail) {
    const id = Number(detail[1]);
    if (id === 404) return route.fulfill(json({ ok: false }, 404));
    const base = {
      id, currency: "ILS", sourceSystemCode: "OTHER", sourceSystemNameRaw: "המערכת הקודמת",
      sourceDocumentTypeRaw: "חשבונית מס קבלה", importedAt: ago(4000), customerTaxIdSnapshot: "514000000",
      reversesLinked: false, reversesOriginalNumberRaw: null, reverses: null, reversedBy: [],
    };
    const record = id === 4
      ? { ...base, documentTypeCode: "330", originalDocumentNumber: "20449", originalIssueDate: "2025-12-02",
          totalAmount: "-120.00", subtotalAmount: "-101.69", vatAmount: "-18.31",
          customerNameSnapshot: "דנה לוי — הזמנות אירועים ומגשי אירוח", reversesLinked: true,
          reverses: { id: 1, documentTypeCode: "320", originalDocumentNumber: "20451", originalIssueDate: "2025-12-28" } }
      : { ...base, documentTypeCode: "320", originalDocumentNumber: "20451", originalIssueDate: "2025-12-28",
          totalAmount: "1180.00", subtotalAmount: "1000.00", vatAmount: "180.00", customerNameSnapshot: "מאפיית השכונה",
          reversedBy: [{ id: 4, documentTypeCode: "330", originalDocumentNumber: "20449", originalIssueDate: "2025-12-02" }] };
    return route.fulfill(json({ ok: true, record }));
  }
  if (p.includes("/api/data-transfer/historical/records")) {
    const rec = (id, code, num, day, amount, customer) => ({
      id, documentTypeCode: code, originalDocumentNumber: num, originalIssueDate: `2025-${day}`,
      totalAmount: amount, currency: "ILS", customerNameSnapshot: customer,
      sourceSystemCode: "OTHER", sourceSystemNameRaw: "המערכת הקודמת", reversesLinked: false, reversesOriginalNumberRaw: null,
    });
    const items = [
      rec(1, "320", "20451", "12-28", "1180.00", "מאפיית השכונה"),
      rec(4, "330", "20449", "12-02", "-120.00", "דנה לוי — הזמנות אירועים ומגשי אירוח"),
    ];
    return route.fulfill(json({ ok: true, items, page: 1, pageSize: 20, total: 2, totalPages: 1,
      hasMore: false, sourceSystems: ["המערכת הקודמת"], emptyHistory: false }));
  }
  if (req.method() !== "GET") {
    // Nothing is written: every mutation answers "refused" without effect.
    return route.fulfill(json({ error: "qa-mock: writes are disabled" }, 409));
  }
  return route.fulfill(json({}));
}

const SHOTS_SCRIPT = [
  { visual: "תקריב על כוס קפה מהבילה על הבר", voice: "הבוקר מתחיל כאן" },
  { visual: "נועה מגישה קרואסון ללקוח", voice: "מאפים טריים כל בוקר מ-7:00" },
  { visual: "שלט הכניסה ברחוב", voice: "דיזנגוף 100 — קופצים?" },
];
const VARIANTS = [
  {
    id: "v1", title: "שיחה אמיתית מאחורי הבר", description: "נועה מדברת למצלמה בזמן שהיא מכינה קפה",
    whyItFits: "מרגיש טבעי ולא כמו פרסומת, ומזמין לשלוח הודעה", score: 92, tone: "חם", pace: "רגוע",
    videoType: "SHORT", durationSeconds: 25, structure: ["פתיחה", "מה מיוחד", "הזמנה"],
    script: { title: "בוקר אצל נועה", hook: "בואו לטעום את הקפה של הבוקר", caption: "קפה נועה פתוח היום מ-7:00", shots: SHOTS_SCRIPT },
  },
  {
    id: "v2", title: "30 שניות של בוקר", description: "רצף קצר של רגעים מהבוקר בבית הקפה",
    whyItFits: "עוצר גלילה בלי לדבר למצלמה", score: 84, tone: "אנרגטי", pace: "מהיר",
    videoType: "SHORT", durationSeconds: 30, structure: ["תנועה", "מוצר", "כתובת"],
    script: { hook: "ככה נראה בוקר טוב", caption: "מחכים לכם", shots: SHOTS_SCRIPT },
  },
  {
    id: "v3", title: "הלקוח הקבוע מספר", description: "לקוח קבוע מספר למה הוא חוזר כל יום — סיפור קצר ואמיתי שבונה אמון ומזמין להגיע",
    whyItFits: "בונה אמון דרך מישהו אחר", score: 78, tone: "אישי", pace: "בינוני",
    videoType: "MID", durationSeconds: 45, structure: ["סיפור", "רגש", "הזמנה"],
    script: { hook: "למה אני פה כל בוקר?", caption: "תודה שאתם כאן", shots: SHOTS_SCRIPT },
  },
];

const shots = [];
let readyNeedle = "";

async function snap(page, domain, file) {
  const dir = path.join(ROOT, domain);
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, file), fullPage: false });
  const metrics = await page.evaluate(() => {
    const de = document.documentElement;
    return { overflow: de.scrollWidth > de.clientWidth + 2 };
  });
  return { file: `${domain}/${file}`, ...metrics };
}

async function settle(page, needle) {
  await page.waitForFunction(
    (n) => {
      const text = document.body.innerText || "";
      return !text.includes("Compiling") && !text.includes("טוען…") && !text.includes("טוען...") && (!n || text.includes(n));
    },
    needle,
    { timeout: 90000 },
  );
  await page.waitForTimeout(350);
}

async function shoot(page, domain, label, width) {
  await page.setViewportSize({ width, height: 900 });
  await settle(page, readyNeedle);
  const result = await snap(page, domain, `${label}-${width}.png`);
  shots.push({ domain, label, width, ...result });
  console.log(domain, label, width, result.overflow ? "OVERFLOW" : "ok");
}

async function open(page, routePath, readyText) {
  readyNeedle = readyText;
  await page.goto(BASE + routePath, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForFunction(() => {
    const overlay = document.querySelector("[data-dubiz-intro-overlay]");
    return !overlay || getComputedStyle(overlay).opacity === "0";
  }, null, { timeout: 90000 });
  await settle(page, readyText);
}

async function widths(page, domain, label, list = ALL) {
  for (const width of list) await shoot(page, domain, label, width);
}

const browser = await chromium.launch({ headless: true });

async function newContext(storage = {}) {
  const context = await browser.newContext({ locale: "he-IL", timezoneId: "Asia/Jerusalem", reducedMotion: "reduce" });
  await context.addInitScript((extra) => {
    localStorage.setItem("token", "desktop-ux-qa");
    localStorage.setItem("user", JSON.stringify({ id: 1, name: "נועה", businessId: 1 }));
    localStorage.setItem("dubiz.home.identity.v1", "dubiz");
    for (const [key, value] of Object.entries(extra)) localStorage.setItem(key, value);
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = "nextjs-portal{display:none!important}";
      document.head.appendChild(style);
    });
  }, storage);
  await context.route("**/api/**", fulfill);
  return context;
}

const context = await newContext();
const page = await context.newPage();

const scenarios = [];
const scenario = (name, run) => scenarios.push({ name, run });

// ── Inbox ───────────────────────────────────────────────────────────────────
scenario("inbox-list", async () => {
  mode = "populated";
  await open(page, "/inbox", "שיחות");
  await widths(page, "inbox", "list");
});
scenario("inbox-selected", async () => {
  mode = "populated";
  await open(page, "/inbox?conversationId=11", "ההובלה");
  await widths(page, "inbox", "selected-long", [390, 768, 1024, 1280, 1440, 1920]);
  await open(page, "/inbox?conversationId=13", "פתוחים בשבת");
  await widths(page, "inbox", "selected-short", [1440]);
});
scenario("inbox-closed", async () => {
  mode = "populated";
  await open(page, "/inbox?conversationId=14", "היה מושלם");
  await widths(page, "inbox", "selected-closed", [1440, 1920]);
});
scenario("inbox-gates", async () => {
  mode = "wa-never";
  await open(page, "/inbox", "");
  await page.waitForTimeout(1500);
  await widths(page, "inbox", "whatsapp-onboarding", [390, 1440, 1920]);
  mode = "wa-broken";
  await open(page, "/inbox", "שיחות");
  await widths(page, "inbox", "reconnect-banner", [1440]);
  mode = "populated";
});
scenario("inbox-empty", async () => {
  mode = "inbox-empty";
  await open(page, "/inbox", "");
  await page.waitForTimeout(1500);
  await widths(page, "inbox", "empty", [390, 1440, 1920]);
  mode = "populated";
});
scenario("inbox-error", async () => {
  mode = "inbox-error";
  await open(page, "/inbox", "");
  await page.waitForTimeout(1500);
  await widths(page, "inbox", "error", [1440]);
  mode = "populated";
});

// ── Tools ───────────────────────────────────────────────────────────────────
scenario("tools-home", async () => {
  mode = "populated";
  await open(page, "/tools", "כסף וחשבוניות");
  await widths(page, "tools", "home", ALL);
  mode = "tools-clear";
  await open(page, "/tools", "כסף וחשבוניות");
  await widths(page, "tools", "home-clear", [1440]);
  mode = "populated";
});
scenario("tools-category", async () => {
  mode = "populated";
  for (const slug of ["money", "customers", "operations"]) {
    await open(page, `/tools/${slug}`, "");
    await page.waitForTimeout(800);
    await widths(page, "tools", `category-${slug}`, slug === "money" ? ALL : [390, 1440, 1920]);
  }
});

// ── Content studio generated states (carry-forward B) ──────────────────────
const FLOW_GEN = JSON.stringify({
  vibe: "warm_personal", canFilm: true, mode: "camera", creationEntryMode: "reel_from_assets",
  primaryGoal: "leads", goal: "leads", selectedPlatform: "instagram", contentAngle: "trust",
  contentArchetypeId: "authentic", directionType: "authentic", directionReasoning: "מרגיש טבעי ולא כמו פרסומת",
  creatorContext: "בית קפה שכונתי, מאפים טריים כל בוקר", contentGoalPrompt: "להביא לקוחות בבוקר",
  selectedDirection: { id: "authentic", title: "שיחה אמיתית", recommendedFormat: "reel" },
  selectedFormat: "reel", audienceTypes: ["local"],
});
scenario("studio-generated", async () => {
  mode = "populated";
  const ctx = await newContext({ content_flow: FLOW_GEN });
  const p = await ctx.newPage();
  await open(p, "/content/creator-plan", "שיחה אמיתית מאחורי הבר");
  await widths(p, "content-studio", "plan-variants", [390, 1280, 1440, 1920]);
  await ctx.close();
  mode = "plan-error";
  const ctxE = await newContext({ content_flow: FLOW_GEN });
  const pe = await ctxE.newPage();
  await open(pe, "/content/creator-plan", "לא הצלחנו להרכיב");
  await widths(pe, "content-studio", "plan-error", [1440]);
  await ctxE.close();
  mode = "populated";
  const result = JSON.stringify({ selectedVariant: VARIANTS[0], variants: VARIANTS });
  const ctx2 = await newContext({ content_flow: FLOW_GEN, content_result: result });
  const p2 = await ctx2.newPage();
  await open(p2, "/content/shot-direction", "תקריב על כוס קפה");
  await widths(p2, "content-studio", "shots-populated", [390, 1440, 1920]);
  await ctx2.close();
  const ctx3 = await newContext({
    content_flow: FLOW_GEN, content_result: result,
    content_assets: JSON.stringify({ "shot-1": "https://example.com/1.mp4", "shot-2": "https://example.com/2.mp4" }),
  });
  const p3 = await ctx3.newPage();
  await open(p3, "/content/render", "");
  await p3.waitForTimeout(2500);
  await widths(p3, "content-studio", "render-working", [390, 1440]);
  await ctx3.close();
});

// ── Slice 6 carry-forward C–E, plus the offering fields from main ──────────
scenario("carry-coupon-published", async () => {
  mode = "populated";
  await open(page, "/revenue?view=create", "מה תרצה שהקופון");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: /להחזיר לקוחות/ }).first().click();
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: /^הנחה/ }).first().click();
  await page.getByText("מה הלקוח מקבל").first().waitFor();
  await page.getByRole("button", { name: /^אחוז הנחה/ }).first().click();
  await page.getByRole("button", { name: /^המשך$/ }).first().click();
  await page.waitForTimeout(400);
  readyNeedle = "";
  await widths(page, "offers", "create-terms", [1440]);
  await page.getByRole("button", { name: /צור את הקופון/ }).first().click();
  readyNeedle = "הקופון שלך פורסם";
  await widths(page, "offers", "create-published", [390, 1024, 1280, 1440, 1920]);
});
scenario("carry-historical-detail", async () => {
  mode = "populated";
  await open(page, "/settings/import-export/historical/records", "מאפיית השכונה");
  await widths(page, "settings", "historical-records-rowlink", [1440]);
  await open(page, "/settings/import-export/historical/records/1", "20451");
  await widths(page, "settings", "historical-record", [390, 768, 1280, 1440, 1920]);
  await open(page, "/settings/import-export/historical/records/4", "20449");
  await widths(page, "settings", "historical-record-credit", [1440]);
  await open(page, "/settings/import-export/historical/records/404", "המסמך לא נמצא");
  await widths(page, "settings", "historical-record-missing", [1440]);
});
scenario("carry-import-export", async () => {
  mode = "populated";
  for (const [route, slug, needle] of [
    ["/settings/import-export/import", "import", "ייבוא"],
    ["/settings/import-export/documents", "import-documents", "ייבוא מסמכים"],
    ["/settings/import-export/export", "export", "ייצוא"],
  ]) {
    await open(page, route, needle);
    await widths(page, "settings", `regression-${slug}`, [390, 768, 1024]);
  }
  // The recoloured primary actions, enabled. Choosing a domain writes nothing.
  await open(page, "/settings/import-export/export", "ייצוא");
  await page.getByText("לקוחות").first().click();
  readyNeedle = "";
  await widths(page, "settings", "regression-export-enabled", [390, 768, 1024]);
  await open(page, "/settings/import-export/import", "ייבוא");
  await page.getByText("לקוחות").first().click();
  await page.waitForTimeout(500);
  readyNeedle = "";
  await widths(page, "settings", "regression-import-picked", [390, 768, 1024]);
  await page.locator('input[type="file"]').first().setInputFiles({
    name: "customers.csv", mimeType: "text/csv", buffer: Buffer.from("שם,טלפון\nיוסי כהן,0500000000\n"),
  });
  await page.waitForTimeout(800);
  for (const width of [390, 768, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole("button", { name: "בדקו את הקובץ" }).scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, 160));
    await shoot(page, "settings", "regression-import-check", width);
  }
});
scenario("offering-item-create", async () => {
  mode = "populated";
  await open(page, "/inventory/items/create", "מוצר שהעסק רוצה להבליט");
  await widths(page, "inventory", "create-item-offering", [390, 1280, 1440, 1920]);
});
scenario("tools-category-clear", async () => {
  mode = "tools-clear";
  await open(page, "/tools/money", "כסף וחשבוניות");
  await page.waitForTimeout(800);
  await widths(page, "tools", "category-money-clear", [1440]);
  mode = "populated";
});

for (const s of scenarios) {
  if (ONLY.length && !ONLY.some((prefix) => s.name.startsWith(prefix))) continue;
  try {
    await s.run();
  } catch (error) {
    console.error("SCENARIO FAILED", s.name, error.message.split("\n")[0]);
    process.exitCode = 1;
  }
}

await browser.close();
const overflow = shots.filter((shot) => shot.overflow);
if (!ONLY.length) {
  fs.writeFileSync(
    path.join(ROOT, "slice7-metrics.json"),
    JSON.stringify({ count: shots.length, overflow: overflow.length, shots }, null, 2),
  );
}
console.log("SHOTS", shots.length, "OVERFLOW", overflow.length);
if (overflow.length) process.exitCode = 2;
