// Billing PDF renderer — pure Node-side wrapper around pdfmake 0.3.x.
//
// Responsibilities (and only these):
//   • Lazily build a single PdfPrinter for the lifetime of the process.
//   • Register the Hebrew font once into pdfmake's virtual filesystem.
//   • Take a v1 issued snapshot, hand it to the template, and return a Buffer.
//
// This file is the ONLY place in the codebase allowed to import pdfmake or
// touch its virtual-fs singleton. It must NOT import from Prisma, fs, http,
// or any other Billing service.
//
// The require() pattern below mirrors the verified POC in
// tmp/billing-pdf-poc/render.ts. pdfmake 0.3.x ships CJS-only and its Node
// printer constructor lives at "pdfmake/js/Printer".default. Skipping
// URLResolver causes resolveUrls() to throw on first render.

import { hebrewFontVfs } from "@/lib/pdf/hebrew-font-vfs";
import {
  buildDocDefinition,
  type BillingIssuedSnapshotV1,
} from "@/lib/services/billing/pdf/billing-pdf-template";

const FONT_FILENAME = "NotoSansHebrew-Regular.ttf";
const FONT_NAME = "NotoSansHebrew";

const FONTS = {
  [FONT_NAME]: {
    normal: FONT_FILENAME,
    bold: FONT_FILENAME,
    italics: FONT_FILENAME,
    bolditalics: FONT_FILENAME,
  },
};

type PdfPrinterLike = {
  createPdfKitDocument(
    docDef: unknown
  ): Promise<NodeJS.ReadableStream & { end: () => void }>;
};

let _printer: PdfPrinterLike | null = null;

function loadFontBuffer(): Buffer {
  const vfsMap = hebrewFontVfs as unknown as Record<string, string>;
  const base64 = vfsMap[FONT_FILENAME];
  if (!base64 || typeof base64 !== "string") {
    throw new Error(
      `Hebrew font '${FONT_FILENAME}' is missing from lib/pdf/hebrew-font-vfs.ts`
    );
  }
  return Buffer.from(base64, "base64");
}

function getPrinter(): PdfPrinterLike {
  if (_printer) return _printer;

  // pdfmake is CJS-only. The dynamic require() is intentional and matches
  // the verified POC; switching to ESM imports breaks resolution.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const PdfPrinter = require("pdfmake/js/Printer").default;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const URLResolver = require("pdfmake/js/URLResolver").default;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const vfs = require("pdfmake/js/virtual-fs").default;

  // Register the Hebrew font into pdfmake's shared virtual-fs singleton.
  // Calling writeFileSync more than once with the same content is a no-op
  // beyond a buffer overwrite — harmless under hot reload in dev.
  vfs.writeFileSync(FONT_FILENAME, loadFontBuffer());

  const urlResolver = new URLResolver(vfs);
  _printer = new PdfPrinter(FONTS, vfs, urlResolver) as PdfPrinterLike;
  return _printer;
}

// Public: render a v1 issued snapshot into a single PDF Buffer.
//
// Returns a Buffer (not a stream) because the orchestrator must hash the
// full payload (sha256) before deciding the storage key. PDFs in this
// domain are small (< ~100KB), so the memory cost is negligible.
export async function renderBillingPdfFromSnapshot(
  snapshot: BillingIssuedSnapshotV1
): Promise<Buffer> {
  if (process.env.BILLING_PDF_DEBUG_LOG === "1") {
    const firstLine = snapshot.lines[0]?.description ?? "(no lines)";
    console.log("[billing-pdf-debug] ENTER renderBillingPdfFromSnapshot (pdfmake)", {
      customerNameFromSnapshot: snapshot.customer.name,
      firstLineDescriptionFromSnapshot: firstLine,
    });
  }

  const printer = getPrinter();
  const docDef = buildDocDefinition(snapshot);
  const doc = await printer.createPdfKitDocument(docDef);

  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", (err: unknown) => reject(err));
    doc.end();
  });
}
