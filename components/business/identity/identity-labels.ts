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
  category: "תחום",
  subCategory: "תת־תחום",
  businessModel: "סוג העסק",
};

/** Contact facts come from the billing details: shown privately, public only by explicit approval. */
export const CONTACT_FACTS = new Set(["PUBLIC_PHONE", "PUBLIC_EMAIL", "PUBLIC_ADDRESS"]);

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
      return `נקבעו ${value.bookings} תורים לשירותים בחצי השנה האחרונה`;
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
