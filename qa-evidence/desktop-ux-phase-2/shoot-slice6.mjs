/**
 * Runtime visual QA for Desktop UX Phase 2 slice 6:
 * settings, business, offers (coupons), content studio.
 *
 * Every /api call is mocked. Nothing connects a provider, sends a message,
 * publishes a coupon, or generates content.
 *
 *   node qa-evidence/desktop-ux-phase-2/shoot-slice6.mjs            # everything
 *   ONLY=settings-hub,offers node qa-evidence/...                   # by scenario prefix
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.QA_BASE || "http://localhost:3010";
const ROOT = path.resolve("qa-evidence/desktop-ux-phase-2");
const ALL = [390, 768, 1024, 1280, 1440, 1600, 1920];
const ONLY = (process.env.ONLY || "").split(",").filter(Boolean);

let mode = "connected";

function json(body, status = 200) {
  return { status, contentType: "application/json", body: JSON.stringify(body) };
}

const ISO = (d) => `2026-${d}T08:00:00.000+03:00`;

function coupon(partial) {
  return {
    publicId: "c1",
    benefit: "10% הנחה על כל העסק",
    description: null,
    state: "ACTIVE",
    issuedAt: ISO("09-01"),
    expiresAt: ISO("12-01"),
    redeemedAt: null,
    createdAt: ISO("09-01"),
    offerId: 3,
    redemptionCount: 0,
    ...partial,
  };
}

const COUPONS = [
  coupon({ publicId: "c1", benefit: "10% הנחה על כל העסק", redemptionCount: 4 }),
  coupon({ publicId: "c4", benefit: "1+1 על מאפים בימי ראשון", description: "בתוקף רק בקופה, עד 2 לאדם", issuedAt: ISO("09-12"), expiresAt: ISO("10-31"), redemptionCount: 11 }),
  coupon({ publicId: "c2", benefit: "קפה שני במתנה", state: "DISABLED", issuedAt: ISO("08-20") }),
  coupon({ publicId: "c3", benefit: "הטבת פתיחה — 20 ש״ח על קנייה ראשונה מעל 80 ש״ח לכל לקוח חדש שמגיע מהשכונה", state: "EXPIRED", issuedAt: ISO("06-01"), expiresAt: ISO("08-01"), redemptionCount: 27 }),
  coupon({ publicId: "c5", benefit: "עוגייה מתנה", state: "REDEEMED", issuedAt: ISO("09-02"), redeemedAt: ISO("09-05"), redemptionCount: 1 }),
];

function invoiceProfile(complete) {
  return {
    profile: complete
      ? {
          billingLegalName: "קפה נועה",
          billingBusinessKind: "עוסק מורשה",
          billingTaxId: "514123456",
          billingPhone: "050-000-0000",
          billingEmail: "noa@example.com",
          billingAddress: "דיזנגוף 100, תל אביב",
          billingVatNumber: "514123456",
          billingPaymentNote: "העברה בנקאית",
          billingFooterNote: "תודה שקניתם אצלנו",
        }
      : {},
    identityComplete: complete,
  };
}

async function fulfill(route) {
  const req = route.request();
  const p = new URL(req.url()).pathname;
  if (p.includes("/api/auth/me")) {
    return route.fulfill(json({ user: { name: "נועה לוי", email: "noa@example.com", businessName: "קפה נועה" } }));
  }
  if (p.includes("/api/business/profile")) {
    return route.fulfill(json({
      profile: mode === "business-sparse"
        ? {}
        : { category: "אוכל", subCategory: "בית קפה", billingAddress: "דיזנגוף 100, תל אביב" },
    }));
  }
  if (p.includes("/api/billing/invoice-profile")) {
    if (req.method() === "PATCH" && mode === "business-invalid") {
      return route.fulfill(json({ error: "שם העסק במסמך הוא שדה חובה" }, 400));
    }
    return route.fulfill(json(invoiceProfile(mode !== "business-sparse")));
  }
  if (p.includes("/api/integrations/gmail/status")) {
    return route.fulfill(json(mode === "disconnected" ? { connected: false } : { connected: true, emailAddress: "noa.cafe@gmail.com" }));
  }
  if (p.includes("/api/integrations/whatsapp/connection")) {
    if (mode === "wa-error") return route.fulfill(json({ error: "unavailable" }, 500));
    if (mode === "disconnected") return route.fulfill(json({ connection: null }));
    return route.fulfill(json({
      connection: {
        status: "CONNECTED",
        displayPhoneNumber: "+972 50-000-0000",
        phoneNumberId: "pn",
        wabaId: "waba",
        lastVerifiedAt: ISO("09-20"),
        updatedAt: ISO("09-20"),
      },
    }));
  }
  if (p.includes("/api/taxes/authority/status")) {
    return route.fulfill(json({
      authority: {
        environment: "SANDBOX",
        status: mode === "disconnected" ? "DISCONNECTED" : "CONNECTED",
        connectedAt: ISO("09-01"),
        expiresAt: "2027-09-01T08:00:00.000+03:00",
        canConnect: mode === "disconnected",
        canReconnect: mode !== "disconnected",
      },
    }));
  }
  if (p.includes("/api/payments/providers")) {
    return route.fulfill(json({ providers: [] }));
  }
  if (p.includes("/api/payments/connections")) {
    return route.fulfill(json({
      connections: mode === "disconnected"
        ? []
        : [{ provider: "PAYPLUS", merchantId: "noa-cafe", isActive: true, hasCredential: true }],
    }));
  }
  if (p.includes("/api/security/sessions")) {
    return route.fulfill(json({
      currentIdentified: true,
      sessions: [
        { id: "s1", current: true, label: "Chrome · Windows", createdAt: ISO("09-01"), lastUsedAt: ISO("09-29"), expiresAt: ISO("10-29"), status: "active" },
        { id: "s2", current: false, label: "Safari · iPhone", createdAt: ISO("08-14"), lastUsedAt: ISO("09-27"), expiresAt: ISO("10-14"), status: "active" },
        { id: "s3", current: false, label: "Chrome · Android", createdAt: ISO("07-02"), lastUsedAt: ISO("08-02"), expiresAt: ISO("08-30"), status: "expired" },
      ],
    }));
  }
  if (p.includes("/api/business/bot-hub")) {
    return route.fulfill(json({
      identity: { displayName: "הבוט של נועה", avatar: null },
      runtime: { workMode: "SMART_DRAFTS" },
      signals: {
        welcomeOk: true, questionsCount: 2, finishOk: true, productLinkOk: false,
        workModeManual: false, goalsCount: 1, learningCount: 0, personalityOk: true,
        approachOk: true, knowledgeOk: true,
      },
    }));
  }
  if (p.includes("/api/business/bot-settings")) {
    return route.fulfill(json({
      settings: {
        enabled: true,
        showDraftSuggestionsInInbox: true,
        welcomeMessage: "שלום, איך אפשר לעזור?",
        questions: { items: ["לאיזה סניף?", "כמה אנשים?"] },
        finalAction: "LEAVE_MESSAGE",
        handoffRules: null,
        productLinkEnabled: false,
        productLinkUrl: "",
        productLinkIntro: "",
      },
    }));
  }
  if (p.includes("/api/revenue/coupons/mine")) {
    return route.fulfill(json({ coupons: mode === "offers-empty" ? [] : COUPONS }));
  }
  if (p.includes("/api/revenue/coupons/my-business")) {
    return route.fulfill(json({
      business: {
        id: 1, name: "קפה נועה", city: "תל אביב", address: "דיזנגוף 100", phone: "050-000-0000",
        openingHours: null, category: "אוכל", subCategory: "בית קפה", businessModel: null,
        nameMissing: false, incomplete: [],
      },
    }));
  }
  if (p.includes("/api/revenue/coupons/active")) {
    return route.fulfill(json({ coupons: [] }));
  }
  if (p.includes("/api/data-transfer/historical/records")) {
    const rec = (id, code, num, day, amount, customer) => ({
      id, documentTypeCode: code, originalDocumentNumber: num, originalIssueDate: `2025-${day}`,
      totalAmount: amount, currency: "ILS", customerNameSnapshot: customer,
      sourceSystemCode: "OTHER", sourceSystemNameRaw: "המערכת הקודמת",
      reversesLinked: false, reversesOriginalNumberRaw: null,
    });
    const items = [
      rec(1, "320", "20451", "12-28", "1180.00", "מאפיית השכונה"),
      rec(2, "320", "20450", "12-21", "354.00", "יוסי כהן"),
      rec(3, "400", "7712", "12-19", "354.00", "יוסי כהן"),
      rec(4, "330", "20449", "12-02", "-120.00", "דנה לוי — הזמנות אירועים ומגשי אירוח"),
      rec(5, "305", "20448", "11-30", "2400.00", null),
    ];
    return route.fulfill(json({
      ok: true, items, page: 1, pageSize: 20, total: items.length, totalPages: 1,
      hasMore: false, sourceSystems: ["המערכת הקודמת"], emptyHistory: false,
    }));
  }
  if (p.includes("/api/account")) {
    return route.fulfill(json({ email: "noa@example.com" }));
  }
  return route.fulfill(json({}));
}

const shots = [];
let readyNeedle = "";

async function snap(page, domain, file) {
  const dir = path.join(ROOT, domain);
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, file), fullPage: false });
  const metrics = await page.evaluate(() => {
    const de = document.documentElement;
    return {
      overflow: de.scrollWidth > de.clientWidth + 2,
      text: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 240),
    };
  });
  return { file: `${domain}/${file}`, ...metrics };
}

/** Ready = needle present, nothing still "טוען…", no dev compile badge. */
async function settle(page, needle) {
  await page.waitForFunction(
    (n) => {
      const text = document.body.innerText || "";
      return !text.includes("Compiling") && !text.includes("טוען…") && !text.includes("טוען...") && (!n || text.includes(n));
    },
    needle,
    { timeout: 90000 },
  );
  await page.waitForTimeout(300);
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
    // Evidence shows the product, not the Next dev badge.
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

// ── Settings ────────────────────────────────────────────────────────────────
scenario("settings-hub", async () => {
  mode = "connected";
  await open(page, "/settings", "הגדרות");
  await widths(page, "settings", "hub");
});
scenario("settings-hub-disconnected", async () => {
  mode = "disconnected";
  await open(page, "/settings", "הגדרות");
  await widths(page, "settings", "hub-disconnected", [1440]);
});
scenario("settings-account", async () => {
  mode = "connected";
  await open(page, "/settings/team", "המשתמש שלך");
  await widths(page, "settings", "account", [390, 1440, 1920]);
});
scenario("settings-business", async () => {
  mode = "connected";
  await open(page, "/settings/business", "פרטי העסק");
  await widths(page, "settings", "business-pointer", [1440]);
});
scenario("settings-connections", async () => {
  mode = "connected";
  await open(page, "/settings/connections", "Gmail");
  await widths(page, "settings", "connections-connected", [390, 1024, 1280, 1440, 1920]);
  mode = "disconnected";
  await open(page, "/settings/connections", "Gmail");
  await widths(page, "settings", "connections-disconnected", [390, 1440, 1920]);
});
scenario("settings-locale", async () => {
  await open(page, "/settings/workspace", "שפה ואזור");
  await widths(page, "settings", "locale", [390, 1440]);
});
scenario("settings-devices", async () => {
  await open(page, "/settings/security", "Safari");
  await widths(page, "settings", "devices", [390, 1440, 1920]);
});
scenario("settings-delete", async () => {
  await open(page, "/settings/account", "חשבון ופרטיות");
  await widths(page, "settings", "account-delete", [390, 1440]);
});
scenario("settings-import-export", async () => {
  await open(page, "/settings/import-export", "ייבוא וייצוא");
  await widths(page, "settings", "import-export", [390, 1440]);
  await open(page, "/settings/import-export/import", "ייבוא");
  await widths(page, "settings", "import", [1440]);
  await open(page, "/settings/import-export/export", "ייצוא");
  await widths(page, "settings", "export", [390, 1440]);
  await open(page, "/settings/import-export/templates", "תבניות");
  await widths(page, "settings", "templates", [1440]);
  await open(page, "/settings/import-export/documents", "ייבוא מסמכים");
  await widths(page, "settings", "documents-import", [1440]);
  await open(page, "/settings/import-export/historical", "");
  await page.waitForTimeout(1200);
  await widths(page, "settings", "historical", [1440]);
  await open(page, "/settings/import-export/historical/records", "מאפיית השכונה");
  await widths(page, "settings", "historical-records", [390, 1280, 1440, 1920]);
});
scenario("settings-whatsapp", async () => {
  mode = "connected";
  await open(page, "/settings/whatsapp", "WhatsApp");
  await widths(page, "settings", "whatsapp-connected", [390, 1440, 1920]);
  mode = "disconnected";
  await open(page, "/settings/whatsapp", "WhatsApp");
  await widths(page, "settings", "whatsapp-disconnected", [390, 1440]);
  mode = "wa-error";
  await open(page, "/settings/whatsapp", "WhatsApp");
  await widths(page, "settings", "whatsapp-error", [1440]);
  mode = "connected";
});

// ── Business ────────────────────────────────────────────────────────────────
scenario("business-identity", async () => {
  mode = "connected";
  await open(page, "/business", "זהות עסקית");
  await widths(page, "business", "identity-populated");
  mode = "business-sparse";
  await open(page, "/business", "זהות עסקית");
  await widths(page, "business", "identity-sparse", [390, 1440, 1920]);
  mode = "business-invalid";
  await open(page, "/business", "זהות עסקית");
  await page.getByRole("button", { name: "שמור שינויים" }).click();
  readyNeedle = "שדה חובה";
  await widths(page, "business", "identity-error", [390, 1440]);
  mode = "connected";
});
scenario("business-bot", async () => {
  mode = "connected";
  await open(page, "/business/bot", "הבוט שלי");
  await widths(page, "business", "bot-hub", [390, 1024, 1440, 1920]);
  await open(page, "/business/bot-settings", "כך יראה הלקוח");
  await widths(page, "business", "bot-editor", [390, 1024, 1440, 1920]);
});

scenario("business-bot-more", async () => {
  mode = "connected";
  await open(page, "/business/bot", "הבוט שלי");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: /מי הבוט/ }).first().click();
  await page.waitForTimeout(500);
  readyNeedle = "";
  await widths(page, "business", "bot-sheet", [390, 1440]);
  await open(page, "/business/bot-settings/goal", "");
  await page.waitForTimeout(1500);
  await widths(page, "business", "bot-area", [390, 1440]);
  await open(page, "/business/bot/setup/success", "");
  await page.waitForTimeout(1500);
  await widths(page, "business", "bot-success", [390, 1440]);
});

