/**
 * Structured Fields Foundation — Stage A (types only, no behavior).
 *
 * Defines what a "Bot Field" is in the system. This is a pure data model:
 *   - It does NOT touch the live conversation flow, the response planner,
 *     bot policy, NLU, or Message persistence.
 *   - It does NOT yet write to Customer / Appointment. `mapsTo` only DECLARES
 *     an intended destination; no writer consumes it in Stage A.
 *
 * Persistence note: today `BusinessBotSettings.questions` is the legacy shape
 * `{ items: string[] }` (free-text questions). These types describe the
 * forward-looking v2 shape `{ version: 2, fields: BotField[] }`. Stage A does
 * NOT persist v2 anywhere — the normalizer ([normalize-bot-fields]) only READS
 * whatever shape exists and always yields a uniform `BotField[]`.
 */

/** Supported field kinds. `text` is the legacy-equivalent (free text). */
export type BotFieldType =
  | "text"
  | "phone"
  | "email"
  | "date"
  | "datetime"
  | "select"
  | "multiselect"
  | "image";

export const BOT_FIELD_TYPES: readonly BotFieldType[] = [
  "text",
  "phone",
  "email",
  "date",
  "datetime",
  "select",
  "multiselect",
  "image",
];

/** A single choice for `select` / `multiselect` fields. */
export type BotFieldOption = {
  value: string;
  label: string;
};

/**
 * Conservative allow-list of destinations a field MAY eventually map to.
 * Stage A does not write to any of these — the list exists so the editor /
 * validation layer can constrain `mapsTo` to known-safe targets only.
 */
export type BotFieldMapTarget =
  | "Customer.phone"
  | "Customer.email"
  | "Customer.city"
  | "Appointment.startsAt";

export const BOT_FIELD_MAP_TARGETS: readonly BotFieldMapTarget[] = [
  "Customer.phone",
  "Customer.email",
  "Customer.city",
  "Appointment.startsAt",
];

/** The canonical structured-field model. */
export type BotField = {
  /** Stable identifier for the field (e.g. "legacy_0" or a generated id). */
  id: string;
  /** Machine key used for mapping / answer correlation (snake/lower). */
  key: string;
  /** Short human label for the field (UI). */
  label: string;
  /** The question text actually asked to the customer. */
  question: string;
  /** Field kind — drives future input/validation. */
  type: BotFieldType;
  /** Whether the field must be answered. */
  required: boolean;
  /** Choices for select / multiselect. Absent/empty for other types. */
  options?: BotFieldOption[];
  /**
   * Declared destination for a future write. NEVER consumed in Stage A.
   * `null`/absent = unmapped (the common case).
   */
  mapsTo?: BotFieldMapTarget | null;
};

/** Current persisted version for the structured shape. */
export const BOT_FIELDS_VERSION = 2 as const;

/** Forward-looking persisted shape. NOT written anywhere in Stage A. */
export type BotFieldsConfigV2 = {
  version: typeof BOT_FIELDS_VERSION;
  fields: BotField[];
};

/** Legacy persisted shape — what every existing bot currently stores. */
export type LegacyQuestionsConfig = {
  items: string[];
};
