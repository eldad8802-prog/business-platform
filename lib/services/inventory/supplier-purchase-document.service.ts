/* eslint-disable @typescript-eslint/no-explicit-any -- pdfmake ships no usable types (pre-existing casts) */
import pdfMake from "pdfmake/build/pdfmake";
import pdfFonts from "pdfmake/build/vfs_fonts";
import { hebrewFontVfs } from "@/lib/pdf/hebrew-font-vfs";
import { rtlInlines } from "@/lib/text/rtl-inline-text";
import { formatQtyNumber, qtyWithUnit, unitWord } from "@/lib/inventory/unit-words";

/** Minimal draft shape for building supplier order text / PDF (client-side). */
export type SupplierPurchaseDraftLineForDocument = {
  rawName: string | null;
  quantity: number;
  unitType: string | null;
};

export type SupplierPurchaseDraftForDocument = {
  id: number;
  supplierName: string | null;
  externalOrderId?: string | null;
  orderDate?: string | Date | null;
  createdAt?: string | Date | null;
  lines: SupplierPurchaseDraftLineForDocument[];
};

export function formatSupplierDraftDisplayDate(
  draft: SupplierPurchaseDraftForDocument
): string {
  if (draft.orderDate) {
    const d =
      draft.orderDate instanceof Date
        ? draft.orderDate
        : new Date(draft.orderDate);
    if (!Number.isNaN(d.getTime())) return d.toLocaleDateString("he-IL");
  }
  if (draft.createdAt) {
    const d =
      draft.createdAt instanceof Date
        ? draft.createdAt
        : new Date(draft.createdAt);
    if (!Number.isNaN(d.getTime())) return d.toLocaleDateString("he-IL");
  }
  return new Date().toLocaleDateString("he-IL");
}

export function buildSupplierOrderText(
  draft: SupplierPurchaseDraftForDocument
): string {
  const supplierName = draft.supplierName || "ספק";
  const displayDate = formatSupplierDraftDisplayDate(draft);

  const linesText = draft.lines
    .map((line, index) => {
      const name = line.rawName || "מוצר ללא שם";
      // Unit words, never raw codes ("5 מארזים", not "5 BOX").
      return `${index + 1}. ${name} — ${qtyWithUnit(Number(line.quantity), line.unitType)}`;
    })
    .join("\n");

  return `שלום,
נשמח לבצע הזמנה מספק.

ספק: ${supplierName}
מספר הזמנה: #${draft.id}
תאריך: ${displayDate}

מוצרים להזמנה:
${linesText}

תודה.`;
}

export function openWhatsAppWithSupplierOrderText(orderText: string): void {
  const encodedText = encodeURIComponent(orderText);
  window.open(`https://wa.me/?text=${encodedText}`, "_blank");
}

export function buildSupplierOrderMailto(
  subject: string,
  body: string
): string {
  const params = new URLSearchParams();
  params.set("subject", subject);
  params.set("body", body);
  return `mailto:?${params.toString()}`;
}

export function openSupplierOrderMailto(subject: string, body: string): void {
  window.location.href = buildSupplierOrderMailto(subject, body);
}

type DownloadPdfOptions = {
  /** Shown in PDF header; defaults to `document.title` in browser. */
  windowTitle?: string;
};

/** The two values the browser takes from its environment; a server rendering passes them explicitly. */
export type SupplierPurchaseOrderDocumentContext = {
  /** The header line (the browser uses its `document.title`). */
  headerTitle: string;
  /** The date shown (the browser formats it in its own time zone); defaults to formatSupplierDraftDisplayDate. */
  displayDate?: string;
};

/** The font family the document uses, mapped to the Hebrew font file — the same mapping in browser and server. */
export const SUPPLIER_ORDER_PDF_FONTS = {
  Hebrew: {
    normal: "NotoSansHebrew-Regular.ttf",
    bold: "NotoSansHebrew-Regular.ttf",
    italics: "NotoSansHebrew-Regular.ttf",
    bolditalics: "NotoSansHebrew-Regular.ttf",
  },
};

