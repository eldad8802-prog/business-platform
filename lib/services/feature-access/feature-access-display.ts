import type { FeatureAccessReasonCode, FeatureAccessSource } from "./feature-access.types";

export type FeatureAccessDisplayState =
  | "enabled"
  | "inherited"
  | "disabled"
  | "emergency"
  | "immutable";

export function featureAccessSourceLabel(source: FeatureAccessSource): string {
  switch (source) {
    case "emergency":
      return "כבוי זמנית לכל העסקים";
    case "business":
      return "נקבע במיוחד לעסק הזה";
    case "global":
    case "catalog":
      return "לפי הגדרת המערכת";
  }
}

export function computeFeatureAccessDisplayState(input: {
  allowed: boolean;
  emergencyDisabled: boolean;
  businessOverride: "ENABLED" | "DISABLED" | null;
  mutable: boolean;
}): FeatureAccessDisplayState {
  if (!input.mutable) {
    return "immutable";
  }
  if (input.emergencyDisabled) {
    return "emergency";
  }
  if (input.businessOverride === "DISABLED") {
    return "disabled";
  }
  if (input.businessOverride === "ENABLED") {
    return "enabled";
  }
  if (!input.allowed) {
    return "disabled";
  }
  return "inherited";
}

export function featureAccessDisplayStateLabel(
  state: FeatureAccessDisplayState
): string {
  switch (state) {
    case "enabled":
      return "פתוח לעסק הזה";
    case "inherited":
      return "לפי ברירת המחדל";
    case "disabled":
      return "סגור לעסק הזה";
    case "emergency":
      return "כבוי זמנית לכל העסקים";
    case "immutable":
      return "פיצ׳ר בסיסי שלא ניתן לשינוי";
  }
}

export function featureAccessOverrideLabel(
  override: "ENABLED" | "DISABLED" | null
): string {
  if (override === "ENABLED") return "פתוח לעסק הזה";
  if (override === "DISABLED") return "סגור לעסק הזה";
  return "לפי ברירת המחדל";
}

export type FeatureAccessCategoryGroup =
  | "operations"
  | "communication"
  | "finance"
  | "growth"
  | "integrations";

export const FEATURE_CATEGORY_GROUP_ORDER: readonly FeatureAccessCategoryGroup[] =
  [
    "operations",
    "communication",
    "finance",
    "growth",
    "integrations",
  ];

export function featureCategoryGroupLabel(
  group: FeatureAccessCategoryGroup
): string {
  switch (group) {
    case "operations":
      return "תפעול";
    case "communication":
      return "תקשורת";
    case "finance":
      return "כספים";
    case "growth":
      return "צמיחה";
    case "integrations":
      return "אינטגרציות";
  }
}

export function categoryToGroup(
  category: string
): FeatureAccessCategoryGroup {
  switch (category) {
    case "documents":
    case "inventory":
      return "operations";
    case "inbox":
    case "bot":
      return "communication";
    case "billing":
    case "pricing":
    case "revenue":
      return "finance";
    case "content":
    case "reports":
      return "growth";
    case "integrations":
      return "integrations";
    default:
      return "operations";
  }
}

export function categoryLabelHe(category: string): string {
  switch (category) {
    case "documents":
      return "מסמכים";
    case "billing":
      return "חשבוניות";
    case "inbox":
      return "שיחות";
    case "inventory":
      return "מלאי";
    case "content":
      return "תוכן";
    case "pricing":
      return "תמחור";
    case "revenue":
      return "הכנסות";
    case "integrations":
      return "אינטגרציות";
    case "bot":
      return "בוט";
    case "reports":
      return "דוחות";
    default:
      return category;
  }
}
