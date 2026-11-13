/**
 * The daily digest — runDailyDigest(now) (notifications track spec, 2026-11-12; windows: owner decision 2026-11-13).
 * SERVER-ONLY.
 *
 * Walks the live businesses in keyset pages (notification_live_businesses — identifiers only); for each business
 * where `notifications_engine` is ON, in its tenant transaction and its time zone (BookingSettings.timeZone, else
 * Asia/Jerusalem; Intl, DST-safe), for each user with the digest enabled whose local clock has reached their digest
 * minute (default 08:00) and who has no digest yet today:
 *
 *   collect the unresolved, undismissed notifications visible to the user (userId NULL or theirs) that SURFACED in
 *   the user's digest window, whose category is in DIGEST mode for them, or whose push to them was held back
 *   (to_digest, rate_limited, quiet) — EXCLUDING anything already SENT to them by push for that surfacing. Nothing ⇒
 *   nothing (never an empty push). Otherwise ONE notification (category digest.daily, userId = the user, dedupeKey
 *   `digest:u<userId>:<YYYY-MM-DD>` — the database's unique key makes a second digest that day impossible) with one
 *   owed push carrying the generic, count-only text "סיכום יומי: N עניינים מחכים לך". The push worker sends it.
 *
 * The window (digestWindowStart): an item belongs to exactly ONE digest per user — the first digest after it
 * (re)surfaced. The window starts at that user's previous ACTUAL digest (its own row's createdAt), so a day with
 * nothing to report loses nothing (the next window still starts at the last digest written); the first digest ever
 * looks back 24 hours; the window never reaches back more than 7 days. A reopened item surfaces again (its
 * lastSurfacedAt moves) and is included again, once.
 *
 * Counts only in the report and the log.
 */
import { prisma } from "@/lib/prisma";
import { tenantTx } from "@/lib/tenant/tenant-tx";

import { classifyNotification } from "../catalog";
import { rotationOrder } from "./schedule";
import { digestMoment } from "../notification-time";
import { effectiveSettings, resolveCategory } from "../preferences";
import { businessTimeZone, readUserPreferences } from "../preferences-store";
import { businessGates, type BusinessGates } from "./engine-gate";
import { notify } from "./notify";
import { recipientUsers } from "./recipients";
import { digestWindowStart, forThisSurfacing } from "./worker-decision";

const PAGE = 200;
const HELD_FOR_DIGEST = ["to_digest", "rate_limited", "quiet"];

export type DigestReport = {
  businesses: number; engineOff: number; usersChecked: number; due: number; digests: number; empty: number; errors: number;
  /** Businesses with no user due this pass (one read, no per-user transaction, no gate). */
  notDue?: number;
  /** The scheduled pass (opts.rotation — the cron): live businesses, groups, the group it started at, covered before the budget. */
  rotation?: { total: number; parts: number; startSlice: number; covered: number } | null;
};

export const digestDedupeKey = (userId: number, dayKey: string) => `digest:u${userId}:${dayKey}`;
export const digestSummary = (count: number) => `סיכום יומי: ${count} עניינים מחכים לך`;

/** Page through the live businesses (identifiers only) and visit each one. */
export async function walkLiveBusinesses(visit: (businessId: number) => Promise<void>): Promise<void> {
  let after = 0;
  for (;;) {
    const page = await prisma.$queryRaw<{ businessId: number }[]>`
      SELECT "businessId" FROM public.notification_live_businesses(${after}::int, ${PAGE}::int)`;
    if (page.length === 0) break;
    for (const r of page) await visit(Number(r.businessId));
    after = Number(page[page.length - 1].businessId);
    if (page.length < PAGE) break;
  }
}

export async function runDailyDigest(
  now: Date = new Date(),
  opts: {
    businessIds?: number[]; gates?: (businessId: number) => Promise<BusinessGates>; quiet?: boolean;
    /**
     * The scheduled (cron) pass: the stateless rotation over every live business (status-sweep.ts rotationOrder),
     * stopped by `budgetMs` before maxDuration. A business not reached this pass is reached by a later one the same
     * morning — "due" means the local clock has REACHED the digest minute, and the dedupe key is the local day.
     */
    rotation?: { cadenceMs: number; slice?: number };
    budgetMs?: number;
    clock?: () => number;
  } = {},
): Promise<DigestReport> {
  const report: DigestReport = { businesses: 0, engineOff: 0, usersChecked: 0, due: 0, digests: 0, empty: 0, errors: 0, notDue: 0, rotation: null };
  const gatesOf = opts.gates ?? businessGates;
  const clock = opts.clock ?? (() => Date.now());
  const started = clock();
  const overBudget = () => opts.budgetMs !== undefined && clock() - started >= opts.budgetMs;
  const visit = async (businessId: number) => {
    report.businesses += 1;
    try {
      // Cheap first: one read decides whether ANY user of the business is due (local time vs digest minute, digest
      // not yet written today) — most passes of the day stop here, before the gate and any per-user transaction.
      const plan = await duePlan(businessId, now);
      if (plan.users.length === 0) { report.notDue = (report.notDue ?? 0) + 1; report.usersChecked += plan.checked; return; }
      const gates = await gatesOf(businessId);
      if (!gates.engineOn) { report.engineOff += 1; return; }
      await digestBusiness(businessId, now, gates, report, plan);
    } catch {
      report.errors += 1;
    }
  };
  if (opts.businessIds) {
    for (const b of opts.businessIds) { if (overBudget()) break; await visit(b); }
  } else if (opts.rotation) {
    const live: number[] = [];
    await walkLiveBusinesses(async (b) => { live.push(b); });
    const { order, parts, startSlice } = rotationOrder(live, now, opts.rotation.cadenceMs, opts.rotation.slice);
    report.rotation = { total: live.length, parts, startSlice, covered: 0 };
    for (const b of order) {
      if (overBudget()) break;
      await visit(b);
      report.rotation.covered += 1;
    }
  } else {
    await walkLiveBusinesses(visit);
  }
  if (!opts.quiet) console.log("[notifications] digest", JSON.stringify(report));
  return report;
}

