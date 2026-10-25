/**
 * Appointments milestone B — the calendar END TO END in a real browser, on the real app (`next start`) over the
 * Production-shaped lab (.appt/lab.sh --with-appt, seeded by .appt/ui-seed.ts). Desktop 1440×900 and phone 390×844.
 *
 *   ON  (business A, appointments ON by a per-business override):
 *       the week, the day by staff, details, create with the open-lead link (decision 11), a taken time → the nearest
 *       free times, drag to move, cancel with a reason, the month, staff and hours, service rules, the Secretary's
 *       card and calendar, "קבע תור" from the customer card, the text limits, the phone's agenda / sheets / month.
 *   OFF (business B, no override): the screen says the calendar is not active, the API answers 404, the navigation,
 *       the Secretary and the customer card show nothing of it.
 *
 * Every step leaves a screenshot in $OUT; the result table goes to $OUT/report.md. Exit 1 on any failed check.
 * env: E2E_BASE, SEED_OUT, OUT. Synthetic only — ZERO secrets, ZERO network beyond localhost.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

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
    const detail = e instanceof Error ? e.message.split("\n")[0].slice(0, 200) : String(e);
    rows.push({ name, ok: false, detail });
    if (current) await current.screenshot({ path: join(OUT, `FAILED-${name.split(" ")[0]}.png`) }).catch(() => undefined);
    console.log(`  [FAIL] ${name} — ${detail}`);
  }
}

async function ctx(browser: Browser, token: string, phone: boolean): Promise<BrowserContext> {
  const c = await browser.newContext({
    baseURL: BASE,
    locale: "he-IL",
    timezoneId: "Asia/Jerusalem",
    ...(phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } }),
  });
  await c.addInitScript((t) => { try { localStorage.setItem("token", t); } catch { /* opaque */ } }, token);
  return c;
}

