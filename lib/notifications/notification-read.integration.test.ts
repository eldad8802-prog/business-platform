/**
 * Notification read surface — DB integration proof.
 *
 * Two things are being proven, and they are not the same kind of claim.
 *
 * TENANT SAFETY is a security property, so it is asserted at the application
 * query boundary rather than left to row-level security. Production still runs
 * as a privileged role today, which means RLS is inert there: if the predicate
 * is wrong, nothing else stops it.
 *
 * LIFECYCLE SEPARATION is a product property. resolvedAt is business truth,
 * readAt is consumption state, and the tests below fail if anything starts
 * confusing the two — reading a problem must not end it, and a problem ending
 * must not count as read.
 *
 * Requires env: DATABASE_URL / DIRECT_URL pointing at a THROWAWAY database at
 * the current migration head. Writes no production data.
 *
 * Run: npx tsx lib/notifications/notification-read.integration.test.ts
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { NotificationChannel } from "@prisma/client";

import { prisma } from "../prisma";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  clampLimit,
  countUnread,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "./notification-read.service";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let failures = 0;
function check(name: string, cond: boolean, extra = ""): void {
  if (!cond) failures++;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
}

const NOW = new Date("2026-09-10T06:00:00.000Z");

/** A notification written directly, so these tests exercise the READ path only. */
function seed(
  businessId: number,
  key: string,
  over: Partial<{
    readAt: Date | null;
    resolvedAt: Date | null;
    dismissedAt: Date | null;
    lastSurfacedAt: Date;
    severity: string;
  }> = {},
) {
  return prisma.notification.create({
    data: {
      businessId,
      dedupeKey: `b${businessId}:inventory:ALERT:inventory_item:${key}`,
      domain: "inventory",
      semanticCategory: "ALERT",
      severity: over.severity ?? "CRITICAL",
      entityType: "inventory_item",
      entityId: Number(key),
      title: `alert ${key}`,
      summary: null,
      href: "/inventory",
      intendedChannels: ["IN_APP", "PUSH"] as NotificationChannel[],
      reason: "test fixture",
      cooldownHours: 24,
      firstSurfacedAt: NOW,
      lastSurfacedAt: over.lastSurfacedAt ?? NOW,
      lastNotifiedAt: NOW,
      readAt: over.readAt ?? null,
      resolvedAt: over.resolvedAt ?? null,
      dismissedAt: over.dismissedAt ?? null,
    },
  });
}

