/**
 * The translator: a typed dotted key → the active dictionary's string, with `{name}` interpolation.
 *
 * Keys are checked at compile time against the Hebrew source dictionary, so a typo or a removed key
 * fails `tsc`. A key missing at runtime (only possible for a dynamically built key) falls back to
 * the Hebrew text, then to the key itself — the UI never renders `undefined`.
 */
import { he } from "./messages/he";
import type { Messages } from "./messages/types";

type Join<K, P> = K extends string ? (P extends string ? `${K}.${P}` : never) : never;
type Paths<T> = T extends string
  ? never
  : { [K in keyof T & string]: T[K] extends string ? K : Join<K, Paths<T[K]>> }[keyof T & string];

export type MessageKey = Paths<Messages>;
export type MessageVars = Readonly<Record<string, string | number>>;
export type Translator = (key: MessageKey, vars?: MessageVars) => string;

function lookup(messages: unknown, key: string): string | undefined {
  let node: unknown = messages;
  for (const part of key.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : undefined;
}

export function interpolate(template: string, vars?: MessageVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole
  );
}

export function translate(messages: Messages, key: string, vars?: MessageVars): string {
  const text = lookup(messages, key) ?? lookup(he, key) ?? key;
  return interpolate(text, vars);
}

export function createTranslator(messages: Messages): Translator {
  return (key, vars) => translate(messages, key, vars);
}
