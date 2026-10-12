/**
 * Account recovery — LOCAL browser E2E (Chromium via Playwright) against `next start` on :3571 and the
 * aet_e2e lab DB (127.0.0.1:55531). Email delivery is answered in-process by .aet-e2e/fake-resend.cjs
 * (outbox.jsonl); nothing leaves this machine.
 *
 *   PHASE=on  npx tsx .aet-e2e/e2e.ts   (server with both flags ON)
 *   PHASE=off npx tsx .aet-e2e/e2e.ts   (server restarted with both flags unset)
 * Synthetic data only.
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { PrismaClient } from "@prisma/client";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = "http://localhost:3571";
const PHASE = process.env.PHASE ?? "on";
const OWNER_URL = process.env.OWNER_URL!;
if (!/127\.0\.0\.1:55531\/aet_e2e/.test(OWNER_URL ?? "")) throw new Error("local lab OWNER_URL only");
const DIR = __dirname;
const SHOTS = join(DIR, "shots");
const OUTBOX = join(DIR, "outbox.jsonl");
const db = new PrismaClient({ datasourceUrl: OWNER_URL, log: ["error"] });
const RUN = Date.now().toString(36);
const PW = "Aet-e2e-synthetic-pw-1";
const NEW_PW = "Aet-e2e-synthetic-NEW-2";
const VERIFY_SUBJECT = "אימות כתובת האימייל שלך ב־Dubiz";
const RESET_SUBJECT = "בחירת סיסמה חדשה ל־Dubiz";
const USED = "כבר השתמשו בקישור";
const EXPIRED = "תוקף הקישור פג";

type Row = { id: string; vp: string; name: string; pass: boolean; evidence: string };
const rows: Row[] = [];
function rec(id: string, vp: string, name: string, pass: boolean, evidence: string) {
  rows.push({ id, vp, name, pass, evidence });
  console.log(`${pass ? "[PASS]" : "[FAIL]"} #${id} ${vp} ${name} — ${evidence}`);
}

let ipSeq = 1;
const IP_BASE = PHASE === "on" ? 31 : 41;
const nextIp = () => `10.${IP_BASE}.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;

type Mail = { fakeId: string; to: string[]; subject: string; text: string; html: string; idempotencyKey: string | null };
function outbox(): Mail[] {
  if (!existsSync(OUTBOX)) return [];
  return readFileSync(OUTBOX, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
const mailsTo = (addr: string, subject?: string) =>
  outbox().filter((m) => m.to?.includes(addr) && (subject === undefined || m.subject === subject));
async function waitMails(addr: string, subject: string, n: number, ms = 20000): Promise<Mail[]> {
  const t0 = Date.now();
  for (;;) {
    const m = mailsTo(addr, subject);
    if (m.length >= n || Date.now() - t0 > ms) return m;
    await new Promise((r) => setTimeout(r, 300));
  }
}
function linkOf(m: Mail | undefined, path: "verify-email" | "reset-password"): string | null {
  if (!m) return null;
  const re = new RegExp(`${BASE.replace(/[/.]/g, "\\$&")}/${path}#t=[0-9a-f-]{36}\\.[A-Za-z0-9_-]{43}`);
  return re.exec(m.text ?? "")?.[0] ?? null;
}
const tokenIdOf = (link: string) => link.split("#t=")[1].split(".")[0];

async function api(method: string, path: string, body?: unknown, opts: { token?: string; ip?: string } = {}) {
  const headers: Record<string, string> = { "x-forwarded-for": opts.ip ?? nextIp() };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: "manual" });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text };
}

async function settle(page: Page, ms = 1200) {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(ms);
}
const overflow = (page: Page) => page.evaluate(() => ({ sw: document.scrollingElement!.scrollWidth, iw: window.innerWidth }));
const ovs = (o: { sw: number; iw: number }) => `${o.sw}/${o.iw}`;
const ovOk = (o: { sw: number; iw: number }) => o.sw <= o.iw;

async function newCtx(browser: Browser, w: number, h: number): Promise<BrowserContext> {
  return browser.newContext({
    viewport: { width: w, height: h },
    locale: "he-IL",
    extraHTTPHeaders: { "x-forwarded-for": nextIp() },
    isMobile: w < 500,
    hasTouch: w < 1000,
  });
}

async function fillRegister(page: Page, v: { name: string; biz: string; email: string; pw: string }) {
  await page.locator('input[autocomplete="name"]').fill(v.name);
  await page.locator('input[autocomplete="organization"]').fill(v.biz);
  await page.locator('input[autocomplete="email"]').fill(v.email);
  await page.locator('input[autocomplete="new-password"]').fill(v.pw);
  await page.locator('form input[type="checkbox"]').first().check();
  await page.locator('form button[type="submit"]').first().click();
}
async function loginUi(page: Page, email: string, pw: string) {
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(pw);
  await page.locator('form button[type="submit"]').first().click();
}
async function signupUi(page: Page, email: string, tag: string) {
  const paths: string[] = [];
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) {
      const p = new URL(f.url()).pathname;
      if (paths[paths.length - 1] !== p) paths.push(p);
    }
  });
  await page.goto(`${BASE}/register`);
  await settle(page, 600);
  await fillRegister(page, { name: `דנה בדיקה ${tag}`, biz: `עסק שחזור ${tag} ${RUN}`, email, pw: PW });
  const setup = await page.waitForURL(/\/setup/, { timeout: 30000 }).then(() => true).catch(() => false);
  await settle(page, 800);
  if (setup) await page.getByRole("button", { name: "אמלא אחר כך" }).click();
  const app = await page.waitForURL(/\/app(\/|$|\?)/, { timeout: 30000 }).then(() => true).catch(() => false);
  return { setup, app, paths };
}
const cardText = (page: Page) => page.locator("main, body").first().innerText();

async function tokens(userId: number, purpose: string) {
  return db.$queryRawUnsafe<Array<{ id: string; createdAt: Date; expiresAt: Date; consumedAt: Date | null; invalidatedAt: Date | null; tokenHash: string; email: string }>>(
    `SELECT id::text, "createdAt", "expiresAt", "consumedAt", "invalidatedAt", "tokenHash", email FROM "AuthEmailToken" WHERE "userId"=$1 AND purpose=$2 ORDER BY "createdAt", id`,
    userId,
    purpose
  );
}
async function userRow(email: string) {
  const r = await db.$queryRawUnsafe<Array<{ id: number; businessId: number; password: string; tokenVersion: number; emailVerifiedAt: Date | null }>>(
    `SELECT id, "businessId", password, "tokenVersion", "emailVerifiedAt" FROM "User" WHERE email=$1`,
    email
  );
  return r[0];
}
async function sessions(userId: number) {
  return db.$queryRawUnsafe<Array<{ id: string; revokedAt: Date | null; revokedReason: string | null }>>(
    `SELECT id::text, "revokedAt", "revokedReason" FROM "AuthSession" WHERE "userId"=$1 ORDER BY "createdAt"`,
    userId
  );
}
const shot = (page: Page, name: string, fullPage = false) => page.screenshot({ path: join(SHOTS, name), fullPage });

const VPS = [
  { tag: "390", w: 390, h: 844 },
  { tag: "820", w: 820, h: 1180 },
  { tag: "1440", w: 1440, h: 900 },
] as const;

async function perViewport(browser: Browser, vp: (typeof VPS)[number]) {
  const V = `${vp.w}x${vp.h}`;
  const email = `aet-${vp.tag}-${RUN}@aet-e2e.test`;

  // ── 1 · signup ────────────────────────────────────────────────────────────────────────────
  const dev1 = await newCtx(browser, vp.w, vp.h);
  const p1 = await dev1.newPage();
  const su = await signupUi(p1, email, vp.tag);
  const u = await userRow(email);
  const verifyMails = await waitMails(email, VERIFY_SUBJECT, 1);
  const allToUser = mailsTo(email);
  const welcome = allToUser.filter((m) => m.subject !== VERIFY_SUBJECT);
  const vt = u ? await tokens(u.id, "EMAIL_VERIFY") : [];
  const te = u
    ? await db.$queryRawUnsafe<Array<{ kind: string; payload: any; status: string; providerMessageId: string | null }>>(
        `SELECT kind, payload, status, "providerMessageId" FROM "TransactionalEmail" WHERE "userId"=$1 ORDER BY id`,
        u.id
      )
    : [];
  const teVerify = te.filter((r) => r.kind === "EMAIL_VERIFY");
  const payloadKeys = teVerify[0] ? Object.keys(teVerify[0].payload).sort().join(",") : "none";
  rec(
    "1",
    V,
    "signup /register → /setup → /app; EMAIL_VERIFY + WELCOME in outbox; 1 token; payload tokenId+firstName",
    su.setup && su.app && !!u && verifyMails.length === 1 && welcome.length === 1 && vt.length === 1 && teVerify.length === 1 && payloadKeys === "firstName,tokenId",
    `nav=${su.paths.join("→")}; outbox to user: verify=${verifyMails.length} ("${verifyMails[0]?.subject}"), other=${welcome.map((m) => m.subject).join("|")}; AuthEmailToken EMAIL_VERIFY=${vt.length}; TE rows=${te.map((r) => `${r.kind}/${r.status}/${r.providerMessageId}`).join(",")}; EMAIL_VERIFY payload keys=${payloadKeys}`
  );

  // ── 2 · banner + resend ───────────────────────────────────────────────────────────────────
  await settle(p1, 1500);
  const banner = p1.getByTestId("verify-banner");
  const bannerShown = await banner.waitFor({ state: "visible", timeout: 15000 }).then(() => true).catch(() => false);
  const ovApp = await overflow(p1);
  await shot(p1, `app-banner-${vp.tag}.png`);
  await banner.getByRole("button", { name: "שליחה חוזרת" }).click().catch(() => undefined);
  const noteOk = await p1.getByText("שלחנו קישור אימות").first().waitFor({ timeout: 10000 }).then(() => true).catch(() => false);
  const verifyMails2 = await waitMails(email, VERIFY_SUBJECT, 2);
  const vt2 = u ? await tokens(u.id, "EMAIL_VERIFY") : [];
  const ovApp2 = await overflow(p1);
  await shot(p1, `app-banner-resent-${vp.tag}.png`);
  rec(
    "2",
    V,
    "/app verify banner; 'שליחה חוזרת' → new email, previous token SUPERSEDED; no h-overflow",
    bannerShown && noteOk && verifyMails2.length === 2 && vt2.length === 2 && !!vt2[0].invalidatedAt && !vt2[1].invalidatedAt && !vt2[1].consumedAt && ovOk(ovApp) && ovOk(ovApp2),
    `banner=${bannerShown}; note "שלחנו קישור אימות"=${noteOk}; verify mails=${verifyMails2.length}; tokens=${vt2.length} [0].invalidatedAt=${vt2[0]?.invalidatedAt?.toISOString() ?? null} [1].open=${!vt2[1]?.invalidatedAt && !vt2[1]?.consumedAt}; /app scrollWidth/innerWidth=${ovs(ovApp)} after=${ovs(ovApp2)}`
  );

  // ── 3 · verify link ───────────────────────────────────────────────────────────────────────
  const oldVerifyLink = linkOf(verifyMails2[0], "verify-email");
  const verifyLink = linkOf(verifyMails2[1], "verify-email");
  // superseded first link (extra evidence)
  const pS = await dev1.newPage();
  await pS.goto(oldVerifyLink ?? `${BASE}/verify-email`);
  const supFailed = await pS.getByTestId("verify-failed").waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
  const supText = supFailed ? await pS.getByTestId("verify-failed").innerText() : "";
  await pS.close();
  const pV = await dev1.newPage();
  await pV.goto(verifyLink ?? `${BASE}/verify-email`);
  const vDone = await pV.getByTestId("verify-done").waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
  const urlAfter = pV.url();
  const ovVerify = await overflow(pV);
  await shot(pV, `verify-done-${vp.tag}.png`);
  const uV = await userRow(email);
  await p1.goto(`${BASE}/app`);
  await settle(p1, 3000);
  const bannerGone = (await p1.getByTestId("verify-banner").count()) === 0;
  const pV2 = await dev1.newPage();
  await pV2.goto(verifyLink ?? `${BASE}/verify-email`);
  const vFailed = await pV2.getByTestId("verify-failed").waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
  const vFailedText = vFailed ? await pV2.getByTestId("verify-failed").innerText() : "";
  const ovVerify2 = await overflow(pV2);
  await shot(pV2, `verify-used-${vp.tag}.png`);
  await pV.close();
  await pV2.close();
  rec(
    "3",
    V,
    "verify link → verify-done, fragment removed, emailVerifiedAt set, banner gone; same link again → 'כבר השתמשו בקישור'",
    !!verifyLink && vDone && !urlAfter.includes("#") && !!uV?.emailVerifiedAt && bannerGone && vFailed && vFailedText.includes(USED),
    `link=${verifyLink ? "/verify-email#t=<id>.<secret>" : "MISSING"}; done=${vDone}; url after=${urlAfter}; emailVerifiedAt=${uV?.emailVerifiedAt?.toISOString() ?? null}; banner after reload present=${!bannerGone}; reuse → "${vFailedText}"; (superseded first link → "${supText}")`
  );

  // ── 6 prep: device 1 stays signed in ─────────────────────────────────────────────────────
  const dev1Token = await p1.evaluate(() => localStorage.getItem("token"));
  const meBefore = await p1.evaluate(async (t) => (await fetch("/api/auth/me", { headers: { authorization: `Bearer ${t}` } })).status, dev1Token);

  // ── 4 · forgot password (device 2) ───────────────────────────────────────────────────────
  const resetBefore = mailsTo(email, RESET_SUBJECT).length;
  const unknown = `nobody-${vp.tag}-${RUN}@aet-e2e.test`;
  const dev2 = await newCtx(browser, vp.w, vp.h);
  const p2 = await dev2.newPage();
  await p2.goto(`${BASE}/login`);
  await settle(p2, 800);
  const fl = p2.getByTestId("forgot-password-link");
  const flVisible = await fl.isVisible().catch(() => false);
  const flText = flVisible ? (await fl.innerText()).trim() : "";
  await shot(p2, `login-${vp.tag}.png`);
  if (flVisible) await fl.click();
  await p2.waitForURL(/\/forgot-password/, { timeout: 15000 }).catch(() => undefined);
  await settle(p2, 600);
  const forgotPath = new URL(p2.url()).pathname;
  const ovForgot = await overflow(p2);
  await shot(p2, `forgot-${vp.tag}.png`);
  await p2.locator("#forgot-email").fill(email);
  await p2.getByRole("button", { name: "שליחת קישור" }).click();
  const sent1 = await p2.getByTestId("forgot-sent").waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
  const text1 = sent1 ? await cardText(p2) : "";
  const ovSent = await overflow(p2);
  await shot(p2, `forgot-sent-${vp.tag}.png`);
  const p2b = await dev2.newPage();
  await p2b.goto(`${BASE}/forgot-password`);
  await settle(p2b, 600);
  await p2b.locator("#forgot-email").fill(unknown);
  await p2b.getByRole("button", { name: "שליחת קישור" }).click();
  const sent2 = await p2b.getByTestId("forgot-sent").waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
  const text2 = sent2 ? await cardText(p2b) : "";
  await shot(p2b, `forgot-sent-unknown-${vp.tag}.png`);
  await p2b.close();
  const resetMails = await waitMails(email, RESET_SUBJECT, resetBefore + 1);
  await new Promise((r) => setTimeout(r, 2500));
  const unknownMails = mailsTo(unknown);
  const resetMailsNow = mailsTo(email, RESET_SUBJECT);
  rec(
    "4",
    V,
    "/login 'שכחתי סיסמה' → /forgot-password; known + unknown → identical 'בדקו את תיבת המייל'; exactly 1 reset email, to the user",
    flVisible && flText === "שכחתי סיסמה" && forgotPath === "/forgot-password" && sent1 && sent2 && text1 === text2 && text1.includes("בדקו את תיבת המייל") && resetMailsNow.length - resetBefore === 1 && unknownMails.length === 0,
    `link "${flText}" → ${forgotPath}; known sent=${sent1}, unknown sent=${sent2}; texts identical=${text1 === text2}; new reset mails to user=${resetMailsNow.length - resetBefore} (waited ${resetMails.length}); mails to unknown=${unknownMails.length}; overflow forgot=${ovs(ovForgot)} sent=${ovs(ovSent)}`
  );

  // ── 5 · reset ────────────────────────────────────────────────────────────────────────────
  const resetLink = linkOf(resetMailsNow[resetMailsNow.length - 1], "reset-password");
  const pR = await dev2.newPage();
  await pR.goto(resetLink ?? `${BASE}/reset-password`);
  const formOk = await pR.locator("#reset-password").waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
  const resetUrl = pR.url();
  const ovReset = await overflow(pR);
  await shot(pR, `reset-form-${vp.tag}.png`);
  await pR.locator("#reset-password").fill(NEW_PW);
  await pR.locator("#reset-confirm").fill(NEW_PW + "x");
  await pR.getByRole("button", { name: "שמירת הסיסמה" }).click();
  const mismatch = await pR.getByText("הסיסמאות לא זהות").first().waitFor({ timeout: 5000 }).then(() => true).catch(() => false);
  await pR.locator("#reset-password").fill("short1");
  await pR.locator("#reset-confirm").fill("short1");
  await pR.getByRole("button", { name: "שמירת הסיסמה" }).click();
  const short = await pR.getByText("הסיסמה חייבת להכיל לפחות 8 תווים").first().waitFor({ timeout: 5000 }).then(() => true).catch(() => false);
  await shot(pR, `reset-errors-${vp.tag}.png`);
  const before5 = await userRow(email);
  await pR.locator("#reset-password").fill(NEW_PW);
  await pR.locator("#reset-confirm").fill(NEW_PW);
  await pR.getByRole("button", { name: "שמירת הסיסמה" }).click();
  const done = await pR.getByTestId("reset-done").waitFor({ timeout: 20000 }).then(() => true).catch(() => false);
  const ovDone = await overflow(pR);
  await shot(pR, `reset-done-${vp.tag}.png`);
  await pR.getByRole("link", { name: "לכניסה" }).click().catch(() => undefined);
  await pR.waitForURL(/\/login\?reset=done/, { timeout: 15000 }).catch(() => undefined);
  await settle(pR, 800);
  const loginUrl = pR.url();
  const notice = await pR.getByTestId("reset-done-notice").isVisible().catch(() => false);
  await shot(pR, `login-reset-notice-${vp.tag}.png`);
  await loginUi(pR, email, PW);
  const oldErr = await pR.getByText("האימייל או הסיסמה שגויים").first().waitFor({ timeout: 10000 }).then(() => true).catch(() => false);
  await shot(pR, `login-old-password-${vp.tag}.png`);
  await pR.locator('input[type="password"]').fill(NEW_PW);
  await pR.locator('form button[type="submit"]').first().click();
  const inApp = await pR.waitForURL(/\/app(\/|$|\?)/, { timeout: 30000 }).then(() => true).catch(() => false);
  const after5 = await userRow(email);
  rec(
    "5",
    V,
    "reset link → form (fragment removed); mismatch + short → Hebrew errors; done → 'לכניסה' → /login?reset=done notice; old pw refused, new pw → /app",
    !!resetLink && formOk && !resetUrl.includes("#") && mismatch && short && done && /\/login\?reset=done$/.test(loginUrl) && notice && oldErr && inApp &&
      before5.password !== after5.password && after5.tokenVersion === before5.tokenVersion + 1,
    `form=${formOk}; url=${resetUrl}; mismatch err=${mismatch}; short err=${short}; done=${done}; → ${new URL(loginUrl).pathname}${new URL(loginUrl).search}; notice=${notice}; old pw "האימייל או הסיסמה שגויים"=${oldErr}; new pw → /app=${inApp}; DB hash changed=${before5.password !== after5.password}; tokenVersion ${before5.tokenVersion}→${after5.tokenVersion}; overflow form=${ovs(ovReset)} done=${ovs(ovDone)}`
  );

  // ── 6 · second device dead ───────────────────────────────────────────────────────────────
  const meAfter = await p1.evaluate(async (t) => (await fetch("/api/auth/me", { headers: { authorization: `Bearer ${t}` } })).status, dev1Token);
  const refreshAfter = await p1.evaluate(async () => (await fetch("/api/auth/refresh", { method: "POST", credentials: "same-origin" })).status);
  await p1.goto(`${BASE}/app`);
  await p1.waitForURL(/\/login/, { timeout: 20000 }).catch(() => undefined);
  await settle(p1, 1000);
  const dev1End = new URL(p1.url()).pathname;
  await shot(p1, `device1-after-reset-${vp.tag}.png`);
  const ss = await sessions(u.id);
  const revokedByReset = ss.filter((s) => s.revokedReason === "password_reset").length;
  rec(
    "6",
    V,
    "device 1 (signed in before reset): /api/auth/me 401, refresh 401, /app → /login",
    meBefore === 200 && meAfter === 401 && refreshAfter === 401 && dev1End === "/login",
    `me before=${meBefore}, after=${meAfter}; refresh after=${refreshAfter}; /app ends at ${dev1End}; AuthSession revokedReason=password_reset: ${revokedByReset}/${ss.length}`
  );

  // ── 7 · used + expired links ─────────────────────────────────────────────────────────────
  const pU = await dev2.newPage();
  await pU.goto(resetLink ?? `${BASE}/reset-password`);
  const unusable = await pU.getByTestId("reset-unusable").waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
  const usedText = unusable ? await pU.getByTestId("reset-unusable").innerText() : "";
  const ovUnusable = await overflow(pU);
  await shot(pU, `reset-used-${vp.tag}.png`);
  await pU.close();
  const fr = await api("POST", "/api/auth/password/forgot", { email });
  const mailsE = await waitMails(email, RESET_SUBJECT, resetMailsNow.length + 1);
  const expLink = linkOf(mailsE[mailsE.length - 1], "reset-password");
  let expText = "";
  let expUpdated = 0;
  if (expLink) {
    expUpdated = await db.$executeRawUnsafe(
      `UPDATE "AuthEmailToken" SET "createdAt" = timezone('UTC', now()) - interval '2 hours', "expiresAt" = timezone('UTC', now()) - interval '1 hour' WHERE id = $1::uuid`,
      tokenIdOf(expLink)
    );
    const pE = await dev2.newPage();
    await pE.goto(expLink);
    const ex = await pE.getByTestId("reset-unusable").waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
    expText = ex ? await pE.getByTestId("reset-unusable").innerText() : "";
    await shot(pE, `reset-expired-${vp.tag}.png`);
    await pE.close();
  }
  rec(
    "7",
    V,
    "reused reset link → 'כבר השתמשו בקישור'; expired (owner SQL) → 'תוקף הקישור פג'",
    usedText.includes(USED) && fr.status === 200 && expUpdated === 1 && expText.includes(EXPIRED),
    `reuse → "${usedText}"; new forgot ${fr.status}, expiry rows updated=${expUpdated}; expired → "${expText}"; overflow unusable=${ovs(ovUnusable)}`
  );

  rec(
    "8",
    V,
    "no horizontal overflow on /forgot-password, /reset-password, /verify-email",
    [ovForgot, ovSent, ovReset, ovDone, ovUnusable, ovVerify, ovVerify2].every(ovOk),
    `forgot=${ovs(ovForgot)} sent=${ovs(ovSent)} reset form=${ovs(ovReset)} done=${ovs(ovDone)} unusable=${ovs(ovUnusable)} verify done=${ovs(ovVerify)} failed=${ovs(ovVerify2)}`
  );
  await dev1.close();
  await dev2.close();
  return { email, userId: u.id };
}

async function register(tag: string) {
  const email = `aet-${tag}-${RUN}@aet-e2e.test`;
  const r = await api("POST", "/api/auth/register", { name: `משתמש ${tag}`, businessName: `עסק ${tag} ${RUN}`, email, password: PW, acceptTerms: true });
  return { email, status: r.status, token: r.json?.token as string, userId: r.json?.userId as number, businessId: r.json?.businessId as number };
}

async function phaseOn(browser: Browser) {
  const state: any = { run: RUN, users: {} };
  for (const vp of VPS) state.users[vp.tag] = await perViewport(browser, vp);

  // ── 9 · tenant isolation ─────────────────────────────────────────────────────────────────
  {
    const A = await register("iso-a");
    const B = await register("iso-b");
    await waitMails(B.email, VERIFY_SUBJECT, 1);
    const bBefore = await userRow(B.email);
    const bSessBefore = await sessions(bBefore.id);
    const aBefore = await userRow(A.email);
    const f1 = await api("POST", "/api/auth/password/forgot", { email: A.email });
    const aMails = await waitMails(A.email, RESET_SUBJECT, 1);
    const aLink = linkOf(aMails[0], "reset-password")!;
    const r1 = await api("POST", "/api/auth/password/reset", { token: aLink.split("#t=")[1], password: NEW_PW });
    // B, signed in, posts a fresh link of A's with a password of B's choosing: it can only ever act on A.
    const f2 = await api("POST", "/api/auth/password/forgot", { email: A.email });
    const aMails2 = await waitMails(A.email, RESET_SUBJECT, 2);
    const aLink2 = linkOf(aMails2[1], "reset-password")!;
    const B_TRY = "B-chosen-password-9";
    const r2 = await api("POST", "/api/auth/password/reset", { token: aLink2.split("#t=")[1], password: B_TRY }, { token: B.token });
    const bAfter = await userRow(B.email);
    const bSessAfter = await sessions(bBefore.id);
    const aAfter = await userRow(A.email);
    const bLogin = await api("POST", "/api/auth/login", { email: B.email, password: PW });
    const bLoginWithBTry = await api("POST", "/api/auth/login", { email: B.email, password: B_TRY });
    const aLoginBTry = await api("POST", "/api/auth/login", { email: A.email, password: B_TRY });
    // resend verification for B → only B's address
    const before = outbox().length;
    const aVerifyBefore = mailsTo(A.email, VERIFY_SUBJECT).length;
    const rs = await api("POST", "/api/auth/email/resend", undefined, { token: bLogin.json?.token });
    await waitMails(B.email, VERIFY_SUBJECT, 2);
    await new Promise((r) => setTimeout(r, 2000));
    const newMails = outbox().slice(before);
    const sessUnchanged = JSON.stringify(bSessBefore) === JSON.stringify(bSessAfter.slice(0, bSessBefore.length)) && bSessBefore.every((s) => !s.revokedAt);
    rec(
      "9",
      "API",
      "tenant isolation: reset of A leaves B (hash, tokenVersion, sessions) untouched; B can't aim A's link at B; resend for B → only B",
      A.status === 200 && B.status === 200 && f1.status === 200 && r1.status === 200 && f2.status === 200 && r2.status === 200 &&
        bAfter.password === bBefore.password && bAfter.tokenVersion === bBefore.tokenVersion && sessUnchanged &&
        bLogin.status === 200 && bLoginWithBTry.status === 401 && aLoginBTry.status === 200 && aAfter.tokenVersion === aBefore.tokenVersion + 2 &&
        rs.status === 200 && newMails.length === 1 && newMails[0].to.length === 1 && newMails[0].to[0] === B.email && mailsTo(A.email, VERIFY_SUBJECT).length === aVerifyBefore,
      `register A/B=${A.status}/${B.status}; A reset=${r1.status}; B hash same=${bAfter.password === bBefore.password}, tokenVersion ${bBefore.tokenVersion}→${bAfter.tokenVersion}, B sessions unchanged/none revoked=${sessUnchanged} (${bSessBefore.length} before, ${bSessAfter.length} after incl. new logins); B login old pw=${bLogin.status}; B (bearer) posts A's 2nd link w/ B-chosen pw → ${r2.status}: B login with it=${bLoginWithBTry.status}, A login with it=${aLoginBTry.status}; A tokenVersion ${aBefore.tokenVersion}→${aAfter.tokenVersion}; B resend=${rs.status} → new mails=${newMails.length} to=${JSON.stringify(newMails.map((m) => m.to))}`
    );
  }

  // ── 10 · per-account login failure limit ────────────────────────────────────────────────
  {
    const X = await register("lim-x");
    const Y = await register("lim-y");
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) codes.push((await api("POST", "/api/auth/login", { email: X.email, password: `wrong-${i}-pw` })).status);
    const right = await api("POST", "/api/auth/login", { email: X.email, password: PW });
    const other = await api("POST", "/api/auth/login", { email: Y.email, password: PW });
    rec(
      "10",
      "API",
      "10 wrong passwords (10 different IPs) → correct password 429 Hebrew; other account logs in",
      codes.every((c) => c === 401) && right.status === 429 && right.json?.error === "יותר מדי ניסיונות. כדאי לחכות כמה דקות ולנסות שוב." && other.status === 200,
      `wrong=${codes.join(",")}; correct → ${right.status} "${right.json?.error}" (${right.json?.code}); other user → ${other.status}`
    );
  }

  // ── 11 · honeypot ────────────────────────────────────────────────────────────────────────
  {
    const email = `aet-honeypot-${RUN}@aet-e2e.test`;
    const [u0, b0] = await Promise.all([db.user.count(), db.business.count()]);
    const r = await api("POST", "/api/auth/register", { name: "בוט", businessName: `עסק בוט ${RUN}`, email, password: PW, acceptTerms: true, dz_confirm_field: "x" });
    const [u1, b1] = await Promise.all([db.user.count(), db.business.count()]);
    const byEmail = await db.user.count({ where: { email } });
    rec("11", "API", "honeypot dz_confirm_field='x' → 400 SIGNUP_REJECTED, no rows", r.status === 400 && r.json?.code === "SIGNUP_REJECTED" && u1 === u0 && b1 === b0 && byEmail === 0,
      `status=${r.status} code=${r.json?.code} "${r.json?.error}"; ΔUser=${u1 - u0} ΔBusiness=${b1 - b0}; user with that email=${byEmail}`);
  }

  state.outboxLinesAfterOn = outbox().length;
  writeFileSync(join(DIR, "state.json"), JSON.stringify(state, null, 2));
}

async function phaseOff(browser: Browser) {
  const state = JSON.parse(readFileSync(join(DIR, "state.json"), "utf8"));
  const outBefore = outbox();
  const ctx = await newCtx(browser, 390, 844);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await settle(page, 800);
  const forgotLink = await page.getByTestId("forgot-password-link").count();
  const forgotText = await page.getByText("שכחתי סיסמה").count();
  await shot(page, "off-login-390.png");
  await page.goto(`${BASE}/forgot-password`);
  await settle(page, 600);
  const unavailable = await page.getByText("האפשרות לבחור סיסמה חדשה דרך המייל עדיין לא זמינה.").isVisible().catch(() => false);
  const formPresent = await page.locator("#forgot-email").count();
  await shot(page, "off-forgot-390.png");
  const known = state.users["390"].email;
  const fp = await api("POST", "/api/auth/password/forgot", { email: known });
  const st = await api("GET", "/api/auth/email/status");
  // signup still works, no token
  const email = `aet-off-${RUN}@aet-e2e.test`;
  const su = await signupUi(page, email, "off");
  await settle(page, 3000);
  const bannerCount = await page.getByTestId("verify-banner").count();
  await shot(page, "off-app-390.png");
  const u = await userRow(email);
  const tok = u ? await db.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) n FROM "AuthEmailToken" WHERE "userId"=$1`, u.id) : [{ n: -1n }];
  const tokenStatus = await page.evaluate(async () => {
    const t = localStorage.getItem("token");
    const r = await fetch("/api/auth/email/status", { headers: { authorization: `Bearer ${t}` } });
    return { s: r.status, j: await r.json() };
  });
  const resend = await page.evaluate(async () => {
    const t = localStorage.getItem("token");
    return (await fetch("/api/auth/email/resend", { method: "POST", headers: { authorization: `Bearer ${t}` } })).status;
  });
  const login = await api("POST", "/api/auth/login", { email, password: PW });
  await new Promise((r) => setTimeout(r, 4000));
  const outAfter = outbox();
  const newMails = outAfter.slice(outBefore.length);
  const newLinkMails = newMails.filter((m) => m.subject === VERIFY_SUBJECT || m.subject === RESET_SUBJECT);
  rec(
    "12",
    "390x844 + API",
    "flags OFF: no 'שכחתי סיסמה'; /forgot-password 'not available'; forgot API 404; status {verificationEnabled:false}; no banner; signup works, 0 tokens; login works; no new reset/verify emails",
    forgotLink === 0 && forgotText === 0 && unavailable && formPresent === 0 && fp.status === 404 && st.status === 200 && st.json?.verificationEnabled === false &&
      su.setup && su.app && bannerCount === 0 && Number(tok[0].n) === 0 && tokenStatus.j?.verificationEnabled === false && login.status === 200 && newLinkMails.length === 0,
    `login forgot link=${forgotLink}, text=${forgotText}; forgot page unavailable card=${unavailable}, form=${formPresent}; POST forgot=${fp.status} ${fp.json?.code}; GET status (anon)=${st.status} ${st.text}; signed-in status=${JSON.stringify(tokenStatus.j)}; resend=${resend}; signup nav=${su.paths.join("→")}; banner=${bannerCount}; AuthEmailToken(user)=${tok[0].n}; login=${login.status}; new outbox mails=${newMails.length} (${newMails.map((m) => m.subject).join("|")}), of which verify/reset=${newLinkMails.length}`
  );
  await ctx.close();
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    if (PHASE === "on") await phaseOn(browser);
    else await phaseOff(browser);
  } finally {
    await browser.close();
    await db.$disconnect();
  }
  const file = join(DIR, `results-${PHASE}.json`);
  writeFileSync(file, JSON.stringify(rows, null, 2));
  const fails = rows.filter((r) => !r.pass);
  console.log(`\n${rows.length - fails.length}/${rows.length} PASS (${PHASE})`);
}
main().catch((e) => {
  console.error(e);
  writeFileSync(join(DIR, `results-${PHASE}.json`), JSON.stringify(rows, null, 2));
  process.exit(1);
});
