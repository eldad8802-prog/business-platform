/**
 * Customer WhatsApp TEMPLATES — the ONE file that holds every text a customer may receive from the central Dubiz
 * number (G1, appointments completion program, workstream F). SERVER-ONLY, pure: no database, no network, no clock.
 *
 * ┌───────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
 * │ STATUS: DRAFT — NEEDS OWNER APPROVAL AND META APPROVAL.                                                        │
 * │ None of these templates is approved by Meta yet. Until they are (and the owner sets                            │
 * │ WHATSAPP_PLATFORM_SEND_MODE=live with the platform credentials) the transport is SIMULATED: nothing is sent.   │
 * │ The `name` of each template is what will be submitted to Meta (WhatsApp Manager → Message templates), language  │
 * │ `he`. A template Meta approves under a different name or text must be changed HERE before going live.          │
 * └───────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * Owner rules (2026-11-24): every message NAMES THE BUSINESS (it is sent from Dubiz's number on the business's
 * behalf — the business name is always parameter {{1}} of an operational template); the manage link is included
 * where the customer can act on it; no marketing, no SMS, no e-mail. Parameters are plain text only (Meta forbids
 * new lines and long runs of spaces inside a parameter) — `templateParam` enforces it.
 *
 * Meta category per template: UTILITY for every appointment message (a transaction the customer started or is part
 * of). The verification code: Meta normally requires the AUTHENTICATION category, whose body text is FIXED by Meta
 * ("<code> is your verification code") and cannot carry the business name. The owner rule "every message names the
 * business" therefore needs a decision when submitting: (a) UTILITY with the text below (Meta may reject or
 * re-categorise it), or (b) AUTHENTICATION with Meta's fixed text and the business named in the button / footer if
 * Meta allows it. OPEN QUESTION FOR THE OWNER — recorded in the PR body.
 */

export type MessageClass = "OPERATIONAL" | "VERIFICATION";

export type TemplateDefinition = {
  /** Stored in NotificationDelivery.templateKey (^[a-z0-9_]{1,64}$) and submitted to Meta as the template name. */
  name: string;
  language: "he";
  metaCategory: "UTILITY" | "AUTHENTICATION";
  messageClass: MessageClass;
  /** The parameters, in order ({{1}}, {{2}} …). `business` is always present. */
  params: readonly ("business" | "service" | "date" | "time" | "link" | "code")[];
  /** The Hebrew body as it will be submitted (placeholders {{n}}). */
  body: string;
  /** Approval state — every template starts "pending". */
  approval: "pending_owner_and_meta";
};

const T = <K extends string>(t: TemplateDefinition & { name: K }) => t;

/**
 * The templates. Appointment templates come in a "with link" and a "no link" form: a booking made through the public
 * link has the customer's own manage page; an appointment the business entered itself has none.
 */
