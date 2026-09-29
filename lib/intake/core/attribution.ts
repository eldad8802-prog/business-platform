/**
 * Business Intake · attribution preservation (M3 keeps it; M8 analyses it).
 *
 * Acquisition evidence is only valuable if it survives ingestion. Every source
 * maps what it truly knows into {@link IntakeAttributionV1}; this module makes
 * the result safe to retain indefinitely:
 *
 *   - URLs keep origin + path only, plus utm_* parameters lifted into `utm`.
 *     Query strings and fragments are dropped: they routinely carry emails,
 *     phone numbers, tokens and session ids.
 *   - Values are trimmed, stripped of control characters and bounded.
 *   - Unknown keys are dropped (the shape is a contract, not a JSON bag).
 *   - An attribution with nothing left in it is null, not `{ v: 1 }`.
 */

import type { IntakeAttributionV1 } from "./contract";

const MAX = 200;
const UTM_KEYS = ["source", "medium", "campaign", "content", "term"] as const;
const STRING_KEYS = [
  "channel",
  "source",
  "provider",
  "campaign",
  "campaignId",
  "adSet",
  "adSetId",
  "ad",
  "adId",
  "form",
  "formId",
  "clickId",
  "referralSourceType",
  "headline",
] as const;

function clean(value: unknown, max = MAX): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const s = String(value).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : undefined;
}

/**
 * origin + path of an http(s) URL; utm_* parameters returned separately.
 * Anything else (mailto:, javascript:, unparsable) yields nothing.
 */
export function sanitizeUrl(raw: unknown): { url?: string; utm: IntakeAttributionV1["utm"] } {
  const s = clean(raw, 2048);
  if (!s) return { utm: undefined };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { utm: undefined };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { utm: undefined };
  const utm: NonNullable<IntakeAttributionV1["utm"]> = {};
  for (const k of UTM_KEYS) {
    const v = clean(u.searchParams.get(`utm_${k}`));
    if (v) utm[k] = v;
  }
  return {
    url: `${u.origin}${u.pathname}`.slice(0, 512),
    utm: Object.keys(utm).length ? utm : undefined,
  };
}

function isoOrUndefined(value: unknown): string | undefined {
  if (!(value instanceof Date) && typeof value !== "string") return undefined;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * Build a retained attribution from an adapter's mapping. Accepts loosely typed
 * input (adapters map provider fields in) and returns only the contract shape.
 */
export function sanitizeAttribution(input: Record<string, unknown> | null | undefined): IntakeAttributionV1 | null {
  if (!input || typeof input !== "object") return null;
  const out: IntakeAttributionV1 = { v: 1 };
  for (const k of STRING_KEYS) {
    const v = clean(input[k]);
    if (v) out[k] = v;
  }
  const landing = sanitizeUrl(input.landingPage);
  if (landing.url) out.landingPage = landing.url;
  const referral = sanitizeUrl(input.referralSourceUrl);
  if (referral.url) out.referralSourceUrl = referral.url;

  const utm: NonNullable<IntakeAttributionV1["utm"]> = { ...(landing.utm ?? {}) };
  const given = input.utm && typeof input.utm === "object" ? (input.utm as Record<string, unknown>) : {};
  for (const k of UTM_KEYS) {
    const v = clean(given[k]);
    if (v) utm[k] = v; // explicit values win over ones parsed from the URL
  }
  if (Object.keys(utm).length) out.utm = utm;

  const firstTouch = isoOrUndefined(input.firstTouchAt);
  if (firstTouch) out.firstTouchAt = firstTouch;

  return Object.keys(out).length > 1 ? out : null;
}
