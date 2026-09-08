/**
 * Historical fiscal Analyze — read, map, normalize, validate. ZERO writes.
 *
 * # What this reuses, and the one place it does not
 *
 * The file half is entirely the proven engine: `readImportSource` decides the
 * accepted types, the size and row ceilings and WHICH SHEET is the data, and
 * `proposeMapping` matches headers deterministically. Neither is reimplemented
 * here, and the historical aliases live in the same per-domain registry as
 * everyone else's.
 *
 * The ROW half is its own. `validateRows` is the tabular validator: it carries
 * per-domain maximum-length tables keyed by "customers"/"leads", and it
 * normalizes through `value-normalize`, whose numbers are JavaScript numbers
 * and which has no date parser at all. Teaching it fiscal semantics would mean
 * putting Decimal arithmetic, an explicit date-format contract and VAT
 * consistency into the validator every other domain shares — widening the
 * blast radius of a fiscal rule to four domains that have no fiscal meaning.
 * So this is a narrow adapter, and the fiscal rules stay where the fiscal
 * boundary is.
 *
 * # What Analyze deliberately does NOT do
 *
 * It writes nothing — no record, no run, no marker, no document, no customer.
 * It performs no database read either: the question is "what is in this file",
 * not "what does it collide with". Duplicate policy is I-8B.3, reversal
 * resolution is I-8B.3, and the preview token is I-8B.4. The identity material
 * a duplicate check will need is prepared per row so that phase does not have
 * to parse the file again.
 *
 * # Determinism
 *
 * The same bytes, the same sheet, the same mapping and the same date-format
 * choice produce the same analysis, and `analysisHash` binds all four. Change
 * any of them and the identity changes — which matters most for the date
 * format, because that single choice decides which month a document belongs to.
 */

import { Prisma } from "@prisma/client";

import {
  canonicalizeMapping,
  proposeMapping,
  type ColumnProposal,
  type ResolvedMapping,
} from "@/lib/data-transfer/import/mapping/mapping-proposer";
import { readImportSource } from "@/lib/data-transfer/import/import-source";
import { sha256Hex } from "@/lib/data-transfer/import/preview/preview-token";
import { IMPORT_MAPPING_SAMPLE_VALUES } from "@/lib/data-transfer/import/import-config";
import {
  HISTORICAL_FIELDS,
  type HistoricalFieldSpec,
  type HistoricalFieldTarget,
} from "@/lib/data-transfer/historical/historical-fields";
import {
  normalizeFiscalDate,
  type DateFormatContract,
} from "@/lib/data-transfer/historical/historical-date";
import { normalizeFiscalAmount } from "@/lib/data-transfer/historical/historical-money";
import {
  normalizeCustomerTaxIdSnapshot,
  normalizeHistoricalCurrency,
  normalizeHistoricalDocumentType,
  normalizeHistoricalSourceSystem,
} from "@/lib/data-transfer/historical/historical-vocabulary";

/** Version of the normalization contract, folded into the analysis identity. */
const ANALYSIS_CONTRACT_VERSION = "historical-analyze:v1";

/* ------------------------------------------------------------- codes ----- */

/**
 * Structural codes. They never carry a value from the file — a code that
 * embedded a customer name or an amount would put business data into logs and
 * telemetry, which is the one thing an error code must not do.
 */
export type HistoricalRowErrorCode =
  | "MISSING_DOCUMENT_TYPE"
  | "UNKNOWN_DOCUMENT_TYPE"
  | "MISSING_DOCUMENT_NUMBER"
  | "MISSING_DATE"
  | "AMBIGUOUS_DATE"
  | "INVALID_DATE"
  | "UNSUPPORTED_DATE_FORMAT"
  | "MISSING_TOTAL"
  | "INVALID_AMOUNT"
  | "AMBIGUOUS_DECIMAL_COMMA"
  | "TOO_MANY_DECIMALS"
  | "AMOUNT_OUT_OF_RANGE"
  | "MISSING_CURRENCY"
  | "UNSUPPORTED_CURRENCY"
  | "MISSING_SOURCE_SYSTEM"
  | "INVALID_SOURCE_SYSTEM"
  | "INVALID_CUSTOMER_TAX_ID";

