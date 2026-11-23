/**
 * UX review tour — the Service Desk as it is today (main), in Chromium, on the synthetic lab only. NOT a test: it opens
 * every screen and state it can reach, at 360 / 390 (phone emulation) and 1440 (desktop), takes a full-page shot and, on
 * the phone, the first screen, and measures what can be measured (side scroll, small tap targets, the smallest font,
 * page length in screens). Nothing here changes the UI. A state that cannot be reached is recorded as such.
 * env: E2E_BASE, SEED_OUT, OUT, OWNER_URL.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";

const BASE = process.env.E2E_BASE ?? "http://localhost:3740";
const OUT = process.env.OUT ?? "/tmp/sdux";
const SHOTS = join(OUT, "shots");
mkdirSync(SHOTS, { recursive: true });
const seed = JSON.parse(readFileSync(process.env.SEED_OUT!, "utf8")) as Record<string, number | string>;
const n = (k: string) => Number(seed[k]);
const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });

type Size = { key: string; width: number; height: number; phone: boolean };
const W360: Size = { key: "360", width: 360, height: 740, phone: true };
const W390: Size = { key: "390", width: 390, height: 844, phone: true };
const DESK: Size = { key: "1440", width: 1440, height: 900, phone: false };
const ALL = [W360, W390, DESK];

type Audit = { overflowX: number; screens: number; smallTargets: number; smallTargetSamples: string[]; minFont: number; buttons: number; consoleErrors: string[] };
type Entry = { id: string; group: string; screen: string; state: string; width: string; full?: string; fold?: string; element?: string; ok: boolean; note?: string; audit?: Audit };
const manifest: Entry[] = [];

async function ctx(browser: Browser, token: string, size: Size): Promise<BrowserContext> {
  const c = await browser.newContext({
    baseURL: BASE, locale: "he-IL", timezoneId: "Asia/Jerusalem", viewport: { width: size.width, height: size.height },
    ...(size.phone ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { deviceScaleFactor: 1 }),
  });
  await c.addCookies([{ name: "dz_locale", value: "he", url: BASE }]);
  await c.addInitScript((t) => { try { localStorage.setItem("token", t); } catch { /* opaque */ } }, token);
  return c;
}

async function audit(page: Page, errors: string[]): Promise<Audit> {
  const a = await page.evaluate(() => {
    const vis = (el: Element) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };
    const targets = [...document.querySelectorAll("main a, main button, main input:not([type=hidden]), main select, main textarea, main summary, main [role=button], main label:has(input[type=checkbox])")].filter(vis);
    const small = targets.filter((el) => { const r = el.getBoundingClientRect(); return r.height < 44 && !(el instanceof HTMLTextAreaElement); });
    let minFont = 99;
    for (const el of document.querySelectorAll("main *")) {
      if (!vis(el)) continue;
      if (![...el.childNodes].some((c) => c.nodeType === 3 && (c.textContent ?? "").trim())) continue;
      minFont = Math.min(minFont, parseFloat(getComputedStyle(el).fontSize));
    }
    return {
      overflowX: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth,
      screens: Math.round((document.documentElement.scrollHeight / window.innerHeight) * 10) / 10,
      smallTargets: small.length,
      smallTargetSamples: small.slice(0, 6).map((el) => `${(el.textContent || (el as HTMLInputElement).placeholder || el.getAttribute("aria-label") || el.tagName).trim().slice(0, 30)} (${Math.round(el.getBoundingClientRect().height)}px)`),
      minFont: minFont === 99 ? 0 : minFont,
      buttons: [...document.querySelectorAll("main button, main a[class]")].filter(vis).length,
    };
  });
  return { ...a, consoleErrors: errors.slice(0, 5) };
}

