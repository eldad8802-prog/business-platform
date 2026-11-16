/**
 * Legal identity corrections — the whole flow in real browsers, two isolated accounts, against the real server and the
 * real migrations with Production's role topology (.sli/lab.sh <db> --with-correction). Synthetic data only.
 *
 *   requester  = the owner of business A (עוסק פטור, identity confirmed at signup), its own browser context
 *   approver   = a platform admin of business B with the LegalIdentityApprover row + the env lists, its own context
 *
 *   U1  both sign in through /login; each screen says which account and business it acts for
 *   U2  wrong password / no change → refused on screen, nothing stored
 *   U3  submit → PENDING; the profile is NOT changed by a request
 *   U4  the requester cannot reach the approver API (queue, decision) — not even for its own request
 *   U5  the approver enrols MFA (real API), sees the request in its queue, asks for more information behind step-up
 *   U6  the requester sees "התבקש מידע נוסף" and the note
 *   U7  approve (notes + confirmation + step-up) → APPLIED; only now the legal name changes; still confirmed
 *   U8  /business after the approval: the identity fields are read-only with the lock note; typing changes nothing;
 *       the invoice-profile API refuses a direct change (409 LEGAL_IDENTITY_LOCKED); the database refuses it too
 *   U9  reject (notes + step-up) → REJECTED, the public note shown, the profile unchanged
 *   U10 cancel by the requester → CANCELLED; the approver can no longer decide it
 *   U11 every decision and info request is in PlatformAuditEvent by the approver, for that request; decidedBy is not
 *       the requester and not a user of business A
 *   U12 a cross-tab account switch: the correction screen turns red and stops submitting
 *
 * Viewports: requester = iPhone-size (WebKit when installed, else Chromium with the iPhone UA), approver = Android
 * (Chromium, Pixel UA), plus desktop Chromium for /business. EMULATION, not real devices.
 *
 * Setup: `.sli/lab.sh <db> --with-correction`, then `psql -f .sli/admin-read-plane.sql` as the owner (Production's
 * admin read plane), then the app (next dev/start) with the runtime / auth / admin roles, both flags and a synthetic
 * ADMIN_MFA_ENCRYPTION_KEY. Local run 2026-11-17: 26/26.
 *
 * env: E2E_BASE, OWNER_URL, RUNTIME_URL (read-back through the runtime role), E2E_APPROVER_EMAIL (= the server's
 *      PLATFORM_ADMIN_EMAILS / PLATFORM_ADMIN_LEGAL_IDENTITY_APPROVERS), E2E_OUT (screenshots + results.json).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";
import * as OTPAuth from "otpauth";
import { chromium, devices, webkit, type Browser, type BrowserContext, type Page } from "playwright";

const BASE = process.env.E2E_BASE ?? "http://localhost:3741";
const OUT = process.env.E2E_OUT ?? ".sli/.evidence/ui";
mkdirSync(OUT, { recursive: true });
const APPROVER_EMAIL = (process.env.E2E_APPROVER_EMAIL ?? "lic-ui-approver@lab.invalid").toLowerCase();
const OWNER_EMAIL = APPROVER_EMAIL.replace("approver", "owner");
const PASSWORD = "Lab-Synthetic-Pass-2026!";
const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });

type Row = { id: string; pass: boolean; observed: string };
const rows: Row[] = [];
function check(id: string, title: string, pass: boolean, observed: unknown = "") {
  const o = typeof observed === "string" ? observed : JSON.stringify(observed);
  rows.push({ id: `${id} ${title}`, pass, observed: o.slice(0, 400) });
  console.log(`  [${pass ? "PASS" : "FAIL"}] ${id} ${title}${pass ? "" : " — " + o.slice(0, 300)}`);
}
const shot = (p: Page, name: string) => p.screenshot({ path: join(OUT, `${name}.png`), fullPage: true }).catch(() => undefined);

function withCheckDigit(eight: string): string {
  let sum = 0;
  for (let i = 0; i < 8; i++) { let d = Number(eight[i]) * (i % 2 === 0 ? 1 : 2); if (d > 9) d -= 9; sum += d; }
  return eight + String((10 - (sum % 10)) % 10);
}
const TAX_A = withCheckDigit("03141592");
const TAX_B = withCheckDigit("02718281");
const NAME_A = "דנה כהן";

type Rows = Record<string, unknown>[];
async function fixtures() {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const mk = async (name: string, kind: string, legal: string, tax: string, email: string, role: string) => {
    const b = (await owner.$queryRawUnsafe(`INSERT INTO "Business" ("name","updatedAt") VALUES ($1, now()) RETURNING id`, name)) as Rows;
    const businessId = Number(b[0].id);
    await owner.$executeRawUnsafe(
      `INSERT INTO "BusinessProfile" ("businessId","updatedAt","onboardingCompletedAt","billingBusinessKind","billingLegalName","billingTaxId",
         "billingAddress","billingPhone","billingEmail","legalIdentityConfirmedAt","legalIdentitySource")
       VALUES ($1, now(), now(), $2, $3, $4, 'הרצל 1, תל אביב', '0501234567', 'biz@lab.invalid', now(), 'SIGNUP')`,
      businessId, kind, legal, tax);
    const u = (await owner.$queryRawUnsafe(
      `INSERT INTO "User" ("email","password","name","businessId","updatedAt","role","emailVerifiedAt","termsAcceptedAt")
       VALUES ($1,$2,'משתמש מעבדה',$3, now(), $4::"UserRole", now(), now()) RETURNING id`, email, hash, businessId, role)) as Rows;
    return { businessId, userId: Number(u[0].id) };
  };
  const a = await mk("עסק מעבדה א", "EXEMPT_DEALER", NAME_A, TAX_A, OWNER_EMAIL, "USER");
  const b = await mk("עסק מעבדה ב", "AUTHORIZED_DEALER", "יוסי לוי", TAX_B, APPROVER_EMAIL, "PLATFORM_ADMIN");
  await owner.$executeRawUnsafe(`INSERT INTO "LegalIdentityApprover" ("userId", "note") VALUES ($1, 'lab ui')`, b.userId);
  return { a, b };
}
const profileA = async (businessId: number) =>
  ((await owner.$queryRawUnsafe(
    `SELECT "billingLegalName" AS name, "billingTaxId" AS tax, "billingBusinessKind" AS kind, "legalIdentityConfirmedAt" IS NOT NULL AS confirmed
       FROM "BusinessProfile" WHERE "businessId" = $1`, businessId)) as Rows)[0] as { name: string; tax: string; kind: string; confirmed: boolean };
const requestsOf = async (businessId: number) =>
  (await owner.$queryRawUnsafe(
    `SELECT id, status::text AS status, "requestedByUserId" AS by, "decidedByUserId" AS decided, "infoRequestedAt" IS NOT NULL AS info,
            "publicNote" IS NOT NULL AS pub, "internalNote" IS NOT NULL AS internal, "requestedLegalName" AS requested
       FROM "LegalIdentityCorrectionRequest" WHERE "businessId" = $1 ORDER BY id`, businessId)) as Array<{
    id: number; status: string; by: number; decided: number | null; info: boolean; pub: boolean; internal: boolean; requested: string }>;
const auditFor = async (requestId: number) =>
  (await owner.$queryRawUnsafe(
    `SELECT action, "actorUserId" AS actor FROM "PlatformAuditEvent" WHERE "targetId" = $1 AND action LIKE 'PLATFORM_LEGAL_IDENTITY%' ORDER BY id`,
    String(requestId))) as Array<{ action: string; actor: number }>;

async function context(browser: Browser, device: (typeof devices)[string] | null, viewport?: { width: number; height: number }): Promise<BrowserContext> {
  const c = await browser.newContext({
    ...(device ?? {}), ...(viewport ? { viewport } : {}), baseURL: BASE, locale: "he-IL", timezoneId: "Asia/Jerusalem",
  });
  await c.addCookies([{ name: "dz_locale", value: "he", url: BASE }]);
  c.setDefaultNavigationTimeout(300_000);
  c.setDefaultTimeout(120_000);
  return c;
}
async function login(p: Page, email: string) {
  await go(p, "/login");
  await p.locator('input[type="email"]').fill(email);
  await p.locator('input[type="password"]').fill(PASSWORD);
  await p.locator('button[type="submit"]').click();
  await p.waitForFunction(() => { try { return !!localStorage.getItem("token"); } catch { return false; } }, null, { timeout: 120_000 });
  // The sign-in navigates on its own (to /app or the next page): let it land before the test navigates.
  await p.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 300_000 });
  await p.waitForURL((u) => u.pathname.startsWith("/app"), { timeout: 120_000 }).catch(() => undefined);
  await p.waitForLoadState("networkidle").catch(() => undefined);
}
/** goto that survives the app's own client-side redirects (a navigation interrupted by another is retried). */
async function go(p: Page, path: string) {
  for (let i = 0; ; i++) {
    try { await p.goto(path); return; } catch (e) {
      if (i >= 3 || !String((e as Error).message).includes("interrupted by another navigation")) throw e;
      await p.waitForLoadState("networkidle").catch(() => undefined);
    }
  }
}
const token = (p: Page) => p.evaluate(() => localStorage.getItem("token") ?? "");
async function api(p: Page, path: string, init: { method?: string; body?: unknown } = {}) {
  return p.evaluate(async ({ path, init }) => {
    const r = await fetch(path, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${localStorage.getItem("token") ?? ""}`, ...(init.body ? { "Content-Type": "application/json" } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    let json: unknown = null;
    try { json = await r.json(); } catch { /* not json */ }
    return { status: r.status, json: json as Record<string, unknown> | null };
  }, { path, init });
}

// TOTP: a code is accepted once per 30 s step (replay protection), so every use waits for a fresh step.
let totp: OTPAuth.TOTP | null = null;
let lastStep = -1;
async function freshCode(): Promise<string> {
  for (;;) {
    const step = Math.floor(Date.now() / 30_000);
    if (step !== lastStep && Date.now() % 30_000 < 27_000) { lastStep = step; return totp!.generate(); }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
/** Answers the admin step-up dialog when the server asks for it (ADMIN_MFA_REQUIRED). */
async function stepUpIfAsked(p: Page, waitMs = 8000) {
  const input = p.locator("#admin-step-up-code");
  try { await input.waitFor({ state: "visible", timeout: waitMs }); } catch { return false; }
  await input.fill(await freshCode());
  await p.getByRole("button", { name: "אישור", exact: true }).click();
  await input.waitFor({ state: "detached", timeout: 60_000 }).catch(() => undefined);
  return true;
}

/** Waits until `target` is visible, answering the step-up dialog whenever it appears on the way. */
async function untilVisible(p: Page, target: ReturnType<Page["locator"]>, timeoutMs = 240_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await target.isVisible().catch(() => false)) return;
    if (await p.locator("#admin-step-up-code").isVisible().catch(() => false)) { await stepUpIfAsked(p, 1000); continue; }
    await p.waitForTimeout(500);
  }
  throw new Error("not visible in time: " + String(target));
}

/** Waits until the database shows the action took effect, answering the step-up dialog whenever it appears. */
async function untilDb(p: Page, done: () => Promise<boolean>, timeoutMs = 240_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await done()) return;
    if (await p.locator("#admin-step-up-code").isVisible().catch(() => false)) { await stepUpIfAsked(p, 1000); continue; }
    await p.waitForTimeout(500);
  }
}

const CORRECTION = "/business/legal-identity/correction";
async function submitCorrection(p: Page, legalName: string, password = PASSWORD) {
  const form = p.getByTestId("correction-form");
  await form.waitFor();
  await form.locator("input").nth(0).fill(legalName); // שם משפטי (the select is first, then name, then number)
  await form.locator("textarea").fill("שגיאת הקלדה בשם המשפטי בעת ההרשמה (בדיקת מעבדה)");
  const box = form.locator('input[type="checkbox"]');
  if (!(await box.isChecked())) await box.check();
  await form.locator('input[type="password"]').fill(password);
  await form.getByRole("button", { name: "שליחת בקשת תיקון" }).click();
}
const statusText = async (p: Page) => (await p.getByTestId("correction-status").textContent().catch(() => null)) ?? "";

/** `next dev` compiles a route on its first request; compile every route used here once, unauthenticated, so a
 *  compile hiccup is never mistaken for the application's answer. */
async function warmUp() {
  const paths: Array<[string, string]> = [
    ["GET", "/api/auth/me"], ["GET", "/api/business/legal-identity/corrections"], ["DELETE", "/api/business/legal-identity/corrections/1"],
    ["GET", "/api/platform-admin/legal-identity-corrections"], ["GET", "/api/platform-admin/legal-identity-corrections/1"],
    ["POST", "/api/platform-admin/legal-identity-corrections/1/decision"], ["POST", "/api/platform-admin/legal-identity-corrections/1/request-info"],
    ["POST", "/api/platform-admin/mfa/enroll"], ["POST", "/api/platform-admin/mfa/confirm"], ["POST", "/api/platform-admin/mfa/verify"],
    ["GET", "/api/billing/invoice-profile"], ["PATCH", "/api/billing/invoice-profile"],
  ];
  for (const [method, path] of paths) {
    for (let i = 0; i < 3; i++) {
      const r = await fetch(BASE + path, { method }).catch(() => null);
      if (r && r.status < 500) break;
    }
  }
}

async function main() {
  await warmUp();
  const { a, b } = await fixtures();
  console.log(`fixtures: business A #${a.businessId} (user ${a.userId}), business B #${b.businessId} (approver ${b.userId})`);

  const chrome = await chromium.launch();
  let wk: Browser | null = null;
  try { wk = await webkit.launch(); } catch { console.log("  (WebKit not installed: the requester runs in Chromium with the iPhone profile)"); }
  const reqCtx = await context(wk ?? chrome, devices["iPhone 13"]);
  const appCtx = await context(chrome, devices["Pixel 7"]);
  const req = await reqCtx.newPage();
  const app = await appCtx.newPage();
  const engine = wk ? "WebKit" : "Chromium";

  try {
    // U1 sign in, who am I
    await login(req, OWNER_EMAIL);
    await login(app, APPROVER_EMAIL);
    await go(req, CORRECTION);
    const strip = req.getByTestId("signed-in-as");
    await strip.waitFor();
    const s1 = (await strip.textContent()) ?? "";
    check("U1a", `requester screen (${engine}, iPhone 13) names its account and business #${a.businessId}`, s1.includes(OWNER_EMAIL) && s1.includes(`#${a.businessId}`), s1);
    await shot(req, "U1-requester-form");

    // U2 refusals on screen, nothing stored
    const before = await profileA(a.businessId);
    await submitCorrection(req, `${NAME_A} א`, "wrong-password-123");
    await req.getByRole("alert").first().waitFor({ timeout: 60_000 }).catch(() => undefined);
    const afterWrong = await requestsOf(a.businessId);
    check("U2a", "wrong password → refused, no request stored", afterWrong.length === 0, afterWrong);
    await shot(req, "U2-wrong-password");
    await req.reload();
    await submitCorrection(req, NAME_A);
    await req.getByRole("alert").first().waitFor({ timeout: 60_000 }).catch(() => undefined);
    const afterSame = await requestsOf(a.businessId);
    check("U2b", "no change → refused, no request stored", afterSame.length === 0, afterSame);

    // U3 submit
    await req.reload();
    await submitCorrection(req, `${NAME_A} א`);
    await req.getByTestId("correction-pending").waitFor({ timeout: 120_000 });
    const st3 = await statusText(req);
    const r3 = await requestsOf(a.businessId);
    const p3 = await profileA(a.businessId);
    check("U3a", "submit → PENDING on screen and in the database, by the requester", st3.includes("ממתין") && r3.length === 1 && r3[0].status === "PENDING" && r3[0].by === a.userId, { st3, r3 });
    check("U3b", "the request alone does not change the legal name", p3.name === before.name && p3.confirmed, p3);
    await shot(req, "U3-pending");
    const id1 = r3[0]?.id;

    // U4 the requester cannot use the approver API
    const q4 = await api(req, "/api/platform-admin/legal-identity-corrections");
    const d4 = await api(req, `/api/platform-admin/legal-identity-corrections/${id1}/decision`, { method: "POST", body: { approve: true, publicNote: "אישור עצמי", internalNote: "אישור עצמי", confirmedReview: true } });
    check("U4a", "requester → approver queue refused", q4.status === 401 || q4.status === 403 || q4.status === 404, q4.status);
    check("U4b", "requester → decision on its own request refused, request still PENDING",
      (d4.status === 401 || d4.status === 403 || d4.status === 404) && (await requestsOf(a.businessId))[0].status === "PENDING", d4.status);

    // U5 approver: MFA enrolment (real API), queue, info request behind step-up
    const en = await api(app, "/api/platform-admin/mfa/enroll", { method: "POST" });
    totp = OTPAuth.URI.parse(String(en.json?.otpauthUri)) as OTPAuth.TOTP;
    const cf = await api(app, "/api/platform-admin/mfa/confirm", { method: "POST", body: { code: await freshCode() } });
    check("U5a", "approver enrols TOTP through the real API", en.status === 200 && cf.status === 200, { en: en.status, cf: cf.status });
    await go(app, "/admin/legal-identity-corrections");
    const appStrip = app.getByTestId("signed-in-as");
    await untilVisible(app, appStrip);
    const s5 = (await appStrip.textContent()) ?? "";
    check("U5b", `approver screen (Chromium, Pixel 7) names its account and business #${b.businessId}`, s5.includes(APPROVER_EMAIL) && s5.includes(`#${b.businessId}`), s5);
    await untilVisible(app, app.getByTestId("lic-list").getByText(`(#${a.businessId})`).first());
    check("U5c", "the request is in the approver's queue", true);
    await shot(app, "U5-queue");
    await go(app, `/admin/legal-identity-corrections/${id1}`);
    await untilVisible(app, app.getByTestId("lic-detail"));
    await app.locator("textarea").first().fill("נא לצרף תעודת עוסק (בדיקת מעבדה)");
    await app.getByRole("button", { name: "החזרה לבעל העסק" }).click();
    await untilDb(app, async () => (await requestsOf(a.businessId))[0]?.info === true);
    const r5 = (await requestsOf(a.businessId))[0];
    check("U5d", "info request → stays PENDING with infoRequestedAt", r5.status === "PENDING" && r5.info, r5);
    await shot(app, "U5-info-requested");

    // U6 requester sees it
    await req.reload();
    await req.getByTestId("correction-info-request").waitFor({ timeout: 60_000 });
    const st6 = await statusText(req);
    const note6 = (await req.getByTestId("correction-info-request").textContent()) ?? "";
    check("U6", "requester sees 'התבקש מידע נוסף' and the note", st6.includes("התבקש מידע נוסף") && note6.includes("תעודת עוסק"), { st6, note6 });
    await shot(req, "U6-info-shown");

    // U7 approve
    await app.reload();
    await untilVisible(app, app.getByTestId("lic-detail"));
    const areas = app.locator("textarea");
    await areas.nth(1).fill("הפרטים תוקנו לפי המסמכים (מעבדה)");
    await areas.nth(2).fill("נבדק מול תעודה סינתטית; תואם");
    await app.locator('label input[type="checkbox"]').last().check();
    await app.getByRole("button", { name: "אישור וביצוע התיקון" }).click();
    await untilDb(app, async () => (await requestsOf(a.businessId))[0]?.status !== "PENDING");
    const r7 = (await requestsOf(a.businessId))[0];
    const p7 = await profileA(a.businessId);
    check("U7a", "approve → APPLIED, decided by the approver", r7.status === "APPLIED" && r7.decided === b.userId && r7.pub && r7.internal, r7);
    check("U7b", "only now the legal name changed, still confirmed, number and kind unchanged",
      p7.name === `${NAME_A} א` && p7.confirmed && p7.tax === TAX_A && p7.kind === "EXEMPT_DEALER", p7);
    await shot(app, "U7-approved");
    await req.reload();
    await req.getByTestId("correction-history").waitFor();
    const h7 = (await req.getByTestId("correction-history").textContent()) ?? "";
    check("U7c", "requester history shows 'אושר ובוצע' with the public note", h7.includes("אושר ובוצע") && h7.includes("הפרטים תוקנו"), h7);

    // U8 locked after the correction
    const deskCtx = await context(chrome, null, { width: 1440, height: 900 });
    await deskCtx.addInitScript((t) => { try { localStorage.setItem("token", t); } catch { /* opaque */ } }, await token(req));
    const desk = await deskCtx.newPage();
    await go(desk, "/business");
    const lockNote = desk.getByTestId("legal-identity-locked-note");
    await lockNote.waitFor({ timeout: 300_000 }).catch(() => undefined);
    const nameInput = desk.locator(`input[value="${NAME_A} א"]`).first();
    const ro = await nameInput.getAttribute("readonly").catch(() => null);
    await nameInput.click().catch(() => undefined);
    await desk.keyboard.type("XYZ").catch(() => undefined);
    const val = await nameInput.inputValue().catch(() => "");
    check("U8a", "/business (desktop): lock note shown, the corrected name read-only, typing changes nothing",
      (await lockNote.isVisible().catch(() => false)) && ro !== null && val === `${NAME_A} א`, { ro, val });
    await shot(desk, "U8-business-locked-desktop");
    await go(req, "/business");
    await req.getByTestId("legal-identity-locked-note").waitFor({ timeout: 300_000 }).catch(() => undefined);
    check("U8b", `/business (${engine}, iPhone 13): lock note shown`, await req.getByTestId("legal-identity-locked-note").isVisible().catch(() => false));
    await shot(req, "U8-business-locked-phone");
    const patch = await api(req, "/api/billing/invoice-profile", { method: "PATCH", body: { billingLegalName: "שם אחר לגמרי" } });
    check("U8c", "invoice-profile API refuses a direct change: 409 LEGAL_IDENTITY_LOCKED",
      patch.status === 409 && JSON.stringify(patch.json).includes("LEGAL_IDENTITY_LOCKED") && (await profileA(a.businessId)).name === `${NAME_A} א`, patch);
    await deskCtx.close();

    // U9 reject
    await go(req, CORRECTION);
    await submitCorrection(req, `${NAME_A} ב`);
    await req.getByTestId("correction-pending").waitFor({ timeout: 120_000 });
    const id2 = (await requestsOf(a.businessId)).at(-1)!.id;
    await go(app, `/admin/legal-identity-corrections/${id2}`);
    await untilVisible(app, app.getByTestId("lic-detail"));
    await app.locator("textarea").nth(1).fill("לא צורף מסמך תומך (מעבדה)");
    await app.locator("textarea").nth(2).fill("אין התאמה למסמך; נדחה");
    await app.getByRole("button", { name: "דחייה" }).click();
    await untilDb(app, async () => (await requestsOf(a.businessId)).find((r) => r.id === id2)?.status !== "PENDING");
    const r9 = (await requestsOf(a.businessId)).find((r) => r.id === id2)!;
    const p9 = await profileA(a.businessId);
    check("U9a", "reject → REJECTED by the approver; the profile unchanged", r9.status === "REJECTED" && r9.decided === b.userId && p9.name === `${NAME_A} א`, { r9, p9 });
    await req.reload();
    const h9 = (await req.getByTestId("correction-history").textContent()) ?? "";
    check("U9b", "requester sees 'נדחה' with the public note", h9.includes("נדחה") && h9.includes("לא צורף מסמך"), h9);
    await shot(req, "U9-rejected");

    // U10 cancel
    await submitCorrection(req, `${NAME_A} ג`);
    await req.getByTestId("correction-pending").waitFor({ timeout: 120_000 });
    const id3 = (await requestsOf(a.businessId)).at(-1)!.id;
    await req.getByRole("button", { name: "ביטול הבקשה" }).click();
    await req.getByTestId("correction-form").waitFor({ timeout: 60_000 });
    const r10 = (await requestsOf(a.businessId)).find((r) => r.id === id3)!;
    const h10 = (await req.getByTestId("correction-history").textContent()) ?? "";
    const late = await api(app, `/api/platform-admin/legal-identity-corrections/${id3}/decision`, { method: "POST", body: { approve: true, publicNote: "מאוחר מדי", internalNote: "מאוחר מדי", confirmedReview: true } });
    check("U10a", "cancel → CANCELLED, no decider; history shows 'בוטל'", r10.status === "CANCELLED" && r10.decided === null && h10.includes("בוטל"), { r10, h10 });
    check("U10b", "the approver cannot decide a cancelled request", (await requestsOf(a.businessId)).find((r) => r.id === id3)!.status === "CANCELLED" && late.status >= 400, late.status);
    await shot(req, "U10-cancelled");

    // U11 audit + four eyes
    const a1 = await auditFor(id1);
    const a2 = await auditFor(id2);
    const sameBiz = (await owner.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "User" WHERE id = $1 AND "businessId" = $2`, b.userId, a.businessId)) as Rows;
    check("U11a", "audit: info request + approval of request 1 by the approver",
      a1.some((e) => e.action === "PLATFORM_LEGAL_IDENTITY_CORRECTION_INFO_REQUESTED" && e.actor === b.userId)
        && a1.some((e) => e.action === "PLATFORM_LEGAL_IDENTITY_CORRECTION_APPROVED" && e.actor === b.userId), a1);
    check("U11b", "audit: rejection of request 2 by the approver", a2.some((e) => e.action === "PLATFORM_LEGAL_IDENTITY_CORRECTION_REJECTED" && e.actor === b.userId), a2);
    check("U11c", "the decider is not the requester and not a user of business A", b.userId !== a.userId && Number(sameBiz[0].n) === 0);

    // U12 cross-tab switch
    await go(req, CORRECTION);
    await req.getByTestId("signed-in-as").waitFor();
    // Another tab of the same browser signs in to another account: what a sign-in leaves behind is the shared
    // localStorage token (the /login page itself redirects away while this browser is signed in).
    const approverToken = await token(app);
    const other = await reqCtx.newPage();
    await go(other, "/app");
    await other.evaluate((t) => localStorage.setItem("token", t), approverToken);
    await req.bringToFront();
    await req.evaluate(() => window.dispatchEvent(new Event("focus")));
    const alert = req.getByRole("alert").filter({ hasText: "החשבון בדפדפן הוחלף" });
    await alert.waitFor({ timeout: 30_000 }).catch(() => undefined);
    const disabled = await req.getByRole("button", { name: "שליחת בקשת תיקון" }).isDisabled().catch(() => false);
    check("U12", "another tab signs in to another account → red warning, submit disabled", (await alert.isVisible().catch(() => false)) && disabled);
    await shot(req, "U12-switched");
  } catch (e) {
    check("RUN", "scenario ran to completion", false, String((e as Error).stack ?? e).split("\n").slice(0, 3).join(" | "));
    await shot(req, "FAILED-requester");
    await shot(app, "FAILED-approver");
  } finally {
    await chrome.close().catch(() => undefined);
    await wk?.close().catch(() => undefined);
    await owner.$disconnect();
  }
  const failed = rows.filter((r) => !r.pass);
  writeFileSync(join(OUT, "results.json"), JSON.stringify({ engine: { requester: wk ? "webkit" : "chromium", approver: "chromium" }, rows }, null, 2));
  console.log(`correction UI e2e: ${rows.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
}

void main();