type DuePlan = { timeZone: string; users: number[]; checked: number };

/**
 * One tenant transaction: the business's time zone, its recipient users, their stored digest settings and today's
 * digests already written — the users whose local clock has reached their digest minute and who have no digest yet
 * this local day. The per-user transaction below re-checks both (it is the authority); this only skips work.
 */
async function duePlan(businessId: number, now: Date): Promise<DuePlan> {
  return tenantTx(businessId, async (tx) => {
    const timeZone = await businessTimeZone(tx, businessId);
    const ids = await recipientUsers(tx, businessId, null, null);
    if (ids.length === 0) return { timeZone, users: [], checked: 0 };
    const stored = await tx.notificationSettings.findMany({
      where: { businessId, userId: { in: ids } },
      select: { userId: true, pushEnabled: true, quietHoursEnabled: true, quietStartMinute: true, quietEndMinute: true, digestEnabled: true, digestMinute: true, lockScreenDetails: true },
    });
    const byUser = new Map(stored.map(({ userId, ...rest }) => [userId, rest]));
    const candidates = ids.filter((u) => {
      const s = effectiveSettings(byUser.get(u) ?? null);
      return s.digestEnabled && digestMoment(now, timeZone, s.digestMinute).due;
    });
    if (candidates.length === 0) return { timeZone, users: [], checked: ids.length };
    const keys = candidates.map((u) => digestDedupeKey(u, digestMoment(now, timeZone, effectiveSettings(byUser.get(u) ?? null).digestMinute).dayKey));
    const done = new Set((await tx.notification.findMany({ where: { businessId, dedupeKey: { in: keys } }, select: { dedupeKey: true } })).map((r) => r.dedupeKey));
    return { timeZone, users: candidates.filter((_u, i) => !done.has(keys[i]!)), checked: ids.length };
  });
}

async function digestBusiness(businessId: number, now: Date, gates: BusinessGates, report: DigestReport, plan: DuePlan): Promise<void> {
  const users = { timeZone: plan.timeZone, ids: plan.users };
  report.usersChecked += plan.checked - plan.users.length;
  for (const userId of users.ids) {
    report.usersChecked += 1;
    try {
      await tenantTx(businessId, async (tx) => {
        const { settings: stored, prefs } = await readUserPreferences(tx, businessId, userId);
        const settings = effectiveSettings(stored);
        if (!settings.digestEnabled) return;
        const moment = digestMoment(now, users.timeZone, settings.digestMinute);
        if (!moment.due) return;
        const dedupeKey = digestDedupeKey(userId, moment.dayKey);
        if (await tx.notification.findFirst({ where: { businessId, dedupeKey }, select: { id: true } })) return;
        report.due += 1;

        // The previous ACTUAL digest of this user (a day with nothing to report wrote none, so it is skipped).
        const previous = await tx.notification.findFirst({
          where: { businessId, userId, semanticCategory: "digest.daily", dedupeKey: { startsWith: `digest:u${userId}:` }, createdAt: { lt: now } },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        });
        const since = digestWindowStart(now, previous?.createdAt ?? null);

        const candidates = await tx.notification.findMany({
          where: {
            businessId,
            OR: [{ userId: null }, { userId }],
            resolvedAt: null,
            dismissedAt: null,
            lastSurfacedAt: { gt: since, lte: now },
            NOT: { semanticCategory: { in: ["digest.daily", "system.test"] } },
          },
          select: { id: true, domain: true, semanticCategory: true, severity: true, entityType: true, lastSurfacedAt: true },
          take: 500,
        });
        const ids = candidates.map((c) => c.id);
        const pushRows = ids.length === 0 ? [] : await tx.notificationDelivery.findMany({
          where: {
            businessId, userId, channel: "PUSH", notificationId: { in: ids },
            OR: [{ status: "SENT", subscriptionId: { not: null } }, { status: "SUPPRESSED", error: { in: HELD_FOR_DIGEST } }],
          },
          select: { notificationId: true, status: true, attemptedAt: true, completedAt: true },
        });
        let count = 0;
        for (const c of candidates) {
          const cat = classifyNotification(c);
          if (!cat) continue;
          const mine = pushRows.filter((r) => r.notificationId === c.id);
          const pushed = mine.some((r) => r.status === "SENT" && forThisSurfacing(r.attemptedAt, c.lastSurfacedAt));
          if (pushed) continue;
          const held = mine.some((r) => r.status === "SUPPRESSED" && forThisSurfacing(r.completedAt, c.lastSurfacedAt));
          const eff = resolveCategory(cat, settings, prefs, gates.categoryAvailable(cat));
          if (!eff.available || !eff.inApp) continue;
          if (eff.delivery === "digest" || held) count += 1;
        }
        if (count === 0) { report.empty += 1; return; }
        const out = await notify(tx, {
          businessId,
          category: "digest.daily",
          entity: { type: "digest", id: userId },
          dedupeKey,
          title: "סיכום יומי",
          summary: digestSummary(count),
          href: "/notifications",
          userId,
          now,
        });
        if (out.notified) report.digests += 1;
      });
    } catch {
      report.errors += 1;
    }
  }
}
