/**
 * Historical fiscal Preview — what confirming would actually do.
 *
 * # The server owns the truth
 *
 * Preview does not accept a client's word for anything it could verify. The
 * file is re-parsed, re-normalized and re-analyzed from the bytes, and the
 * duplicate and reversal analysis is re-run against the database. A request
 * that says `duplicate = NONE` is not evidence; it is a claim about a fact the
 * server can check, so the server checks it.
 *
 * What the client legitimately supplies is what only the owner knows: which
 * sheet, which mapping, how to read a textual date, and what they decided.
 *
 * # Staleness is not a technicality
 *
 * The conclusions here depend on records that already exist. A record inserted
 * between Analyze and Preview turns a NONE into an EXACT without changing a
 * byte of the file, and nothing the owner is looking at would say so.
 *
 * So a caller may pass the evidence fingerprint Analyze gave them. If the
 * database has moved, Preview REFUSES with `ANALYSIS_STALE` rather than quietly
 * building a different preview under the owner's feet. Rebuilding silently is
 * the failure mode here — the owner would confirm something they never read.
 *
 * # Nothing is written
 *
 * No record, no run, no marker. The token is stateless: the preview itself is
 * not stored anywhere, which is why it can be recomputed identically instead of
 * being looked up.
 */

import {
  analyzeHistoricalSourceWithDuplicates,
  type HistoricalAnalyzedRowWithDuplicates,
} from "@/lib/data-transfer/historical/historical-analyze-duplicates";
import type { HistoricalAnalyzeInput } from "@/lib/data-transfer/historical/historical-analyze";
import {
  allowedActionsFor,
  blockingReasons,
  decisionsHashOf,
  defaultActionFor,
  isBlocked,
  requiresOwnerDecision,
  resolveDecisions,
  unresolvedRows,
  validateDecisions,
  type BlockingReasonCode,
  type DecidableRow,
  type DecisionProblem,
  type HistoricalAction,
  type HistoricalDecisions,
} from "@/lib/data-transfer/historical/historical-decisions";
import {
  issueHistoricalPreviewToken,
} from "@/lib/data-transfer/historical/historical-preview-token";
import { IMPORT_PREVIEW_ROW_WINDOW, IMPORT_PREVIEW_TTL_SECONDS } from "@/lib/data-transfer/import/import-config";
import type { ReversalState } from "@/lib/data-transfer/historical/historical-duplicates";

/** How a credit's target will be reached when Execute eventually runs. */
export type ReversalTargetClass =
  | "NOT_APPLICABLE"
  /** A record the business already holds. */
  | "EXISTING_RECORD"
  /** An earlier row of this same file that is going to be created. */
  | "ROW_TO_BE_CREATED"
  /** An earlier row that will NOT be created, so nothing new to bind to. */
  | "ROW_NOT_BEING_CREATED"
  /** The number is kept as text and no relation is formed. */
  | "TEXT_ONLY"
  | "BLOCKED";

export type HistoricalPreviewRow = {
  sourceRowNumber: number;
  values: HistoricalAnalyzedRowWithDuplicates["values"];
  state: HistoricalAnalyzedRowWithDuplicates["state"];
  errors: HistoricalAnalyzedRowWithDuplicates["errors"];
  warnings: HistoricalAnalyzedRowWithDuplicates["warnings"];
  duplicate: HistoricalAnalyzedRowWithDuplicates["duplicate"];
  reversal: HistoricalAnalyzedRowWithDuplicates["reversal"];
  /** How the credit will reach its target, once Execute exists. */
  reversalTarget: ReversalTargetClass;
  defaultDecision: HistoricalAction;
  allowedDecisions: HistoricalAction[];
  selectedDecision: HistoricalAction;
  ownerDecisionRequired: boolean;
  blocked: boolean;
  blockingReasons: BlockingReasonCode[];
};

