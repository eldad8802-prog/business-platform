/**
 * Server-side enforcement of a business's platform features — subscriptions phase 1. SERVER-ONLY.
 *
 * Eleven core features (documents, billing, inbox, inventory, content, pricing, revenue, gmail_import, whatsapp,
 * starter_bot, reports) were enforced only by the interface: a module the business could not see was still answered
 * by its API. This module is the one place their routes, webhooks and background steps ask "may this business use
 * feature X?". The answer is the SAME resolver the interface already reads (resolve-feature-access.ts, exposed by
 * GET /api/business/capabilities) — this file adds no rule of its own, no plan, no subscription, no FREE_LIMITED.
 *
 * MODES — env FEATURE_ACCESS_ENFORCEMENT:
 *   off     — not consulted at all; no database work, no log.
 *   shadow  — DEFAULT (unset or any unknown value). Resolves and LOGS every request that enforce would refuse
 *             (`feature_access_would_deny`), and lets it through. Behaviour is unchanged; the log tells, before
 *             anyone switches to enforce, exactly which businesses and routes enforce would affect.
 *   enforce — refuses: 403 { error: "FEATURE_NOT_AVAILABLE", feature }. Switching to it is an owner decision.
 *
 * Why shadow is the default: the per-business overrides and global policies that exist in Production were not read
 * for this change (that needs an owner-approved read-only check). A business whose module is switched off by an
 * override still reaches it through other surfaces today; enforcing blindly could change what it can do. Shadow
 * removes the guesswork without changing anything.
 *
 * Never throws. An unauthenticated request passes through untouched — the route's own auth answers 401 as before.
 * Errors resolving access: shadow lets the request through (and logs); enforce fails closed, like every other gate
 * in this codebase (tasks-http, appointments-http, service-desk-gate).
 */
import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";

import { PLATFORM_FEATURE_KEYS, type PlatformFeatureKey } from "./platform-feature-catalog";
import { resolveBusinessCapabilities } from "./resolve-feature-access";
import type { FeatureAccessResult } from "./feature-access.types";

/** The eleven features this guard covers. Other keys already have their own server gates. */
export const GUARDED_FEATURE_KEYS = [
  PLATFORM_FEATURE_KEYS.DOCUMENTS,
  PLATFORM_FEATURE_KEYS.BILLING,
  PLATFORM_FEATURE_KEYS.INBOX,
  PLATFORM_FEATURE_KEYS.INVENTORY,
  PLATFORM_FEATURE_KEYS.CONTENT,
  PLATFORM_FEATURE_KEYS.PRICING,
  PLATFORM_FEATURE_KEYS.REVENUE,
  PLATFORM_FEATURE_KEYS.GMAIL_IMPORT,
  PLATFORM_FEATURE_KEYS.WHATSAPP,
  PLATFORM_FEATURE_KEYS.STARTER_BOT,
  PLATFORM_FEATURE_KEYS.REPORTS,
] as const;

export type GuardedFeatureKey = (typeof GUARDED_FEATURE_KEYS)[number];

export type FeatureEnforcementMode = "off" | "shadow" | "enforce";

export const FEATURE_ACCESS_ENFORCEMENT_ENV = "FEATURE_ACCESS_ENFORCEMENT";
export const FEATURE_NOT_AVAILABLE = "FEATURE_NOT_AVAILABLE";

/** Unset, empty or unknown ⇒ shadow. Only the exact words "off" / "enforce" change it. */
export function featureEnforcementMode(env: Record<string, string | undefined> = process.env): FeatureEnforcementMode {
  const raw = (env[FEATURE_ACCESS_ENFORCEMENT_ENV] ?? "").trim().toLowerCase();
  if (raw === "off") return "off";
  if (raw === "enforce") return "enforce";
  return "shadow";
}

export type GuardDecision = "allow" | "log" | "deny";

/**
 * The whole policy of this file, pure. `allowed` is the resolver's answer, or null when it could not be obtained.
 *   allowed            → allow (every mode)
 *   not allowed/error  → shadow: log ; enforce: deny ; off: never asked.
 */
export function decideGuard(mode: FeatureEnforcementMode, allowed: boolean | null): GuardDecision {
  if (mode === "off") return "allow";
  if (allowed === true) return "allow";
  return mode === "enforce" ? "deny" : "log";
}

