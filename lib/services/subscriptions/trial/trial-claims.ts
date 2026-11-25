/**
 * Trial claims — duplicate-trial prevention at signup (subscriptions stage C, decisions 13 / 16 / 28). SERVER-ONLY.
 *
 * Signup already collects, on both paths (email + password, Google), the business's tax id (required, nine digits),
 * the login email, the business phone (required, NOT verified) and — on the Google path — the Google subject. Nothing
 * new is asked and the signup form does not change. From those values this module derives keyed digests
 * (HMAC-SHA-256 with a server-held key, never a plain hash — a nine-digit tax id would be trivially reversible), and
 * the auth plane's definer function subscription_signup_open (migration 20261228090000), INSIDE the account
 * transaction, either opens a 30-day trial or, when a TAX_ID, EMAIL or GOOGLE_SUB digest already had a trial, opens
 * the business as a customer WITHOUT a trial. A PHONE match alone is a hint for the admin, never a refusal (the phone
 * is not verified). The signup itself is never refused.
 *
 * SWITCH — env SUBSCRIPTION_TRIALS_ENABLED must be exactly "true", and TRIAL_CLAIM_HMAC_KEY must hold at least 32
 * characters. Otherwise NOTHING is written: the new business has no subscription record and is computed as a tester
 * (today's access; decision 16 — interim signups become testers until trials are switched on).
 * TRIAL_CLAIM_KEY_VERSION (default 1) names the key; a rotated key starts a new claim space (documented trade-off).
 */
import { createHmac } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { PLAN_CATALOG_VERSION } from "../plan-catalog";

export const TRIAL_DAYS = 30;
export const SUBSCRIPTION_TRIALS_ENABLED_ENV = "SUBSCRIPTION_TRIALS_ENABLED";
export const TRIAL_CLAIM_HMAC_KEY_ENV = "TRIAL_CLAIM_HMAC_KEY";
export const TRIAL_CLAIM_KEY_VERSION_ENV = "TRIAL_CLAIM_KEY_VERSION";

export type TrialClaimKind = "TAX_ID" | "EMAIL" | "GOOGLE_SUB" | "PHONE";
export type TrialClaim = { kind: TrialClaimKind; digest: string };

export type TrialIdentity = {
  taxId?: string | null;
  email?: string | null;
  googleSubject?: string | null;
  phone?: string | null;
};

export type TrialConfig = { key: string; keyVersion: number } | null;

/** null = trials are off (nothing is written). */
export function trialConfig(env: Record<string, string | undefined> = process.env): TrialConfig {
  if ((env[SUBSCRIPTION_TRIALS_ENABLED_ENV] ?? "").trim() !== "true") return null;
  const key = env[TRIAL_CLAIM_HMAC_KEY_ENV] ?? "";
  if (key.length < 32) return null;
  const v = Number.parseInt((env[TRIAL_CLAIM_KEY_VERSION_ENV] ?? "1").trim(), 10);
  return { key, keyVersion: Number.isInteger(v) && v >= 1 && v <= 1000 ? v : 1 };
}

/** Pure normalisation, so the same identity always yields the same digest. */
export function normalizeTrialValue(kind: TrialClaimKind, raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  switch (kind) {
    case "TAX_ID": {
      const d = v.replace(/\D/g, "");
      return d.length >= 5 && d.length <= 9 ? d.padStart(9, "0") : null;
    }
    case "EMAIL": {
      const e = v.toLowerCase();
      const at = e.lastIndexOf("@");
      if (at <= 0) return null;
      let local = e.slice(0, at);
      const domain = e.slice(at + 1);
      // A "+tag" alias is the same mailbox; Gmail also ignores dots — the cheapest ways to open a second trial.
      local = local.split("+")[0];
      if (domain === "gmail.com" || domain === "googlemail.com") return `${local.replace(/\./g, "")}@gmail.com`;
      return `${local}@${domain}`;
    }
    case "GOOGLE_SUB":
      return v;
    case "PHONE": {
      let d = v.replace(/\D/g, "");
      if (d.startsWith("972")) d = `0${d.slice(3)}`;
      return d.length >= 9 ? d : null;
    }
  }
}

export function trialClaimDigest(key: string, kind: TrialClaimKind, normalized: string): string {
  return createHmac("sha256", key).update(`${kind}:${normalized}`).digest("hex");
}

/** Pure: the claims of an identity (distinct kinds, normalised, keyed). */
export function trialClaimsFor(identity: TrialIdentity, key: string): TrialClaim[] {
  const out: TrialClaim[] = [];
  const add = (kind: TrialClaimKind, raw: string | null | undefined) => {
    if (!raw) return;
    const n = normalizeTrialValue(kind, raw);
    if (n) out.push({ kind, digest: trialClaimDigest(key, kind, n) });
  };
  add("TAX_ID", identity.taxId);
  add("EMAIL", identity.email);
  add("GOOGLE_SUB", identity.googleSubject);
  add("PHONE", identity.phone);
  return out;
}

export type SignupSubscriptionOutcome = "TRIAL_OPENED" | "TRIAL_OPENED_PHONE_HINT" | "DUPLICATE_NO_TRIAL" | "TRIALS_OFF" | "NO_IDENTITY";

/**
 * Inside the signup transaction (auth plane). Trials off, or no usable identity ⇒ nothing written. On: the database
 * decides atomically with the account; an error rolls the signup back like any other step of it (the function only
 * refuses states a brand-new business cannot be in).
 */
export async function openSignupSubscriptionInAccountTx(
  tx: Prisma.TransactionClient,
  businessId: number,
  identity: TrialIdentity,
  config: TrialConfig = trialConfig(),
): Promise<SignupSubscriptionOutcome> {
  if (!config) return "TRIALS_OFF";
  const claims = trialClaimsFor(identity, config.key);
  if (claims.length === 0) return "NO_IDENTITY";
  const rows = await tx.$queryRaw<{ outcome: string }[]>`
    SELECT public.subscription_signup_open(${businessId}::integer, ${JSON.stringify(claims)}::jsonb, ${config.keyVersion}::integer,
                                           ${TRIAL_DAYS}::integer, ${PLAN_CATALOG_VERSION}::text) AS outcome`;
  const outcome = rows[0]?.outcome;
  console.info(JSON.stringify({ event: "subscription_signup_opened", businessId, outcome }));
  return outcome === "TRIAL_OPENED" || outcome === "TRIAL_OPENED_PHONE_HINT" || outcome === "DUPLICATE_NO_TRIAL" ? outcome : "TRIAL_OPENED";
}
