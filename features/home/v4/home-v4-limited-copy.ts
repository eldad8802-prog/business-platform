/**
 * HOME v4 — FREE_LIMITED texts and styles (owner decisions 3 + 4), kept OUT of the global dictionary on purpose.
 *
 * FREE_LIMITED is drawn only when the subscription mechanism reports it, and that mechanism does not exist yet — so
 * no business sees any of this today. To keep every business's Home and "+" from downloading it, this module is
 * loaded on demand (limited-copy-loader.ts) only once the capabilities answer says FREE_LIMITED.
 */

import type { Locale } from "@/lib/i18n/config";

export type LimitedCopy = {
  /** The one status line under the greeting, and its link (drawn only when the mechanism names a plan screen). */
  statusLine: string;
  statusLink: string;
  /** The one plan card in בשבילך. */
  eyebrow: string;
  title: string;
  body: string;
  cta: string;
  /** The secretary's collection group: what waits stays visible; a reminder returns with an active plan. */
  collectionBody: string;
  collectionCta: string;
  /** "+": one line under the actions that are still allowed. */
  createNote: string;
};

const HE: LimitedCopy = {
  statusLine: "המנוי במצב צפייה. כל הנתונים שמורים.",
  statusLink: "המנוי שלי",
  eyebrow: "המנוי שלך",
  title: "חוזרים לעבוד כרגיל עם מנוי פעיל",
  body: "הנתונים שלך שמורים וזמינים לצפייה ולייצוא. במסלול בסיסי כל הפעולות חוזרות.",
  cta: "בחירת מסלול",
  collectionBody: "אפשר לראות מי עוד לא שילם. שליחת תזכורת חוזרת עם מנוי פעיל.",
  collectionCta: "לצפייה בבקשות",
  createNote: "קביעת תור, חשבונית ובקשת תשלום זמינות עם מנוי פעיל.",
};

const EN: LimitedCopy = {
  statusLine: "Your plan is view-only. All your data is kept.",
  statusLink: "My plan",
  eyebrow: "Your plan",
  title: "Back to work as usual with an active plan",
  body: "Your data is kept and available to view and export. On the Basic plan every action comes back.",
  cta: "Choose a plan",
  collectionBody: "You can see who hasn't paid yet. Sending a reminder comes back with an active plan.",
  collectionCta: "View requests",
  createNote: "Appointments, invoices and payment requests come back with an active plan.",
};

export function limitedCopy(locale: Locale): LimitedCopy {
  return locale === "en" ? EN : HE;
}

/** The status line's look (HOME v4 tokens) — injected with the line itself, never into the shared HOME_V4_CSS. */
export const LIMITED_CSS = `
.h4-head { display:flex; flex-direction:column; grid-area:head; }
.h4-status { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:6px; padding:8px 8px 8px 14px; border-radius:16px; background:#FBF7EF; border:1px solid #E6D7BE; color:#815A32; font-size:14px; }
.h4-status a { display:inline-flex; align-items:center; min-height:40px; padding:0 8px; color:var(--h4-teal-deep); font-weight:600; text-decoration:none; white-space:nowrap; }
`;
