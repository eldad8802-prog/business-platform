/**
 * M6 — the ONE canonical acquisition lead.
 *
 * Every acquisition provider adapter (Meta Lead Ads, Google Ads lead forms, website forms) does one
 * thing: turn its provider's payload into an {@link AcquisitionLeadV1}. From here on nothing knows
 * the provider: the receipt, the normalization, identity (M4), routing (M4 R4 → core lead
 * destination), the Lead, its lifecycle (M5), the Secretary and the learning signals are the same
 * code for every source.
 *
 *   provider payload ──adapter──▶ AcquisitionLeadV1 ──▶ IntakeReceiptDraft (family LEAD)
 *        ──acceptIntake──▶ IntakeEvent ──processor──▶ normalizeAcquisitionLead ──▶ M4 identity
 *        ──▶ routeToLead ──▶ Lead (+ lifecycle "created", Secretary attention, sensors)
 *
 * PERSONAL DATA lives only in the receipt payload (purged when processed) and, as the Lead's
 * contact / intent, in the Lead (erased with it). The receipt METADATA — kept after the purge, for
 * M8 attribution — is non-personal by construction: ids of the business's own campaigns / forms /
 * ads, the platform, whether it was a test, and for each fact whether the provider supplied it,
 * did not supply it, or never can ("not_applicable") — so "unknown" never masquerades as "absent".
 */

import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { ClaimedIntakeEvent, IntakeReceiptDraft, NormalizeResult } from "@/lib/intake/core/contract";
import { deriveEventIdentity } from "@/lib/intake/core/event-identity";
import { sanitizeAttribution } from "@/lib/intake/core/attribution";
import { normalizeContactHints } from "@/lib/intake/core/contact";

export const ACQUISITION_PROVIDERS = ["meta", "google", "web"] as const;
export type AcquisitionProvider = (typeof ACQUISITION_PROVIDERS)[number];

/** Facts a lead may carry; each is supplied / not_supplied / not_applicable for its provider. */
export const ACQUISITION_FACTS = [
  "phone", "email", "name", "form", "campaign", "adSet", "ad", "clickId", "landingPage", "referrer", "utm", "consent",
] as const;
export type AcquisitionFact = (typeof ACQUISITION_FACTS)[number];
export type FactStatus = "supplied" | "not_supplied" | "not_applicable";

export const ANSWER_LIMIT = 30;
export const ANSWER_VALUE_MAX = 500;
export const ANSWER_LABEL_MAX = 120;

export type AcquisitionAnswer = { key: string; label: string; value: string };

export type AcquisitionLeadV1 = {
  v: 1;
  provider: AcquisitionProvider;
  /** The provider's id for this submission (Meta leadgen_id, Google lead_id, web submission id). */
  providerLeadId: string | null;
  /** ISO time the person submitted, as the provider reports it. */
  submittedAt: string | null;
  /** Provider-flagged test submission (Google is_test). A test never becomes a Lead. */
  isTest: boolean;
  /** Facebook / Instagram / Google surface, when the provider says (non-personal). */
  platform?: string;
  contact: { fullName?: string; firstName?: string; lastName?: string; phone?: string; email?: string; company?: string };
  /** Every other answer, verbatim and bounded (personal). */
  answers: AcquisitionAnswer[];
  /** Consent checkboxes the form showed and whether they were ticked. */
  consent: { label: string; given: boolean }[];
  context: {
    formId?: string;
    formName?: string;
    campaignId?: string;
    campaignName?: string;
    adSetId?: string;
    adSetName?: string;
    adId?: string;
    adName?: string;
    clickId?: string;
    /** The provider's own kind of lead source (Google lead_source: LEAD_FORM / CONVERSATIONAL_AGENT). */
    sourceType?: string;
    /** Whether adSetId names an ad group or a Performance Max asset group (Google). */
    adSetKind?: "ad_group" | "asset_group";
    landingUrl?: string;
    referrerUrl?: string;
    utm?: Partial<Record<"source" | "medium" | "campaign" | "content" | "term", string>>;
  };
};

