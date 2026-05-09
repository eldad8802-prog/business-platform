/**
 * Diagnostic: print issuedSnapshot text + DB PDF fields, then render HTML PDF + PNG
 * (same renderBillingPdfHtmlFromSnapshot as production html path). Bypasses API, auth, and cache.
 *
 * Usage:
 *   npx tsx scripts/billing-pdf-debug-document.ts <billingDocumentId>
 *
 * Outputs:
 *   tmp/billing-html-debug-<id>.pdf
 *   tmp/billing-html-debug-<id>.png   (HTML screenshot; same template as PDF body)
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

function codePrefix(s: string, maxChars: number): string {
  const slice = [...s].slice(0, maxChars);
  return slice
    .map((ch) => {
      const cp = ch.codePointAt(0);
      return `${ch}(U+${cp!.toString(16).toUpperCase().padStart(4, "0")})`;
    })
    .join(" ");
}

async function main(): Promise<void> {
  const idArg = process.argv[2];
  const id = Number(idArg);
  if (!idArg || !Number.isInteger(id) || id <= 0) {
    console.error(
      "Usage: npx tsx scripts/billing-pdf-debug-document.ts <billingDocumentId>"
    );
    process.exitCode = 1;
    return;
  }

  const prisma = new PrismaClient();
  try {
    const doc = await prisma.billingDocument.findFirst({
      where: { id, status: BillingDocumentStatus.ISSUED },
      select: {
        id: true,
        businessId: true,
        pdfRenderStatus: true,
        pdfStorageKey: true,
        pdfHash: true,
        pdfTemplateVersion: true,
        issuedSnapshot: true,
      },
    });

    if (!doc) {
      console.error(`No ISSUED billing document with id=${id}`);
      process.exitCode = 1;
      return;
    }

    if (!doc.issuedSnapshot || typeof doc.issuedSnapshot !== "object") {
      console.error("issuedSnapshot missing");
      process.exitCode = 1;
      return;
    }

    assertSnapshotV1(doc.issuedSnapshot);
    const snapshot = doc.issuedSnapshot as unknown as BillingIssuedSnapshotV1;

    const cn = snapshot.customer.name;
    const fd = snapshot.lines[0]?.description ?? "";

    console.log("--- issuedSnapshot (DB, before any renderer) ---");
    console.log("customer.name JSON:", JSON.stringify(cn));
    console.log("lines[0].description JSON:", JSON.stringify(fd));
    console.log("customer.name codepoints (first 12 chars):", codePrefix(cn, 12));
    console.log("lines[0] codepoints (first 12 chars):", codePrefix(fd, 12));

    console.log("--- DB PDF metadata (may indicate cached file exists) ---");
    console.log(
      JSON.stringify(
        {
          pdfRenderStatus: doc.pdfRenderStatus,
          pdfStorageKey: doc.pdfStorageKey,
          pdfHashPrefix: doc.pdfHash ? doc.pdfHash.slice(0, 16) : null,
          pdfTemplateVersion: doc.pdfTemplateVersion,
        },
        null,
        2
      )
    );

    console.log(
      "--- HTML renderer only (bypass cache; matches BILLING_PDF_RENDERER=html path) ---"
    );
    const pdfBuf = await renderBillingPdfHtmlFromSnapshot(snapshot);
    const pdfPath = join(process.cwd(), "tmp", `billing-html-debug-${id}.pdf`);
    writeFileSync(pdfPath, pdfBuf);
    console.log("wrote", pdfPath, `(${pdfBuf.length} bytes)`);

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
      const pngPath = join(process.cwd(), "tmp", `billing-html-debug-${id}.png`);
      await page.screenshot({ path: pngPath, fullPage: true });
      console.log("wrote", pngPath);
    } finally {
      await browser.close();
    }

    console.log(
      "Interpret: correct JSON + wrong PNG/PDF → rendering; garbled JSON → data/issue-time."
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
