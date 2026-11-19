/**
 * The push worker — runPushWorker(now) (notifications track spec, 2026-11-12). SERVER-ONLY.
 *
 * Sends the OWED pushes (NotificationDelivery: channel PUSH, status PENDING, no subscriptionId) that
 * notification_push_due() lists — identifiers only, across live businesses — each inside its own business's tenant
 * transaction:
 *
 *   0. Kill switch: unless `notifications_engine` is ON for the business nothing is claimed or sent. Its owed rows
 *      are only kept from clogging the queue: past their TTL → FAILED 'expired'; otherwise re-checked later.
 *   1. CLAIM: a conditional UPDATE sets leaseUntil = now + 2 min while the row is PENDING, due and not leased — one
 *      winner among concurrent workers; a crashed attempt becomes retryable when its lease runs out.
 *  0b. Activation (owner decisions 2026-11-13): the business's activation record ("NotificationEngineActivation",
 *      migration 20261212090000) after the worker's observation (activation.ts observeActivation — records the first
 *      moment it sees the engine ON for a business enabled through the global policy alone; transitions of the
 *      override and of the kill switch are recorded by the database triggers). The record unreadable (table missing:
 *      code deployed before the migration) or still OFF ⇒ the business's owed rows are HELD like engine OFF
 *      (activationUnavailable): never a wave, never a crash.
 *  1b. Clean start: an owed row the rule does not allow (worker-decision.ts pushableCreatedAt — created before the
 *      first activation, while the engine was OFF, or in an ON period older than the previous one) is closed FAILED
 *      'pre_cutover', never sent. A global policy edit that changes no business's effective state moves nothing, so a
 *      quiet-hours deferral is never lost to it; one deferred in the previous ON period survives an OFF → ON.
 *      Historical rows stay (the notification center still shows them); nothing is deleted. cutoverDryRun() reports,
 *      read-only, per business what the worker would close vs send.
 *   2. userId NULL (the whole business) ⇒ FAN OUT: one owed row per recipient user (recipients.ts), the original
 *      SUPPRESSED 'fanned_out'.
 *   3. Per user: resolved / dismissed ⇒ SUPPRESSED 'resolved'; past expiry ⇒ FAILED 'expired' (rows written before
 *      the engine have no expiresAt and expire their category's TTL after creation — never a flood); category
 *      feature unavailable ⇒ 'feature_off'; preferences say no push ⇒ 'pref_off'; digest mode ⇒ 'to_digest';
 *      quiet hours (no bypass) ⇒ nextAttemptAt = their end (or 'quiet' when that is past the expiry); per-user rate
 *      limit ⇒ 'rate_limited'.
 *   4. Devices: the user's live subscriptions; FCM needs a LIVE login session (auth_sessions_live), web push bound
 *      to a session needs it live, legacy web push with no session is allowed; providers without configuration are
 *      skipped.
 *   5. Send (unified sender), OUTSIDE any transaction; then one SENT / FAILED row per device (subscriptionId,
 *      userId). Gone ⇒ the subscription is revoked ('gone'). Transient ⇒ attempts + 1 and a backoff (1 m, 5 m,
 *      15 m, 1 h; the 5th failure ends it); only devices not yet done are tried again. Done ⇒ completedAt.
 *
 * Counts only in the report and the log ("[notifications] worker …"): no ids of people, no tokens, no text.
 * An "unhealthy" line when the oldest owed push waited more than 30 minutes past its due time, or failures spike.
 */
import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { tenantTx } from "@/lib/tenant/tenant-tx";

import { categoryMayPush, classifyNotification, type CategoryDefinition } from "../catalog";
import { effectiveSettings, resolveCategory } from "../preferences";
import { businessTimeZone, readUserPreferences } from "../preferences-store";
import { buildPushMessage } from "../push/push-content";
import { providerConfigured, sendToDevice, type SenderDeps } from "../push/push-sender";
import type { PushResult } from "../push/push-types";
import { observeActivation } from "./activation";
import { businessGates, type BusinessGates } from "./engine-gate";
import { recipientUsers } from "./recipients";
import {
  PRE_CUTOVER, decideOwed, effectiveExpiry, eligibleDevices, pushableCreatedAt, retryAfter,
  type ActivationRecord, type ActivationState,
} from "./worker-decision";

