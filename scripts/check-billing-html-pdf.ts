/**
 * One-off: render issued Billing snapshot with HTML Playwright renderer → PDF file.
 * Uses the same renderBillingPdfHtmlFromSnapshot as GET /api/billing/documents/[id]/pdf (when BILLING_PDF_RENDERER=html).
 *
 * Usage (PowerShell):
 *   $env:BILLING_PDF_RENDERER="html"
 *   npx playwright install chromium
 *   npx tsx scripts/check-billing-html-pdf.ts
 */

import { writeFileSync } from "fs";
import { join } from "path";

import { PrismaClient, BillingDocumentStatus } from "@prisma/client";
import { chromium } from "playwright";

import {
  getNotoSansHebrewFontDataUri,
  renderBillingPdfHtmlFromSnapshot,
} from "../lib/services/billing/pdf/billing-pdf-html-renderer";
import { buildBillingInvoiceHtml } from "../lib/services/billing/pdf/billing-pdf-html-template";
import {
  assertSnapshotV1,
  type BillingIssuedSnapshotV1,
} from "../lib/services/billing/pdf/billing-pdf-template";

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const doc = await prisma.billingDocument.findFirst({
      where: { status: BillingDocumentStatus.ISSUED },
      orderBy: { id: "desc" },
      select: { id: true, businessId: true, issuedSnapshot: true },
    });

    if (!doc?.issuedSnapshot || typeof doc.issuedSnapshot !== "object") {
      console.error(
        "No ISSUED billing document with issuedSnapshot found. Issue an invoice from the UI first."
      );
      process.exitCode = 1;
      return;
    }

    assertSnapshotV1(doc.issuedSnapshot);
    const snapshot = doc.issuedSnapshot as unknown as BillingIssuedSnapshotV1;

    console.log(
      `Rendering HTML PDF for billingDocument id=${doc.id} businessId=${doc.businessId} …`
    );
    const buffer = await renderBillingPdfHtmlFromSnapshot(snapshot);

    const out = join(process.cwd(), "tmp", "billing-html-integration-check.pdf");
    writeFileSync(out, buffer);
    console.log(`OK: wrote ${out} (${buffer.length} bytes)`);

    const fontUri = getNotoSansHebrewFontDataUri();
    const html = buildBillingInvoiceHtml(snapshot, fontUri);
    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    try {
      const page = await browser.newPage({
        viewport: { width: 1200, height: 1800 },
      });
      await page.setContent(html, { waitUntil: "networkidle" });
      const png = join(process.cwd(), "tmp", "billing-html-integration-check.png");
      await page.screenshot({ path: png, fullPage: true });
      console.log(`OK: screenshot (same HTML as PDF renderer): ${png}`);
    } finally {
      await browser.close();
    }

    console.log(
      "Open the PDF/PNG locally for RTL/visual checks (renderer matches billing-pdf-html-renderer)."
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
