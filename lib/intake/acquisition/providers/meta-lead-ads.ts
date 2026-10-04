/**
 * M6 — Meta Lead Ads: Facebook and Instagram lead ads (source "meta.lead_ads").
 *
 * Official path (developers.facebook.com, Graph v25): the app subscribes each Page the owner
 * authorized to the `leadgen` field; Meta POSTs a NOTIFICATION per lead — leadgen_id, page_id,
 * form_id, adgroup_id, ad_id, created_time — signed with X-Hub-Signature-256 (app secret). The answers
 * are NOT in it: they are read with GET /{leadgen_id} using the Page's token. Instagram lead ads
 * belong to the Page, so they arrive the same way.
 *
 * So: the webhook records a reference receipt (durable, deduped by leadgen_id per Page) and ACKs;
 * the processor's hydrate step reads the lead with the Page token (encrypted at rest) and replaces
 * the reference with the canonical lead before the one normalizer runs. Meta keeps leads ~90 days,
 * so a token problem defers the receipt until the owner reconnects instead of losing it.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { IntakeTerminalError, type ClaimedIntakeEvent, type HydrateResult, type IntakeReceiptDraft } from "@/lib/intake/core/contract";
import { deriveEventIdentity } from "@/lib/intake/core/event-identity";
import { acquisitionReceipt, canonicalLead } from "../canonical";
import { makeAcquisitionAdapter } from "../adapter";
import { resolveResourceConnection } from "../resolve";
import { markConnectionError, readMetaPageToken } from "../connection.service";
import { metaAppSecret, metaGraphVersion } from "../meta-config";

export const META_LEAD_ADS_SOURCE = "meta.lead_ads" as const;
export const META_LEAD_FIELDS =
  "id,created_time,field_data,form_id,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,platform,is_organic,custom_disclaimer_responses";

/** The reference a webhook delivery becomes (no personal data in it). */
export type MetaLeadRefV1 = {
  v: 1;
  kind: "meta_leadgen_ref";
  leadgenId: string;
  pageId: string;
  formId?: string;
  adId?: string;
  adgroupId?: string;
  createdTime?: number;
};

const digits = (v: unknown) => (typeof v === "string" || typeof v === "number") && /^[0-9]{1,32}$/.test(String(v)) ? String(v) : undefined;

/** Every leadgen change in a (signature-verified) webhook body, grouped by Page. */
export function parseMetaLeadgenWebhook(body: unknown): { ok: true; byPage: Map<string, MetaLeadRefV1[]> } | { ok: false; code: string } {
  if (!body || typeof body !== "object") return { ok: false, code: "malformed" };
  const b = body as { object?: unknown; entry?: unknown };
  if (b.object !== "page" || !Array.isArray(b.entry)) return { ok: false, code: "not_page_object" };
  const byPage = new Map<string, MetaLeadRefV1[]>();
  for (const entry of b.entry.slice(0, 1000)) {
    const changes = (entry as { changes?: unknown })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const ch of changes) {
      const c = ch as { field?: unknown; value?: Record<string, unknown> };
      if (c?.field !== "leadgen" || !c.value) continue;
      const leadgenId = digits(c.value.leadgen_id);
      const pageId = digits(c.value.page_id) ?? digits((entry as { id?: unknown }).id);
      if (!leadgenId || !pageId) continue;
      const ref: MetaLeadRefV1 = {
        v: 1, kind: "meta_leadgen_ref", leadgenId, pageId,
        ...(digits(c.value.form_id) ? { formId: digits(c.value.form_id) } : {}),
        ...(digits(c.value.ad_id) ? { adId: digits(c.value.ad_id) } : {}),
        ...(digits(c.value.adgroup_id) ? { adgroupId: digits(c.value.adgroup_id) } : {}),
        ...(typeof c.value.created_time === "number" ? { createdTime: c.value.created_time } : {}),
      };
      const list = byPage.get(pageId) ?? [];
      list.push(ref);
      byPage.set(pageId, list);
    }
  }
  return { ok: true, byPage };
}

/** The receipt for a lead reference: keyed by leadgen_id within the Page (Meta retries ~36h). */
export function metaReferenceReceipt(ref: MetaLeadRefV1): IntakeReceiptDraft {
  const identity = deriveEventIdentity({ providerEventId: ref.leadgenId, accountScope: ref.pageId });
  return {
    family: "LEAD",
    eventType: "lead.submitted",
    externalEventId: identity.externalEventId,
    dedupeBasis: identity.dedupeBasis,
    providerAccountRef: null,
    occurredAt: ref.createdTime ? new Date(ref.createdTime * 1000) : null,
    payload: ref as unknown as Prisma.InputJsonValue,
    metadata: {
      v: 1, provider: "meta", isTest: false, hydrated: false,
      ...(ref.formId ? { formId: ref.formId } : {}),
      ...(ref.adId ? { adId: ref.adId } : {}),
      ...(ref.adgroupId ? { adSetId: ref.adgroupId } : {}),
    } as Prisma.InputJsonValue,
  };
}

