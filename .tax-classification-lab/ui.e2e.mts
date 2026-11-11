/**
 * PR-0 — the screens, in a real browser against `next dev` on a throwaway database (synthetic data only).
 * Covers only what the API battery cannot see: what the owner is offered and told on screen.
 *
 *   U1 exempt dealer: the billing list offers the tax-invoice action and no way to create a receipt
 *   U2 missing classification: creating an invoice opens the business-details form instead
 *   U3 licensed dealer, ≥5,000 ₪ to a dealer customer, submissions closed (Production pilot settings):
 *      the message after "הפק חשבונית" — and after a reload, whether the screen shows any allocation state
 *   U4 the same invoice: what the PDF action returns
 *
 * Verdicts use the same vocabulary as battery.mts (OK / DEFECT / OBSERVED). Screenshots + ui-results.json go to
 * $LAB_EVIDENCE_DIR/ui. env: E2E_BASE, OWNER_URL (fixtures), AUTH_TOKEN_SECRET (same as the server).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CustomerTaxIdType, PrismaClient } from "@prisma/client";
import { chromium, type Browser, type Page } from "playwright";

const BASE = process.env.E2E_BASE ?? "http://localhost:3730";
const OUT = join(process.env.LAB_EVIDENCE_DIR ?? ".tax-classification-lab/.evidence", "ui");
mkdirSync(OUT, { recursive: true });
const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });

/** The billing list's primary action — "+ צור חשבונית" (createInvoice), the tax-invoice create flow. */
const CREATE_INVOICE = 'button[data-dz-action="primary"]';

type Row = { id: string; verdict: string; via: "UI"; title: string; observed: string; matched: boolean };
const rows: Row[] = [];
function check(id: string, verdict: "OK" | "DEFECT" | "OBSERVED", title: string, holds: boolean, observed: unknown) {
  const obs = typeof observed === "string" ? observed : JSON.stringify(observed);
  rows.push({ id, verdict, via: "UI", title, observed: obs.slice(0, 600), matched: holds });
  console.log(`  [${holds ? "PASS" : "FAIL"}] ${id} ${verdict} (UI) ${title}${holds ? "" : " — observed: " + obs.slice(0, 300)}`);
}

async function tenant(key: string, kind: string | null) {
  const { signAuthToken } = await import("@/lib/auth-token");
  const stamp = Date.now();
  const b = await owner.business.create({ data: { name: `taxlab-ui-${key}-${stamp}` } });
  const u = await owner.user.create({ data: { email: `taxlab-ui-${key}-${stamp}@example.test`, password: "x", businessId: b.id, role: "USER" } });
  await owner.businessProfile.create({
    data: {
      businessId: b.id, onboardingCompletedAt: new Date(), billingLegalName: `עסק סינתטי ${key}`, billingBusinessKind: kind,
      billingTaxId: kind === "EXEMPT_DEALER" ? "000000018" : "999999998", billingVatNumber: kind === "AUTHORIZED_DEALER" ? "999999998" : null,
      billingAddress: "רחוב הבדיקה 1", billingPhone: "03-0000000", billingEmail: `taxlab-ui-${key}@example.test`,
    },
  });
  const dealer = await owner.customer.create({ data: { businessId: b.id, name: "לקוח עוסק מורשה סינתטי", taxId: "515000131", taxIdType: CustomerTaxIdType.AUTHORIZED_DEALER } });
  return { businessId: b.id, token: signAuthToken(u.id, u.tokenVersion), dealerId: dealer.id };
}

async function page(browser: Browser, token: string): Promise<Page> {
  const c = await browser.newContext({ baseURL: BASE, locale: "he-IL", timezoneId: "Asia/Jerusalem", viewport: { width: 1440, height: 900 } });
  await c.addCookies([{ name: "dz_locale", value: "he", url: BASE }]);
  await c.addInitScript((t) => { try { localStorage.setItem("token", t); } catch { /* opaque */ } }, token);
  // `next dev` compiles each route on first visit (over a minute on a cold runner).
  c.setDefaultNavigationTimeout(300_000);
  return c.newPage();
}
/** The billing list loads the business details before the create action is wired to them. */
async function billingListReady(p: Page) {
  await p.locator(CREATE_INVOICE).first().waitFor({ timeout: 300_000 });
  await p.getByText("טוען פרטי עסק").first().waitFor({ state: "detached", timeout: 120_000 }).catch(() => undefined);
  await p.waitForTimeout(1000);
}
const body = (p: Page) => p.evaluate(() => document.body.innerText);
const shot = (p: Page, name: string) => p.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });

/** One scenario: an exception is recorded as a mismatch (with a screenshot), never a silent hang. */
async function scenario(id: string, p: Page, fn: () => Promise<void>) {
  console.log(`— ${id}`);
  try {
    await fn();
  } catch (e) {
    await shot(p, `FAILED-${id}`).catch(() => undefined);
    check(id, "OK", "scenario ran to completion", false, String((e as Error).message).split("\n")[0]);
  } finally {
    await p.context().close().catch(() => undefined);
  }
}

