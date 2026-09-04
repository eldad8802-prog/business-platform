/**
 * The Import dry-run, start to finish. ONE place that owns the flow.
 *
 *   bytes -> source/sheet -> mapping -> normalize -> validate -> duplicates
 *         -> summary -> signed attestation
 *
 * The API routes are deliberately thin: they authenticate, hand over the bytes
 * and the owner's choices, and serialize what comes back. A route that assembled
 * this itself would be a second place where the flow could be wrong, and the
 * two would drift.
 *
 * # Trust
 *
 * The caller may choose a DOMAIN, a SHEET (from the list the server found), and
 * a MAPPING. Everything else is re-derived here from the bytes: the row values,
 * the content hash, the row count, the validation results, the duplicates. A
 * client-supplied "this row is fine" is never believed, because believing it is
 * how a dry run stops being a check.
 *
 * # Zero writes
 *
 * Nothing in this file, or anything it calls, creates or updates business data.
 * The only DB access is the read-only duplicate lookup, which runs inside the
 * tenant substrate. Asserted structurally by the verifier.
 */

import type { DataTransferDomainId } from "@/lib/data-transfer/domains";
import { getExportDescriptor } from "@/lib/data-transfer/export/export-registry";
import { importableFields } from "@/lib/data-transfer/domain-fields";
import {
  IMPORT_MAPPING_SAMPLE_VALUES,
  IMPORT_PREVIEW_ROW_WINDOW,
  IMPORT_PREVIEW_TTL_SECONDS,
} from "@/lib/data-transfer/import/import-config";
import {
  readImportSource,
  type ImportSourceResult,
} from "@/lib/data-transfer/import/import-source";
import {
  canonicalizeMapping,
  proposeMapping,
  type ColumnProposal,
  type MappingProblem,
  type ResolvedMapping,
} from "@/lib/data-transfer/import/mapping/mapping-proposer";
import {
  issuePreviewToken,
  sha256Hex,
} from "@/lib/data-transfer/import/preview/preview-token";
import {
  deriveImportRows,
  type DerivedRow,
} from "@/lib/data-transfer/import/derive-rows";
import {
  projectLeadSideEffects,
  type LeadSideEffects,
} from "@/lib/data-transfer/import/lead-side-effects";
import {
  decisionsHashOf,
  inFileEligibleRows,
  mayOverrideToCreate,
  resolveDecisions,
  validateDecisions,
  type DecisionProblem,
  type RowDecisions,
} from "@/lib/data-transfer/import/execute/row-decisions";

/* ------------------------------------------------------------- analyze -- */

export type AnalyzeInput = {
  domainId: DataTransferDomainId;
  filename: string;
  bytes: Buffer;
  sheetName?: string | null;
};

export type AnalyzeResult =
  | {
      ok: true;
      sheetName: string | null;
      availableSheets: string[];
      headers: string[];
      rowCount: number;
      proposals: ColumnProposal[];
      /** Fields the owner must map before a preview can be produced. */
      requiredFields: string[];
      /** Every field this domain can accept, for the manual override list. */
      importableFields: { field: string; required: boolean; help: string | null }[];
      contentHash: string;
    }
  | { ok: false; code: string; message: string; availableSheets?: string[] };

function sourceFailure(result: Extract<ImportSourceResult, { ok: false }>): AnalyzeResult {
  return {
    ok: false,
    code: result.code,
    message: result.message,
    availableSheets: result.availableSheets,
  };
}

/**
 * Step 1 — read the file and propose a mapping. No tenant data is touched:
 * analyze answers "what is in this file", not "what does it collide with".
 */
export async function analyzeImportSource(
  input: AnalyzeInput
): Promise<AnalyzeResult> {
  const source = await readImportSource({
    filename: input.filename,
    bytes: input.bytes,
    sheetName: input.sheetName ?? null,
  });
  if (!source.ok) return sourceFailure(source);

  const descriptor = getExportDescriptor(input.domainId);
  const fields = importableFields(descriptor.columns);

  const proposals = proposeMapping({
    domainId: input.domainId,
    fields: descriptor.columns,
    headers: source.table.headers,
    sampleRows: source.table.rows,
    sampleCount: IMPORT_MAPPING_SAMPLE_VALUES,
  });

  return {
    ok: true,
    sheetName: source.sheetName,
    availableSheets: source.availableSheets,
    headers: source.table.headers,
    rowCount: source.table.rows.length,
    proposals,
    requiredFields: fields.filter((f) => f.required).map((f) => f.header),
    importableFields: fields.map((f) => ({
      field: f.header,
      required: f.required === true,
      help: f.help ?? null,
    })),
    contentHash: sha256Hex(input.bytes),
  };
}

/* ------------------------------------------------------------- preview -- */

