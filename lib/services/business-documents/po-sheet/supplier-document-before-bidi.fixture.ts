/**
 * TEST FIXTURE — a verbatim copy of buildSupplierPurchaseOrderDocDefinition as it was on origin/main 5d146aa2, before
 * the right-to-left text fix (lib/text/rtl-inline-text). supplier-document-unchanged.test.ts proves this copy still
 * produces the hashes recorded from the ORIGINAL browser download, and that the fixed builder differs from it only
 * in its text nodes, each the same text as direction runs. Never imported by application code.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- verbatim copy of an untyped pdfmake definition */
import { formatQtyNumber, unitWord } from "@/lib/inventory/unit-words";
import {
  formatSupplierDraftDisplayDate,
  type SupplierPurchaseDraftForDocument,
  type SupplierPurchaseOrderDocumentContext,
} from "@/lib/services/inventory/supplier-purchase-document.service";

export function buildSupplierPurchaseOrderDocDefinitionBeforeBidi(
  draft: SupplierPurchaseDraftForDocument,
  context: SupplierPurchaseOrderDocumentContext
): any {
  const nbsp = "\u00A0";
  const rtlText = (value: string) => value.replaceAll(" ", nbsp);

  const supplierName = draft.supplierName || "ספק";
  const today = context.displayDate ?? formatSupplierDraftDisplayDate(draft);
  const headerTitle = context.headerTitle;

  const totalUnits = draft.lines.reduce(
    (sum, line) => sum + Number(line.quantity || 0),
    0
  );

  const metaRows: any[][] = [
    [
      { text: supplierName, style: "metaValue" },
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
      { text: ext, style: "metaValue" },
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
                text: line.rawName || "מוצר ללא שם",
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