/** Which facts each provider can ever supply (the rest are not_applicable for it). */
const CAPABLE: Record<AcquisitionProvider, ReadonlySet<AcquisitionFact>> = {
  meta: new Set<AcquisitionFact>(["phone", "email", "name", "form", "campaign", "adSet", "ad", "consent"]),
  google: new Set<AcquisitionFact>(["phone", "email", "name", "form", "campaign", "adSet", "ad", "clickId"]),
  web: new Set<AcquisitionFact>(["phone", "email", "name", "form", "campaign", "clickId", "landingPage", "referrer", "utm", "consent"]),
};

const str = (v: unknown, max = 200): string | undefined => {
  if (typeof v !== "string" && typeof v !== "number") return undefined;
  const s = String(v).replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return s ? s.slice(0, max) : undefined;
};
/** Ids of the business's OWN provider objects: short, opaque, safe charset only. */
const idOf = (v: unknown): string | undefined => {
  const s = str(v, 64);
  return s && /^[A-Za-z0-9_.:-]+$/.test(s) ? s : undefined;
};
/**
 * The provider's id for ONE submission — the receipt's dedupe key. Never truncated (two distinct ids
 * sharing a prefix must never collapse into one receipt): a plain id up to 200 characters is kept as
 * is; anything longer or outside the safe charset is kept as its sha256, which is just as unique.
 */
const leadIdOf = (v: unknown): string | undefined => {
  if (typeof v !== "string" && typeof v !== "number") return undefined;
  const s = String(v).trim();
  if (!s) return undefined;
  if (s.length <= 200 && /^[A-Za-z0-9_.:-]+$/.test(s)) return s;
  return `sha256-${createHash("sha256").update(s, "utf8").digest("hex")}`;
};

/** Bound and clean a provider's raw parts into the canonical lead (adapters call this). */
export function canonicalLead(input: {
  provider: AcquisitionProvider;
  providerLeadId?: unknown;
  submittedAt?: unknown;
  isTest?: unknown;
  platform?: unknown;
  contact?: Partial<Record<keyof AcquisitionLeadV1["contact"], unknown>>;
  answers?: { key?: unknown; label?: unknown; value?: unknown }[];
  consent?: { label?: unknown; given?: unknown }[];
  context?: Partial<Record<keyof Omit<AcquisitionLeadV1["context"], "utm">, unknown>> & { utm?: Record<string, unknown> | null };
}): AcquisitionLeadV1 {
  const c = input.contact ?? {};
  const ctx = input.context ?? {};
  const utm: Partial<Record<"source" | "medium" | "campaign" | "content" | "term", string>> = {};
  for (const k of ["source", "medium", "campaign", "content", "term"] as const) {
    const v = str(ctx.utm?.[k], 100);
    if (v) utm[k] = v;
  }
  const answers: AcquisitionAnswer[] = [];
  for (const a of input.answers ?? []) {
    if (answers.length >= ANSWER_LIMIT) break;
    const value = str(a.value, ANSWER_VALUE_MAX);
    if (!value) continue;
    const key = str(a.key, 64) ?? `q${answers.length + 1}`;
    answers.push({ key, label: str(a.label, ANSWER_LABEL_MAX) ?? key, value });
  }
  const consent = (input.consent ?? [])
    .slice(0, 10)
    .map((x) => ({ label: str(x.label, ANSWER_LABEL_MAX) ?? "consent", given: x.given === true }));
  const submitted = str(input.submittedAt, 40);
  const submittedDate = submitted ? new Date(submitted) : null;
  return {
    v: 1,
    provider: input.provider,
    providerLeadId: leadIdOf(input.providerLeadId) ?? null,
    submittedAt: submittedDate && !Number.isNaN(submittedDate.getTime()) ? submittedDate.toISOString() : null,
    isTest: input.isTest === true,
    ...(str(input.platform, 20) ? { platform: str(input.platform, 20)!.toLowerCase() } : {}),
    contact: {
      ...(str(c.fullName) ? { fullName: str(c.fullName) } : {}),
      ...(str(c.firstName, 100) ? { firstName: str(c.firstName, 100) } : {}),
      ...(str(c.lastName, 100) ? { lastName: str(c.lastName, 100) } : {}),
      ...(str(c.phone, 40) ? { phone: str(c.phone, 40) } : {}),
      ...(str(c.email, 254) ? { email: str(c.email, 254) } : {}),
      ...(str(c.company) ? { company: str(c.company) } : {}),
    },
    answers,
    consent,
    context: {
      ...(idOf(ctx.formId) ? { formId: idOf(ctx.formId) } : {}),
      ...(str(ctx.formName, 120) ? { formName: str(ctx.formName, 120) } : {}),
      ...(idOf(ctx.campaignId) ? { campaignId: idOf(ctx.campaignId) } : {}),
      ...(str(ctx.campaignName, 120) ? { campaignName: str(ctx.campaignName, 120) } : {}),
      ...(idOf(ctx.adSetId) ? { adSetId: idOf(ctx.adSetId) } : {}),
      ...(str(ctx.adSetName, 120) ? { adSetName: str(ctx.adSetName, 120) } : {}),
      ...(idOf(ctx.adId) ? { adId: idOf(ctx.adId) } : {}),
      ...(str(ctx.adName, 120) ? { adName: str(ctx.adName, 120) } : {}),
      ...(str(ctx.clickId, 200) ? { clickId: str(ctx.clickId, 200) } : {}),
      ...(typeof ctx.sourceType === "string" && /^[A-Z][A-Z_]{0,39}$/.test(ctx.sourceType) ? { sourceType: ctx.sourceType } : {}),
      ...(ctx.adSetKind === "ad_group" || ctx.adSetKind === "asset_group" ? { adSetKind: ctx.adSetKind } : {}),
      ...(str(ctx.landingUrl, 500) ? { landingUrl: str(ctx.landingUrl, 500) } : {}),
      ...(str(ctx.referrerUrl, 500) ? { referrerUrl: str(ctx.referrerUrl, 500) } : {}),
      ...(Object.keys(utm).length ? { utm } : {}),
    },
  };
}

