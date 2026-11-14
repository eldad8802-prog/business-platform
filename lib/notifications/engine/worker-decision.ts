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

/** The error of an owed push closed because it was not created while the engine was ON for the business. */
export const PRE_CUTOVER = "pre_cutover";

/**
 * The business's engine activation record ("NotificationEngineActivation", migration 20261212090000 — owner decisions
 * 2026-11-13). Written ONLY when the engine's effective state for that business changes: by the database itself (a
 * trigger on the per-business override; a trigger on the global policy that fires only when globalEnabled /
 * emergencyDisabled really change) or by the worker's observation (notification_engine_observe — a business enabled
 * through the global policy alone). An admin edit of the global policy row that changes nobody's state writes nothing.
 *
 *   firstActivatedAt   the first moment the engine was effectively ON. STABLE: never moves again.
 *   lastActivatedAt    the start of the current (or last) ON period.
 *   lastDeactivatedAt  the end of the last ON period; null = never turned OFF since the first activation.
 *   priorActivatedAt   the start of the ON period lastDeactivatedAt ended (= firstActivatedAt until a re-activation).
 * Recorded OFF ⇔ lastDeactivatedAt ≥ lastActivatedAt.
 */
export type ActivationRecord = {
  firstActivatedAt: Date;
  lastActivatedAt: Date;
  priorActivatedAt: Date;
  lastDeactivatedAt: Date | null;
};

/** Does the record say the engine is ON right now? */
export function recordedOn(r: ActivationRecord): boolean {
  return r.lastDeactivatedAt === null || r.lastDeactivatedAt.getTime() < r.lastActivatedAt.getTime();
}

/**
 * THE CUTOVER RULE (owner decisions 2026-11-13). While the engine is ON, an owed push may be sent only if it was
 * created in the CURRENT ON period [lastActivatedAt, ∞) or in the ON period right before it
 * [priorActivatedAt, lastDeactivatedAt) — and, as always, before its TTL (effectiveExpiry). Consequences:
 *   - initial activation: nothing created before firstActivatedAt is ever pushed (historical rows stay, unsent);
 *   - OFF → ON (the business's switch, or the kill switch lifted): nothing created while OFF is ever pushed — no
 *     wave; a push the last ON period deferred to the end of quiet hours survives ONE toggle and is delivered then
 *     if still inside its TTL; anything from an older ON period is dropped (two toggles back is history);
 *   - an edit of the global policy that does not change the business's effective state moves nothing, so a quiet-
 *     hours deferral is never lost to it;
 *   - engine enabled globally (no override): firstActivatedAt is the first moment the worker sees it ON for the
 *     business; later policy edits do not move it.
 * Why one previous period and not "every ON period ever": the record keeps exactly two recorded transitions around
 * the carried period, which is what proves a carried row was created while ON; with any coarser memory an
 * OFF-period row could slip through. Losing a two-toggles-old deferral is the safe side of that trade.
 */
export function pushableCreatedAt(createdAt: Date, r: ActivationRecord): boolean {
  if (!recordedOn(r)) return false;
  const t = createdAt.getTime();
  if (t >= r.lastActivatedAt.getTime()) return true;
  return r.lastDeactivatedAt !== null && t >= r.priorActivatedAt.getTime() && t < r.lastDeactivatedAt.getTime();
}

/**
 * What the database records when the engine is seen ON / OFF at `at` (notification_engine_record, migration
 * 20261212090000), mirrored for the read-only dry run: a first activation; OFF → ON lands strictly after the recorded
 * deactivation and makes the period that deactivation ended the "prior" one; ON → OFF at or after the activation.
 */
export function projectActivation(r: ActivationRecord | null, on: boolean, at: Date): ActivationRecord | null {
  if (r === null) return on ? { firstActivatedAt: at, lastActivatedAt: at, priorActivatedAt: at, lastDeactivatedAt: null } : null;
  if (!recordedOn(r)) {
    if (!on) return r;
    const t = Math.max(at.getTime(), r.lastDeactivatedAt!.getTime() + 1);
    return { ...r, priorActivatedAt: r.lastActivatedAt, lastActivatedAt: new Date(t) };
  }
  if (on) return r;
  return { ...r, lastDeactivatedAt: new Date(Math.max(at.getTime(), r.lastActivatedAt.getTime())) };
}

/**
 * The activation as the worker uses it: the record (after its observation) when the engine is ON and the record
 * agrees; otherwise "unavailable" — the table missing (code deployed before migration 20261212090000), a read error,
 * or a record that still says OFF — and the worker HOLDS every owed row (no claim, no send, TTL expiry only): never a
 * wave, never a crash, and nothing closed that a later, readable record could still allow.
 */
export type ActivationState = { kind: "on"; record: ActivationRecord } | { kind: "unavailable" };

export function activationState(engineOn: boolean, r: ActivationRecord | null): ActivationState {
  if (!engineOn || r === null || !recordedOn(r)) return { kind: "unavailable" };
  return { kind: "on", record: r };
}

export type ActivationCounts = { owed: number; wouldExpirePreCutover: number; wouldExpireTtl: number; wouldProceed: number; wouldHold: number };

/**
 * The dry run's arithmetic: what the worker would do at `now` with these owed rows under this activation record
 * (null, or a record that says OFF ⇒ unavailable ⇒ every row held).
 */
export function classifyOwedForActivation(
  rows: readonly { createdAt: Date; expiresAt: Date | null; category: CategoryDefinition | null }[],
  activation: ActivationRecord | null,
  now: Date,
): ActivationCounts {
  const out: ActivationCounts = { owed: rows.length, wouldExpirePreCutover: 0, wouldExpireTtl: 0, wouldProceed: 0, wouldHold: 0 };
  for (const r of rows) {
    if (activation === null || !recordedOn(activation)) out.wouldHold += 1;
    else if (!pushableCreatedAt(r.createdAt, activation)) out.wouldExpirePreCutover += 1;
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