export type HistoricalRowWarningCode =
  | "FUTURE_ISSUE_DATE"
  | "SUBTOTAL_MISSING"
  | "VAT_ARITHMETIC_MISMATCH"
  | "CREDIT_NOTE_POSITIVE_AMOUNT"
  | "NON_CREDIT_NEGATIVE_AMOUNT"
  | "CREDIT_NOTE_WITHOUT_REFERENCE";

export type HistoricalMappingBlockerCode =
  | "MAPPING_REQUIRED_MISSING"
  | "MAPPING_DUPLICATE_TARGET"
  | "MAPPING_AMBIGUOUS";

/* ------------------------------------------------------------- shapes ---- */

export type HistoricalRowState = "READY" | "WARNING" | "ERROR";

/** One field, as the owner wrote it and as Dubiz read it. */
export type HistoricalFieldValue = {
  field: string;
  original: string;
  normalized: string | null;
};

export type HistoricalAnalyzedRow = {
  /** 1-based row number in the SOURCE file, header excluded. */
  sourceRowNumber: number;
  state: HistoricalRowState;
  errors: { field: string; code: HistoricalRowErrorCode; reason: string }[];
  warnings: { field: string; code: HistoricalRowWarningCode; reason: string }[];
  values: HistoricalFieldValue[];
  /**
   * The components a fiscal duplicate check will compare, normalized once here
   * so I-8B.3 never has to re-read the file. Business identity is server-side
   * and deliberately absent.
   */
  identity: {
    sourceSystemCode: string | null;
    documentTypeCode: string | null;
    originalDocumentNumber: string | null;
  };
};

export type HistoricalMappingEntry = {
  /** Canonical owner-facing column. */
  field: string;
  target: HistoricalFieldTarget;
  requirement: "required" | "optional" | "conditional";
  /** Header in the uploaded file, when one was matched. */
  sourceHeader: string | null;
  sourceIndex: number | null;
  status: "EXACT" | "SUGGESTED" | "AMBIGUOUS" | "UNMAPPED";
  /** Fields this header could equally be, when AMBIGUOUS. */
  candidates: string[];
};

export type HistoricalDateInterpretation = {
  /** How textual dates were read. `null` when the owner has not said. */
  suppliedFormat: DateFormatContract;
  /** True when every date in the file read one way only. */
  deterministic: boolean;
  /** Present when the file cannot be read without the owner choosing. */
  requirement: "DATE_FORMAT_REQUIRED" | null;
  choices: readonly ["DMY", "MDY"];
};

export type HistoricalAnalyzeResult =
  | {
      ok: false;
      code: string;
      message: string;
      availableSheets?: string[];
    }
  | {
      ok: true;
      file: {
        filename: string;
        format: "xlsx" | "csv";
        sheetName: string | null;
        availableSheets: string[];
        headers: string[];
        rowCount: number;
        contentHash: string;
      };
      mapping: {
        entries: HistoricalMappingEntry[];
        /** Source columns that matched nothing. Simply not imported. */
        unmappedSourceHeaders: string[];
        blockers: { code: HistoricalMappingBlockerCode; field: string; reason: string }[];
        mappingHash: string;
      };
      dateInterpretation: HistoricalDateInterpretation;
      summary: {
        totalRows: number;
        ready: number;
        warning: number;
        error: number;
        /** True when mapping blockers stopped the analysis before the rows. */
        stoppedAtMapping: boolean;
      };
      rows: HistoricalAnalyzedRow[];
      /** Binds bytes + sheet + mapping + date format + contract version. */
      analysisHash: string;
    };

export type HistoricalAnalyzeInput = {
  filename: string;
  bytes: Buffer;
  /** Chosen worksheet. `null` lets the source reader decide, or ask. */
  sheetName?: string | null;
  /** How textual dates are to be read. `null` when the owner has not said. */
  dateFormat?: DateFormatContract;
  /**
   * The owner's confirmed mapping, source column index -> canonical field.
   * `null` means "use what the proposer found", which resolves EXACT and
   * SUGGESTED matches and never resolves an AMBIGUOUS one.
   */
  mapping?: ResolvedMapping | null;
};