type Tx = Prisma.TransactionClient;

export const LEASE_MS = 2 * 60_000;
export const ENGINE_OFF_RECHECK_MS = 30 * 60_000;
export const UNHEALTHY_AGE_SECONDS = 30 * 60;
export { PRE_CUTOVER, pushableCreatedAt };

/**
 * The monitoring view of a pass (counts only): the unhealthy signal and what it rests on, plus the rows closed
 * without a send — expired (past TTL) and pre_cutover (created before activation) — so an activation's backlog
 * closing is visible next to the health line, never mistaken for failures.
 */
export function workerHealth(r: WorkerReport) {
  return {
    unhealthy: r.unhealthy, oldestOwedAgeSeconds: r.oldestOwedAgeSeconds, devicesSent: r.devicesSent, devicesFailed: r.devicesFailed,
    failed: r.failed, expired: r.expired, preCutover: r.preCutover, engineOff: r.engineOff, activationUnavailable: r.activationUnavailable,
    errors: r.errors,
  };
}
const BATCH = 100;
const MAX_DEVICES = 20;

export type WorkerReport = {
  owed: number;
  claimed: number;
  fannedOut: number;
  sent: number;
  failed: number;
  suppressed: number;
  expired: number;
  deferred: number;
  retried: number;
  engineOff: number;
  /** Owed pushes the activation rule does not allow (pushableCreatedAt), closed FAILED 'pre_cutover' (never sent). */
  preCutover: number;
  /** Owed pushes held because the business's activation record could not be read / still says OFF (fail safe). */
  activationUnavailable: number;
  errors: number;
  devicesSent: number;
  devicesFailed: number;
  devicesRevoked: number;
  /** How long past its due time the most overdue owed push this pass handled had waited (engine ON only). */
  oldestOwedAgeSeconds: number;
  unhealthy: boolean;
};

export type WorkerOptions = {
  limit?: number;
  /** Only this business (the after() trigger, the test push). */
  businessId?: number;
  /** Only these owed rows of `businessId` (the test push). */
  deliveryIds?: number[];
  deps?: SenderDeps;
  /** Test seam: the gates of a business. */
  gates?: (businessId: number) => Promise<BusinessGates>;
  /** Test seam: the activation observation of a business (default: activation.ts observeActivation). */
  activation?: (businessId: number, engineOn: boolean, now: Date) => Promise<ActivationState>;
  /** Silence the log line (tests). */
  quiet?: boolean;
};

const emptyReport = (): WorkerReport => ({
  owed: 0, claimed: 0, fannedOut: 0, sent: 0, failed: 0, suppressed: 0, expired: 0, deferred: 0, retried: 0,
  engineOff: 0, preCutover: 0, activationUnavailable: 0, errors: 0, devicesSent: 0, devicesFailed: 0, devicesRevoked: 0, oldestOwedAgeSeconds: 0, unhealthy: false,
});

/** The codebase's convention for raw timestamp parameters: a UTC wall-clock string, never the session's zone. */
export function toUtcTimestamp(d: Date): string {
  return d.toISOString().replace("T", " ").replace("Z", "");
}

