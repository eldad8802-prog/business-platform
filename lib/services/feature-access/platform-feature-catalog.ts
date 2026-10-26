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
  KNOWLEDGE_DERIVATION: "knowledge_derivation",
  ACQUISITION_META_LEAD_ADS: "acquisition_meta_lead_ads",
  ACQUISITION_GOOGLE_LEAD_FORMS: "acquisition_google_lead_forms",
  ACQUISITION_WEB_FORMS: "acquisition_web_forms",
  OWNER_RECOMMENDATIONS: "owner_recommendations",
  COMMERCE_WOOCOMMERCE: "commerce_woocommerce",
  COMMERCE_WIX: "commerce_wix",
  TELEPHONY_CLOUDTALK: "telephony_cloudtalk",
  TELEPHONY_VOICENTER: "telephony_voicenter",
  DAILY_TASKS: "daily_tasks",
  ACCOUNTANT_MONTH_CLOSE: "accountant_month_close",
  BANK_FILE_IMPORT: "bank_file_import",
  POS_RIVHIT: "pos_rivhit",
  APPOINTMENTS: "appointments",
  PUBLIC_BOOKING: "public_booking",
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
  | "reports"
  | "intelligence"
  | "tasks"
  | "scheduling";

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
    {
      // Authority for /api/knowledge/derive. OFF by default: a business is derivable only after a
      // platform admin enables it for that business. Not a product surface.
      key: PLATFORM_FEATURE_KEYS.KNOWLEDGE_DERIVATION,
      displayName: "גזירת ידע עסקי",
      category: "intelligence",
      description: "הרשאת הפעלת גזירת ידע (למידה) עבור העסק — כבויה כברירת מחדל",
      defaultEnabled: false,
      mutable: true,
    },
    // M6 — first-wave acquisition sources. OFF by default (migration 20261009090000): no inbound lead
    // is accepted for a business until that source is enabled for it.
    {
      key: PLATFORM_FEATURE_KEYS.ACQUISITION_META_LEAD_ADS,
      displayName: "לידים מ־Meta (פייסבוק ואינסטגרם)",
      category: "integrations",
      description: "קבלת לידים מטופסי Lead Ads של עמוד פייסבוק — כבוי כברירת מחדל",
      defaultEnabled: false,
      mutable: true,
    },
    {
      key: PLATFORM_FEATURE_KEYS.ACQUISITION_GOOGLE_LEAD_FORMS,
      displayName: "לידים מטופסי Google Ads",
      category: "integrations",
      description: "קבלת לידים מטופסי לידים של Google Ads (webhook) — כבוי כברירת מחדל",
      defaultEnabled: false,
      mutable: true,
    },
    {
      key: PLATFORM_FEATURE_KEYS.ACQUISITION_WEB_FORMS,
      displayName: "לידים מטופס באתר",
      category: "integrations",
      description: "קבלת לידים מטופס יצירת קשר באתר העסק — כבוי כברירת מחדל",
      defaultEnabled: false,
      mutable: true,
    },
    // M7-A — commerce + telephony sources (D4, D5). OFF by default (migration 20261013090000): no
    // order or call is accepted for a business until that source is enabled for it.
    {
      key: PLATFORM_FEATURE_KEYS.COMMERCE_WOOCOMMERCE,
      displayName: "הזמנות מחנות WooCommerce",
      category: "integrations",
      description: "קליטת הזמנות מחנות WooCommerce של העסק — כבוי כברירת מחדל",
      defaultEnabled: false,
      mutable: true,
    },
    {
      key: PLATFORM_FEATURE_KEYS.COMMERCE_WIX,
      displayName: "הזמנות מחנות Wix",
      category: "integrations",
      description: "קליטת הזמנות מחנות Wix של העסק — כבוי כברירת מחדל",
      defaultEnabled: false,
      mutable: true,
    },
    {
      key: PLATFORM_FEATURE_KEYS.TELEPHONY_CLOUDTALK,
      displayName: "שיחות מ־CloudTalk",
      category: "integrations",
      description: "קליטת שיחות טלפון (נכנסות, יוצאות, שלא נענו) מ־CloudTalk — כבוי כברירת מחדל",
      defaultEnabled: false,
      mutable: true,
    },
    {
      key: PLATFORM_FEATURE_KEYS.TELEPHONY_VOICENTER,
      displayName: "שיחות מ־Voicenter",
      category: "integrations",
      description: "קליטת שיחות טלפון (נכנסות, יוצאות, שלא נענו) מ־Voicenter — כבוי כברירת מחדל",
      defaultEnabled: false,
      mutable: true,
    },
    // Closed Loop — Dubiz recommendations shown to the owner, and the owner's decision on them. OFF by
    // default (migration 20261012090000): a business sees them only after a platform admin enables it.
    {
      key: PLATFORM_FEATURE_KEYS.OWNER_RECOMMENDATIONS,
      displayName: "המלצות Dubiz",
      category: "intelligence",
      description: "הצגת המלצות Dubiz לבעל העסק וקבלת החלטתו — כבויה כברירת מחדל",
      defaultEnabled: false,
      mutable: true,
    },
    // Daily Tasks — personal tasks with time, reminder and Web Push. ON for every business, existing and new (owner
    // decision 2026-10-24); the global policy row is switched on by its own release migration. Every route still
    // checks this flag first (404 when off), so a business override or the emergency switch can close it.
    {
      key: PLATFORM_FEATURE_KEYS.DAILY_TASKS,
      displayName: "היום שלי — משימות",
      category: "tasks",
      description: "משימות אישיות עם מועד, תזכורת והתראה לטלפון — פתוח לכל העסקים",
      defaultEnabled: true,
      mutable: true,
    },
    // Monthly accountant workflow (migration 20261027090000). OFF by default, like every new feature: with no
    // policy row the resolver falls back to this default, so a deploy that reaches Production before the
    // migration cannot switch the workflow on. Controlled verification = a business override; the general
    // rollout (owner gate G5) flips this default together with the policy row. Sending to the accountant is a
    // second, separate switch (ACCOUNTANT_DELIVERY_ENABLED).
    {
      key: PLATFORM_FEATURE_KEYS.ACCOUNTANT_MONTH_CLOSE,
      displayName: "חבילה חודשית לרואה החשבון",
      category: "documents",
      description: "הכנה חודשית אוטומטית של חבילת רואה החשבון, התראה, ושליחה לרואה החשבון באישור בעל העסק",
      defaultEnabled: false,
      mutable: true,
    },
    // Bank file import (revenue truth milestone B1). OFF by default: with no policy row the resolver falls back to
    // this default, so a deploy that reaches Production before its data migration cannot switch it on. It adds
    // a second way to upload a bank statement (CSV / XLSX, preview first) into the same ExternalTransaction rows
    // the payables upload writes; that upload is unchanged.
    {
      key: PLATFORM_FEATURE_KEYS.BANK_FILE_IMPORT,
      displayName: "קליטת קובצי בנק",
      category: "integrations",
      description: "העלאת קובץ תנועות בנק (CSV או Excel) עם תצוגה מקדימה לפני קליטה",
      defaultEnabled: false,
      mutable: true,
    },
    // Rivhit sales documents → revenue truth (S1-A, migration 20261104090000). OFF by default: with no policy row the
    // resolver falls back to this default, so a deploy that reaches Production before the migration cannot switch it
    // on. Read-only: Dubiz never writes to Rivhit.
    {
      key: PLATFORM_FEATURE_KEYS.POS_RIVHIT,
      displayName: "מכירות מריווחית",
      category: "integrations",
      description: "קריאת מסמכי מכירה וקבלות מריווחית Online לשכבת אמת ההכנסות (קריאה בלבד) — כבוי כברירת מחדל",
      defaultEnabled: false,
      mutable: true,
    },
    // Appointments, milestone A (migration 20261029090000). OFF by default, like every new feature: with no policy row
    // the resolver falls back to this default, so a deploy that reaches Production before the migration cannot switch
    // the calendar on. It gates the new owner routes only; the appointment paths that predate it are not gated.
    {
      key: PLATFORM_FEATURE_KEYS.APPOINTMENTS,
      displayName: "יומן ותורים",
      category: "scheduling",
      description: "יומן, תורים, עובדים וזמינות לבעל העסק — כבוי כברירת מחדל",
      defaultEnabled: false,
      mutable: true,
    },
    // External booking (milestone D). Seeded OFF with the foundation; nothing reads it until milestone D ships.
    {
      key: PLATFORM_FEATURE_KEYS.PUBLIC_BOOKING,
      displayName: "הזמנת תורים חיצונית",
      category: "scheduling",
      description: "קישור הזמנות ציבורי ללקוחות — כבוי כברירת מחדל",
      defaultEnabled: false,
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
