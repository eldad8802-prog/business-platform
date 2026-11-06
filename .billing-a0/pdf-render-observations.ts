/**
 * A0 — what a RENDERED PDF of each existing document type looks like, minus the
 * parts that legitimately change on every render.
 *
 * Why not compare PDF bytes: every render embeds a fresh CreationDate / ModDate
 * (and the Producer string of the engine), and Production renders with the
 * serverless Chromium build (@sparticuz/chromium) while CI renders with the
 * Playwright Chromium. The BYTE-exact guarantee for the PDF therefore sits one
 * step earlier, on the renderer's complete input (golden.test.ts: the HTML
 * document and the pdfmake document definition, sha256).
 *
 * Here, on the rendered output, we compare:
 *   - the page count;
 *   - the full extracted text with all whitespace removed (content and reading
 *     order of every text run — header, issuer, customer, lines, totals,
 *     payment note, footer, page numbering — independent of line wrapping).
 * Metadata (CreationDate, ModDate, Producer, Creator, document ID) is excluded.
 */
import { PDFParse } from "pdf-parse";
import { renderBillingPdfHtmlFromSnapshot } from "../lib/services/billing/pdf/billing-pdf-html-renderer";
import { renderBillingPdfFromSnapshot } from "../lib/services/billing/pdf/billing-pdf-renderer";
import type { BillingIssuedSnapshotV1 } from "../lib/services/billing/pdf/billing-pdf-template";
import { buildCases, withAllocationNumber, type Case } from "./fixtures";

export const PDF_METADATA_EXCLUDED = ["CreationDate", "ModDate", "Producer", "Creator", "ID"] as const;

/** Keys rendered: one per document type, plus the allocation-number overlay. */
const RENDERED = [
  "TAX_INVOICE.classic",
  "TAX_INVOICE.large+allocation",
  "TAX_INVOICE_RECEIPT.classic",
  "RECEIPT.classic",
  "CREDIT_NOTE.classic",
  "QUOTE.classic",
];

function pick(cases: Case[], key: string): BillingIssuedSnapshotV1 {
  if (key === "TAX_INVOICE.large+allocation") {
    const c = cases.find((x) => x.key === "TAX_INVOICE.large")!;
    return withAllocationNumber(c.snapshot as unknown as BillingIssuedSnapshotV1, "123456789");
  }
  return cases.find((x) => x.key === key)!.snapshot as unknown as BillingIssuedSnapshotV1;
}

async function extract(pdf: Buffer): Promise<{ pages: number; text: string }> {
  const parser = new PDFParse({ data: pdf });
  try {
    const t = await parser.getText();
    // Drop the parser's own page separators, then every whitespace character.
    const text = t.text.replace(/-- \d+ of \d+ --/g, "").replace(/\s+/g, "");
    return { pages: t.total, text };
  } finally {
    await parser.destroy();
  }
}

export async function computePdfRenderObservations(): Promise<Record<string, string>> {
  const cases = buildCases();
  const out: Record<string, string> = {};
  for (const key of RENDERED) {
    const snapshot = pick(cases, key);
    const html = await extract(await renderBillingPdfHtmlFromSnapshot(snapshot));
    out[`render.html.${key}.pages`] = String(html.pages);
    out[`render.html.${key}.text`] = html.text;
    const pm = await extract(await renderBillingPdfFromSnapshot(snapshot));
    out[`render.pdfmake.${key}.pages`] = String(pm.pages);
    out[`render.pdfmake.${key}.text`] = pm.text;
  }
  return out;
}
