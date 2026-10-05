/**
 * The business categories an owner picks at onboarding, and their Hebrew labels.
 *
 * `BusinessProfile.category` / `subCategory` store the English `value`; every
 * screen that shows them to the owner reads the label from here. Onboarding
 * (which writes them) and Profile / Settings (which show them) used to keep
 * separate copies — this is the one copy.
 */

export type BusinessSubCategoryOption = { value: string; label: string };

export type BusinessCategoryOption = {
  value: string;
  label: string;
  subCategories: BusinessSubCategoryOption[];
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

export const BUSINESS_MODEL_OPTIONS = [
  { value: "service", label: "שירות" },
  { value: "product", label: "מוצר" },
  { value: "hybrid", label: "שירות + מוצר" },
] as const;

const OTHER_CATEGORY = "Other";

function clean(raw: string | null | undefined): string {
  return typeof raw === "string" ? raw.trim() : "";
}

export function findBusinessCategory(
  category: string | null | undefined,
): BusinessCategoryOption | null {
  const value = clean(category);
  return BUSINESS_CATEGORY_OPTIONS.find((option) => option.value === value) ?? null;
}

/**
 * The owner-facing line for a stored category: the sub-category's label when it
 * is known (the more specific of the two), else the category's.
 *
 * A stored value with no label in the map is shown as stored rather than hidden:
 * older rows and free-text values are still the owner's own words, and dropping
 * them would make a filled field look empty. Nothing stored → null.
 */
export function businessCategoryLabel(
  category: string | null | undefined,
  subCategory: string | null | undefined,
): string | null {
  const cat = clean(category);
  const sub = clean(subCategory);
  const option = findBusinessCategory(cat);

  // "אחר · כללי" is a real choice but says nothing about the business, so it is
  // not shown as if it were a category line.
  if (option?.value === OTHER_CATEGORY) return null;

  if (sub) {
    const subOption = option?.subCategories.find((s) => s.value === sub);
    if (subOption) return subOption.label;
  }
  if (option) return option.label;
  return sub || cat || null;
}
