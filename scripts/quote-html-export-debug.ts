/**
 * One-off debug: export QUOTE billing HTML, screenshot, and PDF from a snapshot.
 *
 * Usage (PowerShell):
 *   npx tsx scripts/quote-html-export-debug.ts <billingDocumentId>
 *
 * Outputs:
 *   tmp/quote-html-debug-real.html  — raw HTML before Playwright
 *   tmp/quote-html-debug-real.png   — screenshot of that HTML in Chromium (browser view)
 *   tmp/quote-html-debug-real.pdf   — PDF from that same HTML via page.pdf()
 */

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

import { BillingDocumentType, PrismaClient } from "@prisma/client";
import { chromium } from "playwright";

import { getNotoSansHebrewFontDataUri } from "../lib/services/billing/pdf/billing-pdf-html-renderer";
import { buildBillingInvoiceHtml } from "../lib/services/billing/pdf/billing-pdf-html-template";
import { allocateQuoteDocumentNumberIfMissing } from "../lib/services/billing/quote-document-number";
import { buildQuotePdfSnapshot } from "../lib/services/billing/quote-pdf-snapshot";
import { assertSnapshotV1, type BillingIssuedSnapshotV1 } from "../lib/services/billing/pdf/billing-pdf-template";

async function main(): Promise<void> {
  const idArg = process.argv[2];
  const id = Number(idArg);
  if (!idArg || !Number.isInteger(id) || id <= 0) {
    console.error(
      "Usage: npx tsx scripts/quote-html-export-debug.ts <billingDocumentId>"
    );
    process.exitCode = 1;
    return;
  }

  const tmpDir = join(process.cwd(), "tmp");
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

  const htmlPath = join(tmpDir, "quote-html-debug-real.html");
  const pngPath = join(tmpDir, "quote-html-debug-real.png");
  const pdfPath = join(tmpDir, "quote-html-debug-real.pdf");

  const prisma = new PrismaClient();
  try {
    const doc = await prisma.billingDocument.findFirst({
      where: { id, documentType: BillingDocumentType.QUOTE },
      include: { lines: { orderBy: { lineIndex: "asc" } } },
    });

    if (!doc) {
      console.error(`No QUOTE billing document with id=${id}`);
      process.exitCode = 1;
      return;
    }

    // Quotes can be rendered pre-issue; we follow the same data requirements as the service.
    const allocated = await prisma.$transaction((tx) =>
      allocateQuoteDocumentNumberIfMissing(tx, {
        businessId: doc.businessId,
        billingDocumentId: id,
      })
    );

    const business = await prisma.business.findUnique({
      where: { id: doc.businessId },
      select: {
        id: true,
        name: true,
        profile: {
          select: {
            billingLegalName: true,
            billingTaxId: true,
            billingVatNumber: true,
            billingPhone: true,
            billingEmail: true,
            billingAddress: true,
            billingPaymentNote: true,
            billingFooterNote: true,
            billingLogoDataUrl: true,
            billingSignatureDataUrl: true,
            billingPdfTemplateStyle: true,
          },
        },
      },
    });

    if (!business) {
      console.error("Business not found");
      process.exitCode = 1;
      return;
    }

    const customerNameSnapshot = (doc.customerNameSnapshot ?? "").trim();
    if (customerNameSnapshot.length === 0) {
      console.error("Quote missing customerNameSnapshot");
      process.exitCode = 1;
      return;
    }
    if (doc.lines.length === 0) {
      console.error("Quote has no lines");
      process.exitCode = 1;
      return;
    }

    const totals = {
      subtotalAmount: doc.subtotalAmount,
      vatAmount: doc.vatAmount,
      totalAmount: doc.totalAmount,
    };

    const snapshot: BillingIssuedSnapshotV1 = buildQuotePdfSnapshot({
      document: doc,
      lines: doc.lines,
      business,
      customer: null,
      documentNumber: doc.documentNumber ?? allocated?.documentNumber ?? 0,
      documentNumberFormatted:
        doc.documentNumberFormatted ??
        allocated?.documentNumberFormatted ??
        "(missing)",
      snapshotDate: new Date(),
      actorUserId: doc.createdByUserId ?? 1,
      totals,
    });

    assertSnapshotV1(snapshot);

    console.log("customer.name:", JSON.stringify(snapshot.customer.name));
    console.log("issuer.name:", JSON.stringify(snapshot.issuer.name));
    console.log(
      "lines[0].description:",
      JSON.stringify(snapshot.lines[0]?.description ?? "")
    );

    const fontDataUri = getNotoSansHebrewFontDataUri();
    const html = buildBillingInvoiceHtml(snapshot, fontDataUri);

    writeFileSync(htmlPath, html, "utf-8");
    console.log("wrote", htmlPath);

    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    try {
      const screenshotPage = await browser.newPage({
        viewport: { width: 1240, height: 1754 },
      });
      await screenshotPage.setContent(html, { waitUntil: "networkidle" });
      await screenshotPage.screenshot({ path: pngPath, fullPage: true });
      console.log("wrote", pngPath);

      const pdfPage = await browser.newPage();
      await pdfPage.setContent(html, { waitUntil: "networkidle" });
      const pdfBuf = await pdfPage.pdf({
        format: "A4",
        printBackground: true,
        displayHeaderFooter: false,
        margin: { top: "0px", right: "0px", bottom: "0px", left: "0px" },
      });
      writeFileSync(pdfPath, pdfBuf);
      console.log("wrote", pdfPath);
    } finally {
      await browser.close();
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

