/**
 * Service Desk UI 1.3a, PR 1 — state and layout evidence for /service-desk and /service-desk/settings.
 *
 * Renders the REAL pages (real components, real CSS) against STUBBED API responses, so every state can be captured
 * without any database or business data: the module not open, the home, a new business's settings, saved settings,
 * validation, read-only, a version conflict, a successful save, the leave-without-saving confirm and an inactive default
 * technician. Synthetic data only; nothing is written anywhere.
 *
 * For each state and width it asserts:
 *   - RTL on the document, no horizontal overflow, the "חזרה" control present
 *   - the state's own content (and, for writes, the request the page sent: body, Idempotency-Key, no business id)
 *
 *   AUDIT_BASE_URL=http://localhost:3197 AUDIT_OUT_DIR=<dir> node scripts/qa/ui/service-desk-settings-states.mjs
 */
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.AUDIT_BASE_URL || "http://localhost:3197";
const OUT = process.env.AUDIT_OUT_DIR || path.join(process.cwd(), ".service-desk-settings");
const VIEWPORTS = [
  { width: 360, height: 800 },
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
];

const results = [];
function check(name, cond, detail = "") {
  results.push({ name, pass: Boolean(cond), detail: String(detail) });
  console.log(`${cond ? "OK  " : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

/* ----------------------------------------------------------- fixtures -- */

const STAFF = [{ id: 11, displayName: "דנה כהן" }, { id: 12, displayName: "יוסי לוי" }];
const EMPTY = { version: null, defaultStaffMemberId: null, warrantyTemplate: null, activeTermsVersionId: null, activeStatutoryNoticeVersionId: null };
const SAVED = {
  version: 4, defaultStaffMemberId: 11,
  warrantyTemplate: { value: 6, unit: "MONTHS", scope: "חלקים שהוחלפו ועבודת התיקון", exclusions: "נזקי מים ושבר מסך לאחר המסירה" },
  activeTermsVersionId: null, activeStatutoryNoticeVersionId: null,
};
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const STATES = {
  "home-not-open": { page: "/service-desk", access: 404 },
  "home": { page: "/service-desk", access: "FULL" },
  "settings-new": { page: "/service-desk/settings", access: "FULL", settings: EMPTY },
  "settings-saved": { page: "/service-desk/settings", access: "FULL", settings: SAVED },
  "settings-invalid": { page: "/service-desk/settings", access: "FULL", settings: EMPTY, act: "invalid" },
  "settings-read-only": { page: "/service-desk/settings", access: "READ_ONLY", settings: SAVED },
  "settings-conflict": { page: "/service-desk/settings", access: "FULL", settings: SAVED, put: { status: 409, body: { error: "VERSION_CONFLICT" } }, act: "save" },
  "settings-saved-toast": { page: "/service-desk/settings", access: "FULL", settings: EMPTY, put: { status: 200 }, act: "save-new" },
  "settings-leave-confirm": { page: "/service-desk/settings", access: "FULL", settings: SAVED, act: "leave" },
  "settings-inactive-technician": { page: "/service-desk/settings", access: "FULL", settings: { ...SAVED, defaultStaffMemberId: 99 } },
};

/* -------------------------------------------------------------- stubs -- */

const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function installStubs(page, s, sent) {
  // Catch-all first: Playwright gives the LAST registered matching route priority.
  await page.route("**/api/**", (route) => json(route, {}));
  await page.route("**/api/business/capabilities", (route) =>
    json(route, { features: { service_desk: { allowed: s.access === "FULL", reasonCode: s.access === "FULL" ? "BUSINESS_ENABLED" : "GLOBAL_DEFAULT", reasonLabel: "" } } }));
  await page.route("**/api/service-desk/access", (route) => (s.access === 404 ? json(route, { error: "NOT_FOUND" }, 404) : json(route, { mode: s.access })));
  await page.route("**/api/service-desk/staff", (route) => json(route, { staff: STAFF }));
  await page.route("**/api/service-desk/settings", async (route) => {
    const req = route.request();
    if (req.method() === "GET") return json(route, s.settings);
    sent.push({ method: req.method(), key: req.headers()["idempotency-key"] ?? null, body: req.postDataJSON() });
    if (!s.put) return json(route, { error: "INTERNAL" }, 500);
    if (s.put.status !== 200) return json(route, s.put.body, s.put.status);
    const b = req.postDataJSON();
    return json(route, { ...s.settings, version: (s.settings.version ?? 0) + 1, defaultStaffMemberId: b.defaultStaffMemberId, warrantyTemplate: b.warrantyTemplate, replayed: false });
  });
}

/* ---------------------------------------------------------------- main -- */

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  for (const [key, s] of Object.entries(STATES)) {
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, locale: "he-IL", reducedMotion: "reduce" });
      const page = await ctx.newPage();
      const sent = [];
      await installStubs(page, s, sent);
      await page.addInitScript(() => {
        try {
          localStorage.setItem("token", "qa-stub-token");
        } catch {
          /* ignore */
        }
      });
      await page.goto(`${BASE}${s.page}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("h1", { timeout: 180000 });
      const tag = `${key} @${vp.width}`;

      if (s.page === "/service-desk/settings" && s.access !== 404) await page.waitForSelector("#sd-tech", { timeout: 120000 });
      else await page.waitForSelector(s.access === 404 ? "text=עדיין לא פתוחה" : "text=הגדרות שירות", { timeout: 120000 });

      if (s.act === "invalid") {
        await page.getByLabel("העסק נותן אחריות על תיקונים").check();
        await page.fill("#sd-w-value", "0");
        await page.click("button[type=submit]");
        await page.waitForSelector("#sd-w-scope-p", { timeout: 10000 });
      }
      if (s.act === "save") {
        await page.fill("#sd-w-value", "12");
        await page.click("button[type=submit]");
        await page.waitForSelector("[role=alert] >> text=רענן", { timeout: 10000 });
      }
      if (s.act === "save-new") {
        await page.selectOption("#sd-tech", "12");
        await page.getByLabel("העסק נותן אחריות על תיקונים").check();
        await page.fill("#sd-w-value", "3");
        await page.fill("#sd-w-scope", "  עבודת התיקון בלבד  ");
        await page.click("button[type=submit]");
        await page.waitForSelector("text=ההגדרות נשמרו", { timeout: 10000 });
      }
      if (s.act === "leave") {
        await page.selectOption("#sd-tech", "");
        await page.click("[data-back-button], header button, header a", { timeout: 10000 });
        await page.waitForSelector("text=יש שינויים שלא נשמרו", { timeout: 10000 });
      }
      await page.waitForTimeout(500);

      const m = await page.evaluate(() => ({
        dir: document.documentElement.getAttribute("dir"),
        scrollW: document.documentElement.scrollWidth,
        iw: window.innerWidth,
        back: !!document.querySelector("header a, header button"),
        text: document.body.innerText,
        submit: document.querySelector("button[type=submit]")?.textContent ?? null,
        submitDisabled: document.querySelector("button[type=submit]")?.disabled ?? null,
        disabledInputs: [...document.querySelectorAll("#sd-tech, input[type=checkbox]")].every((e) => e.disabled),
        options: [...document.querySelectorAll("#sd-tech option")].map((o) => o.textContent),
        nav: [...document.querySelectorAll("nav a")].map((a) => a.textContent?.trim() ?? ""),
      }));
      check(`${tag}: RTL`, m.dir === "rtl", m.dir);
      check(`${tag}: no horizontal overflow`, m.scrollW <= m.iw + 1, `${m.scrollW} vs ${m.iw}`);
      check(`${tag}: the "חזרה" control is present`, m.back);
      if (vp.width === 1440) {
        const inNav = m.nav.some((t) => t.includes("תיקונים ושירות"));
        check(`${tag}: «ניהול העסק» lists the module only while service_desk is ON`, s.access === "FULL" ? inNav : !inNav, m.nav.join(" | ").slice(0, 200));
      }

      switch (key) {
        case "home-not-open":
          check(`${tag}: not open → the notice, no link to the settings`, m.text.includes("עדיין לא פתוחה") && !m.text.includes("טכנאי ברירת מחדל ואחריות"));
          break;
        case "home":
          check(`${tag}: the settings entry; cases are announced, not offered`, m.text.includes("הגדרות שירות") && m.text.includes("בשלב הבא") && !m.text.includes("תיק חדש\n"));
          break;
        case "settings-new":
          check(`${tag}: a new business — the owner, no warranty, save disabled until a change`, m.options[0] === "אני (בעל העסק)" && m.options.length === 3 && m.submitDisabled === true && !m.text.includes("מה האחריות מכסה"));
          check(`${tag}: the automatic assignment is stated plainly`, m.text.includes("ישויך אוטומטית לכל תיק חדש"));
          check(`${tag}: the statutory warranty note is shown`, m.text.includes("האחריות שהחוק מחייב"));
          check(`${tag}: terms and reminders are muted, not offered`, m.text.includes("תנאי שירות") && m.text.includes("תזכורות איסוף") && (m.text.match(/עוד לא זמין/g) ?? []).length === 2);
          break;
        case "settings-saved":
          check(`${tag}: the saved technician and warranty are shown`, (await page.inputValue("#sd-tech")) === "11" && (await page.inputValue("#sd-w-value")) === "6" && (await page.inputValue("#sd-w-excl")).includes("נזקי מים"));
          break;
        case "settings-invalid":
          check(`${tag}: invalid value and a missing scope are explained, nothing sent`, m.text.includes("1 ומעלה") && m.text.includes("תאר מה האחריות מכסה") && sent.length === 0);
          break;
        case "settings-read-only":
          check(`${tag}: read-only — the banner, every control disabled, no save button`, m.text.includes("לצפייה בלבד") && m.disabledInputs && m.submit === null);
          break;
        case "settings-conflict":
          check(`${tag}: VERSION_CONFLICT → "רענן ונסה שוב" with a reload button`, m.text.includes("רענן ונסה שוב") && m.text.includes("לרענן"));
          check(`${tag}: the request: the loaded version, a UUIDv7 Idempotency-Key, no business id`,
            sent.length === 1 && sent[0].body.expectedVersion === 4 && UUID_V7.test(sent[0].key ?? "") && !("businessId" in sent[0].body), JSON.stringify(sent[0] ?? {}));
          break;
        case "settings-saved-toast":
          check(`${tag}: saved → the toast; the save button goes back to disabled`, m.text.includes("ההגדרות נשמרו") && m.submitDisabled === true);
          check(`${tag}: first save body — expectedVersion null, staff 12, trimmed scope, exclusions null`,
            sent.length === 1 && sent[0].body.expectedVersion === null && sent[0].body.defaultStaffMemberId === 12
              && sent[0].body.warrantyTemplate?.value === 3 && sent[0].body.warrantyTemplate?.unit === "MONTHS"
              && sent[0].body.warrantyTemplate?.scope === "עבודת התיקון בלבד" && sent[0].body.warrantyTemplate?.exclusions === null && UUID_V7.test(sent[0].key ?? ""),
            JSON.stringify(sent[0] ?? {}));
          break;
        case "settings-leave-confirm":
          check(`${tag}: unsaved change + "חזרה" → the confirm, the page stays`, m.text.includes("יש שינויים שלא נשמרו") && m.text.includes("להישאר") && page.url().endsWith("/service-desk/settings"));
          break;
        case "settings-inactive-technician":
          check(`${tag}: an inactive default technician is named as such and explained`, m.options.includes("טכנאי שכבר לא פעיל") && m.text.includes("כבר לא פעיל בעסק"));
          break;
        default:
          break;
      }

      const file = path.join(OUT, `service-desk-${key}-${vp.width}.png`);
      await page.screenshot({ path: file, fullPage: true });
      await ctx.close();
    }
  }
  await browser.close();
  await writeFile(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