/** X-Hub-Signature-256: HMAC-SHA256(app secret, raw body), compared in constant time. */
export function verifyMetaSignature(raw: string, header: string | null, secret: string): boolean {
  const m = /^sha256=([0-9a-f]{64})$/i.exec((header ?? "").trim());
  if (!m) return false;
  const expected = createHmac("sha256", secret).update(raw, "utf8").digest();
  const given = Buffer.from(m[1], "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// ── Graph read (hydrate) ─────────────────────────────────────────────────────

/** The token travels in the Authorization header, never in the URL (URLs end up in logs). */
type GraphFetch = (url: string, token: string) => Promise<{ status: number; json: unknown }>;
const realFetch: GraphFetch = async (url, token) => {
  const r = await fetch(url, { method: "GET", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
  let json: unknown = null;
  try { json = await r.json(); } catch { json = null; }
  return { status: r.status, json };
};
let graphFetch: GraphFetch = realFetch;

/** Tests only: a stand-in for graph.facebook.com. Refused in production. */
export function setMetaGraphFetchForTests(fn: GraphFetch | null): void {
  if (process.env.NODE_ENV === "production") throw new Error("test hook disabled in production");
  graphFetch = fn ?? realFetch;
}

function appSecretProof(token: string): string | null {
  const secret = metaAppSecret();
  return secret ? createHmac("sha256", secret).update(token).digest("hex") : null;
}

const HOUR = 3_600_000;

/** Read the lead behind a reference and turn it into the canonical lead. */
export async function hydrateMetaLead(ctx: { businessId: number; now: Date }, event: ClaimedIntakeEvent): Promise<HydrateResult> {
  const p = event.payload as Partial<MetaLeadRefV1> | null;
  if (!p || p.kind !== "meta_leadgen_ref") return { kind: "unchanged" }; // already canonical (resume)
  if (typeof p.leadgenId !== "string" || typeof p.pageId !== "string") throw new IntakeTerminalError("malformed_reference");
  if (p.pageId !== event.providerAccountRef) throw new IntakeTerminalError("page_mismatch");

  const cred = await readMetaPageToken(ctx.businessId, p.pageId);
  if (!cred) return { kind: "deferred", code: "page_not_connected", until: new Date(ctx.now.getTime() + 6 * HOUR) };

  const version = metaGraphVersion();
  const proof = appSecretProof(cred.token);
  const url =
    `https://graph.facebook.com/${encodeURIComponent(version)}/${encodeURIComponent(p.leadgenId)}` +
    `?fields=${encodeURIComponent(META_LEAD_FIELDS)}` +
    (proof ? `&appsecret_proof=${proof}` : "");
  const res = await graphFetch(url, cred.token);
  const err = (res.json as { error?: { code?: number; error_subcode?: number } } | null)?.error;
  if (res.status >= 500) throw new Error(`meta_graph_${res.status}`);
  if (err || res.status !== 200) {
    const code = err?.code;
    if (code === 190 || res.status === 401) {
      await markConnectionError(cred.connectionId, "META_TOKEN_INVALID");
      return { kind: "deferred", code: "meta_token_invalid", until: new Date(ctx.now.getTime() + 6 * HOUR) };
    }
    if (code === 10 || code === 200 || res.status === 403) {
      await markConnectionError(cred.connectionId, "META_PERMISSION_MISSING");
      return { kind: "deferred", code: "meta_permission_missing", until: new Date(ctx.now.getTime() + 6 * HOUR) };
    }
    if (code === 4 || code === 17 || code === 32 || code === 613 || res.status === 429) {
      return { kind: "deferred", code: "meta_rate_limited", until: new Date(ctx.now.getTime() + HOUR) };
    }
    if (code === 100) throw new IntakeTerminalError("meta_lead_unavailable");
    throw new Error(`meta_graph_${res.status}_${code ?? "unknown"}`);
  }

  const lead = res.json as Record<string, unknown>;
  const fieldData = Array.isArray(lead.field_data) ? lead.field_data.slice(0, 60) : [];
  const contact: Record<string, string> = {};
  const answers: { key: string; label: string; value: string }[] = [];
  const CONTACT: Record<string, string> = {
    full_name: "fullName", first_name: "firstName", last_name: "lastName",
    email: "email", work_email: "email", phone_number: "phone", work_phone_number: "phone", company_name: "company",
  };
  for (const f of fieldData) {
    const name = typeof (f as { name?: unknown })?.name === "string" ? (f as { name: string }).name : "";
    const values = (f as { values?: unknown })?.values;
    const value = Array.isArray(values) ? values.filter((x) => typeof x === "string").join(", ") : "";
    if (!name || !value) continue;
    const slot = CONTACT[name.toLowerCase()];
    if (slot && !contact[slot]) contact[slot] = value;
    else answers.push({ key: name, label: name.replace(/_/g, " "), value });
  }
  const disclaimers = Array.isArray(lead.custom_disclaimer_responses) ? lead.custom_disclaimer_responses : [];
  const canonical = canonicalLead({
    provider: "meta",
    providerLeadId: lead.id ?? p.leadgenId,
    submittedAt: lead.created_time,
    platform: lead.platform,
    contact,
    answers,
    consent: disclaimers.map((d) => ({
      label: (d as { checkbox_key?: unknown })?.checkbox_key as string,
      given: (d as { is_checked?: unknown })?.is_checked === "1" || (d as { is_checked?: unknown })?.is_checked === true,
    })),
    context: {
      formId: lead.form_id ?? p.formId,
      campaignId: lead.campaign_id,
      campaignName: lead.campaign_name,
      adSetId: lead.adset_id ?? p.adgroupId,
      adSetName: lead.adset_name,
      adId: lead.ad_id ?? p.adId,
      adName: lead.ad_name,
    },
  });
  // Metadata as any canonical receipt would carry it (non-personal), now that facts are known.
  const metadata = acquisitionReceipt(canonical, p.pageId).metadata as Prisma.InputJsonValue;
  return { kind: "hydrated", payload: canonical as unknown as Prisma.InputJsonValue, metadata };
}

export const metaLeadAdsAdapter = makeAcquisitionAdapter({
  sourceKey: META_LEAD_ADS_SOURCE,
  async resolveTenant(accountRef) {
    const c = await resolveResourceConnection(META_LEAD_ADS_SOURCE, accountRef);
    return c ? c.businessId : null;
  },
  hydrate: hydrateMetaLead,
});