export type HistoricalPreviewSummary = {
  totalRows: number;
  willCreate: number;
  willSkip: number;
  createAnyway: number;
  ownerDecisionRequired: number;
  blocked: number;
  withWarnings: number;
  exactDatabaseDuplicates: number;
  strongDuplicateCandidates: number;
  inFileCollisions: number;
  unresolvedReversals: number;
};

export type HistoricalPreviewResult =
  | {
      ok: false;
      code: string;
      message: string;
      availableSheets?: string[];
      decisionProblems?: DecisionProblem[];
      /** Present for ANALYSIS_STALE so a caller can re-analyze knowingly. */
      currentEvidenceFingerprint?: string;
    }
  | {
      ok: true;
      file: {
        filename: string;
        format: "xlsx" | "csv";
        sheetName: string | null;
        rowCount: number;
        contentHash: string;
      };
      dateInterpretation: Awaited<
        ReturnType<typeof analyzeHistoricalSourceWithDuplicates>
      > extends infer R
        ? R extends { ok: true; dateInterpretation: infer D }
          ? D
          : never
        : never;
      summary: HistoricalPreviewSummary;
      /** A bounded window; the summary counts are always complete. */
      rows: HistoricalPreviewRow[];
      rowsTruncated: boolean;
      /** Every row's resolved action, defaults included. */
      decisions: HistoricalDecisions;
      /** Rows still waiting on the owner. */
      awaitingDecision: number[];
      readyForExecute: boolean;
      /** Why not, when it is not. Owner-safe codes. */
      notReadyReasons: string[];
      evidenceFingerprint: string;
      /** Signed ONLY when `readyForExecute`. Null otherwise. */
      previewToken: string | null;
      expiresAt: string | null;
    };

export type HistoricalPreviewInput = HistoricalAnalyzeInput & {
  businessId: number;
  userId: number;
  /** The owner's choices, or null on the first call. */
  decisions?: HistoricalDecisions | null;
  /**
   * The fingerprint Analyze reported. When supplied and the database has since
   * moved, Preview refuses rather than rebuilding silently.
   */
  expectedEvidenceFingerprint?: string | null;
};

/** The row facts a decision is judged against. */
function decidableOf(row: HistoricalAnalyzedRowWithDuplicates): DecidableRow {
  // Structural errors are the ones Analyze raised about the ROW itself. The
  // duplicate and reversal codes are folded in separately, because a collision
  // is a decision and a malformed date is not.
  const structural = row.errors.filter(
    (error) =>
      error.code !== "DUPLICATE_AMBIGUOUS" &&
      error.code !== "REVERSAL_TARGET_AMBIGUOUS" &&
      error.code !== "REVERSAL_TARGET_AFTER_CREDIT" &&
      error.code !== "REVERSAL_TARGET_UNSUPPORTED_TYPE"
  );
  return {
    sourceRowNumber: row.sourceRowNumber,
    hasStructuralError: structural.length > 0,
    database: row.duplicate.database.state,
    inFile: row.duplicate.inFile.state,
    reversal: row.reversal.state,
  };
}

/**
 * How a credit will actually reach its target once Execute runs.
 *
 * The subtle case the brief names: row 8 credits row 5, and the owner SKIPPED
 * row 5 because the business already holds it. The credit is not broken — its
 * target exists, it is simply already in the database rather than about to be
 * inserted. Reporting that as a dependency on a row that will not be created
 * would block a perfectly good import.
 *
 * So the question asked here is "what will the target BE", not "is the target
 * row being created".
 */
