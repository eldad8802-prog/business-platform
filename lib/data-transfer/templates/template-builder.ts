/**
 * Import templates — the file an owner downloads to prepare their data.
 *
 * # Two sheets, and why the examples are NOT on the data sheet
 *
 *   Sheet 1  ייבוא     header row only
 *   Sheet 2  הוראות    one row per field: name, required, type, explanation,
 *                      example, allowed values
 *
 * A worked example is what makes a template usable — a bare header row leaves
 * the owner guessing what "יחידת מידה" wants. But an example row sitting in the
 * sheet they will fill in and upload is a data-integrity trap: it looks like
 * their data, it is easy to miss, and a future import would happily create a
 * customer named "ישראל ישראלי". Splitting them means the examples are always
 * visible and can never be uploaded by accident.
 *
 * # Fields
 *
 * Derived from the SAME per-domain field list the export uses
 * (`lib/data-transfer/domain-fields.ts`), filtered to `importable`. There is no
 * second column list to drift, and the verifier asserts the derivation rather
 * than a hardcoded expectation.
 *
 * # Privacy
 *
 * Generation reads NO business data. No query, no tenant tables, no
 * businessId, no userId, no internal ids. Given a domain the output is
 * byte-deterministic apart from the date in its file name — which is asserted,
 * because a template that varied per tenant would mean it had touched tenant
 * data.
 */

import {
  buildXlsxBuffer,
  type XlsxColumn,
  type XlsxSheetSpec,
} from "@/lib/data-transfer/format/xlsx-writer";
import type { SheetCell } from "@/lib/data-transfer/format/table.types";
import {
  importableFields,
  type DomainFieldSpec,
} from "@/lib/data-transfer/domain-fields";
import type { DataTransferDomainId } from "@/lib/data-transfer/domains";
import {
  EXPORT_DESCRIPTORS,
  isExportableDomainId,
} from "@/lib/data-transfer/export/export-registry";
import { israelDateStamp } from "@/lib/data-transfer/export/export-package";

/** Sheet the owner fills in and will later upload. */
export const TEMPLATE_DATA_SHEET = "ייבוא";
/** Sheet that explains it. Never uploaded. */
export const TEMPLATE_GUIDE_SHEET = "הוראות";

/** Guide columns, in reading order for a Hebrew RTL sheet. */
const GUIDE_COLUMNS: XlsxColumn[] = [
  { header: "שדה", type: "text", width: 24 },
  { header: "חובה?", type: "text", width: 10 },
  { header: "סוג הנתון", type: "text", width: 16 },
  { header: "הסבר", type: "text", width: 58 },
  { header: "דוגמה", type: "text", width: 26 },
  { header: "ערכים מותרים", type: "text", width: 46 },
];

/** Owner-facing name for a cell type. Never the internal token. */
const TYPE_LABELS: Record<string, string> = {
  text: "טקסט",
  integer: "מספר שלם",
  number: "מספר",
  currency: "סכום בשקלים",
  date: "תאריך",
  datetime: "תאריך ושעה",
};

/**
 * The format contract the owner is being asked to honour. Stated here, in the
 * file itself, because the owner reads the template — not our docs. I-5
 * implements the reading and normalization of exactly this.
 */
type FormatNote = {
  title: string;
  body: string;
  /**
   * When present, the note only appears if the domain actually has a field it
   * applies to. A "how to write dates" note on a template with no date column
   * is noise, and noise in instructions is how the useful lines get skipped.
   */
  appliesTo?: (fields: readonly DomainFieldSpec[]) => boolean;
};

const hasType = (...types: string[]) =>
  (fields: readonly DomainFieldSpec[]) =>
    fields.some((f) => types.includes(f.type));

const hasHeaderContaining = (...needles: string[]) =>
  (fields: readonly DomainFieldSpec[]) =>
    fields.some((f) => needles.some((n) => f.header.includes(n)));

