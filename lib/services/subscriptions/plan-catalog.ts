/**
 * Subscription plan catalog — Dubiz subscriptions stage A (stage 3 of the plan document). PURE, no database.
 *
 * Source: the owner-approved plan document "Dubiz — תכנון סופי של מסלולי המנויים", section 1 (the 36-capability
 * matrix), approved 2026-11-20 (section 9, decision 1: three tiers per the matrix; online booking only in Advanced and
 * Premium). This file TRANSLATES that matrix onto the 33 platform feature keys that exist in code. It invents no tier,
 * no price and no limit. A change here is a commercial change: it needs the owner's approval, a code review and the
 * tests in plan-catalog.test.ts.
 *
 * What a row says, per feature key:
 *   minPlan      — the lowest plan in which the module is available at all ("כל מסלול כולל את כל מה שבמסלול שמתחתיו").
 *                  Deeper actions inside a module that the matrix places in a higher plan (for example a recurring
 *                  invoice in Advanced) are action-level and belong to stage C; they are listed in `deeper` for the
 *                  record and are not evaluated yet.
 *   freeLimited  — what the module allows while the business is FREE_LIMITED (matrix "מה מותר ב-FREE_LIMITED"):
 *                  full     — the whole module stays open (pricing calculator, activity packs);
 *                  limited  — only the allowed actions (view, export, legal corrections, basic writes) — stage C
 *                             classifies them per route;
 *                  none     — nothing (AI, content studio, online booking, push engine).
 *   matrixRow    — the matrix row(s) the key was mapped from, so a reviewer can check the translation.
 *   confirm      — set when the translation from matrix row to feature key needed a judgement; listed in the
 *                  approval package for the owner to confirm before any enforcement. Shadow only until then.
 *
 * Not here on purpose: prices, the payment provider, the grace period, the trial length — none is decided for code.
 */
import { PLATFORM_FEATURE_KEYS as K, type PlatformFeatureKey } from "@/lib/services/feature-access/platform-feature-catalog";

/** The approved matrix version this file encodes. A business keeps the version it was assigned until moved on purpose. */
export const PLAN_CATALOG_VERSION = "2026-11-20" as const;

export const SUBSCRIPTION_PLANS = ["BASIC", "ADVANCED", "PREMIUM"] as const;
export type SubscriptionPlan = (typeof SUBSCRIPTION_PLANS)[number];

const PLAN_RANK: Record<SubscriptionPlan, number> = { BASIC: 1, ADVANCED: 2, PREMIUM: 3 };

export function isSubscriptionPlan(value: unknown): value is SubscriptionPlan {
  return typeof value === "string" && (SUBSCRIPTION_PLANS as readonly string[]).includes(value);
}

/** True when `plan` includes everything `required` includes (each plan includes all plans below it). */
export function planIncludes(plan: SubscriptionPlan, required: SubscriptionPlan): boolean {
  return PLAN_RANK[plan] >= PLAN_RANK[required];
}

/**
 * Premium opens commercially only once two or three of its AI capabilities are live and tested (decision 4,
 * 2026-11-20). Until then no CUSTOMER may be assigned PREMIUM — the admin plan change refuses it. A trial and a tester
 * still resolve at Premium depth, because the feature flags already keep every unreleased capability closed.
 */
export const PREMIUM_COMMERCIALLY_OPEN = false as const;

export type FreeLimitedAccess = "full" | "limited" | "none";

export type PlanCatalogRow = {
  minPlan: SubscriptionPlan;
  freeLimited: FreeLimitedAccess;
  matrixRow: string;
  deeper?: Partial<Record<SubscriptionPlan, string>>;
  confirm?: string;
};

