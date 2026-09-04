/**
 * The ONE derivation from bytes to rows, shared by preview and execute.
 *
 * Preview shows the owner what will happen; execute makes it happen. If those
 * two ever computed rows differently, the owner would be approving one thing
 * and getting another — and the difference would be invisible, because the
 * preview would still look right. So neither owns a derivation: they call this.
 *
 * Execute passes the same bytes, the same mapping and the same sheet, and the
 * signed attestation is what proves they are the same. Row N here is therefore
 * the same row N the owner saw, which is what makes "sourceRowNumber" a valid
 * idempotency identity.
 *
 * Read-only. The single DB access is the tenant-scoped duplicate lookup.
 */

import type { DataTransferDomainId } from "@/lib/data-transfer/domains";
import { getExportDescriptor } from "@/lib/data-transfer/export/export-registry";
import {
  readImportSource,
  type ImportSourceResult,
} from "@/lib/data-transfer/import/import-source";
import {
  validateMapping,
  type MappingProblem,
  type ResolvedMapping,
} from "@/lib/data-transfer/import/mapping/mapping-proposer";
import {
  validateRows,
  type ValidatedRow,
} from "@/lib/data-transfer/import/validate/row-validate";
import {
  detectExistingMatches,
  detectInFileDuplicates,
  mergeDuplicates,
  type DuplicateEvidence,
} from "@/lib/data-transfer/import/duplicates/duplicate-detect";

export type DerivedRow = {
  rowNumber: number;
  status: "READY" | "WARNING" | "ERROR";
  errors: { field: string; reason: string; original: string }[];
  changes: { field: string; original: string; normalized: string }[];
  duplicates: DuplicateEvidence[];
};

export type DeriveInput = {
  businessId: number;
  domainId: DataTransferDomainId;
  filename: string;
  bytes: Buffer;
  sheetName: string | null;
  mapping: ResolvedMapping;
};

export type DeriveResult =
  | {
      ok: true;
      sheetName: string | null;
      /** EVERY row, in file order. Preview windows this; execute does not. */
      rows: DerivedRow[];
      /** The validated payloads the writers consume, keyed by row number. */
      validated: Map<number, ValidatedRow>;
      counts: {
        totalRows: number;
        ready: number;
        warning: number;
        error: number;
        withDuplicates: number;
      };
    }
  | {
      ok: false;
      code: string;
      message: string;
      availableSheets?: string[];
      mappingProblems?: MappingProblem[];
    };

export async function deriveImportRows(
  input: DeriveInput
): Promise<DeriveResult> {
  const source: ImportSourceResult = await readImportSource({
    filename: input.filename,
    bytes: input.bytes,
    sheetName: input.sheetName,
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

  // Re-validated even though analyze proposed it: the owner edited it in
  // between, and the edit arrived from the client.
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

  const validated = validateRows({
    domainId: input.domainId,
    fields: descriptor.columns,
    mapping: input.mapping,
    rows: source.table.rows,
  });

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

  const rows: DerivedRow[] = validated.map((row) => {
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

  return {
    ok: true,
    sheetName: source.sheetName,
    rows,
    validated: new Map(validated.map((r) => [r.rowNumber, r])),
    counts: {
      totalRows: validated.length,
      ready,
      warning,
      error,
      withDuplicates,
    },
  };
}
