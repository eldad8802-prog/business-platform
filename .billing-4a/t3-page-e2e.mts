/**
 * 4a T3 — the FULL document page in a production build (`next build` + `next start`) on an isolated lab database
 * (Production role topology, ephemeral PG17 in CI). Real login session (AuthSession + signed token), real routes, real
 * services. Screenshots of every step.
 *
 *   P1  exempt-era tax-invoice draft with a 0% line, after the transition: the page shows the notice + the button
 *   P2  issuing from the page (the real issue button + confirm dialog) is refused with the owner's wording; no number
 *   P3  the review lists every line with its VAT rate, the 0% line marked
 *   P4  the explicit confirmation → "reviewed"; one audit event bound to the document and the transition
 *   P5  issuing from the page now succeeds; the 0% line is kept
 *   P6  editing a line after a review brings the notice back (invalidated)
 *   P7  a business without a transition: the same draft page shows nothing new and issues as today
 *
 *   OWNER_URL=… AUTH_TOKEN_SECRET=<same as the server> E2E_BASE=http://localhost:3797 OUT=<dir> npx tsx .billing-4a/t3-page-e2e.mts
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BillingDocumentType, PrismaClient } from "@prisma/client";
import { chromium, type Browser, type Page } from "playwright";

import { signAuthToken } from "../lib/auth-token";

const BASE = process.env.E2E_BASE ?? "http://localhost:3797";
const OUT = process.env.OUT ?? "./.t3-page-out";
mkdirSync(OUT, { recursive: true });
const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
type Rows = Record<string, unknown>[];
let pass = 0;
const failures: string[] = [];
let current: Page | null = null;
async function check(name: string, fn: () => Promise<unknown>) {
  try { const r = await fn(); if (r === false) throw new Error("condition false"); pass++; console.log(`  [PASS] ${name}`); }
  catch (e) {
    failures.push(name); console.log(`  [FAIL] ${name} — ${e instanceof Error ? e.message.split("\n")[0].slice(0, 240) : String(e)}`);
    if (current) await current.screenshot({ path: join(OUT, `FAILED-${name.split(" ")[0]}.png`), fullPage: true }).catch(() => undefined);
  }
}
function withCheckDigit(eight: string): string {
  let sum = 0;
  for (let i = 0; i < 8; i++) { let d = Number(eight[i]) * (i % 2 === 0 ? 1 : 2); if (d > 9) d -= 9; sum += d; }
  return eight + String((10 - (sum % 10)) % 10);
}
let seq = 0;
async function business(kind: "EXEMPT_DEALER" | "AUTHORIZED_DEALER") {
  const n = ++seq;
  const taxId = withCheckDigit(String(36000000 + n * 7919).slice(0, 8));
  const b = (await owner.$queryRawUnsafe(`INSERT INTO "Business" ("name","updatedAt") VALUES ($1, now()) RETURNING id`, `העסק של דנה ${n}`)) as Rows;
  const businessId = Number(b[0].id);
  const email = `t3-page-${Date.now()}-${n}@lab.invalid`;
  const u = (await owner.$queryRawUnsafe(`INSERT INTO "User" ("email","password","name","businessId","updatedAt") VALUES ($1,$2,'דנה',$3, now()) RETURNING id`, email, "$2b$10$" + "A".repeat(53), businessId)) as Rows;
  const userId = Number(u[0].id);
  await owner.$queryRawUnsafe(`INSERT INTO "BusinessProfile" ("businessId","billingBusinessKind","billingLegalName","billingTaxId","billingVatNumber","billingAddress","billingPhone",
       "billingEmail","legalIdentityConfirmedAt","legalIdentitySource","updatedAt")
     VALUES ($1,$2,'דנה כהן',$3,$4,'הרצל 1, תל אביב','0501234567','biz@lab.invalid', now(), 'SIGNUP', now())`, businessId, kind, taxId, kind === "AUTHORIZED_DEALER" ? taxId : null);
  const priv = await owner.customer.create({ data: { businessId, name: "לקוח פרטי" } });
  const s = (await owner.$queryRawUnsafe(`INSERT INTO "AuthSession" ("userId","secretHash","tokenVersionAtIssue","createdAt","lastUsedAt","idleExpiresAt","absoluteExpiresAt")
     VALUES ($1,$2,0,now(),now(),now() + interval '1 day',now() + interval '30 days') RETURNING id`, userId, createHash("sha256").update(randomBytes(32)).digest("hex"))) as Rows;
  const sessionId = String(s[0].id);
  return { businessId, userId, taxId, privateId: priv.id, email, sessionId, token: signAuthToken(userId, 0, sessionId) };
}
type Biz = Awaited<ReturnType<typeof business>>;

async function openPage(browser: Browser, b: Biz, id: number, vp: { width: number; height: number }): Promise<Page> {
  const ctx = await browser.newContext({ viewport: vp, locale: "he-IL" });
  await ctx.addInitScript(([token, sid, user]) => {
    try { localStorage.setItem("token", token as string); localStorage.setItem("sessionId", sid as string); localStorage.setItem("user", user as string); } catch { /* ignore */ }
  }, [b.token, b.sessionId, JSON.stringify({ id: b.userId, businessId: b.businessId, businessName: "העסק של דנה", email: b.email })]);
  const p = await ctx.newPage();
  current = p;
  await p.goto(`${BASE}/billing/${id}`, { waitUntil: "networkidle", timeout: 180_000 });
  return p;
}
/** The draft's issue button (the primary "הפק…" action), then the confirm dialog's confirm button. */
async function issueFromPage(p: Page) {
  await p.getByRole("button", { name: /^הפק/ }).first().click();
  const dialog = p.getByRole("dialog");
  await dialog.waitFor({ timeout: 30_000 });
  await dialog.getByRole("button", { name: /הפק/ }).last().click();
}