/** Per fact: did this provider supply it, not supply it, or can it never? (non-personal) */
export function factStatus(lead: AcquisitionLeadV1): Record<AcquisitionFact, FactStatus> {
  const has: Record<AcquisitionFact, boolean> = {
    phone: !!lead.contact.phone,
    email: !!lead.contact.email,
    name: !!(lead.contact.fullName || lead.contact.firstName || lead.contact.lastName),
    form: !!(lead.context.formId || lead.context.formName),
    campaign: !!(lead.context.campaignId || lead.context.campaignName || lead.context.utm?.campaign),
    adSet: !!(lead.context.adSetId || lead.context.adSetName),
    ad: !!(lead.context.adId || lead.context.adName),
    clickId: !!lead.context.clickId,
    landingPage: !!lead.context.landingUrl,
    referrer: !!lead.context.referrerUrl,
    utm: !!lead.context.utm,
    consent: lead.consent.length > 0,
  };
  const out = {} as Record<AcquisitionFact, FactStatus>;
  for (const f of ACQUISITION_FACTS) {
    out[f] = has[f] ? "supplied" : CAPABLE[lead.provider].has(f) ? "not_supplied" : "not_applicable";
  }
  return out;
}

export const ACQUISITION_EVENT_TYPE = "lead.submitted";

/**
 * The receipt for one canonical lead. `accountScope` is the trusted connection's provider-side
 * reference (Page id / endpoint id) so provider ids are unique per connection. A lead with no
 * provider id is keyed by a NAMED fingerprint (form + UTC day + contact + answers), so a re-delivery
 * of the same submission still collapses.
 */
