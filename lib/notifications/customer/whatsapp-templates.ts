/**
 * Customer WhatsApp TEMPLATES — the ONE file that holds every text a customer may receive from the central Dubiz
 * number (G1, appointments completion program, workstream F). SERVER-ONLY, pure: no database, no network, no clock.
 *
 * STATUS: texts and categories decided by the owner (D11, 2026-11-26); NOT YET SUBMITTED to Meta and not approved by
 * Meta. Until Meta approves them (and the owner sets WHATSAPP_PLATFORM_SEND_MODE=live with the platform credentials)
 * the transport is SIMULATED: nothing is sent. The `name` of each template is what will be submitted (WhatsApp Manager
 * → Message templates, language `he`). A template Meta approves under a different name or text must be changed HERE
 * before going live. The owner-facing copy with the compliance checklist: C:/dev/appt-program/release/templates-for-owner.md.
 *
 * Owner rules: every OPERATIONAL message NAMES THE BUSINESS ("בית העסק: {{1}}"); the appointment details sit on their
 * own lines (the line breaks are part of the template text — Meta forbids new lines inside a parameter, error 132018,
 * and `templateParam` flattens every value); the manage link is included where the customer can act on it; no
 * marketing, no SMS, no e-mail.
 *
 * META COMPLIANCE (checked against Meta's template rules, 2026-11-26; enforced by templateCompliance() and the tests):
 *   - a body may not START or END with a parameter ("dangling parameters are not allowed") — every body here starts and
 *     ends with fixed text;
 *   - no two parameters adjacent without text between them — each detail has its own label;
 *   - parameters sequential {{1}}…{{n}}; no `#`, `$`, `%` in a parameter's name; body ≤ 1024 characters;
 *   - not "too many variable parameters relative to the message length" — at most 4 per body, each with a label, beside
 *     fixed sentences;
 *   - the MANAGE LINK cannot be the last thing in the body ("לניהול התור: {{5}}" would end with a parameter), so it is a
 *     dynamic URL BUTTON (one variable, appended to the end of the button's URL; label ≤ 25 characters), sent as a
 *     `button` component (sub_type url, index 0) whose parameter is the customer's manage token. The body keeps the
 *     owner's wording as a sentence that ends with text. Deviations from the owner's text are listed per template below.
 *   - The verification code (owner decision D1): the AUTHENTICATION category with Meta's FIXED text and copy-code button;
 *     its only parameter is the code; the business is named on the verification SCREEN (workstream G).
 */

export type MessageClass = "OPERATIONAL" | "VERIFICATION";

export type TemplateParam = "business" | "service" | "date" | "time" | "code";

export type TemplateDefinition = {
  /** Stored in NotificationDelivery.templateKey (^[a-z0-9_]{1,64}$) and submitted to Meta as the template name. */
  name: string;
  language: "he";
  metaCategory: "UTILITY" | "AUTHENTICATION";
  messageClass: MessageClass;
  /** The BODY parameters, in order ({{1}}, {{2}} …). `business` is present in every template that names the business. */
  params: readonly TemplateParam[];
  /** The Hebrew body as it will be submitted (placeholders {{n}}; the line breaks are part of the template). */
  body: string;
  /** Owner rule: the message names the business ({{1}}). False only for the AUTHENTICATION code (decision D1). */
  namesBusiness: boolean;
  /**
   * The manage link as a dynamic URL button: its label (≤ 25 characters) and the URL submitted to Meta, whose ONE
   * variable is appended at the end — the customer's manage token (the page reads it from the fragment).
   */
  urlButton?: { text: string; url: "{APP_BASE_URL}/book/manage#{{1}}" };
  /** AUTHENTICATION only: Meta's copy-code button, whose URL parameter is the code. */
  otpButton?: "COPY_CODE";
  /** AUTHENTICATION only: Meta's preset expiry footer, in minutes. */
  codeExpirationMinutes?: number;
  /** Where the submitted text differs from the owner's wording, and why (empty = the owner's text exactly). */
  deviations: readonly string[];
  /** Owner approved the text and category (D11); Meta has not reviewed it yet. */
  approval: "owner_approved_pending_meta";
};

const T = <K extends string>(t: TemplateDefinition & { name: K }) => t;

/** The appointment details, one per line (owner D11). */
const DETAILS = "בית העסק: {{1}}\nשירות: {{2}}\nתאריך: {{3}}\nשעה: {{4}}";
const DETAIL_PARAMS = ["business", "service", "date", "time"] as const;
const MANAGE_URL = "{APP_BASE_URL}/book/manage#{{1}}" as const;
const BUTTON_DEVIATION = (label: string) =>
  `The owner's last line "${label}: [link]" would end the body with a parameter, which Meta rejects (dangling parameter). ` +
  `The link is a dynamic URL button labelled "${label}" (the owner's words), and the body line reads "${label} לחצו על הכפתור למטה." ` +
  "so the body ends with fixed text.";
