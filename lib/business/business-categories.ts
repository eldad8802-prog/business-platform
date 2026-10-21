/**
 * The business categories an owner picks at onboarding, and their Hebrew labels.
 *
 * `BusinessProfile.category` / `subCategory` store the English `value`; every
 * screen that shows them to the owner reads the label from here. Onboarding
 * (which writes them) and Profile / Settings (which show them) used to keep
 * separate copies — this is the one copy.
 *
 * `label` is the Hebrew text (verbatim, from the dictionary — insights.categories.*); `labelKey` lets a
 * screen show it in the interface language: `t(option.labelKey)`.
 */
import { he } from "@/lib/i18n/messages/he";
import { createTranslator, type MessageKey, type Translator } from "@/lib/i18n/translate";

const HE_T: Translator = createTranslator(he);

export type BusinessSubCategoryOption = { value: string; label: string; labelKey: MessageKey };

export type BusinessCategoryOption = {
  value: string;
  label: string;
  labelKey: MessageKey;
  subCategories: BusinessSubCategoryOption[];
};

export const BUSINESS_CATEGORY_OPTIONS: BusinessCategoryOption[] = [
  {
    value: "Beauty",
    label: HE_T("insights.categories.beauty.label"),
    labelKey: "insights.categories.beauty.label",
    subCategories: [
      { value: "Nails", label: HE_T("insights.categories.beauty.nails"), labelKey: "insights.categories.beauty.nails" },
      { value: "Hair", label: HE_T("insights.categories.beauty.hair"), labelKey: "insights.categories.beauty.hair" },
      { value: "Skincare", label: HE_T("insights.categories.beauty.skincare"), labelKey: "insights.categories.beauty.skincare" },
      { value: "Cosmetics", label: HE_T("insights.categories.beauty.cosmetics"), labelKey: "insights.categories.beauty.cosmetics" },
      { value: "Lashes", label: HE_T("insights.categories.beauty.lashes"), labelKey: "insights.categories.beauty.lashes" },
      { value: "Makeup", label: HE_T("insights.categories.beauty.makeup"), labelKey: "insights.categories.beauty.makeup" },
    ],
  },
  {
    value: "Food",
    label: HE_T("insights.categories.food.label"),
    labelKey: "insights.categories.food.label",
    subCategories: [
      { value: "Restaurant", label: HE_T("insights.categories.food.restaurant"), labelKey: "insights.categories.food.restaurant" },
      { value: "Bakery", label: HE_T("insights.categories.food.bakery"), labelKey: "insights.categories.food.bakery" },
      { value: "Catering", label: HE_T("insights.categories.food.catering"), labelKey: "insights.categories.food.catering" },
      { value: "Street Food", label: HE_T("insights.categories.food.streetFood"), labelKey: "insights.categories.food.streetFood" },
      { value: "Desserts", label: HE_T("insights.categories.food.desserts"), labelKey: "insights.categories.food.desserts" },
      { value: "Cafe", label: HE_T("insights.categories.food.cafe"), labelKey: "insights.categories.food.cafe" },
    ],
  },
  {
    value: "Fitness",
    label: HE_T("insights.categories.fitness.label"),
    labelKey: "insights.categories.fitness.label",
    subCategories: [
      { value: "Personal Training", label: HE_T("insights.categories.fitness.personalTraining"), labelKey: "insights.categories.fitness.personalTraining" },
      { value: "Pilates", label: HE_T("insights.categories.fitness.pilates"), labelKey: "insights.categories.fitness.pilates" },
      { value: "Yoga", label: HE_T("insights.categories.fitness.yoga"), labelKey: "insights.categories.fitness.yoga" },
      { value: "Nutrition", label: HE_T("insights.categories.fitness.nutrition"), labelKey: "insights.categories.fitness.nutrition" },
      { value: "Studio", label: HE_T("insights.categories.fitness.studio"), labelKey: "insights.categories.fitness.studio" },
    ],
  },
  {
    value: "Home Services",
    label: HE_T("insights.categories.homeServices.label"),
    labelKey: "insights.categories.homeServices.label",
    subCategories: [
      { value: "Cleaning", label: HE_T("insights.categories.homeServices.cleaning"), labelKey: "insights.categories.homeServices.cleaning" },
      { value: "Moving", label: HE_T("insights.categories.homeServices.moving"), labelKey: "insights.categories.homeServices.moving" },
      { value: "Repairs", label: HE_T("insights.categories.homeServices.repairs"), labelKey: "insights.categories.homeServices.repairs" },
      { value: "Air Conditioning", label: HE_T("insights.categories.homeServices.airConditioning"), labelKey: "insights.categories.homeServices.airConditioning" },
      { value: "Plumbing", label: HE_T("insights.categories.homeServices.plumbing"), labelKey: "insights.categories.homeServices.plumbing" },
      { value: "Electrical", label: HE_T("insights.categories.homeServices.electrical"), labelKey: "insights.categories.homeServices.electrical" },
    ],
  },
  {
    value: "Events",
    label: HE_T("insights.categories.events.label"),
    labelKey: "insights.categories.events.label",
    subCategories: [
      { value: "Photography", label: HE_T("insights.categories.events.photography"), labelKey: "insights.categories.events.photography" },
      { value: "DJ", label: HE_T("insights.categories.events.dj"), labelKey: "insights.categories.events.dj" },
      { value: "Decor", label: HE_T("insights.categories.events.decor"), labelKey: "insights.categories.events.decor" },
      { value: "Production", label: HE_T("insights.categories.events.production"), labelKey: "insights.categories.events.production" },
      { value: "Bar", label: HE_T("insights.categories.events.bar"), labelKey: "insights.categories.events.bar" },
    ],
  },
  {
    value: "Retail",
    label: HE_T("insights.categories.retail.label"),
    labelKey: "insights.categories.retail.label",
    subCategories: [
      { value: "Fashion", label: HE_T("insights.categories.retail.fashion"), labelKey: "insights.categories.retail.fashion" },
      { value: "Gifts", label: HE_T("insights.categories.retail.gifts"), labelKey: "insights.categories.retail.gifts" },
      { value: "Accessories", label: HE_T("insights.categories.retail.accessories"), labelKey: "insights.categories.retail.accessories" },
      { value: "Home Design", label: HE_T("insights.categories.retail.homeDesign"), labelKey: "insights.categories.retail.homeDesign" },
      { value: "Online Store", label: HE_T("insights.categories.retail.onlineStore"), labelKey: "insights.categories.retail.onlineStore" },
    ],
  },
  {
    value: "Other",
    label: HE_T("insights.categories.other.label"),
    labelKey: "insights.categories.other.label",
    subCategories: [{ value: "General", label: HE_T("insights.categories.other.general"), labelKey: "insights.categories.other.general" }],
  },
];

export const BUSINESS_MODEL_OPTIONS = [
  { value: "service", label: HE_T("insights.categories.model.service"), labelKey: "insights.categories.model.service" },
  { value: "product", label: HE_T("insights.categories.model.product"), labelKey: "insights.categories.model.product" },
  { value: "hybrid", label: HE_T("insights.categories.model.hybrid"), labelKey: "insights.categories.model.hybrid" },
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
  t?: Translator,
): string | null {
  const cat = clean(category);
  const sub = clean(subCategory);
  const option = findBusinessCategory(cat);

  // "אחר · כללי" is a real choice but says nothing about the business, so it is
  // not shown as if it were a category line.
  if (option?.value === OTHER_CATEGORY) return null;

  if (sub) {
    const subOption = option?.subCategories.find((s) => s.value === sub);
    if (subOption) return t ? t(subOption.labelKey) : subOption.label;
  }
  if (option) return t ? t(option.labelKey) : option.label;
  return sub || cat || null;
}