async function dueIds(now: Date, opts: WorkerOptions): Promise<{ businessId: number; deliveryId: number }[]> {
  const limit = Math.min(Math.max(opts.limit ?? BATCH, 1), 500);
  if (opts.businessId !== undefined) {
    const businessId = opts.businessId;
    const rows = await tenantTx(businessId, (tx) =>
      tx.notificationDelivery.findMany({
        where: {
          businessId,
          status: "PENDING",
          channel: "PUSH",
          subscriptionId: null,
          ...(opts.deliveryIds ? { id: { in: opts.deliveryIds } } : {}),
          AND: [{ OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] }, { OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }],
        },
        select: { id: true },
        orderBy: [{ nextAttemptAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
        take: limit,
      }),
    );
    return rows.map((r) => ({ businessId, deliveryId: r.id }));
  }
  const rows = await prisma.$queryRaw<{ businessId: number; deliveryId: number }[]>`
    SELECT "businessId", "deliveryId" FROM public.notification_push_due(${toUtcTimestamp(now)}::timestamp(3), ${limit}::int)`;
  return rows.map((r) => ({ businessId: Number(r.businessId), deliveryId: Number(r.deliveryId) }));
}

export async function runPushWorker(now: Date = new Date(), opts: WorkerOptions = {}): Promise<WorkerReport> {
  const report = emptyReport();
  const due = await dueIds(now, opts);
  report.owed = due.length;
  const byBusiness = new Map<number, number[]>();
  for (const d of due) byBusiness.set(d.businessId, [...(byBusiness.get(d.businessId) ?? []), d.deliveryId]);
  const gatesOf = opts.gates ?? businessGates;
  const activationOf = opts.activation ?? observeActivation;

  for (const [businessId, ids] of byBusiness) {
    try {
      const gates = await gatesOf(businessId);
      // Observed in both states: ON records a global-only business's first activation, OFF its deactivation.
      const activation = await activationOf(businessId, gates.engineOn, now);
      if (!gates.engineOn) {
        await holdWhileEngineOff(businessId, ids, now, report, "engineOff");
        continue;
      }
      if (activation.kind !== "on") {
        await holdWhileEngineOff(businessId, ids, now, report, "activationUnavailable");
        continue;
      }
      const queue = [...ids];
      while (queue.length > 0) {
        const id = queue.shift()!;
        try {
          const children = await processOwed(businessId, id, now, gates, activation.record, opts.deps ?? {}, report);
          queue.push(...children);
        } catch {
          report.errors += 1;
        }
      }
    } catch {
      report.errors += 1;
    }
  }

  const attempts = report.devicesSent + report.devicesFailed;
  report.unhealthy = report.oldestOwedAgeSeconds > UNHEALTHY_AGE_SECONDS || (attempts >= 10 && report.devicesFailed * 2 > attempts);
  if (!opts.quiet) {
    console.log("[notifications] worker", JSON.stringify(report));
    if (report.unhealthy) {
      console.warn("[notifications] worker unhealthy", JSON.stringify(workerHealth(report)));
    }
  }
  return report;
}

/**
 * The engine is OFF for this business: nothing is claimed, decided or sent. Owed rows past their TTL are closed
 * as FAILED 'expired' (the historical PENDING pushes of the snapshot writer end here, unsent); the rest are looked
 * at again later, so they never crowd the due list for businesses where the engine is ON.
 */
async function holdWhileEngineOff(
  businessId: number, ids: number[], now: Date, report: WorkerReport, held: "engineOff" | "activationUnavailable",
): Promise<void> {
  await tenantTx(businessId, async (tx) => {
    const rows = await tx.notificationDelivery.findMany({
      where: { id: { in: ids }, businessId, status: "PENDING", channel: "PUSH", subscriptionId: null },
      select: { id: true, expiresAt: true, createdAt: true, notification: { select: { domain: true, semanticCategory: true, severity: true, entityType: true } } },
    });
    const free = { OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] };
    for (const r of rows) {
      const expiry = effectiveExpiry(r, classifyNotification(r.notification));
      if (expiry.getTime() <= now.getTime()) {
        const n = await tx.notificationDelivery.updateMany({
          where: { id: r.id, businessId, status: "PENDING", ...free },
          data: { status: "FAILED", error: "expired", completedAt: now, leaseUntil: null },
        });
        report.expired += n.count;
      } else {
        const next = new Date(Math.min(expiry.getTime(), now.getTime() + ENGINE_OFF_RECHECK_MS));
        const n = await tx.notificationDelivery.updateMany({ where: { id: r.id, businessId, status: "PENDING", ...free }, data: { nextAttemptAt: next } });
        report[held] += n.count;
      }
    }
  });
}

