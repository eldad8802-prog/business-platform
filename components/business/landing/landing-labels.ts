/** P3-B — owner-language labels for the strategy preview. */

export const SECTION_LABELS: Record<string, string> = {
  HERO: "פתיחה",
  PRIMARY_ACTION: "פעולה",
  QUOTE_PROCESS: "איך מקבלים הצעה",
  BOOKING_INFO: "איך קובעים תור",
  CONTACT_PANEL: "יצירת קשר",
  LOCATION_AND_HOURS: "כתובת ושעות",
  SERVICES_OVERVIEW: "השירותים",
  PRODUCTS_SHOWCASE: "המוצרים",
  FEATURED_OFFERINGS: "מה שבחרת להבליט",
  TRUST_PROOF: "אמון",
  ABOUT: "על העסק",
  SERVICE_AREA: "אזור שירות",
};

export const MISSING_LABELS: Record<string, string> = {
  PUBLIC_BUSINESS_NAME: "שם העסק מאושר לפרסום",
  PUBLIC_DESCRIPTION: "תיאור העסק מאושר לפרסום",
  USABLE_CONVERSION_PATH: "דרך פנייה מאושרת (טלפון, וואטסאפ, טופס או הגעה)",
  PUBLIC_ADDRESS: "כתובת מאושרת לפרסום",
  PUBLIC_OPENING_HOURS: "שעות פעילות מאושרות לפרסום",
  ACTIVE_SERVICES: "שירותים פעילים",
  ACTIVE_PRODUCTS: "מוצרים פעילים",
  OWNER_FEATURED_OFFERINGS: "שירותים או מוצרים שסימנת להבליט",
  PUBLIC_TRUST_CLAIM: "טענת אמון מאושרת לפרסום",
  PUBLIC_SERVICE_AREA: "אזור שירות מאושר לפרסום",
  RESOLVE_BLOCKING_CONFLICTS: "טיפול בנושאים שמחכים לבדיקה שלך",
  OFFERING_IMAGE: "תמונה מאושרת של שירות או מוצר",
  HERO_IMAGE: "תמונה ראשית מאושרת",
  LOCATION_IMAGE: "תמונה של המקום",
  OWNER_OR_TEAM_IMAGE: "תמונה שלך או של הצוות",
  SERVICE_RESULT_IMAGE: "תמונה של עבודה שעשית",
  NO_VIABLE_STRATEGY: "אין עדיין כיוון שאפשר להציע",
  NO_ACTIVE_OFFERINGS: "אין שירותים או מוצרים פעילים",
  NO_USABLE_CONVERSION_PATH: "אין דרך פנייה מאושרת",
};

export const SET_CONFLICT_LABELS: Record<string, string> = {
  OWNER_EVIDENCE_DIVERGENCE: "הכיוון המומלץ שומר על המטרה שבחרת. לפי מה שקורה בעסק בפועל, הוספנו גם חלופה שכדאי לשקול.",
  OWNER_OBJECTIVE_NOT_FULFILLABLE: "את המטרה העיקרית שבחרת עדיין אי אפשר להפעיל — חסרה דרך פנייה מאושרת עבורה. ההצעות למטה הן חלופות בינתיים.",
  OWNER_OBJECTIVE_NO_STRATEGY_IN_V1: "מכירה אונליין עדיין לא נתמכת ב-Dubiz, לכן אין כיוון שמבוסס על רכישה באתר.",
  OWNER_SELECTED_PLATFORM_UNPROVEN: "בחרת ב-WhatsApp העסקי. הוא נשאר בכיוון המומלץ, אבל עדיין לא הוכח במלואו ב-Dubiz.",
  CLAIM_LIKE_TEXT_NEEDS_REVIEW: "יש טקסט שנשמע כמו טענת אמון — הוא לא ייכנס לדף עד שתבדוק אותו במסך \"איך העסק מוצג\".",
};

export const COMPOSITION_STATUS_LABELS: Record<string, string> = {
  COMPOSED: "הטיוטה מוכנה",
  REJECTED: "הטיוטה שנוצרה לא עברה את בדיקות הבטיחות של דוביז, ולכן לא תוצג. אפשר לנסות שוב.",
  UNAVAILABLE: "יצירת טיוטות דף עדיין לא הופעלה בחשבון הזה.",
  FAILED: "לא הצלחנו ליצור טיוטה כרגע. אפשר לנסות שוב בעוד רגע.",
};

export const BLUEPRINT_MISSING_LABELS: Record<string, string> = {
  ...MISSING_LABELS,
  PUBLIC_APPROVED_ASSET: "לפחות תמונה אחת מאושרת לפרסום",
};

/* ───────────── P3-E — saved versions (never "published / live / on air": nothing is published) ───────────── */

/** The badge of a saved version. A RETIRED version is a draft the owner discarded. */
export const VERSION_BADGE: Record<string, string> = {
  APPROVED: "מאושרת",
  DRAFT: "טיוטה",
  SUPERSEDED: "גרסה קודמת",
  RETIRED: "טיוטה שבוטלה",
};

/** Today's re-check of a saved version (deterministic, against current approvals). */
const CURRENT_BLOCKER_PREFIX: Record<string, string> = {
  ASSET_NOT_PUBLIC_APPROVED: "תמונה בגרסה כבר לא מאושרת לפרסום",
  TRUST_CLAIM_NOT_PUBLIC_EFFECTIVE: "טענת אמון בגרסה כבר לא מאושרת לפרסום",
  TRUST_CLAIM_WORDING_CHANGED: "הנוסח של טענת אמון השתנה מאז שהגרסה נשמרה",
  FACT_NOT_APPROVED: "פרט עסק בגרסה כבר לא מאושר לפרסום",
  FACT_VALUE_CHANGED: "פרט עסק השתנה מאז שהגרסה נשמרה",
  STATEMENT_NOT_APPROVED: "טקסט על העסק בגרסה כבר לא מאושר לפרסום",
  STATEMENT_TEXT_CHANGED: "טקסט על העסק השתנה מאז שהגרסה נשמרה",
  OFFERING_NOT_AVAILABLE: "שירות או מוצר בגרסה כבר לא פעיל",
  OFFERING_CHANGED: "שירות או מוצר השתנה מאז שהגרסה נשמרה (שם, תיאור או מחיר)",
  CONVERSION_DESTINATION_MISSING: "לדרך הפנייה בגרסה אין כרגע פרט מאושר (טלפון, אימייל, וואטסאפ או כתובת)",
  CONVERSION_UNSUPPORTED: "דרך הפנייה בגרסה כבר לא נתמכת",
  UNSUPPORTED_BLUEPRINT_VERSION: "הגרסה נשמרה בפורמט שכבר לא נתמך",
  UNSUPPORTED_RENDERER_VERSION: "הגרסה נשמרה בפורמט שכבר לא נתמך",
};

export function currentBlockerLabel(code: string): string {
  return CURRENT_BLOCKER_PREFIX[code.split(":")[0]] ?? code;
}

export function snapshotMissingLabel(code: string): string {
  return BLUEPRINT_MISSING_LABELS[code] ?? BLUEPRINT_MISSING_LABELS[code.replace(/^ASSET:/, "")] ?? code;
}
