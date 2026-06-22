/**
 * Template Catalog — read-only helpers + integrity validator.
 *
 * Pure lookups + a preview-only resolver. No materialization to BotField[],
 * no persistence, no conversation-flow coupling.
 */

import { BUSINESS_CATEGORY_OPTIONS } from "@/lib/constants/business-categories";
import { getCatalogField, isCatalogKey } from "../bot-fields";
import { FINAL_ACTIONS, isFinalAction } from "../final-action";
import { BOT_TEMPLATE_CATALOG } from "./template-catalog";
import {
  GENERIC_TEMPLATE_CATEGORY,
  TEMPLATE_VERSION,
  type BotTemplate,
  type ResolvedTemplateField,
} from "./bot-template.types";

const TEMPLATES_BY_KEY: ReadonlyMap<string, BotTemplate> = new Map(
  BOT_TEMPLATE_CATALOG.map((t) => [t.key, t])
);

const TEMPLATE_BY_CATEGORY: ReadonlyMap<string, BotTemplate> = new Map(
  BOT_TEMPLATE_CATALOG.filter(
    (t) => t.category !== GENERIC_TEMPLATE_CATEGORY
  ).map((t) => [t.category, t])
);

/** The guaranteed fallback template. */
export function getDefaultTemplate(): BotTemplate {
  const generic = TEMPLATES_BY_KEY.get("generic_default");
  if (!generic) {
    // Guarded by assertTemplateCatalogIntegrity; defensive for runtime safety.
    throw new Error("template-catalog: generic_default is missing");
  }
  return generic;
}

/** Lookup by template key. */
export function getTemplate(key: string): BotTemplate | undefined {
  if (typeof key !== "string" || key.length === 0) return undefined;
  return TEMPLATES_BY_KEY.get(key);
}

export function listTemplates(): BotTemplate[] {
  return [...BOT_TEMPLATE_CATALOG];
}

/**
 * Resolve a business category to its default template. Unknown / `"Other"` /
 * empty categories fall back to the generic template.
 */
export function getTemplateForCategory(
  category: string | null | undefined
): BotTemplate {
  if (typeof category === "string") {
    const match = TEMPLATE_BY_CATEGORY.get(category);
    if (match) return match;
  }
  return getDefaultTemplate();
}

/**
 * PREVIEW-ONLY projection: join each fieldRef with its catalog definition and
 * apply the question override. Read-only — this does NOT create BotField
 * instances and does NOT persist anything. Unknown catalog keys are skipped
 * defensively (integrity guarantees there are none).
 */
export function resolveTemplate(template: BotTemplate): ResolvedTemplateField[] {
  return [...template.fieldRefs]
    .sort((a, b) => a.order - b.order)
    .map((ref): ResolvedTemplateField | null => {
      const field = getCatalogField(ref.catalogKey);
      if (!field) return null;
      return {
        catalogKey: ref.catalogKey,
        order: ref.order,
        required: ref.required,
        question: ref.questionOverride?.trim() || field.defaultQuestion,
        label: field.defaultLabel,
        type: field.type,
        mapsTo: field.mapsTo,
        options: field.options,
      };
    })
    .filter((f): f is ResolvedTemplateField => f !== null);
}

/**
 * Dev/test invariant check. Throws on the first violation. Not called by any
 * runtime path — exercised by the verify script.
 */
export function assertTemplateCatalogIntegrity(): void {
  const validCategories = new Set<string>([
    ...BUSINESS_CATEGORY_OPTIONS.map((c) => c.value),
    GENERIC_TEMPLATE_CATEGORY,
  ]);
  const seenKeys = new Set<string>();
  const seenCategories = new Set<string>();
  let genericCount = 0;

  for (const t of BOT_TEMPLATE_CATALOG) {
    if (t.templateVersion !== TEMPLATE_VERSION) {
      throw new Error(`template[${t.key}]: templateVersion must be ${TEMPLATE_VERSION}`);
    }
    if (!t.key) throw new Error("template: empty key");
    if (seenKeys.has(t.key)) throw new Error(`template: duplicate key "${t.key}"`);
    seenKeys.add(t.key);

    if (!validCategories.has(t.category)) {
      throw new Error(`template[${t.key}]: unknown category "${t.category}"`);
    }
    // One-to-one category → template (excluding the generic sentinel).
    if (t.category !== GENERIC_TEMPLATE_CATEGORY) {
      if (seenCategories.has(t.category)) {
        throw new Error(`template[${t.key}]: category "${t.category}" mapped more than once`);
      }
      seenCategories.add(t.category);
    } else {
      genericCount += 1;
    }

    if (t.partyRole !== "CUSTOMER") {
      throw new Error(`template[${t.key}]: partyRole must be CUSTOMER in v1`);
    }
    if (!isFinalAction(t.finalAction)) {
      throw new Error(`template[${t.key}]: invalid finalAction "${t.finalAction}"`);
    }
    if (!t.label.trim() || !t.welcomeMessage.trim()) {
      throw new Error(`template[${t.key}]: label/welcomeMessage required`);
    }
    if (t.fieldRefs.length === 0) {
      throw new Error(`template[${t.key}]: must reference at least one field`);
    }

    const seenOrders = new Set<number>();
    const seenRefKeys = new Set<string>();
    for (const ref of t.fieldRefs) {
      if (!isCatalogKey(ref.catalogKey)) {
        throw new Error(`template[${t.key}]: unknown catalogKey "${ref.catalogKey}"`);
      }
      if (seenRefKeys.has(ref.catalogKey)) {
        throw new Error(`template[${t.key}]: duplicate catalogKey "${ref.catalogKey}"`);
      }
      seenRefKeys.add(ref.catalogKey);

      if (!Number.isInteger(ref.order) || ref.order <= 0) {
        throw new Error(`template[${t.key}]: order must be a positive integer`);
      }
      if (seenOrders.has(ref.order)) {
        throw new Error(`template[${t.key}]: duplicate order ${ref.order}`);
      }
      seenOrders.add(ref.order);

      if (
        ref.questionOverride !== undefined &&
        ref.questionOverride.trim().length === 0
      ) {
        throw new Error(`template[${t.key}]: empty questionOverride`);
      }
    }
  }

  if (genericCount !== 1) {
    throw new Error(`template-catalog: expected exactly one generic template, got ${genericCount}`);
  }
}
