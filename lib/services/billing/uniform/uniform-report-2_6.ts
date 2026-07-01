/**
 * WP3 — §2.6 output (פלטים לאימות נתונים) as a pdfmake docDefinition.
 * Pure: builds the object from the §2.6 data model; no pdfmake import here.
 */
import { displayMoney, type Report26Data } from "@/lib/services/billing/uniform/uniform-report-data";

export function buildReport26DocDefinition(data: Report26Data): Record<string, unknown> {
  const body: unknown[][] = [
    [
      { text: "מספר", bold: true },
      { text: "סוג המסמך", bold: true },
      { text: "סה\"כ כמותי", bold: true },
      { text: "סה\"כ כספי כולל מע\"מ (בש\"ח)", bold: true },
    ],
    ...data.rows.map((r) => [r.code, r.name, String(r.count), displayMoney(r.sumInclVat)]),
    [
      { text: "סה\"כ", bold: true },
      "",
      { text: String(data.totalCount), bold: true },
      { text: displayMoney(data.totalSum), bold: true },
    ],
  ];

  return {
    pageSize: "A4",
    pageMargins: [30, 30, 30, 30],
    defaultStyle: { font: "NotoSansHebrew", fontSize: 9, alignment: "right" },
    content: [
      { text: "פלט 2.6 — פלטים לאימות נתונים", fontSize: 14, bold: true, margin: [0, 0, 0, 6] },
      { text: `עוסק מורשה: ${data.vatNumber}   |   ${data.businessName}` },
      { text: `טווח תאריכים: ${data.periodStart} – ${data.periodEnd}`, margin: [0, 0, 0, 8] },
      {
        table: { headerRows: 1, widths: ["auto", "*", "auto", "auto"], body },
        layout: "lightHorizontalLines",
      },
    ],
  };
}