(async () => {
  const a = await prisma.business.create({ data: { name: "read-api-A" } });
  const b = await prisma.business.create({ data: { name: "read-api-B" } });

  try {
    /* ── empty ────────────────────────────────────────────────────────────── */
    const empty = await listNotifications(a.id, { limit: DEFAULT_LIMIT, cursor: null, unreadOnly: false });
    check("an empty business lists cleanly", empty.notifications.length === 0 && empty.nextCursor === null);
    check("an empty business has an unread count of zero", empty.unreadCount === 0);

    /* ── the four lifecycle shapes ────────────────────────────────────────── */
    const openUnread = await seed(a.id, "1", { lastSurfacedAt: new Date(NOW.getTime() + 4000) });
    const openRead = await seed(a.id, "2", { readAt: NOW, lastSurfacedAt: new Date(NOW.getTime() + 3000) });
    const resolvedUnread = await seed(a.id, "3", { resolvedAt: NOW, lastSurfacedAt: new Date(NOW.getTime() + 2000) });
    const resolvedRead = await seed(a.id, "4", { readAt: NOW, resolvedAt: NOW, lastSurfacedAt: new Date(NOW.getTime() + 1000) });
    const dismissed = await seed(a.id, "5", { dismissedAt: NOW, lastSurfacedAt: NOW });
    await seed(b.id, "9");

    const page = await listNotifications(a.id, { limit: DEFAULT_LIMIT, cursor: null, unreadOnly: false });
    const ids = page.notifications.map((n) => n.id);

    check("an active unread notification appears", ids.includes(openUnread.id));
    check("a read notification is still listed", ids.includes(openRead.id));
    check("resolved history is preserved in the list", ids.includes(resolvedUnread.id) && ids.includes(resolvedRead.id));
    check("a dismissed notification is hidden", !ids.includes(dismissed.id));
    check("newest activity comes first",
      ids.join(",") === [openUnread.id, openRead.id, resolvedUnread.id, resolvedRead.id].join(","), ids.join(","));

    /* ── unread count is a strict subset of what the list shows ───────────── */
    const count = await countUnread(a.id);
    check("the badge counts only open, unread, visible rows", count === 1, `count=${count}`);
    check("the list reports the same number it would render", page.unreadCount === count);
    check("resolved-but-unread is not counted",
      !((await listNotifications(a.id, { limit: 50, cursor: null, unreadOnly: true })).notifications
        .some((n) => n.id === resolvedUnread.id)));
    check("every counted row is a row the list shows",
      (await listNotifications(a.id, { limit: 50, cursor: null, unreadOnly: true })).notifications
        .every((n) => ids.includes(n.id)));

    /* ── the list exposes business truth, not transport internals ─────────── */
    const sample = page.notifications[0] as Record<string, unknown>;
    check("the payload carries what the UI needs",
      ["id", "domain", "severity", "title", "href", "readAt", "resolvedAt"].every((f) => f in sample));
    check("it leaks no internal identity or scheduling fields",
      !["dedupeKey", "reason", "cooldownHours", "lastNotifiedAt", "businessId", "intendedChannels", "deliveries"]
        .some((f) => f in sample), Object.keys(sample).join(","));

    /* ── tenant isolation ─────────────────────────────────────────────────── */
    const bPage = await listNotifications(b.id, { limit: DEFAULT_LIMIT, cursor: null, unreadOnly: false });
    check("business A cannot see business B's notifications",
      !ids.some((id) => bPage.notifications.map((n) => n.id).includes(id)));
    check("business B sees only its own", bPage.notifications.length === 1);

    const crossRead = await markNotificationRead(b.id, openUnread.id, NOW);
    check("B cannot mark A's notification read", crossRead.found === false && crossRead.changed === false);
    check("A's notification is untouched by B",
      (await prisma.notification.findUnique({ where: { id: openUnread.id } }))!.readAt === null);

    const bogus = await markNotificationRead(a.id, 99_999_999, NOW);
    check("an id that does not exist is reported as not found", bogus.found === false);

    /* ── mark read: consumption state only ────────────────────────────────── */
    const before = await prisma.notification.findUnique({ where: { id: openUnread.id } });
    const first = await markNotificationRead(a.id, openUnread.id, new Date(NOW.getTime() + 60_000));
    const after = await prisma.notification.findUnique({ where: { id: openUnread.id } });

    check("marking read succeeds and reports a change", first.found && first.changed);
    check("readAt is set", after!.readAt !== null);
    check("marking read does NOT resolve the notification", after!.resolvedAt === null);
    check("marking read leaves the cooldown anchor alone",
      after!.lastNotifiedAt?.getTime() === before!.lastNotifiedAt?.getTime());
    check("marking read leaves dedupe identity alone", after!.dedupeKey === before!.dedupeKey);
    check("marking read leaves the surfaced timestamps alone",
      after!.lastSurfacedAt.getTime() === before!.lastSurfacedAt.getTime() &&
      after!.firstSurfacedAt.getTime() === before!.firstSurfacedAt.getTime());
    check("the badge drops to zero", (await countUnread(a.id)) === 0);

    const repeat = await markNotificationRead(a.id, openUnread.id, new Date(NOW.getTime() + 120_000));
    const afterRepeat = await prisma.notification.findUnique({ where: { id: openUnread.id } });
    check("a repeat is found but changes nothing", repeat.found && repeat.changed === false);
    check("a repeat does not move the timestamp",
      afterRepeat!.readAt!.getTime() === after!.readAt!.getTime());

    check("no read operation creates a delivery row",
      (await prisma.notificationDelivery.count({ where: { businessId: a.id } })) === 0);

    /* ── resolution stays business truth ──────────────────────────────────── */
    check("a resolved notification did not become read by resolving",
      (await prisma.notification.findUnique({ where: { id: resolvedUnread.id } }))!.readAt === null);
    check("a resolved, read notification remains queryable as history",
      (await listNotifications(a.id, { limit: 50, cursor: null, unreadOnly: false })).notifications
        .some((n) => n.id === resolvedRead.id && n.resolvedAt !== null && n.readAt !== null));

    /* ── mark all read ────────────────────────────────────────────────────── */
    const openB = await seed(b.id, "10");
    const bCountBefore = await countUnread(b.id);
    const cleared = await markAllNotificationsRead(b.id, new Date(NOW.getTime() + 180_000));
    check("mark-all-read clears exactly what the badge counted",
      cleared === bCountBefore && (await countUnread(b.id)) === 0, `cleared=${cleared} counted=${bCountBefore}`);
    check("mark-all-read resolved nothing",
      (await prisma.notification.findUnique({ where: { id: openB.id } }))!.resolvedAt === null);
    check("mark-all-read did not touch the other tenant",
      (await prisma.notification.findUnique({ where: { id: resolvedUnread.id } }))!.readAt === null);
    check("mark-all-read never touches a dismissed row",
      (await prisma.notification.findUnique({ where: { id: dismissed.id } }))!.readAt === null);

    /* ── pagination ───────────────────────────────────────────────────────── */
    const p1 = await listNotifications(a.id, { limit: 2, cursor: null, unreadOnly: false });
    check("a partial page reports a cursor", p1.notifications.length === 2 && p1.nextCursor !== null);
    const p2 = await listNotifications(a.id, { limit: 2, cursor: p1.nextCursor, unreadOnly: false });
    check("the next page continues without repeating",
      !p2.notifications.some((n) => p1.notifications.map((x) => x.id).includes(n.id)));
    check("the last page reports no cursor", p2.nextCursor === null, `n=${p2.notifications.length}`);
    check("limit is clamped", clampLimit("999") === MAX_LIMIT && clampLimit("0") === DEFAULT_LIMIT && clampLimit(null) === DEFAULT_LIMIT);

    /* ── structural: the security property, locked ────────────────────────── */
    const svc = readFileSync(join(REPO_ROOT, "lib", "notifications", "notification-read.service.ts"), "utf8");
    const writes = [...svc.matchAll(/prisma\.notification\.(updateMany|update|deleteMany|delete)\(/g)].map((m) => m[1]);
    check("the read service performs no delete of any kind",
      !writes.some((w) => w.startsWith("delete")), writes.join(","));
    check("it never uses bare update(), only tenant-scoped updateMany()",
      writes.every((w) => w === "updateMany"), writes.join(","));
    check("every write predicate names businessId",
      svc.split("updateMany({").slice(1).every((seg) => seg.slice(0, 240).includes("businessId")));
    // Imports, not prose: the doc comment above legitimately names all three.
    const svcImports = svc
      .split(String.fromCharCode(10))
      .filter((l) => l.trimStart().startsWith("import"))
      .join(" | ");
    check("the read layer imports no policy, writer or business-status module",
      !/notification-policy|notification-writer|business-status/.test(svcImports), svcImports);

    for (const rel of [
      ["notifications", "route.ts"],
      ["notifications", "unread-count", "route.ts"],
      ["notifications", "[id]", "read", "route.ts"],
      ["notifications", "read-all", "route.ts"],
    ]) {
      const body = readFileSync(join(REPO_ROOT, "app", "api", ...rel), "utf8");
      const label = rel.slice(0, -1).join("/");
      check(`${label} takes its tenant from the session`, /user\.businessId/.test(body));
      check(`${label} accepts no businessId from the request`,
        !/(body|payload|searchParams\.get\(["']businessId)/.test(body) || !/businessId\s*=/.test(body));
    }
  } finally {
    await prisma.business.deleteMany({ where: { id: { in: [a.id, b.id] } } });
    await prisma.$disconnect();
  }

  console.log(
    failures === 0
      ? `\nNOTIFICATION-READ API: all checks passed\n`
      : `\nNOTIFICATION-READ API: ${failures} FAILED\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("integration harness error:", err);
  process.exit(1);
});
