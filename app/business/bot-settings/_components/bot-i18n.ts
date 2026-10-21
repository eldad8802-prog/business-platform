/**
 * Localized labels for the bot option lists that live in lib/features/** (Hebrew, single source).
 *
 * The lib lists stay untouched (tests and server code read them); the UI resolves each option's
 * label through `content.bot.options.<group>.<value>`. Hebrew text in the dictionary is identical to
 * the lib labels, and an unknown value falls back to the lib label — Hebrew output never changes.
 */
import type { MessageKey, Translator } from "@/lib/i18n/translate";

export type BotOptionGroup =
  | "tone"
  | "verbosity"
  | "trait"
  | "language"
  | "audience"
  | "saleStyle"
  | "initiative"
  | "priority"
  | "learningType"
  | "memory"
  | "forbidden"
  | "boundary"
  | "workMode"
  | "finalAction"
  | "goalCategory"
  | "goal";

/** `t(key)` or `fallback` when the dictionary has no such key (the translator returns the key). */
function lookup(t: Translator, key: string, fallback: string): string {
  const out = t(key as MessageKey);
  return out === key ? fallback : out;
}

/** Label of a flat option (`options.<group>.<value>`). */
export function botOptionLabel(t: Translator, group: BotOptionGroup, value: string, fallback: string): string {
  return lookup(t, `content.bot.options.${group}.${value}`, fallback);
}

/** A field of a structured option (`options.<group>.<value>.<field>`). */
export function botOptionField(
  t: Translator,
  group: BotOptionGroup,
  value: string,
  field: "label" | "hint" | "title" | "description" | "trustLine",
  fallback: string
): string {
  return lookup(t, `content.bot.options.${group}.${value}.${field}`, fallback);
}

/** `{ value, label }` lists with flat labels (tone, trait, language, audience, initiative, priority…). */
export function localizeValueOptions<T extends { value: string; label: string }>(
  t: Translator,
  group: BotOptionGroup,
  options: ReadonlyArray<T>
): T[] {
  return options.map((o) => ({ ...o, label: botOptionLabel(t, group, o.value, o.label) }));
}

/** `{ value, label, hint }` lists (verbosity, sale style). */
export function localizeValueHintOptions<T extends { value: string; label: string; hint: string }>(
  t: Translator,
  group: BotOptionGroup,
  options: ReadonlyArray<T>
): T[] {
  return options.map((o) => ({
    ...o,
    label: botOptionField(t, group, o.value, "label", o.label),
    hint: botOptionField(t, group, o.value, "hint", o.hint),
  }));
}

/** `{ key, label, hint }` lists (memory toggles, forbidden presets, handoff boundaries). */
export function localizeKeyOptions<T extends { key: string; label: string; hint: string }>(
  t: Translator,
  group: BotOptionGroup,
  options: ReadonlyArray<T>
): T[] {
  return options.map((o) => ({
    ...o,
    label: botOptionField(t, group, o.key, "label", o.label),
    hint: botOptionField(t, group, o.key, "hint", o.hint),
  }));
}

/** Work-mode cards (`{ id, title, description, trustLine }`). */
export function localizeWorkModes<T extends { id: string; title: string; description: string; trustLine: string }>(
  t: Translator,
  options: ReadonlyArray<T>
): T[] {
  return options.map((o) => ({
    ...o,
    title: botOptionField(t, "workMode", o.id, "title", o.title),
    description: botOptionField(t, "workMode", o.id, "description", o.description),
    trustLine: botOptionField(t, "workMode", o.id, "trustLine", o.trustLine),
  }));
}
