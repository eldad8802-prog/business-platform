/**
 * The ONE field contract for historical fiscal import.
 *
 * Eleven columns, declared once. The template renders them, Analyze will map
 * and validate against them, and Execute will write from them — so there is no
 * second list to drift, which is the same rule `domain-fields.ts` already sets
 * for the tabular domains.
 *
 * # What is deliberately NOT here
 *
 * Nothing internal: no id, no businessId, no documentId, no importRunId, no
 * reversesHistoricalDocumentId, no createdAt, no updatedAt. An owner-facing
 * contract that exposes a database handle has failed, and a column an owner can
 * fill in with a foreign key is a way to write into another tenant's world.
 *
 * No customer address, email or phone either. The model can hold them, and v1
 * does not ask for them: there is no consumer for that data yet, and collecting
 * personal details with nothing to read them is a privacy cost with no product
 * benefit. Adding them later is a one-line change here.
 *
 * # Required means "a fiscal record is meaningless without it"
 *
 * Type, original number, date, total, currency and source system. Between them
 * they answer what the document is, which document it is, when it was issued,
 * what it was for, in what money, and who produced it. Drop any one and the row
 * stops being a fiscal record.
 *
 * Subtotal and VAT are optional because plenty of real exports carry only a
 * total, and refusing those histories to enforce arithmetic we were not given
 * would be inventing a requirement the source never had.
 *
 * The credited-document number is CONDITIONAL: meaningless on an invoice,
 * expected on a credit note. Analyze enforces the condition; the contract
 * records it.
 */

import type { DomainFieldSpec } from "@/lib/data-transfer/domain-fields";
import {
  HISTORICAL_CURRENCIES,
  HISTORICAL_TYPE_LABELS,
} from "@/lib/data-transfer/historical/historical-vocabulary";

/** Where a column lands on `HistoricalFiscalDocument`. */
export type HistoricalFieldTarget =
  | "documentTypeCode"
  | "originalDocumentNumber"
  | "originalIssueDate"
  | "totalAmount"
  | "subtotalAmount"
  | "vatAmount"
  | "currency"
  | "customerNameSnapshot"
  | "customerTaxIdSnapshot"
  | "sourceSystemCode"
  | "reversesOriginalNumberRaw";

export type HistoricalFieldSpec = DomainFieldSpec & {
  /** The model field this column becomes. One column, one target. */
  target: HistoricalFieldTarget;
  /**
   * True when the column is required only for some document types. `required`
   * stays false so the template says "רשות" rather than promising something
   * the owner cannot always supply; the condition is stated in `help`.
   */
  conditional?: boolean;
};

const TYPE_VALUES = Object.values(HISTORICAL_TYPE_LABELS);

/**
 * The canonical eleven, in the order the owner reads them: what the document
 * is, then what it says, then who it was for, then where it came from.
 */
export const HISTORICAL_FIELDS: readonly HistoricalFieldSpec[] = [
  {
    header: "סוג מסמך",
    target: "documentTypeCode",
    type: "text",
    width: 20,
    exportable: false,
    importable: true,
    required: true,
    help: "אחד מהערכים המותרים בלבד. הצעת מחיר אינה נקלטת כהיסטוריה פיסקלית.",
    example: "חשבונית מס",
    allowedValues: TYPE_VALUES,
  },
  {
    header: "מספר מסמך מקורי",
    target: "originalDocumentNumber",
    type: "text",
    width: 22,
    exportable: false,
    importable: true,
    required: true,
    help: "המספר שהמערכת הקודמת הדפיסה על המסמך, כפי שהוא. סמנו את העמודה כטקסט באקסל כדי לשמור אפסים מובילים.",
    example: "2024/0017",
  },
  {
    header: "תאריך המסמך",
    target: "originalIssueDate",
    type: "date",
    width: 16,
    exportable: false,
    importable: true,
    required: true,
    help: "התאריך שבו המערכת הקודמת הפיקה את המסמך.",
    example: "17/03/2024",
  },
  {
    header: "סכום כולל",
    target: "totalAmount",
    type: "number",
    width: 16,
    exportable: false,
    importable: true,
    required: true,
    help: "הסכום הסופי של המסמך, כולל מע״מ. עד שתי ספרות אחרי הנקודה.",
    example: "1170.00",
  },
  {
    header: "סכום לפני מע״מ",
    target: "subtotalAmount",
    type: "number",
    width: 18,
    exportable: false,
    importable: true,
    help: "אם המערכת הקודמת רשמה אותו. אם לא — השאירו ריק, לא נחשב אותו עבורכם.",
    example: "1000.00",
  },
  {
    header: "מע״מ",
    target: "vatAmount",
    type: "number",
    width: 14,
    exportable: false,
    importable: true,
    help: "אם המערכת הקודמת רשמה אותו. נשמר כפי שהוא, גם אם החישוב לא מסתדר.",
    example: "170.00",
  },
  {
    header: "מטבע",
    target: "currency",
    type: "text",
    width: 12,
    exportable: false,
    importable: true,
    required: true,
    help: "חובה לציין במפורש. לא נניח מטבע במקומכם.",
    example: "ILS",
    allowedValues: HISTORICAL_CURRENCIES,
  },
  {
    header: "שם לקוח",
    target: "customerNameSnapshot",
    type: "text",
    width: 28,
    exportable: false,
    importable: true,
    help: "השם כפי שהופיע על המסמך המקורי. נשמר כתצלום ולא מקושר לכרטיס לקוח בדוביז.",
    example: "חברת דוגמה בע״מ",
  },
  {
    header: "מספר עוסק / ח.פ. לקוח",
    target: "customerTaxIdSnapshot",
    type: "text",
    width: 22,
    exportable: false,
    importable: true,
    help: "8 או 9 ספרות, כפי שהופיע על המסמך. לא נוצר ולא מתעדכן כרטיס לקוח.",
    example: "512345678",
  },
  {
    header: "מערכת מקור",
    target: "sourceSystemCode",
    type: "text",
    width: 22,
    exportable: false,
    importable: true,
    required: true,
    help: 'שם המערכת שבה הופק המסמך. אם אין מערכת מסוימת, כתבו "ידני".',
    example: "ידני",
  },
  {
    header: "מספר מסמך שמזוכה",
    target: "reversesOriginalNumberRaw",
    type: "text",
    width: 22,
    exportable: false,
    importable: true,
    conditional: true,
    help: `רלוונטי ל"${HISTORICAL_TYPE_LABELS.CREDIT_NOTE}" בלבד: מספר המסמך המקורי שהזיכוי מבטל. אם המסמך המקורי לא מיובא — נשמר כטקסט.`,
    example: "2024/0011",
  },
] as const;

/** The owner-facing headers, in contract order. */
export const HISTORICAL_HEADERS: readonly string[] = HISTORICAL_FIELDS.map(
  (f) => f.header
);

export function historicalFieldByHeader(
  header: string
): HistoricalFieldSpec | undefined {
  return HISTORICAL_FIELDS.find((f) => f.header === header);
}

/** Fields the owner MUST supply on every row. */
export const HISTORICAL_REQUIRED_FIELDS: readonly HistoricalFieldSpec[] =
  HISTORICAL_FIELDS.filter((f) => f.required === true);

/** Fields required only for some document types. */
export const HISTORICAL_CONDITIONAL_FIELDS: readonly HistoricalFieldSpec[] =
  HISTORICAL_FIELDS.filter((f) => f.conditional === true);
