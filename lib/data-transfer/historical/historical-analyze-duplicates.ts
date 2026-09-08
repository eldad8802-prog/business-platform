/**
 * Analyze, plus what the business already holds.
 *
 * I-8B.2's analyzer answers "what is in this file" and touches no database at
 * all. That property is worth keeping, so it is kept: this module calls it
 * unchanged and then adds the half that needs a tenant-scoped read.
 *
 * Splitting them this way means the file analysis stays testable without a
 * database, the database code has nothing to decide about parsing, and the
 * zero-write guarantee can be asserted separately on each.
 *
 * # Where severity is decided
 *
 * A duplicate or an unresolved reversal changes what a row MEANS, so it can
 * change the row's state — but only by the rules written out below, and never
 * by rewriting a value. The rule of thumb: a collision the owner can resolve is
 * a WARNING, and a question Dubiz cannot answer deterministically is an ERROR.
 * Choosing between two candidates is exactly the thing that must not be
 * guessed, so ambiguity blocks.
 */

import {
  analyzeHistoricalSource,
  type HistoricalAnalyzeInput,
  type HistoricalAnalyzeResult,
  type HistoricalAnalyzedRow,
  type HistoricalRowState,
} from "@/lib/data-transfer/historical/historical-analyze";
import {
  analyzeHistoricalDuplicates,
  type DuplicateAnalysis,
  type DuplicateAnalysisResult,
  type DuplicateInputRow,
  type ReversalAnalysis,
} from "@/lib/data-transfer/historical/historical-duplicates";

/** Codes I-8B.3 adds. Structural, and carrying no value from the file. */
export type DuplicateErrorCode =
  | "DUPLICATE_AMBIGUOUS"
  | "REVERSAL_TARGET_AMBIGUOUS"
  | "REVERSAL_TARGET_AFTER_CREDIT"
  | "REVERSAL_TARGET_UNSUPPORTED_TYPE";

export type DuplicateWarningCode =
  | "DUPLICATE_EXISTS"
  | "DUPLICATE_CONFLICT"
  | "IN_FILE_DUPLICATE"
  | "IN_FILE_CONFLICT"
  | "REVERSAL_TARGET_NOT_FOUND";

/**
 * The enriched row. `errors` and `warnings` are WIDENED rather than inherited:
 * a row can now carry an I-8B.2 structural code and an I-8B.3 duplicate code at
 * once, and the two vocabularies stay separate types so neither file can quietly
 * start emitting the other's codes.
 */
export type HistoricalAnalyzedRowWithDuplicates = Omit<
  HistoricalAnalyzedRow,
  "errors" | "warnings"
> & {
  errors: {
    field: string;
    code: HistoricalAnalyzedRow["errors"][number]["code"] | DuplicateErrorCode;
    reason: string;
  }[];
  warnings: {
    field: string;
    code: HistoricalAnalyzedRow["warnings"][number]["code"] | DuplicateWarningCode;
    reason: string;
  }[];
  duplicate: DuplicateAnalysis;
  reversal: ReversalAnalysis;
};

export type HistoricalAnalyzeWithDuplicatesResult =
  | Extract<HistoricalAnalyzeResult, { ok: false }>
  | (Omit<Extract<HistoricalAnalyzeResult, { ok: true }>, "rows"> & {
      rows: HistoricalAnalyzedRowWithDuplicates[];
      /** What the database said, so a later phase can detect staleness. */
      duplicateEvidence: DuplicateAnalysisResult["evidence"];
    });

/**
 * The severity contract, in one table.
 *
 *   database EXACT              WARNING   the same document is already held
 *   database STRONG_CANDIDATE   WARNING   same identity, different facts
 *   database AMBIGUOUS          ERROR     two records claim this identity
 *   in-file EXACT_DUPLICATE     WARNING   an earlier row says the same thing
 *   in-file CONFLICTING         WARNING   an earlier row disagrees
 *   reversal NOT_FOUND          WARNING   the original was never imported
 *   reversal AMBIGUOUS          ERROR     more than one candidate
 *   reversal TARGET_AFTER       ERROR     the target is later in the file
 *   reversal UNSUPPORTED_TYPE   ERROR     that document cannot be credited
 *
 * `NO_REFERENCE` is already a warning from I-8B.2 and is not repeated here.
 */
