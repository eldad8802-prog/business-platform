/**
 * Notification writer — DB integration proof.
 *
 * The writer's two hardest guarantees, identity under concurrency and tenant
 * containment, are properties of SQL, not of TypeScript. A mocked Prisma would
 * prove that the code calls what it says it calls and nothing about whether the
 * database agrees, so this runs against a real PostgreSQL.
 *
 * Self-provisioning: creates its own two businesses and deletes them at the end,
 * so it can run against any disposable database without external fixtures.
 * It writes no production data and reads no production secrets.
 *
 * Requires env: DATABASE_URL (and DIRECT_URL) pointing at a THROWAWAY database
 * whose schema is at the current migration head.
 *
 * Run: npx tsx lib/notifications/notification-writer.integration.test.ts
 */
import { prisma } from "../prisma";
import { runWithTenantContext } from "../tenant/context";
import type { BusinessStatusItem } from "../business-status/types";
import {
  persistSnapshotNotifications,
  markNotificationRead,
  dismissNotification,
  resolveNotification,
} from "./notification-writer";

let failures = 0;
function check(name: string, cond: boolean, extra = ""): void {
  if (!cond) failures++;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
}

/**
 * A business-status item. Only the fields the writer reads are meaningful; the
 * rest exist because the type requires them.
 */
function item(over: {
  domain: string;
  semanticCategory: string;
  severity: string;
  entityId: number;
  title?: string;
  summary?: string | null;
  href?: string;
}): BusinessStatusItem {
  return {
    itemId: `item-${over.domain}-${over.entityId}`,
    domain: over.domain as BusinessStatusItem["domain"],
    semanticCategory: over.semanticCategory as BusinessStatusItem["semanticCategory"],
    title: over.title ?? "stock is critical",
    summary: over.summary ?? null,
    severity: over.severity as BusinessStatusItem["severity"],
    priorityScore: 100,
    entityRef: { type: "InventoryItem", id: over.entityId },
    state: "open",
    createdAt: new Date().toISOString(),
    primaryAction: { kind: "navigate", label: "open", href: over.href ?? "/inventory/1" },
    sourceEngine: "test",
  } as BusinessStatusItem;
}

// Rule keys taken from the policy, not invented here.
const PUSH_ITEM = () => item({ domain: "inventory", semanticCategory: "ALERT", severity: "CRITICAL", entityId: 1 });
const INAPP_ITEM = () => item({ domain: "inventory", semanticCategory: "ALERT", severity: "HIGH", entityId: 2 });
const SILENT_ITEM = () => item({ domain: "inventory", semanticCategory: "ALERT", severity: "LOW", entityId: 3 });

// 09:00 Jerusalem — outside quiet hours, so push is allowed to survive policy.
const DAY = new Date("2026-09-10T06:00:00.000Z");
// 23:00 Jerusalem — inside quiet hours.
const NIGHT = new Date("2026-09-10T20:00:00.000Z");

const asTenant = <T>(businessId: number, fn: () => Promise<T>): Promise<T> =>
  runWithTenantContext({ businessId }, fn);

