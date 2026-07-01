/**
 * WP3 — §5.4 / appendix-4 output (ממשק משתמש — הדוח המודפס לאחר ההפקה) as a
 * pdfmake docDefinition. Pure builder from the §5.4 data model.
 */
import type { Report54Data } from "@/lib/services/billing/uniform/uniform-report-data";

export function buildReport54DocDefinition(data: Report54Data): Record<string, unknown> {
  const recordBody: unknown[][] = [
    [
      { text: "קוד רשומה", bold: true },
      { text: "תיאור רשומה", bold: true },
      { text: "סך רשומות", bold: true },
    ],
    ...data.recordRows.map((r) => [r.code, r.name, String(r.count)]),
  ];

  return {
    pageSize: "A4",
    pageMargins: [30, 30, 30, 30],
    defaultStyle: { font: "NotoSansHebrew", fontSize: 10, alignment: "right" },
    content: [
      { text: "הפקת קבצים במבנה אחיד עבור:", fontSize: 14, bold: true, margin: [0, 0, 0, 8] },
      { text: `מספר עוסק מורשה: ${data.vatNumber}` },
      { text: `שם בית העסק: ${data.businessName}` },
      { text: `מלל קבוע: ${data.constMessage}` },
      { text: `הנתונים נשמרו בנתיב: ${data.dirPath}` },
      {
        text: `טווח תאריכים: מתאריך ${data.periodStart} ועד תאריך ${data.periodEnd}`,
        margin: [0, 0, 0, 8],
      },
      {
        text: "פירוט סך סוגי הרשומות שנוצרו בקובץ BKMVDATA.TXT:",
        bold: true,
        margin: [0, 4, 0, 4],
      },
      {
        table: { headerRows: 1, widths: ["auto", "*", "auto"], body: recordBody },
        layout: "lightHorizontalLines",
      },
      {
        text: `הנתונים הופקו באמצעות תוכנת: ${data.softwareName}, מספר תעודת הרישום: ${data.softwareRegistrationNumber}`,
        margin: [0, 10, 0, 0],
      },
      { text: `בתאריך ${data.generatedDate} בשעה ${data.generatedTime}` },
    ],
  };
}
