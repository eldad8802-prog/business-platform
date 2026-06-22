/**
 * Template Materialization — Stage D (pure helpers, no I/O).
 *
 * Converts a read-only `BotTemplate` into the structured config a business
 * would own. These functions are PURE: deterministic, side-effect-free, and
 * they do NOT persist, touch Prisma, call the API, or change the planner.
 *
 * Source-of-truth contract (locked):
 *   - `questions` is v2 `{ version: 2, fields }` — the NEW source of truth.
 *   - `legacyItems` is a COMPATIBILITY PROJECTION only, derived from `fields`
 *     via `botFieldsToLegacyItems`. Never authored, never a source of truth.
 *     It exists so a future save path keeps `parseQuestionItems` + the planner
 *     working unchanged.
 *
 * Materialization is copy/snapshot, one-directional (Catalog -> config). It
 * never writes back to the catalog.
 */

import {
  botFieldsToLegacyItems,
  getCatalogField,
  type BotField,
  type BotFieldsConfigV2,
} from "../bot-fields";
import type { FinalAction } from "../final-action";
import type { BotTemplate } from "./bot-template.types";

/**
 * Pure projection of a template into business-owned bot fields.
 *
 * One `BotField` per `fieldRef`, ordered by `order`. Field shape (type /
 * mapsTo / options / label) is read from the Field Catalog so the output is
 * strongly typed; `required` and the (overridable) `question` come from the
 * ref. Unknown catalog keys are skipped defensively (catalog integrity
 * guarantees there are none).
 */
export function templateToBotFields(template: BotTemplate): BotField[] {
  return [...template.fieldRefs]
    .sort((a, b) => a.order - b.order)
    .map((ref): BotField | null => {
      const field = getCatalogField(ref.catalogKey);
      if (!field) return null;
      const botField: BotField = {
        id: ref.catalogKey,
        key: ref.catalogKey,
        catalogKey: ref.catalogKey,
        label: field.defaultLabel,
        question: ref.questionOverride?.trim() || field.defaultQuestion,
        type: field.type,
        required: ref.required,
        mapsTo: field.mapsTo,
      };
      if (field.options) {
        botField.options = field.options;
      }
      return botField;
    })
    .filter((f): f is BotField => f !== null);
}

/** Provenance metadata — a record of origin, NOT a live link to the catalog. */
export type TemplateProvenance = {
  sourceTemplateKey: string;
  sourceTemplateVersion: number;
};

/**
 * The materialized config a business would own. Maps 1:1 to the conceptual
 * BusinessBotSettings columns, but this helper does NOT persist anything.
 */
export type MaterializedBotConfig = {
  /** v2 structured questions — the source of truth. */
  questions: BotFieldsConfigV2;
  /** Derived compatibility projection for the legacy planner. Not a SoT. */
  legacyItems: string[];
  welcomeMessage: string;
  finalAction: FinalAction;
  provenance: TemplateProvenance;
};

/**
 * Pure materialization of a template into a business config snapshot.
 * No persistence. `questions` holds v2 (SoT); `legacyItems` is derived from
 * `questions.fields` via the existing bridge.
 */
export function materializeTemplateConfig(
  template: BotTemplate
): MaterializedBotConfig {
  const fields = templateToBotFields(template);
  return {
    questions: { version: 2, fields },
    legacyItems: botFieldsToLegacyItems(fields),
    welcomeMessage: template.welcomeMessage,
    finalAction: template.finalAction,
    provenance: {
      sourceTemplateKey: template.key,
      sourceTemplateVersion: template.templateVersion,
    },
  };
}
