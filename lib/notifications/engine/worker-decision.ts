/**
 * The push worker's decisions — PURE (notifications track spec, 2026-11-12). The worker gathers the facts inside
 * the business's tenant transaction and asks these functions what to do; nothing here reads a database or a clock.
 */
import type { CategoryDefinition } from "../catalog";
import type { EffectiveCategory } from "../preferences";
import { quietUntil, type QuietHours } from "../notification-time";

/* ───────────────────────────────────────────────────────────── expiry ── */

/**
 * When an owed push stops being worth sending. Rows the engine writes carry expiresAt; rows written BEFORE it
 * existed (the snapshot writer's historical PENDING pushes) do not — they expire `ttlMinutes` after creation, so
 * enabling the engine can never flood a phone with old news. Unknown category: 60 minutes.
 */
export function effectiveExpiry(row: { expiresAt: Date | null; createdAt: Date }, cat: CategoryDefinition | null): Date {
  if (row.expiresAt) return row.expiresAt;
  return new Date(row.createdAt.getTime() + (cat?.ttlMinutes ?? 60) * 60_000);
}

/* ──────────────────────────────────────────────── clean-start cutover ── */

/** The error of an owed push closed because it was created before the business's engine activation moment. */
export const PRE_CUTOVER = "pre_cutover";

/**
 * The cutover rule (owner decision 2026-11-13: when the engine is enabled, NO push for an event created before that
 * moment). The engine can be ON for a business only through its BusinessFeatureAccess override (state ENABLED — the
 * catalog default is OFF, so the global policy alone cannot turn it on), written by the platform admin's
 * feature-access mutation, which refuses a no-op and stamps `updatedAt` (Prisma @updatedAt) on every state change.
 * So the latest OFF→ON moment is that row's updatedAt. The global policy row's updatedAt is folded in too: lifting
 * the emergency kill switch is also an OFF→ON moment for every business. The later of the two wins — which can only
 * move the cutover FORWARD (fewer pushes, never more): nothing created while the engine was OFF is pushed later.
 */
export function cutoverFrom(input: { override: { updatedAt: Date } | null; policy: { updatedAt: Date } | null }): Date | null {
  const times = [input.override?.updatedAt, input.policy?.updatedAt].filter((d): d is Date => d instanceof Date);
  if (times.length === 0) return null;
  return new Date(Math.max(...times.map((d) => d.getTime())));
}

/** Was this owed row created before the engine's activation moment? (null moment = no cutover, TTL only.) */
export function isPreCutover(createdAt: Date, cutoverAt: Date | null): boolean {
  return cutoverAt !== null && createdAt.getTime() < cutoverAt.getTime();
}

export type ActivationCounts = { owed: number; wouldExpirePreCutover: number; wouldExpireTtl: number; wouldProceed: number };

/** The dry run's arithmetic: what an activation at `activationAt` would do with these owed rows at `now`. */
export function classifyOwedForActivation(
  rows: readonly { createdAt: Date; expiresAt: Date | null; category: CategoryDefinition | null }[],
  activationAt: Date | null,
  now: Date,
): ActivationCounts {
  const out: ActivationCounts = { owed: rows.length, wouldExpirePreCutover: 0, wouldExpireTtl: 0, wouldProceed: 0 };
  for (const r of rows) {
    if (isPreCutover(r.createdAt, activationAt)) out.wouldExpirePreCutover += 1;
    else if (effectiveExpiry(r, r.category).getTime() <= now.getTime()) out.wouldExpireTtl += 1;
    else out.wouldProceed += 1;
  }
  return out;
}

/* ──────────────────────────────────────────────────────── digest window ── */

export const DIGEST_FIRST_WINDOW_MS = 24 * 3_600_000;
export const DIGEST_MAX_WINDOW_MS = 7 * 24 * 3_600_000;

/**
 * Where a user's digest window starts (owner decision 2026-11-13: an item is in exactly ONE digest per user — the
 * first after it (re)surfaced): right after that user's previous ACTUAL digest (a day with nothing to report wrote
 * none, so nothing is lost), never more than 7 days back; the first digest ever looks back 24 hours.
 */
export function digestWindowStart(now: Date, previousDigestAt: Date | null): Date {
  if (previousDigestAt === null) return new Date(now.getTime() - DIGEST_FIRST_WINDOW_MS);
  return new Date(Math.max(previousDigestAt.getTime(), now.getTime() - DIGEST_MAX_WINDOW_MS));
}

/**
 * Does a push row speak for THIS surfacing of an item? Only a row written at or after it last surfaced — a push sent
 * (or held back) for an earlier life of a reopened item says nothing about the new one.
 */
