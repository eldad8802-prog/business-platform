/**
 * The daily digest — runDailyDigest(now) (notifications track spec, 2026-11-12). SERVER-ONLY.
 *
 * Walks the live businesses in keyset pages (notification_live_businesses — identifiers only); for each business
 * where `notifications_engine` is ON, in its tenant transaction and its time zone (BookingSettings.timeZone, else
 * Asia/Jerusalem; Intl, DST-safe), for each user with the digest enabled whose local clock has reached their digest
 * minute (default 08:00) and who has no digest yet today:
 *
 *   collect the unresolved, undismissed notifications visible to the user (userId NULL or theirs) from the last 24
 *   hours whose category is in DIGEST mode for them, or whose push to them was held back (to_digest, rate_limited,
 *   quiet) — EXCLUDING anything already SENT to them by push. Nothing ⇒ nothing (never an empty push). Otherwise
 *   ONE notification (category digest.daily, userId = the user, dedupeKey `digest:u<userId>:<YYYY-MM-DD>` — the
 *   database's unique key makes a second digest that day impossible) with one owed push carrying the generic,
 *   count-only text "סיכום יומי: N עניינים מחכים לך". The push worker sends it.
 *
 * Counts only in the report and the log.
 */
import { prisma } from "@/lib/prisma";
import { tenantTx } from "@/lib/tenant/tenant-tx";

import { classifyNotification } from "../catalog";
import { digestMoment } from "../notification-time";
import { effectiveSettings, resolveCategory } from "../preferences";
import { businessTimeZone, readUserPreferences } from "../preferences-store";
import { businessGates, type BusinessGates } from "./engine-gate";
import { notify } from "./notify";
import { recipientUsers } from "./recipients";

const PAGE = 200;
const HELD_FOR_DIGEST = ["to_digest", "rate_limited", "quiet"];

export type DigestReport = { businesses: number; engineOff: number; usersChecked: number; due: number; digests: number; empty: number; errors: number };

export const digestDedupeKey = (userId: number, dayKey: string) => `digest:u${userId}:${dayKey}`;
export const digestSummary = (count: number) => `סיכום יומי: ${count} עניינים מחכים לך`;

export async function runDailyDigest(
  now: Date = new Date(),
  opts: { businessIds?: number[]; gates?: (businessId: number) => Promise<BusinessGates>; quiet?: boolean } = {},
): Promise<DigestReport> {
  const report: DigestReport = { businesses: 0, engineOff: 0, usersChecked: 0, due: 0, digests: 0, empty: 0, errors: 0 };
  const gatesOf = opts.gates ?? businessGates;
  const visit = async (businessId: number) => {
    report.businesses += 1;
    try {
      const gates = await gatesOf(businessId);
      if (!gates.engineOn) { report.engineOff += 1; return; }
      await digestBusiness(businessId, now, gates, report);
    } catch {
      report.errors += 1;
    }
  };
  if (opts.businessIds) {
    for (const b of opts.businessIds) await visit(b);
  } else {
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
  if (!opts.quiet) console.log("[notifications] digest", JSON.stringify(report));
  return report;
}

async function digestBusiness(businessId: number, now: Date, gates: BusinessGates, report: DigestReport): Promise<void> {
  const users = await tenantTx(businessId, async (tx) => ({
    timeZone: await businessTimeZone(tx, businessId),
    ids: await recipientUsers(tx, businessId, null, null),
  }));
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

        const candidates = await tx.notification.findMany({
          where: {
            businessId,
            OR: [{ userId: null }, { userId }],
            resolvedAt: null,
            dismissedAt: null,
            lastSurfacedAt: { gte: new Date(now.getTime() - 86_400_000) },
            NOT: { semanticCategory: { in: ["digest.daily", "system.test"] } },
          },
          select: { id: true, domain: true, semanticCategory: true, severity: true, entityType: true },
          take: 500,
        });
        const ids = candidates.map((c) => c.id);
        const pushRows = ids.length === 0 ? [] : await tx.notificationDelivery.findMany({
          where: {
            businessId, userId, channel: "PUSH", notificationId: { in: ids },
            OR: [{ status: "SENT", subscriptionId: { not: null } }, { status: "SUPPRESSED", error: { in: HELD_FOR_DIGEST } }],
          },
          select: { notificationId: true, status: true },
        });
        const pushed = new Set(pushRows.filter((r) => r.status === "SENT").map((r) => r.notificationId));
        const held = new Set(pushRows.filter((r) => r.status === "SUPPRESSED").map((r) => r.notificationId));
        let count = 0;
        for (const c of candidates) {
          const cat = classifyNotification(c);
          if (!cat || pushed.has(c.id)) continue;
          const eff = resolveCategory(cat, settings, prefs, gates.categoryAvailable(cat));
          if (!eff.available || !eff.inApp) continue;
          if (eff.delivery === "digest" || held.has(c.id)) count += 1;
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
