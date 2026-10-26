/**
 * "Continue with Google", milestone 3 — the emails of linking Google to an existing account:
 *
 *   LINK_GOOGLE      the single-use proof link, sent to the ACCOUNT's address (not the Google one, though
 *                    they are the same address): opening it changes nothing; the page asks for a click, in
 *                    the browser that started with Google.
 *   GOOGLE_LINKED    the security notice after a link — whichever proof was used.
 *   GOOGLE_UNLINKED  the security notice after the owner removed the link.
 *
 * Same frame as the other account emails (templates/account-links.ts). Hebrew only (owner decision,
 * 22.10.2026): a row stored with another locale still renders Hebrew. The proof link's secret is derived at
 * render time and never stored (lib/auth/email-link.ts); the notices carry no link that acts — only the way
 * to the security settings.
 */

import { buildEmailLink } from "@/lib/auth/email-link";

import { renderAccountEmail, type AccountEmailCopy, type AccountLinkPayload } from "./account-links";
import { emailLanguage, firstNameOf, type RenderedEmail } from "./welcome";

const HE = emailLanguage("he");
const REASON = "קיבלת את ההודעה הזו כי היא נוגעת לאבטחת החשבון שלך בדוביז.";

export const LINK_GOOGLE_COPY: AccountEmailCopy = {
  subject: "אישור חיבור Google לחשבון שלך בדוביז",
  preheader: "לחיצה אחת, באותו דפדפן שבו התחלת, מחברת את Google לחשבון.",
  lines: [
    "התבקש חיבור של חשבון Google לחשבון שלך בדוביז.",
    "אם ביקשת את זה, יש לפתוח את הקישור באותו דפדפן שבו התחלת עם Google וללחוץ על אישור החיבור.",
  ],
  cta: "לאישור החיבור",
  after: [
    "הקישור תקף ל־30 דקות ולשימוש אחד בלבד. פתיחת הקישור לבדה לא משנה דבר.",
    "אם לא ביקשת חיבור כזה, אפשר להתעלם מההודעה. שום דבר לא ישתנה בחשבון.",
  ],
  reason: REASON,
};

export type GoogleNoticePayload = { firstName: string | null; googleEmail: string };

export function parseGoogleNoticePayload(value: unknown): GoogleNoticePayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.some((k) => k !== "firstName" && k !== "googleEmail")) return null;
  const { firstName, googleEmail } = value as { firstName?: unknown; googleEmail?: unknown };
  if (typeof googleEmail !== "string" || googleEmail.length < 3 || googleEmail.length > 320 || !googleEmail.includes("@")) return null;
  if (firstName !== undefined && firstName !== null && typeof firstName !== "string") return null;
  return { googleEmail, firstName: typeof firstName === "string" ? firstNameOf(firstName) : null };
}

export function googleLinkedCopy(googleEmail: string): AccountEmailCopy {
  return {
    subject: "חשבון Google חובר לחשבון שלך בדוביז",
    preheader: "מעכשיו אפשר להתחבר לדוביז גם עם Google.",
    lines: [`חשבון Google ‏(${googleEmail}) חובר עכשיו לחשבון שלך בדוביז. מעכשיו אפשר להתחבר גם עם Google.`],
    cta: "להגדרות האבטחה",
    after: ["אם לא חיברת את Google בעצמך, יש להיכנס להגדרות האבטחה, לנתק את Google ולבחור סיסמה חדשה."],
    reason: REASON,
  };
}

export function googleUnlinkedCopy(googleEmail: string): AccountEmailCopy {
  return {
    subject: "חשבון Google נותק מהחשבון שלך בדוביז",
    preheader: "ההתחברות עם Google הוסרה מהחשבון.",
    lines: [`חשבון Google ‏(${googleEmail}) נותק מהחשבון שלך בדוביז. ההתחברות ממשיכה עם האימייל והסיסמה.`],
    cta: "להגדרות האבטחה",
    after: ["אם לא ניתקת את Google בעצמך, יש להיכנס להגדרות האבטחה ולבחור סיסמה חדשה."],
    reason: REASON,
  };
}

export const SECURITY_SETTINGS_PATH = "/settings/security";

export function renderLinkGoogle(payload: AccountLinkPayload, ctx: { appBaseUrl: string }): RenderedEmail {
  return renderAccountEmail(LINK_GOOGLE_COPY, payload.firstName, buildEmailLink(ctx.appBaseUrl, payload.tokenId, "LINK_GOOGLE"), HE);
}

export function renderGoogleLinked(payload: GoogleNoticePayload, ctx: { appBaseUrl: string }): RenderedEmail {
  return renderAccountEmail(googleLinkedCopy(payload.googleEmail), payload.firstName, `${ctx.appBaseUrl}${SECURITY_SETTINGS_PATH}`, HE);
}

export function renderGoogleUnlinked(payload: GoogleNoticePayload, ctx: { appBaseUrl: string }): RenderedEmail {
  return renderAccountEmail(googleUnlinkedCopy(payload.googleEmail), payload.firstName, `${ctx.appBaseUrl}${SECURITY_SETTINGS_PATH}`, HE);
}