export function acquisitionReceipt(lead: AcquisitionLeadV1, accountScope: string): IntakeReceiptDraft {
  // Without a provider id (a plain website form), the receipt key is the CONTENT of the submission and
  // its UTC day — never the server's arrival time. A double-click, a browser resubmit or a network
  // retry of the same enquiry is then one receipt; the same person asking again tomorrow is a new one.
  const identity = lead.providerLeadId
    ? deriveEventIdentity({ providerEventId: lead.providerLeadId, accountScope })
    : deriveEventIdentity({
        fingerprint: [
          lead.context.formId ?? null,
          lead.submittedAt ? lead.submittedAt.slice(0, 10) : null,
          lead.contact.email?.toLowerCase() ?? null,
          lead.contact.phone?.replace(/\D/g, "") ?? null,
          lead.answers.map((a) => `${a.key}=${a.value}`).join("|") || null,
        ],
        accountScope,
      });
  const status = factStatus(lead);
  const metadata = {
    v: 1,
    provider: lead.provider,
    isTest: lead.isTest,
    ...(lead.platform ? { platform: lead.platform } : {}),
    ...(lead.context.formId ? { formId: lead.context.formId } : {}),
    ...(lead.context.campaignId ? { campaignId: lead.context.campaignId } : {}),
    ...(lead.context.adSetId ? { adSetId: lead.context.adSetId } : {}),
    ...(lead.context.adId ? { adId: lead.context.adId } : {}),
    ...(lead.context.sourceType ? { sourceType: lead.context.sourceType } : {}),
    ...(lead.context.adSetKind ? { adSetKind: lead.context.adSetKind } : {}),
    ...(lead.context.clickId ? { hasClickId: true } : {}),
    ...(lead.context.utm ? { utm: lead.context.utm } : {}),
    answerCount: lead.answers.length,
    facts: status,
  };
  const submitted = lead.submittedAt ? new Date(lead.submittedAt) : null;
  const plausible =
    submitted && submitted.getTime() <= Date.now() + 86_400_000 && submitted.getTime() >= Date.UTC(2000, 0, 1) ? submitted : null;
  return {
    family: "LEAD",
    eventType: ACQUISITION_EVENT_TYPE,
    externalEventId: identity.externalEventId,
    dedupeBasis: identity.dedupeBasis,
    providerAccountRef: null, // set by acceptIntake from the trusted connection
    occurredAt: plausible,
    payload: lead as unknown as Prisma.InputJsonValue,
    metadata: metadata as unknown as Prisma.InputJsonValue,
  };
}

function isLead(p: unknown): p is AcquisitionLeadV1 {
  if (!p || typeof p !== "object") return false;
  const x = p as Partial<AcquisitionLeadV1>;
  return x.v === 1 && typeof x.provider === "string" && (ACQUISITION_PROVIDERS as readonly string[]).includes(x.provider)
    && !!x.contact && typeof x.contact === "object" && Array.isArray(x.answers) && !!x.context && typeof x.context === "object";
}

/** The owner-readable summary of what the person asked for (personal; → Lead.intentSnapshot). */
export function leadIntentOf(lead: AcquisitionLeadV1): string | undefined {
  const lines = lead.answers.map((a) => `${a.label}: ${a.value}`);
  for (const c of lead.consent) lines.push(`${c.label}: ${c.given ? "✓" : "✗"}`);
  const text = lines.join("\n").trim();
  return text ? text.slice(0, 2000) : undefined;
}

/**
 * The ONE normalizer for every acquisition source. Pure. An explicit lead form → target "lead"
 * (M4 rule R4, executed by the core lead destination); a provider test submission → "none".
 */
export function normalizeAcquisitionLead(event: ClaimedIntakeEvent): NormalizeResult {
  const lead = event.payload;
  if (!isLead(lead)) return { ok: false, code: "malformed_payload" };
  const displayName =
    lead.contact.fullName ?? ([lead.contact.firstName, lead.contact.lastName].filter(Boolean).join(" ") || undefined);
  const contact = normalizeContactHints({
    phone: lead.contact.phone,
    email: lead.contact.email,
    displayName,
    companyName: lead.contact.company,
  });
  const ctx = lead.context;
  return {
    ok: true,
    normalized: {
      occurredAt: event.occurredAt,
      // A provider test submission ("Send test data") carries a dummy contact: nothing about it is a
      // person to resolve or keep, so no hints survive normalization (the payload is purged on IGNORED).
      contactHints: lead.isTest ? null : contact.hints,
      signals: contact.signals,
      // No deterministic contact rule at the provider: M4 identity decides (never a silent merge).
      identity: contact.hints && !lead.isTest ? "unresolved" : "none",
      attribution: sanitizeAttribution({
        channel: "lead_form",
        provider: lead.provider,
        source: lead.platform,
        form: ctx.formName,
        formId: ctx.formId,
        campaign: ctx.campaignName,
        campaignId: ctx.campaignId,
        adSet: ctx.adSetName,
        adSetId: ctx.adSetId,
        ad: ctx.adName,
        adId: ctx.adId,
        clickId: ctx.clickId,
        referralSourceType: ctx.sourceType,
        landingPage: ctx.landingUrl,
        referralSourceUrl: ctx.referrerUrl,
        utm: ctx.utm,
        firstTouchAt: lead.submittedAt ?? undefined,
      }),
      target: lead.isTest ? "none" : "lead",
      leadIntent: leadIntentOf(lead),
    },
  };
}
