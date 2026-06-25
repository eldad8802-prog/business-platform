/**
 * Generic product placeholder glyph.
 *
 * Product identity is business data: a real imageUrl should win at the call site,
 * and when no image exists we avoid guessing a food/category emoji from text.
 * Keep this as a neutral package placeholder only.
 */
const DEFAULT_PRODUCT_PLACEHOLDER = "\u{1F4E6}";

export function getProductEmoji(_name?: string | null, _category?: string | null): string {
  void _name;
  void _category;
  return DEFAULT_PRODUCT_PLACEHOLDER;
}
