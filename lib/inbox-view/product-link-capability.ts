/**
 * Product Link Mode v1 — capability for inbox SBA / future flows.
 * Not a catalog: only a single outbound URL + optional intro text.
 */

export const MAX_PRODUCT_LINK_URL_CHARS = 2048;
export const MAX_PRODUCT_LINK_INTRO_CHARS = 600;

export function isValidProductLinkUrl(
  raw: string | null | undefined
): boolean {
  if (raw == null || typeof raw !== "string") return false;
  const t = raw.trim();
  if (!t || t.length > MAX_PRODUCT_LINK_URL_CHARS) return false;
  try {
    const u = new URL(t);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

export type ProductLinkCapabilityInput = {
  productLinkEnabled: boolean;
  productLinkUrl: string | null;
} | null;

/**
 * Mirrors SBA gate: enabled flag plus syntactically valid http(s) URL.
 */
export function computeProductCatalogEnabled(
  settings: ProductLinkCapabilityInput
): boolean {
  if (!settings?.productLinkEnabled) return false;
  return isValidProductLinkUrl(settings.productLinkUrl);
}

/** Message body for inbox composer when owner taps Product Link chip. */
export function formatProductLinkComposerText(
  intro: string | null | undefined,
  url: string | null | undefined
): string {
  const introTrim = (intro ?? "").trim();
  const urlTrim = (url ?? "").trim();
  if (!isValidProductLinkUrl(urlTrim)) return introTrim;
  if (introTrim) return `${introTrim}\n\n${urlTrim}`;
  return urlTrim;
}
