/** Business-level billing PDF layout preset (HTML + pdfmake). Not per-document. */

export const BILLING_PDF_TEMPLATE_STYLES = [
  "CLASSIC",
  "MODERN",
  "COMPACT",
] as const;

export type BillingPdfTemplateStyle = (typeof BILLING_PDF_TEMPLATE_STYLES)[number];

export const DEFAULT_BILLING_PDF_TEMPLATE_STYLE: BillingPdfTemplateStyle =
  "CLASSIC";

export function parseBillingPdfTemplateStyle(
  raw: string | null | undefined
): BillingPdfTemplateStyle {
  if (!raw || typeof raw !== "string") return DEFAULT_BILLING_PDF_TEMPLATE_STYLE;
  const u = raw.trim().toUpperCase();
  if (u === "CLASSIC" || u === "MODERN" || u === "COMPACT") return u;
  return DEFAULT_BILLING_PDF_TEMPLATE_STYLE;
}

export const BILLING_PDF_TEMPLATE_STYLE_LABELS_HE: Record<
  BillingPdfTemplateStyle,
  string
> = {
  CLASSIC: "קלאסי",
  MODERN: "מודרני",
  COMPACT: "צפוף",
};

export const BILLING_PDF_TEMPLATE_STYLE_HINTS_HE: Record<
  BillingPdfTemplateStyle,
  string
> = {
  CLASSIC: "מסמך נקי ורשמי — מתאים לרוב העסקים.",
  MODERN: "כותרת בולטת יותר ומראה מודרני.",
  COMPACT: "פחות ריווח — מתאים למסמכים ארוכים.",
};
