/**
 * Single source of truth for business domain taxonomy.
 *
 * Extracted verbatim from the onboarding screen so the same category /
 * sub-category / business-model values can be reused by other surfaces
 * (e.g. a future domain-aware bot builder) without duplicating the literal.
 *
 * Values are intentionally stable identifiers — the Hebrew `label`s are for
 * display only. Do NOT rename `value`s: they are persisted as free-text on
 * `BusinessProfile.category` / `subCategory` / `businessModel`.
 */

export type BusinessSubCategoryOption = {
  value: string;
  label: string;
};

export type BusinessCategoryOption = {
  value: string;
  label: string;
  subCategories: BusinessSubCategoryOption[];
};

export type BusinessModelOption = {
  value: string;
  label: string;
};

export const BUSINESS_CATEGORY_OPTIONS: BusinessCategoryOption[] = [
  {
    value: "Beauty",
    label: "יופי וטיפוח",
    subCategories: [
      { value: "Nails", label: "ציפורניים" },
      { value: "Hair", label: "שיער" },
      { value: "Skincare", label: "טיפוח פנים ועור" },
      { value: "Cosmetics", label: "קוסמטיקה" },
      { value: "Lashes", label: "ריסים וגבות" },
      { value: "Makeup", label: "איפור" },
    ],
  },
  {
    value: "Food",
    label: "אוכל ומשקאות",
    subCategories: [
      { value: "Restaurant", label: "מסעדה" },
      { value: "Bakery", label: "מאפייה" },
      { value: "Catering", label: "קייטרינג" },
      { value: "Street Food", label: "אוכל רחוב" },
      { value: "Desserts", label: "קינוחים" },
      { value: "Cafe", label: "בית קפה" },
    ],
  },
  {
    value: "Fitness",
    label: "כושר ואימון",
    subCategories: [
      { value: "Personal Training", label: "אימון אישי" },
      { value: "Pilates", label: "פילאטיס" },
      { value: "Yoga", label: "יוגה" },
      { value: "Nutrition", label: "תזונה" },
      { value: "Studio", label: "סטודיו" },
    ],
  },
  {
    value: "Home Services",
    label: "שירותי בית",
    subCategories: [
      { value: "Cleaning", label: "ניקיון" },
      { value: "Moving", label: "הובלות" },
      { value: "Repairs", label: "תיקונים" },
      { value: "Air Conditioning", label: "מיזוג אוויר" },
      { value: "Plumbing", label: "אינסטלציה" },
      { value: "Electrical", label: "חשמל" },
    ],
  },
  {
    value: "Events",
    label: "אירועים",
    subCategories: [
      { value: "Photography", label: "צילום" },
      { value: "DJ", label: "די ג'יי" },
      { value: "Decor", label: "עיצוב" },
      { value: "Production", label: "הפקה" },
      { value: "Bar", label: "בר לאירועים" },
    ],
  },
  {
    value: "Retail",
    label: "קמעונאות ומכירה",
    subCategories: [
      { value: "Fashion", label: "אופנה" },
      { value: "Gifts", label: "מתנות" },
      { value: "Accessories", label: "אקססוריז" },
      { value: "Home Design", label: "עיצוב לבית" },
      { value: "Online Store", label: "חנות אונליין" },
    ],
  },
  {
    value: "Other",
    label: "אחר",
    subCategories: [{ value: "General", label: "כללי" }],
  },
];

export const BUSINESS_MODEL_OPTIONS: BusinessModelOption[] = [
  { value: "service", label: "שירות" },
  { value: "product", label: "מוצר" },
  { value: "hybrid", label: "שירות + מוצר" },
];
