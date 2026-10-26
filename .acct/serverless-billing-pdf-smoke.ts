/**
 * Billing documents (tax invoice, receipt, tax invoice-receipt) rendered the way Vercel renders them:
 * @sparticuz/chromium launched through playwright-core by the shared launcher (lib/pdf/chromium.ts),
 * inside an Amazon Linux 2023 container, with no Playwright browser download present. No database, no
 * network, no storage — the real renderer (renderBillingPdfHtmlFromSnapshot) on synthetic snapshots.
 *
 * Each PDF must be a real A4 PDF with the Hebrew font embedded, and must sign + verify with the existing
 * signer (tampering must break it) — the signature pipeline is the same one Production uses.
 */
import { PDFDocument } from "pdf-lib";

import { chromiumMode } from "@/lib/pdf/chromium";
import { buildBillingInvoiceHtml } from "@/lib/services/billing/pdf/billing-pdf-html-template";
import { renderBillingPdfHtmlFromSnapshot } from "@/lib/services/billing/pdf/billing-pdf-html-renderer";
import type { BillingIssuedSnapshotV1 } from "@/lib/services/billing/pdf/billing-pdf-template";
import { generateTestSigningMaterial } from "@/lib/services/signing/__testutils__/test-signing-identity";
import { verifySignedPdf } from "@/lib/services/signing/pdf-signature-verify";
import { signPdf } from "@/lib/services/signing/pdf-signer.service";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}

const ALLOCATION = "20240718181618323199093572";

function snapshot(type: "TAX_INVOICE" | "RECEIPT" | "TAX_INVOICE_RECEIPT", n: number): BillingIssuedSnapshotV1 {
  return {
    schemaVersion: 1,
    issuedAt: "2026-09-15T10:00:00.000Z",
    document: { id: 40 + n, type, status: "ISSUED", number: n, numberFormatted: String(n).padStart(6, "0"), currency: "ILS", allocationNumber: type === "RECEIPT" ? null : ALLOCATION, referenceDocumentId: null },
    issuer: { id: 3, name: "דוביז", legalName: "דוביז בע\"מ", taxId: "515000123", vatRegistration: "515000123", address: "הרצל 1, תל אביב", phone: "03-0000000", email: null, logoUrl: null, bankDetails: null },
    customer: { id: 7, name: "מאפיית הלב", legalName: null, taxId: "514000000", phone: null, email: null, city: "חיפה", address: null },
    lines: [
      { lineIndex: 0, description: "שירות ייעוץ — ספטמבר", quantity: "1.0000", unitPrice: "1000.0000", vatRatePercent: "18.00", lineSubtotal: "1000.00", vatAmount: "180.00", lineTotal: "1180.00" },
      { lineIndex: 1, description: "Office Depot ישראל — ציוד", quantity: "2.0000", unitPrice: "50.0000", vatRatePercent: "18.00", lineSubtotal: "100.00", vatAmount: "18.00", lineTotal: "118.00" },
    ],
    totals: { subtotal: "1100.00", vat: "198.00", total: "1298.00", ...(type === "RECEIPT" ? { unapplied: "0.00" } : {}) },
    tax: { currency: "ILS", defaultVatRate: null, vatMode: "EXCLUSIVE" },
    metadata: { locale: "he-IL", timezone: "Asia/Jerusalem", actorUserId: 1, source: "manual" },
    pdfTemplateStyle: "CLASSIC",
    extensions: {},
  } as unknown as BillingIssuedSnapshotV1;
}

async function main() {
  ok("the job runs as a serverless function would (mode detection)", chromiumMode() === "serverless", chromiumMode());

  const types = ["TAX_INVOICE", "RECEIPT", "TAX_INVOICE_RECEIPT"] as const;
  for (const [i, type] of types.entries()) {
    const snap = snapshot(type, i + 7);
    const html = buildBillingInvoiceHtml(snap, "");
    ok(`${type}: the document number is in the document`, html.includes(snap.document.numberFormatted));
    if (snap.document.allocationNumber) ok(`${type}: the allocation number is in the document`, html.includes(ALLOCATION));

    const t0 = Date.now();
    const pdf = await renderBillingPdfHtmlFromSnapshot(snap);
    const ms = Date.now() - t0;
    console.log(`  [INFO] ${type}: ${chromiumMode()} render took ${ms} ms, ${pdf.length} bytes`);
    ok(`${type}: a real PDF is produced`, pdf.subarray(0, 5).toString("latin1") === "%PDF-");
    const doc = await PDFDocument.load(pdf);
    const size = doc.getPage(0).getSize();
    ok(`${type}: A4 pages`, Math.abs(size.width - 595.28) <= 2 && Math.abs(size.height - 841.89) <= 2, JSON.stringify(size));
    ok(`${type}: the Hebrew font is embedded`, /NotoSansHebrew/.test(pdf.toString("latin1")));
    ok(`${type}: rendered well inside the 60 s function limit (cold start included)`, ms < 45_000, `${ms} ms`);

    const signed = await signPdf(pdf, generateTestSigningMaterial());
    const v = verifySignedPdf(signed.bytes);
    ok(`${type}: signs and verifies (sha256/RSA)`, v.valid === true && v.digestAlgorithm === "sha256", v.reason);
    const t = Buffer.from(signed.bytes);
    const [a, b] = v.byteRange!;
    t[a + Math.min(b - 1, 100)] ^= 0xff;
    ok(`${type}: tampering breaks verification`, verifySignedPdf(t).valid === false);
  }

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => process.exit());