/* ------------------------------------------------------------ helpers ---- */

function requirementOf(field: HistoricalFieldSpec): HistoricalMappingEntry["requirement"] {
  if (field.required === true) return "required";
  return field.conditional === true ? "conditional" : "optional";
}

function cellText(cell: unknown): string {
  if (cell == null) return "";
  if (cell instanceof Date) return cell.toISOString();
  return String(cell).trim();
}

/**
 * Turn proposals into a mapping, resolving only what is unambiguous.
 *
 * EXACT and SUGGESTED are each a SINGLE match, so accepting them is reading the
 * header rather than choosing between readings. AMBIGUOUS is never resolved
 * here: that is a question for the owner, and answering it silently is how the
 * right value lands in the wrong column.
 */
function mappingFromProposals(proposals: readonly ColumnProposal[]): ResolvedMapping {
  const mapping: ResolvedMapping = {};
  for (const proposal of proposals) {
    if (proposal.field && (proposal.status === "EXACT" || proposal.status === "SUGGESTED")) {
      mapping[proposal.sourceIndex] = proposal.field;
    }
  }
  return mapping;
}

/** Decimal comparison, because JavaScript numbers cannot do fiscal equality. */
function decimalsAgree(subtotal: string, vat: string, total: string): boolean {
  const sum = new Prisma.Decimal(subtotal).plus(new Prisma.Decimal(vat));
  return sum.equals(new Prisma.Decimal(total));
}

function isNegative(amount: string): boolean {
  return new Prisma.Decimal(amount).isNegative();
}

function isPositive(amount: string): boolean {
  return new Prisma.Decimal(amount).greaterThan(0);
}

/* ------------------------------------------------------------ analyze ---- */

