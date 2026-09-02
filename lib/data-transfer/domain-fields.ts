/**
 * The ONE field description a domain has, shared by every data-transfer
 * surface.
 *
 * # Why one model and not two lists
 *
 * An export column list and an import template column list that are written
 * separately drift, and the drift is silent: the template teaches the owner a
 * column the importer will not accept, or the export ships a field the template
 * never mentions. So a domain declares its fields ONCE, and each surface
 * filters the same list by capability.
 *
 * # exportable is not importable
 *
 * These are genuinely different questions and the model keeps them apart:
 *
 *  - `exportable` — does this belong in a copy of the owner's data? "נוצר
 *    בתאריך" does: it tells them when a record started. It is NOT importable,
 *    because the system sets it; asking an owner to supply it would invite them
 *    to fabricate history.
 *  - `importable` — will the canonical create service actually ACCEPT this
 *    value? That is a fact about `customerService.createCustomer` and friends,
 *    not a preference. A template that offers a field the service ignores is a
 *    promise the product cannot keep.
 *
 * `required` is therefore derived from the SERVICE's validation, never from the
 * database column's nullability: a Prisma-nullable column can still be
 * mandatory for a meaningful business record, and a NOT NULL column with a
 * default is not something the owner must supply.
 *
 * `aliases` is declared now and unused — I-5's column mapping will populate it.
 * It lives here so the synonym vocabulary ends up attached to the field it
 * describes rather than in a separate table that can fall out of step.
 */

import type { XlsxColumnType } from "@/lib/data-transfer/format/xlsx-writer";

export type DomainFieldSpec = {
  /** Owner-facing Hebrew label — the field's identity on EVERY surface. */
  header: string;
  /** Cell type for spreadsheet rendering and (later) parsing. */
  type: XlsxColumnType;
  /** Column width hint. */
  width?: number;

  /** Included in an export artifact. */
  exportable: boolean;
  /** Accepted by the domain's canonical create service. */
  importable: boolean;
  /**
   * Mandatory on import. Meaningless unless `importable`. Derived from the
   * service's own validation — see each descriptor for the evidence.
   */
  required?: boolean;

  /** One line telling the owner what to put here. Instructions sheet. */
  help?: string;
  /** Business values for a controlled vocabulary, in Hebrew. */
  allowedValues?: readonly string[];
  /** SYNTHETIC example. Never real business data. */
  example?: string;

  /** Reserved for I-5 column mapping. Deliberately empty today. */
  aliases?: readonly string[];
};

export function exportableFields(
  fields: readonly DomainFieldSpec[]
): DomainFieldSpec[] {
  return fields.filter((f) => f.exportable);
}

export function importableFields(
  fields: readonly DomainFieldSpec[]
): DomainFieldSpec[] {
  return fields.filter((f) => f.importable);
}

export function requiredImportFields(
  fields: readonly DomainFieldSpec[]
): DomainFieldSpec[] {
  return fields.filter((f) => f.importable && f.required === true);
}