type Plan =
  | { kind: "done"; children: number[] }
  | {
      kind: "send";
      lease: Date;
      owed: { id: number; userId: number; attempts: number; expiry: Date; notificationId: number };
      devices: { id: number; provider: string; endpoint: string; p256dh: string; auth: string }[];
      alreadySent: boolean;
      message: ReturnType<typeof buildPushMessage>;
    };

async function processOwed(
  businessId: number,
  id: number,
  now: Date,
  gates: BusinessGates,
  activation: ActivationRecord,
  deps: SenderDeps,
  report: WorkerReport,
): Promise<number[]> {
  const plan: Plan = await tenantTx(businessId, (tx) => claimAndDecide(tx, businessId, id, now, gates, activation, report));
  if (plan.kind === "done") return plan.children;

  const results: { deviceId: number; result: PushResult }[] = await Promise.all(
    plan.devices.map(async (d) => ({ deviceId: d.id, result: await sendToDevice(d, plan.message, deps) })),
  );
  await tenantTx(businessId, (tx) => recordResults(tx, businessId, plan, results, now, report));
  return [];
}

async function claimAndDecide(
  tx: Tx, businessId: number, id: number, now: Date, gates: BusinessGates, activation: ActivationRecord, report: WorkerReport,
): Promise<Plan> {
  const lease = new Date(now.getTime() + LEASE_MS);
  const claim = await tx.notificationDelivery.updateMany({
    where: {
      id, businessId, status: "PENDING", channel: "PUSH", subscriptionId: null,
      AND: [{ OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] }],
    },
    data: { leaseUntil: lease },
  });
  if (claim.count !== 1) return { kind: "done", children: [] };
  report.claimed += 1;

  const row = await tx.notificationDelivery.findFirst({
    where: { id, businessId },
    select: {
      id: true, userId: true, attempts: true, expiresAt: true, createdAt: true, nextAttemptAt: true, notificationId: true,
      notification: {
        select: {
          id: true, userId: true, domain: true, semanticCategory: true, severity: true, entityType: true, entityId: true,
          title: true, summary: true, href: true, resolvedAt: true, dismissedAt: true,
        },
      },
    },
  });
  if (!row) return { kind: "done", children: [] };
  const n = row.notification;
  const cat: CategoryDefinition | null = classifyNotification(n);
  const expiry = effectiveExpiry(row, cat);

  const finish = async (status: "SENT" | "FAILED" | "SUPPRESSED", error: string | null, extra: { attempts?: number } = {}) => {
    await tx.notificationDelivery.updateMany({
      where: { id, businessId, status: "PENDING", leaseUntil: lease },
      data: { status, error, completedAt: now, leaseUntil: null, ...extra },
    });
    if (status === "SENT") report.sent += 1;
    else if (status === "SUPPRESSED") report.suppressed += 1;
    else if (error === "expired") report.expired += 1;
    else if (error === PRE_CUTOVER) report.preCutover += 1;
    else report.failed += 1;
  };

  // ── 1b. clean start: only what was created while the engine was ON (pushableCreatedAt) is ever pushed ──────────
  // (owner decisions 2026-11-13). Checked before anything else and before the health age: the backlog an activation
  // closes is expected, not a sign of a stuck queue. The row and its notification stay (no deletion).
  if (!pushableCreatedAt(row.createdAt, activation)) { await finish("FAILED", PRE_CUTOVER); return { kind: "done", children: [] }; }
  const dueAt = row.nextAttemptAt ?? row.createdAt;
  report.oldestOwedAgeSeconds = Math.max(report.oldestOwedAgeSeconds, Math.floor((now.getTime() - dueAt.getTime()) / 1000));

  // ── 2. the whole business → one owed row per recipient ──────────────────────────────────────────────────────────
  if (row.userId === null) {
    if (n.resolvedAt !== null || n.dismissedAt !== null) { await finish("SUPPRESSED", "resolved"); return { kind: "done", children: [] }; }
    if (expiry.getTime() <= now.getTime()) { await finish("FAILED", "expired"); return { kind: "done", children: [] }; }
    if (!categoryMayPush(cat)) { await finish("SUPPRESSED", "unknown_category"); return { kind: "done", children: [] }; }
    const users = await recipientUsers(tx, businessId, cat, n.userId);
    const children: number[] = [];
    for (const userId of users) {
      const child = await tx.notificationDelivery.create({
        data: {
          businessId, notificationId: row.notificationId, channel: "PUSH", status: "PENDING", userId,
          attempts: 0, expiresAt: expiry, attemptedAt: now, createdAt: now,
        },
        select: { id: true },
      });
      children.push(child.id);
    }
    await finish("SUPPRESSED", "fanned_out");
    report.fannedOut += 1;
    return { kind: "done", children };
  }

  // ── 3. one user's owed push: the decision ───────────────────────────────────────────────────────────────────────
  const userId = row.userId;
  const { settings: stored, prefs } = await readUserPreferences(tx, businessId, userId);
  const settings = effectiveSettings(stored);
  const effective = resolveCategory(cat, settings, prefs, cat ? gates.categoryAvailable(cat) : true);
  const timeZone = await businessTimeZone(tx, businessId);
  const recentSends = await recentNormalSends(tx, businessId, userId, now);
  const decision = decideOwed({
    now, notification: n, expiresAt: expiry, category: cat, effective,
    quiet: { enabled: settings.quietHoursEnabled, startMinute: settings.quietStartMinute, endMinute: settings.quietEndMinute },
    timeZone, recentSends,
  });
  if (decision.kind === "suppress") { await finish("SUPPRESSED", decision.reason); return { kind: "done", children: [] }; }
  if (decision.kind === "expire") { await finish("FAILED", "expired"); return { kind: "done", children: [] }; }
  if (decision.kind === "defer") {
    await tx.notificationDelivery.updateMany({
      where: { id, businessId, status: "PENDING", leaseUntil: lease },
      data: { nextAttemptAt: decision.until, leaseUntil: null },
    });
    report.deferred += 1;
    return { kind: "done", children: [] };
  }

  // ── 4. devices ──────────────────────────────────────────────────────────────────────────────────────────────────
  const devices = await tx.pushSubscription.findMany({
    where: { businessId, userId, revokedAt: null, NOT: { endpoint: { startsWith: "erased:" } } },
    select: { id: true, provider: true, endpoint: true, p256dh: true, auth: true, authSessionId: true },
    orderBy: { id: "asc" },
    take: MAX_DEVICES,
  });
  // Devices this owed push already reached (or that refused it for good) in an earlier attempt are not tried again.
  const done = await tx.notificationDelivery.findMany({
    where: {
      businessId, notificationId: row.notificationId, userId, channel: "PUSH", subscriptionId: { not: null },
      createdAt: { gte: row.createdAt },
      NOT: { status: "FAILED", error: { startsWith: "transient" } },
    },
    select: { subscriptionId: true, status: true },
  });
  const doneIds = new Set(done.map((d) => d.subscriptionId));
  const alreadySent = done.some((d) => d.status === "SENT");
  const sessionIds = [...new Set(devices.map((d) => d.authSessionId).filter((s): s is string => s !== null))];
  const live = new Set<string>();
  if (sessionIds.length > 0) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id"::text AS "id" FROM public.auth_sessions_live(${sessionIds}::uuid[], ${toUtcTimestamp(now)}::timestamp(3))`;
    for (const r of rows) live.add(String(r.id));
  }
  const eligible = eligibleDevices(devices.filter((d) => !doneIds.has(d.id)), live, (p) => providerConfigured(p));
  if (eligible.length === 0) {
    if (alreadySent) await finish("SENT", null);
    else await finish("SUPPRESSED", "no_device");
    return { kind: "done", children: [] };
  }
  const message = buildPushMessage(cat!, { id: n.id, title: n.title, summary: n.summary, href: n.href, entityType: n.entityType, entityId: n.entityId }, {
    lockScreenDetails: settings.lockScreenDetails,
    ttlSeconds: Math.max(60, (expiry.getTime() - now.getTime()) / 1000),
  });
  return {
    kind: "send",
    lease,
    owed: { id, userId, attempts: row.attempts, expiry, notificationId: row.notificationId },
    devices: eligible.map(({ id: did, provider, endpoint, p256dh, auth }) => ({ id: did, provider, endpoint, p256dh, auth })),
    alreadySent,
    message,
  };
}

