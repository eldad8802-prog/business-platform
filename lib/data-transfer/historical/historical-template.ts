/**
 * The XLSX template for historical fiscal import.
 *
 * Built through the SAME workbook builder the four tabular domains use — two
 * sheets, RTL, a header-only data sheet, a guide that explains every field —
 * so an owner who has downloaded a Dubiz template before recognises this one
 * immediately.
 *
 * # Why it is not routed through `buildImportTemplate`
 *
 * That function looks the domain up in `EXPORT_DESCRIPTORS`, and the historical
 * domain must stay out of that list: `isExportableDomainId` is derived from it,
 * and every import route gates on that predicate. Registering the domain there
 * to obtain a template would quietly hand analyze, preview and execute a domain
 * none of them can serve.
 *
 * # The four things the guide must make unmistakable
 *
 * An owner who misreads this template does not produce a broken row, they
 * produce a fiscal record that claims something untrue. So the notes below lead
 * the guide sheet, before the general formatting rules:
 *
 *   1. these are documents ANOTHER system issued
 *   2. the number is the ORIGINAL number, not a Dubiz number
 *   3. currency is required and will not be assumed
 *   4. importing issues nothing — no number is drawn, nothing is filed
 *
 * # Not routed anywhere yet
 *
 * Nothing serves this file to an owner. The template exists so I-8B.2 Analyze
 * has a contract to read against, and a download link would be navigation to a
 * flow that cannot yet do anything.
 */

import {
  buildTemplateWorkbook,
  type FormatNote,
  type ImportTemplate,
} from "@/lib/data-transfer/templates/template-builder";
import { HISTORICAL_FIELDS } from "@/lib/data-transfer/historical/historical-fields";
import { HISTORICAL_TYPE_LABELS } from "@/lib/data-transfer/historical/historical-vocabulary";

/** `dubiz-historical-documents-template-2026-09-08.xlsx` */
export const HISTORICAL_TEMPLATE_SLUG = "historical-documents";

/** The notes that carry the meaning of this template, before the generic ones. */
export const HISTORICAL_GUIDE_NOTES: readonly FormatNote[] = [
  {
    title: "מה הקובץ הזה",
    body: "רשימת מסמכים שהפקתם במערכת אחרת לפני שעברתם לדוביז. הקליטה שומרת אותם כהיסטוריה בלבד.",
  },
  {
    title: "דוביז לא מפיקה כאן מסמך",
    body: "הקליטה לא מנפיקה מסמך חדש, לא מקצה מספר של דוביז, לא מפיקה PDF ולא מדווחת לרשות המסים. המסמכים נשמרים כפי שהם.",
  },
  {
    title: "מספר המסמך",
    body: "כתבו את המספר שהמערכת הקודמת הדפיסה, כולל לוכסנים, מקפים ואפסים מובילים. אל תמציאו מספר חדש.",
  },
  {
    title: "מטבע",
    body: "עמודת המטבע היא חובה. לא נניח מטבע במקומכם, גם אם כל המסמכים בשקלים.",
  },
  {
    title: "זיכויים",
    body: `ב"${HISTORICAL_TYPE_LABELS.CREDIT_NOTE}" מלאו את מספר המסמך המקורי שהזיכוי מבטל. אם המסמך המקורי לא נמצא בקובץ — נשמור את המספר כטקסט.`,
  },
  {
    title: "סכומים שלא מסתדרים",
    body: "אם סכום לפני מע״מ ומע״מ לא מסתכמים לסכום הכולל, נשמור את שלושתם כפי שהם ונציג לכם התראה. לא נתקן מספרים היסטוריים.",
  },
];

/** Build the historical import template. Reads no business data. */
export function buildHistoricalImportTemplate(at: Date): Promise<ImportTemplate> {
  return buildTemplateWorkbook({
    domainId: "historical-documents",
    fields: HISTORICAL_FIELDS,
    fileSlug: HISTORICAL_TEMPLATE_SLUG,
    at,
    extraNotes: HISTORICAL_GUIDE_NOTES,
  });
}
