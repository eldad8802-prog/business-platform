/**
 * Field Catalog — read-only helpers + integrity validator.
 *
 * Pure lookups over the canonical `BOT_FIELD_CATALOG`. No side effects, no
 * persistence, no conversation-flow coupling.
 */

import { BOT_FIELD_MAP_TARGETS, BOT_FIELD_TYPES } from "./bot-field.types";
import { BOT_FIELD_CATALOG } from "./field-catalog";
import {
  BUILDER_VISIBILITIES,
  FIELD_CLASSES,
  FIELD_NAMESPACES,
  type BuilderVisibility,
  type CatalogField,
  type FieldClass,
  type FieldNamespace,
} from "./field-catalog.types";

// Built once at module load — the catalog is static.
const CATALOG_BY_KEY: ReadonlyMap<string, CatalogField> = new Map(
  BOT_FIELD_CATALOG.map((f) => [f.key, f])
);

/** Returns the catalog definition for a key, or `undefined` when unknown. */
export function getCatalogField(key: string): CatalogField | undefined {
  if (typeof key !== "string" || key.length === 0) return undefined;
  return CATALOG_BY_KEY.get(key);
}

/** True when `key` is a known catalog key. */
export function isCatalogKey(key: unknown): key is string {
  return typeof key === "string" && CATALOG_BY_KEY.has(key);
}

export type ListCatalogFieldsOptions = {
  namespace?: FieldNamespace;
  fieldClass?: FieldClass;
  builderV1?: BuilderVisibility;
};

/** Returns catalog fields filtered by namespace / class / builder visibility. */
export function listCatalogFields(
  opts: ListCatalogFieldsOptions = {}
): CatalogField[] {
  return BOT_FIELD_CATALOG.filter((f) => {
    if (opts.namespace && f.namespace !== opts.namespace) return false;
    if (opts.fieldClass && f.fieldClass !== opts.fieldClass) return false;
    if (opts.builderV1 && f.builderV1 !== opts.builderV1) return false;
    return true;
  });
}

/** Convenience: the fields exposed in the generic Bot Builder v1 palette. */
export function getBuilderV1Fields(): CatalogField[] {
  return listCatalogFields({ builderV1: "shown" });
}

/**
 * Dev/test invariant check for the catalog. Throws on the first violation.
 * Not called by any runtime path — exercised by the verify script so a bad
 * catalog edit fails loudly rather than silently shipping.
 */
export function assertCatalogIntegrity(): void {
  const validTypes = new Set<string>(BOT_FIELD_TYPES);
  const validTargets = new Set<string>(BOT_FIELD_MAP_TARGETS);
  const validNamespaces = new Set<string>(FIELD_NAMESPACES);
  const validClasses = new Set<string>(FIELD_CLASSES);
  const validVisibilities = new Set<string>(BUILDER_VISIBILITIES);
  const seen = new Set<string>();

  for (const f of BOT_FIELD_CATALOG) {
    if (!f.key) throw new Error("catalog: empty key");
    if (seen.has(f.key)) throw new Error(`catalog: duplicate key "${f.key}"`);
    seen.add(f.key);

    if (!validNamespaces.has(f.namespace)) {
      throw new Error(`catalog[${f.key}]: bad namespace "${f.namespace}"`);
    }
    if (!validClasses.has(f.fieldClass)) {
      throw new Error(`catalog[${f.key}]: bad fieldClass "${f.fieldClass}"`);
    }
    if (!validTypes.has(f.type)) {
      throw new Error(`catalog[${f.key}]: bad type "${f.type}"`);
    }
    if (!validVisibilities.has(f.builderV1)) {
      throw new Error(`catalog[${f.key}]: bad builderV1 "${f.builderV1}"`);
    }

    // mapsTo must be null or an allow-listed target.
    if (f.mapsTo !== null && !validTargets.has(f.mapsTo)) {
      throw new Error(
        `catalog[${f.key}]: mapsTo "${f.mapsTo}" is not in BOT_FIELD_MAP_TARGETS`
      );
    }

    // namespace ⇔ class coherence: conversation.* must be conversation class;
    // every other namespace must be data class.
    const expectedClass: FieldClass =
      f.namespace === "conversation" ? "conversation" : "data";
    if (f.fieldClass !== expectedClass) {
      throw new Error(
        `catalog[${f.key}]: namespace "${f.namespace}" expects fieldClass "${expectedClass}"`
      );
    }

    // options only allowed on select / multiselect.
    if (f.options && f.type !== "select" && f.type !== "multiselect") {
      throw new Error(`catalog[${f.key}]: options not allowed for type "${f.type}"`);
    }

    if (!f.defaultLabel.trim() || !f.defaultQuestion.trim()) {
      throw new Error(`catalog[${f.key}]: defaultLabel/defaultQuestion required`);
    }
  }
}
