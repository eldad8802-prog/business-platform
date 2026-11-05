/**
 * ר2 — the letter as a PDF, through the shared Chromium launcher (lib/pdf/chromium).
 * Kept apart from letter.service.ts so only the PDF route carries the browser bundle
 * (next.config.ts outputFileTracingIncludes + scripts/ci/pdf-route-tracing-guard.mjs).
 */
import { launchChromium } from "@/lib/pdf/chromium";

import type { LetterInput } from "./letter.contracts";
import { renderLetterHtml } from "./letter.service";

export async function renderLetterPdf(businessId: number, input: LetterInput): Promise<Buffer> {
  const html = await renderLetterHtml(businessId, input);
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    const pdf = await page.pdf({ format: "A4", printBackground: true, margin: { top: "0px", right: "0px", bottom: "0px", left: "0px" } });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