async function main() {
  const { createBillingDraft } = await import("@/lib/services/billing/billing-draft.service");
  const { performKindTransition } = await import("@/lib/services/legal-identity/kind-transition.service");
  const { kindTransitionStatementSha256, israelToday } = await import("@/lib/legal-identity/kind-transition");
  const { replayRepositoryRls } = await import("../.tax-classification-lab/lab-kit.mts");
  await replayRepositoryRls(process.env.OWNER_URL!);
  const LINES = [{ description: "ייעוץ עסקי", quantity: "1", unitPrice: "500", vatRatePercent: "18" }, { description: "שירות ללקוח בחו״ל", quantity: "1", unitPrice: "300", vatRatePercent: "0" }];
  const draft = async (b: Biz) => (await createBillingDraft({ businessId: b.businessId, actorUserId: b.userId, documentType: BillingDocumentType.TAX_INVOICE, customerId: b.privateId, customerNameSnapshot: "לקוח פרטי", initialLines: LINES })).id;
  const status = async (id: number) => ((await owner.$queryRawUnsafe(`SELECT status::text s, "documentNumber" n FROM "BillingDocument" WHERE id=$1`, id)) as Rows)[0];

  const E = await business("EXEMPT_DEALER");
  const eDraft = await draft(E);
  const eEdit = await draft(E);
  const date = israelToday();
  const sha = kindTransitionStatementSha256({ businessId: E.businessId, actorUserId: E.userId, legalName: "דנה כהן", taxId: E.taxId, vatNumber: E.taxId, statusEffectiveDate: date });
  const tr = await performKindTransition(E.businessId, E.userId, { vatNumber: E.taxId, statusEffectiveDate: date, reauthMethod: "PASSWORD", reauthAt: new Date(), statementSha256: sha });
  console.log(`transition: ${tr}`);
  const A = await business("AUTHORIZED_DEALER");
  const aDraft = await draft(A);

  const browser = await chromium.launch();
  for (const vp of [{ name: "phone", width: 412, height: 915 }, { name: "desktop", width: 1280, height: 900 }]) {
    if (vp.name === "phone") {
      const p = await openPage(browser, E, eDraft, vp);
      await check("P1 the draft page shows the notice with the owner's wording and the button", async () => {
        await p.getByTestId("vat-review-required").waitFor({ timeout: 60_000 });
        await p.screenshot({ path: join(OUT, "P1-phone-notice.png"), fullPage: true });
        return (await p.getByTestId("vat-review-required").innerText()).includes("המסמך נוצר לפני המעבר שלך לעוסק מורשה")
          && (await p.getByTestId("vat-review-open").innerText()).trim() === "בדיקת מע״מ במסמך";
      });
      await check("P2 issuing from the page is refused with the owner's wording; no number", async () => {
        await issueFromPage(p);
        const alert = p.getByRole("dialog").getByRole("alert");
        await alert.waitFor({ timeout: 30_000 });
        await p.screenshot({ path: join(OUT, "P2-phone-issue-refused.png"), fullPage: true });
        const text = await alert.innerText();
        const d = await status(eDraft);
        await p.keyboard.press("Escape").catch(() => undefined);
        await p.getByRole("dialog").getByRole("button").first().click().catch(() => undefined);
        return text.includes("המסמך נוצר לפני המעבר שלך לעוסק מורשה") && d.s === "DRAFT" && d.n === null;
      });
      await check("P3 the review lists every line with its VAT rate, the 0% line marked", async () => {
        await p.reload({ waitUntil: "networkidle" });
        await p.getByTestId("vat-review-open").click();
        await p.getByTestId("vat-review-dialog").waitFor({ timeout: 30_000 });
        await p.screenshot({ path: join(OUT, "P3-phone-review.png"), fullPage: true });
        return (await p.locator('[data-testid="vat-review-dialog"] tr[data-zero="1"]').count()) === 1 && (await p.locator('[data-testid="vat-review-dialog"] tbody tr').count()) === 2;
      });
      await check("P4 the explicit confirmation → reviewed; one event bound to the document and the transition", async () => {
        await p.getByTestId("vat-review-confirm").click();
        await p.getByTestId("vat-review-done").waitFor({ timeout: 30_000 });
        await p.screenshot({ path: join(OUT, "P4-phone-reviewed.png"), fullPage: true });
        const ev = (await owner.$queryRawUnsafe(`SELECT count(*)::int n, max((metadata->>'transitionId')::int) t FROM "BillingAuditEvent" WHERE "billingDocumentId"=$1 AND "eventType"='BILLING_DRAFT_VAT_REVIEW_CONFIRMED'`, eDraft)) as Rows;
        const t = ((await owner.$queryRawUnsafe(`SELECT id FROM "BusinessKindTransition" WHERE "businessId"=$1`, E.businessId)) as Rows)[0].id;
        return ev[0].n === 1 && Number(ev[0].t) === Number(t);
      });
      await check("P5 issuing from the page now succeeds; the 0% line is kept", async () => {
        await issueFromPage(p);
        for (let i = 0; i < 60 && (await status(eDraft)).s !== "ISSUED"; i++) await p.waitForTimeout(500);
        await p.waitForTimeout(1500);
        await p.screenshot({ path: join(OUT, "P5-phone-issued.png"), fullPage: true });
        const zero = ((await owner.$queryRawUnsafe(`SELECT "vatRatePercent"::text v FROM "BillingDocumentLine" WHERE "billingDocumentId"=$1 ORDER BY "lineIndex"`, eDraft)) as Rows).map((r) => r.v);
        return (await status(eDraft)).s === "ISSUED" && zero[1] === "0.00";
      });
      await p.context().close();

      const q = await openPage(browser, E, eEdit, vp);
      await check("P6 a line edit after the review brings the notice back", async () => {
        await q.getByTestId("vat-review-open").click();
        await q.getByTestId("vat-review-confirm").click();
        await q.getByTestId("vat-review-done").waitFor({ timeout: 30_000 });
        // Edit through the page's own lines API (as the editor's save does), then reload.
        const res = await q.evaluate(async ([id, token]) => {
          const r = await fetch(`/api/billing/documents/${id}/lines`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ lines: [{ description: "ייעוץ עסקי", quantity: "1", unitPrice: "550", vatRatePercent: "18" }, { description: "שירות ללקוח בחו״ל", quantity: "1", unitPrice: "300", vatRatePercent: "0" }] }) });
          return r.status;
        }, [eEdit, E.token] as const);
        await q.reload({ waitUntil: "networkidle" });
        await q.getByTestId("vat-review-required").waitFor({ timeout: 30_000 });
        await q.screenshot({ path: join(OUT, "P6-phone-invalidated.png"), fullPage: true });
        return res >= 200 && res < 300;
      });
      await q.context().close();
    }
    const pa = await openPage(browser, A, aDraft, vp);
    await check(`P7 ${vp.name}: a business without a transition — nothing new on the page`, async () => {
      await pa.waitForTimeout(3000);
      await pa.screenshot({ path: join(OUT, `P7-${vp.name}-no-transition.png`), fullPage: true });
      return (await pa.getByTestId("vat-review-required").count()) === 0 && (await pa.getByTestId("vat-review-done").count()) === 0;
    });
    if (vp.name === "desktop") {
      await check("P7 …and its draft issues from the page as today", async () => {
        await issueFromPage(pa);
        for (let i = 0; i < 60 && (await status(aDraft)).s !== "ISSUED"; i++) await pa.waitForTimeout(500);
        await pa.screenshot({ path: join(OUT, "P7-desktop-issued.png"), fullPage: true });
        return (await status(aDraft)).s === "ISSUED";
      });
    }
    await pa.context().close();
  }
  await browser.close();
  console.log(`\nT3 page e2e: ${pass} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
  await owner.$disconnect();
}
main().catch(async (e) => { console.error(e); process.exitCode = 1; await owner.$disconnect(); });
