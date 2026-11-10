/**
 * Purchase-order sheet — the server rendering of the EXISTING supplier order PDF. SERVER-ONLY.
 *
 * The document definition is the inventory module's own builder (buildSupplierPurchaseOrderDocDefinition), the one the
 * browser download uses; this file only supplies what the browser takes from its environment, the way the send screen
 * computes it in the same action:
 *   - the header line = the send screen's page title in the user's interface language ("<inventory> · Dubiz",
 *     app/layout.tsx title template; app/(shell)/inventory/layout.tsx meta.titles.inventory);
 *   - the date = formatSupplierDraftDisplayDate's rule (order date, else creation date) formatted he-IL, in Israel time.
 * Rendered with pdfmake's server printer and the same Hebrew font file the browser embeds (lib/pdf/hebrew-font-vfs).
 */
import type { Locale } from "@/lib/i18n/config";
import { getMessages } from "@/lib/i18n/messages";
import { hebrewFontVfs } from "@/lib/pdf/hebrew-font-vfs";
import {
  buildSupplierPurchaseOrderDocDefinition,
  SUPPLIER_ORDER_PDF_FONTS,
  type SupplierPurchaseDraftForDocument,
  type SupplierPurchaseOrderDocumentContext,
} from "@/lib/services/inventory/supplier-purchase-document.service";

const FONT_FILE = "NotoSansHebrew-Regular.ttf";

type PdfPrinterLike = { createPdfKitDocument(docDef: unknown): Promise<NodeJS.ReadableStream & { end: () => void }> };
let printer: PdfPrinterLike | null = null;

function getPrinter(): PdfPrinterLike {
  if (printer) return printer;
  // pdfmake's server printer is CJS-only (same loading as the billing renderer, which is not touched).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const PdfPrinter = require("pdfmake/js/Printer").default;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const URLResolver = require("pdfmake/js/URLResolver").default;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const vfs = require("pdfmake/js/virtual-fs").default;
  const base64 = (hebrewFontVfs as unknown as Record<string, string>)[FONT_FILE];
  if (!base64) throw new Error(`Hebrew font '${FONT_FILE}' is missing from lib/pdf/hebrew-font-vfs.ts`);
  vfs.writeFileSync(FONT_FILE, Buffer.from(base64, "base64"));
  printer = new PdfPrinter(SUPPLIER_ORDER_PDF_FONTS, vfs, new URLResolver(vfs)) as PdfPrinterLike;
  return printer;
}

/** The send screen's page title in the given interface language — what the browser download prints as its header. */
export function supplierOrderHeaderTitle(locale: Locale): string {
  return `${getMessages(locale).meta.titles.inventory} · Dubiz`;
}

/** formatSupplierDraftDisplayDate's rule, in Israel time (the browser formats in its own zone; the server is UTC). */
export function supplierOrderDisplayDate(draft: Pick<SupplierPurchaseDraftForDocument, "orderDate" | "createdAt">, now: Date = new Date()): string {
  const fmt = (d: Date) => d.toLocaleDateString("he-IL", { timeZone: "Asia/Jerusalem" });
  for (const v of [draft.orderDate, draft.createdAt]) {
    if (!v) continue;
    const d = v instanceof Date ? v : new Date(v);
    if (!Number.isNaN(d.getTime())) return fmt(d);
  }
  return fmt(now);
}

export async function renderSupplierOrderPdf(draft: SupplierPurchaseDraftForDocument, context: Required<SupplierPurchaseOrderDocumentContext>): Promise<Buffer> {
  const doc = await getPrinter().createPdfKitDocument(buildSupplierPurchaseOrderDocDefinition(draft, context));
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", (e: unknown) => reject(e));
    doc.end();
  });
}