// ── Offers (coupons) ────────────────────────────────────────────────────────
scenario("offers-empty", async () => {
  mode = "offers-empty";
  await open(page, "/revenue", "עדיין לא יצרת קופון");
  await widths(page, "offers", "empty", [390, 1440, 1920]);
  mode = "connected";
});
scenario("offers-populated", async () => {
  mode = "connected";
  await open(page, "/revenue", "הקופונים שלי");
  await widths(page, "offers", "populated");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("option", { name: /קפה שני/ }).click();
  readyNeedle = "הפעל מחדש";
  await widths(page, "offers", "selected-disabled", [1440, 1920]);
  // Keyboard: the row after "קפה שני" is the long, expired coupon.
  await page.keyboard.press("ArrowDown");
  readyNeedle = "הטבת פתיחה";
  await widths(page, "offers", "selected-expired-long", [1280, 1440]);
});
scenario("offers-create", async () => {
  mode = "connected";
  await open(page, "/revenue?view=create", "מה תרצה שהקופון");
  await widths(page, "offers", "create-goal", [390, 1024, 1280, 1440, 1920]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: /להחזיר לקוחות/ }).first().click();
  await page.waitForTimeout(400);
  readyNeedle = "";
  await widths(page, "offers", "create-direction", [390, 1440, 1920]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: /^הנחה/ }).first().click();
  readyNeedle = "מה הלקוח מקבל";
  await widths(page, "offers", "create-builder", [390, 1280, 1440, 1920]);
});

