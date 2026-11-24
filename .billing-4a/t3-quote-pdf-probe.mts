/**
 * 4a T3 — probe of the EXISTING quote PDF behaviour (read + render only; no product code change).
 *   Q1  a business without a transition: download the same unchanged quote twice → same bytes? (cache / live render)
 *   Q2  an exempt business: finalize a quote (number + PDF), transition, download again → what changed in the issuer
 *       block the PDF prints (the snapshot the renderer receives), and are the number and the lines unchanged?
 *   OWNER_URL=… DATABASE_URL=… npx tsx .billing-4a/t3-quote-pdf-probe.mts
 */
import { BillingDocumentType, PrismaClient } from "@prisma/client";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
type Rows = Record<string, unknown>[];
function withCheckDigit(eight: string): string {
  let sum = 0;
  for (let i = 0; i < 8; i++) { let d = Number(eight[i]) * (i % 2 === 0 ? 1 : 2); if (d > 9) d -= 9; sum += d; }
  return eight + String((10 - (sum % 10)) % 10);
}
async function main() {
  const { createBillingDraft } = await import("@/lib/services/billing/billing-draft.service");
  const { getOrRenderQuotePdf, loadQuoteBusiness } = await import("@/lib/services/billing/quote-pdf.service");
  const { buildQuotePdfSnapshot } = await import("@/lib/services/billing/quote-pdf-snapshot");
  const { performKindTransition } = await import("@/lib/services/legal-identity/kind-transition.service");
  const { kindTransitionStatementSha256, israelToday } = await import("@/lib/legal-identity/kind-transition");
  const { replayRepositoryRls } = await import("../.tax-classification-lab/lab-kit.mts");
  await replayRepositoryRls(process.env.OWNER_URL!);
  let n = 0;
  async function business(kind: "EXEMPT_DEALER" | "AUTHORIZED_DEALER") {
    const taxId = withCheckDigit(String(37000000 + (++n)).slice(0, 8));
    const b = (await owner.$queryRawUnsafe(`INSERT INTO "Business" ("name","updatedAt") VALUES ($1, now()) RETURNING id`, `qprobe-${Date.now()}-${n}`)) as Rows;
    const businessId = Number(b[0].id);
    const u = (await owner.$queryRawUnsafe(`INSERT INTO "User" ("email","password","name","businessId","updatedAt") VALUES ($1,$2,'דנה',$3, now()) RETURNING id`, `qprobe-${Date.now()}-${n}@lab.invalid`, "$2b$10$" + "A".repeat(53), businessId)) as Rows;
    await owner.$queryRawUnsafe(`INSERT INTO "BusinessProfile" ("businessId","billingBusinessKind","billingLegalName","billingTaxId","billingVatNumber","billingAddress","billingPhone","billingEmail","legalIdentityConfirmedAt","legalIdentitySource","updatedAt")
       VALUES ($1,$2,'דנה כהן',$3,$4,'הרצל 1','0501234567','b@lab.invalid', now(), 'SIGNUP', now())`, businessId, kind, taxId, kind === "AUTHORIZED_DEALER" ? taxId : null);
    const priv = await owner.customer.create({ data: { businessId, name: "לקוח פרטי" } });
    return { businessId, userId: Number(u[0].id), privateId: priv.id, taxId };
  }
  const LINES = [{ description: "שירות", quantity: "1", unitPrice: "500", vatRatePercent: "0" }];
  const quote = async (b: Awaited<ReturnType<typeof business>>) => (await createBillingDraft({ businessId: b.businessId, actorUserId: b.userId, documentType: BillingDocumentType.QUOTE, customerId: b.privateId, customerNameSnapshot: "לקוח פרטי", initialLines: LINES })).id;
  const issuerSnapshot = async (b: Awaited<ReturnType<typeof business>>, id: number) => {
    const doc = await owner.billingDocument.findUniqueOrThrow({ where: { id }, include: { lines: true } });
    const biz = await loadQuoteBusiness(b.businessId);
    const s = buildQuotePdfSnapshot({ document: doc, lines: doc.lines, business: biz as never, customer: null, documentNumber: doc.documentNumber, documentNumberFormatted: doc.documentNumberFormatted, snapshotDate: new Date(), actorUserId: b.userId,
      totals: { subtotalAmount: doc.subtotalAmount, vatAmount: doc.vatAmount, totalAmount: doc.totalAmount } } as never) as unknown as { issuer: Record<string, unknown>; extensions?: Record<string, unknown> };
    return { issuer: s.issuer, extensions: s.extensions ?? null };
  };

  const A = await business("AUTHORIZED_DEALER");
  const qa = await quote(A);
  const a1 = await getOrRenderQuotePdf({ businessId: A.businessId, billingDocumentId: qa, actorUserId: A.userId });
  const a2 = await getOrRenderQuotePdf({ businessId: A.businessId, billingDocumentId: qa, actorUserId: A.userId });
  console.log("Q1 no transition, same quote downloaded twice:", JSON.stringify({ sameBytes: a1.pdfHash === a2.pdfHash, secondFromCache: a2.renderedNow === false, renderedNow: [a1.renderedNow, a2.renderedNow] }));

  const E = await business("EXEMPT_DEALER");
  const qe = await quote(E);
  const e1 = await getOrRenderQuotePdf({ businessId: E.businessId, billingDocumentId: qe, actorUserId: E.userId });
  const before = await issuerSnapshot(E, qe);
  const numBefore = (await owner.billingDocument.findUniqueOrThrow({ where: { id: qe } })).documentNumberFormatted;
  const date = israelToday();
  const sha = kindTransitionStatementSha256({ businessId: E.businessId, actorUserId: E.userId, legalName: "דנה כהן", taxId: E.taxId, vatNumber: E.taxId, statusEffectiveDate: date });
  await performKindTransition(E.businessId, E.userId, { vatNumber: E.taxId, statusEffectiveDate: date, reauthMethod: "PASSWORD", reauthAt: new Date(), statementSha256: sha });
  const e2 = await getOrRenderQuotePdf({ businessId: E.businessId, billingDocumentId: qe, actorUserId: E.userId });
  const after = await issuerSnapshot(E, qe);
  const doc = await owner.billingDocument.findUniqueOrThrow({ where: { id: qe }, include: { lines: true } });
  const diff = Object.keys({ ...before.issuer, ...after.issuer }).filter((k) => JSON.stringify(before.issuer[k]) !== JSON.stringify(after.issuer[k]));
  console.log("Q2 exempt quote finalized, then transition, then downloaded again:", JSON.stringify({
    sameBytes: e1.pdfHash === e2.pdfHash, renderedNow: [e1.renderedNow, e2.renderedNow], numberUnchanged: doc.documentNumberFormatted === numBefore,
    linesVat: doc.lines.map((l) => l.vatRatePercent.toString()), issuerFieldsThatChanged: diff,
    before: Object.fromEntries(diff.map((k) => [k, before.issuer[k]])), after: Object.fromEntries(diff.map((k) => [k, after.issuer[k]])),
    extensionsBefore: before.extensions, extensionsAfter: after.extensions }));
  await owner.$disconnect();
}
main().catch(async (e) => { console.error(e); process.exitCode = 1; await owner.$disconnect(); });
