/**
 * Billing HTML→PDF via Chromium.
 *
 * Dev/local: run `npx playwright install chromium` once so the browser binary exists.
 *
 * Production / serverless (Vercel): the shared launcher (lib/pdf/chromium.ts) starts the serverless
 * Chromium build. Only the browser changes — the HTML, the page options and the bytes' meaning do not.
 */

import { launchChromium } from "@/lib/pdf/chromium";
import { hebrewFontVfs } from "@/lib/pdf/hebrew-font-vfs";
import { escapeHtmlForPdf } from "@/lib/services/billing/pdf/billing-pdf-text-policy";
import { buildBillingInvoiceHtml } from "@/lib/services/billing/pdf/billing-pdf-html-template";
import type { BillingIssuedSnapshotV1 } from "@/lib/services/billing/pdf/billing-pdf-template";

const FONT_FILENAME = "NotoSansHebrew-Regular.ttf";

function billingPdfDebugEnabled(): boolean {
  return process.env.BILLING_PDF_DEBUG_LOG === "1";
}

/**
 * The embedded copy only. It is byte-identical to public/fonts/NotoSansHebrew-Regular.ttf (asserted by
 * lib/pdf/chromium.verify.test.ts), so the data URI — and the HTML — are unchanged. The former
 * `join(process.cwd(), "public", …)` read made file tracing pull the whole project directory into every
 * PDF-rendering function (~150 MB), which with the serverless browser exceeded Vercel's 250 MB limit.
 */
export function getNotoSansHebrewFontDataUri(): string {
  const vfsMap = hebrewFontVfs as unknown as Record<string, string>;
  const base64 = vfsMap[FONT_FILENAME];
  if (!base64 || typeof base64 !== "string") {
    throw new Error(`Hebrew font '${FONT_FILENAME}' missing in lib/pdf/hebrew-font-vfs.ts`);
  }
  return `data:font/ttf;base64,${base64}`;
}

function buildFooterTemplate(fontDataUri: string, issuerName: string): string {
  const issuerEsc = escapeHtmlForPdf(issuerName);
  return `
<style>
  @font-face {
    font-family: 'NotoSansHebrew';
    src: url('${fontDataUri}') format('truetype');
    font-weight: 400;
    font-style: normal;
  }
  .pf { font-family: NotoSansHebrew, sans-serif; box-sizing: border-box; }
  .pf-wrap {
    width: 100%;
    font-size: 8px;
    padding: 12px 44px 0;
    color: #64748b;
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
  }
  .pf-r {
    text-align: left;
    direction: rtl;
    unicode-bidi: isolate;
    flex: 1;
    min-width: 0;
    overflow: hidden;
  }
  .pf-l {
    text-align: right;
    direction: ltr;
    flex: 0 0 auto;
    white-space: nowrap;
  }
</style>
<div class="pf-wrap">
  <div class="pf pf-r">${issuerEsc}</div>
  <div class="pf pf-l">עמוד <span class="pageNumber"></span> מתוך <span class="totalPages"></span></div>
</div>`;
}

export async function renderBillingPdfHtmlFromSnapshot(
  snapshot: BillingIssuedSnapshotV1
): Promise<Buffer> {
  if (billingPdfDebugEnabled()) {
    const firstLine = snapshot.lines[0]?.description ?? "(no lines)";
    console.log("[billing-pdf-debug] ENTER renderBillingPdfHtmlFromSnapshot", {
      customerNameFromSnapshot: snapshot.customer.name,
      firstLineDescriptionFromSnapshot: firstLine,
    });
  }

  const fontDataUri = getNotoSansHebrewFontDataUri();
  const html = buildBillingInvoiceHtml(snapshot, fontDataUri);

  const browser = await launchChromium();

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: "<div></div>",
      footerTemplate: buildFooterTemplate(fontDataUri, snapshot.issuer.name),
      margin: {
        top: "0px",
        right: "0px",
        bottom: "52px",
        left: "0px",
      },
    });

    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