// ── Content studio ──────────────────────────────────────────────────────────
const FLOW_EARLY = JSON.stringify({ vibe: "warm_personal", canFilm: true, mode: "camera", creationEntryMode: "reel_from_assets" });
const FLOW_FULL = JSON.stringify({
  vibe: "warm_personal", canFilm: true, mode: "camera", creationEntryMode: "reel_from_assets",
  primaryGoal: "leads", goal: "leads", selectedPlatform: "instagram",
  contentArchetypeId: "authentic", directionType: "authentic", directionReasoning: "מרגיש טבעי ולא כמו פרסומת",
  creatorContext: "בית קפה שכונתי, מאפים טריים כל בוקר", selectedFormat: "reel",
});
const RESULT = JSON.stringify({
  selectedVariant: { id: "v1", script: { hook: "בואו לטעום את הקפה של הבוקר", caption: "קפה נועה פתוח היום מ-7:00" } },
});
const RENDER = JSON.stringify({ renderId: "r1", status: "succeeded", url: "https://example.com/qa-video.mp4" });

scenario("content-home", async () => {
  const ctx = await newContext({});
  const p = await ctx.newPage();
  await open(p, "/content", "איך בא לך שהתוכן ירגיש");
  await widths(p, "content-studio", "home");
  await p.setViewportSize({ width: 1440, height: 900 });
  await p.getByRole("radio").nth(1).click();
  readyNeedle = "להצטלם";
  await widths(p, "content-studio", "home-vibe", [390, 1280, 1440, 1920]);
  await ctx.close();
});
scenario("content-steps", async () => {
  const ctx = await newContext({ content_flow: FLOW_EARLY });
  const p = await ctx.newPage();
  await open(p, "/content/goal", "מה הכי חשוב");
  await widths(p, "content-studio", "goal", [390, 1024, 1280, 1440, 1920]);
  await p.getByRole("radio").first().click();
  readyNeedle = "איפה זה יעלה";
  await widths(p, "content-studio", "goal-selected", [1440]);
  await ctx.close();
  const ctx2 = await newContext({ content_flow: FLOW_FULL });
  const p2 = await ctx2.newPage();
  await open(p2, "/content/archetype", "שיחה אמיתית");
  await widths(p2, "content-studio", "archetype", [390, 1440, 1920]);
  await open(p2, "/content/setup", "המשך");
  await widths(p2, "content-studio", "setup", [390, 1440]);
  await ctx2.close();
});
scenario("content-result", async () => {
  const ctx = await newContext({ content_flow: FLOW_FULL, content_result: RESULT, content_render_output: RENDER });
  const p = await ctx.newPage();
  await open(p, "/content/result", "הסרטון מוכן");
  await widths(p, "content-studio", "result", [390, 1024, 1440, 1920]);
  await ctx.close();
});
// One frame check per remaining studio route: the frame lives in the layout,
// so each route is verified to sit in the working column beside the brief
// without overflow. APIs answer {} — the step shows its own empty/error copy.
// Reachable routes only. flow, mode, intent, value, style, context and summary
// are linked only from each other and from nowhere in the product.
const STUDIO_ROUTES = [
  "creator-plan", "shot-direction", "assets-upload", "ai-assets", "render",
  "create", "assets", "generate", "format", "direction", "ai-brief",
];
scenario("content-sweep", async () => {
  const ctx = await newContext({ content_flow: FLOW_FULL, content_result: RESULT });
  const p = await ctx.newPage();
  for (const route of STUDIO_ROUTES) {
    await open(p, `/content/${route}`, "");
    await p.waitForTimeout(1200);
    await widths(p, "content-studio", `sweep-${route}`, [1440]);
  }
  await ctx.close();
});
scenario("content-missing", async () => {
  const ctx = await newContext({});
  const p = await ctx.newPage();
  await open(p, "/content/result", "");
  await widths(p, "content-studio", "result-missing", [390, 1440]);
  await ctx.close();
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
    path.join(ROOT, "slice6-metrics.json"),
    JSON.stringify({ shots: shots.length, overflow: overflow.length, shots }, null, 2),
  );
}
console.log("SHOTS", shots.length, "OVERFLOW", overflow.length);
if (overflow.length) process.exitCode = 2;
