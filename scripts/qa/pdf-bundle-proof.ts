/**
 * Billing PDF still renders from the TRIMMED function bundle.
 *
 * Run after `next build`:
 *   npx tsx scripts/qa/pdf-bundle-proof.ts
 *
 * 1. Reads the PDF route's own trace (what Vercel packages into the function).
 * 2. Copies every traced project file (outside node_modules) into an isolated
 *    directory and makes it the working directory — the renderer resolves its
 *    Hebrew font as process.cwd()/public/fonts/…, exactly as in the function.
 * 3. Renders the same issued-invoice fixture with BOTH renderer families
 *    (HTML/Chromium — the production renderer — and pdfmake) and checks:
 *    a valid PDF, the Hebrew font embedded, and the Hebrew/number content
 *    extractable from the PDF text.
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { BillingDocument, BillingDocumentLine, Prisma } from "@prisma/client";
import { buildIssuedSnapshot } from "@/lib/services/billing/billing-issue.service";
import type { BillingIssuedSnapshotV1 } from "@/lib/services/billing/pdf/billing-pdf-template";
import { renderBillingPdfFromSnapshot } from "@/lib/services/billing/pdf/billing-pdf-renderer";
import { getNotoSansHebrewFontDataUri, renderBillingPdfHtmlFromSnapshot } from "@/lib/services/billing/pdf/billing-pdf-html-renderer";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}${extra !== undefined ? ` — ${String(extra)}` : ""}`);
  else {
    failed += 1;
    console.error(`FAIL: ${name}`, extra ?? "");
  }
}

function fixtureSnapshot(): BillingIssuedSnapshotV1 {
  const document = {
    id: 1, documentType: "TAX_INVOICE", status: "ISSUED", currency: "ILS",
    referenceDocumentId: null, customerNameSnapshot: "לקוח בדיקה",
  } as unknown as BillingDocument;
  const lines = [
    {
      lineIndex: 0, description: "שירות בדיקה",
      quantity: new Prisma.Decimal("1"), unitPrice: new Prisma.Decimal("100"),
      vatRatePercent: new Prisma.Decimal("17"), lineSubtotal: new Prisma.Decimal("100"),
      vatAmount: new Prisma.Decimal("17"), lineTotal: new Prisma.Decimal("117"),
    } as unknown as BillingDocumentLine,
  ];
  const business = {
    id: 1, name: "Dubiz",
    profile: {
      billingLegalName: "דוביז בע\"מ", billingBusinessKind: "LTD_COMPANY",
      billingTaxId: "515000123", billingVatNumber: "515000123",
      billingPhone: null, billingEmail: null, billingAddress: null,
      billingPaymentNote: null, billingFooterNote: null,
      billingLogoDataUrl: null, billingSignatureDataUrl: null, billingPdfTemplateStyle: null,
    },
  };
  const snap = buildIssuedSnapshot({
    document, lines, business,
    customer: { id: 7, name: "לקוח בדיקה", phone: null, email: null, city: "תל אביב", taxId: "514000000" },
    documentNumber: 7, documentNumberFormatted: "000007",
    issuedAt: new Date("2026-06-15T10:00:00.000Z"), actorUserId: 1,
    totals: { subtotalAmount: new Prisma.Decimal("100"), vatAmount: new Prisma.Decimal("17"), totalAmount: new Prisma.Decimal("117") },
  });
  return snap as unknown as BillingIssuedSnapshotV1;
}

async function pdfText(pdf: Buffer): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(pdf) });
  try {
    return (await parser.getText()).text;
  } finally {
    await parser.destroy();
  }
}

async function checkPdf(label: string, pdf: Buffer): Promise<void> {
  ok(`${label}: valid PDF header`, pdf.subarray(0, 5).toString() === "%PDF-", pdf.subarray(0, 8).toString());
  ok(`${label}: Hebrew font embedded (NotoSansHebrew)`, pdf.includes("NotoSansHebrew"));
  const text = await pdfText(pdf);
  const norm = text.replace(/\s+/g, " ");
  const rev = (s: string) => [...s].reverse().join("");
  // Whitespace-insensitive: pdfmake's text layer joins Hebrew words ("לקוחבדיקה").
  const flat = norm.replace(/\s+/g, "");
  const hasHebrew = (s: string) => [s, rev(s)].some((v) => flat.includes(v.replace(/\s+/g, "")));
  ok(`${label}: document number in the text`, norm.includes("000007"));
  ok(`${label}: Hebrew customer name in the text`, hasHebrew("לקוח בדיקה"), norm.slice(0, 160));
  ok(`${label}: total 117 in the text`, /117/.test(norm));
}

(async () => {
  const root = process.cwd();
  const traceFile = join(root, ".next", "server", "app", "api", "billing", "documents", "[id]", "pdf", "route.js.nft.json");
  ok("PDF route trace exists (run next build first)", existsSync(traceFile), traceFile);
  const { files } = JSON.parse(readFileSync(traceFile, "utf8")) as { files: string[] };
  const traced = files.map((f) => relative(root, resolve(dirname(traceFile), f)).split(sep).join("/"));
  ok("trace carries no qa-evidence", traced.every((f) => !f.startsWith("qa-evidence/")), traced.filter((f) => f.startsWith("qa-evidence/")).length);

  // Isolated bundle: only traced project files (node_modules resolve from source).
  const bundle = mkdtempSync(join(tmpdir(), "pdf-fn-bundle-"));
  let copied = 0;
  for (const f of traced) {
    if (f.includes("node_modules/") || f.startsWith("..")) continue;
    const src = join(root, f);
    if (!existsSync(src) || !lstatSync(src).isFile()) continue;
    const dst = join(bundle, f);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    copied += 1;
  }
  console.log(`isolated bundle: ${copied} traced project files → ${bundle}`);
  process.chdir(bundle);
  ok("font is present inside the bundle (process.cwd()/public/fonts)", existsSync(join(process.cwd(), "public", "fonts", "NotoSansHebrew-Regular.ttf")));
  ok("renderer resolves the font from the bundle", getNotoSansHebrewFontDataUri().startsWith("data:font/ttf;base64,"));

  const snap = fixtureSnapshot();
  const html = await renderBillingPdfHtmlFromSnapshot(snap);
  await checkPdf("HTML/Chromium (production renderer)", html);
  const pdfmake = await renderBillingPdfFromSnapshot(snap);
  await checkPdf("pdfmake (legacy renderer)", pdfmake);

  process.chdir(root);
  const outDir = join(root, "qa-evidence", "pdf-bundle-proof");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "invoice-html-chromium.pdf"), html);
  writeFileSync(join(outDir, "invoice-pdfmake.pdf"), pdfmake);
  console.log(`PDFs written to ${relative(root, outDir)}`);

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nPDF renders correctly from the trimmed function bundle (both renderer families).");
})().catch((e) => {
  console.error("RUNNER ERROR:", (e as Error).stack || (e as Error).message);
  process.exit(1);
});
