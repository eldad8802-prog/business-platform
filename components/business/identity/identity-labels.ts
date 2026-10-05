/** P2 — Hebrew labels for the identity vocabulary. Display only; the codes live in lib/services/identity. */

export const DIMENSION_LABELS: Record<string, { title: string; hint: string }> = {
  DESCRIPTION: { title: "במשפט אחד — מה העסק", hint: "איך היית מתאר את העסק ללקוח חדש" },
  SPECIALIZATION: { title: "במה העסק מתמחה", hint: "עד 3 תחומי התמחות" },
  DIFFERENTIATOR: { title: "מה מבדל אתכם", hint: "רק דברים נכונים שאפשר לעמוד מאחוריהם" },
  SERVICE_AREA: { title: "אזור שירות", hint: "ערים או אזורים שאתם משרתים" },
  TARGET_AUDIENCE: { title: "את מי אתם רוצים למשוך", hint: "עד 4" },
  PRIMARY_OBJECTIVE: { title: "מה הכי חשוב שלקוח יעשה", hint: "מטרה אחת עיקרית" },
  SECONDARY_OBJECTIVE: { title: "מטרות משניות", hint: "עד 2" },
  TONE: { title: "הטון של העסק", hint: "איך העסק מדבר" },
  POSITIONING: { title: "במה אתם רוצים שיזכרו אתכם", hint: "עד 3" },
};

export const CODE_LABELS: Record<string, string> = {
  INDIVIDUALS: "לקוחות פרטיים",
  BUSINESSES: "עסקים",
  LOCAL_CUSTOMERS: "לקוחות מהאזור",
  REMOTE_CUSTOMERS: "לקוחות מרחוק / אונליין",
  HOME_SERVICE_CUSTOMERS: "שירות עד הבית",
  APPOINTMENT_CUSTOMERS: "לקוחות שקובעים תור",
  WALK_IN_CUSTOMERS: "לקוחות שנכנסים מהרחוב",
  NEW_CUSTOMERS: "לקוחות חדשים",
  RETURNING_CUSTOMERS: "לקוחות חוזרים",
  EVENT_CUSTOMERS: "לקוחות לאירועים",
  BOOK: "לקבוע תור",
  BUY: "לקנות",
  CALL: "להתקשר",
  WHATSAPP: "לשלוח וואטסאפ",
  REQUEST_QUOTE: "לבקש הצעת מחיר",
  VISIT_STORE: "להגיע לעסק",
  DISCOVER_SERVICES: "להכיר את השירותים",
  DISCOVER_PRODUCTS: "להכיר את המוצרים",
  LEAVE_LEAD: "להשאיר פרטים",
  PROFESSIONAL: "מקצועי",
  WARM: "חם ואישי",
  FRIENDLY_CASUAL: "קליל וחברי",
  ENERGETIC: "אנרגטי",
  PREMIUM: "יוקרתי",
  VALUE: "תמורה טובה למחיר",
  SPEED: "מהירות",
  AVAILABILITY: "זמינות",
  EXPERTISE: "מומחיות",
  LOCAL_TRUST: "עסק מקומי שסומכים עליו",
  SPECIALIZATION: "התמחות",
  CONVENIENCE: "נוחות",
  BREADTH: "מגוון רחב",
  PERSONAL_SERVICE: "יחס אישי",
  INNOVATION: "חדשנות",
};

export const FACT_LABELS: Record<string, string> = {
  BUSINESS_NAME: "שם העסק",
  CITY: "עיר",
  OPENING_HOURS: "שעות פעילות",
  PUBLIC_PHONE: "טלפון",
  PUBLIC_EMAIL: "אימייל",
  PUBLIC_ADDRESS: "כתובת",
  PUBLIC_WHATSAPP: "מספר WhatsApp העסקי",
  category: "תחום",
  subCategory: "תת־תחום",
  businessModel: "סוג העסק",
};

/** Contact facts come from the billing details: shown privately, public only by explicit approval. */
export const CONTACT_FACTS = new Set(["PUBLIC_PHONE", "PUBLIC_EMAIL", "PUBLIC_ADDRESS", "PUBLIC_WHATSAPP"]);

export const FACT_STATE_LABELS: Record<string, string> = {
  KNOWN: "ידוע — לא אושר",
  OWNER_CONFIRMED: "אושר שזה נכון — פנימי",
  PUBLIC_USE_APPROVED: "מאושר לשימוש פומבי",
};

