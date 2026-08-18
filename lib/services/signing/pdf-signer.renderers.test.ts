/**
 * Renderer-agnostic proof (Phase 2A). Run:
 *   npx tsx lib/services/signing/pdf-signer.renderers.test.ts
 *
 * Proves the signer signs + verifies PDFs from BOTH production PDF families:
 *   1. pdfmake-generated (legacy billing renderer)
 *   2. HTML/Chromium-generated (default billing renderer, via Playwright)
 *
 * The billing renderers are used ONLY to produce representative PDF fixtures — the
 * signer itself never imports Billing. Requires the Playwright chromium binary.
 */
import { BillingDocument, BillingDocumentLine, Prisma } from "@prisma/client";
import { buildIssuedSnapshot } from "@/lib/services/billing/billing-issue.service";
import type { BillingIssuedSnapshotV1 } from "@/lib/services/billing/pdf/billing-pdf-template";
import { renderBillingPdfFromSnapshot } from "@/lib/services/billing/pdf/billing-pdf-renderer";
import { renderBillingPdfHtmlFromSnapshot } from "@/lib/services/billing/pdf/billing-pdf-html-renderer";
import { signPdf } from "./pdf-signer.service";
import { verifySignedPdf } from "./pdf-signature-verify";
import { generateTestSigningMaterial } from "./__testutils__/test-signing-identity";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else { failed += 1; console.error(`FAIL: ${name}`, extra ?? ""); }
}

function fixtureSnapshot(): BillingIssuedSnapshotV1 {
  const document = {
    id: 1, documentType: "TAX_INVOICE", status: "ISSUED", currency: "ILS",
    referenceDocumentId: null, customerNameSnapshot: "לקוח בדיקה",
  } as unknown as BillingDocument;
  const lines = [
    {
      lineIndex: 0, description: "שירות בדיקה",
      quantity: new Prisma.Decimal("1"), unitPrice: new Prisma.Decimal("100"),
      vatRatePercent: new Prisma.Decimal("17"), lineSubtotal: new Prisma.Decimal("100"),
      vatAmount: new Prisma.Decimal("17"), lineTotal: new Prisma.Decimal("117"),
    } as unknown as BillingDocumentLine,
  ];
  const business = {
    id: 1, name: "Dubiz",
    profile: {
      billingLegalName: "דוביז בע\"מ", billingBusinessKind: "LTD_COMPANY",
      billingTaxId: "515000123", billingVatNumber: "515000123",
      billingPhone: null, billingEmail: null, billingAddress: null,
      billingPaymentNote: null, billingFooterNote: null,
      billingLogoDataUrl: null, billingSignatureDataUrl: null, billingPdfTemplateStyle: null,
    },
  };
  const snap = buildIssuedSnapshot({
    document, lines, business,
    customer: { id: 7, name: "לקוח בדיקה", phone: null, email: null, city: "תל אביב", taxId: "514000000" },
    documentNumber: 7, documentNumberFormatted: "000007",
    issuedAt: new Date("2026-06-15T10:00:00.000Z"), actorUserId: 1,
    totals: { subtotalAmount: new Prisma.Decimal("100"), vatAmount: new Prisma.Decimal("17"), totalAmount: new Prisma.Decimal("117") },
  });
  return snap as unknown as BillingIssuedSnapshotV1;
}

async function signVerify(label: string, pdf: Buffer): Promise<void> {
  ok(`${label}: renderer produced a valid PDF`, pdf.subarray(0, 5).toString() === "%PDF-", pdf.subarray(0, 8).toString());
  const material = generateTestSigningMaterial();
  const signed = await signPdf(pdf, material);
  const v = verifySignedPdf(signed.bytes);
  ok(`${label}: signed PDF has a signature dictionary`, signed.bytes.includes("/ByteRange") && (signed.bytes.includes("/Type /Sig") || signed.bytes.includes("/Type/Sig")));
  ok(`${label}: signature verifies (sha256/RSA, cert present)`, v.valid === true && v.digestAlgorithm === "sha256", v.reason);
  // tamper check on this family too
  const t = Buffer.from(signed.bytes);
  const [a, b] = v.byteRange!;
  const idx = a + Math.min(b - 1, 100);
  t[idx] = t[idx] ^ 0xff;
  ok(`${label}: tampering breaks verification`, verifySignedPdf(t).valid === false);
}

(async () => {
  const snap = fixtureSnapshot();

  // Family 1 — pdfmake
  const pdfmakePdf = await renderBillingPdfFromSnapshot(snap);
  await signVerify("pdfmake", pdfmakePdf);

  // Family 2 — HTML/Chromium
  const chromiumPdf = await renderBillingPdfHtmlFromSnapshot(snap);
  await signVerify("chromium", chromiumPdf);

  if (failed > 0) { console.error(`\n${failed} test(s) failed.`); process.exit(1); }
  console.log("\nBoth PDF renderer families sign + verify correctly.");
})().catch((e) => { console.error("TEST RUNNER ERROR:", (e as Error).stack || (e as Error).message); process.exit(1); });
