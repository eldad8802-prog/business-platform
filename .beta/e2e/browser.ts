/**
 * Closed beta — end-to-end on a running app (local lab: `next dev` on the migrated lab database with
 * BETA_COHORT_RESTRICTIONS=on, SIGNUP_ALLOWED_EMAILS and SIGNUP_INVITE_SECRET set, public signup closed).
 *
 *   A. closed signup: no code / wrong code / another tester's code → the closed gate; the real form with
 *      the personal link → account + enrollment
 *   B. API gates: beta → "בקרוב" refusals; the regular (pre-existing style) business → its usual answers
 *   C. issue: beta + qualifying tax invoice → 409 before anything is written; others → normal path
 *   D. screens × personas × viewports (390 / 820 / 1440): the expected copy, no horizontal scroll,
 *      screenshots to OUT_DIR
 *
 * env: BASE (http://localhost:3077), OWNER_URL (lab), SIGNUP_INVITE_SECRET, OUT_DIR, REGULAR_EMAIL.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { PrismaClient, Prisma, BillingDocumentType, CustomerTaxIdType } from "@prisma/client";
import { inviteCodeFor } from "@/lib/auth/signup-invite";

const BASE = process.env.BASE ?? "http://localhost:3077";
const OUT = process.env.OUT_DIR!;
const SECRET = process.env.SIGNUP_INVITE_SECRET!;
const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
fs.mkdirSync(OUT, { recursive: true });

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}

const BETA_EMAIL = "beta.tester@example.test";
const OTHER_BETA = "beta.two@example.test";
const PASSWORD = "E2e-Password-123";

async function api(method: string, p: string, token: string | null, body?: unknown, extra: Record<string, string> = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  let json: Record<string, unknown> = {};
  try { json = (await res.json()) as Record<string, unknown>; } catch { /* not json */ }
  return { status: res.status, json };
}

