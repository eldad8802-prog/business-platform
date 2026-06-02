import type { FeatureAccessReasonCode } from "./feature-access.types";

const REASON_LABELS: Record<FeatureAccessReasonCode, string> = {
  EMERGENCY_DISABLED: "כבוי זמנית לכל העסקים",
  BUSINESS_DISABLED: "נסגר במיוחד לעסק הזה",
  BUSINESS_ENABLED: "נפתח במיוחד לעסק הזה",
  GLOBAL_DEFAULT: "לפי הגדרת המערכת",
  CATALOG_DEFAULT: "לפי ברירת המחדל",
};

export function featureAccessReasonLabel(code: FeatureAccessReasonCode): string {
  return REASON_LABELS[code];
}
