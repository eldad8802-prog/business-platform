/**
 * Appointments — the whole feature END TO END in a real browser, on the real app (`next start`) over the
 * Production-shaped lab (.bkg/lab.sh --with-bkg, seeded by .appt/ui-seed.ts). Design direction A (2026-11-02).
 * Desktop 1440×900, phone 390×844, small phone 320×640, tablet 820×1180.
 *
 *   ON  (business A, appointments ON by a per-business override):
 *       the day with a lane per staff member (an inactive one too, while they have an appointment), two staff at the
 *       same time, a 15-minute appointment and every state told apart by more than colour, details with the action of
 *       the state and the final-state confirmation, booking (the open-lead link — decision 11), a taken time → the
 *       nearest free times, the form's unsaved-changes question, drag + "החזרה למקום", a drag outside the hours asks
 *       first, cancel with a reason, cancelled appointments on request, the month, closures named, every free time,
 *       the management centre (hours, special days, staff, services — who performs, from both pages), the requests,
 *       the booking settings (the dead-end warning), the text limits, the Secretary (a date link opens that date),
 *       the customer card, "+", and the phone / small phone / tablet (a real time grid, sheets, back closes a sheet,
 *       nothing covered, no sideways scroll).
 *   OFF (business B, no override): every screen says the calendar is not active, the API answers 404, the
 *       navigation, the Secretary and the customer card show nothing of it, and B cannot read A.
 *
 * Every step leaves a screenshot in $OUT; the result table goes to $OUT/report.md. Exit 1 on any failed check.
 * env: E2E_BASE, SEED_OUT, OUT. Synthetic only — ZERO secrets, ZERO network beyond localhost.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";

const BASE = process.env.E2E_BASE ?? "http://localhost:3700";
const OUT = process.env.OUT ?? "/tmp/appt-ui";
const seed = JSON.parse(readFileSync(process.env.SEED_OUT!, "utf8"));
mkdirSync(OUT, { recursive: true });

const rows: Array<{ name: string; ok: boolean; detail: string }> = [];
let current: Page | null = null;
async function check(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    const r = await fn();
    if (r === false) throw new Error("condition false");
    rows.push({ name, ok: true, detail: "" });
    console.log(`  [PASS] ${name}`);
  } catch (e) {
    const detail = e instanceof Error ? e.message.split("\n")[0].slice(0, 220) : String(e);
    rows.push({ name, ok: false, detail });
    if (current) await current.screenshot({ path: join(OUT, `FAILED-${name.split(" ")[0]}.png`) }).catch(() => undefined);
    console.log(`  [FAIL] ${name} — ${detail}`);
  }
}

type Size = { width: number; height: number; phone: boolean };
const DESKTOP: Size = { width: 1440, height: 900, phone: false };
const PHONE: Size = { width: 390, height: 844, phone: true };

async function ctx(browser: Browser, token: string, size: Size): Promise<BrowserContext> {
  const c = await browser.newContext({
    baseURL: BASE,
    locale: "he-IL",
    timezoneId: "Asia/Jerusalem",
    viewport: { width: size.width, height: size.height },
    ...(size.phone ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}),
  });
  await c.addInitScript((t) => { try { localStorage.setItem("token", t); } catch { /* opaque */ } }, token);
  return c;
}

