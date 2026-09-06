/**
 * First notification consumer — DB integration proof.
 *
 * Drives real inventory movements through the real service and asserts what the
 * notification layer ends up believing. Nothing is mocked: the alert is created
 * by the inventory domain's own thresholds, the fact is read back through the
 * same business-status loader `/api/business-status` uses, and the policy and
 * writer are the merged ones.
 *
 * The sequence mirrors the route exactly — a tenant transaction that commits,
 * then the sync afterwards — because the whole point of the design is that
 * persistence happens after the commit and cannot affect it.
 *
 * Requires env: DATABASE_URL / DIRECT_URL pointing at a THROWAWAY database at
 * the current migration head. Writes no production data.
 *
 * Run: npx tsx lib/notifications/inventory-alert-notifications.integration.test.ts
 */
import { InventoryMovementReason, InventoryMovementType, InventoryUnitType } from "@prisma/client";

import { prisma } from "../prisma";
import { runWithTenantContext } from "../tenant/context";
import { withTenantTransaction } from "../tenant/transaction";
import { inventoryService } from "../services/inventory/inventory.service";

import { syncInventoryAlertNotifications } from "./inventory-alert-notifications";

let failures = 0;
function check(name: string, cond: boolean, extra = ""): void {
  if (!cond) failures++;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
}

/** Exactly what the movements route does: commit, then reconcile. */
async function movementThenSync(businessId: number, itemId: number, delta: number, now: Date) {
  const movement = await runWithTenantContext({ businessId }, () =>
    withTenantTransaction((tx) =>
      inventoryService.createMovement(
        {
          businessId,
          itemId,
          movementType: delta > 0 ? InventoryMovementType.IN : InventoryMovementType.OUT,
          reason: delta > 0 ? InventoryMovementReason.MANUAL_ADD : InventoryMovementReason.MANUAL_REMOVE,
          quantityDelta: delta,
        },
        { tx },
      ),
    ),
  );
  const sync = await runWithTenantContext({ businessId }, () =>
    syncInventoryAlertNotifications(businessId, now),
  );
  return { movement, sync };
}

const T0 = new Date("2026-09-10T06:00:00.000Z"); // 09:00 Jerusalem, outside quiet hours

