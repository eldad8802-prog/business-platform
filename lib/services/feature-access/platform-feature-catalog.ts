/**
 * Platform feature catalog — source of truth for feature keys (Phase 0–1).
 * Adding a key requires updating this file and a DB seed/migration row.
 */

export const PLATFORM_FEATURE_KEYS = {
  DOCUMENTS: "documents",
  BILLING: "billing",
  INBOX: "inbox",
  INVENTORY: "inventory",
  CONTENT: "content",
  PRICING: "pricing",
  REVENUE: "revenue",
  GMAIL_IMPORT: "gmail_import",
  WHATSAPP: "whatsapp",
  STARTER_BOT: "starter_bot",
  REPORTS: "reports",
} as const;

export type PlatformFeatureKey =
  (typeof PLATFORM_FEATURE_KEYS)[keyof typeof PLATFORM_FEATURE_KEYS];

export type PlatformFeatureCategory =
  | "documents"
  | "billing"
  | "inbox"
  | "inventory"
  | "content"
  | "pricing"
  | "revenue"
  | "integrations"
  | "bot"
  | "reports";

export type PlatformFeatureCatalogEntry = {
  key: PlatformFeatureKey;
  displayName: string;
  category: PlatformFeatureCategory;
  description: string;
  defaultEnabled: boolean;
  mutable: boolean;
};

export const PLATFORM_FEATURE_CATALOG: readonly PlatformFeatureCatalogEntry[] =
  [
    {
      key: PLATFORM_FEATURE_KEYS.DOCUMENTS,
      displayName: "מסמכים",
      category: "documents",
      description: "העלאה, תיבה ובדיקת מסמכים",
      defaultEnabled: true,
      mutable: true,
    },
    {
      key: PLATFORM_FEATURE_KEYS.BILLING,
      displayName: "חשבוניות",
      category: "billing",
      description: "יצירה, הפקה וניהול מסמכי חיוב",
      defaultEnabled: true,
      mutable: true,
    },
    {
      key: PLATFORM_FEATURE_KEYS.INBOX,
      displayName: "שיחות / תיבה",
      category: "inbox",
      description: "ניהול שיחות עם לקוחות",
      defaultEnabled: true,
      mutable: true,
    },
    {
      key: PLATFORM_FEATURE_KEYS.INVENTORY,
      displayName: "מלאי",
      category: "inventory",
      description: "פריטים, תנועות והזמנות מספק",
      defaultEnabled: true,
      mutable: true,
    },
    {
      key: PLATFORM_FEATURE_KEYS.CONTENT,
      displayName: "תוכן",
      category: "content",
      description: "יצירת תוכן ו-AI",
      defaultEnabled: true,
      mutable: true,
    },
    {
      key: PLATFORM_FEATURE_KEYS.PRICING,
      displayName: "תמחור",
      category: "pricing",
      description: "מחשבון תמחור ופרופילי מחיר",
      defaultEnabled: true,
      mutable: true,
    },
    {
      key: PLATFORM_FEATURE_KEYS.REVENUE,
      displayName: "הכנסות / קופונים",
      category: "revenue",
      description: "קופונים, מימוש והכנסות",
      defaultEnabled: true,
      mutable: true,
    },
    {
      key: PLATFORM_FEATURE_KEYS.GMAIL_IMPORT,
      displayName: "ייבוא Gmail",
      category: "integrations",
      description: "חיבור וייבוא מצרופות מייל",
      defaultEnabled: true,
      mutable: true,
    },
    {
      key: PLATFORM_FEATURE_KEYS.WHATSAPP,
      displayName: "WhatsApp",
      category: "integrations",
      description: "ייבוא מצרופות WhatsApp",
      defaultEnabled: true,
      mutable: true,
    },
    {
      key: PLATFORM_FEATURE_KEYS.STARTER_BOT,
      displayName: "בוט פתיחה",
      category: "bot",
      description: "בוט שיחה אוטומטי לעסק",
      defaultEnabled: true,
      mutable: true,
    },
    {
      key: PLATFORM_FEATURE_KEYS.REPORTS,
      displayName: "דוחות",
      category: "reports",
      description: "ייצוא וסיכומי דוחות",
      defaultEnabled: true,
      mutable: true,
    },
  ];

const CATALOG_BY_KEY = new Map(
  PLATFORM_FEATURE_CATALOG.map((entry) => [entry.key, entry])
);

export function isPlatformFeatureKey(value: string): value is PlatformFeatureKey {
  return CATALOG_BY_KEY.has(value as PlatformFeatureKey);
}

export function getPlatformFeatureCatalogEntry(
  key: PlatformFeatureKey
): PlatformFeatureCatalogEntry {
  const entry = CATALOG_BY_KEY.get(key);
  if (!entry) {
    throw new Error(`Unknown platform feature key: ${key}`);
  }
  return entry;
}

export function listPlatformFeatureKeys(): PlatformFeatureKey[] {
  return PLATFORM_FEATURE_CATALOG.map((e) => e.key);
}