const shot = (page: Page, name: string, fullPage = false) => page.screenshot({ path: join(OUT, `${name}.png`), fullPage });
const seen = (page: Page | Locator, text: string | RegExp, timeout = 25_000) => page.getByText(text).first().waitFor({ state: "visible", timeout });
async function api(token: string, path: string) {
  const r = await fetch(BASE + path, { headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const hourOf = (iso: string) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jerusalem" }).format(new Date(iso));
const longDay = (day: string) => new Intl.DateTimeFormat("he-IL", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(day + "T12:00:00Z"));
const startedNow = (hour: number) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jerusalem", hour: "2-digit", hour12: false }).format(new Date())) >= hour;
const noSideScroll = async (page: Page, w: number) => {
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  if (width > w) throw new Error(`page is ${width}px wide at ${w}px`);
};
/** Closes the open form; with changes it asks first — leaving is confirmed. */
async function closeForm(page: Page) {
  const dlg = page.getByRole("dialog");
  await dlg.getByRole("button", { name: "סגירה" }).first().click();
  const leave = page.getByRole("button", { name: "לצאת בלי לשמור" });
  if (await leave.count()) await leave.click();
  await dlg.waitFor({ state: "hidden", timeout: 10_000 });
}
async function openNew(page: Page) {
  await page.getByRole("button", { name: "קביעת תור" }).first().click();
  const dlg = page.getByRole("dialog");
  await dlg.getByRole("heading", { name: "קביעת תור" }).waitFor({ timeout: 15_000 });
  return dlg;
}
async function otherTime(dlg: Locator, hhmm: string) {
  const other = dlg.getByRole("button", { name: "שעה אחרת" });
  if (await other.count()) await other.click();
  await dlg.getByLabel("שעה אחרת", { exact: true }).fill(hhmm);
}

async function main() {
  const browser = await chromium.launch();
  const t = seed.tokenA as string;

  // ── Desktop, appointments ON ──────────────────────────────────────────────────────────────────
  console.log("desktop · appointments ON");
  const dc = await ctx(browser, t, DESKTOP);
  const p = await dc.newPage();
  current = p;

  await check("D1 the day opens by default: a lane per staff member, the business's own lane, the time grid", async () => {
    await p.goto(`/calendar?day=${seed.today}`);
    for (const name of ["שירה", "אבי", "ללא עובד"]) await p.locator(`span:text-is("${name}")`).first().waitFor({ timeout: 25_000 });
    await p.getByRole("tab", { name: "יום", exact: true, selected: true }).waitFor();
    await p.getByRole("tablist", { name: "ימי השבוע" }).waitFor();
    await shot(p, "01-desktop-day-by-staff");
  });
  await check("D2 an inactive staff member's appointment stays: their lane is there, marked, with the appointment", async () => {
    await p.locator('span:text-is("Dana Cohen (לא פעיל)")').first().waitFor({ timeout: 15_000 });
    await p.locator(`[data-appointment="${seed.ids.inactiveDana}"]`).waitFor();
  });
  await check("D3 two staff at the same time are both on the grid; a 15-minute appointment names its state", async () => {
    await p.locator(`[data-appointment="${seed.ids.todayNoa}"]`).waitFor();
    await p.locator(`[data-appointment="${seed.ids.parallelDaniel}"]`).waitFor();
    const short = await p.locator(`[data-appointment="${seed.ids.shortDaniel}"]`).getAttribute("aria-label");
    if (!short || !short.includes("Daniel Levi") || !short.includes("מאושר")) throw new Error(`short block reads: ${short}`);
    const proposed = await p.locator(`[data-appointment="${seed.ids.todayYossi}"]`).getAttribute("aria-label");
    if (!proposed?.includes("ממתין לאישור")) throw new Error(`proposed block reads: ${proposed}`);
    if (!(await p.locator(`[data-appointment="${seed.ids.todayYossi}"] [class*="mark_PROPOSED"]`).count())) throw new Error("no waiting mark on the block");
    const lunch = await p.locator(`[data-appointment="${seed.ids.lunch}"]`).getAttribute("aria-label");
    if (!lunch?.includes("חסימת זמן")) throw new Error(`block reads: ${lunch}`);
  });
  await check("D4 the week: 7 columns with the seeded appointments; the legend tells every state", async () => {
    await p.goto(`/calendar?view=week&day=${seed.today}`);
    await seen(p, "נועה לוי · תספורת");
    await seen(p, "הפסקת צהריים");
    const legend = p.getByRole("list", { name: "מקרא" });
    for (const word of ["פנוי", "מחוץ לשעות", "סגור", "חסום", "ממתין לאישור", "התקיים", "לא הגיע", "בוטל"]) await legend.getByText(word, { exact: true }).first().waitFor();
    await shot(p, "02-desktop-week");
  });
  await check("D5 ניהול העסק in the sidebar lists יומן ותורים", async () => p.getByRole("link", { name: "יומן ותורים" }).first().waitFor({ timeout: 15_000 }));

  await check("D6 details: state, call / WhatsApp links, the actions of the state, history", async () => {
    await p.goto(`/calendar?day=${seed.today}&appointment=${seed.ids.todayNoa}`);
    const panel = p.getByRole("complementary", { name: "פרטי התור" });
    await panel.getByText("מאושר").first().waitFor({ timeout: 15_000 });
    for (const b of ["שינוי מועד", "עריכת פרטים", "ביטול התור"]) await panel.getByRole("button", { name: b }).waitFor();
    await panel.getByRole("link", { name: "חיוג" }).waitFor();
    const wa = await panel.getByRole("link", { name: "WhatsApp" }).getAttribute("href");
    if (wa !== "https://wa.me/972521111111") throw new Error(`WhatsApp link: ${wa}`);
    const outcomes = await panel.getByRole("button", { name: /^(התקיים|לא הגיע)$/ }).count();
    if (outcomes !== (startedNow(10) ? 2 : 0)) throw new Error(`outcome buttons: ${outcomes}`);
    await panel.getByRole("button", { name: /^היסטוריה/ }).click();
    await panel.getByText("נקבע").first().waitFor();
    await shot(p, "03-desktop-details");
  });
  await check("D7 a final state: no actions, says it is final, offers a new appointment for the customer", async () => {
    await p.goto(`/calendar?day=${seed.today}&appointment=${seed.ids.noShow}`);
    const panel = p.getByRole("complementary", { name: "פרטי התור" });
    await panel.getByText("לא הגיע").first().waitFor({ timeout: 15_000 });
    await panel.getByText(/סטטוס סופי/).waitFor();
    await panel.getByRole("button", { name: /קביעת תור חדש ל/ }).waitFor();
    if (await panel.getByRole("button", { name: "שינוי מועד" }).count()) throw new Error("a final appointment offers a move");
    await shot(p, "04-desktop-final-state");
  });
  await check("D8 \"התקיים\" asks once more and says it cannot be undone (when the appointment has started)", async () => {
    if (!startedNow(10)) return true;
    await p.goto(`/calendar?day=${seed.today}&appointment=${seed.ids.todayNoa}`);
    const panel = p.getByRole("complementary", { name: "פרטי התור" });
    await panel.getByRole("button", { name: "התקיים", exact: true }).click();
    await panel.getByText("אחרי הסימון אי אפשר להחזיר אותו.").waitFor({ timeout: 10_000 });
    await shot(p, "05-desktop-final-confirm");
    await panel.getByRole("button", { name: "חזרה", exact: true }).click();
    if ((await api(t, `/api/appointments/${seed.ids.todayNoa}`)).body.appointment.status !== "CONFIRMED") throw new Error("marked without confirmation");
  });

  await check("D9 book: customer → service and staff → a free time; the open lead is linked (decision 11)", async () => {
    await p.goto(`/calendar?day=${seed.today}`);
    const dlg = await openNew(p);
    await dlg.getByLabel("לקוח", { exact: true }).fill("רון");
    await dlg.getByRole("option", { name: /רון אברהם/ }).click();
    await dlg.getByText("יקושר לליד הפתוח").waitFor({ timeout: 15_000 });
    await dlg.getByLabel("שירות", { exact: true }).selectOption({ label: "ייעוץ · 30 דק׳" });
    await dlg.getByLabel("צוות", { exact: true }).selectOption({ label: "אבי" });
    await otherTime(dlg, "17:00");
    await dlg.getByRole("region", { name: "סיכום" }).waitFor();
    await shot(p, "06-desktop-create-form");
    await dlg.getByRole("button", { name: "קביעת תור", exact: true }).click();
    await dlg.waitFor({ state: "hidden", timeout: 20_000 });
    const list = await api(t, `/api/appointments?from=${encodeURIComponent(new Date(Date.now() - 864e5).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 3 * 864e5).toISOString())}`);
    const ron = (list.body?.appointments ?? []).find((a: { customerId: number }) => a.customerId === seed.customers.ron);
    if (!ron || ron.leadId === null) throw new Error(`no linked appointment for the lead's customer: ${JSON.stringify(ron)}`);
    await shot(p, "07-desktop-after-create");
  });
  await check("D10 problems are shown next to their fields, all at once", async () => {
    const dlg = await openNew(p);
    await dlg.getByRole("button", { name: "קביעת תור", exact: true }).click();
    await dlg.getByText("צריך לבחור לקוח.").waitFor({ timeout: 10_000 });
    await dlg.getByText("כדאי להשלים את השדות המסומנים.").waitFor();
    await shot(p, "08-desktop-field-errors");
    await closeForm(p);
  });
  await check("D11 a taken time answers in Hebrew and offers the nearest free times; closing with changes asks first", async () => {
    const dlg = await openNew(p);
    await dlg.getByLabel("לקוח", { exact: true }).fill("מאיה");
    await dlg.getByRole("option", { name: /מאיה פרץ/ }).click();
    await dlg.getByLabel("שירות", { exact: true }).selectOption({ label: "תספורת · 45 דק׳" });
    await dlg.getByLabel("צוות", { exact: true }).selectOption({ label: "שירה" });
    await dlg.getByLabel("תאריך", { exact: true }).fill(seed.today);
    await otherTime(dlg, "10:00");
    await dlg.getByRole("button", { name: /קביעת תור|לקבוע בכל זאת/ }).last().click();
    await dlg.getByText("השעה הזו כבר תפוסה").waitFor({ timeout: 15_000 });
    await dlg.getByText("שעות קרובות שפנויות").waitFor();
    await shot(p, "09-desktop-conflict");
    await dlg.getByRole("button", { name: "סגירה" }).first().click();
    await p.getByText("יש שינויים שלא נשמרו").first().waitFor({ timeout: 5_000 });
    await shot(p, "10-desktop-unsaved-form");
    await p.getByRole("button", { name: "להישאר" }).click();
    if (!(await dlg.isVisible())) throw new Error("staying closed the form");
    await closeForm(p);
  });
  await check("D12 a staff member who does not perform the new service is cleared, with a word", async () => {
    const dlg = await openNew(p);
    await dlg.getByLabel("צוות", { exact: true }).selectOption({ label: "אבי" });
    await dlg.getByLabel("שירות", { exact: true }).selectOption({ label: "צבע · שעה וחצי" });
    await dlg.getByText(/אבי לא מבצע\/ת את השירות הזה/).waitFor({ timeout: 10_000 });
    if ((await dlg.getByLabel("צוות", { exact: true }).inputValue()) !== "") throw new Error("the hidden choice stayed");
    await closeForm(p);
  });

  await check("D13 drag an appointment two hours later: moved by the server; \"החזרה למקום\" puts it back", async () => {
    await p.goto(`/calendar?view=day&day=${seed.today}`);
    const block = p.locator(`[data-appointment="${seed.ids.todayNoa}"]`);
    await block.waitFor();
    await block.scrollIntoViewIfNeeded();
    const box = (await block.boundingBox())!;
    await p.mouse.move(box.x + box.width / 2, box.y + 8);
    await p.mouse.down();
    await p.mouse.move(box.x + box.width / 2, box.y + 8 + 60, { steps: 6 });
    await p.mouse.move(box.x + box.width / 2, box.y + 8 + 128, { steps: 6 });
    await p.mouse.up();
    await seen(p, "התור הוזז");
    const one = await api(t, `/api/appointments/${seed.ids.todayNoa}`);
    if (hourOf(one.body.appointment.startsAt) !== "12:00") throw new Error(`moved to ${hourOf(one.body.appointment.startsAt)}`);
    if (!one.body.history.some((h: { type: string }) => h.type === "APPOINTMENT_RESCHEDULED")) throw new Error("no journal event");
    await shot(p, "11-desktop-after-drag");
    await p.getByRole("button", { name: "החזרה למקום" }).click();
    await seen(p, "התור חזר למקומו");
    const back = await api(t, `/api/appointments/${seed.ids.todayNoa}`);
    if (hourOf(back.body.appointment.startsAt) !== "10:00") throw new Error(`put back to ${hourOf(back.body.appointment.startsAt)}`);
  });
  await check("D14 a drag to before opening asks first; \"להשאיר במקום\" keeps it", async () => {
    await p.reload();
    const block = p.locator(`[data-appointment="${seed.ids.todayNoa}"]`);
    await block.waitFor();
    await block.scrollIntoViewIfNeeded();
    const box = (await block.boundingBox())!;
    await p.mouse.move(box.x + box.width / 2, box.y + 8);
    await p.mouse.down();
    await p.mouse.move(box.x + box.width / 2, box.y + 8 - 60, { steps: 6 });
    await p.mouse.move(box.x + box.width / 2, box.y + 8 - 128, { steps: 6 });
    await p.mouse.up();
    await seen(p, "להזיז לשעה שאינה פנויה?");
    await shot(p, "12-desktop-drag-outside-asks");
    await p.getByRole("button", { name: "להשאיר במקום" }).click();
    if (hourOf((await api(t, `/api/appointments/${seed.ids.todayNoa}`)).body.appointment.startsAt) !== "10:00") throw new Error("moved without asking");
  });

  await check("D15 cancel with a closed reason and a note: the time is freed, the journal says so", async () => {
    await p.goto(`/calendar?view=day&day=${seed.today}&appointment=${seed.ids.todayYossi}`);
    const panel = p.getByRole("complementary", { name: "פרטי התור" });
    await panel.getByText("ממתין לאישור").first().waitFor({ timeout: 15_000 });
    await panel.getByRole("button", { name: "ביטול התור" }).click();
    await panel.getByRole("radio", { name: "הלקוח ביטל" }).click();
    await panel.getByLabel("הסבר קצר (לא חובה)").fill("התקשר לבטל");
    await shot(p, "13-desktop-cancel");
    await p.waitForTimeout(800);
    await panel.getByRole("button", { name: "כן, לבטל את התור" }).click();
    await panel.getByText("בוטל", { exact: true }).first().waitFor({ timeout: 15_000 });
    const one = await api(t, `/api/appointments/${seed.ids.todayYossi}`);
    if (one.body.appointment.status !== "CANCELED" || one.body.appointment.cancelReason !== "CUSTOMER_CANCELED") throw new Error(JSON.stringify(one.body.appointment));
  });
  await check("D16 cancelled appointments: hidden by default, shown (struck through) on request", async () => {
    await p.goto(`/calendar?view=day&day=${seed.today}`);
    await p.locator(`[data-appointment="${seed.ids.todayNoa}"]`).waitFor({ timeout: 20_000 });
    if (await p.locator(`[data-appointment="${seed.ids.todayYossi}"]`).count()) throw new Error("a cancelled appointment shows by default");
    await p.getByLabel("הצגת מבוטלים").check();
    await p.locator(`[data-appointment="${seed.ids.todayYossi}"]`).waitFor({ timeout: 15_000 });
    const label = await p.locator(`[data-appointment="${seed.ids.todayYossi}"]`).getAttribute("aria-label");
    if (!label?.includes("בוטל")) throw new Error(`cancelled reads: ${label}`);
    await shot(p, "14-desktop-show-cancelled");
    await p.getByLabel("הצגת מבוטלים").uncheck();
  });

  await check("D17 the month: each day's count; closed days and different hours named", async () => {
    await p.goto(`/calendar?view=month&day=${seed.partDay}`);
    await p.locator('[class*="weekRow"]').first().waitFor({ timeout: 20_000 });
    await p.waitForTimeout(1500);
    const label = async (day: string) => (await p.locator(`button[aria-label^="${longDay(day)}"]`).first().getAttribute("aria-label")) ?? "";
    if (!(await label(seed.closedDay)).includes("סגור כל היום")) throw new Error(`closed day reads: ${await label(seed.closedDay)}`);
    if (!/12:00.14:00/.test(await label(seed.partDay))) throw new Error(`part-day reads: ${await label(seed.partDay)}`);
    await shot(p, "15-desktop-month");
  });
  await check("D18 closures are named on the day and the week (a lock and the label)", async () => {
    await p.goto(`/calendar?view=day&day=${seed.partDay}`);
    await p.locator('[class*="closureLabel"]').first().waitFor({ timeout: 20_000 });
    await shot(p, "16-desktop-day-closure");
    await p.goto(`/calendar?view=week&day=${seed.closedDay}`);
    await p.locator('[class*="closureLabel"]', { hasText: "חג" }).first().waitFor({ timeout: 20_000 });
    await shot(p, "17-desktop-week-closures");
  });
  await check("D19 every free time is offered (show more); nothing inside a closure", async () => {
    await p.goto(`/calendar?view=day&day=${seed.today}`);
    const dlg = await openNew(p);
    await dlg.getByLabel("תאריך", { exact: true }).fill(seed.partDay);
    const head = dlg.getByText(/^שעות פנויות \(/).first();
    await head.waitFor({ timeout: 20_000 });
    const total = Number(((await head.textContent()) ?? "").match(/\((\d+)\)/)?.[1] ?? 0);
    const more = dlg.locator('[class*="chipMore"]');
    if (await more.count()) await more.click();
    const chips = dlg.locator('[class*="slotChips"] button[aria-pressed]');
    if (!(total > 9 && (await chips.count()) === total)) throw new Error(`total ${total}, chips ${await chips.count()}`);
    const inside = await chips.evaluateAll((els) => els.map((e) => e.textContent ?? "").filter((x) => x >= "12:00" && x < "14:00"));
    if (inside.length) throw new Error(`offered inside the closure: ${inside.join(",")}`);
    await shot(p, "18-desktop-all-slots");
    await closeForm(p);
  });
  await check("D20 a time inside a closure is flagged BEFORE booking; an open time is not; a closed day says why", async () => {
    const dlg = await openNew(p);
    await dlg.getByRole("radio", { name: "פגישה" }).click();
    await dlg.getByLabel("נושא", { exact: true }).fill("בדיקת סגירה");
    await dlg.getByLabel("תאריך", { exact: true }).fill(seed.partDay);
    await otherTime(dlg, "12:30");
    await dlg.getByText("השעה נופלת בזמן סגור").first().waitFor({ timeout: 15_000 });
    await dlg.getByRole("button", { name: "לקבוע בכל זאת" }).waitFor();
    await shot(p, "19-desktop-closure-warning");
    await dlg.getByLabel("שעה אחרת", { exact: true }).fill("10:00");
    await dlg.getByRole("button", { name: "קביעת פגישה" }).waitFor({ timeout: 5_000 });
    if (await dlg.getByText("השעה נופלת בזמן סגור").count()) throw new Error("an open time is still flagged");
    await dlg.getByLabel("תאריך", { exact: true }).fill(seed.closedDay);
    await dlg.getByText(/אין שעה פנויה ביום הזה\. היום סגור/).first().waitFor({ timeout: 15_000 });
    await closeForm(p);
  });
  await check("D21 a time block: from–to, for the whole business", async () => {
    const dlg = await openNew(p);
    await dlg.getByRole("radio", { name: "חסימה" }).click();
    await dlg.getByRole("heading", { name: "חסימת זמן" }).waitFor();
    await dlg.getByLabel("משעה", { exact: true }).waitFor();
    await dlg.getByLabel("עד שעה", { exact: true }).waitFor();
    await shot(p, "20-desktop-block-form");
    await closeForm(p);
  });
  await check("D22 the forms enforce the server's text limits, in Hebrew", async () => {
    const dlg = await openNew(p);
    await dlg.getByRole("radio", { name: "פגישה" }).click();
    await dlg.getByLabel("נושא", { exact: true }).fill("א".repeat(205));
    await otherTime(dlg, "15:00");
    await dlg.getByRole("button", { name: /קביעת פגישה|לקבוע בכל זאת/ }).click();
    await dlg.getByText(/ארוך מדי: עד 200/).first().waitFor({ timeout: 10_000 });
    await shot(p, "21-desktop-text-limit");
    await closeForm(p);
  });

  await check("D23 ניהול היומן: a row per subject with its state", async () => {
    await p.goto("/calendar/manage");
    await p.getByRole("heading", { name: "ניהול היומן" }).waitFor({ timeout: 20_000 });
    await seen(p, /א׳–ה׳/);
    await seen(p, /שירה/);
    await seen(p, "3 שירותים");
    await seen(p, "הזמנת תורים בקישור");
    await shot(p, "22-desktop-manage");
  });
  await check("D24 שעות פעילות: the week, a break, copy to other days; leaving with changes asks first", async () => {
    await p.goto("/calendar/hours");
    await p.getByRole("button", { name: "שמירת השעות" }).waitFor({ timeout: 20_000 });
    if (!(await p.getByRole("button", { name: "שמירת השעות" }).isDisabled())) throw new Error("nothing changed, yet save is live");
    await p.getByRole("button", { name: /הפסקה וטווח נוסף/ }).first().click();
    if (!(await p.getByRole("button", { name: "שמירת השעות" }).isEnabled())) throw new Error("a change does not enable save");
    await p.getByRole("button", { name: /העתקה לימים אחרים/ }).first().click();
    await seen(p, /להעתיק את השעות של יום/);
    await shot(p, "23-desktop-hours");
    await p.getByRole("button", { name: /^חזרה|לניהול היומן/ }).first().click();
    await p.getByText("יש שינויים שלא נשמרו").first().waitFor({ timeout: 5_000 });
    await p.getByRole("button", { name: "להישאר" }).click();
    await p.getByRole("button", { name: "ביטול השינויים" }).click();
  });
  await check("D25 ימים מיוחדים: the business's closures listed, add form", async () => {
    await p.goto("/calendar/special-days");
    await p.getByRole("list", { name: "ימים מיוחדים קרובים" }).waitFor({ timeout: 20_000 });
    await seen(p, /חג/);
    await p.getByRole("radio", { name: "סגור בחלק מהיום" }).click();
    await p.getByLabel("משעה", { exact: true }).waitFor();
    await shot(p, "24-desktop-special-days");
  });
  await check("D26 צוות: the list (an inactive member marked) and a member's page (hours, special days, services)", async () => {
    await p.goto("/calendar/staff");
    await p.getByRole("link", { name: /Dana Cohen/ }).getByText("לא פעיל").waitFor({ timeout: 20_000 });
    await shot(p, "25-desktop-staff-list");
    await p.getByRole("link", { name: /^ש\s*שירה/ }).first().click();
    await p.getByRole("heading", { name: "שעות עבודה" }).waitFor({ timeout: 20_000 });
    await p.getByRole("group", { name: "שירותים שהעובד מבצע" }).waitFor();
    await shot(p, "26-desktop-staff-member", true);
  });
  await check("D27 a new service, its length edited, and the calendar books with the new length", async () => {
    await p.goto("/calendar/services");
    await p.getByRole("button", { name: "הוספת שירות" }).first().click();
    await p.getByLabel("שם השירות", { exact: true }).fill("פן");
    await p.getByLabel("משך (דקות)", { exact: true }).fill("40");
    await p.getByRole("button", { name: "הוספת השירות" }).click();
    await p.waitForURL(/\/calendar\/services\/\d+/, { timeout: 20_000 });
    await p.locator("#svc-duration").fill("50");
    await p.getByRole("button", { name: "שמירת השינויים" }).click();
    await seen(p, "השינויים נשמרו");
    await shot(p, "27-desktop-service-page", true);
    await p.goto(`/calendar?day=${seed.today}`);
    const dlg = await openNew(p);
    await dlg.getByLabel("שירות", { exact: true }).selectOption({ label: "פן · 50 דק׳" });
    if ((await dlg.getByLabel("משך", { exact: true }).inputValue()) !== "50") throw new Error("the form did not take the edited length");
    await closeForm(p);
  });
  await check("D28 who performs a service: one editor on the service page and the staff page, saved, others untouched", async () => {
    const before = (await api(t, "/api/appointments/staff")).body.staff as Array<{ id: number; services: Array<{ businessServiceId: number }> }>;
    await p.goto(`/calendar/services/${seed.services.color}`);
    const who = p.getByRole("group", { name: "מי מבצע את השירות" });
    const avi = who.getByRole("checkbox", { name: "אבי" });
    await avi.waitFor({ timeout: 20_000 });
    if (await avi.isChecked()) throw new Error("אבי should not perform צבע in the seed");
    await avi.check();
    await p.getByRole("button", { name: "שמירת השינויים" }).click();
    await seen(p, "השינויים נשמרו");
    await p.reload();
    await p.getByRole("group", { name: "מי מבצע את השירות" }).getByRole("checkbox", { name: "אבי" }).waitFor({ timeout: 20_000 });
    if (!(await p.getByRole("group", { name: "מי מבצע את השירות" }).getByRole("checkbox", { name: "אבי" }).isChecked())) throw new Error("after a reload the assignment is gone");
    await p.goto(`/calendar/staff/${seed.staff.avi}`);
    const mine = p.getByRole("group", { name: "שירותים שהעובד מבצע" });
    await mine.getByRole("checkbox", { name: /^צבע/ }).waitFor({ timeout: 20_000 });
    if (!(await mine.getByRole("checkbox", { name: /^צבע/ }).isChecked())) throw new Error("the staff page does not show the same assignment");
    const after = (await api(t, "/api/appointments/staff")).body.staff as typeof before;
    for (const m of before) {
      const a = after.find((x) => x.id === m.id)!;
      const rest = (l: typeof m.services) => l.map((x) => x.businessServiceId).filter((x) => x !== seed.services.color).sort().join(",");
      if (rest(a.services) !== rest(m.services)) throw new Error(`staff ${m.id}: another service's assignment changed`);
    }
    await shot(p, "28-desktop-staff-services", true);
  });

  await check("D29 the requests: the link's pending request with its phone and note; approving asks first", async () => {
    await p.goto("/calendar?view=requests");
    await seen(p, "בקשה לדוגמה");
    await seen(p, /מהקישור/);
    await shot(p, "29-desktop-requests");
    await p.getByRole("button", { name: "אישור", exact: true }).first().click();
    await p.getByText(/לאשר את התור של .?בקשה לדוגמה.?\?/).waitFor({ timeout: 10_000 });
    await p.getByRole("button", { name: "כן, לאשר" }).click();
    await seen(p, /התור של .?בקשה לדוגמה.? אושר/);
  });
  await check("D30 booking settings: the link, the platform's limits, and the dead-end combination named with its fix", async () => {
    await p.goto("/calendar/booking");
    await p.getByRole("heading", { name: "הקישור" }).waitFor({ timeout: 20_000 });
    await p.locator("code").filter({ hasText: "/book/" }).first().waitFor({ timeout: 15_000 });
    await seen(p, "מגבלות האבטחה של דוביז");
    await shot(p, "30-desktop-booking-settings", true);
    const names = p.getByRole("switch", { name: "שמות העובדים" });
    const wasShown = (await names.getAttribute("aria-checked")) === "true";
    await p.getByRole("radiogroup", { name: "הלקוח בוחר עובד" }).getByRole("radio", { name: "חובה" }).click();
    await seen(p, "נשמר");
    if (wasShown) { await names.click(); await p.waitForTimeout(1200); }
    await seen(p, /אף שירות לא יוצג ללקוחות/);
    await shot(p, "31-desktop-booking-dead-end");
    await p.getByRole("button", { name: "לשנות ל„אם רוצה”" }).click();
    await p.getByText(/אף שירות לא יוצג ללקוחות/).waitFor({ state: "hidden", timeout: 15_000 });
    if (wasShown) { await names.click(); await p.waitForTimeout(1200); }
  });

  await check("D31 the Secretary: תורים היום, and its calendar opens on the date in the link", async () => {
    await p.goto("/secretary");
    await seen(p, "תורים היום");
    await shot(p, "32-desktop-secretary");
    await p.goto(`/secretary?screen=calendar&day=${seed.partDay}`);
    await seen(p, longDay(seed.partDay));
    await shot(p, "33-desktop-secretary-calendar-day");
  });
  await check("D32 the customer card: \"קביעת תור\" opens the form with the customer; an appointment links to its day", async () => {
    await p.goto(`/customers/${seed.customers.maya}`);
    const link = p.locator(`a[href*="appointment=${seed.ids.todayMaya}"]`).first();
    await link.waitFor({ timeout: 20_000 });
    if (!(await link.getAttribute("href"))?.includes(`day=${seed.today}`)) throw new Error("the appointment link has no day");
    await shot(p, "34-desktop-customer-card");
    await p.getByRole("link", { name: "קביעת תור" }).click();
    await p.waitForURL(/\/calendar/);
    const dlg = p.getByRole("dialog");
    await dlg.getByText("מאיה פרץ").waitFor({ timeout: 20_000 });
    await closeForm(p);
  });
  await dc.close();

  // ── Phone 390, appointments ON ─────────────────────────────────────────────────────────────────
  console.log("phone · appointments ON");
  const mc = await ctx(browser, t, PHONE);
  const m = await mc.newPage();
  current = m;
  await check("M1 the phone's day is a time grid: hours, free time, the week strip, the booking button", async () => {
    await m.goto(`/calendar?day=${seed.today}`);
    await m.locator(`[data-appointment="${seed.ids.todayNoa}"]`).waitFor({ timeout: 25_000 });
    await m.getByRole("tablist", { name: "ימי השבוע" }).waitFor();
    await m.getByRole("button", { name: /^קביעה ב.* בשעה/ }).first().waitFor({ state: "attached" });
    await m.getByRole("button", { name: "קביעת תור" }).first().waitFor();
    await noSideScroll(m, 390);
    await shot(m, "m01-phone-day");
  });
  await check("M2 day and week differ on the phone: the week is a list grouped by day", async () => {
    await m.getByRole("tab", { name: "שבוע", exact: true }).click();
    await m.getByRole("button", { name: /— תצוגת יום$/ }).first().waitFor({ timeout: 15_000 });
    if (await m.getByRole("tablist", { name: "ימי השבוע" }).count()) throw new Error("the week shows the day strip");
    await shot(m, "m02-phone-week", true);
  });
  await check("M3 a tap on free time opens the form with that time", async () => {
    await m.goto(`/calendar?day=${seed.today}`);
    const hit = m.getByRole("button", { name: /בשעה 17:00$/ }).first();
    await hit.scrollIntoViewIfNeeded();
    await hit.click();
    const dlg = m.getByRole("dialog");
    await dlg.getByRole("heading", { name: "קביעת תור" }).waitFor({ timeout: 15_000 });
    if (!(await dlg.getByLabel("שעה אחרת", { exact: true }).inputValue()).startsWith("17:")) throw new Error("the tapped time is not filled in");
    await shot(m, "m03-phone-create-sheet");
    await closeForm(m);
  });
  await check("M4 an appointment opens as a sheet; the phone's back closes the sheet, not the calendar", async () => {
    await m.goto(`/calendar?day=${seed.today}`);
    const block = m.locator(`[data-appointment="${seed.ids.todayMaya}"]`);
    await block.scrollIntoViewIfNeeded();
    await block.click();
    await m.getByRole("dialog").getByText("גוון 7.1").waitFor({ timeout: 15_000 });
    await shot(m, "m04-phone-details-sheet");
    await m.goBack();
    await m.getByRole("dialog").waitFor({ state: "hidden", timeout: 10_000 });
    if (!m.url().includes("/calendar")) throw new Error(`back left the calendar: ${m.url()}`);
  });
  await check("M5 the phone's month: counts and closed days", async () => {
    await m.goto(`/calendar?view=month&day=${seed.closedDay}`);
    await m.locator('[class*="cellBadge"]', { hasText: "סגור" }).first().waitFor({ timeout: 20_000 });
    await shot(m, "m05-phone-month");
  });
  await check("M6 cancel on the phone: a double tap keeps the appointment; the confirm is held a moment", async () => {
    await m.goto(`/calendar?day=${seed.today}&appointment=${seed.ids.todayMaya}`);
    const open = m.getByRole("button", { name: "ביטול התור" });
    await open.waitFor({ timeout: 20_000 });
    await open.scrollIntoViewIfNeeded();
    const box = (await open.boundingBox())!;
    await m.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await m.waitForTimeout(60);
    await m.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await m.waitForTimeout(1200);
    const status = (await api(t, `/api/appointments/${seed.ids.todayMaya}`)).body.appointment.status;
    if (status !== "CONFIRMED") throw new Error(`after a double tap the appointment is ${status}`);
    const confirm = m.getByRole("button", { name: "כן, לבטל את התור" });
    if (!(await confirm.count())) await open.click();
    await shot(m, "m06-phone-cancel");
    await m.getByRole("button", { name: /חזרה, להשאיר/ }).click();
  });
  await check("M7 a closed day on the phone: the closure is named; nothing sideways", async () => {
    await m.goto(`/calendar?view=day&day=${seed.closedDay}`);
    await m.locator('[class*="closureLabel"]', { hasText: "חג" }).first().waitFor({ timeout: 20_000 });
    await noSideScroll(m, 390);
    await shot(m, "m07-phone-closed-day");
  });
  type Cover = { button: { top: number; bottom: number } | null; navTop: number | null; underNav: boolean };
  const COVER_PROBE = `(() => {
    const nav = [...document.querySelectorAll("nav")].map((e) => e.getBoundingClientRect()).find((r) => r.bottom >= innerHeight - 2 && r.height < 140) || null;
    const el = [...document.querySelectorAll("main button")].find((x) => (x.textContent || "").trim() === "קביעת תור");
    const b = el ? el.getBoundingClientRect() : null;
    return { button: b && { top: b.top, bottom: b.bottom }, navTop: nav ? nav.top : null, underNav: !!b && !!nav && b.bottom > nav.top };
  })()`;
  await check("M8 \"קביעת תור\" stays on screen above the bottom bar, never under it", async () => {
    await m.goto(`/calendar?day=${seed.today}`);
    await m.locator(`[data-appointment="${seed.ids.todayNoa}"]`).waitFor({ timeout: 20_000 });
    const c = (await m.evaluate(COVER_PROBE)) as Cover;
    if (!c.button || c.underNav || c.button.bottom > 844) throw new Error(JSON.stringify(c));
  });
  await check("M9 the active view tab is marked and looks different", async () => {
    const tab = m.getByRole("tab", { name: "יום", exact: true });
    if ((await tab.getAttribute("aria-selected")) !== "true") throw new Error("the active tab is not marked");
    const color = (name: string) => m.getByRole("tab", { name, exact: true }).evaluate((e) => getComputedStyle(e).borderBottomColor);
    if ((await color("יום")) === (await color("שבוע"))) throw new Error("active and inactive tabs look alike");
  });
  await check("M10 \"+\" offers קביעת תור where the calendar is open", async () => {
    await m.getByRole("button", { name: "פעולה חדשה" }).first().click();
    await m.getByText("קביעת תור", { exact: true }).last().waitFor({ timeout: 10_000 });
    await shot(m, "m08-phone-plus-sheet");
    await m.keyboard.press("Escape");
  });
  await check("M11 the management centre and its pages on the phone", async () => {
    await m.goto("/calendar/manage");
    await m.getByRole("heading", { name: "ניהול היומן" }).waitFor({ timeout: 20_000 });
    await noSideScroll(m, 390);
    await shot(m, "m09-phone-manage");
    await m.goto("/calendar/hours");
    await m.getByRole("button", { name: "שמירת השעות" }).waitFor({ timeout: 20_000 });
    await noSideScroll(m, 390);
    await shot(m, "m10-phone-hours", true);
    await m.goto(`/calendar/staff/${seed.staff.shira}`);
    await m.getByRole("heading", { name: "שעות עבודה" }).waitFor({ timeout: 20_000 });
    await noSideScroll(m, 390);
    await shot(m, "m11-phone-staff-member", true);
    await m.goto(`/calendar/services/${seed.services.haircut}`);
    await m.getByRole("heading", { name: "כללי קביעה" }).waitFor({ timeout: 20_000 });
    await noSideScroll(m, 390);
    await shot(m, "m12-phone-service", true);
    await m.goto("/calendar/booking");
    await m.getByRole("heading", { name: "הקישור" }).waitFor({ timeout: 20_000 });
    await noSideScroll(m, 390);
    await shot(m, "m13-phone-booking-settings", true);
  });
  await check("M12 the requests on the phone", async () => {
    await m.goto("/calendar?view=requests");
    await m.getByRole("heading", { name: /ממתינות לאישור/ }).waitFor({ timeout: 20_000 });
    await shot(m, "m14-phone-requests", true);
  });
  await mc.close();

  // A small phone (320), a common phone (375) and a tablet: nothing sideways, nothing covered.
  for (const [w, h, name] of [[320, 640, "S1 small phone"], [375, 667, "S2 phone"], [820, 1180, "T1 tablet"]] as const) {
    const sc = await ctx(browser, t, { width: w, height: h, phone: w < 768 });
    const sp = await sc.newPage();
    current = sp;
    await check(`${name} (${w}px): the day, the form and the management centre fit; the booking button is clear of the bar`, async () => {
      await sp.goto(`/calendar?day=${seed.today}`);
      await sp.locator(`[data-appointment="${seed.ids.todayNoa}"]`).waitFor({ timeout: 25_000 });
      await noSideScroll(sp, w);
      const c = (await sp.evaluate(COVER_PROBE)) as Cover;
      if (!c.button || c.underNav) throw new Error(JSON.stringify(c));
      await shot(sp, `${w}-day`);
      const dlg = await openNew(sp);
      await dlg.getByLabel("לקוח", { exact: true }).waitFor();
      await noSideScroll(sp, w);
      await shot(sp, `${w}-form`);
      await closeForm(sp);
      await sp.goto("/calendar/manage");
      await sp.getByRole("heading", { name: "ניהול היומן" }).waitFor({ timeout: 20_000 });
      await noSideScroll(sp, w);
      await shot(sp, `${w}-manage`);
    });
    await sc.close();
  }

  // ── Business B, appointments OFF ──────────────────────────────────────────────────────────────
  console.log("desktop · appointments OFF (business B)");
  const oc = await ctx(browser, seed.tokenB, DESKTOP);
  const o = await oc.newPage();
  current = o;
  await check("O1 OFF: the calendar and its settings say it is not active", async () => {
    await o.goto("/calendar");
    await seen(o, "היומן עדיין לא פעיל לעסק שלך");
    await shot(o, "o01-off-calendar");
    await o.goto("/calendar/manage");
    await seen(o, "היומן עדיין לא פעיל לעסק שלך");
  });
  await check("O2 OFF: the API answers 404 for the signed-in owner", async () => (await api(seed.tokenB, `/api/appointments?from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 864e5).toISOString())}`)).status === 404);
  await check("O3 OFF: the sidebar does not list the calendar", async () => {
    await o.goto("/secretary");
    await o.waitForLoadState("networkidle");
    return (await o.getByRole("link", { name: "יומן ותורים" }).count()) === 0;
  });
  await check("O4 OFF: the Secretary has no תורים היום card", async () => {
    await o.getByText("תחנות ניהול").first().waitFor({ timeout: 20_000 });
    await o.waitForTimeout(1500);
    await shot(o, "o02-off-secretary");
    return (await o.getByText("תורים היום").count()) === 0;
  });
  await check("O5 OFF: business B cannot read business A's appointment", async () => (await api(seed.tokenB, `/api/appointments/${seed.ids.todayNoa}`)).status === 404);
  await oc.close();

  await browser.close();
  const failed = rows.filter((r) => !r.ok);
  const md = [
    "## Appointments — end to end (real app, PG lab, desktop + phones + tablet) — design direction A",
    "",
    `${rows.length - failed.length} passed, ${failed.length} failed`,
    "",
    "| check | result |",
    "|---|---|",
    ...rows.map((r) => `| ${r.name} | ${r.ok ? "PASS" : `FAIL — ${r.detail.replace(/\|/g, "\\|")}`} |`),
  ].join("\n");
  writeFileSync(join(OUT, "report.md"), md);
  console.log(`\n${rows.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
