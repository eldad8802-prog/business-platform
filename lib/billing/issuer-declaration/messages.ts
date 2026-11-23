/**
 * What the owner is told for every outcome of the declaration flow (#1081). Each message says what happened and
 * what was NOT done — nothing is recorded unless the outcome is CONFIRMED. Hebrew only, like the other emailed-link
 * pages.
 */

import type { IssuerDeclarationConsumeStatus, IssuerDeclarationLinkStatus } from "@/lib/auth/issuer-declaration-link";

/**
 * The owner-approved legal identity rule (2026-11-20/21, 4a T6): there is no correction request and no approver. The
 * same individual moves from exempt to authorized through "מעבר לעוסק מורשה"; any other name or number is a new
 * business file. Plain text, never a link: the transition flow has its own switch and answers 404 while it is off.
 */
export const LEGAL_IDENTITY_RULE_MESSAGE =
  "סוג העסק, השם המשפטי ומספר העוסק / ח״פ לא משתנים לאחר האישור. מעבר מעוסק פטור לעוסק מורשה — דרך ״מעבר לעוסק מורשה״. שם או מספר אחר — בתיק עסק חדש.";

/** Refusals billing decides before the link is touched (it stays unspent). */
export type IssuerDeclarationPrecondition = "ALREADY_DECLARED" | "INCOMPLETE" | "NEEDS_DESIGNATION";

export type IssuerDeclarationConfirmOutcome = IssuerDeclarationConsumeStatus | IssuerDeclarationPrecondition;
export type IssuerDeclarationRequestOutcome = "SENT" | "NOT_ISSUED" | IssuerDeclarationPrecondition;

export const CONFIRM_MESSAGES: Record<IssuerDeclarationConfirmOutcome, string> = {
  CONFIRMED: "ההצהרה אושרה ונשמרה. אין צורך להצהיר שוב — היא חלה על כל המסמכים מעכשיו.",
  USED: "הקישור כבר שומש. אם ההצהרה כבר אושרה — אין צורך לעשות דבר. אם לא, אפשר לשלוח קישור חדש.",
  SUPERSEDED: "נשלח קישור חדש יותר, ולכן הקישור הזה לא אישר דבר. רק הקישור האחרון שנשלח עובד.",
  EXPIRED: "עברו יותר מ־30 דקות, ולכן שום דבר לא נשמר. אפשר לבקש קישור חדש.",
  BINDING_MISMATCH: "פרטי העסק השתנו מאז שנשלח הקישור, ולכן הקישור בוטל ושום דבר לא נשמר. יש לבדוק את הפרטים ולשלוח קישור חדש.",
  INVALID: "הקישור אינו תקין או שאינו שייך לחשבון המחובר. שום דבר לא נשמר. יש להתחבר לחשבון שאליו נשלח הקישור ולפתוח אותו שוב.",
  ALREADY_DECLARED: `לעסק כבר קיימת הצהרת מנפיק, ולכן לא נשמרה הצהרה נוספת. ${LEGAL_IDENTITY_RULE_MESSAGE}`,
  INCOMPLETE: "פרטי המנפיק אינם שלמים, ולכן ההצהרה לא נשמרה. יש להשלים אותם ולשלוח קישור חדש.",
  NEEDS_DESIGNATION: "בעסק יש כמה משתמשים, ולכן צוות דוביז קובע מי מוסמך להצהיר. ההצהרה לא נשמרה כאן.",
};

export const REQUEST_MESSAGES: Record<IssuerDeclarationRequestOutcome, string> = {
  SENT: "שלחנו קישור לאישור ההצהרה לאימייל של החשבון. הקישור תקף ל־30 דקות ולשימוש אחד.",
  NOT_ISSUED: "לא נשלח קישור. ייתכן שנשלחו כבר שלושה קישורים בשעה האחרונה. אפשר לנסות שוב מאוחר יותר.",
  ALREADY_DECLARED: CONFIRM_MESSAGES.ALREADY_DECLARED,
  INCOMPLETE: "יש להשלים את פרטי המנפיק לפני שליחת קישור האישור.",
  NEEDS_DESIGNATION: "בעסק יש כמה משתמשים, ולכן צוות דוביז קובע מי מוסמך להצהיר. לא נשלח קישור.",
};

export const CHECK_MESSAGES: Record<Exclude<IssuerDeclarationLinkStatus, "VALID">, string> = {
  USED: CONFIRM_MESSAGES.USED,
  SUPERSEDED: CONFIRM_MESSAGES.SUPERSEDED,
  EXPIRED: CONFIRM_MESSAGES.EXPIRED,
  INVALID: "הקישור אינו תקין. יש לפתוח את הקישור מההודעה האחרונה שנשלחה.",
};

export const SIGN_IN_REQUIRED_MESSAGE =
  "הקישור נפתח בדפדפן שבו אינך מחובר/ת לדוביז. מטעמי אבטחה הוא עובד רק כשהחשבון מחובר: יש להתחבר בדפדפן הזה, ואז לפתוח את הקישור מהמייל שוב.";

/** The signed-in account has no name to sign the declaration with (a company's declarant must be a named person). */
export const DECLARANT_NAME_MISSING_MESSAGE =
  "חסר שם מלא בחשבון שלך, והוא נדרש כדי לחתום על ההצהרה בשם החברה. זה פרט של החשבון ולא של העסק — לעדכונו יש לפנות לצוות דוביז.";

/** The stable machine code of the identity-lock refusal (409), alongside LEGAL_IDENTITY_LOCKED. */
export const ISSUER_IDENTITY_LOCKED_CODE = "ISSUER_IDENTITY_LOCKED";

export const ISSUER_IDENTITY_LOCKED_MESSAGE = `פרטי הזהות של העסק נעולים לפי הצהרת המנפיק. ${LEGAL_IDENTITY_RULE_MESSAGE}`;

export const ISSUER_DECLARATION_REQUIRED_MESSAGE =
  "לפני הפקת מסמך יש להשלים את פרטי המנפיק ולאשר את הצהרת המנפיק. המסמך לא הופק ולא הוקצה לו מספר.";