function issuesFor(
  duplicate: DuplicateAnalysis,
  reversal: ReversalAnalysis
): {
  errors: { field: string; code: DuplicateErrorCode; reason: string }[];
  warnings: { field: string; code: DuplicateWarningCode; reason: string }[];
} {
  const errors: { field: string; code: DuplicateErrorCode; reason: string }[] = [];
  const warnings: { field: string; code: DuplicateWarningCode; reason: string }[] = [];

  switch (duplicate.database.state) {
    case "EXACT":
      warnings.push({
        field: "מספר מסמך מקורי",
        code: "DUPLICATE_EXISTS",
        reason: "מסמך זהה כבר קיים בהיסטוריה",
      });
      break;
    case "STRONG_CANDIDATE":
      warnings.push({
        field: "מספר מסמך מקורי",
        code: "DUPLICATE_CONFLICT",
        reason: "קיים מסמך עם אותו מספר, אבל חלק מהפרטים שונים",
      });
      break;
    case "AMBIGUOUS":
      errors.push({
        field: "מספר מסמך מקורי",
        code: "DUPLICATE_AMBIGUOUS",
        reason: "יותר ממסמך היסטורי אחד נושא את אותו מספר",
      });
      break;
    default:
      break;
  }

  if (duplicate.inFile.state === "EXACT_DUPLICATE") {
    warnings.push({
      field: "מספר מסמך מקורי",
      code: "IN_FILE_DUPLICATE",
      reason: "שורה מוקדמת יותר בקובץ מתארת את אותו מסמך",
    });
  } else if (duplicate.inFile.state === "CONFLICTING_DUPLICATE") {
    warnings.push({
      field: "מספר מסמך מקורי",
      code: "IN_FILE_CONFLICT",
      reason: "שורה מוקדמת יותר בקובץ נושאת את אותו מספר עם פרטים שונים",
    });
  }

  switch (reversal.state) {
    case "NOT_FOUND":
      warnings.push({
        field: "מספר מסמך שמזוכה",
        code: "REVERSAL_TARGET_NOT_FOUND",
        reason: "המסמך שהזיכוי מבטל לא נמצא. המספר יישמר כטקסט",
      });
      break;
    case "AMBIGUOUS":
      errors.push({
        field: "מספר מסמך שמזוכה",
        code: "REVERSAL_TARGET_AMBIGUOUS",
        reason: "יותר ממסמך אחד מתאים למספר שהזיכוי מפנה אליו",
      });
      break;
    case "TARGET_AFTER_CREDIT":
      errors.push({
        field: "מספר מסמך שמזוכה",
        code: "REVERSAL_TARGET_AFTER_CREDIT",
        reason: "המסמך שהזיכוי מבטל מופיע בקובץ אחרי הזיכוי",
      });
      break;
    case "UNSUPPORTED_TARGET_TYPE":
      errors.push({
        field: "מספר מסמך שמזוכה",
        code: "REVERSAL_TARGET_UNSUPPORTED_TYPE",
        reason: "סוג המסמך שהזיכוי מפנה אליו אינו ניתן לזיכוי",
      });
      break;
    default:
      break;
  }

  return { errors, warnings };
}

/** Recompute the row state from ALL of its issues, structural ones included. */
function stateOf(row: {
  errors: readonly unknown[];
  warnings: readonly unknown[];
}): HistoricalRowState {
  if (row.errors.length > 0) return "ERROR";
  return row.warnings.length > 0 ? "WARNING" : "READY";
}

export async function analyzeHistoricalSourceWithDuplicates(
  businessId: number,
  input: HistoricalAnalyzeInput
): Promise<HistoricalAnalyzeWithDuplicatesResult> {
  const analysis = await analyzeHistoricalSource(input);
  if (!analysis.ok) return analysis;

  const lookupRows: DuplicateInputRow[] = analysis.rows.map((row) => {
    const value = (field: string): string | null =>
      row.values.find((v) => v.field === field)?.normalized ?? null;
    return {
      sourceRowNumber: row.sourceRowNumber,
      identity: {
        sourceSystemCode: row.identity.sourceSystemCode ?? undefined,
        documentTypeCode: row.identity.documentTypeCode ?? undefined,
        originalDocumentNumber: row.identity.originalDocumentNumber,
      },
      facts: {
        originalIssueDate: value("תאריך המסמך"),
        totalAmount: value("סכום כולל"),
        subtotalAmount: value("סכום לפני מע״מ"),
        vatAmount: value("מע״מ"),
        currency: value("מטבע"),
        customerNameSnapshot: value("שם לקוח"),
        customerTaxIdSnapshot: value("מספר עוסק / ח.פ. לקוח"),
      },
      reversesOriginalNumberRaw: value("מספר מסמך שמזוכה"),
    };
  });

  const { byRow, evidence } = await analyzeHistoricalDuplicates(businessId, lookupRows);

  const rows: HistoricalAnalyzedRowWithDuplicates[] = analysis.rows.map((row) => {
    const found = byRow.get(row.sourceRowNumber);
    const duplicate: DuplicateAnalysis = found?.duplicate ?? {
      database: { state: "NONE", matchCount: 0, comparison: null, differingFields: [] },
      inFile: { state: "NONE", firstOccurrenceRow: null, laterRows: [] },
    };
    const reversal: ReversalAnalysis = found?.reversal ?? {
      state: "NOT_APPLICABLE",
      rawNumber: null,
      targetSourceRow: null,
      targetSummary: null,
      candidateCount: 0,
    };

    const { errors, warnings } = issuesFor(duplicate, reversal);
    const enriched: HistoricalAnalyzedRowWithDuplicates = {
      ...row,
      errors: [...row.errors, ...errors],
      warnings: [...row.warnings, ...warnings],
      duplicate,
      reversal,
    };
    return { ...enriched, state: stateOf(enriched) };
  });

  return {
    ...analysis,
    rows,
    summary: {
      ...analysis.summary,
      ready: rows.filter((r) => r.state === "READY").length,
      warning: rows.filter((r) => r.state === "WARNING").length,
      error: rows.filter((r) => r.state === "ERROR").length,
    },
    duplicateEvidence: evidence,
  };
}
