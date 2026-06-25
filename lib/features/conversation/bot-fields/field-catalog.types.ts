/**
 * Field Catalog — Stage B (definitions, read-only).
 *
 * The catalog is the system's Source of Truth for "which fields exist in the
 * world". A `CatalogField` is a DEFINITION (system-owned, stable) — distinct
 * from a `BotField` instance (a per-bot usage that references a catalog entry
 * via `catalogKey`). See Field Catalog v1.
 *
 * This module is pure data + types. It does NOT touch the conversation flow,
 * planner, NLU, persistence, or perform any mapping writes.
 */

import type {
  BotFieldMapTarget,
  BotFieldOption,
  BotFieldType,
} from "./bot-field.types";

/** Top-level grouping of a catalog field. */
export type FieldNamespace = "party" | "appointment" | "subject" | "conversation";

export const FIELD_NAMESPACES: readonly FieldNamespace[] = [
  "party",
  "appointment",
  "subject",
  "conversation",
];

/**
 * Field class — meaning axis (independent of whether it maps to a column):
 *   - `data`         → real, long-term business meaning.
 *   - `conversation` → advances the chat; not necessarily part of the data model.
 */
export type FieldClass = "data" | "conversation";

export const FIELD_CLASSES: readonly FieldClass[] = ["data", "conversation"];

/** Whether the field appears in the generic Bot Builder v1 field palette. */
export type BuilderVisibility = "shown" | "reserved";

export const BUILDER_VISIBILITIES: readonly BuilderVisibility[] = [
  "shown",
  "reserved",
];

/** A single canonical field definition in the catalog. */
export type CatalogField = {
  /** Stable, namespaced identifier (e.g. "party_name"). Unique in the catalog. */
  key: string;
  /** Grouping namespace. */
  namespace: FieldNamespace;
  /** Meaning class — data vs conversation. */
  fieldClass: FieldClass;
  /** Canonical input type. */
  type: BotFieldType;
  /**
   * Canonical write destination, or `null` for generic / reserved fields.
   * Only targets present in `BOT_FIELD_MAP_TARGETS` are permitted. Stage B
   * keeps this DECLARATIVE — no writer consumes it.
   */
  mapsTo: BotFieldMapTarget | null;
  /** Whether it shows in the generic Bot Builder v1 palette. */
  builderV1: BuilderVisibility;
  /** Default human label (an instance may override). */
  defaultLabel: string;
  /** Default question asked to the customer (an instance may override). */
  defaultQuestion: string;
  /** Default choices for select fields (optional; instance/template may supply). */
  options?: BotFieldOption[];
};
