/**
 * Bot Template — Stage C (Ordered Form / L1, read-only).
 *
 * A template is a DATA entity: an ordered composition of references to Field
 * Catalog keys plus a thin conversation wrapper. It is NOT a flow entity —
 * no conditions, branching, skips, value-dependent questions, or rules.
 *
 * `fieldRefs` are OBJECTS (not strings) to leave an additive door open for a
 * future `showIf?` without breaking v1. `templateVersion` is the gate for any
 * such future L2 shape.
 *
 * This module is pure data + types. No materialization, no persistence, no
 * conversation-flow coupling.
 */

import type { FinalAction } from "../final-action";

/** Counterparty role a template collects for. v1 invariant: always CUSTOMER. */
export type PartyRole = "CUSTOMER" | "SUPPLIER" | "EMPLOYEE" | "ACCOUNTANT";

/** Current template shape version. */
export const TEMPLATE_VERSION = 1 as const;

/** Sentinel category for the fallback template (not a business category). */
export const GENERIC_TEMPLATE_CATEGORY = "generic" as const;

/**
 * Either a business category value (from BUSINESS_CATEGORY_OPTIONS) or the
 * generic sentinel. Kept as `string` here; validated against the real set in
 * `assertTemplateCatalogIntegrity`.
 */
export type TemplateCategory = string;

/** A single ordered reference from a template to a Field Catalog entry. */
export type TemplateFieldRef = {
  /** Must resolve via `isCatalogKey` to a known catalog field. */
  catalogKey: string;
  /** 1-based position; unique within the template. */
  order: number;
  /** Whether the field is required in this template. */
  required: boolean;
  /** Overrides the catalog field's defaultQuestion. Non-empty when present. */
  questionOverride?: string;
};

/** The canonical template definition. */
export type BotTemplate = {
  templateVersion: typeof TEMPLATE_VERSION;
  /** Stable, unique identifier (e.g. "beauty_default"). */
  key: string;
  /** Business category this template is the default for, or "generic". */
  category: TemplateCategory;
  /** v1: always "CUSTOMER". */
  partyRole: PartyRole;
  /** Human label for a future picker. */
  label: string;
  /** Seed welcome message (the business may later edit a materialized copy). */
  welcomeMessage: string;
  /** Concluding action — from the FinalAction SoT. */
  finalAction: FinalAction;
  /** Ordered composition of catalog-key references. */
  fieldRefs: TemplateFieldRef[];
};

/** Read-only projection of one resolved field (template ref joined with catalog). */
export type ResolvedTemplateField = {
  catalogKey: string;
  order: number;
  required: boolean;
  /** questionOverride ?? catalog.defaultQuestion */
  question: string;
  label: string;
  type: string;
  mapsTo: string | null;
  options?: { value: string; label: string }[];
};