const CONTACT_LINE = "לשינוי או לביטול התור יש לפנות לבית העסק.";

/**
 * The templates. Appointment templates come in a "with link" and a "no link" form: a booking made through the public
 * link has the customer's own manage page (the URL button); an appointment the business entered itself has none.
 */
export const WHATSAPP_TEMPLATES = {
  appt_received: T({
    name: "dubiz_appt_received",
    language: "he",
    metaCategory: "UTILITY",
    messageClass: "OPERATIONAL",
    namesBusiness: true,
    params: DETAIL_PARAMS,
    body: `שלום, בקשתך לקביעת תור התקבלה בהצלחה.\n\n${DETAILS}\n\nנעדכן אותך לאחר אישור בית העסק.\n\nלניהול הבקשה לחצו על הכפתור למטה.`,
    urlButton: { text: "לניהול הבקשה", url: MANAGE_URL },
    deviations: [BUTTON_DEVIATION("לניהול הבקשה")],
    approval: "owner_approved_pending_meta",
  }),
  appt_confirmed: T({
    name: "dubiz_appt_confirmed",
    language: "he",
    metaCategory: "UTILITY",
    messageClass: "OPERATIONAL",
    namesBusiness: true,
    params: DETAIL_PARAMS,
    body: `התור שלך נקבע בהצלחה!\n\n${DETAILS}\n\nלניהול התור לחצו על הכפתור למטה.`,
    urlButton: { text: "לניהול התור", url: MANAGE_URL },
    deviations: [BUTTON_DEVIATION("לניהול התור")],
    approval: "owner_approved_pending_meta",
  }),
  appt_confirmed_nolink: T({
    name: "dubiz_appt_confirmed_nolink",
    language: "he",
    metaCategory: "UTILITY",
    messageClass: "OPERATIONAL",
    namesBusiness: true,
    params: DETAIL_PARAMS,
    body: `התור שלך נקבע בהצלחה!\n\n${DETAILS}\n\n${CONTACT_LINE}`,
    deviations: [],
    approval: "owner_approved_pending_meta",
  }),
  appt_changed: T({
    name: "dubiz_appt_changed",
    language: "he",
    metaCategory: "UTILITY",
    messageClass: "OPERATIONAL",
    namesBusiness: true,
    params: DETAIL_PARAMS,
    body: `מועד התור שלך עודכן.\n\n${DETAILS}\n\nלניהול התור לחצו על הכפתור למטה.`,
    urlButton: { text: "לניהול התור", url: MANAGE_URL },
    deviations: [BUTTON_DEVIATION("לניהול התור")],
    approval: "owner_approved_pending_meta",
  }),
  appt_changed_nolink: T({
    name: "dubiz_appt_changed_nolink",
    language: "he",
    metaCategory: "UTILITY",
    messageClass: "OPERATIONAL",
    namesBusiness: true,
    params: DETAIL_PARAMS,
    body: `מועד התור שלך עודכן.\n\n${DETAILS}\n\n${CONTACT_LINE}`,
    deviations: [],
    approval: "owner_approved_pending_meta",
  }),
  appt_cancelled: T({
    name: "dubiz_appt_cancelled",
    language: "he",
    metaCategory: "UTILITY",
    messageClass: "OPERATIONAL",
    namesBusiness: true,
    params: DETAIL_PARAMS,
    body: `התור שלך בוטל.\n\n${DETAILS}\n\nלקביעת תור חדש יש לפנות לבית העסק.`,
    deviations: [],
    approval: "owner_approved_pending_meta",
  }),
  appt_reminder: T({
    name: "dubiz_appt_reminder",
    language: "he",
    metaCategory: "UTILITY",
    messageClass: "OPERATIONAL",
    namesBusiness: true,
    params: DETAIL_PARAMS,
    body: `שלום, רצינו להזכיר לך שיש לך תור קרוב.\n\n${DETAILS}\n\nלניהול התור לחצו על הכפתור למטה.`,
    urlButton: { text: "לניהול התור", url: MANAGE_URL },
    deviations: [BUTTON_DEVIATION("לניהול התור")],
    approval: "owner_approved_pending_meta",
  }),
  appt_reminder_nolink: T({
    name: "dubiz_appt_reminder_nolink",
    language: "he",
    metaCategory: "UTILITY",
    messageClass: "OPERATIONAL",
    namesBusiness: true,
    params: DETAIL_PARAMS,
    body: `שלום, רצינו להזכיר לך שיש לך תור קרוב.\n\n${DETAILS}\n\n${CONTACT_LINE}`,
    deviations: [],
    approval: "owner_approved_pending_meta",
  }),
  booking_code: T({
    name: "dubiz_booking_code",
    language: "he",
    metaCategory: "AUTHENTICATION",
    messageClass: "VERIFICATION",
    namesBusiness: false,
    otpButton: "COPY_CODE",
    codeExpirationMinutes: 5,
    params: ["code"],
    // Meta's fixed AUTHENTICATION body (Hebrew locale) with its preset security notice; the footer "הקוד יפוג בעוד 5
    // דקות" is Meta's expiry component (codeExpirationMinutes). Nothing here is free text of ours; Meta itself places
    // the code first (its preset), which is why this one template is exempt from the leading-parameter rule.
    body: "{{1}} הוא קוד האימות שלך. למען אבטחתך, אין לשתף את הקוד הזה.",
    deviations: [],
    approval: "owner_approved_pending_meta",
  }),
} as const;