const FORMAT_NOTES: readonly FormatNote[] = [
  {
    title: "איך למלא",
    body: 'מלאו את הגיליון "ייבוא" — כל שורה היא רשומה אחת. הגיליון הזה נועד להסבר בלבד ולא נקלט.',
  },
  {
    title: "תאריכים",
    body: "כתבו תאריך בפורמט יום/חודש/שנה — לדוגמה 03/04/2026 הוא ה-3 באפריל. בשלב הייבוא תוכלו לאשר את הפורמט לפני הקליטה.",
    appliesTo: hasType("date", "datetime"),
  },
  {
    title: "מספרים וסכומים",
    body: "מספר בלבד, בלי ₪ ובלי פסיקים. נקודה עשרונית — לדוגמה 1250.50.",
    appliesTo: hasType("number", "integer", "currency"),
  },
  {
    title: "טלפונים",
    body: "כל צורה מקובלת עובדת: 050-123-4567 או 0501234567 או 972501234567.",
    appliesTo: hasHeaderContaining("טלפון"),
  },
  {
    title: "מק״ט וברקוד",
    body: "סמנו את העמודה כטקסט באקסל, אחרת אפסים מובילים יימחקו.",
    appliesTo: hasHeaderContaining("מק״ט", "ברקוד"),
  },
  { title: "שורות ריקות", body: "שורה ריקה לגמרי פשוט תדולג." },
  {
    title: "עמודות",
    body: 'אל תשנו את שמות העמודות בגיליון "ייבוא". אפשר להשאיר עמודת רשות ריקה לגמרי.',
  },
];

function typeLabel(field: DomainFieldSpec): string {
  return TYPE_LABELS[field.type] ?? field.type;
}

function guideRows(fields: readonly DomainFieldSpec[]): SheetCell[][] {
  const fieldRows: SheetCell[][] = fields.map((f) => [
    f.header,
    f.required ? "חובה" : "רשות",
    typeLabel(f),
    f.help ?? null,
    f.example ?? null,
    f.allowedValues ? f.allowedValues.join(" · ") : null,
  ]);

  // A blank separator, then the cross-cutting format rules that APPLY to this
  // domain. Kept on the guide sheet so the contract travels WITH the file the
  // owner is working in.
  const notes: SheetCell[][] = FORMAT_NOTES.filter(
    (note) => !note.appliesTo || note.appliesTo(fields)
  ).map((note) => [note.title, null, null, note.body, null, null]);

  return [...fieldRows, [null, null, null, null, null, null], ...notes];
}

export type ImportTemplate = {
  domainId: DataTransferDomainId;
  body: Buffer;
  filename: string;
  contentType: string;
  /** Importable field headers, in template order. Exposed for verification. */
  headers: string[];
};

/** `dubiz-customers-template-2026-09-03.xlsx` */
export function buildTemplateFilename(
  fileSlug: string,
  at: Date,
  extension = "xlsx"
): string {
  return `dubiz-${fileSlug}-template-${israelDateStamp(at)}.${extension}`;
}

export function isTemplateDomainId(
  value: unknown
): value is DataTransferDomainId {
  return isExportableDomainId(value);
}

/** Build the two-sheet XLSX template for one domain. */
export async function buildImportTemplate(
  domainId: DataTransferDomainId,
  at: Date
): Promise<ImportTemplate> {
  const descriptor = EXPORT_DESCRIPTORS.find((d) => d.id === domainId);
  if (!descriptor) {
    throw new Error(`No import template for domain: ${domainId}`);
  }

  const fields = importableFields(descriptor.columns);
  if (fields.length === 0) {
    throw new Error(`Domain has no importable fields: ${domainId}`);
  }

  const dataSheet: XlsxSheetSpec = {
    name: TEMPLATE_DATA_SHEET,
    columns: fields.map((f) => ({
      header: f.header,
      type: f.type,
      width: f.width,
    })),
    // Header row only. See the module note on why examples live elsewhere.
    rows: [],
    rightToLeft: true,
    freezeHeader: true,
    // Nothing to filter in an empty sheet, and a filter on a blank range is
    // noise in the owner's first impression of the file.
    autoFilter: false,
  };

  const guideSheet: XlsxSheetSpec = {
    name: TEMPLATE_GUIDE_SHEET,
    columns: GUIDE_COLUMNS,
    rows: guideRows(fields),
    rightToLeft: true,
    freezeHeader: false,
    autoFilter: false,
  };

  const body = await buildXlsxBuffer([dataSheet, guideSheet]);

  return {
    domainId,
    body,
    filename: buildTemplateFilename(descriptor.fileSlug, at),
    contentType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    headers: fields.map((f) => f.header),
  };
}
