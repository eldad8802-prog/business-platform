/**
 * ISSUER_DECLARATION — the single-use link that confirms a business's issuer declaration (#1081; migration
 * 20261126090000; lib/auth/issuer-declaration-link.ts).
 *
 * Same frame as the other account emails (templates/account-links.ts, used read-only here). Hebrew only, like
 * the Google link: a row stored with another locale still renders Hebrew.
 *
 * What it shows is deliberately minimal (owner decision 2026-11-11): the business's legal name and legal form,
 * and the 30-minute limit. NEVER an ID number, a VAT / dealer / company number, an address or a phone — those
 * belong to the declaration screen, behind a signed-in session, not to a mailbox. The payload therefore cannot
 * carry them: parse accepts exactly { tokenId, firstName, legalName, legalForm } and nothing else is rendered.
 * The link's secret is derived at render time and never stored (lib/auth/email-link.ts).
 */

import { buildEmailLink } from "@/lib/auth/email-link";

import { renderAccountEmail, type AccountEmailCopy } from "./account-links";
import { emailLanguage, type RenderedEmail } from "./welcome";

const HE = emailLanguage("he");

export const ISSUER_DECLARATION_LEGAL_FORMS = {
  EXEMPT_DEALER: "עוסק פטור",
  AUTHORIZED_DEALER: "עוסק מורשה",
  LTD_COMPANY: "חברה בע״מ",
} as const;
export type IssuerDeclarationLegalForm = keyof typeof ISSUER_DECLARATION_LEGAL_FORMS;

export type IssuerDeclarationPayload = {
  tokenId: string;
  firstName: string | null;
  /** The business's legal name as it appears on the declaration (bounded; escaped by the frame). */
  legalName: string;
  legalForm: IssuerDeclarationLegalForm;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_DECLARATION_LEGAL_NAME = 120;

export function parseIssuerDeclarationPayload(value: unknown): IssuerDeclarationPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).sort().join(",");
  if (keys !== "firstName,legalForm,legalName,tokenId") return null;
  if (typeof v.tokenId !== "string" || !UUID.test(v.tokenId)) return null;
  if (v.firstName !== null && (typeof v.firstName !== "string" || v.firstName.length > 60)) return null;
  if (typeof v.legalName !== "string" || !v.legalName.trim() || v.legalName.length > MAX_DECLARATION_LEGAL_NAME) return null;
  if (typeof v.legalForm !== "string" || !(v.legalForm in ISSUER_DECLARATION_LEGAL_FORMS)) return null;
  return { tokenId: v.tokenId, firstName: v.firstName as string | null, legalName: v.legalName, legalForm: v.legalForm as IssuerDeclarationLegalForm };
}

export function issuerDeclarationCopy(legalName: string, legalForm: IssuerDeclarationLegalForm): AccountEmailCopy {
  return {
    subject: "אישור הצהרת המנפיק של העסק שלך בדוביז",
    preheader: "הקישור תקף ל־30 דקות ולשימוש אחד בלבד.",
    lines: [
      `התבקש אישור של הצהרת המנפיק עבור ${legalName} (${ISSUER_DECLARATION_LEGAL_FORMS[legalForm]}).`,
      "כדי לאשר, יש לפתוח את הקישור כשהחשבון שלך מחובר, ולאשר את הפרטים שמוצגים במסך.",
    ],
    cta: "לאישור ההצהרה",
    after: [
      "הקישור תקף ל־30 דקות ולשימוש אחד בלבד. אם פרטי העסק ישתנו לפני האישור, צריך לבקש קישור חדש.",
      "אם לא ביקשת את זה, אפשר להתעלם מההודעה. שום דבר לא ישתנה.",
    ],
    reason: "קיבלת את ההודעה הזו כי היא נוגעת לפרטי העסק שלך בדוביז.",
  };
}

export function renderIssuerDeclaration(payload: IssuerDeclarationPayload, ctx: { appBaseUrl: string }): RenderedEmail {
  return renderAccountEmail(
    issuerDeclarationCopy(payload.legalName, payload.legalForm),
    payload.firstName,
    buildEmailLink(ctx.appBaseUrl, payload.tokenId, "ISSUER_DECLARATION"),
    HE,
  );
}