(async () => {
  const a = await prisma.business.create({ data: { name: "notif-writer-A" } });
  const b = await prisma.business.create({ data: { name: "notif-writer-B" } });

  try {
    /* ── silence ─────────────────────────────────────────────────────────── */
    await asTenant(a.id, () => persistSnapshotNotifications(a.id, [SILENT_ITEM()], DAY));
    const silentRows = await prisma.notification.count({ where: { businessId: a.id } });
    check("policy silences the fact -> zero rows written", silentRows === 0, `rows=${silentRows}`);

    /* ── in-app only ─────────────────────────────────────────────────────── */
    const inapp = await asTenant(a.id, () => persistSnapshotNotifications(a.id, [INAPP_ITEM()], DAY));
    const inappRow = await prisma.notification.findFirst({
      where: { businessId: a.id, dedupeKey: inapp[0].dedupeKey },
      include: { deliveries: true },
    });
    check("in-app fact creates one notification", inapp.length === 1 && inapp[0].created && inapp[0].notified);
    check("in-app intendedChannels is IN_APP only", JSON.stringify(inappRow?.intendedChannels) === '["IN_APP"]', JSON.stringify(inappRow?.intendedChannels));
    check("in-app writes exactly one delivery, SENT", inappRow?.deliveries.length === 1 && inappRow.deliveries[0].status === "SENT");
    check("stored payload is the snapshot payload", inappRow?.href === "/inventory/1" && inappRow?.entityId === 2);
    check("cooldown anchor set on first notify", inappRow?.lastNotifiedAt !== null);

    /* ── push-eligible, outside quiet hours ──────────────────────────────── */
    const push = await asTenant(a.id, () => persistSnapshotNotifications(a.id, [PUSH_ITEM()], DAY));
    const pushRow = await prisma.notification.findFirst({
      where: { businessId: a.id, dedupeKey: push[0].dedupeKey },
      include: { deliveries: { orderBy: { channel: "asc" } } },
    });
    check("push-eligible fact records both channels", JSON.stringify(pushRow?.intendedChannels) === '["IN_APP","PUSH"]', JSON.stringify(pushRow?.intendedChannels));
    check("push delivery row exists and is PENDING (nothing was sent)",
      pushRow?.deliveries.some((d) => d.channel === "PUSH" && d.status === "PENDING") === true);
    check("in-app delivery of the same notification is SENT",
      pushRow?.deliveries.some((d) => d.channel === "IN_APP" && d.status === "SENT") === true);
    check("no delivery is marked SENT for PUSH",
      pushRow?.deliveries.some((d) => d.channel === "PUSH" && d.status === "SENT") === false);

    /* ── quiet hours: suppression is the policy's, not the writer's ──────── */
    const night = await asTenant(b.id, () => persistSnapshotNotifications(b.id, [PUSH_ITEM()], NIGHT));
    const nightRow = await prisma.notification.findFirst({
      where: { businessId: b.id, dedupeKey: night[0].dedupeKey },
      include: { deliveries: true },
    });
    check("quiet hours downgrade push to in-app", JSON.stringify(nightRow?.intendedChannels) === '["IN_APP"]', JSON.stringify(nightRow?.intendedChannels));
    check("quiet hours produce no PUSH delivery row",
      nightRow?.deliveries.every((d) => d.channel === "IN_APP") === true);

    /* ── idempotency: same fact again inside cooldown ────────────────────── */
    const again = await asTenant(a.id, () => persistSnapshotNotifications(a.id, [INAPP_ITEM()], new Date(DAY.getTime() + 60_000)));
    const afterAgain = await prisma.notification.findFirst({
      where: { businessId: a.id, dedupeKey: again[0].dedupeKey },
      include: { deliveries: true },
    });
    check("re-observing the same fact creates no second notification",
      again[0].created === false && again[0].notificationId === inapp[0].notificationId);
    check("re-observation inside cooldown does not re-notify", again[0].notified === false && again[0].withinCooldown);
    check("re-observation adds no delivery row", afterAgain?.deliveries.length === 1, `deliveries=${afterAgain?.deliveries.length}`);
    check("re-observation still bumps lastSurfacedAt",
      (afterAgain?.lastSurfacedAt.getTime() ?? 0) > (inappRow?.lastSurfacedAt.getTime() ?? 0));

    /* ── cooldown expiry re-notifies ─────────────────────────────────────── */
    const later = new Date(DAY.getTime() + 25 * 3_600_000); // rule is 24h
    const renotified = await asTenant(a.id, () => persistSnapshotNotifications(a.id, [INAPP_ITEM()], later));
    const afterRenotify = await prisma.notification.findFirst({
      where: { businessId: a.id, dedupeKey: renotified[0].dedupeKey },
      include: { deliveries: true },
    });
    check("past cooldown, the same fact notifies again", renotified[0].notified === true && renotified[0].created === false);
    check("re-notification appends a second delivery", afterRenotify?.deliveries.length === 2, `deliveries=${afterRenotify?.deliveries.length}`);

    /* ── lifecycle transitions ───────────────────────────────────────────── */
    const nid = inapp[0].notificationId;
    check("read transition", await asTenant(a.id, () => markNotificationRead(a.id, nid, later)));
    check("readAt is set", (await prisma.notification.findUnique({ where: { id: nid } }))?.readAt !== null);
    check("dismiss transition", await asTenant(a.id, () => dismissNotification(a.id, nid, later)));
    check("dismissedAt is set", (await prisma.notification.findUnique({ where: { id: nid } }))?.dismissedAt !== null);
    check("resolve transition", await asTenant(a.id, () => resolveNotification(a.id, nid, later)));
    const resolved = await prisma.notification.findUnique({ where: { id: nid } });
    check("resolvedAt is set", resolved?.resolvedAt !== null);
    check("resolve does not disturb the cooldown anchor", resolved?.lastNotifiedAt?.getTime() === later.getTime(), `stored=${resolved?.lastNotifiedAt?.toISOString()} expected=${later.toISOString()}`);

    /* ── reopen ──────────────────────────────────────────────────────────── */
    // Still inside the new cooldown: the fact comes back, but the owner is not
    // re-notified, and their dismissal is therefore left standing.
    const soon = new Date(later.getTime() + 60_000);
    const reopened = await asTenant(a.id, () => persistSnapshotNotifications(a.id, [INAPP_ITEM()], soon));
    const afterReopen = await prisma.notification.findUnique({ where: { id: nid } });
    check("a resolved fact that returns is reported as reopened", reopened[0].reopened === true);
    check("reopen clears resolvedAt (the fact is present again)", afterReopen?.resolvedAt === null);
    check("reopen inside cooldown does not re-notify", reopened[0].notified === false);
    check("reopen inside cooldown leaves the owner's dismissal alone", afterReopen?.dismissedAt !== null);

    // Past cooldown the same return IS news, and read/dismiss are cleared.
    const muchLater = new Date(later.getTime() + 25 * 3_600_000);
    const renews = await asTenant(a.id, () => persistSnapshotNotifications(a.id, [INAPP_ITEM()], muchLater));
    const afterRenew = await prisma.notification.findUnique({ where: { id: nid } });
    check("past cooldown a returning fact re-notifies", renews[0].notified === true);
    check("re-notification clears read", afterRenew?.readAt === null);
    check("re-notification clears dismissed", afterRenew?.dismissedAt === null);

    /* ── tenant separation ───────────────────────────────────────────────── */
    const bSame = await asTenant(b.id, () => persistSnapshotNotifications(b.id, [INAPP_ITEM()], DAY));
    check("an equivalent fact in another business is a separate notification",
      bSame[0].created === true && bSame[0].notificationId !== inapp[0].notificationId);
    check("dedupe keys are tenant-scoped", bSame[0].dedupeKey !== inapp[0].dedupeKey,
      `${bSame[0].dedupeKey} vs ${inapp[0].dedupeKey}`);

    /* ── cross-tenant containment ────────────────────────────────────────── */
    const bNid = bSame[0].notificationId;
    const crossed = await asTenant(b.id, () => markNotificationRead(b.id, nid, muchLater));
    check("B cannot mark A's notification read", crossed === false);
    check("A's notification is untouched by B",
      (await prisma.notification.findUnique({ where: { id: nid } }))?.readAt === null);

    let refused = false;
    try {
      await asTenant(b.id, () => persistSnapshotNotifications(a.id, [INAPP_ITEM()], muchLater));
    } catch {
      refused = true;
    }
    check("writing for business A inside tenant context B is refused", refused);

    /* ── concurrency: the database, not the application, decides ─────────── */
    const raceItem = () => item({ domain: "billing", semanticCategory: "FAILURE_EVENT", severity: "HIGH", entityId: 99 });
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        asTenant(a.id, () => persistSnapshotNotifications(a.id, [raceItem()], muchLater)),
      ),
    );
    const settled = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof persistSnapshotNotifications>>>[];
    const raceKey = settled[0]?.value[0]?.dedupeKey;
    const rows = await prisma.notification.count({ where: { businessId: a.id, dedupeKey: raceKey } });
    const notifiedCount = settled.filter((r) => r.value[0].notified).length;
    const createdCount = settled.filter((r) => r.value[0].created).length;
    const deliveries = await prisma.notificationDelivery.count({
      where: { businessId: a.id, notification: { dedupeKey: raceKey } },
    });
    check("8 concurrent writers produce exactly one notification", rows === 1, `rows=${rows}`);
    check("exactly one writer claims creation", createdCount === 1, `created=${createdCount}`);
    check("exactly one writer wins the right to notify", notifiedCount === 1, `notified=${notifiedCount}`);
    check("only the winner writes deliveries", deliveries === 2, `deliveries=${deliveries} (IN_APP+PUSH)`);
    check("no concurrent writer failed", settled.length === 8, `fulfilled=${settled.length}/8`);

    /* ── transactional consistency ───────────────────────────────────────── */
    // A snapshot whose second item explodes must leave nothing behind from the
    // first, including its delivery rows.
    const before = await prisma.notification.count({ where: { businessId: b.id } });
    const beforeDeliveries = await prisma.notificationDelivery.count({ where: { businessId: b.id } });
    const poisoned = [
      item({ domain: "billing", semanticCategory: "FAILURE_EVENT", severity: "HIGH", entityId: 4242 }),
      { ...item({ domain: "billing", semanticCategory: "FAILURE_EVENT", severity: "HIGH", entityId: 4243 }), title: null as unknown as string },
    ];
    let rolledBack = false;
    try {
      await asTenant(b.id, () => persistSnapshotNotifications(b.id, poisoned, muchLater));
    } catch {
      rolledBack = true;
    }
    const after = await prisma.notification.count({ where: { businessId: b.id } });
    const afterDeliveries = await prisma.notificationDelivery.count({ where: { businessId: b.id } });
    check("a failing item aborts the whole snapshot write", rolledBack);
    check("rollback leaves no partial Notification", after === before, `${before} -> ${after}`);
    check("rollback leaves no partial NotificationDelivery", afterDeliveries === beforeDeliveries, `${beforeDeliveries} -> ${afterDeliveries}`);

    /* ── no DELETE anywhere ──────────────────────────────────────────────── */
    const totalA = await prisma.notification.count({ where: { businessId: a.id } });
    check("nothing the writer does removes a notification", totalA >= 3, `rows=${totalA}`);
  } finally {
    await prisma.business.deleteMany({ where: { id: { in: [a.id, b.id] } } });
    await prisma.$disconnect();
  }

  console.log(
    failures === 0
      ? `\nNOTIFICATION-WRITER INTEGRATION: all checks passed\n`
      : `\nNOTIFICATION-WRITER INTEGRATION: ${failures} FAILED\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("integration harness error:", err);
  process.exit(1);
});