export const WHATSAPP_TEMPLATES = {
  appt_received: T({
    name: "dubiz_appt_received",
    language: "he",
    metaCategory: "UTILITY",
    messageClass: "OPERATIONAL",
    params: ["business", "service", "date", "time", "link"],
    body: "שלום, הבקשה שלך לתור ב{{1}} התקבלה: {{2}} ב-{{3}} בשעה {{4}}. העסק יאשר אותה בהקדם ונעדכן אותך כאן. לצפייה או ביטול: {{5}}",
    approval: "pending_owner_and_meta",
  }),
  appt_confirmed: T({
    name: "dubiz_appt_confirmed",
    language: "he",
    metaCategory: "UTILITY",
    messageClass: "OPERATIONAL",
    params: ["business", "service", "date", "time", "link"],
    body: "התור שלך ב{{1}} נקבע: {{2}} ב-{{3}} בשעה {{4}}. לצפייה או ביטול: {{5}}",
    approval: "pending_owner_and_meta",
  }),
  appt_confirmed_nolink: T({
    name: "dubiz_appt_confirmed_nolink",
    language: "he",
    metaCategory: "UTILITY",
    messageClass: "OPERATIONAL",
    params: ["business", "service", "date", "time"],
    body: "התור שלך ב{{1}} נקבע: {{2}} ב-{{3}} בשעה {{4}}. לשינוי יש לפנות לעסק.",
    approval: "pending_owner_and_meta",
  }),
  appt_changed: T({
    name: "dubiz_appt_changed",
    language: "he",
    metaCategory: "UTILITY",
    messageClass: "OPERATIONAL",
    params: ["business", "service", "date", "time", "link"],
    body: "התור שלך ב{{1}} עודכן: {{2}} ב-{{3}} בשעה {{4}}. לצפייה או ביטול: {{5}}",
    approval: "pending_owner_and_meta",
  }),
  appt_changed_nolink: T({
    name: "dubiz_appt_changed_nolink",
    language: "he",
    metaCategory: "UTILITY",
    messageClass: "OPERATIONAL",
    params: ["business", "service", "date", "time"],
    body: "התור שלך ב{{1}} עודכן: {{2}} ב-{{3}} בשעה {{4}}. לשינוי יש לפנות לעסק.",
    approval: "pending_owner_and_meta",
  }),
  appt_cancelled: T({
    name: "dubiz_appt_cancelled",
    language: "he",
    metaCategory: "UTILITY",
    messageClass: "OPERATIONAL",
    params: ["business", "service", "date", "time"],
    body: "התור שלך ב{{1}} בוטל: {{2}} ב-{{3}} בשעה {{4}}. לקביעת תור חדש יש לפנות לעסק.",
    approval: "pending_owner_and_meta",
  }),
  appt_reminder: T({
    name: "dubiz_appt_reminder",
    language: "he",
    metaCategory: "UTILITY",
    messageClass: "OPERATIONAL",
    params: ["business", "service", "date", "time", "link"],
    body: "תזכורת: יש לך תור ב{{1}} — {{2}} ב-{{3}} בשעה {{4}}. לצפייה או ביטול: {{5}}",
    approval: "pending_owner_and_meta",
  }),
  appt_reminder_nolink: T({
    name: "dubiz_appt_reminder_nolink",
    language: "he",
    metaCategory: "UTILITY",
    messageClass: "OPERATIONAL",
    params: ["business", "service", "date", "time"],
    body: "תזכורת: יש לך תור ב{{1}} — {{2}} ב-{{3}} בשעה {{4}}. לשינוי יש לפנות לעסק.",
    approval: "pending_owner_and_meta",
  }),
  booking_code: T({
    name: "dubiz_booking_code",
    language: "he",
    metaCategory: "AUTHENTICATION",
    messageClass: "VERIFICATION",
    params: ["business", "code"],
    body: "קוד האימות שלך לקביעת תור ב{{1}} הוא {{2}}. הקוד תקף ל-5 דקות. אין למסור אותו לאף אחד.",
    approval: "pending_owner_and_meta",
  }),
} as const;

export type TemplateId = keyof typeof WHATSAPP_TEMPLATES;
export type TemplateName = (typeof WHATSAPP_TEMPLATES)[TemplateId]["name"];

const BY_NAME = new Map<string, TemplateDefinition>(Object.values(WHATSAPP_TEMPLATES).map((t) => [t.name, t]));

export function templateByName(name: string): TemplateDefinition | null {
  return BY_NAME.get(name) ?? null;
}

/** One parameter as Meta accepts it: no new line / tab, no run of more than three spaces, bounded, never empty. */
// New lines of every kind (incl. U+0085, U+2028, U+2029 — built from code points so no raw separator sits in the source).
const LINE_BREAKS = new RegExp(`[\r\n\t\v\f${String.fromCharCode(0x85, 0x2028, 0x2029)}]+`, "g");

export function templateParam(value: string, max = 120): string {
  const flat = value.replace(LINE_BREAKS, " ").replace(/ {2,}/g, " ").trim();
  const clipped = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  return clipped.length > 0 ? clipped : "-";
}

export type TemplateValues = Partial<Record<TemplateDefinition["params"][number], string>>;

/**
 * The ordered body parameters of a template. Refuses (null) when a required value is missing — above all the
 * business name: a message that does not name the business is never sent (owner rule).
 */
export function buildTemplateParams(t: TemplateDefinition, values: TemplateValues): string[] | null {
  if (!values.business || !values.business.trim()) return null;
  const out: string[] = [];
  for (const p of t.params) {
    const v = values[p];
    if (v === undefined || v === null || !String(v).trim()) return null;
    out.push(p === "link" || p === "code" ? String(v).trim() : templateParam(String(v)));
  }
  return out;
}

/** The text exactly as the customer would read it (the simulation log and tests; never stored). */
export function renderTemplate(t: TemplateDefinition, params: readonly string[]): string {
  return t.body.replace(/\{\{(\d+)\}\}/g, (_, n: string) => params[Number(n) - 1] ?? "");
}