export const PLAN_CATALOG: Readonly<Record<PlatformFeatureKey, PlanCatalogRow>> = {
  // ── כסף ומסים ─────────────────────────────────────────────────────────────────────────────────────────────
  [K.BILLING]: {
    minPlan: "BASIC",
    freeLimited: "limited",
    matrixRow: "חשבוניות וקבלות; מספרי הקצאה; גבייה וקישורי תשלום; תשלומים לספקים",
    deeper: { ADVANCED: "חשבונית חוזרת, שליחה ב-WhatsApp, תזכורות גבייה", PREMIUM: "זיהוי חריגות בחיוב" },
  },
  [K.BANK_FILE_IMPORT]: { minPlan: "ADVANCED", freeLimited: "limited", matrixRow: "ייבוא קובץ בנק", deeper: { PREMIUM: "התאמה חכמה" } },
  [K.POS_RIVHIT]: { minPlan: "ADVANCED", freeLimited: "limited", matrixRow: "קופה (Rivhit)" },
  [K.ACCOUNTANT_MONTH_CLOSE]: {
    minPlan: "BASIC",
    freeLimited: "limited",
    matrixRow: "חבילה לרואה חשבון — בסיסי: הפקה והורדה ידנית",
  },
  [K.ACCOUNTANT_DELIVERY]: {
    minPlan: "ADVANCED",
    freeLimited: "none",
    matrixRow: "חבילה לרואה חשבון — מתקדם: שליחה חודשית אוטומטית",
    confirm:
      "accountant_delivery שולח את החבילה מתוך Dubiz, כל משלוח באישור בעל העסק. המטריצה שמה בבסיסי 'הפקה והורדה ידנית' ובמתקדם 'שליחה חודשית אוטומטית'. מיפיתי למתקדם; אם שליחה ידנית מתוך Dubiz שייכת לבסיסי — לשנות ל-BASIC.",
  },

  // ── מסמכים ודוחות ─────────────────────────────────────────────────────────────────────────────────────────
  [K.DOCUMENTS]: {
    minPlan: "BASIC",
    freeLimited: "limited",
    matrixRow: "תיבת מסמכים וסריקה",
    deeper: { ADVANCED: "קליטה אוטומטית ממקורות", PREMIUM: "סיווג חכם, זיהוי כפילויות וחריגות" },
  },
  [K.DOCUMENT_SUPPLIER_LINKING]: {
    minPlan: "BASIC",
    freeLimited: "limited",
    matrixRow: "תיבת מסמכים וסריקה (שיוך מסמך לספק הוא חלק מהאישור הידני)",
    confirm: "document_supplier_linking אינו שורה נפרדת במטריצה; שויך לתיבת המסמכים בבסיסי.",
  },
  [K.GMAIL_IMPORT]: { minPlan: "ADVANCED", freeLimited: "limited", matrixRow: "ייבוא מ-Gmail" },
  [K.WHATSAPP]: { minPlan: "ADVANCED", freeLimited: "limited", matrixRow: "מסמכים מ-WhatsApp" },
  [K.BUSINESS_DOCUMENTS]: {
    minPlan: "BASIC",
    freeLimited: "limited",
    matrixRow: "הצעות מחיר ומסמכים עסקיים",
    deeper: { ADVANCED: "אישור לקוח מקוון, המרה לחשבונית, תזכורת מעקב" },
  },
  [K.REPORTS]: {
    minPlan: "BASIC",
    freeLimited: "limited",
    matrixRow: "דוחות וייצוא; ייצוא כל הנתונים (רצפת זכויות)",
    deeper: { ADVANCED: "דוח מתוזמן במייל", PREMIUM: "ניתוחים והשוואות" },
  },

  // ── לקוחות, מכירות ושיווק ─────────────────────────────────────────────────────────────────────────────────
  [K.INBOX]: { minPlan: "ADVANCED", freeLimited: "limited", matrixRow: "שיחות WhatsApp ותיבה מאוחדת" },
  [K.STARTER_BOT]: { minPlan: "ADVANCED", freeLimited: "limited", matrixRow: "בוט פתיחה" },
  [K.ACQUISITION_META_LEAD_ADS]: { minPlan: "ADVANCED", freeLimited: "limited", matrixRow: "מקורות לידים אוטומטיים (Meta)" },
  [K.ACQUISITION_GOOGLE_LEAD_FORMS]: { minPlan: "ADVANCED", freeLimited: "limited", matrixRow: "מקורות לידים אוטומטיים (Google)" },
  [K.ACQUISITION_WEB_FORMS]: { minPlan: "ADVANCED", freeLimited: "limited", matrixRow: "מקורות לידים אוטומטיים (טפסים)" },
  [K.COMMERCE_WOOCOMMERCE]: { minPlan: "ADVANCED", freeLimited: "limited", matrixRow: "מקורות לידים אוטומטיים (חנויות); מלאי — חיבור לחנות אונליין" },
  [K.COMMERCE_WIX]: { minPlan: "ADVANCED", freeLimited: "limited", matrixRow: "מקורות לידים אוטומטיים (חנויות); מלאי — חיבור לחנות אונליין" },
  [K.TELEPHONY_CLOUDTALK]: { minPlan: "ADVANCED", freeLimited: "limited", matrixRow: "מקורות לידים אוטומטיים (טלפוניה)" },
  [K.TELEPHONY_VOICENTER]: { minPlan: "ADVANCED", freeLimited: "limited", matrixRow: "מקורות לידים אוטומטיים (טלפוניה)" },
  [K.INTAKE_STATUS_VISIBILITY]: {
    minPlan: "ADVANCED",
    freeLimited: "limited",
    matrixRow: "מקורות לידים אוטומטיים (מצב הקליטה שלהם)",
    confirm: "intake_status_visibility מציג את מצב הקליטה ממקורות הלידים האוטומטיים, ולכן שויך איתם למתקדם.",
  },
  [K.REVENUE]: { minPlan: "BASIC", freeLimited: "limited", matrixRow: "קופונים ומבצעים", deeper: { ADVANCED: "הפצה אוטומטית" } },
  [K.CONTENT]: { minPlan: "PREMIUM", freeLimited: "none", matrixRow: "סטודיו תוכן ווידאו" },
  [K.PRICING]: { minPlan: "BASIC", freeLimited: "full", matrixRow: "מחשבון תמחור", deeper: { PREMIUM: "המלצת מחיר" } },

  // ── תפעול ─────────────────────────────────────────────────────────────────────────────────────────────────
  [K.APPOINTMENTS]: {
    minPlan: "BASIC",
    freeLimited: "limited",
    matrixRow: "יומן תורים",
    deeper: { ADVANCED: "תזכורת תור ללקוח", PREMIUM: "זיהוי חורים ולקוחות שלא חזרו" },
  },
  [K.PUBLIC_BOOKING]: { minPlan: "ADVANCED", freeLimited: "none", matrixRow: "הזמנת תור אונליין (החלטה 1: רק במתקדם ובפרימיום)" },
  [K.DAILY_TASKS]: { minPlan: "BASIC", freeLimited: "limited", matrixRow: "משימות ותזכורות", deeper: { PREMIUM: "הצעת משימות מהפעילות" } },
  [K.SERVICE_DESK]: {
    minPlan: "BASIC",
    freeLimited: "limited",
    matrixRow: "תיקונים ושירות",
    deeper: { ADVANCED: "עדכון סטטוס אוטומטי ללקוח", PREMIUM: "תקלות חוזרות, זמני טיפול" },
  },
  [K.INVENTORY]: {
    minPlan: "BASIC",
    freeLimited: "limited",
    matrixRow: "מלאי, ספקים והזמנות רכש",
    deeper: { ADVANCED: "חיבור לקופה ולחנות אונליין", PREMIUM: "חיזוי הזמנות" },
  },
  [K.NOTIFICATIONS_ENGINE]: {
    minPlan: "ADVANCED",
    freeLimited: "none",
    matrixRow: "התראות — בסיסי: פיד באפליקציה; מתקדם: מנוע פוש ותקציר יומי",
    confirm:
      "notifications_engine הוא מנוע הפוש. לפי שורת 'התראות' הוא במתקדם, אבל שורת 'משימות ותזכורות' בבסיסי כוללת 'תזכורת פוש לבעל העסק'. כשתגיע האכיפה (שלב ג) תזכורת משימה אישית צריכה חריגה ברמת הפעולה — או להעביר את המפתח לבסיסי.",
  },
  [K.KNOWLEDGE_DERIVATION]: {
    minPlan: "PREMIUM",
    freeLimited: "none",
    matrixRow: "תובנות והמלצות Dubiz — פרימיום: רכיבי AI",
    confirm: "knowledge_derivation (גזירת ידע/למידה) שויך לרכיבי ה-AI של פרימיום.",
  },
  [K.OWNER_RECOMMENDATIONS]: { minPlan: "PREMIUM", freeLimited: "none", matrixRow: "תובנות והמלצות Dubiz — המלצות וזיהוי בעיות ב-AI" },
  [K.ACTIVITY_PACKS]: { minPlan: "BASIC", freeLimited: "full", matrixRow: "חבילות פעילות (החלטה 2: תצוגה בלבד, חינם, ללא מגבלה)" },
};

export function planCatalogRow(key: PlatformFeatureKey): PlanCatalogRow {
  return PLAN_CATALOG[key];
}