export async function analyzeHistoricalSource(
  input: HistoricalAnalyzeInput
): Promise<HistoricalAnalyzeResult> {
  const dateFormat: DateFormatContract = input.dateFormat ?? null;

  const source = await readImportSource({
    filename: input.filename,
    bytes: input.bytes,
    sheetName: input.sheetName ?? null,
  });
  if (!source.ok) {
    return {
      ok: false,
      code: source.code,
      message: source.message,
      availableSheets: source.availableSheets,
    };
  }

  const proposals = proposeMapping({
    domainId: "historical-documents",
    fields: HISTORICAL_FIELDS,
    headers: source.table.headers,
    sampleRows: source.table.rows,
    sampleCount: IMPORT_MAPPING_SAMPLE_VALUES,
  });

  const mapping = input.mapping ?? mappingFromProposals(proposals);

  // Canonical field -> the source columns claiming it. More than one is a
  // conflict the owner must resolve, not something to pick a winner from.
  const columnsFor = new Map<string, number[]>();
  for (const [rawIndex, field] of Object.entries(mapping)) {
    const index = Number(rawIndex);
    if (!Number.isInteger(index)) continue;
    columnsFor.set(field, [...(columnsFor.get(field) ?? []), index]);
  }

  const proposalByIndex = new Map(proposals.map((p) => [p.sourceIndex, p]));
  const blockers: { code: HistoricalMappingBlockerCode; field: string; reason: string }[] = [];

  const entries: HistoricalMappingEntry[] = HISTORICAL_FIELDS.map((field) => {
    const columns = columnsFor.get(field.header) ?? [];
    const index = columns.length > 0 ? columns[0] : null;
    const proposal = index === null ? null : proposalByIndex.get(index) ?? null;

    if (columns.length > 1) {
      blockers.push({
        code: "MAPPING_DUPLICATE_TARGET",
        field: field.header,
        reason: "יותר מעמודה אחת בקובץ הותאמה לאותו שדה",
      });
    }
    if (columns.length === 0 && field.required === true) {
      blockers.push({
        code: "MAPPING_REQUIRED_MISSING",
        field: field.header,
        reason: "עמודת חובה שלא נמצאה בקובץ",
      });
    }

    return {
      field: field.header,
      target: field.target,
      requirement: requirementOf(field),
      sourceHeader: proposal?.sourceHeader ?? null,
      sourceIndex: index,
      status: index === null ? "UNMAPPED" : proposal?.status ?? "EXACT",
      candidates: proposal?.candidates ?? [],
    };
  });

  for (const proposal of proposals) {
    if (proposal.status === "AMBIGUOUS") {
      blockers.push({
        code: "MAPPING_AMBIGUOUS",
        field: proposal.sourceHeader,
        reason: "הכותרת יכולה להתאים ליותר משדה אחד",
      });
    }
  }

  const unmappedSourceHeaders = proposals
    .filter((p) => !(p.sourceIndex in mapping))
    .map((p) => p.sourceHeader);

  const mappingHash = sha256Hex(canonicalizeMapping(mapping));
  const contentHash = sha256Hex(input.bytes);
  const analysisHash = sha256Hex(
    [
      ANALYSIS_CONTRACT_VERSION,
      `content:${contentHash}`,
      `sheet:${source.sheetName ?? ""}`,
      `mapping:${mappingHash}`,
      `dateFormat:${dateFormat ?? "UNSET"}`,
    ].join("\n")
  );

  const file = {
    filename: input.filename,
    format: source.kind,
    sheetName: source.sheetName,
    availableSheets: source.availableSheets,
    headers: [...source.table.headers],
    rowCount: source.table.rows.length,
    contentHash,
  };

  // A required column that is not mapped means no row can be judged: every one
  // of them would report the same missing field, which buries the real problem.
  if (blockers.length > 0) {
    return {
      ok: true,
      file,
      mapping: { entries, unmappedSourceHeaders, blockers, mappingHash },
      dateInterpretation: {
        suppliedFormat: dateFormat,
        deterministic: false,
        requirement: null,
        choices: ["DMY", "MDY"],
      },
      summary: {
        totalRows: source.table.rows.length,
        ready: 0,
        warning: 0,
        error: 0,
        stoppedAtMapping: true,
      },
      rows: [],
      analysisHash,
    };
  }

  const columnOf = new Map<string, number>();
  for (const entry of entries) {
    if (entry.sourceIndex !== null) columnOf.set(entry.field, entry.sourceIndex);
  }

  const rows: HistoricalAnalyzedRow[] = [];
  let ambiguousDates = 0;

  source.table.rows.forEach((row, index) => {
    // A row with nothing in any mapped column is the blank line at the end of a
    // spreadsheet, not a record.
    const hasAnyValue = [...columnOf.values()].some((c) => cellText(row[c]) !== "");
    if (!hasAnyValue) return;

    const analyzed = analyzeRow(row, columnOf, index + 1, dateFormat);
    if (analyzed.errors.some((e) => e.code === "AMBIGUOUS_DATE")) ambiguousDates += 1;
    rows.push(analyzed);
  });

  const dateInterpretation: HistoricalDateInterpretation = {
    suppliedFormat: dateFormat,
    deterministic: ambiguousDates === 0,
    requirement: ambiguousDates > 0 && dateFormat === null ? "DATE_FORMAT_REQUIRED" : null,
    choices: ["DMY", "MDY"],
  };

  return {
    ok: true,
    file,
    mapping: { entries, unmappedSourceHeaders, blockers, mappingHash },
    dateInterpretation,
    summary: {
      totalRows: rows.length,
      ready: rows.filter((r) => r.state === "READY").length,
      warning: rows.filter((r) => r.state === "WARNING").length,
      error: rows.filter((r) => r.state === "ERROR").length,
      stoppedAtMapping: false,
    },
    rows,
    analysisHash,
  };
}

/* --------------------------------------------------------------- row ----- */

