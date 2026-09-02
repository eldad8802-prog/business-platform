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
  validateMapping,
  type ColumnProposal,
  type MappingProblem,
  type ResolvedMapping,
} from "@/lib/data-transfer/import/mapping/mapping-proposer";
import { validateRows, type ValidatedRow } from "@/lib/data-transfer/import/validate/row-validate";
import {
  detectExistingMatches,
  detectInFileDuplicates,
  mergeDuplicates,
  type DuplicateEvidence,
} from "@/lib/data-transfer/import/duplicates/duplicate-detect";
import {
  issuePreviewToken,
  sha256Hex,
} from "@/lib/data-transfer/import/preview/preview-token";

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
};

export type PreviewRow = {
  rowNumber: number;
  status: "READY" | "WARNING" | "ERROR";
  errors: { field: string; reason: string; original: string }[];
  /** Only values Dubiz would CHANGE — the rest is noise in a preview. */
  changes: { field: string; original: string; normalized: string }[];
  duplicates: DuplicateEvidence[];
};

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
      previewToken: string;
      expiresAt: string;
    }
  | {
      ok: false;
      code: string;
      message: string;
      availableSheets?: string[];
      mappingProblems?: MappingProblem[];
    };

/**
 * Step 2 — the full dry run.
 *
 * Everything trusted is recomputed from the bytes. The mapping is re-validated
 * against the domain even though analyze already proposed one, because the
 * owner edited it in between and the edit arrived from the client.
 */
export async function buildImportPreview(
  input: PreviewInput
): Promise<PreviewResult> {
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

  const descriptor = getExportDescriptor(input.domainId);

  const mappingProblems = validateMapping({
    fields: descriptor.columns,
    headerCount: source.table.headers.length,
    mapping: input.mapping,
  });
  if (mappingProblems.length > 0) {
    return {
      ok: false,
      code: "MAPPING_INVALID",
      message: "התאמת העמודות אינה שלמה",
      mappingProblems,
    };
  }

  const validated: ValidatedRow[] = validateRows({
    domainId: input.domainId,
    fields: descriptor.columns,
    mapping: input.mapping,
    rows: source.table.rows,
  });

  // Duplicates: in-file is pure; existing is a tenant-scoped READ.
  const inFile = detectInFileDuplicates(input.domainId, validated);
  const existing = await detectExistingMatches(
    input.businessId,
    input.domainId,
    validated
  );
  const duplicates = mergeDuplicates(inFile, existing);

  let ready = 0;
  let warning = 0;
  let error = 0;
  let withDuplicates = 0;

  const rows: PreviewRow[] = validated.map((row) => {
    const evidence = duplicates.get(row.rowNumber) ?? [];
    // A duplicate never rescues an ERROR row, and never silently passes as
    // READY: it is exactly the case that needs the owner's attention.
    const status =
      row.status === "ERROR"
        ? "ERROR"
        : evidence.length > 0
          ? "WARNING"
          : "READY";

    if (status === "ERROR") error += 1;
    else if (status === "WARNING") warning += 1;
    else ready += 1;
    if (evidence.length > 0) withDuplicates += 1;

    return {
      rowNumber: row.rowNumber,
      status,
      errors: row.errors,
      changes: row.values
        .filter((v) => v.changed)
        .map((v) => ({
          field: v.field,
          original: v.original,
          normalized: v.normalized,
        })),
      duplicates: evidence,
    };
  });

  // Issues first: an owner opening a preview wants the problems, not row 1.
  const rank = { ERROR: 0, WARNING: 1, READY: 2 } as const;
  const window = [...rows]
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
      sheetName: source.sheetName,
      rowCount: validated.length,
    },
    issuedAt
  );

  return {
    ok: true,
    sheetName: source.sheetName,
    summary: {
      totalRows: validated.length,
      ready,
      warning,
      error,
      withDuplicates,
    },
    rows: window,
    rowsTruncated: rows.length > window.length,
    previewToken,
    expiresAt: new Date(
      issuedAt.getTime() + IMPORT_PREVIEW_TTL_SECONDS * 1000
    ).toISOString(),
  };
}