let seq = 0;
/** One state at the given widths: a fresh page per width, `setup` brings it to the state, then the shots. */
async function capture(browser: Browser, o: { group: string; screen: string; state: string; token: string; sizes?: Size[];
  setup: (p: Page, size: Size) => Promise<void>; element?: (p: Page) => Locator }) {
  const id = String(++seq).padStart(3, "0");
  for (const size of o.sizes ?? ALL) {
    const c = await ctx(browser, o.token, size);
    const p = await c.newPage();
    const errors: string[] = [];
    p.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
    p.on("pageerror", (e) => errors.push(`pageerror: ${e.message.slice(0, 160)}`));
    const base = `${id}-${size.key}`;
    const e: Entry = { id, group: o.group, screen: o.screen, state: o.state, width: size.key, ok: false };
    try {
      await o.setup(p, size);
      await p.waitForTimeout(600);
      await p.screenshot({ path: join(SHOTS, `${base}-full.jpg`), fullPage: true, type: "jpeg", quality: 72 });
      e.full = `shots/${base}-full.jpg`;
      if (size.phone) {
        await p.evaluate(() => window.scrollTo(0, 0));
        await p.screenshot({ path: join(SHOTS, `${base}-fold.jpg`), type: "jpeg", quality: 72 });
        e.fold = `shots/${base}-fold.jpg`;
      }
      if (o.element) {
        const el = o.element(p);
        if (await el.count()) {
          await el.first().scrollIntoViewIfNeeded();
          await el.first().screenshot({ path: join(SHOTS, `${base}-el.jpg`), type: "jpeg", quality: 80 });
          e.element = `shots/${base}-el.jpg`;
        }
      }
      e.audit = await audit(p, errors);
      e.ok = true;
    } catch (err) {
      e.note = `not reached: ${(err as Error).message.split("\n")[0].slice(0, 200)}`;
      await p.screenshot({ path: join(SHOTS, `${base}-FAILED.jpg`), fullPage: true, type: "jpeg", quality: 60 }).catch(() => undefined);
      e.full = `shots/${base}-FAILED.jpg`;
    }
    manifest.push(e);
    console.log(`  ${e.ok ? "ok " : "-- "} ${id} ${size.key.padStart(4)} ${o.screen} — ${o.state}${e.note ? ` (${e.note})` : ""}`);
    await c.close();
  }
}

const caseReady = (p: Page) => p.locator("section[aria-label='מצב ופעולה הבאה']").waitFor({ timeout: 120_000 });
async function openCase(p: Page, id: number) { await p.goto(`/service-desk/cases/${id}`); await caseReady(p); }
const statusBtn = (p: Page, name: string) => p.locator("section[aria-label='מצב ופעולה הבאה']").getByRole("button", { name, exact: true });
async function own<T = Record<string, unknown>>(b: number, sql: string, ...a: unknown[]): Promise<T[]> {
  return owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(b));
    return (await tx.$queryRawUnsafe(sql, ...a)) as T[];
  });
}
const statusOf = async (id: number) => String((await own(n("bizA"), `SELECT status::text s FROM "ServiceCase" WHERE id = $1`, id))[0].s);
async function waitStatus(id: number, want: string) {
  for (let i = 0; i < 60; i++) { if ((await statusOf(id)) === want) return; await new Promise((r) => setTimeout(r, 250)); }
  throw new Error(`status ${await statusOf(id)} ≠ ${want}`);
}
const listReady = (p: Page) => p.getByRole("heading", { name: "תיקי שירות" }).waitFor({ timeout: 180_000 });
const A = () => String(seed.tokenA);

