/**
 * M6 — website forms (source "web.form").
 *
 * A business's website posts a submission to its own endpoint: /api/intake/acquisition/web/<publicId>.
 *   server mode   Authorization: Bearer <key> (the key shown once in Dubiz) — the strong path
 *   browser mode  no key; the request's Origin must be one the owner allowed for this endpoint,
 *                 plus a honeypot field and per-endpoint rate limits (a browser cannot keep a secret)
 * The endpoint names no business: the trusted connection does.
 *
 * Accepted fields (JSON or form-encoded): name | full_name | first_name | last_name, phone, email,
 * company, message, consent, submission_id (idempotency), form_id, form_name, page_url, referrer,
 * utm_source…utm_term, gclid | fbclid | click_id — every other field becomes an answer.
 */
import { canonicalLead, type AcquisitionLeadV1 } from "../canonical";
import { makeAcquisitionAdapter } from "../adapter";
import { resolvePublicConnection } from "../resolve";

export const WEB_FORM_SOURCE = "web.form" as const;
export const WEB_FORM_MAX_FIELDS = 40;
export const HONEYPOT_FIELDS = ["_hp", "_honey", "website_url_confirm"] as const;

const KNOWN = new Set([
  "name", "full_name", "first_name", "last_name", "phone", "email", "company", "message", "consent",
  "submission_id", "form_id", "form_name", "page_url", "referrer", "utm_source", "utm_medium", "utm_campaign",
  "utm_content", "utm_term", "gclid", "fbclid", "click_id", ...HONEYPOT_FIELDS,
]);

export type WebFormParse = { ok: true; lead: AcquisitionLeadV1; honeypot: boolean } | { ok: false; code: string };

/** Flat string fields from a JSON object or a form body. Nested values are ignored. */
export function flattenFields(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= WEB_FORM_MAX_FIELDS) break;
    const key = k.trim().toLowerCase().slice(0, 64);
    if (!key || !/^[a-z0-9_.\-[\]]+$/.test(key)) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[key] = String(v);
  }
  return out;
}

export function parseWebForm(fields: Record<string, string>): WebFormParse {
  const honeypot = HONEYPOT_FIELDS.some((h) => (fields[h] ?? "").trim() !== "");
  const answers = Object.entries(fields)
    .filter(([k]) => !KNOWN.has(k))
    .map(([k, v]) => ({ key: k, label: k.replace(/[_\-.]+/g, " "), value: v }));
  if (fields.message) answers.unshift({ key: "message", label: "message", value: fields.message });
  const consent =
    fields.consent !== undefined
      ? [{ label: "consent", given: /^(1|true|yes|on|כן)$/i.test(fields.consent.trim()) }]
      : [];
  const lead = canonicalLead({
    provider: "web",
    providerLeadId: fields.submission_id,
    submittedAt: new Date().toISOString(),
    contact: {
      fullName: fields.full_name ?? fields.name,
      firstName: fields.first_name,
      lastName: fields.last_name,
      phone: fields.phone,
      email: fields.email,
      company: fields.company,
    },
    answers,
    consent,
    context: {
      formId: fields.form_id,
      formName: fields.form_name,
      clickId: fields.gclid ?? fields.fbclid ?? fields.click_id,
      landingUrl: fields.page_url,
      referrerUrl: fields.referrer,
      utm: {
        source: fields.utm_source, medium: fields.utm_medium, campaign: fields.utm_campaign,
        content: fields.utm_content, term: fields.utm_term,
      },
    },
  });
  if (!lead.contact.phone && !lead.contact.email) return { ok: false, code: "no_contact" };
  return { ok: true, lead, honeypot };
}

export const webFormAdapter = makeAcquisitionAdapter({
  sourceKey: WEB_FORM_SOURCE,
  async resolveTenant(accountRef) {
    const c = await resolvePublicConnection(WEB_FORM_SOURCE, accountRef);
    return c ? c.businessId : null;
  },
});
