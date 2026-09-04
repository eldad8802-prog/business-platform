/**
 * Column mapping — deterministic heuristics, no AI, no guessing.
 *
 * The proposer answers one question per source column: which Dubiz field is
 * this, and how sure are we? It returns a PROPOSAL. The owner decides.
 *
 * # The three outcomes
 *
 *   EXACT      the header IS the canonical Hebrew label, after safe
 *              normalization. Nothing to think about.
 *   SUGGESTED  the header matches an explicit, domain-scoped alias. Plausible,
 *              and shown as a suggestion the owner confirms.
 *   AMBIGUOUS  the header matches more than one field. Never resolved by
 *              picking a winner — the owner is asked.
 *   UNMAPPED   nothing matched. The column is simply not imported.
 *
 * # Why there is no fourth, cleverer tier
 *
 * Any fuzzy tier (edit distance, substring, embeddings) buys convenience by
 * accepting a chance of writing the right value into the wrong column. That
 * error is silent, survives the preview if the owner is skimming, and is very
 * expensive to undo. An UNMAPPED column costs one click.
 *
 * A canonical label always beats an alias: if one field's canonical header and
 * another field's alias both match, that is not ambiguity, it is a clear winner.
 * Ambiguity is only ever reported BETWEEN matches of the same strength.
 */

import type { DataTransferDomainId } from "@/lib/data-transfer/domains";
import type { DomainFieldSpec } from "@/lib/data-transfer/domain-fields";
import { importableFields } from "@/lib/data-transfer/domain-fields";
import { aliasesFor } from "@/lib/data-transfer/import/domain-aliases";
import { normalizeHeaderForMatch } from "./header-normalize";

export type MappingStatus = "EXACT" | "SUGGESTED" | "AMBIGUOUS" | "UNMAPPED";

export type ColumnProposal = {
  /** Position in the uploaded file. The stable identity of a source column. */
  sourceIndex: number;
  /** Header exactly as it appears in the file. */
  sourceHeader: string;
  /** Proposed Dubiz field (its canonical Hebrew label), or null. */
  field: string | null;
  status: MappingStatus;
  /** Fields this header could equally be, when AMBIGUOUS. */
  candidates: string[];
  /** First few non-empty values, so the owner can sanity-check the guess. */
  samples: string[];
};

function matchesForHeader(
  header: string,
  fields: readonly DomainFieldSpec[],
  domainId: DataTransferDomainId
): { exact: string[]; alias: string[] } {
  const needle = normalizeHeaderForMatch(header);
  const exact: string[] = [];
  const alias: string[] = [];
  if (needle === "") return { exact, alias };

  for (const field of fields) {
    if (normalizeHeaderForMatch(field.header) === needle) {
      exact.push(field.header);
      continue;
    }
    const synonyms = aliasesFor(domainId, field.header);
    if (synonyms.some((a) => normalizeHeaderForMatch(a) === needle)) {
      alias.push(field.header);
    }
  }
  return { exact, alias };
}

/**
 * Propose a mapping for every column in the uploaded header row.
 *
 * `samples` are drawn from the file so the owner can see what a column actually
 * contains — the single most useful thing when a header is unhelpful.
 */
export function proposeMapping(input: {
  domainId: DataTransferDomainId;
  fields: readonly DomainFieldSpec[];
  headers: readonly string[];
  sampleRows: readonly (readonly unknown[])[];
  sampleCount: number;
}): ColumnProposal[] {
  const importable = importableFields(input.fields);

  return input.headers.map((sourceHeader, sourceIndex) => {
    const { exact, alias } = matchesForHeader(
      sourceHeader,
      importable,
      input.domainId
    );

    const samples: string[] = [];
    for (const row of input.sampleRows) {
      if (samples.length >= input.sampleCount) break;
      const cell = row[sourceIndex];
      if (cell == null) continue;
      const text = String(cell).trim();
      if (text.length > 0) samples.push(text.slice(0, 60));
    }

    // A canonical label outranks an alias — that is a winner, not a tie.
    if (exact.length === 1) {
      return { sourceIndex, sourceHeader, field: exact[0], status: "EXACT", candidates: [], samples };
    }
    if (exact.length > 1) {
      return { sourceIndex, sourceHeader, field: null, status: "AMBIGUOUS", candidates: exact, samples };
    }
    if (alias.length === 1) {
      return { sourceIndex, sourceHeader, field: alias[0], status: "SUGGESTED", candidates: [], samples };
    }
    if (alias.length > 1) {
      return { sourceIndex, sourceHeader, field: null, status: "AMBIGUOUS", candidates: alias, samples };
    }
    return { sourceIndex, sourceHeader, field: null, status: "UNMAPPED", candidates: [], samples };
  });
}

/**
 * A finalized mapping: source column index -> Dubiz field label. A column the
 * owner chose not to import is simply absent.
 */
export type ResolvedMapping = Record<number, string>;

export type MappingProblem =
  | { kind: "MISSING_REQUIRED"; field: string }
  | { kind: "DUPLICATE_TARGET"; field: string; sourceIndexes: number[] }
  | { kind: "UNKNOWN_FIELD"; field: string }
  | { kind: "UNKNOWN_COLUMN"; sourceIndex: number }
  | { kind: "NOT_IMPORTABLE"; field: string };

/**
 * Check a mapping the owner has finalized. Returns every problem, not just the
 * first — someone fixing a mapping wants the whole list, not a queue.
 *
 * Two source columns pointing at ONE field is refused rather than resolved:
 * picking "the first" or "the last" would silently discard data the owner
 * believed they were importing.
 */
export function validateMapping(input: {
  fields: readonly DomainFieldSpec[];
  headerCount: number;
  mapping: ResolvedMapping;
}): MappingProblem[] {
  const importable = importableFields(input.fields);
  const byLabel = new Map(importable.map((f) => [f.header, f]));
  const allLabels = new Set(input.fields.map((f) => f.header));
  const problems: MappingProblem[] = [];

  const targets = new Map<string, number[]>();
  for (const [rawIndex, field] of Object.entries(input.mapping)) {
    const sourceIndex = Number(rawIndex);
    if (
      !Number.isInteger(sourceIndex) ||
      sourceIndex < 0 ||
      sourceIndex >= input.headerCount
    ) {
      problems.push({ kind: "UNKNOWN_COLUMN", sourceIndex });
      continue;
    }
    if (!byLabel.has(field)) {
      problems.push(
        allLabels.has(field)
          ? { kind: "NOT_IMPORTABLE", field }
          : { kind: "UNKNOWN_FIELD", field }
      );
      continue;
    }
    targets.set(field, [...(targets.get(field) ?? []), sourceIndex]);
  }

  for (const [field, sourceIndexes] of targets) {
    if (sourceIndexes.length > 1) {
      problems.push({ kind: "DUPLICATE_TARGET", field, sourceIndexes });
    }
  }

  for (const field of importable) {
    if (field.required && !targets.has(field.header)) {
      problems.push({ kind: "MISSING_REQUIRED", field: field.header });
    }
  }

  return problems;
}

/**
 * Canonical, order-independent serialization of a finalized mapping.
 *
 * The preview token signs a HASH of this string, so the same mapping expressed
 * in a different key order must produce the same bytes — otherwise a caller
 * could re-send an identical mapping and be told it does not match.
 */
export function canonicalizeMapping(mapping: ResolvedMapping): string {
  return Object.keys(mapping)
    .map((k) => Number(k))
    .filter((k) => Number.isInteger(k))
    .sort((a, b) => a - b)
    .map((k) => `${k}=${mapping[k]}`)
    .join("\n");
}
