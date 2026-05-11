/**
 * One-off debug: export billing HTML, screenshot, and PDF from a real issued snapshot.
 *
 * All three outputs come from the same HTML string — enabling a direct browser vs PDF comparison.
 *
 * Usage (PowerShell):
 *   npx tsx scripts/billing-html-export-debug.ts <billingDocumentId>
 *
 * Outputs:
 *   tmp/billing-html-debug-real.html  — raw HTML before Playwright
 *   tmp/billing-html-debug-real.png   — screenshot of that HTML in Chromium (browser view)
 *   tmp/billing-html-debug-real.pdf   — PDF from that same HTML via page.pdf()
 */

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

import { BillingDocumentStatus, PrismaClient } from "@prisma/client";
import { chromium } from "playwright";

import {
  getNotoSansHebrewFontDataUri,
} from "../lib/services/billing/pdf/billing-pdf-html-renderer";
import { buildBillingInvoiceHtml } from "../lib/services/billing/pdf/billing-pdf-html-template";
import {
  assertSnapshotV1,
  type BillingIssuedSnapshotV1,
} from "../lib/services/billing/pdf/billing-pdf-template";

async function main(): Promise<void> {
  const idArg = process.argv[2];
  const id = Number(idArg);
  if (!idArg || !Number.isInteger(id) || id <= 0) {
    console.error(
      "Usage: npx tsx scripts/billing-html-export-debug.ts <billingDocumentId>"
    );
    process.exitCode = 1;
    return;
  }

  const tmpDir = join(process.cwd(), "tmp");
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

  const htmlPath = join(tmpDir, "billing-html-debug-real.html");
  const pngPath  = join(tmpDir, "billing-html-debug-real.png");
  const pdfPath  = join(tmpDir, "billing-html-debug-real.pdf");

  const prisma = new PrismaClient();
  try {
    const doc = await prisma.billingDocument.findFirst({
      where: { id, status: BillingDocumentStatus.ISSUED },
      select: { id: true, issuedSnapshot: true },
    });

    if (!doc) {
      console.error(`No ISSUED billing document with id=${id}`);
      process.exitCode = 1;
      return;
    }
    if (!doc.issuedSnapshot || typeof doc.issuedSnapshot !== "object") {
      console.error("issuedSnapshot missing or null");
      process.exitCode = 1;
      return;
    }

    assertSnapshotV1(doc.issuedSnapshot);
    const snapshot = doc.issuedSnapshot as unknown as BillingIssuedSnapshotV1;

    console.log("customer.name:", JSON.stringify(snapshot.customer.name));
    console.log("issuer.name:", JSON.stringify(snapshot.issuer.name));
    console.log("lines[0].description:", JSON.stringify(snapshot.lines[0]?.description ?? ""));

    // Build HTML — identical to what renderBillingPdfHtmlFromSnapshot sends to Playwright
    const fontDataUri = getNotoSansHebrewFontDataUri();
    const html = buildBillingInvoiceHtml(snapshot, fontDataUri);

    writeFileSync(htmlPath, html, "utf-8");
    console.log("wrote", htmlPath);

    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    try {
      // Screenshot: browser renders the HTML as a webpage (no print CSS)
      const screenshotPage = await browser.newPage({
        viewport: { width: 1240, height: 1754 },
      });
      await screenshotPage.setContent(html, { waitUntil: "networkidle" });
      await screenshotPage.screenshot({ path: pngPath, fullPage: true });
      console.log("wrote", pngPath);

      // PDF: same HTML, same browser, print pipeline (this is what users receive)
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

    console.log("\nNext step:");
    console.log("  Open tmp/billing-html-debug-real.png  → browser view");
    console.log("  Open tmp/billing-html-debug-real.pdf  → print/PDF view");
    console.log("  Open tmp/billing-html-debug-real.html → inspect source");
    console.log("\nIf PNG looks correct but PDF does not → Chromium print pipeline issue.");
    console.log("If both look wrong → HTML/CSS/template issue.");
    console.log("If both look correct → user is viewing an old cached PDF.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