/** What Dubiz noticed, per signal kind — phrased as an observation, never as a claim. */
export function describeSignal(kind: string, value: Record<string, string | number | boolean>): string {
  switch (kind) {
    case "OFFERING_MIX":
      return value.mix === "SERVICE_LED" ? "רוב מה שהעסק מציע הוא שירותים" : value.mix === "PRODUCT_LED" ? "רוב מה שהעסק מציע הוא מוצרים" : "העסק מציע גם שירותים וגם מוצרים";
    case "CATEGORY_BREADTH":
      return value.breadth === "BROAD" ? `ההצעות שלך פרוסות על ${value.categories} קטגוריות` : value.breadth === "FOCUSED" ? "כל ההצעות שלך באותה קטגוריה" : "ההצעות שלך בכמה קטגוריות";
    case "FULFILLMENT_MODE":
      return value.fulfillment === "AT_CUSTOMER" ? "יש שירותים שניתנים אצל הלקוח" : value.fulfillment === "ONLINE" ? "יש שירותים שניתנים אונליין" : "יש שירותים שניתנים בעסק";
    case "QUOTE_PRICING":
      return "ברוב השירותים המחיר נקבע בהצעת מחיר";
    case "BOOKING_DEMAND":
      return `הושלמו ${value.bookings} תורים לשירותים בחצי השנה האחרונה`;
    case "DEMAND_CONCENTRATION":
      return `הצעה אחת מרכזת כ־${value.sharePct}% מהביקוש (פנימי בלבד — לא טענה שיווקית)`;
    case "CONTENT_VARIANT_PREFERENCE":
      return `בתוכן, בחרת ברוב הפעמים בגרסה מסוג "${value.variantKey}"`;
    case "BOT_TONE":
      return "בהגדרות הבוט בחרת טון דיבור";
    case "BOT_AUDIENCE":
      return "בהגדרות הבוט בחרת קהל יעד";
    case "BOT_PRIORITY":
      return "בהגדרות הבוט בחרת עדיפות";
    default:
      return kind;
  }
}

/* ── P3-A · conversion + trust (owner-facing language; never an enum name) ── */

export const CHANNEL_LABELS: Record<string, string> = {
  WHATSAPP_CLOUD: "WhatsApp העסקי (מחובר ל-Dubiz)",
  WHATSAPP_LINK: "WhatsApp במספר הטלפון",
  PHONE: "שיחת טלפון",
  IN_PERSON: "הגעה לעסק",
  EXTERNAL_LINK: "חנות באתר חיצוני",
  EMAIL: "אימייל",
  DUBIZ_FORM: "טופס פנייה באתר",
  DUBIZ_BOOKING: "קביעת תור אונליין",
  DUBIZ_CHECKOUT: "רכישה אונליין",
};

export const DECLARATION_LABELS: Record<string, { title: string; hint: string }> = {
  ACCEPTS_VISITS: { title: "לקוחות יכולים להגיע לעסק", hint: "יש מקום שאפשר להגיע אליו בשעות הפעילות" },
  BOOKING_BY_MESSAGE: { title: "קובעים תורים בטלפון או בהודעה", hint: "הלקוח פונה ואתם קובעים איתו מועד" },
  QUOTES_ON_REQUEST: { title: "נותנים הצעת מחיר לפי בקשה", hint: "הלקוח מתאר מה הוא צריך ומקבל הצעה" },
  WHATSAPP_ON_PUBLIC_PHONE: { title: "יש WhatsApp במספר הטלפון של העסק", hint: "אפשר לשלוח הודעה לאותו מספר" },
  EXTERNAL_SHOP: { title: "מוכרים גם בחנות אונליין חיצונית", hint: "Dubiz עדיין לא יכול לפרסם קישור לחנות — זה רק נרשם" },
};

export const CAPABILITY_LABELS: Record<string, string> = {
  AVAILABLE: "פעיל",
  AVAILABLE_UNOBSERVED: "זמין — מתבצע מחוץ ל-Dubiz",
  PLATFORM_UNPROVEN: "מחובר, עדיין בבדיקה ב-Dubiz",
  DEGRADED: "יש תקלה בחיבור",
  NOT_AUTHORIZED: "חסר אישור לשימוש פומבי",
  NOT_DECLARED: "עדיין לא סימנת שהעסק עובד כך",
  NOT_CONFIGURED: "לא מוגדר",
  NOT_SUPPORTED_BY_PLATFORM: "Dubiz עדיין לא תומך בזה",
};

