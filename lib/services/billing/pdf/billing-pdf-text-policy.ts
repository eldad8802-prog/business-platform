/**
 * Central dynamic text policy for Billing HTML→PDF.
 *
 * • No reverse(), no BiDi control chars, no NBSP hacks.
 * • Context selects isolate + dir; embedded Noto handles glyphs.
 */

export type PdfDynamicTextContext =
  | "freeText"
  | "mixed"
  | "english"
  | "numeric"
  | "email"
  | "phone"
  | "label";

function stripBidiControls(value: string): string {
  return value.replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "");
}

/** Structural HTML escaping only (never transforms logical text). */
export function escapeHtmlForPdf(s: string): string {
  const raw = typeof s === "string" ? s : String(s);
  return stripBidiControls(raw)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Wraps user/DB text for Chromium HTML→PDF. Context selects direction/isolation;
 * value is never transformed except escaping + BiDi strip.
 */
export function renderDynamicPdfText(
  value: string,
  context: PdfDynamicTextContext
): string {
  const safe = escapeHtmlForPdf(value);

  switch (context) {
    case "numeric":
    case "email":
    case "phone":
      return `<span class="pdf-dyn pdf-dyn--ltr" dir="ltr">${safe}</span>`;

    case "english":
      return `<span class="pdf-dyn pdf-dyn--en" dir="ltr">${safe}</span>`;

    case "label":
      return `<span class="pdf-dyn pdf-dyn--label" dir="rtl">${safe}</span>`;

    case "mixed":
      return `<span class="pdf-dyn pdf-dyn--mixed" dir="rtl">${safe}</span>`;

    case "freeText":
    default:
      return `<span class="pdf-dyn pdf-dyn--he" dir="rtl">${safe}</span>`;
  }
}
