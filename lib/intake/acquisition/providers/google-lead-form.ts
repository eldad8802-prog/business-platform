/**
 * M6 — Google Ads lead form assets (source "google.lead_form").
 *
 * Official path (developers.google.com/google-ads/webhook): the advertiser sets, in the lead form's
 * "Webhook integration", a URL and a key. Google POSTs each submission as JSON with the key in
 * `google_key` (no signature exists); 200 + {} acknowledges; 5xx is retried, 4xx is not.
 * Dubiz gives each connection its own URL (/api/intake/acquisition/google/<publicId>) and its own
 * key, stored only as a sha256: the URL + key pair is the trusted mapping to ONE business.
 *
 * Payload fields used: lead_id, user_column_data[{column_id, column_name, string_value}], form_id,
 * campaign_id, adgroup_id, creative_id, gcl_id, is_test, lead_submit_time, asset_group_id.
 * `is_test` submissions (Google's "Send test data") are accepted but never become a Lead.
 */
import { canonicalLead, type AcquisitionLeadV1 } from "../canonical";
import { makeAcquisitionAdapter } from "../adapter";
import { resolvePublicConnection } from "../resolve";

export const GOOGLE_LEAD_FORM_SOURCE = "google.lead_form" as const;

const CONTACT_COLUMNS: Record<string, "fullName" | "firstName" | "lastName" | "phone" | "email" | "company"> = {
  FULL_NAME: "fullName",
  FIRST_NAME: "firstName",
  LAST_NAME: "lastName",
  PHONE_NUMBER: "phone",
  EMAIL: "email",
  WORK_EMAIL: "email",
  WORK_PHONE: "phone",
  COMPANY_NAME: "company",
};

export type GoogleParse = { ok: true; lead: AcquisitionLeadV1; googleKey: string } | { ok: false; code: string };

export function parseGoogleLead(body: unknown): GoogleParse {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, code: "malformed" };
  const b = body as Record<string, unknown>;
  const googleKey = typeof b.google_key === "string" ? b.google_key : "";
  if (!googleKey) return { ok: false, code: "missing_key" };
  if (typeof b.lead_id !== "string" || !b.lead_id) return { ok: false, code: "missing_lead_id" };
  const cols = Array.isArray(b.user_column_data) ? b.user_column_data.slice(0, 60) : [];
  const contact: Record<string, string> = {};
  const answers: { key: string; label: string; value: string }[] = [];
  for (const c of cols) {
    if (!c || typeof c !== "object") continue;
    const col = c as Record<string, unknown>;
    const id = typeof col.column_id === "string" ? col.column_id : "";
    const value = typeof col.string_value === "string" ? col.string_value : "";
    if (!value) continue;
    const slot = CONTACT_COLUMNS[id];
    if (slot && !contact[slot]) contact[slot] = value;
    else answers.push({ key: id || "question", label: typeof col.column_name === "string" ? col.column_name : id, value });
  }
  const lead = canonicalLead({
    provider: "google",
    providerLeadId: b.lead_id,
    submittedAt: b.lead_submit_time,
    isTest: b.is_test === true,
    platform: "google_ads",
    contact,
    answers,
    context: {
      formId: b.form_id,
      campaignId: b.campaign_id,
      adSetId: b.adgroup_id ?? b.asset_group_id,
      adId: b.creative_id,
      clickId: b.gcl_id,
    },
  });
  return { ok: true, lead, googleKey };
}

export const googleLeadFormAdapter = makeAcquisitionAdapter({
  sourceKey: GOOGLE_LEAD_FORM_SOURCE,
  async resolveTenant(accountRef) {
    const c = await resolvePublicConnection(GOOGLE_LEAD_FORM_SOURCE, accountRef);
    return c ? c.businessId : null;
  },
});