/** The user's SENT pushes of non-exempt categories in the last 24 hours — one instant per notification. */
async function recentNormalSends(tx: Tx, businessId: number, userId: number, now: Date): Promise<Date[]> {
  const rows = await tx.notificationDelivery.findMany({
    where: {
      businessId, userId, channel: "PUSH", status: "SENT", subscriptionId: { not: null },
      attemptedAt: { gte: new Date(now.getTime() - 86_400_000) },
    },
    select: { notificationId: true, attemptedAt: true, notification: { select: { domain: true, semanticCategory: true, severity: true, entityType: true } } },
    take: 500,
  });
  const latest = new Map<number, Date>();
  for (const r of rows) {
    const cat = classifyNotification(r.notification);
    if (cat?.rateExempt) continue;
    const prev = latest.get(r.notificationId);
    if (!prev || prev < r.attemptedAt) latest.set(r.notificationId, r.attemptedAt);
  }
  return [...latest.values()];
}

async function recordResults(
  tx: Tx,
  businessId: number,
  plan: Extract<Plan, { kind: "send" }>,
  results: { deviceId: number; result: PushResult }[],
  now: Date,
  report: WorkerReport,
): Promise<void> {
  const { owed, lease } = plan;
  for (const { deviceId, result } of results) {
    if (result.kind === "not_configured") continue;
    const sent = result.kind === "sent";
    await tx.notificationDelivery.create({
      data: {
        businessId, notificationId: owed.notificationId, channel: "PUSH", status: sent ? "SENT" : "FAILED",
        userId: owed.userId, subscriptionId: deviceId, attempts: owed.attempts + 1,
        error: sent ? null : `${result.kind}:${result.code}`.slice(0, 64),
        attemptedAt: now, createdAt: now, completedAt: now,
      },
      select: { id: true },
    });
    if (sent) report.devicesSent += 1;
    else report.devicesFailed += 1;
    await tx.pushSubscription.updateMany({
      where: { id: deviceId, businessId },
      data: sent
        ? { lastSuccessAt: now, failureCount: 0 }
        : { lastFailureAt: now, failureCount: { increment: 1 } },
    });
    if (result.kind === "gone") {
      const r = await tx.pushSubscription.updateMany({
        where: { id: deviceId, businessId, revokedAt: null },
        data: { revokedAt: now, revokedReason: "gone" },
      });
      report.devicesRevoked += r.count;
    }
  }
  const anySent = plan.alreadySent || results.some((r) => r.result.kind === "sent");
  const anyTransient = results.some((r) => r.result.kind === "transient");
  const close = async (status: "SENT" | "FAILED", error: string | null, attempts: number) => {
    await tx.notificationDelivery.updateMany({
      where: { id: owed.id, businessId, status: "PENDING", leaseUntil: lease },
      data: { status, error, attempts, completedAt: now, leaseUntil: null },
    });
    if (status === "SENT") report.sent += 1;
    else if (error === "expired") report.expired += 1;
    else report.failed += 1;
  };
  if (anyTransient) {
    const attempts = owed.attempts + 1;
    const next = retryAfter(attempts, now);
    if (next !== null && next.getTime() < owed.expiry.getTime()) {
      await tx.notificationDelivery.updateMany({
        where: { id: owed.id, businessId, status: "PENDING", leaseUntil: lease },
        data: { attempts, nextAttemptAt: next, leaseUntil: null },
      });
      report.retried += 1;
      return;
    }
    await close(anySent ? "SENT" : "FAILED", anySent ? null : next === null ? "retries_exhausted" : "expired", attempts);
    return;
  }
  await close(anySent ? "SENT" : "FAILED", anySent ? null : "all_failed", owed.attempts);
}
