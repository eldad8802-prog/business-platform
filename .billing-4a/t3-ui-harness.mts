/**
 * 4a T3 — screenshots of the draft VAT review: the real component, the real Hebrew messages, the real services on the
 * lab database (Production role topology). The full `next dev` page could not be compiled on this machine (out of
 * memory), so this harness bundles only the component (esbuild) and answers its /vat-review requests with
 * readDraftVatReview / confirmDraftVatReview; issuance is the real issueBillingDocument.
 *   OWNER_URL=… DATABASE_URL=… OUT=<dir> npx tsx .billing-4a/t3-ui-harness.mts
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { BillingDocumentType, PrismaClient } from "@prisma/client";
import { build } from "esbuild";
import { chromium } from "playwright";

const OUT = process.env.OUT ?? "./.t3-ui-out";
mkdirSync(OUT, { recursive: true });
const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
type Rows = Record<string, unknown>[];
let pass = 0;
const failures: string[] = [];
async function check(name: string, fn: () => Promise<unknown>) {
  try { const r = await fn(); if (r === false) throw new Error("condition false"); pass++; console.log(`  [PASS] ${name}`); }
  catch (e) { failures.push(name); console.log(`  [FAIL] ${name} — ${e instanceof Error ? e.message.split("\n")[0].slice(0, 240) : String(e)}`); }
}
function withCheckDigit(eight: string): string {
  let sum = 0;
  for (let i = 0; i < 8; i++) { let d = Number(eight[i]) * (i % 2 === 0 ? 1 : 2); if (d > 9) d -= 9; sum += d; }
  return eight + String((10 - (sum % 10)) % 10);
}

async function main() {
  const { createBillingDraft } = await import("@/lib/services/billing/billing-draft.service");
  const { issueBillingDocument } = await import("@/lib/services/billing/billing-issue.service");
  const { performKindTransition } = await import("@/lib/services/legal-identity/kind-transition.service");
  const { kindTransitionStatementSha256, israelToday } = await import("@/lib/legal-identity/kind-transition");
  const { readDraftVatReview, confirmDraftVatReview } = await import("@/lib/services/billing/kind-transition/draft-vat-review.service");
  const { replayRepositoryRls } = await import("../.tax-classification-lab/lab-kit.mts");
  await replayRepositoryRls(process.env.OWNER_URL!);

  async function business(kind: "EXEMPT_DEALER" | "AUTHORIZED_DEALER", eight: string) {
    const taxId = withCheckDigit(eight);
    const b = (await owner.$queryRawUnsafe(`INSERT INTO "Business" ("name","updatedAt") VALUES ($1, now()) RETURNING id`, `t3-ui-${Date.now()}`)) as Rows;
    const businessId = Number(b[0].id);
    const u = (await owner.$queryRawUnsafe(`INSERT INTO "User" ("email","password","name","businessId","updatedAt") VALUES ($1,$2,'דנה',$3, now()) RETURNING id`,
      `t3-ui-${Date.now()}-${eight}@lab.invalid`, "$2b$10$" + "A".repeat(53), businessId)) as Rows;
    await owner.$queryRawUnsafe(`INSERT INTO "BusinessProfile" ("businessId","billingBusinessKind","billingLegalName","billingTaxId","billingVatNumber","billingAddress","billingPhone","billingEmail","legalIdentityConfirmedAt","legalIdentitySource","updatedAt")
       VALUES ($1,$2,'דנה כהן',$3,$4,'הרצל 1, תל אביב','0501234567','b@lab.invalid', now(), 'SIGNUP', now())`, businessId, kind, taxId, kind === "AUTHORIZED_DEALER" ? taxId : null);
    const priv = await owner.customer.create({ data: { businessId, name: "לקוח פרטי" } });
    return { businessId, userId: Number(u[0].id), privateId: priv.id, taxId };
  }
  type Biz = Awaited<ReturnType<typeof business>>;
  const LINES = [{ description: "ייעוץ עסקי", quantity: "1", unitPrice: "500", vatRatePercent: "18" }, { description: "שירות ללקוח בחו״ל", quantity: "1", unitPrice: "300", vatRatePercent: "0" }];
  const mk = async (b: Biz) => (await createBillingDraft({ businessId: b.businessId, actorUserId: b.userId, documentType: BillingDocumentType.TAX_INVOICE, customerId: b.privateId, customerNameSnapshot: "לקוח פרטי", initialLines: LINES })).id;
  const E = await business("EXEMPT_DEALER", "34000001");
  const draft = await mk(E);
  const date = israelToday();
  const sha = kindTransitionStatementSha256({ businessId: E.businessId, actorUserId: E.userId, legalName: "דנה כהן", taxId: E.taxId, vatNumber: E.taxId, statusEffectiveDate: date });
  console.log("transition:", await performKindTransition(E.businessId, E.userId, { vatNumber: E.taxId, statusEffectiveDate: date, reauthMethod: "PASSWORD", reauthAt: new Date(), statementSha256: sha }));
  const A = await business("AUTHORIZED_DEALER", "34000002");
  const aDraft = await mk(A);
  const deps = { executeApproval: async (i: { billingDocumentId: number }) => ({ outcome: "completed_approved", billingDocumentId: i.billingDocumentId, submissionId: -1, allocationNumber: "123456789", safeToRetry: false }) } as never;

  const bundle = await build({
    entryPoints: [resolve(".billing-4a/t3-ui-harness/entry.tsx")], bundle: true, write: false, format: "iife", platform: "browser",
    jsx: "automatic", alias: { "@": resolve(".") }, define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error",
  });
  const js = bundle.outputFiles[0].text.replace(/<\/script/g, "<\\/script");
  const browser = await chromium.launch();
  for (const vp of [{ name: "mobile", width: 412, height: 860 }, { name: "desktop", width: 1280, height: 760 }]) {
    const open = async (biz: Biz, docId: number) => {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, locale: "he-IL" });
      const p = await ctx.newPage();
      await p.route("**/api/billing/documents/*/vat-review", async (route) => {
        const req = route.request();
        try {
          const body = req.method() === "POST"
            ? await confirmDraftVatReview({ businessId: biz.businessId, actorUserId: biz.userId, billingDocumentId: docId, fingerprint: (req.postDataJSON() as { fingerprint?: string })?.fingerprint })
            : await readDraftVatReview({ businessId: biz.businessId, billingDocumentId: docId });
          await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
        } catch (e) {
          await route.fulfill({ status: (e as { statusCode?: number }).statusCode ?? 500, contentType: "application/json", body: JSON.stringify({ error: (e as Error).message, code: (e as { code?: string }).code }) });
        }
      });
      const html = `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f2f1ec"><div id="root"></div><script>window.__DOC_ID=${docId}</script><script>${js}</script></body></html>`;
      await p.route("http://harness.local/", (r) => r.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }));
      await p.goto("http://harness.local/");
      return p;
    };
    if (vp.name === "mobile") {
      const p = await open(E, draft);
      await check("S1 the notice with the owner's wording and the button", async () => {
        await p.getByTestId("vat-review-required").waitFor({ timeout: 30_000 });
        await p.screenshot({ path: join(OUT, `S1-${vp.name}-notice.png`), fullPage: true });
        return (await p.getByTestId("vat-review-required").innerText()).includes("המסמך נוצר לפני המעבר שלך לעוסק מורשה") && (await p.getByTestId("vat-review-open").innerText()).trim() === "בדיקת מע״מ במסמך";
      });
      await check("S3 issuing before the review: refused by the real service (409 + the owner's wording), no number", async () => {
        let code = ""; let message = "";
        try { await issueBillingDocument({ businessId: E.businessId, billingDocumentId: draft, actorUserId: E.userId }, deps); } catch (e) { code = (e as { code?: string }).code ?? ""; message = (e as Error).message; }
        const d = ((await owner.$queryRawUnsafe(`SELECT status::text s, "documentNumber" n FROM "BillingDocument" WHERE id=$1`, draft)) as Rows)[0];
        console.log(`    refusal: ${code} — ${message}`);
        return code === "DRAFT_VAT_REVIEW_REQUIRED" && d.s === "DRAFT" && d.n === null;
      });
      await check("S2 the review: every line with its VAT rate, the 0% line marked", async () => {
        await p.getByTestId("vat-review-open").click();
        await p.getByTestId("vat-review-dialog").waitFor({ timeout: 30_000 });
        await p.screenshot({ path: join(OUT, `S2-${vp.name}-review.png`), fullPage: true });
        return (await p.locator('[data-testid="vat-review-dialog"] tr[data-zero="1"]').count()) === 1 && (await p.locator('[data-testid="vat-review-dialog"] tbody tr').count()) === 2;
      });
      await check("S4 after the explicit confirmation: reviewed, one audit event", async () => {
        await p.getByTestId("vat-review-confirm").click();
        await p.getByTestId("vat-review-done").waitFor({ timeout: 30_000 });
        await p.screenshot({ path: join(OUT, `S4-${vp.name}-reviewed.png`), fullPage: true });
        const ev = (await owner.$queryRawUnsafe(`SELECT count(*)::int n FROM "BillingAuditEvent" WHERE "billingDocumentId"=$1 AND "eventType"='BILLING_DRAFT_VAT_REVIEW_CONFIRMED'`, draft)) as Rows;
        return ev[0].n === 1;
      });
      await check("S5 then the real issuance succeeds (0% kept)", async () => {
        await issueBillingDocument({ businessId: E.businessId, billingDocumentId: draft, actorUserId: E.userId }, deps);
        const d = await owner.billingDocument.findUniqueOrThrow({ where: { id: draft }, include: { lines: { orderBy: { lineIndex: "asc" } } } });
        return d.status === "ISSUED" && d.lines[1].vatRatePercent.toString() === "0";
      });
      await p.context().close();
    }
    const pa = await open(A, aDraft);
    await check(`S6 ${vp.name}: a business without a transition — the panel renders nothing`, async () => {
      await pa.waitForTimeout(1500);
      await pa.screenshot({ path: join(OUT, `S6-${vp.name}-no-transition.png`), fullPage: true });
      return (await pa.getByTestId("vat-review-required").count()) === 0 && (await pa.getByTestId("vat-review-done").count()) === 0;
    });
    await pa.context().close();
  }
  await browser.close();
  console.log(`\nT3 UI harness: ${pass} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
  await owner.$disconnect();
}
main().catch(async (e) => { console.error(e); process.exitCode = 1; await owner.$disconnect(); });
