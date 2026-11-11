/**
 * What the owner is told for every outcome of the declaration flow (#1081). Each message says what happened and
 * what was NOT done — nothing is recorded unless the outcome is CONFIRMED. Hebrew only, like the other emailed-link
 * pages.
 */

import type { IssuerDeclarationConsumeStatus, IssuerDeclarationLinkStatus } from "@/lib/auth/issuer-declaration-link";

/** Refusals billing decides before the link is touched (it stays unspent). */
export type IssuerDeclarationPrecondition = "ALREADY_DECLARED" | "INCOMPLETE" | "NEEDS_DESIGNATION";

export type IssuerDeclarationConfirmOutcome = IssuerDeclarationConsumeStatus | IssuerDeclarationPrecondition;
export type IssuerDeclarationRequestOutcome = "SENT" | "NOT_ISSUED" | IssuerDeclarationPrecondition;

export const CONFIRM_MESSAGES: Record<IssuerDeclarationConfirmOutcome, string> = {
  CONFIRMED: "ההצהרה אושרה ונשמרה. מעכשיו פרטי הזהות של העסק נעולים לפי ההצהרה.",
  USED: "הקישור כבר שומש. אם ההצהרה לא נשמרה, אפשר לבקש קישור חדש ממסך הצהרת המנפיק.",
  SUPERSEDED: "נשלח קישור חדש יותר, ולכן הקישור הזה לא אישר דבר. רק הקישור האחרון שנשלח עובד.",
  EXPIRED: "תוקף הקישור פג (30 דקות), ולכן ההצהרה לא נשמרה. אפשר לבקש קישור חדש ממסך הצהרת המנפיק.",
  BINDING_MISMATCH: "פרטי העסק השתנו מאז שנשלח הקישור, ולכן ההצהרה לא נשמרה. יש לבדוק את הפרטים ולבקש קישור חדש.",
  INVALID: "הקישור אינו תקין או שאינו שייך לחשבון המחובר. ההצהרה לא נשמרה. יש להתחבר לחשבון שאליו נשלח הקישור.",
  ALREADY_DECLARED: "לעסק כבר קיימת הצהרת מנפיק, ולכן לא נשמרה הצהרה נוספת. שינוי פרטי הזהות דורש הליך נפרד.",
  INCOMPLETE: "פרטי המנפיק אינם שלמים, ולכן ההצהרה לא נשמרה. יש להשלים אותם ולבקש קישור חדש.",
  NEEDS_DESIGNATION: "בעסק יש יותר ממשתמש אחד. את המורשה להצהיר ממנה מנהל הפלטפורמה, ולכן אי אפשר לאשר כאן. ההצהרה לא נשמרה.",
};

export const REQUEST_MESSAGES: Record<IssuerDeclarationRequestOutcome, string> = {
  SENT: "שלחנו קישור לאישור ההצהרה לאימייל של החשבון. הקישור תקף ל־30 דקות ולשימוש אחד.",
  NOT_ISSUED: "לא נשלח קישור. ייתכן שנשלחו כבר שלושה קישורים בשעה האחרונה. אפשר לנסות שוב מאוחר יותר.",
  ALREADY_DECLARED: CONFIRM_MESSAGES.ALREADY_DECLARED,
  INCOMPLETE: "יש להשלים את פרטי המנפיק לפני שליחת קישור האישור.",
  NEEDS_DESIGNATION: "בעסק יש יותר ממשתמש אחד. את המורשה להצהיר ממנה מנהל הפלטפורמה, ולכן לא נשלח קישור.",
};

export const CHECK_MESSAGES: Record<Exclude<IssuerDeclarationLinkStatus, "VALID">, string> = {
  USED: CONFIRM_MESSAGES.USED,
  SUPERSEDED: CONFIRM_MESSAGES.SUPERSEDED,
  EXPIRED: CONFIRM_MESSAGES.EXPIRED,
  INVALID: "הקישור אינו תקין. יש לפתוח את הקישור מההודעה האחרונה שנשלחה.",
};

export const SIGN_IN_REQUIRED_MESSAGE = "יש להתחבר לחשבון שאליו נשלח הקישור, ואז לפתוח את הקישור שוב.";

export const ISSUER_IDENTITY_LOCKED_MESSAGE =
  "פרטי הזהות של העסק (סוג העסק, השם הרשמי, מספר הזהות או החברה ומספר עוסק מורשה) נעולים לפי הצהרת המנפיק. שינוי שלהם דורש הליך נפרד.";

export const ISSUER_DECLARATION_REQUIRED_MESSAGE =
  "לפני הפקת מסמך יש להשלים את פרטי המנפיק ולאשר את הצהרת המנפיק. המסמך לא הופק ולא הוקצה לו מספר.";
