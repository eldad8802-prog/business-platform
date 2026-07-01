/**
 * WP3 — internal summary report (basis for the post-run simulator report) as a
 * pdfmake docDefinition. Mirrors the simulator's summary structure but only with
 * DECLARED counts (the official "נבדקו" column comes from the simulator itself).
 */
import type { SummaryData } from "@/lib/services/billing/uniform/uniform-report-data";

export function buildSummaryDocDefinition(data: SummaryData): Record<string, unknown> {
  const recordBody: unknown[][] = [
    [
      { text: "קוד רשומה", bold: true },
      { text: "תיאור רשומה", bold: true },
      { text: "סך שדווח", bold: true },
    ],
    ...data.recordRows.map((r) => [r.code, r.name, String(r.count)]),
    [{ text: "סה\"כ", bold: true }, "", { text: String(data.totalRecords), bold: true }],
  ];

  return {
    pageSize: "A4",
    pageMargins: [30, 30, 30, 30],
    defaultStyle: { font: "NotoSansHebrew", fontSize: 10, alignment: "right" },
    content: [
      { text: data.title, fontSize: 14, bold: true, margin: [0, 0, 0, 8] },
      { text: `שם יצרן התוכנה: ${data.vendorName}   |   ע"מ: ${data.vendorVatNumber}` },
      {
        text: `שם תוכנה ומהדורה: ${data.softwareName} ${data.softwareVersion}   |   מספר רישום: ${data.softwareRegistrationNumber}`,
      },
      { text: `הופק בתאריך ${data.generatedDate} בשעה ${data.generatedTime}`, margin: [0, 0, 0, 8] },
      { text: `סך רשומות בקובץ: ${data.totalRecords}`, bold: true, margin: [0, 0, 0, 4] },
      {
        table: { headerRows: 1, widths: ["auto", "*", "auto"], body: recordBody },
        layout: "lightHorizontalLines",
      },
      { text: data.note, italics: true, fontSize: 8, margin: [0, 10, 0, 0] },
    ],
  };
}