export const BLOCKING_LABELS: Record<string, string> = {
  PUBLIC_PHONE_NOT_APPROVED: "מספר הטלפון קיים במערכת אבל עדיין לא אושר לשימוש ציבורי",
  PUBLIC_PHONE_MISSING: "אין מספר טלפון בפרטי העסק",
  PUBLIC_EMAIL_NOT_APPROVED: "האימייל קיים במערכת אבל עדיין לא אושר לשימוש ציבורי",
  PUBLIC_EMAIL_MISSING: "אין אימייל בפרטי העסק",
  PUBLIC_WHATSAPP_NOT_APPROVED: "WhatsApp מחובר, אבל המספר שלו עדיין לא אושר לשימוש ציבורי",
  WHATSAPP_NOT_CONNECTED: "WhatsApp העסקי לא מחובר",
  WHATSAPP_CONNECTION_ERROR: "יש תקלה בחיבור ה-WhatsApp — כרגע אי אפשר להשתמש בו",
  WHATSAPP_ON_PHONE_NOT_DECLARED: "לא סימנת שיש WhatsApp במספר הטלפון",
  ADDRESS_NOT_APPROVED: "הכתובת עדיין לא אושרה לשימוש ציבורי",
  HOURS_NOT_APPROVED: "שעות הפעילות עדיין לא אושרו לשימוש ציבורי",
  VISITS_NOT_DECLARED: "כתובת לבד היא לא חנות — צריך לסמן שלקוחות יכולים להגיע",
  NO_CANONICAL_SHOP_LINK_AUTHORITY: "אין כרגע קישור לחנות ש-Dubiz רשאי לפרסם",
  WEB_FORM_NOT_ENABLED: "אין טופס פנייה פעיל באתר",
  NOT_SUPPORTED_BY_DUBIZ: "Dubiz עדיין לא תומך בזה",
  BOOKING_BY_MESSAGE_NOT_DECLARED: "לא סימנת שקובעים תורים בטלפון או בהודעה",
  QUOTES_ON_REQUEST_NOT_DECLARED: "לא סימנת שנותנים הצעת מחיר לפי בקשה",
  EXTERNAL_SHOP_NOT_DECLARED: "לא סימנת שיש חנות אונליין",
  AUTHORITY_LAPSED: "הפרט השתנה מאז שאישרת אותו — צריך לאשר מחדש",
  TOO_FEW_OFFERINGS: "צריך לפחות 3 שירותים או מוצרים פעילים",
  PLATFORM_UNPROVEN: "WhatsApp העסקי עדיין בבדיקה ב-Dubiz — אפשר לבחור בו, Dubiz לא ימליץ עליו",
};

export const CONFLICT_LABELS: Record<string, string> = {
  PREFERENCE_CAPABILITY_CONFLICT: "הדרך שבחרת עדיין לא זמינה ללקוחות. הבחירה שלך נשמרת, אבל כרגע אי אפשר להשתמש בה כדרך פנייה פעילה.",
  PREFERENCE_EVIDENCE_DIVERGENCE: "הנתונים של העסק מצביעים על דרך פנייה אחרת. הבחירה שלך נשארת — זה רק מידע.",
  PREFERENCE_UNSET: "עדיין לא בחרת מה הכי חשוב שלקוח יעשה.",
  AUTHORITY_LAPSED: "פרט שאישרת השתנה מאז — צריך לאשר אותו מחדש.",
  CHANNEL_DEGRADED: "יש תקלה בערוץ שבחרת — כרגע אי אפשר להשתמש בו.",
  PLATFORM_UNPROVEN: "בחרת ב-WhatsApp העסקי. הבחירה נשמרת, אבל הוא עדיין בבדיקה ב-Dubiz.",
};

export const CLAIM_KIND_LABELS: Record<string, { title: string; hint: string }> = {
  FOUNDED_YEAR: { title: "שנת הקמה", hint: "מאיזו שנה העסק פועל — לפי מה שאתה מצהיר" },
  SERVED_CUSTOMERS: { title: "כמה לקוחות שירתתם", hint: "רק לפי עבודות ותורים שהושלמו ב-Dubiz" },
  LICENSED: { title: "רישיון", hint: "רישיון מקצועי — דורש מסמך תומך פרטי" },
  CERTIFIED: { title: "הסמכה או תעודה", hint: "למשל תעודת כשרות או הסמכה מקצועית — דורש מסמך תומך פרטי" },
  AUTHORIZED_DEALER: { title: "משווק מורשה", hint: "של מותג מסוים — דורש מסמך תומך פרטי" },
  GUARANTEE: { title: "אחריות", hint: "על מה, לכמה זמן ובאילו תנאים" },
};

export const CLAIM_ISSUE_LABELS: Record<string, string> = {
  EXPIRED: "פג תוקף",
  RECONFIRM_DUE: "המידע הזה דורש אישור מחדש",
  NEEDS_DOCUMENT: "כדי להשתמש בזה בפרסום צריך לצרף מסמך תומך",
  EVIDENCE_LAPSED: "הנתונים כבר לא תומכים במספר הזה",
  EVIDENCE_RULE_CHANGED: "שיטת החישוב התעדכנה — צריך לאשר מחדש",
};

export const READINESS_LABELS: Record<string, string> = {
  DESCRIPTION: "משפט אחד שמתאר את העסק",
  TARGET_AUDIENCE: "קהל היעד",
  PRIMARY_OBJECTIVE: "מה הכי חשוב שלקוח יעשה",
  PUBLIC_BUSINESS_NAME: "אישור שם העסק לשימוש ציבורי",
  PUBLIC_CONTACT: "לפחות דרך יצירת קשר אחת שאושרה לשימוש ציבורי",
  USABLE_PATH_FOR_PRIMARY_OBJECTIVE: "דרך זמינה למטרה העיקרית",
  ANY_USABLE_CONVERSION_PATH: "דרך פנייה זמינה אחת לפחות",
  PUBLIC_TRUST_CLAIM: "טענת אמון אחת שאושרה לשימוש ציבורי",
  REVIEW_CLAIM_LIKE_TEXT: "בדיקה של טקסט שנשמע כמו טענת אמון",
};