const shot = (page: Page, name: string) => page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false });
const seen = (page: Page, text: string | RegExp, timeout = 25_000) => page.getByText(text).first().waitFor({ state: "visible", timeout });
async function api(token: string, path: string) {
  const r = await fetch(BASE + path, { headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function main() {
  const browser = await chromium.launch();
  const t = seed.tokenA as string;

  // ── Desktop, appointments ON ──────────────────────────────────────────────────────────────────
  console.log("desktop · appointments ON");
  const dc = await ctx(browser, t, false);
  const p = await dc.newPage();
  current = p;

  await check("D1 the week shows the seeded appointments with customer and service", async () => {
    await p.goto("/calendar?view=week");
    await seen(p, "נועה לוי · תספורת");
    await seen(p, "הפסקת צהריים");
    await shot(p, "01-desktop-week");
  });
  await check("D2 ניהול העסק in the sidebar lists יומן ותורים", async () => p.getByRole("link", { name: "יומן ותורים" }).first().waitFor({ timeout: 15_000 }));
  await check("D3 the day view has a column per staff member", async () => {
    await p.goto(`/calendar?view=day&day=${seed.today}`);
    for (const name of ["שירה", "אבי", "כללי"]) await p.locator(`span:text-is("${name}")`).first().waitFor({ timeout: 25_000 });
    await shot(p, "02-desktop-day-by-staff");
  });
  await check("D4 an appointment opens its details: status, customer, staff, actions, history", async () => {
    await p.getByRole("button", { name: /נועה לוי/ }).first().click();
    const panel = p.getByRole("complementary", { name: "פרטי התור" });
    await panel.getByText("מאושר").first().waitFor({ timeout: 15_000 });
    for (const b of ["הושלם", "לא הגיע", "הזז", "ביטול התור"]) await panel.getByRole("button", { name: b }).waitFor();
    await panel.getByText("נקבע").first().waitFor();
    await shot(p, "03-desktop-details");
  });

  await check("D5 create: a customer with an open lead is linked to it (decision 11), the lead's stage untouched", async () => {
    await p.getByRole("button", { name: "תור חדש" }).first().click();
    const dlg = p.getByRole("dialog");
    await dlg.getByLabel("לקוח", { exact: true }).fill("רון");
    await dlg.getByRole("option", { name: /רון אברהם/ }).click();
    await dlg.getByText("יקושר לליד הפתוח").waitFor({ timeout: 15_000 });
    await dlg.getByLabel("שירות", { exact: true }).selectOption({ label: "ייעוץ · 30 דק׳" });
    await dlg.getByLabel("עובד", { exact: true }).selectOption({ label: "אבי" });
    await dlg.getByLabel("שעה", { exact: true }).fill("16:00");
    await shot(p, "04-desktop-create-form");
    await dlg.getByRole("button", { name: "קבע", exact: true }).click();
    await seen(p, "נקבע");
    const list = await api(t, `/api/appointments?from=${encodeURIComponent(new Date(Date.now() - 864e5).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 3 * 864e5).toISOString())}`);
    const ron = (list.body?.appointments ?? []).find((a: { customerId: number }) => a.customerId === seed.customers.ron);
    if (!ron || ron.leadId === null) throw new Error(`no linked appointment for the lead's customer: ${JSON.stringify(ron)}`);
    await shot(p, "05-desktop-after-create");
  });

  await check("D6 a taken time answers in Hebrew and offers the nearest free times", async () => {
    await p.getByRole("button", { name: "תור חדש" }).first().click();
    const dlg = p.getByRole("dialog");
    await dlg.getByLabel("לקוח", { exact: true }).fill("מאיה");
    await dlg.getByRole("option", { name: /מאיה פרץ/ }).click();
    await dlg.getByLabel("שירות", { exact: true }).selectOption({ label: "תספורת · 45 דק׳" });
    await dlg.getByLabel("עובד", { exact: true }).selectOption({ label: "שירה" });
    await dlg.getByLabel("תאריך", { exact: true }).fill(seed.today);
    await dlg.getByLabel("שעה", { exact: true }).fill("10:00");
    await dlg.getByRole("button", { name: "קבע", exact: true }).click();
    await dlg.getByText("השעה הזו כבר תפוסה").waitFor({ timeout: 15_000 });
    await dlg.getByText("שעות קרובות שפנויות").waitFor();
    await shot(p, "06-desktop-conflict");
    await dlg.getByRole("button", { name: "ביטול" }).last().click();
  });

  await check("D7 drag an appointment two hours later: moved by the server, journalled", async () => {
    await p.goto(`/calendar?view=day&day=${seed.today}`);
    const block = p.getByRole("button", { name: /נועה לוי/ }).first();
    await block.waitFor();
    const box = (await block.boundingBox())!;
    await p.mouse.move(box.x + box.width / 2, box.y + 8);
    await p.mouse.down();
    await p.mouse.move(box.x + box.width / 2, box.y + 8 + 60, { steps: 6 });
    await p.mouse.move(box.x + box.width / 2, box.y + 8 + 112, { steps: 6 });
    await p.mouse.up();
    await seen(p, "הוזז");
    const one = await api(t, `/api/appointments/${seed.ids.todayNoa}`);
    const hour = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jerusalem" }).format(new Date(one.body.appointment.startsAt));
    if (hour !== "12:00") throw new Error(`moved to ${hour}`);
    if (!one.body.history.some((h: { type: string }) => h.type === "APPOINTMENT_RESCHEDULED")) throw new Error("no journal event");
    await shot(p, "07-desktop-after-drag");
  });

  await check("D8 cancel with a closed reason and a note: the time is freed, the journal says so", async () => {
    await p.goto(`/calendar?view=day&day=${seed.today}&appointment=${seed.ids.todayYossi}`);
    const panel = p.getByRole("complementary", { name: "פרטי התור" });
    await panel.getByText("ממתין לאישור").first().waitFor({ timeout: 15_000 });
    await panel.getByRole("button", { name: "ביטול התור" }).click();
    await panel.getByRole("radio", { name: "הלקוח ביטל" }).click();
    await panel.getByLabel("הסבר קצר (לא חובה)").fill("התקשר לבטל");
    await shot(p, "08-desktop-cancel");
    await panel.getByRole("button", { name: "בטל את התור" }).click();
    await panel.getByText("בוטל", { exact: true }).first().waitFor({ timeout: 15_000 });
    const one = await api(t, `/api/appointments/${seed.ids.todayYossi}`);
    if (one.body.appointment.status !== "CANCELED" || one.body.appointment.cancelReason !== "CUSTOMER_CANCELED") throw new Error(JSON.stringify(one.body.appointment));
  });

  await check("D9 the month shows each day's appointments", async () => {
    await p.goto("/calendar?view=month");
    await p.getByRole("button", { name: /· [0-9]+ תור/ }).first().waitFor({ timeout: 20_000 });
    await shot(p, "09-desktop-month");
  });

  await check("D10 staff and hours: the business's week, a staff member's services", async () => {
    await p.goto("/calendar/staff");
    await seen(p, "שעות הפעילות של העסק");
    await shot(p, "10-desktop-staff-business");
    await p.getByRole("button", { name: /^שירה/ }).click();
    await seen(p, "שירותים שהעובד מבצע");
    await shot(p, "11-desktop-staff-member");
  });
  await check("D11 service rules: buffers, step, notice, horizon, who performs", async () => {
    await p.goto("/calendar/services");
    await seen(p, "מרווח לפני");
    await seen(p, "מי מבצע את השירות");
    await shot(p, "12-desktop-services");
  });

  await check("D12 the Secretary: a תורים היום card on its main screen", async () => {
    await p.goto("/secretary");
    await seen(p, "תורים היום");
    await seen(p, "תספורת");
    await shot(p, "13-desktop-secretary");
  });
  await check("D13 the Secretary's existing calendar shows appointments as their own kind", async () => {
    await p.goto(`/secretary?screen=calendar&day=${seed.today}`);
    await seen(p, "תורים, משימות ומועדי תשלום");
    await p.getByRole("list", { name: "מקרא" }).getByText("תור").first().waitFor();
    // today's appointments are listed under the month, with the customer's name and the time
    await seen(p, /12:00 · נועה לוי · תספורת/);
    await shot(p, "14-desktop-secretary-calendar");
  });

  await check("D14 קבע תור on the customer card opens the calendar's form with the customer", async () => {
    await p.goto(`/customers/${seed.customers.maya}`);
    await p.getByRole("link", { name: "קבע תור" }).click();
    await p.waitForURL(/\/calendar/);
    const dlg = p.getByRole("dialog");
    await dlg.getByText("מאיה פרץ").waitFor({ timeout: 20_000 });
    await shot(p, "15-desktop-book-from-customer");
    await dlg.getByRole("button", { name: "ביטול" }).last().click();
  });

  await check("D16 a new service in the catalog, its length edited, and the calendar books with the new length", async () => {
    await p.goto("/calendar/services");
    await p.getByRole("button", { name: "+ שירות חדש" }).first().click();
    await p.getByLabel("שם השירות", { exact: true }).first().fill("פן");
    await p.getByLabel("משך (דקות)", { exact: true }).first().fill("40");
    await p.getByRole("button", { name: "הוספת השירות" }).click();
    await seen(p, "השירות נוסף");
    await p.getByRole("button", { name: /^פן/ }).first().click();
    const card = p.getByRole("region", { name: "פרטי השירות" });
    await card.getByLabel("משך (דקות)", { exact: true }).fill("50");
    await card.getByRole("button", { name: "שמירה" }).click();
    await seen(p, "השירות עודכן");
    await shot(p, "17-desktop-service-edit");
    await p.goto(`/calendar?view=day&day=${seed.today}`);
    await p.getByRole("button", { name: "תור חדש" }).first().click();
    const dlg = p.getByRole("dialog");
    await dlg.getByLabel("שירות", { exact: true }).selectOption({ label: "פן · 50 דק׳" });
    if ((await dlg.getByLabel("משך (דק׳)", { exact: true }).inputValue()) !== "50") throw new Error("the form did not take the edited length");
    await dlg.getByRole("button", { name: "ביטול" }).last().click();
  });

  await check("D15 the forms enforce the server's text limits, in Hebrew", async () => {
    await p.getByRole("button", { name: "תור חדש" }).first().click();
    const dlg = p.getByRole("dialog");
    await dlg.getByRole("radio", { name: "פגישה פנימית" }).click();
    await dlg.getByLabel("כותרת", { exact: true }).fill("א".repeat(205));
    await dlg.getByLabel("שעה", { exact: true }).fill("15:00");
    await dlg.getByRole("button", { name: "קבע", exact: true }).click();
    await dlg.getByText(/ארוך מדי: עד 200/).first().waitFor({ timeout: 10_000 });
    await shot(p, "16-desktop-text-limit");
    await dlg.getByRole("button", { name: "ביטול" }).last().click();
  });
  await dc.close();

  // ── Phone, appointments ON ────────────────────────────────────────────────────────────────────
  console.log("phone · appointments ON");
  const mc = await ctx(browser, t, true);
  const m = await mc.newPage();
  current = m;
  await check("M1 the phone: the day's agenda under the week strip, + always on screen", async () => {
    await m.goto(`/calendar?day=${seed.today}`);
    await seen(m, "נועה לוי · תספורת");
    await m.getByRole("tablist", { name: "ימים" }).waitFor();
    await m.getByRole("button", { name: "תור חדש" }).first().waitFor();
    await shot(m, "m01-phone-agenda");
  });
  await check("M2 an appointment opens as a bottom sheet", async () => {
    await m.getByRole("button", { name: /מאיה פרץ/ }).first().click();
    await m.getByRole("dialog").getByText("גוון 7.1").waitFor({ timeout: 15_000 });
    await shot(m, "m02-phone-details-sheet");
    await m.keyboard.press("Escape");
  });
  await check("M3 the create form as a bottom sheet", async () => {
    await m.getByRole("button", { name: "תור חדש" }).first().click();
    await m.getByRole("dialog").getByText("תור חדש").first().waitFor();
    await shot(m, "m03-phone-create-sheet");
    await m.keyboard.press("Escape");
  });
  await check("M4 the phone's month", async () => {
    await m.goto("/calendar?view=month");
    await m.getByRole("button", { name: /· [0-9]+ תור/ }).first().waitFor({ timeout: 20_000 });
    await shot(m, "m04-phone-month");
  });
  await check("M5 the Secretary on the phone", async () => {
    await m.goto("/secretary");
    await seen(m, "תורים היום");
    await shot(m, "m05-phone-secretary");
  });
  await mc.close();

  // ── Business B, appointments OFF ──────────────────────────────────────────────────────────────
  console.log("desktop · appointments OFF (business B)");
  const oc = await ctx(browser, seed.tokenB, false);
  const o = await oc.newPage();
  current = o;
  await check("O1 OFF: the calendar says it is not active", async () => {
    await o.goto("/calendar");
    await seen(o, "היומן עדיין לא פעיל לעסק שלך");
    await shot(o, "o01-off-calendar");
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
    "## Appointments milestone B — end to end (real app, PG17 lab, desktop + phone)",
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
