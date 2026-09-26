/**
 * Billing HTML→PDF via Playwright Chromium.
 *
 * Dev/local: run `npx playwright install chromium` once so the browser binary exists.
 *
 * Production / serverless (e.g. Vercel): bundling Chromium or calling a remote browser
 * is not addressed here — deploy targets without a local Playwright browser should keep
 * `BILLING_PDF_RENDERER=pdfmake` (legacy path) or supply a compatible runtime.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { chromium } from "playwright";

import { hebrewFontVfs } from "@/lib/pdf/hebrew-font-vfs";
import { escapeHtmlForPdf } from "@/lib/services/billing/pdf/billing-pdf-text-policy";
import { buildBillingInvoiceHtml } from "@/lib/services/billing/pdf/billing-pdf-html-template";
import type { BillingIssuedSnapshotV1 } from "@/lib/services/billing/pdf/billing-pdf-template";

const FONT_FILENAME = "NotoSansHebrew-Regular.ttf";

function billingPdfDebugEnabled(): boolean {
  return process.env.BILLING_PDF_DEBUG_LOG === "1";
}

export function getNotoSansHebrewFontDataUri(): string {
  const publicPath = join(process.cwd(), "public", "fonts", FONT_FILENAME);
  if (existsSync(publicPath)) {
    const b64 = readFileSync(publicPath).toString("base64");
    return `data:font/ttf;base64,${b64}`;
  }
  const vfsMap = hebrewFontVfs as unknown as Record<string, string>;
  const base64 = vfsMap[FONT_FILENAME];
  if (!base64 || typeof base64 !== "string") {
    throw new Error(
      `Hebrew font '${FONT_FILENAME}' missing under public/fonts and lib/pdf/hebrew-font-vfs.ts`
    );
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

  return renderHtmlToPdfHardened(
    html,
    buildFooterTemplate(fontDataUri, snapshot.issuer.name)
  );
}

/** Requests the renderer lets through: inline data only. */
export function isAllowedRendererRequestUrl(url: string): boolean {
  return url.startsWith("data:") || url === "about:blank";
}

/**
 * L-14 — HTML → PDF with the page locked down.
 *
 * The invoice HTML embeds owner/customer-controlled text (escaped) and images
 * (data: URLs only, checked in the template). Defence in depth for the day an
 * escape is missed:
 *   - JavaScript is DISABLED for the page: the template contains no script, and
 *     the output (page count, text, footer page numbers) is identical without
 *     it — proven by the sec-d battery rendering a fixture both ways.
 *   - EVERY network request is aborted except data: / about:blank, so injected
 *     markup cannot reach internal hosts, cloud metadata or the internet.
 *   - service workers are blocked.
 *
 * `--no-sandbox` stays: serverless Linux runtimes (AWS Lambda, which backs
 * Vercel Functions) provide no user namespaces / setuid helper, so Chromium's
 * sandbox cannot start there. With JS off and the network closed, the renderer
 * process has no attacker-driven code path left for the sandbox to contain.
 */
export async function renderHtmlToPdfHardened(
  html: string,
  footerTemplate: string
): Promise<Buffer> {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const context = await browser.newContext({
      javaScriptEnabled: false,
      serviceWorkers: "block",
    });
    await context.route("**/*", (route) => {
      if (isAllowedRendererRequestUrl(route.request().url())) {
        return route.continue();
      }
      return route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: "<div></div>",
      footerTemplate,
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
