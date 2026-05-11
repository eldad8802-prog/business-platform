/**
 * Debug: render the same issued invoice snapshot with multiple free-text BiDi wrappers.
 *
 * Usage (PowerShell):
 *   npx tsx scripts/billing-free-text-bidi-matrix.ts <billingDocumentId>
 *
 * Outputs:
 *   tmp/bidi-matrix-<id>-bdi.pdf/png/html
 *   tmp/bidi-matrix-<id>-isolate-rtl.pdf/png/html
 *   tmp/bidi-matrix-<id>-plaintext-auto.pdf/png/html
 *   tmp/bidi-matrix-<id>-plaintext-rtl.pdf/png/html
 */

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

import { BillingDocumentStatus, PrismaClient } from "@prisma/client";
import { chromium } from "playwright";

import { getNotoSansHebrewFontDataUri } from "../lib/services/billing/pdf/billing-pdf-html-renderer";
import { buildBillingInvoiceHtml } from "../lib/services/billing/pdf/billing-pdf-html-template";
import { assertSnapshotV1, type BillingIssuedSnapshotV1 } from "../lib/services/billing/pdf/billing-pdf-template";

type Strategy = "bdi" | "isolate-rtl" | "plaintext-auto" | "plaintext-rtl";

const STRATEGIES: Strategy[] = [
  "bdi",
  "isolate-rtl",
  "plaintext-auto",
  "plaintext-rtl",
];

function withMatrixTestStrings(snapshot: BillingIssuedSnapshotV1): BillingIssuedSnapshotV1 {
  const s = structuredClone(snapshot) as BillingIssuedSnapshotV1;

  // Free text fields matrix (keep numeric/email/phone fields untouched).
  s.customer.name = "שלום כיתה א";
  s.issuer.name = "הסנדק";

  if (typeof s.issuer.address === "string") {
    s.issuer.address = "רחוב הרצל 12 דירה 4\nהחבצלת 17";
  }
  if (typeof s.issuer.bankDetails === "string") {
    s.issuer.bankDetails = "תשלום לחשבון 123456 בנק לאומי";
  }

  if (Array.isArray(s.lines) && s.lines.length > 0) {
    s.lines[0].description = "שירות תיקון מזגן 2 יחידות";
    if (s.lines.length > 1) {
      s.lines[1].description = "חומוס בשר פול ובשר";
    }
  }

  // Footer note can include free text + numbers.
  s.extensions = {
    ...(s.extensions ?? {}),
    billingFooterNote:
      "הערה: נא להעביר תשלום עד 17/05. תודה!",
  };

  return s;
}

async function renderOne(args: {
  strategy: Strategy;
  id: number;
  snapshot: BillingIssuedSnapshotV1;
}): Promise<void> {
  const { strategy, id, snapshot } = args;

  const tmpDir = join(process.cwd(), "tmp");
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

  const base = join(tmpDir, `bidi-matrix-${id}-${strategy}`);
  const htmlPath = `${base}.html`;
  const pdfPath = `${base}.pdf`;
  const pngPath = `${base}.png`;

  process.env.BILLING_PDF_FREE_TEXT_BIDI = strategy;

  const fontDataUri = getNotoSansHebrewFontDataUri();
  const html = buildBillingInvoiceHtml(snapshot, fontDataUri);
  writeFileSync(htmlPath, html, "utf-8");

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1240, height: 1754 } });
    await page.setContent(html, { waitUntil: "networkidle" });
    await page.screenshot({ path: pngPath, fullPage: true });

    const pdfBuf = await page.pdf({
      format: "A4",
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: "<div></div>",
      footerTemplate: "<div></div>",
      margin: { top: "0px", right: "0px", bottom: "0px", left: "0px" },
    });
    writeFileSync(pdfPath, pdfBuf);
  } finally {
    await browser.close();
  }

  console.log("wrote", { strategy, htmlPath, pngPath, pdfPath });
}

async function main(): Promise<void> {
  const idArg = process.argv[2];
  const id = Number(idArg);
  if (!idArg || !Number.isInteger(id) || id <= 0) {
    console.error(
      "Usage: npx tsx scripts/billing-free-text-bidi-matrix.ts <billingDocumentId>"
    );
    process.exitCode = 1;
    return;
  }

  const prisma = new PrismaClient();
  try {
    const doc = await prisma.billingDocument.findFirst({
      where: { id, status: BillingDocumentStatus.ISSUED },
      select: { issuedSnapshot: true },
    });

    if (!doc?.issuedSnapshot || typeof doc.issuedSnapshot !== "object") {
      console.error(`No ISSUED billing document with issuedSnapshot for id=${id}`);
      process.exitCode = 1;
      return;
    }

    assertSnapshotV1(doc.issuedSnapshot);
    const snapshot = withMatrixTestStrings(
      doc.issuedSnapshot as unknown as BillingIssuedSnapshotV1
    );

    for (const strategy of STRATEGIES) {
      await renderOne({ strategy, id, snapshot });
    }

    console.log("\nOpen the PNGs/PDFs under tmp/ and pick best strategy.");
    console.log("Tip: compare address/payment/footer/line description for natural order (no flips).");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

