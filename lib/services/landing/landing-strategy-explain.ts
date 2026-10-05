import type { LandingBusinessContext } from "./landing-business-context";
import type { LandingStrategy } from "./landing-strategy-engine";
import type { StrategyType } from "./landing-strategy-vocabulary";

/**
 * P3-B · Owner-facing explanation of WHY a direction was proposed. Fixed templates keyed by reason
 * codes — never marketing copy, never a public claim. Internal evidence may be described to the owner
 * (it is the owner's own data), but in neutral terms: no "most popular", no counts presented as proof.
 */

export const STRATEGY_TITLES: Record<StrategyType, string> = {
  REQUEST_QUOTE_FIRST: "בקשת הצעת מחיר",
  BOOKING_FIRST: "קביעת תור",
  CALL_FIRST: "שיחת טלפון ישירה",
  WHATSAPP_FIRST: "פנייה בוואטסאפ",
  LEAD_CAPTURE_FIRST: "השארת פרטים",
  LOCAL_VISIT_FIRST: "הגעה לעסק",
  TRUST_AUTHORITY_FIRST: "אמון ומקצועיות",
  SERVICE_DISCOVERY_FIRST: "היכרות עם השירותים",
  PRODUCT_DISCOVERY_FIRST: "היכרות עם המוצרים",
};

const CHANNEL_HE: Record<string, string> = {
  PHONE: "שיחת טלפון",
  EMAIL: "אימייל",
  WHATSAPP_LINK: "וואטסאפ במספר העסק",
  WHATSAPP_CLOUD: "WhatsApp העסקי (מחובר ל-Dubiz)",
  IN_PERSON: "הגעה לעסק",
  DUBIZ_FORM: "טופס הפנייה באתר",
};

const REASON_HE: Record<string, (p: Record<string, string | number>) => string> = {
  OWNER_PRIMARY_OBJECTIVE: () => "זו המטרה העיקרית שבחרת לעסק",
  OWNER_SECONDARY_OBJECTIVE: () => "זו אחת המטרות המשניות שבחרת",
  QUOTE_PRICING_SUPPORTED: () => "רוב השירותים שלך מתומחרים לפי הצעה",
  DECLARED_QUOTES_ON_REQUEST: () => "סימנת שהעסק נותן הצעות מחיר לפי בקשה",
  SERVICES_AT_CUSTOMER: () => "חלק מהשירותים ניתנים אצל הלקוח",
  COMPLETED_BOOKINGS_SUPPORTED: () => "יש לעסק תורים שהושלמו בחודשים האחרונים",
  AUDIENCE_APPOINTMENT_CUSTOMERS: () => "ציינת שהלקוחות שלך מגיעים בתיאום מראש",
  DECLARED_BOOKING_BY_MESSAGE: () => "סימנת שאפשר לקבוע תור בפנייה",
  RESOLVER_SUGGESTS_CALL: () => "יש לעסק מספר טלפון מאושר לפרסום",
  DECLARED_WHATSAPP_ON_PUBLIC_PHONE: () => "סימנת שיש WhatsApp במספר העסק",
  RESOLVER_SUGGESTS_WHATSAPP: () => "יש דרך מאושרת לפנות לעסק בוואטסאפ",
  WEBSITE_FORM_LIVE: () => "טופס הפנייה באתר פעיל",
  AUDIENCE_BUSINESSES: () => "ציינת שאתה עובד גם עם עסקים",
  DECLARED_ACCEPTS_VISITS: () => "סימנת שלקוחות יכולים להגיע לעסק",
  SERVICES_AT_BUSINESS: () => "השירותים ניתנים במקום העסק",
  AUDIENCE_LOCAL_OR_WALK_IN: () => "ציינת שהלקוחות שלך מהאזור",
  PUBLIC_TRUST_CLAIMS: (p) => (Number(p.count) > 1 ? `יש לעסק ${p.count} טענות אמון מאושרות לפרסום` : "יש לעסק טענת אמון מאושרת לפרסום"),
  TRUST_POSITIONING: () => "המיצוב שבחרת מדגיש מקצועיות ואמון",
  PUBLIC_ADDRESS_APPROVED: () => "כתובת העסק מאושרת לפרסום",
  ACTIVE_SERVICES: (p) => `יש לעסק ${p.activeServices} שירותים פעילים`,
  BROAD_CATEGORIES: () => "השירותים מגוונים",
  SERVICE_LED_MIX: () => "העסק מבוסס בעיקר על שירותים",
  OWNER_FEATURED_SERVICES: () => "סימנת שירותים להבליט",
  ACTIVE_PRODUCTS: (p) => `יש לעסק ${p.activeProducts} מוצרים פעילים`,
  PRODUCT_LED_MIX: () => "העסק מבוסס בעיקר על מוצרים",
  OWNER_FEATURED_PRODUCTS: () => "סימנת מוצרים להבליט",
  OWNER_SELECTED_PLATFORM_UNPROVEN_CHANNEL: () => "בחרת בערוץ WhatsApp העסקי — הוא עדיין לא הוכח במלואו ב-Dubiz",
};

function conversionHe(s: LandingStrategy): string {
  const c = s.primaryConversion;
  if (c.kind === "SURFACE_ONLY") return "כרגע אין לעסק דרך פנייה מאושרת, ולכן הכיוון הזה מציג את העסק בלי כפתור פעולה";
  return `הפנייה תהיה דרך ${CHANNEL_HE[c.channel] ?? c.channel}`;
}

export function explainStrategy(s: LandingStrategy, _ctx: LandingBusinessContext): string {
  void _ctx;
  const reasons = s.evidence
    .filter((e) => e.weight > 0 || e.code === "OWNER_SELECTED_PLATFORM_UNPROVEN_CHANNEL")
    .map((e) => REASON_HE[e.code]?.(e.params))
    .filter((x): x is string => !!x);
  const because = reasons.length ? `, כי ${reasons.join(", ")}` : "";
  return `דוביז מציעה כיוון שמתמקד ב${STRATEGY_TITLES[s.strategyType]}${because}. ${conversionHe(s)}.`;
}