async function main() {
  const E = await tenant("E", "EXEMPT_DEALER");
  const N = await tenant("N", null);
  const A = await tenant("A", "AUTHORIZED_DEALER");
  const browser = await chromium.launch();
  try {
    // U1 — exempt dealer's billing list
    const p1 = await page(browser, E.token);
    await scenario("U1", p1, async () => {
      await p1.goto("/billing");
      await billingListReady(p1);
      await shot(p1, "U1-exempt-billing-list");
      const label = (await p1.locator(CREATE_INVOICE).first().innerText()).trim();
      const text = await body(p1);
      check("U1.offer", "DEFECT", "exempt dealer is offered '+ צור חשבונית' (the tax-invoice flow) on the billing list", label.includes("צור חשבונית"), { label });
      check("U1.receipt", "OBSERVED", "the billing list offers no way to create a receipt", !/צור קבלה|קבלה חדשה|הפק קבלה/.test(text), text.slice(0, 400));
      // Was OBSERVED (the click opened 'יצירת טיוטת חשבונית', no word about the classification) — fixed by #1089.
      // Owner's bar: the notice is shown, the tax-invoice form stays closed, and NO draft is created (DB delta 0).
      const docsBefore = await owner.billingDocument.count({ where: { businessId: E.businessId } });
      await p1.locator(CREATE_INVOICE).first().click();
      const notice = p1.getByTestId("exempt-tax-invoice-notice");
      const form = p1.getByRole("dialog", { name: "יצירת טיוטת חשבונית" });
      await Promise.race([notice.waitFor({ timeout: 15_000 }), form.waitFor({ timeout: 15_000 })]).catch(() => undefined);
      await p1.waitForTimeout(1_000); // let any late request land before counting
      const noticeShown = await notice.isVisible().catch(() => false);
      const noticeText = noticeShown ? (await notice.innerText()).trim() : "";
      const noticeDialog = await p1.locator('[aria-labelledby="exempt-notice-title"]').count();
      const formOpen = await form.isVisible().catch(() => false);
      const docsAfter = await owner.billingDocument.count({ where: { businessId: E.businessId } });
      await shot(p1, "U1-exempt-create-invoice-clicked");
      check("U1.flow", "OK",
        "clicking it shows the exempt-dealer notice ('עוסק פטור אינו רשאי להפיק חשבונית מס'), the tax-invoice form stays closed, and no draft is created",
        noticeShown && noticeText.includes("עוסק פטור אינו רשאי להפיק חשבונית מס") && noticeDialog > 0 && !formOpen && docsAfter === docsBefore,
        { noticeShown, noticeText: noticeText.slice(0, 120), noticeDialog, formOpen, docsBefore, docsAfter });
    });

    // U2 — missing classification
    const p2 = await page(browser, N.token);
    await scenario("U2", p2, async () => {
      await p2.goto("/billing");
      await billingListReady(p2);
      await p2.locator(CREATE_INVOICE).first().click();
      await p2.waitForTimeout(2000);
      await shot(p2, "U2-missing-classification");
      const text = await body(p2);
      check("U2.gate", "OK", "missing classification: the business-details form (with the dealer-type choice) is shown instead of the draft flow", /עוסק פטור|עוסק מורשה/.test(text), text.slice(0, 500));
    });

    // U3/U4 — submissions closed: message, reload, PDF
    const res = await fetch(`${BASE}/api/billing/documents`, {
      method: "POST",
      headers: { Authorization: `Bearer ${A.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ documentType: "TAX_INVOICE", customerId: A.dealerId, initialLines: [{ description: "פרויקט", quantity: "1", unitPrice: "6000", vatRatePercent: "18" }] }),
    });
    const draftId = (await res.json()).document.id as number;
    const p3 = await page(browser, A.token);
    await scenario("U3", p3, async () => {
      await p3.goto(`/billing/${draftId}`);
      const issueBtn = p3.getByRole("button", { name: "הפק חשבונית" }).first();
      await issueBtn.waitFor({ timeout: 240_000 });
      await issueBtn.click();
      const dialog = p3.locator('[aria-labelledby="issue-confirm-title"]');
      await dialog.waitFor({ timeout: 30_000 });
      await shot(p3, "U3-issue-dialog");
      const issued = p3.waitForResponse((r) => r.url().endsWith(`/api/billing/documents/${draftId}/issue`) && r.request().method() === "POST", { timeout: 300_000 });
      await dialog.getByRole("button", { name: "הפק חשבונית" }).click();
      const issueResp = await issued;
      await p3.waitForTimeout(1500);
      await shot(p3, "U3-issue-refused");
      const msg = await body(p3);
      const row = await owner.billingDocument.findUniqueOrThrow({ where: { id: draftId }, select: { status: true, documentNumber: true } });
      check("U3.refused", "OK", "issuing is refused before numbering (409) and the dialog shows why; the document stays a draft without a number",
        issueResp.status() === 409 && /מספר הקצאה/.test(msg) && row.status === "DRAFT" && row.documentNumber === null,
        { status: issueResp.status(), doc: row, excerpt: msg.slice(0, 400) });
      check("U3.noretry", "OK", "nothing on screen offers to 'try again'", !/נסו שוב|לנסות שוב/.test(msg), msg.slice(0, 300));
      const alerts = await p3.locator('[role="alert"]').filter({ hasText: "מספר הקצאה" }).count();
      check("U3.a11y", "OK", "the refusal is announced to assistive technology (role=alert in the issue dialog)", alerts >= 1, alerts);
      await p3.reload();
      await p3.getByRole("button", { name: "הפק חשבונית" }).first().waitFor({ timeout: 300_000 });
      await shot(p3, "U3-after-reload");
      const reloaded = await body(p3);
      check("U3.reload", "OK", "after a reload it is still a draft (no 'מסמך הופק', no 'מוכן לשיתוף')", !/מסמך הופק/.test(reloaded) && !/מוכן לשיתוף/.test(reloaded), reloaded.slice(0, 300));
    });

    // U5 — an invoice that got stuck before the fix (issued, request READY, never sent), phone + desktop
    const legacyId = await (async () => {
      const r = await fetch(`${BASE}/api/billing/documents`, {
        method: "POST",
        headers: { Authorization: `Bearer ${A.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ documentType: "TAX_INVOICE", customerId: A.dealerId, initialLines: [{ description: "חשבונית תקועה", quantity: "1", unitPrice: "6000", vatRatePercent: "18" }] }),
      });
      const id = (await r.json()).document.id as number;
      // Issued the way it was before the gate: in this process, where sending is open, with the
      // Approval refused by the pilot — exactly the stuck state already present in old data.
      process.env.BILLING_AUTHORITY_RUNTIME_ENVIRONMENT = "SANDBOX";
      const { issueBillingDocument } = await import("@/lib/services/billing/billing-issue.service");
      const u = await owner.user.findFirstOrThrow({ where: { businessId: A.businessId }, select: { id: true } });
      await issueBillingDocument({ businessId: A.businessId, billingDocumentId: id, actorUserId: u.id }, {
        executeApproval: async (i: { billingDocumentId: number }) => ({ outcome: "preflight_failed", billingDocumentId: i.billingDocumentId, errorCode: "AUTHORITY_PRODUCTION_PILOT_NOT_ENABLED", safeToRetry: false }) as never,
      });
      return id;
    })();
    for (const size of [{ name: "desktop", width: 1440, height: 900 }, { name: "phone", width: 390, height: 844 }]) {
      const p5 = await page(browser, A.token);
      await p5.setViewportSize({ width: size.width, height: size.height });
      await scenario(`U5.${size.name}`, p5, async () => {
        await p5.goto(`/billing/${legacyId}`);
        await p5.getByText("מסמך הופק").first().waitFor({ timeout: 300_000 });
        await p5.waitForTimeout(2000);
        await shot(p5, `U5-stuck-invoice-${size.name}`);
        const text = await body(p5);
        const banner = await p5.locator('[role="status"][data-billing-authority-state="READY"]').count();
        check(`U5.${size.name}.state`, "OK", "a stuck invoice shows, after a fresh sign-in and load, that the allocation request was not sent and it cannot be delivered (banner role=status)",
          banner === 1 && /בקשת ההקצאה לא נשלחה/.test(text) && /לא ניתן כעת למסור/.test(text), { banner, excerpt: text.slice(0, 400) });
        check(`U5.${size.name}.noshare`, "OK", "no 'מוכן לשיתוף', no share button, no 'שיתוף המסמך'",
          !/מוכן לשיתוף/.test(text) && (await p5.getByRole("button", { name: /^שתף$/ }).count()) === 0 && !/שיתוף המסמך/.test(text), text.slice(0, 300));
        check(`U5.${size.name}.noretry`, "OK", "nothing on screen offers to 'try again'", !/נסו שוב|לנסות שוב/.test(text), "");
        if (size.name === "phone") {
          const overflow = await p5.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          check("U5.phone.noscroll", "OK", "phone 390: no side scroll", overflow <= 1, overflow);
        }
      });
    }
  } finally {
    await browser.close();
  }
  writeFileSync(join(OUT, "ui-results.json"), JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2));
  const bad = rows.filter((r) => !r.matched).length;
  console.log(`\nUI: ${rows.length} checks, mismatches ${bad}`);
  if (bad) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => owner.$disconnect());