function reversalTargetClass(
  row: HistoricalAnalyzedRowWithDuplicates,
  decisions: HistoricalDecisions,
  byRow: Map<number, HistoricalAnalyzedRowWithDuplicates>
): ReversalTargetClass {
  const state: ReversalState = row.reversal.state;
  if (state === "NOT_APPLICABLE") return "NOT_APPLICABLE";
  if (
    state === "AMBIGUOUS" ||
    state === "TARGET_AFTER_CREDIT" ||
    state === "UNSUPPORTED_TARGET_TYPE"
  ) {
    return "BLOCKED";
  }
  if (state === "RESOLVED_EXISTING") return "EXISTING_RECORD";
  if (state === "NO_REFERENCE" || state === "NOT_FOUND") return "TEXT_ONLY";

  // RESOLVED_IN_FILE: the target is an earlier row of this file.
  const targetRow = row.reversal.targetSourceRow;
  if (targetRow === null) return "TEXT_ONLY";
  const action = decisions[targetRow];
  if (action === "CREATE" || action === "CREATE_ANYWAY") return "ROW_TO_BE_CREATED";

  // The target row is being skipped. If it is being skipped BECAUSE the
  // business already holds it, the credit still has something real to point
  // at; otherwise there will be nothing, and the reference stays textual.
  const target = byRow.get(targetRow);
  const alreadyHeld =
    target?.duplicate.database.state === "EXACT" ||
    target?.duplicate.database.state === "STRONG_CANDIDATE";
  return alreadyHeld ? "EXISTING_RECORD" : "ROW_NOT_BEING_CREATED";
}