const signup = (email: string, invite?: string) =>
  api("POST", "/api/auth/register", null, {
    name: "בודקת בטא", businessName: "עסק בטא", email, password: PASSWORD, acceptTerms: true, ...(invite ? { invite } : {}),
  }, { "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 200) + 1}` });

async function main() {
  // ── A. closed signup ─────────────────────────────────────────────────────
  const code = inviteCodeFor(BETA_EMAIL, SECRET);
  const noCode = await signup(BETA_EMAIL);
  ok("A1 listed address WITHOUT a code → closed gate (403 SIGNUP_DISABLED)", noCode.status === 403 && noCode.json.code === "SIGNUP_DISABLED");
  const wrong = await signup(BETA_EMAIL, "A".repeat(22));
  ok("A2 wrong code → closed gate", wrong.status === 403 && wrong.json.code === "SIGNUP_DISABLED");
  const stolen = await signup(BETA_EMAIL, inviteCodeFor(OTHER_BETA, SECRET));
  ok("A3 another tester's code → closed gate", stolen.status === 403 && stolen.json.code === "SIGNUP_DISABLED");
  const unlisted = await signup("stranger@example.test", inviteCodeFor("stranger@example.test", SECRET));
  ok("A4 unlisted address even with a correctly computed code → closed gate", unlisted.status === 403);
  const plain = await fetch(`${BASE}/register`).then((r) => r.text());
  ok("A5 /register (no beta entry) shows the closed notice, no form", !plain.includes("reg-email"));

  const browser = await chromium.launch();
  let betaToken = "";
  let betaBusinessId = 0;
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "he-IL" });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/register?access=beta&invite=${code}`, { waitUntil: "networkidle" });
    await page.fill("#reg-name", "בודקת בטא");
    await page.fill("#reg-business", "עסק בטא");
    await page.fill("#reg-email", BETA_EMAIL);
    await page.fill("#reg-password", PASSWORD);
    await page.check("#reg-terms");
    await page.screenshot({ path: path.join(OUT, "signup-beta-390.png"), fullPage: true });
    await page.click("button[type=submit]");
    await page.waitForURL(/\/setup|\/app/, { timeout: 60_000 }).catch(() => undefined);
    betaToken = (await page.evaluate(() => localStorage.getItem("token"))) ?? "";
    const user = JSON.parse((await page.evaluate(() => localStorage.getItem("user"))) ?? "{}");
    betaBusinessId = Number(user.businessId ?? 0);
    ok("A6 the real form with the personal link opens the account", betaToken.length > 20 && betaBusinessId > 0, page.url());
    await ctx.close();
  }
  const enrolled = (await owner.$queryRawUnsafe(`SELECT cohort, source FROM "BusinessBetaEnrollment" WHERE "businessId" = $1`, betaBusinessId)) as { cohort: string; source: string }[];
  ok("A7 ...enrolled in the closed-beta cohort in the same transaction", enrolled[0]?.cohort === "closed-beta" && enrolled[0]?.source === "CLOSED_BETA_SIGNUP");
  const again = await signup(BETA_EMAIL, code);
  ok("A8 the same link cannot open a second account (closed gate, not 409)", again.status === 403);

  const login = await api("POST", "/api/auth/login", null, { email: process.env.REGULAR_EMAIL, password: PASSWORD });
  const regToken = String(login.json.token ?? "");
  ok("A9 the regular (pre-existing style) owner logs in as before", login.status === 200 && regToken.length > 20, JSON.stringify(login.json).slice(0, 120));
  const regBusinessId = Number((login.json.user as { businessId?: number } | undefined)?.businessId ?? 0);
  const regEnrolled = (await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "BusinessBetaEnrollment" WHERE "businessId" = $1`, regBusinessId)) as { c: number }[];
  ok("A10 the regular business is not enrolled", regEnrolled[0].c === 0);

  // ── B. API gates ─────────────────────────────────────────────────────────
  const ba = await api("GET", "/api/business/beta-access", betaToken);
  const ra = await api("GET", "/api/business/beta-access", regToken);
  const cs = (j: Record<string, unknown>) => j.comingSoon as Record<string, boolean>;
  ok("B1 beta-access: beta → all three coming soon", cs(ba.json)?.META_WHATSAPP && cs(ba.json)?.META_LEAD_ADS && cs(ba.json)?.TAX_AUTHORITY);
  ok("B2 beta-access: regular → nothing coming soon", !cs(ra.json)?.META_WHATSAPP && !cs(ra.json)?.META_LEAD_ADS && !cs(ra.json)?.TAX_AUTHORITY);
  const gates: Array<[string, string, string, unknown]> = [
    ["WhatsApp Embedded Signup", "POST", "/api/integrations/whatsapp/embedded-signup", {}],
    ["Meta lead ads pages", "POST", "/api/integrations/acquisition/meta/pages", { code: "x" }],
    ["Meta lead ads connect", "POST", "/api/integrations/acquisition/meta/connect", { handle: "x", pageId: "1" }],
    ["Tax Authority OAuth connect", "GET", "/api/taxes/oauth/connect", undefined],
  ];
  for (const [label, m, p, body] of gates) {
    const b = await api(m, p, betaToken, body, { accept: "application/json", "x-authority-connect-mode": "json" });
    const r = await api(m, p, regToken, body, { accept: "application/json", "x-authority-connect-mode": "json" });
    ok(`B3 ${label}: beta → 403 FEATURE_COMING_SOON`, b.status === 403 && b.json.code === "FEATURE_COMING_SOON", `${b.status} ${JSON.stringify(b.json).slice(0, 100)}`);
    ok(`B4 ${label}: regular → its usual answer (not the beta refusal) [${r.status}]`, r.json.code !== "FEATURE_COMING_SOON");
  }
  const st = await api("GET", "/api/taxes/authority/status", betaToken);
  ok("B5 Tax Authority status read stays open for beta", st.status === 200, String(st.status));
  const wa = await api("GET", "/api/integrations/whatsapp/connection", betaToken);
  ok("B6 WhatsApp connection status read stays open for beta", wa.status === 200, String(wa.status));
  const md = await api("DELETE", "/api/integrations/whatsapp/connection/meta-data", betaToken);
  ok("B7 Meta data deletion stays open for beta (not the beta refusal)", md.json.code !== "FEATURE_COMING_SOON", String(md.status));

  // ── C. issue ─────────────────────────────────────────────────────────────
  async function draft(businessId: number, subtotal: number, taxIdType: CustomerTaxIdType | null) {
    const customer = await owner.customer.create({
      data: { businessId, name: "לקוח עסקי", taxId: taxIdType ? "515555555" : null, taxIdType },
      select: { id: true },
    });
    const line = { lineIndex: 0, description: "שירות", quantity: new Prisma.Decimal(1), unitPrice: new Prisma.Decimal(subtotal), vatRatePercent: new Prisma.Decimal(18), lineSubtotal: new Prisma.Decimal(subtotal), vatAmount: new Prisma.Decimal(subtotal * 0.18), lineTotal: new Prisma.Decimal(subtotal * 1.18) };
    const doc = await owner.billingDocument.create({
      data: {
        businessId, documentType: BillingDocumentType.TAX_INVOICE, customerId: customer.id, customerNameSnapshot: "לקוח עסקי",
        currency: "ILS", subtotalAmount: new Prisma.Decimal(subtotal), vatAmount: new Prisma.Decimal(subtotal * 0.18),
        totalAmount: new Prisma.Decimal(subtotal * 1.18), lines: { create: [line] },
      } as never,
      select: { id: true },
    }).catch(async () => owner.billingDocument.create({
      data: {
        businessId, documentType: BillingDocumentType.TAX_INVOICE, customerId: customer.id, customerNameSnapshot: "לקוח עסקי",
        currency: "ILS", subtotalAmount: new Prisma.Decimal(subtotal), vatAmount: new Prisma.Decimal(subtotal * 0.18),
        totalAmount: new Prisma.Decimal(subtotal * 1.18),
      } as never,
      select: { id: true },
    }));
    return doc.id;
  }
  const bq = await draft(betaBusinessId, 8000, CustomerTaxIdType.AUTHORIZED_DEALER);
  const bs = await draft(betaBusinessId, 1000, CustomerTaxIdType.AUTHORIZED_DEALER);
  const rq = await draft(regBusinessId, 8000, CustomerTaxIdType.AUTHORIZED_DEALER);
  const i1 = await api("POST", `/api/billing/documents/${bq}/issue`, betaToken, {});
  ok("C1 beta + tax invoice needing an allocation → 409 BETA_ALLOCATION_COMING_SOON", i1.status === 409 && i1.json.code === "BETA_ALLOCATION_COMING_SOON", `${i1.status}`);
  const still = (await owner.$queryRawUnsafe(`SELECT status::text AS s, "documentNumber" AS n FROM "BillingDocument" WHERE id = $1`, bq)) as { s: string; n: unknown }[];
  ok("C2 ...and nothing was written: still a draft, no number consumed", still[0].s === "DRAFT" && (still[0].n === null || still[0].n === undefined), JSON.stringify(still[0]));
  const i2 = await api("POST", `/api/billing/documents/${bs}/issue`, betaToken, {});
  ok(`C3 beta + under the threshold → the normal issue path (not the beta refusal) [${i2.status}]`, i2.json.code !== "BETA_ALLOCATION_COMING_SOON");
  const i3 = await api("POST", `/api/billing/documents/${rq}/issue`, regToken, {});
  ok(`C4 regular + qualifying → the normal issue path (not the beta refusal) [${i3.status}]`, i3.json.code !== "BETA_ALLOCATION_COMING_SOON");

  // ── D. screens ───────────────────────────────────────────────────────────
  const VIEWPORTS: Array<[string, number, number]> = [["390", 390, 844], ["820", 820, 1180], ["1440", 1440, 900]];
  const SCREENS: Array<{ path: string; name: string; betaHas: string[]; regularLacks: string[] }> = [
    { path: "/settings/connections", name: "connections", betaHas: ["החיבור לרשות המסים ייפתח בקרוב", "חיבור WhatsApp Business ייפתח בקרוב"], regularLacks: ["ייפתח בקרוב"] },
    { path: "/settings/whatsapp", name: "whatsapp", betaHas: ["חיבור WhatsApp Business ייפתח בקרוב"], regularLacks: ["ייפתח בקרוב"] },
    { path: "/inbox", name: "inbox", betaHas: ["בינתיים אפשר לנהל כאן שיחות ידניות"], regularLacks: ["בינתיים אפשר לנהל כאן שיחות ידניות"] },
    { path: "/documents", name: "documents", betaHas: ["בקרוב"], regularLacks: [] },
    { path: "/app", name: "home", betaHas: [], regularLacks: ["WhatsApp — בקרוב"] },
    { path: `/billing/${bq}`, name: "billing-draft", betaHas: [], regularLacks: [] },
  ];
  async function visit(page: Page, p: string) {
    await page.goto(BASE + p, { waitUntil: "networkidle", timeout: 90_000 }).catch(() => undefined);
    await page.waitForTimeout(1500);
  }
  for (const [persona, token, userJson] of [
    ["beta", betaToken, { businessId: betaBusinessId }],
    ["regular", regToken, { businessId: regBusinessId }],
  ] as const) {
    for (const [vw, w, h] of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, locale: "he-IL" });
      await ctx.addInitScript(([t, u]) => {
        localStorage.setItem("token", t as string);
        localStorage.setItem("user", JSON.stringify(u));
      }, [token, userJson] as const);
      const page = await ctx.newPage();
      for (const s of SCREENS) {
        if (persona === "regular" && s.name === "billing-draft") continue;
        await visit(page, s.path);
        const text = await page.evaluate(() => document.body.innerText);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        await page.screenshot({ path: path.join(OUT, `${persona}-${s.name}-${vw}.png`), fullPage: true });
        if (persona === "beta") for (const t of s.betaHas) ok(`D ${persona} ${s.name} @${vw}: shows "${t}"`, text.includes(t));
        else for (const t of s.regularLacks) ok(`D ${persona} ${s.name} @${vw}: does not show "${t}"`, !text.includes(t));
        ok(`D ${persona} ${s.name} @${vw}: no horizontal scroll`, overflow <= 1, `overflow ${overflow}px`);
      }
      await ctx.close();
    }
  }
  await browser.close();
  console.log(`\nclosed beta E2E: ${pass} PASS, ${failures.length} FAIL`);
  await owner.$disconnect();
  if (failures.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
