/**
 * Creatomate overlay text: Hebrew-safe shaping + RTL isolate for mixed strings.
 * Does not change creative meaning — only punctuation normalization and safe truncation.
 */

const RLI = "\u2067"; // Right-to-left isolate
const PDI = "\u2069"; // Pop directional isolate

export const CREATOMATE_HEBREW_FONT_FAMILY = "Arial";

/** Arial is a Creatomate built-in font — no external source required. */
export function defaultCreatomateHebrewFonts(): {
  family: string;
  weight: number;
  style: string;
  source: string;
}[] {
  return [];
}

export function prepareCreatomateOverlayText(raw: string, maxChars: number): string {
  let s = String(raw ?? "");
  try {
    s = s.normalize("NFKC");
  } catch {
    /* ignore invalid unicode */
  }

  s = s.replace(/[\u200B-\u200D\uFEFF]/g, "");
  s = s.replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, "-");
  s = s.replace(/[\u201C\u201D\u00AB\u00BB]/g, '"');
  s = s.replace(/[\u2018\u2019]/g, "'");
  s = s.replace(/\s+/g, " ").trim();

  if (!s) return "";

  const chars = [...s];
  const cap = Math.max(8, maxChars);
  const body =
    chars.length > cap
      ? `${chars.slice(0, cap - 1).join("")}…`
      : chars.join("");

  return `${RLI}${body}${PDI}`;
}
