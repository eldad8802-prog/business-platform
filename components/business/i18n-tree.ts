import type { Widen } from "@/lib/i18n/messages/types";
import type { MessageKey, Translator } from "@/lib/i18n/translate";

/**
 * Re-reads a dictionary subtree through the active translator: same shape as the Hebrew source subtree,
 * every leaf = t(`${prefix}.${path}`). Lets label maps keyed by a code (CODE_LABELS[code]) stay maps
 * while following the interface language. With the Hebrew translator the result equals the source.
 */
export function translateTree<T extends object>(t: Translator, prefix: string, source: T): Widen<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    const path = `${prefix}.${key}`;
    out[key] = typeof value === "string" ? t(path as MessageKey) : translateTree(t, path, value as object);
  }
  return out as Widen<T>;
}
