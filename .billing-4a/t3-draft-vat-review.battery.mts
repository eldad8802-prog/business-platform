/**
 * 4a T3 — drafts created before "מעבר לעוסק מורשה" with a 0% VAT line need the owner's explicit review before issuing
 * (or, for a quote, before it is finalized with a number). Production role topology (.billing-4a/lab.sh); every billing
 * call goes through the application's own services on the runtime connection (app_runtime_prod).
 *
 *   V1  a business without a transition: a 0% tax-invoice draft issues exactly as today; the state says not required
 *   V2  after the transition: an exempt-era tax-invoice draft with a 0% line → issuance refused (409
 *       DRAFT_VAT_REVIEW_REQUIRED, the owner's wording), no number, no counter row, the draft unchanged
 *   V3  not in scope: an exempt-era draft with no 0% line issues; a receipt issues; a draft created after the transition
 *       with a 0% line issues
 *   V4  the explicit review: one append-only BILLING_DRAFT_VAT_REVIEW_CONFIRMED event bound to the business, the
 *       document, the transition and the fingerprint; then the draft issues, still at 0% (nothing changed a rate)
 *   V5  any change after the review invalidates it (a price edit, a VAT-rate edit); a plain save never records a review;
 *       a confirmation with a stale fingerprint is refused and records nothing
 *   V6  QUOTE: an unnumbered exempt-era quote with a 0% line cannot be finalized (number + PDF) until reviewed; a quote
 *       already numbered before the transition is served unchanged
 *   V7  a new invoice converted after the transition from an exempt-era quote inherits the quote's age: refused until
 *       reviewed
 *   V8  a credit note for a document issued before the transition follows that document: never blocked
 *   V9  concurrency: parallel issuance attempts of an unreviewed draft all refused with no number; a review racing a
 *       line edit and an issuance never lets unreviewed content be issued
 *   V10 isolation: another business can neither read the review state nor confirm it (not found); events are scoped
 *
 * Synthetic only. ZERO secrets. ZERO network.
 */
import { BillingDocumentType, CustomerTaxIdType, PrismaClient } from "@prisma/client";

process.env.BILLING_AUTHORITY_RUNTIME_ENVIRONMENT = "PRODUCTION";
process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_BUSINESS_IDS = "9";
process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_USER_IDS = "9";
process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_OPERATIONS = "oauth";
let networkAttempts = 0;
globalThis.fetch = (async () => { networkAttempts++; throw new Error("network disabled in this lab"); }) as typeof fetch;

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail: unknown = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail !== "" ? " — " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : ""}`); }
}
const observed = (name: string, v: unknown) => console.log(`  [OBSERVED] ${name}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
type Rows = Record<string, unknown>[];
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim().slice(0, 300);
async function refusal(fn: () => Promise<unknown>): Promise<{ code: string | null; message: string } | null> {
  try { await fn(); return null; } catch (e) { return { code: (e as { code?: string }).code ?? null, message: msg(e) }; }
}
function withCheckDigit(eight: string): string {
  let sum = 0;
  for (let i = 0; i < 8; i++) { let d = Number(eight[i]) * (i % 2 === 0 ? 1 : 2); if (d > 9) d -= 9; sum += d; }
  return eight + String((10 - (sum % 10)) % 10);
}