export function downloadSupplierPurchaseOrderPdf(
  draft: SupplierPurchaseDraftForDocument,
  options?: DownloadPdfOptions
): void {
  const pdf = pdfMake as any;

  const customVfs = {
    ...((pdfFonts as any).pdfMake?.vfs || (pdfFonts as any).vfs || {}),
    ...hebrewFontVfs,
  };

  pdf.vfs = customVfs;

  if (typeof pdf.addVirtualFileSystem === "function") {
    pdf.addVirtualFileSystem(customVfs);
  }

  const fonts = SUPPLIER_ORDER_PDF_FONTS;

  pdf.fonts = fonts;

  const headerTitle =
    options?.windowTitle?.trim() ||
    (typeof document !== "undefined" ? document.title : "").trim();

  const docDefinition = buildSupplierPurchaseOrderDocDefinition(draft, { headerTitle });

  pdf
    .createPdf(docDefinition, undefined, fonts, customVfs)
    .download(`supplier-order-${draft.id}.pdf`);
}

/**
 * The supplier order PDF's pdfmake document definition — the SAME content and design the browser download uses.
 * Pure: no window / document access, no pdfmake globals; font family "Hebrew" (SUPPLIER_ORDER_PDF_FONTS).
 */
export function buildSupplierPurchaseOrderDocDefinition(
  draft: SupplierPurchaseDraftForDocument,
  context: SupplierPurchaseOrderDocumentContext
): any {
  // pdfmake has no bidi: every text goes out as direction runs in visual order (lib/text/rtl-inline-text)
  const rtlText = rtlInlines;

  const supplierName = draft.supplierName || "ספק";
  const today = context.displayDate ?? formatSupplierDraftDisplayDate(draft);
  const headerTitle = context.headerTitle;

  const totalUnits = draft.lines.reduce(
    (sum, line) => sum + Number(line.quantity || 0),
    0
  );

  const metaRows: any[][] = [
    [
      { text: rtlText(supplierName), style: "metaValue" },
      { text: rtlText("ספק"), style: "metaLabel" },
    ],
    [
      { text: `#${draft.id}`, style: "metaValue" },
      { text: rtlText("מספר הזמנה"), style: "metaLabel" },
    ],
  ];

  const ext = draft.externalOrderId?.trim();
  if (ext) {
    metaRows.push([
      { text: rtlText(ext), style: "metaValue" },
      { text: rtlText("מספר חיצוני"), style: "metaLabel" },
    ]);
  }

  metaRows.push([
    { text: today, style: "metaValue" },
    { text: rtlText("תאריך"), style: "metaLabel" },
  ]);

  const docDefinition: any = {
    pageSize: "A4",
    pageMargins: [40, 40, 40, 40],
    footer: (currentPage: number, pageCount: number) => ({
      margin: [40, 0, 40, 22],
      font: "Hebrew",
      fontSize: 9,
      color: "#9ca3af",
      columns: [
        { text: rtlText("נוצר אוטומטית במערכת"), alignment: "left" },
        {
          alignment: "right",
          columns: [
            { width: "auto", text: rtlText("עמוד"), style: "pageFooterText" },
            { width: 6, text: "" },
            {
              width: "auto",
              text: String(currentPage),
              style: "pageFooterPage",
            },
            { width: 10, text: "" },
            { width: "auto", text: rtlText("מתוך"), style: "pageFooterText" },
            { width: 6, text: "" },
            {
              width: "auto",
              text: String(pageCount),
              style: "pageFooterPage",
            },
          ],
          columnGap: 0,
        },
      ],
    }),

    defaultStyle: {
      font: "Hebrew",
      fontSize: 11,
      alignment: "right",
    },

    content: [
      {
        text: rtlText(headerTitle),
        style: "businessName",
        margin: [0, 0, 0, 4],
      },
      {
        text: rtlText("הזמנה לספק"),
        style: "header",
        margin: [0, 0, 0, 12],
      },

      {
        margin: [0, 0, 0, 18],
        table: {
          widths: ["*", 110],
          body: metaRows,
        },
        layout: {
          fillColor: () => "#f9fafb",
          hLineColor: () => "#e5e7eb",
          vLineColor: () => "#e5e7eb",
          hLineWidth: (i: number) =>
            i === 0 || i === metaRows.length ? 1 : 0.75,
          vLineWidth: () => 1,
          paddingTop: () => 8,
          paddingBottom: () => 8,
          paddingLeft: () => 10,
          paddingRight: () => 10,
        },
      },

      {
        text: rtlText("פירוט מוצרים"),
        style: "sectionTitle",
        margin: [0, 0, 0, 8],
      },

      {
        table: {
          headerRows: 1,
          widths: [35, 65, 70, "*"],
          body: [
            [
              { text: "#", style: "tableHeader", alignment: "center" },
              {
                text: rtlText("יחידה"),
                style: "tableHeader",
                alignment: "center",
              },
              {
                text: rtlText("כמות"),
                style: "tableHeader",
                alignment: "center",
              },
              { text: rtlText("מוצר"), style: "tableHeader", alignment: "right" },
            ],
            ...draft.lines.map((line, index) => [
              { text: String(index + 1), alignment: "center" },
              { text: rtlText(unitWord(line.unitType, Number(line.quantity))), alignment: "center" },
              { text: formatQtyNumber(Number(line.quantity)), alignment: "center" },
              {
                text: rtlText(line.rawName || "מוצר ללא שם"),
                alignment: "right",
              },
            ]),
          ],
        },

        layout: {
          fillColor: (rowIndex: number) => {
            if (rowIndex === 0) return "#eef2ff";
            return rowIndex % 2 === 0 ? "#fbfdff" : null;
          },
          hLineWidth: (i: number) => (i === 0 || i === 1 ? 1.2 : 0.75),
          hLineColor: () => "#e5e7eb",
          vLineWidth: () => 0.75,
          vLineColor: () => "#e5e7eb",
          paddingTop: () => 9,
          paddingBottom: () => 9,
          paddingLeft: () => 10,
          paddingRight: () => 10,
        },

        margin: [0, 0, 0, 18],
      },

      {
        margin: [0, 0, 0, 14],
        table: {
          widths: ["*", 110],
          body: [
            [
              { text: String(draft.lines.length), style: "summaryValue" },
              { text: rtlText("סה״כ פריטים"), style: "summaryLabel" },
            ],
            [
              { text: String(totalUnits), style: "summaryValue" },
              { text: rtlText("סה״כ יחידות"), style: "summaryLabel" },
            ],
          ],
        },
        layout: {
          fillColor: () => "#ffffff",
          hLineColor: () => "#e5e7eb",
          vLineColor: () => "#ffffff",
          hLineWidth: (i: number) => (i === 0 || i === 2 ? 0 : 0.75),
          vLineWidth: () => 0,
          paddingTop: () => 6,
          paddingBottom: () => 6,
          paddingLeft: () => 0,
          paddingRight: () => 0,
        },
      },

      {
        text: rtlText("תודה רבה."),
        style: "footer",
      },
    ],

    styles: {
      businessName: {
        fontSize: 14,
        bold: true,
        color: "#111827",
      },
      header: {
        fontSize: 22,
        bold: true,
      },

      metaLabel: {
        fontSize: 11,
        bold: true,
        color: "#111827",
        alignment: "right",
      },
      metaValue: {
        fontSize: 11,
        color: "#374151",
        alignment: "right",
      },

      sectionTitle: {
        fontSize: 14,
        bold: true,
      },

      tableHeader: {
        bold: true,
        color: "#111827",
      },

      summaryLabel: {
        bold: true,
        fontSize: 12,
        alignment: "right",
        color: "#111827",
      },
      summaryValue: {
        bold: true,
        fontSize: 12,
        alignment: "right",
        color: "#111827",
      },

      footer: {
        margin: [0, 10, 0, 0],
      },
      pageFooterText: {
        color: "#9ca3af",
      },
      pageFooterPage: {
        color: "#6b7280",
        bold: true,
      },
    },
  };

  return docDefinition;
}