(async () => {
  const a = await prisma.business.create({ data: { name: "consumer-A" } });
  const b = await prisma.business.create({ data: { name: "consumer-B" } });

  const mkItem = (businessId: number, name: string) =>
    prisma.inventoryItem.create({
      data: {
        businessId,
        name,
        unitType: InventoryUnitType.UNIT,
        currentQuantity: 10,
        minimumQuantity: 3,
      },
    });

  const itemA = await mkItem(a.id, "widget-A");
  const itemB = await mkItem(b.id, "widget-B");

  try {
    /* ── 1. a movement that crosses the threshold creates the notification ── */
    const first = await movementThenSync(a.id, itemA.id, -8, T0); // 10 -> 2, below min 3
    check("the movement itself succeeded", first.movement !== null && first.sync.ok);

    const alerts = await prisma.inventoryAlert.count({
      where: { businessId: a.id, itemId: itemA.id, type: "CRITICAL_STOCK", isResolved: false },
    });
    check("the domain raised one CRITICAL_STOCK alert", alerts === 1, `alerts=${alerts}`);

    const notifs = await prisma.notification.findMany({
      where: { businessId: a.id, domain: "inventory" },
      include: { deliveries: true },
    });
    check("exactly one notification was persisted", notifs.length === 1, `count=${notifs.length}`);
    check("it is the CRITICAL inventory alert",
      notifs[0]?.semanticCategory === "ALERT" && notifs[0]?.severity === "CRITICAL",
      `${notifs[0]?.semanticCategory}/${notifs[0]?.severity}`);
    check("dedupe identity is the alert row, tenant-scoped",
      /^b\d+:inventory:ALERT:inventory_alert:\d+$/.test(notifs[0]?.dedupeKey ?? ""), notifs[0]?.dedupeKey);
    check("it is open (not resolved)", notifs[0]?.resolvedAt === null);

    /* ── 2. delivery state: PUSH persisted, never sent ─────────────────────── */
    const push = notifs[0]?.deliveries.find((d) => d.channel === "PUSH");
    const inApp = notifs[0]?.deliveries.find((d) => d.channel === "IN_APP");
    check("policy granted both channels outside quiet hours",
      JSON.stringify(notifs[0]?.intendedChannels) === '["IN_APP","PUSH"]', JSON.stringify(notifs[0]?.intendedChannels));
    check("PUSH delivery is PENDING", push?.status === "PENDING", push?.status);
    check("no PUSH delivery is SENT or FAILED",
      notifs[0]?.deliveries.every((d) => d.channel !== "PUSH" || d.status === "PENDING") === true);
    check("IN_APP delivery is SENT", inApp?.status === "SENT", inApp?.status);
    check("zero external delivery attempts recorded beyond the two channels",
      notifs[0]?.deliveries.length === 2, `deliveries=${notifs[0]?.deliveries.length}`);

    /* ── 3. repeated movement dedupes ──────────────────────────────────────── */
    const second = await movementThenSync(a.id, itemA.id, -1, new Date(T0.getTime() + 60_000)); // 2 -> 1, still below
    const afterSecond = await prisma.notification.findMany({ where: { businessId: a.id, domain: "inventory" } });
    check("a second movement in the same condition creates no second notification",
      afterSecond.length === 1, `count=${afterSecond.length}`);
    check("the repeat did not re-notify (cooldown)", second.sync.written[0]?.notified === false);
    const deliveriesAfterSecond = await prisma.notificationDelivery.count({ where: { businessId: a.id } });
    check("the repeat added no delivery rows", deliveriesAfterSecond === 2, `deliveries=${deliveriesAfterSecond}`);

    /* ── 4. recovery resolves the notification ─────────────────────────────── */
    const third = await movementThenSync(a.id, itemA.id, +20, new Date(T0.getTime() + 120_000)); // 1 -> 21
    const openAlerts = await prisma.inventoryAlert.count({
      where: { businessId: a.id, itemId: itemA.id, type: "CRITICAL_STOCK", isResolved: false },
    });
    check("the domain resolved its alert", openAlerts === 0, `open=${openAlerts}`);
    check("the sync closed exactly one notification", third.sync.resolved === 1, `resolved=${third.sync.resolved}`);
    const resolvedRow = await prisma.notification.findFirst({ where: { businessId: a.id, domain: "inventory" } });
    check("resolvedAt is set", resolvedRow?.resolvedAt !== null);
    check("resolution did not delete the notification",
      (await prisma.notification.count({ where: { businessId: a.id, domain: "inventory" } })) === 1);

    /* ── 5. reappearance is a NEW occurrence, not a reopen ────────────────── */
    // The inventory domain identifies an alert by its ROW, and it never reuses a
    // resolved row: recovery closes alert #1 and a later drop mints alert #2.
    // entityRef.id therefore changes, so the dedupe key changes, so this is a
    // new notification rather than a reopen of the old one.
    //
    // That is the domain's identity model, not the writer's — the writer's
    // reopen path is real and proven in its own suite, it is simply unreachable
    // from here. Asserted explicitly so the day inventory starts reusing rows,
    // this test fails and someone re-reads this comment.
    const later = new Date(T0.getTime() + 25 * 3_600_000);
    const fourth = await movementThenSync(a.id, itemA.id, -19, later); // 21 -> 2, below min again
    const inventoryRows = await prisma.notification.findMany({
      where: { businessId: a.id, domain: "inventory" },
      orderBy: { id: "asc" },
      include: { deliveries: true },
    });
    check("a returning condition is recorded as a second, distinct notification",
      inventoryRows.length === 2, `count=${inventoryRows.length}`);
    check("the first notification stays resolved", inventoryRows[0]?.resolvedAt !== null);
    check("the new one is open", inventoryRows[1]?.resolvedAt === null);
    check("the two carry different alert ids",
      inventoryRows[0]?.entityId !== inventoryRows[1]?.entityId,
      `${inventoryRows[0]?.entityId} vs ${inventoryRows[1]?.entityId}`);
    check("the new occurrence notifies", fourth.sync.written[0]?.notified === true);
    check("the new occurrence is a creation, not a reopen",
      fourth.sync.written[0]?.created === true && fourth.sync.written[0]?.reopened === false);
    check("the new occurrence's PUSH is still only PENDING",
      inventoryRows[1]?.deliveries.filter((d) => d.channel === "PUSH").every((d) => d.status === "PENDING") === true);
    check("nothing was deleted along the way",
      (await prisma.notification.count({ where: { businessId: a.id, domain: "inventory" } })) === 2);

    /* ── 6. tenant isolation ───────────────────────────────────────────────── */
    await movementThenSync(b.id, itemB.id, -8, T0);
    const bNotifs = await prisma.notification.findMany({ where: { businessId: b.id, domain: "inventory" } });
    const aNotifs = await prisma.notification.findMany({
      where: { businessId: a.id, domain: "inventory" }, orderBy: { id: "asc" },
    });
    check("business B gets its own notification", bNotifs.length === 1);
    check("business A is unchanged by B's sync", aNotifs.length === 2);
    check("the dedupe keys differ across tenants", bNotifs[0]?.dedupeKey !== aNotifs[0]?.dedupeKey,
      `${bNotifs[0]?.dedupeKey} vs ${aNotifs[0]?.dedupeKey}`);
    check("B's sync did not resolve A's open notification", aNotifs[1]?.resolvedAt === null);
    check("B's row belongs to B", bNotifs[0]?.businessId === b.id);

    /* ── 7. a failing sync must not affect the committed movement ──────────── */
    // The tenant guard is the cheapest genuine failure: a mismatched businessId
    // makes the writer refuse, exercising the same catch a DB error would.
    const qtyBefore = (await prisma.inventoryItem.findUnique({ where: { id: itemA.id } }))!.currentQuantity;
    const notifsBefore = await prisma.notification.count({
      where: { businessId: { in: [a.id, b.id] }, domain: "inventory" },
    });
    const movement = await runWithTenantContext({ businessId: a.id }, () =>
      withTenantTransaction((tx) =>
        inventoryService.createMovement(
          {
            businessId: a.id,
            itemId: itemA.id,
            movementType: InventoryMovementType.OUT,
            reason: InventoryMovementReason.MANUAL_REMOVE,
            quantityDelta: -1,
          },
          { tx },
        ),
      ),
    );
    // Wrong tenant on purpose: the writer refuses, the sync absorbs it.
    const badSync = await runWithTenantContext({ businessId: a.id }, () =>
      syncInventoryAlertNotifications(b.id, later),
    );
    const qtyAfter = (await prisma.inventoryItem.findUnique({ where: { id: itemA.id } }))!.currentQuantity;
    check("a cross-tenant sync fails rather than writing", badSync.ok === false);
    check("the failure is reported as data, not thrown", typeof badSync.error === "string");
    check("the committed movement survived the notification failure", movement !== null);
    check("stock quantity reflects only the movement", qtyAfter === qtyBefore - 1, `${qtyBefore} -> ${qtyAfter}`);
    check("the failed sync wrote nothing for either tenant",
      (await prisma.notification.count({ where: { businessId: { in: [a.id, b.id] }, domain: "inventory" } })) === notifsBefore);

    /* ── 8. resolution scope ───────────────────────────────────────────────── */
    // A notification from another domain must never be closed by this consumer.
    await prisma.notification.create({
      data: {
        businessId: a.id, dedupeKey: `b${a.id}:documents:ACTION_REQUIRED:document:1`,
        domain: "documents", semanticCategory: "ACTION_REQUIRED", severity: "MEDIUM",
        entityType: "document", entityId: 1, title: "unrelated", href: "/documents",
        intendedChannels: ["IN_APP"], reason: "fixture", cooldownHours: 48,
      },
    });
    await movementThenSync(a.id, itemA.id, +50, later); // recovers -> resolves inventory
    const foreign = await prisma.notification.findFirst({ where: { businessId: a.id, domain: "documents" } });
    check("a foreign-domain notification is never resolved by this consumer", foreign?.resolvedAt === null);
  } finally {
    await prisma.business.deleteMany({ where: { id: { in: [a.id, b.id] } } });
    await prisma.$disconnect();
  }

  console.log(
    failures === 0
      ? `\nINVENTORY-ALERT CONSUMER: all checks passed\n`
      : `\nINVENTORY-ALERT CONSUMER: ${failures} FAILED\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("integration harness error:", err);
  process.exit(1);
});