async function main() {
  const { performKindTransition } = await import("@/lib/services/legal-identity/kind-transition.service");
  const { kindTransitionStatementSha256, israelToday } = await import("@/lib/legal-identity/kind-transition");
  const { issueBillingDocument } = await import("@/lib/services/billing/billing-issue.service");
  const { createBillingDraft, replaceBillingDraftLines } = await import("@/lib/services/billing/billing-draft.service");
  const { createReceiptDraft } = await import("@/lib/services/billing/receipt/billing-receipt-draft.service");
  const { createBillingCreditNoteDraft } = await import("@/lib/services/billing/billing-credit-reversal.service");
  const { convertQuoteToInvoice } = await import("@/lib/services/billing/convert-quote-to-invoice.service");
  const { getOrRenderQuotePdf } = await import("@/lib/services/billing/quote-pdf.service");
  const { readDraftVatReview, confirmDraftVatReview } = await import("@/lib/services/billing/kind-transition/draft-vat-review.service");
  const { DRAFT_VAT_REVIEW_MESSAGE } = await import("@/lib/services/billing/kind-transition/draft-vat-review");
  const { prisma: runtime } = await import("@/lib/prisma");

  const [who] = (await runtime.$queryRawUnsafe(`SELECT current_user::text who, r.rolsuper, r.rolbypassrls, pg_has_role(current_user,'app_runtime','member') m FROM pg_roles r WHERE r.rolname = current_user`)) as Rows;
  ok("P0 runtime = NOBYPASSRLS non-superuser member of app_runtime", !who.rolsuper && !who.rolbypassrls && who.m === true, who);
  const { replayRepositoryRls } = await import("../.tax-classification-lab/lab-kit.mts");
  ok("P0 replayed the repository's RLS statements", (await replayRepositoryRls(process.env.OWNER_URL!)) > 50);

  const stamp = Date.now();
  let n = 0;
  async function business(kind: "EXEMPT_DEALER" | "AUTHORIZED_DEALER", eight: string) {
    const taxId = withCheckDigit(eight);
    const b = (await owner.$queryRawUnsafe(`INSERT INTO "Business" ("name","updatedAt") VALUES ($1, now()) RETURNING id`, `t3-${stamp}-${++n}`)) as Rows;
    const businessId = Number(b[0].id);
    const u = (await owner.$queryRawUnsafe(`INSERT INTO "User" ("email","password","name","businessId","updatedAt") VALUES ($1,$2,'דנה',$3, now()) RETURNING id`,
      `t3-${stamp}-${n}@lab.invalid`, "$2b$10$" + "A".repeat(53), businessId)) as Rows;
    await owner.$queryRawUnsafe(`INSERT INTO "BusinessProfile" ("businessId","billingBusinessKind","billingLegalName","billingTaxId","billingVatNumber","billingAddress",
         "billingPhone","billingEmail","legalIdentityConfirmedAt","legalIdentitySource","updatedAt")
       VALUES ($1,$2,'דנה כהן',$3,$4,'הרצל 1, תל אביב','0501234567','b@lab.invalid', now(), 'SIGNUP', now())`, businessId, kind, taxId, kind === "AUTHORIZED_DEALER" ? taxId : null);
    const priv = await owner.customer.create({ data: { businessId, name: "לקוח פרטי" } });
    await owner.customer.create({ data: { businessId, name: "לקוח עוסק מורשה", taxId: "515000131", taxIdType: CustomerTaxIdType.AUTHORIZED_DEALER } });
    return { businessId, userId: Number(u[0].id), privateId: priv.id, taxId };
  }
  type Biz = Awaited<ReturnType<typeof business>>;
  const deps = { executeApproval: async (i: { billingDocumentId: number }) => ({ outcome: "completed_approved", billingDocumentId: i.billingDocumentId, submissionId: -1, allocationNumber: "123456789", safeToRetry: false }) } as never;
  const issue = (b: Biz, id: number) => issueBillingDocument({ businessId: b.businessId, billingDocumentId: id, actorUserId: b.userId }, deps);
  const ZERO = [{ description: "שירות", quantity: "1", unitPrice: "500", vatRatePercent: "18" }, { description: "שירות לחו״ל", quantity: "1", unitPrice: "300", vatRatePercent: "0" }];
  const ALL18 = [{ description: "שירות", quantity: "1", unitPrice: "500", vatRatePercent: "18" }];
  const draft = async (b: Biz, t: BillingDocumentType, lines = ZERO) =>
    (await createBillingDraft({ businessId: b.businessId, actorUserId: b.userId, documentType: t, customerId: b.privateId, customerNameSnapshot: "לקוח פרטי", initialLines: lines })).id;
  const doc = (id: number) => owner.billingDocument.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { lineIndex: "asc" } } } });
  const counter = async (b: Biz, t: string) => ((await owner.$queryRawUnsafe(`SELECT "nextNumber" n FROM "BillingDocumentNumberSequence" WHERE "businessId"=$1 AND "documentType"::text=$2`, b.businessId, t)) as Rows)[0]?.n ?? null;
  const events = async (id: number) => (await owner.$queryRawUnsafe(`SELECT "businessId" b, "billingDocumentId" d, "actorUserId" a, metadata m FROM "BillingAuditEvent" WHERE "billingDocumentId"=$1 AND "eventType"='BILLING_DRAFT_VAT_REVIEW_CONFIRMED' ORDER BY id`, id)) as Rows;
  const review = async (b: Biz, id: number) => {
    const s = await readDraftVatReview({ businessId: b.businessId, billingDocumentId: id });
    if (!s.required) return s;
    return confirmDraftVatReview({ businessId: b.businessId, actorUserId: b.userId, billingDocumentId: id, fingerprint: s.fingerprint });
  };

  // ================================================================== V1 no transition
  console.log("\n— V1 a business without a transition");
  const A = await business("AUTHORIZED_DEALER", "32000000");
  const a1 = await draft(A, BillingDocumentType.TAX_INVOICE);
  const aState = await readDraftVatReview({ businessId: A.businessId, billingDocumentId: a1 });
  ok("V1 state: not required (no transition)", aState.required === false && (aState as { reason?: string }).reason === "NO_TRANSITION", aState);
  await issue(A, a1);
  ok("V1 its 0% tax-invoice draft issues exactly as today (number 1)", (await doc(a1)).status === "ISSUED" && (await doc(a1)).documentNumber === 1);

  // ================================================================== exempt era
  const E = await business("EXEMPT_DEALER", "32000001");
  const eZero = await draft(E, BillingDocumentType.TAX_INVOICE);
  const eAll18 = await draft(E, BillingDocumentType.TAX_INVOICE, ALL18);
  const eEdit = await draft(E, BillingDocumentType.TAX_INVOICE);
  const eRate = await draft(E, BillingDocumentType.TAX_INVOICE);
  const eRace = await draft(E, BillingDocumentType.TAX_INVOICE);
  const eRace2 = await draft(E, BillingDocumentType.TAX_INVOICE);
  const eTir = await draft(E, BillingDocumentType.TAX_INVOICE_RECEIPT);
  const qOpen = await draft(E, BillingDocumentType.QUOTE);
  const qSent = await draft(E, BillingDocumentType.QUOTE);
  const qConv = await draft(E, BillingDocumentType.QUOTE);
  const rcpt = (await createReceiptDraft({ businessId: E.businessId, actorUserId: E.userId, documentType: BillingDocumentType.RECEIPT, customerId: E.privateId, currency: "ILS",
    paymentLines: [{ method: "CASH", amount: "50.00", paymentDate: new Date().toISOString() }] } as never)).id;
  // A historical tax invoice issued before the transition (seeded: an exempt dealer cannot issue one) and a credit note
  // draft for it created before the transition.
  const histInv = Number(((await owner.$queryRawUnsafe(
    `INSERT INTO "BillingDocument" ("businessId","documentType","status","issuedAt","documentNumber","documentNumberFormatted","customerId","customerNameSnapshot","subtotalAmount","vatAmount","totalAmount","currency","updatedAt")
     VALUES ($1,'TAX_INVOICE','DRAFT', NULL, NULL, NULL, $2, 'לקוח פרטי', 300, 0, 300, 'ILS', now()) RETURNING id`, E.businessId, E.privateId)) as Rows)[0].id);
  await owner.$queryRawUnsafe(`INSERT INTO "BillingDocumentLine" ("billingDocumentId","lineIndex","description","quantity","unitPrice","vatRatePercent","lineSubtotal","vatAmount","lineTotal","updatedAt")
     VALUES ($1,1,'שירות',1,300,0,300,0,300, now())`, histInv);
  // Lines first, then issued (DZ010 freezes an issued document's lines).
  await owner.$queryRawUnsafe(`UPDATE "BillingDocument" SET status='ISSUED', "issuedAt" = now() - interval '10 days', "documentNumber"=900, "documentNumberFormatted"='000900' WHERE id=$1`, histInv);
  const histCredit = (await createBillingCreditNoteDraft({ businessId: E.businessId, actorUserId: E.userId, sourceBillingDocumentId: histInv } as never)).id;
  // A quote finalized (numbered + PDF) before the transition.
  const sentPdf = await getOrRenderQuotePdf({ businessId: E.businessId, billingDocumentId: qSent, actorUserId: E.userId });
  const qSentNumber = (await doc(qSent)).documentNumber;
  ok("setup: a quote finalized before the transition has its number", qSentNumber !== null, qSentNumber);

  // ================================================================== the transition
  const date = israelToday();
  const sha = kindTransitionStatementSha256({ businessId: E.businessId, actorUserId: E.userId, legalName: "דנה כהן", taxId: E.taxId, vatNumber: E.taxId, statusEffectiveDate: date });
  ok("setup: performKindTransition → TRANSITIONED",
    (await performKindTransition(E.businessId, E.userId, { vatNumber: E.taxId, statusEffectiveDate: date, reauthMethod: "PASSWORD", reauthAt: new Date(), statementSha256: sha })) === "TRANSITIONED");

  // ================================================================== V2
  console.log("\n— V2 an exempt-era draft with a 0% line, after the transition");
  const before = await doc(eZero);
  const r2 = await refusal(() => issue(E, eZero));
  ok("V2 issuance refused: 409 DRAFT_VAT_REVIEW_REQUIRED with the owner's wording", r2?.code === "DRAFT_VAT_REVIEW_REQUIRED" && r2.message === DRAFT_VAT_REVIEW_MESSAGE, r2);
  const after = await doc(eZero);
  ok("V2 no number, still a draft, no TAX_INVOICE counter row", after.documentNumber === null && after.status === "DRAFT" && (await counter(E, "TAX_INVOICE")) === null);
  ok("V2 the draft is unchanged (lines, rates, amounts)", JSON.stringify(after.lines.map((l) => [l.vatRatePercent.toString(), l.unitPrice.toString()])) === JSON.stringify(before.lines.map((l) => [l.vatRatePercent.toString(), l.unitPrice.toString()]))
    && after.totalAmount.toString() === before.totalAmount.toString());
  const r2b = await refusal(() => issue(E, eTir));
  ok("V2 a TAX_INVOICE_RECEIPT draft of the exempt era is refused the same way", r2b?.code === "DRAFT_VAT_REVIEW_REQUIRED", r2b);
  const st = await readDraftVatReview({ businessId: E.businessId, billingDocumentId: eZero });
  ok("V2 state: required, not reviewed, the 0% line marked", st.required === true && st.reviewed === false && JSON.stringify(st.zeroRateLineIndexes) === "[2]", st);

  // ================================================================== V3
  console.log("\n— V3 not in scope");
  await issue(E, eAll18);
  ok("V3 an exempt-era draft with no 0% line issues", (await doc(eAll18)).status === "ISSUED");
  await issue(E, rcpt);
  ok("V3 a receipt issues", (await doc(rcpt)).status === "ISSUED");
  const fresh = await draft(E, BillingDocumentType.TAX_INVOICE);
  await issue(E, fresh);
  ok("V3 a draft created after the transition with a 0% line issues", (await doc(fresh)).status === "ISSUED");

  // ================================================================== V4
  console.log("\n— V4 the explicit review");
  const conf = await review(E, eZero);
  const ev = await events(eZero);
  observed("V4 event", ev);
  const tId = Number(((await owner.$queryRawUnsafe(`SELECT id FROM "BusinessKindTransition" WHERE "businessId"=$1`, E.businessId)) as Rows)[0].id);
  ok("V4 one event bound to the business, the document, the user, the transition and the fingerprint",
    ev.length === 1 && Number(ev[0].b) === E.businessId && Number(ev[0].d) === eZero && Number(ev[0].a) === E.userId
      && (ev[0].m as { transitionId: number }).transitionId === tId && (ev[0].m as { fingerprint: string }).fingerprint === (conf as { fingerprint: string }).fingerprint, ev);
  await issue(E, eZero);
  const issued = await doc(eZero);
  ok("V4 after the review the draft issues, the 0% line still 0% (no rate changed)", issued.status === "ISSUED" && issued.lines[1].vatRatePercent.toString() === "0");
  const again = await review(E, eZero);
  ok("V4 an issued document is never in review", again.required === false);
  const evUpd = await refusal(() => owner.$queryRawUnsafe(`UPDATE "BillingAuditEvent" SET summary='x' WHERE "billingDocumentId"=$1`, eZero));
  ok("V4 the review event is append-only", evUpd !== null, evUpd);

  // ================================================================== V5
  console.log("\n— V5 changes invalidate the review; a save is not a review; a stale confirmation records nothing");
  await review(E, eEdit);
  await replaceBillingDraftLines({ businessId: E.businessId, actorUserId: E.userId, billingDocumentId: eEdit,
    lines: [{ description: "שירות", quantity: "1", unitPrice: "520", vatRatePercent: "18" }, { description: "שירות לחו״ל", quantity: "1", unitPrice: "300", vatRatePercent: "0" }] });
  const r5 = await refusal(() => issue(E, eEdit));
  ok("V5 a price edit after the review → refused again", r5?.code === "DRAFT_VAT_REVIEW_REQUIRED", r5);
  const st5 = await readDraftVatReview({ businessId: E.businessId, billingDocumentId: eEdit });
  ok("V5 the save did not record a review (state: not reviewed, still one event)", st5.required && !st5.reviewed && (await events(eEdit)).length === 1);
  const s0 = await readDraftVatReview({ businessId: E.businessId, billingDocumentId: eRate });
  await replaceBillingDraftLines({ businessId: E.businessId, actorUserId: E.userId, billingDocumentId: eRate,
    lines: [{ description: "שירות", quantity: "1", unitPrice: "500", vatRatePercent: "18" }, { description: "שירות לחו״ל", quantity: "2", unitPrice: "300", vatRatePercent: "0" }] });
  const stale = await refusal(() => confirmDraftVatReview({ businessId: E.businessId, actorUserId: E.userId, billingDocumentId: eRate, fingerprint: (s0 as { fingerprint: string }).fingerprint }));
  ok("V5 a confirmation of content that changed meanwhile → 409 DRAFT_VAT_REVIEW_STALE, nothing recorded", stale?.code === "DRAFT_VAT_REVIEW_STALE" && (await events(eRate)).length === 0, stale);
  await replaceBillingDraftLines({ businessId: E.businessId, actorUserId: E.userId, billingDocumentId: eRate,
    lines: [{ description: "שירות", quantity: "1", unitPrice: "500", vatRatePercent: "18" }, { description: "שירות לחו״ל", quantity: "2", unitPrice: "300", vatRatePercent: "18" }] });
  await issue(E, eRate);
  ok("V5 changing the 0% line to 18% removes the need (no 0% line left) and the draft issues", (await doc(eRate)).status === "ISSUED");

  // ================================================================== V6 quotes
  console.log("\n— V6 quotes");
  const r6 = await refusal(() => getOrRenderQuotePdf({ businessId: E.businessId, billingDocumentId: qOpen, actorUserId: E.userId }));
  ok("V6 an exempt-era unnumbered quote with a 0% line cannot be finalized (refused, no number)", r6?.code === "DRAFT_VAT_REVIEW_REQUIRED" && (await doc(qOpen)).documentNumber === null, r6);
  await review(E, qOpen);
  await getOrRenderQuotePdf({ businessId: E.businessId, billingDocumentId: qOpen, actorUserId: E.userId });
  ok("V6 after the review it is finalized (numbered)", (await doc(qOpen)).documentNumber !== null);
  const sentAgain = await getOrRenderQuotePdf({ businessId: E.businessId, billingDocumentId: qSent, actorUserId: E.userId });
  const qSentDoc = await doc(qSent);
  ok("V6 a quote already finalized before the transition is not blocked: same number, its lines and rates unchanged, no review event",
    qSentDoc.documentNumber === qSentNumber && JSON.stringify(qSentDoc.lines.map((l) => l.vatRatePercent.toString())) === '["18","0"]' && (await events(qSent)).length === 0);
  // EXISTING behaviour, not T3: a quote's PDF is rendered from the LIVE business profile (quote-pdf-snapshot.ts reads
  // billingVatNumber etc.), so a re-download after the transition shows the new VAT number. Recorded, not asserted.
  observed("V6 already-sent quote PDF re-rendered from the live profile (existing behaviour)", { sameHash: sentAgain.pdfHash === sentPdf.pdfHash });

  // ================================================================== V7 conversion
  console.log("\n— V7 an invoice converted after the transition from an exempt-era quote");
  const conv = await convertQuoteToInvoice({ businessId: E.businessId, actorUserId: E.userId, quoteBillingDocumentId: qConv });
  const convDoc = await doc(conv.id);
  const convBkt = ((await owner.$queryRawUnsafe(`SELECT "confirmedAt" c FROM "BusinessKindTransition" WHERE "businessId"=$1`, E.businessId)) as Rows)[0].c as Date;
  ok("setup: the new invoice draft was created after the transition", convDoc.createdAt > new Date(convBkt));
  const r7 = await refusal(() => issue(E, conv.id));
  ok("V7 it inherits the quote's age: refused until reviewed", r7?.code === "DRAFT_VAT_REVIEW_REQUIRED", r7);
  await review(E, conv.id);
  await issue(E, conv.id);
  ok("V7 after the review it issues", (await doc(conv.id)).status === "ISSUED");

  // ================================================================== V8 credit for a historical document
  console.log("\n— V8 a credit note for a document issued before the transition");
  const cs = await readDraftVatReview({ businessId: E.businessId, billingDocumentId: histCredit });
  ok("V8 state: not required (credit for a historical document)", cs.required === false && (cs as { reason?: string }).reason === "CREDIT_FOR_HISTORICAL_DOCUMENT", cs);
  await issue(E, histCredit);
  const hc = await doc(histCredit);
  ok("V8 it issues following the original document (its 0% line kept)", hc.status === "ISSUED" && hc.lines.every((l) => l.vatRatePercent.toString() === "0"));

  // ================================================================== V9 concurrency
  console.log("\n— V9 concurrency");
  const par = await Promise.allSettled(Array.from({ length: 5 }, () => issue(E, eRace)));
  ok("V9 five parallel issuance attempts of an unreviewed draft: all refused, no number",
    par.every((p) => p.status === "rejected" && (p.reason as { code?: string }).code === "DRAFT_VAT_REVIEW_REQUIRED") && (await doc(eRace)).documentNumber === null,
    par.map((p) => (p.status === "rejected" ? (p.reason as { code?: string }).code : "issued")));
  const reviewedState = await review(E, eRace2);
  const reviewedLines = JSON.stringify((await doc(eRace2)).lines.map((l) => [l.description, l.quantity.toString(), l.unitPrice.toString(), l.vatRatePercent.toString()]));
  const race = await Promise.allSettled([
    replaceBillingDraftLines({ businessId: E.businessId, actorUserId: E.userId, billingDocumentId: eRace2,
      lines: [{ description: "שירות", quantity: "3", unitPrice: "500", vatRatePercent: "18" }, { description: "שירות לחו״ל", quantity: "1", unitPrice: "300", vatRatePercent: "0" }] }),
    issue(E, eRace2),
  ]);
  const raced = await doc(eRace2);
  observed("V9 race (edit ‖ issue) outcomes", race.map((p) => (p.status === "rejected" ? `rejected: ${(p.reason as { code?: string }).code ?? msg(p.reason)}` : "ok")));
  const issuedLines = JSON.stringify(raced.lines.map((l) => [l.description, l.quantity.toString(), l.unitPrice.toString(), l.vatRatePercent.toString()]));
  ok("V9 a line edit racing the issuance of a reviewed draft never issues unreviewed content",
    raced.status !== "ISSUED" || (issuedLines === reviewedLines && JSON.stringify(((raced.issuedSnapshot as { lines?: unknown[] })?.lines ?? []).length) === "2"), { status: raced.status, reviewed: (reviewedState as { fingerprint?: string }).fingerprint?.slice(0, 8) });

  // ================================================================== V10 isolation
  console.log("\n— V10 isolation");
  const O = await business("EXEMPT_DEALER", "32000002");
  const xRead = await refusal(() => readDraftVatReview({ businessId: O.businessId, billingDocumentId: eTir }));
  const xConf = await refusal(() => confirmDraftVatReview({ businessId: O.businessId, actorUserId: O.userId, billingDocumentId: eTir, fingerprint: "a".repeat(64) }));
  ok("V10 another business can neither read nor confirm the review (not found), and nothing is recorded",
    /not found/i.test(xRead?.message ?? "") && /not found/i.test(xConf?.message ?? "") && (await events(eTir)).length === 0, { xRead, xConf });

  ok("network: no fetch was attempted", networkAttempts === 0, networkAttempts);
  console.log(`\nT3 draft-vat-review battery: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log("FAILED:\n  " + failures.join("\n  ")); process.exitCode = 1; }
  await owner.$disconnect();
  await runtime.$disconnect();
}

main().catch(async (e) => { console.error(e); process.exitCode = 1; await owner.$disconnect(); });