export async function buildHistoricalPreview(
  input: HistoricalPreviewInput
): Promise<HistoricalPreviewResult> {
  const analysis = await analyzeHistoricalSourceWithDuplicates(input.businessId, {
    filename: input.filename,
    bytes: input.bytes,
    sheetName: input.sheetName ?? null,
    dateFormat: input.dateFormat ?? null,
    mapping: input.mapping ?? null,
  });
  if (!analysis.ok) return analysis;

  if (analysis.mapping.blockers.length > 0) {
    return {
      ok: false,
      code: "MAPPING_INCOMPLETE",
      message: "יש להשלים את התאמת העמודות לפני שאפשר להציג תצוגה מקדימה",
    };
  }

  const evidenceFingerprint = analysis.duplicateEvidence.fingerprint;

  // Staleness. Refuse rather than rebuild: an owner must not confirm a preview
  // that quietly became a different one.
  if (
    input.expectedEvidenceFingerprint &&
    input.expectedEvidenceFingerprint !== evidenceFingerprint
  ) {
    return {
      ok: false,
      code: "ANALYSIS_STALE",
      message:
        "ההיסטוריה השתנתה מאז הבדיקה. יש להריץ את הבדיקה שוב ולעבור על התוצאות",
      currentEvidenceFingerprint: evidenceFingerprint,
    };
  }

  const decidable = analysis.rows.map(decidableOf);
  const submitted = input.decisions ?? null;

  if (submitted) {
    const problems = validateDecisions(decidable, submitted);
    if (problems.length > 0) {
      return {
        ok: false,
        code: "DECISIONS_INVALID",
        message: "אחת הבחירות אינה אפשרית עבור השורה שלה",
        decisionProblems: problems,
      };
    }
  }

  const decisions = resolveDecisions(decidable, submitted);
  const awaitingDecision = unresolvedRows(decidable, submitted);
  const byRow = new Map(analysis.rows.map((row) => [row.sourceRowNumber, row]));

  const rows: HistoricalPreviewRow[] = analysis.rows.map((row) => {
    const decidableRow = decidable.find((d) => d.sourceRowNumber === row.sourceRowNumber)!;
    return {
      sourceRowNumber: row.sourceRowNumber,
      values: row.values,
      state: row.state,
      errors: row.errors,
      warnings: row.warnings,
      duplicate: row.duplicate,
      reversal: row.reversal,
      reversalTarget: reversalTargetClass(row, decisions, byRow),
      defaultDecision: defaultActionFor(decidableRow),
      allowedDecisions: allowedActionsFor(decidableRow),
      selectedDecision: decisions[row.sourceRowNumber],
      ownerDecisionRequired: requiresOwnerDecision(decidableRow),
      blocked: isBlocked(decidableRow),
      blockingReasons: blockingReasons(decidableRow),
    };
  });

  const summary: HistoricalPreviewSummary = {
    totalRows: rows.length,
    willCreate: rows.filter((r) => r.selectedDecision === "CREATE").length,
    willSkip: rows.filter((r) => r.selectedDecision === "SKIP").length,
    createAnyway: rows.filter((r) => r.selectedDecision === "CREATE_ANYWAY").length,
    ownerDecisionRequired: rows.filter((r) => r.ownerDecisionRequired).length,
    blocked: rows.filter((r) => r.blocked).length,
    withWarnings: rows.filter((r) => r.warnings.length > 0).length,
    exactDatabaseDuplicates: rows.filter((r) => r.duplicate.database.state === "EXACT").length,
    strongDuplicateCandidates: rows.filter(
      (r) => r.duplicate.database.state === "STRONG_CANDIDATE"
    ).length,
    inFileCollisions: rows.filter((r) => r.duplicate.inFile.state !== "NONE").length,
    unresolvedReversals: rows.filter(
      (r) => r.reversal.state === "NOT_FOUND" || r.reversal.state === "NO_REFERENCE"
    ).length,
  };

  /**
   * Ready means: nothing is waiting on the owner, and nothing that is going to
   * RUN is broken. A blocked row does not prevent the rest of the file from
   * importing — it is skipped, visibly, with its reason — which is why the
   * check is about the rows that will actually execute.
   */
  const notReadyReasons: string[] = [];
  if (awaitingDecision.length > 0) notReadyReasons.push("OWNER_DECISION_REQUIRED");
  const executing = rows.filter((r) => r.selectedDecision !== "SKIP");
  if (executing.some((r) => r.blocked)) notReadyReasons.push("BLOCKED_ROW_SELECTED");
  if (executing.some((r) => r.errors.length > 0)) notReadyReasons.push("ERROR_ROW_SELECTED");
  if (rows.length === 0) notReadyReasons.push("NO_ROWS");
  if (executing.length === 0 && rows.length > 0) notReadyReasons.push("NOTHING_TO_IMPORT");

  const readyForExecute = notReadyReasons.length === 0;

  // Issues first: an owner opening a preview wants the problems, not row 1.
  const rank = { ERROR: 0, WARNING: 1, READY: 2 } as const;
  const window = [...rows]
    .sort(
      (a, b) => rank[a.state] - rank[b.state] || a.sourceRowNumber - b.sourceRowNumber
    )
    .slice(0, IMPORT_PREVIEW_ROW_WINDOW);

  const issuedAt = new Date();
  // A token is an executable assertion. It is minted only when there is
  // something legitimate to execute — signing an unready preview would create
  // an artifact whose only job is to be refused later.
  const previewToken = readyForExecute
    ? issueHistoricalPreviewToken(
        {
          businessId: input.businessId,
          userId: input.userId,
          domain: "historical-documents",
          contentHash: analysis.file.contentHash,
          sheetName: analysis.file.sheetName,
          mappingHash: analysis.mapping.mappingHash,
          dateFormat: input.dateFormat ?? null,
          analysisHash: analysis.analysisHash,
          rowCount: rows.length,
          decisionsHash: decisionsHashOf(decisions),
          evidenceFingerprint,
        },
        issuedAt
      )
    : null;

  return {
    ok: true,
    file: {
      filename: analysis.file.filename,
      format: analysis.file.format,
      sheetName: analysis.file.sheetName,
      rowCount: analysis.file.rowCount,
      contentHash: analysis.file.contentHash,
    },
    dateInterpretation: analysis.dateInterpretation as never,
    summary,
    rows: window,
    rowsTruncated: rows.length > window.length,
    decisions,
    awaitingDecision,
    readyForExecute,
    notReadyReasons,
    evidenceFingerprint,
    previewToken,
    expiresAt: previewToken
      ? new Date(issuedAt.getTime() + IMPORT_PREVIEW_TTL_SECONDS * 1000).toISOString()
      : null,
  };
}