function analyzeRow(
  row: readonly unknown[],
  columnOf: Map<string, number>,
  sourceRowNumber: number,
  dateFormat: DateFormatContract
): HistoricalAnalyzedRow {
  const errors: HistoricalAnalyzedRow["errors"] = [];
  const warnings: HistoricalAnalyzedRow["warnings"] = [];
  const values: HistoricalFieldValue[] = [];

  const raw = (header: string): unknown => {
    const index = columnOf.get(header);
    return index === undefined ? null : row[index];
  };
  const record = (field: string, original: string, normalized: string | null): void => {
    values.push({ field, original, normalized });
  };
  const fail = (field: string, code: HistoricalRowErrorCode, reason: string): void => {
    errors.push({ field, code, reason });
  };
  const warn = (field: string, code: HistoricalRowWarningCode, reason: string): void => {
    warnings.push({ field, code, reason });
  };

  /* ---- document type ---- */
  const typeCell = raw("סוג מסמך");
  const typeResult = normalizeHistoricalDocumentType(typeCell);
  let documentTypeCode: string | null = null;
  if (typeResult.ok) {
    documentTypeCode = typeResult.value;
    record("סוג מסמך", typeResult.raw, typeResult.value);
  } else {
    record("סוג מסמך", typeResult.raw, null);
    fail(
      "סוג מסמך",
      typeResult.raw === "" ? "MISSING_DOCUMENT_TYPE" : "UNKNOWN_DOCUMENT_TYPE",
      typeResult.reason
    );
  }

  /* ---- original document number: TEXT, trimmed at the edges only ---- */
  const numberText = cellText(raw("מספר מסמך מקורי"));
  record("מספר מסמך מקורי", numberText, numberText === "" ? null : numberText);
  if (numberText === "") {
    fail("מספר מסמך מקורי", "MISSING_DOCUMENT_NUMBER", "מספר מסמך מקורי חסר");
  }

  /* ---- issue date ---- */
  const dateResult = normalizeFiscalDate(raw("תאריך המסמך"), dateFormat);
  if (dateResult.ok) {
    record("תאריך המסמך", dateResult.original, dateResult.value);
    if (dateResult.isFuture) {
      warn("תאריך המסמך", "FUTURE_ISSUE_DATE", "תאריך המסמך עתידי");
    }
  } else {
    record("תאריך המסמך", dateResult.original, null);
    const code: HistoricalRowErrorCode =
      dateResult.code === "EMPTY"
        ? "MISSING_DATE"
        : dateResult.code === "AMBIGUOUS_DATE"
          ? "AMBIGUOUS_DATE"
          : dateResult.code === "UNSUPPORTED_FORMAT"
            ? "UNSUPPORTED_DATE_FORMAT"
            : "INVALID_DATE";
    fail("תאריך המסמך", code, dateResult.reason);
  }

  /* ---- amounts ---- */
  const amount = (header: string, required: boolean): string | null => {
    const cell = raw(header);
    if (cellText(cell) === "" && !required) {
      record(header, "", null);
      return null;
    }
    const result = normalizeFiscalAmount(cell);
    if (result.ok) {
      record(header, result.original, result.value);
      return result.value;
    }
    record(header, result.original, null);
    const code: HistoricalRowErrorCode =
      result.code === "EMPTY"
        ? "MISSING_TOTAL"
        : result.code === "AMBIGUOUS_DECIMAL_COMMA"
          ? "AMBIGUOUS_DECIMAL_COMMA"
          : result.code === "TOO_MANY_DECIMALS"
            ? "TOO_MANY_DECIMALS"
            : result.code === "OUT_OF_RANGE"
              ? "AMOUNT_OUT_OF_RANGE"
              : "INVALID_AMOUNT";
    fail(header, code === "MISSING_TOTAL" && header !== "סכום כולל" ? "INVALID_AMOUNT" : code, result.reason);
    return null;
  };

  const total = amount("סכום כולל", true);
  const subtotal = amount("סכום לפני מע״מ", false);
  const vat = amount("מע״מ", false);

  /* ---- VAT consistency: reported, never repaired ---- */
  if (subtotal === null && total !== null) {
    warn("סכום לפני מע״מ", "SUBTOTAL_MISSING", "המקור לא רשם סכום לפני מע״מ");
  }
  if (subtotal !== null && vat !== null && total !== null) {
    if (!decimalsAgree(subtotal, vat, total)) {
      // All three values stay exactly as the source recorded them. Deriving one
      // from the others would rewrite a historical accounting fact to make the
      // arithmetic tidy.
      warn(
        "סכום כולל",
        "VAT_ARITHMETIC_MISMATCH",
        "סכום לפני מע״מ ומע״מ אינם מסתכמים לסכום הכולל"
      );
    }
  }

  /* ---- sign conventions: both are real, so neither is corrected ---- */
  if (total !== null && documentTypeCode === "CREDIT_NOTE" && isPositive(total)) {
    warn("סכום כולל", "CREDIT_NOTE_POSITIVE_AMOUNT", "מסמך זיכוי עם סכום חיובי");
  }
  if (total !== null && documentTypeCode !== null && documentTypeCode !== "CREDIT_NOTE" && isNegative(total)) {
    warn("סכום כולל", "NON_CREDIT_NEGATIVE_AMOUNT", "מסמך שאינו זיכוי עם סכום שלילי");
  }

  /* ---- currency: required, never assumed ---- */
  const currencyResult = normalizeHistoricalCurrency(raw("מטבע"));
  if (currencyResult.ok) {
    record("מטבע", currencyResult.raw, currencyResult.value);
  } else {
    record("מטבע", currencyResult.raw, null);
    fail(
      "מטבע",
      currencyResult.raw === "" ? "MISSING_CURRENCY" : "UNSUPPORTED_CURRENCY",
      currencyResult.reason
    );
  }

  /* ---- customer snapshot: nothing is looked up, nothing is created ---- */
  const customerName = cellText(raw("שם לקוח"));
  record("שם לקוח", customerName, customerName === "" ? null : customerName);

  const taxIdResult = normalizeCustomerTaxIdSnapshot(raw("מספר עוסק / ח.פ. לקוח"));
  if (taxIdResult.ok) {
    record("מספר עוסק / ח.פ. לקוח", taxIdResult.raw, taxIdResult.value);
  } else {
    record("מספר עוסק / ח.פ. לקוח", taxIdResult.raw, null);
    fail("מספר עוסק / ח.פ. לקוח", "INVALID_CUSTOMER_TAX_ID", taxIdResult.reason);
  }

  /* ---- source system ---- */
  const sourceResult = normalizeHistoricalSourceSystem(raw("מערכת מקור"));
  let sourceSystemCode: string | null = null;
  if (sourceResult.ok) {
    sourceSystemCode = sourceResult.value;
    record("מערכת מקור", sourceResult.raw, sourceResult.value);
  } else {
    record("מערכת מקור", sourceResult.raw, null);
    fail(
      "מערכת מקור",
      sourceResult.raw === "" ? "MISSING_SOURCE_SYSTEM" : "INVALID_SOURCE_SYSTEM",
      sourceResult.reason
    );
  }

  /* ---- reversal reference: TEXT ONLY. Nothing is resolved here ---- */
  const reversesText = cellText(raw("מספר מסמך שמזוכה"));
  record("מספר מסמך שמזוכה", reversesText, reversesText === "" ? null : reversesText);
  if (documentTypeCode === "CREDIT_NOTE" && reversesText === "") {
    // A credit whose original was never imported is legitimate, so this is a
    // warning. Whether the reference RESOLVES is I-8B.3's question.
    warn(
      "מספר מסמך שמזוכה",
      "CREDIT_NOTE_WITHOUT_REFERENCE",
      "מסמך זיכוי בלי מספר המסמך שהוא מזכה"
    );
  }

  const state: HistoricalRowState =
    errors.length > 0 ? "ERROR" : warnings.length > 0 ? "WARNING" : "READY";

  return {
    sourceRowNumber,
    state,
    errors,
    warnings,
    values,
    identity: {
      sourceSystemCode,
      documentTypeCode,
      originalDocumentNumber: numberText === "" ? null : numberText,
    },
  };
}