/* ---------------- resolution, with a short per-instance cache ---------------- */

type Resolved = Record<PlatformFeatureKey, FeatureAccessResult>;
type Resolver = (businessId: number) => Promise<Resolved>;

const CACHE_TTL_MS = 30_000;
const CACHE_MAX = 500;
const cache = new Map<number, { at: number; value: Resolved }>();

const defaultResolver: Resolver = (businessId) =>
  runWithTenantContext({ businessId }, () => resolveBusinessCapabilities(businessId));

let resolver: Resolver = defaultResolver;

type SessionBusiness = (req: Request) => Promise<number | null>;
const defaultSessionBusiness: SessionBusiness = async (req) => (await getCurrentUser(req))?.businessId ?? null;
let sessionBusiness: SessionBusiness = defaultSessionBusiness;

/** Tests only: replace the resolver (and clear the cache). Pass null to restore the real one. */
export function __setFeatureGuardResolverForTests(next: Resolver | null): void {
  resolver = next ?? defaultResolver;
  cache.clear();
}

/** Tests only: replace the session lookup. Pass null to restore the real one (getCurrentUser). */
export function __setFeatureGuardSessionForTests(next: SessionBusiness | null): void {
  sessionBusiness = next ?? defaultSessionBusiness;
}

async function featureAllowed(businessId: number, key: GuardedFeatureKey): Promise<{ allowed: boolean | null; reasonCode: string }> {
  try {
    const now = Date.now();
    let hit = cache.get(businessId);
    if (!hit || now - hit.at > CACHE_TTL_MS) {
      hit = { at: now, value: await resolver(businessId) };
      if (cache.size >= CACHE_MAX) cache.clear();
      cache.set(businessId, hit);
    }
    const r = hit.value[key];
    return { allowed: r?.allowed === true, reasonCode: r?.reasonCode ?? "UNKNOWN" };
  } catch {
    return { allowed: null, reasonCode: "RESOLVE_FAILED" };
  }
}

function logWouldDeny(key: GuardedFeatureKey, site: string, businessId: number, reasonCode: string, mode: FeatureEnforcementMode): void {
  console.warn(
    JSON.stringify({
      event: mode === "enforce" ? "feature_access_denied" : "feature_access_would_deny",
      featureKey: key,
      site,
      businessId,
      reasonCode,
    }),
  );
}

/* ---------------- the two entry points ---------------- */

/**
 * For a background step, webhook or service that already knows the business: may it run this feature's work?
 * shadow / off ⇒ always true (shadow logs what enforce would skip). enforce ⇒ the resolver's answer, fail-closed.
 */
export async function featureAllowedForBusiness(businessId: number, key: GuardedFeatureKey, site: string): Promise<boolean> {
  const mode = featureEnforcementMode();
  if (mode === "off") return true;
  const { allowed, reasonCode } = await featureAllowed(businessId, key);
  const decision = decideGuard(mode, allowed);
  if (decision !== "allow") logWouldDeny(key, site, businessId, reasonCode, mode);
  return decision !== "deny";
}

/**
 * For an owner API route: call FIRST in the handler —
 *     const featureDenied = await guardFeature(req, PLATFORM_FEATURE_KEYS.X);
 *     if (featureDenied) return featureDenied;
 * Returns null to continue, or the refusal to return. Never throws.
 */
export async function guardFeature(req: Request, key: GuardedFeatureKey): Promise<NextResponse | null> {
  const mode = featureEnforcementMode();
  if (mode === "off") return null;
  let businessId: number | null = null;
  try {
    businessId = await sessionBusiness(req);
  } catch {
    businessId = null;
  }
  // No session: not this guard's call — the route's own auth answers exactly as it did before.
  if (!businessId) return null;

  const { allowed, reasonCode } = await featureAllowed(businessId, key);
  const decision = decideGuard(mode, allowed);
  if (decision === "allow") return null;
  let site = "route";
  try {
    site = new URL(req.url).pathname;
  } catch {
    /* keep "route" */
  }
  logWouldDeny(key, site, businessId, reasonCode, mode);
  if (decision === "log") return null;
  return NextResponse.json(
    { error: FEATURE_NOT_AVAILABLE, feature: key },
    { status: 403, headers: { "Cache-Control": "no-store" } },
  );
}