export type PreviewInput = AnalyzeInput & {
  businessId: number;
  userId: number;
  mapping: ResolvedMapping;
  /**
   * The owner's per-row choices, or null on the FIRST preview call.
   *
   * Null means "you decide": the server computes the domain defaults and returns
   * them. A non-null set is re-validated against freshly derived rows before it
   * is bound into the token — a signature proves a decision was not altered, not
   * that it was ever legitimate.
   */
  decisions?: RowDecisions | null;
};

export type PreviewRow = DerivedRow;

export type PreviewSummary = {
  totalRows: number;
  ready: number;
  warning: number;
  error: number;
  withDuplicates: number;
};

export type PreviewResult =
  | {
      ok: true;
      sheetName: string | null;
      summary: PreviewSummary;
      /** A bounded window; the summary counts are always complete. */
      rows: PreviewRow[];
      rowsTruncated: boolean;
      /** Server-resolved action for EVERY row, defaults included. */
      decisions: RowDecisions;
      /** Rows the owner is allowed to switch to CREATE against the default. */
      overridableRows: number[];
      /**
       * Records OTHER than the imported ones that confirming will create.
       *
       * Present for Leads only, where the canonical service resolves-or-creates
       * a Customer per lead. Disclosed here because the owner is approving that
       * consequence too, whether or not they were told about it.
       */
      sideEffects?: LeadSideEffects;
      previewToken: string;
      expiresAt: string;
    }
  | {
      ok: false;
      code: string;
      message: string;
      availableSheets?: string[];
      mappingProblems?: MappingProblem[];
      decisionProblems?: DecisionProblem[];
    };

/**
 * Step 2 — the full dry run.
 *
 * Everything trusted is recomputed from the bytes, through the same derivation
 * execute will use. What the owner approves here is exactly what runs there.
 */
export async function buildImportPreview(
  input: PreviewInput
): Promise<PreviewResult> {
  const derived = await deriveImportRows({
    businessId: input.businessId,
    domainId: input.domainId,
    filename: input.filename,
    bytes: input.bytes,
    sheetName: input.sheetName ?? null,
    mapping: input.mapping,
  });
  if (!derived.ok) return derived;

  const submitted = input.decisions ?? null;
  if (submitted) {
    const decisionProblems = validateDecisions({
      domainId: input.domainId,
      rows: derived.rows,
      decisions: submitted,
    });
    if (decisionProblems.length > 0) {
      return {
        ok: false,
        code: "DECISIONS_INVALID",
        message: "אחת הבחירות אינה אפשרית עבור השורה שלה",
        decisionProblems,
      };
    }
  }

  const decisions = resolveDecisions(input.domainId, derived.rows, submitted);
  const eligible = inFileEligibleRows(derived.rows);
  const overridableRows = derived.rows
    .filter(
      (row) =>
        decisions[row.rowNumber] === "SKIP" &&
        mayOverrideToCreate(input.domainId, row, eligible)
    )
    .map((row) => row.rowNumber);

  // Only the rows that will actually run — a SKIPPED row creates nothing, and
  // counting it would overstate what confirming does.
  const sideEffects =
    input.domainId === "leads"
      ? await projectLeadSideEffects(
          input.businessId,
          derived.rows
            .filter((row) => decisions[row.rowNumber] === "CREATE")
            .map((row) => derived.validated.get(row.rowNumber))
            .filter((row): row is NonNullable<typeof row> => row != null)
        )
      : undefined;

  // Issues first: an owner opening a preview wants the problems, not row 1.
  const rank = { ERROR: 0, WARNING: 1, READY: 2 } as const;
  const window = [...derived.rows]
    .sort((a, b) => rank[a.status] - rank[b.status] || a.rowNumber - b.rowNumber)
    .slice(0, IMPORT_PREVIEW_ROW_WINDOW);

  const issuedAt = new Date();
  const previewToken = issuePreviewToken(
    {
      businessId: input.businessId,
      userId: input.userId,
      domain: input.domainId,
      contentHash: sha256Hex(input.bytes),
      mappingHash: sha256Hex(canonicalizeMapping(input.mapping)),
      decisionsHash: decisionsHashOf(decisions),
      sheetName: derived.sheetName,
      rowCount: derived.counts.totalRows,
    },
    issuedAt
  );

  return {
    ok: true,
    sheetName: derived.sheetName,
    summary: derived.counts,
    rows: window,
    rowsTruncated: derived.rows.length > window.length,
    decisions,
    overridableRows,
    ...(sideEffects ? { sideEffects } : {}),
    previewToken,
    expiresAt: new Date(
      issuedAt.getTime() + IMPORT_PREVIEW_TTL_SECONDS * 1000
    ).toISOString(),
  };
}
