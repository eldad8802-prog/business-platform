/**
 * L-14 renderer proof (needs Chromium: `npx playwright install chromium`).
 *
 *   npx tsx lib/security/sec-d/renderer-proof.test.ts
 *
 * 1. OUTPUT UNCHANGED: the invoice fixture rendered by the hardened renderer
 *    (JS off, network closed) has the same page count and the same extracted
 *    text as the pre-hardening configuration (JS on, no routing).
 * 2. NETWORK CLOSED: markup pointing at a local HTTP server produces requests
 *    under the legacy configuration (control) and ZERO under the hardened one.
 * 3. JS OFF: a <script> that writes into the page runs in the control and not
 *    in the hardened render.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";
import { Prisma, type BillingDocument, type BillingDocumentLine } from "@prisma/client";
import { buildIssuedSnapshot } from "@/lib/services/billing/billing-issue.service";
import type { BillingIssuedSnapshotV1 } from "@/lib/services/billing/pdf/billing-pdf-template";
import { buildBillingInvoiceHtml } from "@/lib/services/billing/pdf/billing-pdf-html-template";
import {
  getNotoSansHebrewFontDataUri,
  renderBillingPdfHtmlFromSnapshot,
  renderHtmlToPdfHardened,
} from "@/lib/services/billing/pdf/billing-pdf-html-renderer";

let failed = 0;
function check(id: string, claim: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`[PASS] ${id} · ${claim}`);
  else {
    failed += 1;
    console.log(`[FAIL] ${id} · ${claim} — ${detail}`);
  }
}

function fixtureSnapshot(): BillingIssuedSnapshotV1 {
  const document = {
    id: 1, documentType: "TAX_INVOICE", status: "ISSUED", currency: "ILS",
    referenceDocumentId: null, customerNameSnapshot: "לקוח בדיקה",
  } as unknown as BillingDocument;
  const lines = Array.from({ length: 40 }, (_, i) => ({
    lineIndex: i, description: `שירות בדיקה ${i + 1}`,
    quantity: new Prisma.Decimal("1"), unitPrice: new Prisma.Decimal("100"),
    vatRatePercent: new Prisma.Decimal("17"), lineSubtotal: new Prisma.Decimal("100"),
    vatAmount: new Prisma.Decimal("17"), lineTotal: new Prisma.Decimal("117"),
  })) as unknown as BillingDocumentLine[];
  const business = {
    id: 1, name: "Dubiz",
    profile: {
      billingLegalName: 'דוביז בע"מ', billingBusinessKind: "LTD_COMPANY",
      billingTaxId: "515000123", billingVatNumber: "515000123",
      billingPhone: null, billingEmail: null, billingAddress: null,
      billingPaymentNote: null, billingFooterNote: null,
      billingLogoDataUrl: null, billingSignatureDataUrl: null, billingPdfTemplateStyle: null,
    },
  };
  return buildIssuedSnapshot({
    document, lines, business,
    customer: { id: 7, name: "לקוח בדיקה", phone: null, email: null, city: "תל אביב", taxId: "514000000" },
    documentNumber: 7, documentNumberFormatted: "000007",
    issuedAt: new Date("2026-06-15T10:00:00.000Z"), actorUserId: 1,
    totals: { subtotalAmount: new Prisma.Decimal("4000"), vatAmount: new Prisma.Decimal("680"), totalAmount: new Prisma.Decimal("4680") },
  }) as unknown as BillingIssuedSnapshotV1;
}

/** The pre-L-14 configuration: JS on, no request interception. */
async function renderLegacy(html: string, footerTemplate: string): Promise<Buffer> {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });
    return Buffer.from(
      await page.pdf({
        format: "A4", printBackground: true, displayHeaderFooter: true,
        headerTemplate: "<div></div>", footerTemplate,
        margin: { top: "0px", right: "0px", bottom: "52px", left: "0px" },
      })
    );
  } finally {
    await browser.close();
  }
}

async function pdfInfo(buf: Buffer): Promise<{ pages: number; text: string }> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PDFParse } = require("pdf-parse") as { PDFParse: new (o: { data: Uint8Array }) => { getText(): Promise<{ text: string; total: number }>; destroy(): Promise<void> } };
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const r = await parser.getText();
    return { pages: r.total, text: r.text.replace(/\s+/g, " ").trim() };
  } finally {
    await parser.destroy();
  }
}

async function main(): Promise<void> {
  const snapshot = fixtureSnapshot();
  const font = getNotoSansHebrewFontDataUri();
  const html = buildBillingInvoiceHtml(snapshot, font);
  // Same footer the renderer builds; reproduced via the hardened entry point.
  const hardened = await renderBillingPdfHtmlFromSnapshot(snapshot);
  const footer = `<div style="font-size:8px;width:100%;text-align:center">עמוד <span class="pageNumber"></span> מתוך <span class="totalPages"></span></div>`;
  const hardenedSameFooter = await renderHtmlToPdfHardened(html, footer);
  const legacy = await renderLegacy(html, footer);

  const a = await pdfInfo(hardenedSameFooter);
  const b = await pdfInfo(legacy);
  const full = await pdfInfo(hardened);
  console.log(`  fixture: hardened ${a.pages} page(s) / ${a.text.length} chars; legacy ${b.pages} page(s) / ${b.text.length} chars`);
  check("L-14", "invoice fixture renders to a multi-page PDF", full.pages >= 2, `pages=${full.pages}`);
  check("L-14", "page count identical with JS disabled + network closed", a.pages === b.pages, `${a.pages} vs ${b.pages}`);
  check("L-14", "extracted text identical with JS disabled + network closed", a.text === b.text);
  check("L-14", "footer page numbers still rendered without page JS", /מתוך/.test(full.text) || /עמוד/.test(full.text));

  // --- network + JS probes -------------------------------------------------
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    res.writeHead(200, { "content-type": "image/png" });
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const probe = `<!doctype html><html><head>
    <link rel="stylesheet" href="http://127.0.0.1:${port}/css">
    <style>body{background:url(http://127.0.0.1:${port}/bg)}</style></head>
    <body><p>probe</p><img src="http://127.0.0.1:${port}/img">
    <iframe src="http://127.0.0.1:${port}/frame"></iframe>
    <script>document.body.insertAdjacentHTML("beforeend","<p>JS-RAN-MARKER</p>")</script>
    </body></html>`;
  try {
    hits.length = 0;
    const control = await renderLegacy(probe, "<div></div>");
    const controlHits = hits.length;
    const controlText = (await pdfInfo(control)).text;
    hits.length = 0;
    const locked = await renderHtmlToPdfHardened(probe, "<div></div>");
    const lockedHits = hits.length;
    const lockedText = (await pdfInfo(locked)).text;
    check("L-14", "control: legacy config DOES reach the local server (probe is live)", controlHits > 0, `hits=${controlHits}`);
    check("L-14", "hardened renderer makes ZERO network requests", lockedHits === 0, `hits=${lockedHits}`);
    check("L-14", "control: legacy config DOES execute page script", controlText.includes("JS-RAN-MARKER"));
    check("L-14", "hardened renderer does NOT execute page script", !lockedText.includes("JS-RAN-MARKER"));
  } finally {
    server.close();
  }

  console.log(`\nrenderer proof: ${failed === 0 ? "all passed" : `${failed} failed`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log(`[CRASH] renderer proof: ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(2);
});