export type TemplateId = keyof typeof WHATSAPP_TEMPLATES;
export type TemplateName = (typeof WHATSAPP_TEMPLATES)[TemplateId]["name"];

const BY_NAME = new Map<string, TemplateDefinition>(Object.values(WHATSAPP_TEMPLATES).map((t) => [t.name, t]));

export function templateByName(name: string): TemplateDefinition | null {
  return BY_NAME.get(name) ?? null;
}

/**
 * Meta's body rules for a template WE author (UTILITY). Returns the problems found (empty = compliant). The
 * AUTHENTICATION code is Meta's own fixed text and is not checked here.
 */
export function templateCompliance(t: TemplateDefinition): string[] {
  const problems: string[] = [];
  if (t.metaCategory === "AUTHENTICATION") return problems;
  const body = t.body;
  const trimmed = body.trim();
  if (/^\{\{\d+\}\}/.test(trimmed)) problems.push("starts with a parameter");
  if (/\{\{\d+\}\}[\s.,!?:;)\]-]*$/.test(trimmed)) problems.push("ends with a parameter (or a parameter and punctuation)");
  if (/\}\}\s*\{\{/.test(body)) problems.push("two parameters adjacent");
  const nums = [...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  if (!nums.every((n, i) => n === i + 1)) problems.push("parameters not sequential from {{1}}");
  if (nums.length !== t.params.length) problems.push("parameter count differs from the definition");
  if (body.length > 1024) problems.push("body over 1024 characters");
  const fixed = body.replace(/\{\{\d+\}\}/g, "").replace(/\s+/g, " ").trim().length;
  if (nums.length > 0 && fixed / nums.length < 15) problems.push("too many parameters relative to the fixed text");
  if (t.urlButton) {
    if (t.urlButton.text.length > 25) problems.push("button label over 25 characters");
    if (!/\{\{1\}\}$/.test(t.urlButton.url) || (t.urlButton.url.match(/\{\{/g) ?? []).length !== 1) problems.push("button URL must end with its one variable");
  }
  return problems;
}

/** One parameter as Meta accepts it: no new line / tab, no run of more than three spaces, bounded, never empty. */
// New lines of every kind (incl. U+0085, U+2028, U+2029 — built from code points so no raw separator sits in the source).
const LINE_BREAKS = new RegExp(`[\r\n\t\v\f${String.fromCharCode(0x85, 0x2028, 0x2029)}]+`, "g");

export function templateParam(value: string, max = 120): string {
  const flat = value.replace(LINE_BREAKS, " ").replace(/ {2,}/g, " ").trim();
  const clipped = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  return clipped.length > 0 ? clipped : "-";
}

export type TemplateValues = Partial<Record<TemplateParam, string>>;

/**
 * The ordered BODY parameters of a template. Refuses (null) when a required value is missing — above all the
 * business name of a template that names it (every operational one): such a message is never sent without it.
 */
export function buildTemplateParams(t: TemplateDefinition, values: TemplateValues): string[] | null {
  if (t.namesBusiness && (!values.business || !values.business.trim())) return null;
  const out: string[] = [];
  for (const p of t.params) {
    const v = values[p];
    if (v === undefined || v === null || !String(v).trim()) return null;
    out.push(p === "code" ? String(v).trim() : templateParam(String(v)));
  }
  return out;
}

/** The manage token as the URL button's parameter (base64url: no encoding needed), or null when it is unusable. */
export function buttonUrlParam(t: TemplateDefinition, token: string | null | undefined): string | null {
  if (!t.urlButton) return null;
  return typeof token === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(token) ? token : null;
}

/** The text exactly as the customer would read it (the simulation log and tests; never stored). */
export function renderTemplate(t: TemplateDefinition, params: readonly string[]): string {
  return t.body.replace(/\{\{(\d+)\}\}/g, (_, n: string) => params[Number(n) - 1] ?? "");
}