export function forThisSurfacing(rowAt: Date | null, lastSurfacedAt: Date): boolean {
  return rowAt !== null && rowAt.getTime() >= lastSurfacedAt.getTime();
}

/* ───────────────────────────────────────────────────────── rate limit ── */

export const RATE_LIMIT = { perHour: 4, perDay: 15 } as const;

/**
 * The per-user push rate limit: at most 4 pushes in the last hour and 15 in the last 24 hours, counted from the
 * user's SENT pushes of non-exempt categories (one per notification, however many devices it reached).
 */
export function rateLimited(sentAt: readonly Date[], now: Date, limit: { perHour: number; perDay: number } = RATE_LIMIT): boolean {
  const t = now.getTime();
  const lastHour = sentAt.filter((d) => t - d.getTime() < 3_600_000 && d.getTime() <= t).length;
  const lastDay = sentAt.filter((d) => t - d.getTime() < 86_400_000 && d.getTime() <= t).length;
  return lastHour >= limit.perHour || lastDay >= limit.perDay;
}

/* ──────────────────────────────────────────────────────── the decision ── */

export type OwedDecision =
  | { kind: "send" }
  | { kind: "suppress"; reason: "resolved" | "unknown_category" | "feature_off" | "pref_off" | "to_digest" | "quiet" | "rate_limited" }
  | { kind: "expire" }
  | { kind: "defer"; until: Date; reason: "quiet" };

export type OwedFacts = {
  now: Date;
  notification: { resolvedAt: Date | null; dismissedAt: Date | null };
  expiresAt: Date;
  /** null = UNKNOWN category. */
  category: CategoryDefinition | null;
  /** The user's effective view of the category (feature availability folded in as `available`). */
  effective: EffectiveCategory;
  quiet: QuietHours;
  timeZone: string;
  /** SENT pushes of non-exempt categories to this user in the last 24 hours. */
  recentSends: readonly Date[];
};

/**
 * One owed push for one user, in the spec's order: resolved / dismissed → expired → unknown → feature → preference
 * → digest mode → quiet hours (defer to their end, unless the category bypasses them; a quiet end past the expiry
 * means the push is held for the digest) → per-user rate limit (held for the digest) → send.
 */
export function decideOwed(f: OwedFacts): OwedDecision {
  if (f.notification.resolvedAt !== null || f.notification.dismissedAt !== null) return { kind: "suppress", reason: "resolved" };
  if (f.expiresAt.getTime() <= f.now.getTime()) return { kind: "expire" };
  if (f.category === null) return { kind: "suppress", reason: "unknown_category" };
  if (!f.effective.available) return { kind: "suppress", reason: "feature_off" };
  if (!f.effective.push) return { kind: "suppress", reason: "pref_off" };
  if (f.effective.delivery === "digest") return { kind: "suppress", reason: "to_digest" };
  if (!f.effective.quietBypass) {
    const until = quietUntil(f.now, f.timeZone, f.quiet);
    if (until !== null) {
      if (until.getTime() >= f.expiresAt.getTime()) return { kind: "suppress", reason: "quiet" };
      return { kind: "defer", until, reason: "quiet" };
    }
  }
  if (!f.effective.rateExempt && rateLimited(f.recentSends, f.now)) return { kind: "suppress", reason: "rate_limited" };
  return { kind: "send" };
}

/* ───────────────────────────────────────────────────────────── retries ── */

export const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

/**
 * After a transient failure: `attempts` is the count INCLUDING this one. Up to 4 retries (1 m, 5 m, 15 m, 1 h);
 * the 5th failure ends it.
 */
export function retryAfter(attempts: number, now: Date): Date | null {
  if (attempts >= MAX_ATTEMPTS) return null;
  return new Date(now.getTime() + BACKOFF_MS[Math.max(0, Math.min(attempts - 1, BACKOFF_MS.length - 1))]);
}

/* ──────────────────────────────────────────────────────────── devices ── */

export type DeviceRow = { id: number; provider: string; authSessionId: string | null };

/**
 * Which of the user's live devices may be pushed to: an FCM device only with a LIVE login session; a web push
 * device bound to a session only while it is live; a legacy web push device with no session (subscribed before
 * the engine) is allowed — its own revocation is the guarantee. A provider this deployment has no configuration
 * for is skipped.
 */
export function eligibleDevices<T extends DeviceRow>(devices: readonly T[], liveSessions: ReadonlySet<string>, configured: (provider: string) => boolean): T[] {
  return devices.filter((d) => {
    if (!configured(d.provider)) return false;
    if (d.provider === "FCM") return d.authSessionId !== null && liveSessions.has(d.authSessionId);
    if (d.provider === "WEB_PUSH") return d.authSessionId === null || liveSessions.has(d.authSessionId);
    return false;
  });
}
