/**
 * Central dynamic text policy for Billing HTML→PDF.
 *
 * • No reverse(), no BiDi control chars in output (strip on input).
 * • Hebrew / mixed RTL → inner `<span dir="rtl" class="pdf-bidi-plain">` with
 *   `unicode-bidi: plaintext` (CSS) so Chromium PDF preserves natural word order.
 * • LTR values (numeric/email/phone/english) → inline span with isolate + dir=ltr.
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

type FreeTextBidiStrategy = "bdi" | "isolate-rtl" | "plaintext-auto" | "plaintext-rtl";

function freeTextBidiStrategy(): FreeTextBidiStrategy {
  const v = (process.env.BILLING_PDF_FREE_TEXT_BIDI ?? "").trim().toLowerCase();
  if (v === "bdi") return "bdi";
  if (v === "isolate-rtl") return "isolate-rtl";
  if (v === "plaintext-auto") return "plaintext-auto";
  if (v === "plaintext-rtl") return "plaintext-rtl";
  // Default: keep current behavior until proven otherwise by matrix tests.
  return "plaintext-rtl";
}

/**
 * User-entered free text (Hebrew, mixed with numbers/punctuation).
 *
 * Must NEVER reverse or alter content; only isolate directionality.
 * Strategy is switchable for diagnostics via `BILLING_PDF_FREE_TEXT_BIDI`.
 */
export function renderFreeText(value: string): string {
  const safe = escapeHtmlForPdf(value);
  const outer = `pdf-dyn pdf-dyn--he`;

  switch (freeTextBidiStrategy()) {
    // A) <bdi dir="rtl">…</bdi>
    case "bdi":
      return `<div class="${outer}"><bdi dir="auto" class="pdf-bidi-free-text-auto">${safe}</bdi></div>`;

    // B) <span dir="rtl" style="unicode-bidi:isolate">…</span>
    case "isolate-rtl":
      return `<div class="${outer}"><span dir="rtl" class="pdf-bidi-free-text-isolate">${safe}</span></div>`;

    // C) <span dir="auto" style="unicode-bidi:plaintext">…</span>
    case "plaintext-auto":
      return `<div class="${outer}"><span dir="auto" class="pdf-bidi-plain-auto pdf-bidi-plain--body">${safe}</span></div>`;

    // D) <span dir="rtl" style="unicode-bidi:plaintext">…</span> (current)
    case "plaintext-rtl":
    default:
      return `<div class="${outer}"><span dir="rtl" class="pdf-bidi-plain pdf-bidi-plain--body">${safe}</span></div>`;
  }
}

/**
 * Hebrew / RTL logical text: plaintext embedding avoids nested `unicode-bidi: embed`
 * fighting HarfBuzz in headless Chromium PDF (reversed words / broken runs).
 */
function wrapRtlPlaintext(
  safe: string,
  variant: "label" | "mixed" | "freeText"
): string {
  const mod =
    variant === "label"
      ? "pdf-bidi-plain pdf-bidi-plain--label"
      : variant === "mixed"
        ? "pdf-bidi-plain pdf-bidi-plain--mixed"
        : "pdf-bidi-plain pdf-bidi-plain--body";
  const outer =
    variant === "label"
      ? "pdf-dyn pdf-dyn--label"
      : variant === "mixed"
        ? "pdf-dyn pdf-dyn--mixed"
        : "pdf-dyn pdf-dyn--he";
  return `<div class="${outer}"><span dir="rtl" class="${mod}">${safe}</span></div>`;
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
      return wrapRtlPlaintext(safe, "label");

    case "mixed":
      return wrapRtlPlaintext(safe, "mixed");

    case "freeText":
    default:
      return renderFreeText(value);
  }
}
