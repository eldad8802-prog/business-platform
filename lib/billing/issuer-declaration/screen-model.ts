/**
 * Issuer declaration (#1081) — the pure view model behind the approved screens (owner, 2026-11-17). No React, no
 * database: which screen a state shows, what every link outcome says and where it leads, and when the billing
 * notice appears. Every state the owner can meet has a Hebrew explanation and a way to continue.
 */

import type { IssuerDetailField } from "./details";

/** What GET /api/billing/issuer-declaration answers (the fields the screens read). */
export type DeclarationScreenState = {
  declared: boolean;
  precondition: "ALREADY_DECLARED" | "INCOMPLETE" | "NEEDS_DESIGNATION" | null;
  declarantNameMissing?: boolean;
  editableFields?: IssuerDetailField[];
  hasStatement: boolean;
};

export type DeclarationScreen = "DECLARED" | "NEEDS_DESIGNATION" | "COMPLETE" | "REVIEW" | "BLOCKED";

/**
 * The screen for a loaded state. COMPLETE = some details are still missing (screen 2); REVIEW = everything is in
 * place and the link can be sent (screen 3); DECLARED = the status screen (screen 6); BLOCKED = nothing the owner can
 * do here (a missing detail that only the correction path or Dubiz can fix).
 */
export function declarationScreenFor(s: DeclarationScreenState): DeclarationScreen {
  if (s.declared || s.precondition === "ALREADY_DECLARED") return "DECLARED";
  if (s.precondition === "NEEDS_DESIGNATION") return "NEEDS_DESIGNATION";
  if (s.precondition === "INCOMPLETE") {
    return (s.editableFields ?? []).length > 0 || s.declarantNameMissing ? "COMPLETE" : "BLOCKED";
  }
  return s.hasStatement ? "REVIEW" : "BLOCKED";
}

/**
 * The billing-area notice (screen 1): shown only while the declaration screens are on (the GET answered at all),
 * the business has not declared, and the owner has not chosen "אחר כך" during THIS visit to the billing area.
 */
export function issuerNoticeVisible(input: { available: boolean; declared: boolean; dismissedThisVisit: boolean }): boolean {
  return input.available && !input.declared && !input.dismissedThisVisit;
}

/** Labels and hints for the fields the owner may complete on the declaration screen. */
export const COMPLETION_FIELD: Partial<Record<IssuerDetailField, { label: string; hint?: string; inputMode?: "numeric" | "tel" | "email"; ltr?: boolean }>> = {
  billingVatNumber: {
    label: "מספר עוסק מורשה",
    hint: "9 ספרות. בעוסק מורשה בדרך כלל זהה למספר הזהות, ובחברה — למספר החברה. מופיע על תעודת עוסק מורשה.",
    inputMode: "numeric",
    ltr: true,
  },
  billingAddress: { label: "כתובת העסק" },
  billingPhone: { label: "טלפון", hint: "9–10 ספרות, למשל 0501234567.", inputMode: "tel", ltr: true },
  billingEmail: { label: "אימייל לחשבוניות", inputMode: "email", ltr: true },
  billingLegalName: { label: "השם הרשמי" },
  billingTaxId: { label: "מספר זהות / מספר חברה", hint: "9 ספרות, בלי רווחים או מקפים.", inputMode: "numeric", ltr: true },
};

export type ConfirmAction = "SIGN_IN" | "NEW_LINK" | "REVIEW_DETAILS" | "STATUS" | "RETRY" | "CONTACT" | "BILLING";

export type ConfirmView = {
  title: string;
  body: string;
  tone: "info" | "attention" | "plain" | "urgent" | "success";
  /** The first action is the primary one. */
  actions: ConfirmAction[];
  /** The token is still unspent and the same attempt may be repeated (transient failure). */
  retryable: boolean;
};

/** Every outcome of the emailed link — from the check (page load) and from the confirmation — to what the page shows. */
export function confirmViewFor(status: string): ConfirmView {
  switch (status) {
    case "CONFIRMED":
      return { title: "ההצהרה אושרה", body: "ההצהרה נשמרה. אין צורך להצהיר שוב — היא חלה על כל המסמכים מעכשיו.", tone: "success", actions: ["STATUS", "BILLING"], retryable: false };
    case "SIGN_IN_REQUIRED":
      return {
        title: "צריך להתחבר קודם",
        body: "הקישור נפתח בדפדפן שבו אינך מחובר/ת לדוביז (למשל מאפליקציית המייל בטלפון). מטעמי אבטחה הוא עובד רק כשהחשבון מחובר: יש להתחבר בדפדפן הזה, ואז לחזור למייל ולפתוח את הקישור שוב — הוא תקף עד 30 דקות מהשליחה.",
        tone: "info",
        actions: ["SIGN_IN"],
        retryable: false,
      };
    case "EXPIRED":
      return { title: "תוקף הקישור פג", body: "עברו יותר מ־30 דקות, ולכן שום דבר לא נשמר. אפשר לבקש קישור חדש.", tone: "attention", actions: ["NEW_LINK"], retryable: false };
    case "SUPERSEDED":
    case "USED":
      return {
        title: "הקישור הזה כבר לא פעיל",
        body: "נשלח קישור חדש יותר, או שהקישור כבר שומש. רק הקישור האחרון עובד. אם ההצהרה כבר אושרה — אין צורך לעשות דבר.",
        tone: "plain",
        actions: ["STATUS"],
        retryable: false,
      };
    case "BINDING_MISMATCH":
      return {
        title: "פרטי העסק השתנו מאז השליחה",
        body: "כדי שתאשר/י בדיוק את מה שיופיע על המסמכים, הקישור בוטל ושום דבר לא נשמר. יש לבדוק את הפרטים ולשלוח קישור חדש.",
        tone: "attention",
        actions: ["REVIEW_DETAILS"],
        retryable: false,
      };
    case "ALREADY_DECLARED":
      return { title: "לעסק כבר קיימת הצהרה", body: "לא נשמרה הצהרה נוספת. אין צורך לעשות דבר.", tone: "plain", actions: ["STATUS"], retryable: false };
    case "INCOMPLETE":
      return { title: "חסרים פרטים", body: "פרטי המנפיק אינם שלמים, ולכן ההצהרה לא נשמרה. יש להשלים אותם ולשלוח קישור חדש.", tone: "attention", actions: ["REVIEW_DETAILS"], retryable: false };
    case "NEEDS_DESIGNATION":
      return {
        title: "צריך לקבוע מי מוסמך להצהיר",
        body: "בעסק יש כמה משתמשים, ולכן צוות דוביז קובע מי מוסמך להצהיר בשם העסק. ההצהרה לא נשמרה כאן.",
        tone: "info",
        actions: ["CONTACT"],
        retryable: false,
      };
    case "NOT_RECORDED":
    case "ERROR":
      return { title: "ההצהרה לא נשמרה", body: "הייתה תקלה זמנית. הקישור לא נוצל — אפשר לנסות שוב עכשיו.", tone: "urgent", actions: ["RETRY"], retryable: true };
    case "INVALID":
    default:
      return {
        title: "הקישור אינו תקין",
        body: "הקישור אינו תקין או שאינו שייך לחשבון המחובר, ושום דבר לא נשמר. יש לפתוח את הקישור מההודעה האחרונה שנשלחה, כשהחשבון שאליו נשלחה מחובר.",
        tone: "attention",
        actions: ["NEW_LINK"],
        retryable: false,
      };
  }
}