async function main() {
  const browser = await chromium.launch();
  try {
    // warm the dev server's routes (first compile is slow)
    { const c = await ctx(browser, A(), DESK); const p = await c.newPage();
      for (const u of ["/service-desk", "/service-desk/new", `/service-desk/cases/${n("c4")}`, `/service-desk/cases/${n("x2")}/intake`, "/service-desk/settings", "/service-desk/setup", "/app"]) await p.goto(u).catch(() => undefined);
      await p.waitForTimeout(3000); await c.close(); }

    // ── 0. Getting there ──
    await capture(browser, { group: "0 כניסה", screen: "בית האפליקציה", state: "איך מגיעים למערכת השירות (תפריט / בית)", token: A(),
      setup: async (p) => { await p.goto("/app"); await p.waitForLoadState("networkidle").catch(() => undefined); await p.waitForTimeout(2500); } });
    await capture(browser, { group: "0 כניסה", screen: "תפריט הניווט", state: "פתיחת תפריט «עוד» / תפריט צד בטלפון", token: A(), sizes: [W390],
      setup: async (p) => {
        await p.goto("/app"); await p.waitForTimeout(2500);
        const more = p.getByRole("button", { name: /עוד|תפריט|More/ }).first();
        if (await more.count()) { await more.click(); await p.waitForTimeout(800); } else throw new Error("no menu button found on the phone");
      } });

    // ── 1. The cases list ──
    await capture(browser, { group: "1 רשימת התיקים", screen: "רשימת תיקים", state: "כל התיקים (עסק עם תיקים)", token: A(),
      setup: async (p) => { await p.goto("/service-desk"); await listReady(p); } });
    await capture(browser, { group: "1 רשימת התיקים", screen: "רשימת תיקים", state: "סינון «דורשים טיפול»", token: A(), sizes: [W390, DESK],
      setup: async (p) => { await p.goto("/service-desk"); await listReady(p); await p.getByRole("group", { name: "סינון" }).getByRole("button", { name: /דורשים טיפול/ }).click(); } });
    await capture(browser, { group: "1 רשימת התיקים", screen: "רשימת תיקים", state: "סינון «סגורים»", token: A(), sizes: [W390],
      setup: async (p) => { await p.goto("/service-desk"); await listReady(p); await p.getByRole("group", { name: "סינון" }).getByRole("button", { name: /סגורים/ }).click(); } });
    await capture(browser, { group: "1 רשימת התיקים", screen: "רשימת תיקים", state: "חיפוש בלי תוצאות", token: A(), sizes: [W390],
      setup: async (p) => { await p.goto("/service-desk"); await listReady(p); await p.getByPlaceholder("חיפוש לפי לקוח, מספר תיק או תיאור").fill("זזזז"); } });
    await capture(browser, { group: "1 רשימת התיקים", screen: "רשימת תיקים", state: "עסק חדש בלי אף תיק (מצב ריק)", token: String(seed.tokenD),
      setup: async (p) => { await p.goto("/service-desk"); await listReady(p); } });
    await capture(browser, { group: "1 רשימת התיקים", screen: "רשימת תיקים", state: "עסק שעוד לא בחר סוגי פעילות (באנר הפעלה)", token: String(seed.tokenC), sizes: [W390, DESK],
      setup: async (p) => { await p.goto("/service-desk"); await listReady(p); await p.locator("[data-setup-banner]").waitFor({ timeout: 30_000 }); } });
    await capture(browser, { group: "1 רשימת התיקים", screen: "רשימת תיקים", state: "עסק שהמערכת לא פתוחה לו", token: String(seed.tokenB), sizes: [W390],
      setup: async (p) => { await p.goto("/service-desk"); await p.getByText("מערכת השירות עדיין לא פתוחה לעסק").waitFor({ timeout: 120_000 }); } });

    // ── 2. Activation + settings ──
    await capture(browser, { group: "2 הפעלה והגדרות", screen: "הפעלת תיקונים ושירות", state: "פעם ראשונה (מוסך, תחום מוצע)", token: String(seed.tokenC),
      setup: async (p) => { await p.goto("/service-desk/setup"); await p.getByRole("radiogroup", { name: "תחום העסק" }).waitFor({ timeout: 120_000 }); } });
    await capture(browser, { group: "2 הפעלה והגדרות", screen: "הגדרות שירות", state: "מסך ההגדרות", token: A(),
      setup: async (p) => { await p.goto("/service-desk/settings"); await p.getByText("איש מקצוע ברירת מחדל").waitFor({ timeout: 120_000 }); } });
    await capture(browser, { group: "2 הפעלה והגדרות", screen: "הגדרות שירות", state: "אחריות מופעלת (שדות נפתחים)", token: A(), sizes: [W390],
      setup: async (p) => { await p.goto("/service-desk/settings"); await p.getByText("איש מקצוע ברירת מחדל").waitFor({ timeout: 120_000 });
        await p.getByText("העסק נותן אחריות על השירות").click(); } });
    await capture(browser, { group: "2 הפעלה והגדרות", screen: "הגדרות שירות", state: "יציאה עם שינויים שלא נשמרו", token: A(), sizes: [W390],
      setup: async (p) => { await p.goto("/service-desk/settings"); await p.getByText("איש מקצוע ברירת מחדל").waitFor({ timeout: 120_000 });
        await p.getByText("העסק נותן אחריות על השירות").click(); await p.getByRole("button", { name: /חזרה|לתיקים|לשירות/ }).first().click();
        await p.getByText("יש שינויים שלא נשמרו.").waitFor({ timeout: 10_000 }); } });

    // ── 3. Opening a case ──
    const newForm = async (p: Page) => { await p.goto("/service-desk/new"); await p.getByText("מה פותחים?").waitFor({ timeout: 120_000 }); };
    await capture(browser, { group: "3 פתיחת תיק", screen: "פתיחה חדשה", state: "מסך ריק — בחירת סוג", token: A(), setup: newForm });
    await capture(browser, { group: "3 פתיחת תיק", screen: "פתיחה חדשה", state: "«עוד סוגים» פתוח", token: A(), sizes: [W390],
      setup: async (p) => { await newForm(p); const m = p.getByRole("button", { name: "עוד סוגים" }); if (await m.count()) await m.click(); else throw new Error("no 'more types' (all tracks already offered)"); } });
    await capture(browser, { group: "3 פתיחת תיק", screen: "פתיחה חדשה", state: "תיקון במעבדה — חיפוש לקוח «דנה»", token: A(),
      setup: async (p) => { await newForm(p); await p.getByRole("button", { name: "תיקון במעבדה" }).click(); await p.locator("#sd-open-customer").fill("דנה");
        await p.getByRole("list", { name: "לקוחות שנמצאו" }).waitFor({ timeout: 20_000 }); } });
    await capture(browser, { group: "3 פתיחת תיק", screen: "פתיחה חדשה", state: "לקוח חדש — טופס קצר", token: A(), sizes: [W360, W390],
      setup: async (p) => { await newForm(p); await p.getByRole("button", { name: "תיקון במעבדה" }).click(); await p.getByRole("button", { name: "+ לקוח חדש" }).click();
        await p.locator("#sd-new-customer-name").fill("לקוח לדוגמה"); await p.locator("#sd-new-customer-phone").fill("05012"); } });
    await capture(browser, { group: "3 פתיחת תיק", screen: "פתיחה חדשה", state: "לקוח נבחר + תיקים קודמים + פרטי הפריט", token: A(),
      setup: async (p) => { await newForm(p); await p.getByRole("button", { name: "תיקון במעבדה" }).click(); await p.locator("#sd-open-customer").fill("דנה");
        await p.getByRole("list", { name: "לקוחות שנמצאו" }).getByRole("button").first().click();
        await p.locator("#sd-open-subject").fill("iPhone 13"); await p.locator("#sd-open-problem").fill("הסוללה מתרוקנת");
        await p.waitForTimeout(1200); } });
    await capture(browser, { group: "3 פתיחת תיק", screen: "פתיחה חדשה", state: "שליחה בלי פרטים — הודעות חסרים", token: A(), sizes: [W390, DESK],
      setup: async (p) => { await newForm(p); await p.getByRole("button", { name: "תיקון במעבדה" }).click(); await p.getByRole("button", { name: "לפתוח ולעבור לקליטה" }).click(); } });
    await capture(browser, { group: "3 פתיחת תיק", screen: "פתיחה חדשה", state: "תיקון אצל הלקוח — שדה כתובת", token: A(), sizes: [W390, DESK],
      setup: async (p) => { await newForm(p); const b = p.getByRole("button", { name: "תיקון אצל הלקוח" });
        if (!(await b.count())) { const m = p.getByRole("button", { name: "עוד סוגים" }); if (await m.count()) await m.click(); }
        await p.getByRole("button", { name: "תיקון אצל הלקוח" }).click(); } });

    // ── 4. Intake ──
    await capture(browser, { group: "4 קליטה", screen: "קליטה", state: "תיק חדש — לפני שנרשם דבר", token: A(),
      setup: async (p) => { await p.goto(`/service-desk/cases/${n("x2")}/intake`); await p.getByText("מצב המכשיר בקליטה").waitFor({ timeout: 120_000 }); } });
    await capture(browser, { group: "4 קליטה", screen: "קליטה", state: "פרטים נרשמו, ממתין לאישור", token: A(), sizes: [W390, DESK],
      setup: async (p) => { await p.goto(`/service-desk/cases/${n("c1")}/intake`); await p.getByText("מצב המכשיר בקליטה").waitFor({ timeout: 120_000 }); } });

    // ── 5. The case screen, by status ──
    const caseStates: [string, string, string][] = [
      ["x2", "נפתח — עוד לא נקלט", "5 תיק — לפי מצב"],
      ["c1", "נפתח — הקליטה נרשמה, צריך לאשר", "5 תיק — לפי מצב"],
      ["x6", "התקבל — לפני אבחון", "5 תיק — לפי מצב"],
      ["c6", "באבחון — ללקוח יש הצעת מחיר לצרף", "5 תיק — לפי מצב"],
      ["c2", "קריאה אצל הלקוח — ממתין לאישור הצעה", "5 תיק — לפי מצב"],
      ["c4", "בעבודה — בהמתנה לחלקים", "5 תיק — לפי מצב"],
      ["c3", "מוכן למסירה — חיוב לא נקבע (המסירה חסומה)", "5 תיק — לפי מצב"],
      ["x3", "קריאה אצל הלקוח — העבודה הסתיימה (סגירת קריאה)", "5 תיק — לפי מצב"],
      ["x5", "תמיכה מרחוק — נפתחה", "5 תיק — לפי מצב"],
      ["x4", "בוטל", "5 תיק — לפי מצב"],
    ];
    for (const [k, state, group] of caseStates) {
      await capture(browser, { group, screen: "מסך תיק", state, token: A(), setup: async (p) => openCase(p, n(k)),
        element: (p) => p.locator("section[aria-label='מצב ופעולה הבאה']") });
    }
    await capture(browser, { group: "5 תיק — לפי מצב", screen: "מסך תיק", state: "בבדיקות (QA) — רשימת בדיקות", token: String(seed.tokenC),
      setup: async (p) => { await p.goto(`/service-desk/cases/${n("c5")}`); await caseReady(p); }, element: (p) => p.locator("[data-panel=qa]") });

    // ── 6. Dialogs and messages (opened, then left without confirming) ──
    const dlg = (p: Page) => p.getByRole("dialog");
    await capture(browser, { group: "6 חלוניות והודעות", screen: "חלונית", state: "אישור קליטה", token: A(), sizes: [W360, W390],
      setup: async (p) => { await openCase(p, n("c1")); await statusBtn(p, "לאשר את הקליטה").click(); await dlg(p).waitFor(); }, element: dlg });
    await capture(browser, { group: "6 חלוניות והודעות", screen: "חלונית", state: "תשובת הלקוח להצעה (טלפון / פנים אל פנים)", token: A(), sizes: [W390, DESK],
      setup: async (p) => { await openCase(p, n("c2")); await statusBtn(p, "הלקוח אישר את ההצעה").click(); await dlg(p).waitFor(); }, element: dlg });
    await capture(browser, { group: "6 חלוניות והודעות", screen: "חלונית", state: "ביטול תיק (סיבה)", token: A(), sizes: [W390],
      setup: async (p) => { await openCase(p, n("x6")); await p.getByRole("button", { name: "ביטול התיק" }).click(); await dlg(p).waitFor(); }, element: dlg });
    await capture(browser, { group: "6 חלוניות והודעות", screen: "חלונית", state: "לא ניתן לתקן", token: A(), sizes: [W390],
      setup: async (p) => { await openCase(p, n("c6")); await statusBtn(p, "לא ניתן לתקן").click(); await dlg(p).waitFor(); }, element: dlg });
    await capture(browser, { group: "6 חלוניות והודעות", screen: "חלונית", state: "קביעת סכום לחיוב", token: A(), sizes: [W390, DESK],
      setup: async (p) => { await openCase(p, n("c3")); await p.locator("[data-panel=charge]").getByRole("button", { name: "לקבוע סכום לחיוב" }).click(); await dlg(p).waitFor(); }, element: dlg });
    await capture(browser, { group: "6 חלוניות והודעות", screen: "חלונית", state: "ללא חיוב (סיבה)", token: A(), sizes: [W390],
      setup: async (p) => { await openCase(p, n("c3")); await p.locator("[data-panel=charge]").getByRole("button", { name: "ללא חיוב", exact: true }).click(); await dlg(p).waitFor(); }, element: dlg });
    await capture(browser, { group: "6 חלוניות והודעות", screen: "חלונית", state: "צירוף הצעת מחיר לתיק", token: A(), sizes: [W390],
      setup: async (p) => { await openCase(p, n("c6")); await p.locator("[data-panel=quote]").getByRole("button", { name: "לצרף לתיק" }).first().click(); await dlg(p).waitFor(); }, element: dlg });
    await capture(browser, { group: "6 חלוניות והודעות", screen: "חלונית", state: "סגירת קריאה", token: A(), sizes: [W390],
      setup: async (p) => { await openCase(p, n("x3")); await statusBtn(p, "לסגור את הקריאה").click(); await dlg(p).waitFor(); }, element: dlg });
    await capture(browser, { group: "6 חלוניות והודעות", screen: "הודעת שגיאה", state: "פעולה שנדחתה (גרסה ישנה — מישהו שינה את התיק)", token: A(), sizes: [W390],
      setup: async (p) => {
        await openCase(p, n("x6"));
        // a second tab changes the case first: the screen still holds the old version
        const other = await p.context().newPage(); await openCase(other, n("x6"));
        await other.locator("[data-panel=fields] #sd-item-location").fill("מגירה 2"); await other.locator("[data-panel=fields]").getByRole("button", { name: "לשמור" }).click();
        await other.waitForTimeout(2500); await other.close();
        await statusBtn(p, "להתחיל אבחון").click();
        await p.locator("[role=alert]").first().waitFor({ timeout: 20_000 });
      } });

    // ── 7. Panels on a case in work: loans, tasks, location + date — and the history they write ──
    await capture(browser, { group: "7 כרטיסים בתיק", screen: "מסך תיק", state: "כרטיסי צד ריקים (ציוד חלופי, משימות, פרטים נוספים)", token: A(), sizes: [W390, DESK],
      setup: async (p) => openCase(p, n("c4")), element: (p) => p.locator("aside") });
    {
      // fill c4's panels once through the UI (the lab only), then shoot the result at every width
      const c = await ctx(browser, A(), W390); const p = await c.newPage();
      try {
        await openCase(p, n("c4"));
        const loans = p.locator("[data-panel=loans]");
        await loans.getByRole("button", { name: "+ ציוד חלופי" }).click(); await loans.locator("#sd-loan-name").fill("מחשב חלופי"); await loans.getByRole("button", { name: "לרשום" }).click();
        await p.waitForTimeout(2500);
        const tasks = p.locator("[data-panel=tasks]");
        await tasks.locator("#sd-task-pick").selectOption(String(n("taskA"))); await tasks.getByRole("button", { name: "לקשר" }).click(); await p.waitForTimeout(2500);
        const f = p.locator("[data-panel=fields]");
        await f.locator("#sd-item-location").fill("מדף 3"); await f.locator("#sd-estimated").fill("2026-12-01"); await f.getByRole("button", { name: "לשמור" }).click(); await p.waitForTimeout(2500);
        console.log("  (c4 panels filled)");
      } catch (e) { console.log(`  (c4 panels not filled: ${(e as Error).message.slice(0, 160)})`); }
      await c.close();
    }
    await capture(browser, { group: "7 כרטיסים בתיק", screen: "מסך תיק", state: "כרטיסים מלאים (ציוד אצל הלקוח, משימה, מיקום ותאריך)", token: A(),
      setup: async (p) => openCase(p, n("c4")), element: (p) => p.locator("aside") });
    await capture(browser, { group: "7 כרטיסים בתיק", screen: "היסטוריה", state: "היסטוריית התיק עם הרישומים החדשים", token: A(),
      setup: async (p) => openCase(p, n("c4")), element: (p) => p.locator("details", { hasText: "היסטוריה" }).last() });
    await capture(browser, { group: "7 כרטיסים בתיק", screen: "מסך תיק", state: "תזכורות איסוף + חיוב (מוכן למסירה)", token: A(), sizes: [W390, DESK],
      setup: async (p) => openCase(p, n("c3")), element: (p) => p.locator("[data-panel=pickup]") });

    // ── 8. A full repair, start to handover, on the phone (390) — every step shot ──
    {
      const c = await ctx(browser, A(), W390); const p = await c.newPage();
      const step = async (state: string, fn: () => Promise<void>) => {
        const id = String(++seq).padStart(3, "0");
        const e: Entry = { id, group: "8 תהליך מלא (390)", screen: "מסך תיק — תהליך", state, width: "390", ok: false };
        try { await fn(); await p.waitForTimeout(700);
          await p.screenshot({ path: join(SHOTS, `${id}-390-full.jpg`), fullPage: true, type: "jpeg", quality: 72 }); e.full = `shots/${id}-390-full.jpg`;
          await p.evaluate(() => window.scrollTo(0, 0)); await p.screenshot({ path: join(SHOTS, `${id}-390-fold.jpg`), type: "jpeg", quality: 72 }); e.fold = `shots/${id}-390-fold.jpg`;
          e.audit = await audit(p, []); e.ok = true;
        } catch (err) { e.note = `not reached: ${(err as Error).message.split("\n")[0].slice(0, 200)}`; }
        manifest.push(e); console.log(`  ${e.ok ? "ok " : "-- "} ${id}  390 flow — ${state}${e.note ? ` (${e.note})` : ""}`);
      };
      const c1 = n("c1");
      await step("1. תיק פתוח, לאשר קליטה", async () => openCase(p, c1));
      await step("2. אחרי אישור הקליטה — התקבל", async () => { await statusBtn(p, "לאשר את הקליטה").click(); await p.getByRole("dialog").getByRole("button", { name: "לאשר", exact: true }).click(); await waitStatus(c1, "CHECKED_IN"); });
      await step("3. באבחון", async () => { await statusBtn(p, "להתחיל אבחון").click(); await waitStatus(c1, "DIAGNOSING"); });
      await step("4. בעבודה", async () => { await statusBtn(p, "להתחיל תיקון").click(); await waitStatus(c1, "IN_REPAIR"); });
      await step("5. מוכן למסירה — המסירה חסומה עד שנקבע חיוב", async () => { await statusBtn(p, "לסיים את התיקון").click(); await waitStatus(c1, "READY"); });
      await step("6. «ללא חיוב» נשמר — אפשר למסור", async () => {
        await p.locator("[data-panel=charge]").getByRole("button", { name: "ללא חיוב", exact: true }).click();
        await p.getByRole("dialog").getByRole("textbox").fill("תיקון באחריות"); await p.getByRole("dialog").getByRole("button", { name: "לשמור", exact: true }).click();
        await p.getByRole("dialog").waitFor({ state: "detached", timeout: 30_000 }); });
      await step("7. חלונית מסירה (שם המקבל)", async () => { await statusBtn(p, "למסור ללקוח").click(); await p.getByRole("dialog").waitFor(); await p.getByRole("dialog").getByRole("textbox").fill("דנה כהן"); });
      await step("8. נמסר — סוף התהליך", async () => { await p.getByRole("dialog").getByRole("button", { name: "לאשר מסירה" }).click(); await waitStatus(c1, "DELIVERED"); });
      await c.close();
    }
    await capture(browser, { group: "8 תהליך מלא (390)", screen: "מסך תיק", state: "נמסר — היסטוריה מלאה", token: A(), sizes: [W360, DESK],
      setup: async (p) => openCase(p, n("c1")), element: (p) => p.locator("details", { hasText: "היסטוריה" }).last() });
    await capture(browser, { group: "1 רשימת התיקים", screen: "רשימת תיקים", state: "אחרי התהליך — סינון «סגורים»", token: A(), sizes: [W390],
      setup: async (p) => { await p.goto("/service-desk"); await listReady(p); await p.getByRole("group", { name: "סינון" }).getByRole("button", { name: /סגורים/ }).click(); } });
    // a new case through the form, to the intake (the real flow)
    await capture(browser, { group: "3 פתיחת תיק", screen: "פתיחה → קליטה", state: "אחרי «לפתוח ולעבור לקליטה» — מסך הקליטה של התיק החדש", token: A(), sizes: [W390],
      setup: async (p) => { await newForm(p); await p.getByRole("button", { name: "תיקון במעבדה" }).click(); await p.locator("#sd-open-customer").fill("מיכל");
        await p.getByRole("list", { name: "לקוחות שנמצאו" }).getByRole("button").first().click();
        await p.locator("#sd-open-subject").fill("AirPods Pro"); await p.locator("#sd-open-problem").fill("אוזניה שמאל לא נטענת");
        await p.getByRole("button", { name: "לפתוח ולעבור לקליטה" }).click(); await p.getByText("מצב המכשיר בקליטה").waitFor({ timeout: 60_000 }); } });
  } finally {
    await browser.close();
    writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
    await owner.$disconnect();
  }
  const okN = manifest.filter((m) => m.ok).length;
  console.log(`tour: ${okN}/${manifest.length} shots`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
