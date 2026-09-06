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
 * THE IDENTITY THIS PROVES
 *
 *   InventoryAlert = one EPISODE.   The domain never reuses a resolved row.
 *   Notification   = one CONDITION. Keyed on the item, so episodes of the same
 *                                   problem collapse into one notification that
 *                                   resolves and reopens.
 *
 * That distinction is why a stock level oscillating around its threshold no
 * longer re-notifies on every dip.
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
import { translateInventoryAlerts } from "../business-status/translators/inventory";

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
const HOUR = 3_600_000;

const inventoryNotifs = (businessId: number) =>
  prisma.notification.findMany({
    where: { businessId, domain: "inventory" },
    orderBy: { id: "asc" },
    include: { deliveries: true },
  });

(async () => {
  const a = await prisma.business.create({ data: { name: "consumer-A" } });
  const b = await prisma.business.create({ data: { name: "consumer-B" } });

  const mkItem = (businessId: number, name: string) =>
    prisma.inventoryItem.create({
      data: { businessId, name, unitType: InventoryUnitType.UNIT, currentQuantity: 10, minimumQuantity: 3 },
    });

  const itemA = await mkItem(a.id, "widget-A");
  const itemA2 = await mkItem(a.id, "widget-A2");
  const itemB = await mkItem(b.id, "widget-B");
  const c = await prisma.business.create({ data: { name: "consumer-C-sales" } });

  try {
    /* ── 1. first critical episode creates the notification ────────────────── */
    const first = await movementThenSync(a.id, itemA.id, -8, T0); // 10 -> 2, below min 3
    check("the movement itself succeeded", first.movement !== null && first.sync.ok);
    check("the domain raised one CRITICAL_STOCK alert",
      (await prisma.inventoryAlert.count({ where: { itemId: itemA.id, type: "CRITICAL_STOCK", isResolved: false } })) === 1);

    let rows = await inventoryNotifs(a.id);
    check("exactly one notification was persisted", rows.length === 1, `count=${rows.length}`);
    check("it is the CRITICAL inventory alert",
      rows[0]?.semanticCategory === "ALERT" && rows[0]?.severity === "CRITICAL");
    check("identity is the ITEM, not the alert row",
      rows[0]?.entityType === "inventory_item" && rows[0]?.entityId === itemA.id,
      `${rows[0]?.entityType}:${rows[0]?.entityId} (item=${itemA.id})`);
    check("dedupe key is the logical condition",
      rows[0]?.dedupeKey === `b${a.id}:inventory:ALERT:inventory_item:${itemA.id}`, rows[0]?.dedupeKey);
    check("it is open", rows[0]?.resolvedAt === null);
    const notificationId = rows[0]!.id;

    /* ── 2. delivery state: PUSH persisted, never sent ─────────────────────── */
    check("policy granted both channels outside quiet hours",
      JSON.stringify(rows[0]?.intendedChannels) === '["IN_APP","PUSH"]');
    check("PUSH delivery is PENDING",
      rows[0]?.deliveries.find((d) => d.channel === "PUSH")?.status === "PENDING");
    check("IN_APP delivery is SENT",
      rows[0]?.deliveries.find((d) => d.channel === "IN_APP")?.status === "SENT");
    check("no PUSH delivery is ever SENT or FAILED",
      rows[0]?.deliveries.every((d) => d.channel !== "PUSH" || d.status === "PENDING") === true);
    check("exactly two delivery rows", rows[0]?.deliveries.length === 2, `n=${rows[0]?.deliveries.length}`);

    /* ── 3. still critical: no duplicate ───────────────────────────────────── */
    const second = await movementThenSync(a.id, itemA.id, -1, new Date(T0.getTime() + 60_000)); // 2 -> 1
    rows = await inventoryNotifs(a.id);
    check("a second movement in the same condition creates no second notification", rows.length === 1);
    check("the repeat did not re-notify (cooldown)", second.sync.written[0]?.notified === false);
    check("the repeat added no delivery rows", rows[0]?.deliveries.length === 2);

    /* ── 4. recovery resolves the notification ─────────────────────────────── */
    const third = await movementThenSync(a.id, itemA.id, +20, new Date(T0.getTime() + 2 * 60_000)); // 1 -> 21
    check("the domain resolved its alert",
      (await prisma.inventoryAlert.count({ where: { itemId: itemA.id, type: "CRITICAL_STOCK", isResolved: false } })) === 0);
    check("the sync closed exactly one notification", third.sync.resolved === 1, `resolved=${third.sync.resolved}`);
    rows = await inventoryNotifs(a.id);
    check("resolvedAt is set", rows[0]?.resolvedAt !== null);
    check("resolution did not delete the notification", rows.length === 1);

    /* ── 5. FLICKER: critical again INSIDE the 24h cooldown ────────────────── */
    // The domain mints a SECOND alert episode here. The notification must not
    // follow it: same item, same condition, so the same row reopens silently.
    const flicker = await movementThenSync(a.id, itemA.id, -19, new Date(T0.getTime() + HOUR)); // 21 -> 2
    const episodes = await prisma.inventoryAlert.count({ where: { itemId: itemA.id, type: "CRITICAL_STOCK" } });
    rows = await inventoryNotifs(a.id);
    check("the domain recorded a SECOND alert episode", episodes === 2, `episodes=${episodes}`);
    check("the notification identity stayed stable — still one row", rows.length === 1, `count=${rows.length}`);
    check("it is the same notification row", rows[0]?.id === notificationId);
    check("the flicker reopened it (resolvedAt cleared)", rows[0]?.resolvedAt === null);
    check("the writer reported a reopen, not a creation",
      flicker.sync.written[0]?.reopened === true && flicker.sync.written[0]?.created === false);
    check("FLICKER INSIDE COOLDOWN DID NOT RE-NOTIFY", flicker.sync.written[0]?.notified === false);
    check("no owner-facing delivery was added during cooldown",
      rows[0]?.deliveries.length === 2, `deliveries=${rows[0]?.deliveries.length}`);
    check("the cooldown anchor survived the reopen",
      rows[0]?.lastNotifiedAt?.getTime() === T0.getTime(), rows[0]?.lastNotifiedAt?.toISOString());

    /* ── 6. recurrence AFTER the cooldown ──────────────────────────────────── */
    const after = new Date(T0.getTime() + 25 * HOUR);
    const renotify = await movementThenSync(a.id, itemA.id, -1, after); // 2 -> 1, still critical
    rows = await inventoryNotifs(a.id);
    check("past the cooldown the same condition notifies again", renotify.sync.written[0]?.notified === true);
    check("still exactly one notification row", rows.length === 1, `count=${rows.length}`);
    check("a re-notification appends deliveries, never removes",
      rows[0]?.deliveries.length === 4, `deliveries=${rows[0]?.deliveries.length}`);
    check("the new PUSH attempt is still only PENDING",
      rows[0]?.deliveries.filter((d) => d.channel === "PUSH").every((d) => d.status === "PENDING") === true);

    /* ── 7. two items in one business stay independent ─────────────────────── */
    await movementThenSync(a.id, itemA2.id, -8, after);
    rows = await inventoryNotifs(a.id);
    check("a second item produces its own notification", rows.length === 2, `count=${rows.length}`);
    check("the two carry different item identities",
      rows[0]?.entityId !== rows[1]?.entityId && rows[1]?.entityId === itemA2.id);
    check("their dedupe keys differ", rows[0]?.dedupeKey !== rows[1]?.dedupeKey);

    /* ── 8. tenants stay independent ───────────────────────────────────────── */
    await movementThenSync(b.id, itemB.id, -8, T0);
    const bRows = await inventoryNotifs(b.id);
    const aRows = await inventoryNotifs(a.id);
    check("business B gets its own notification", bRows.length === 1);
    check("business A is unchanged by B's sync", aRows.length === 2);
    check("dedupe keys differ across tenants", bRows[0]?.dedupeKey !== aRows[0]?.dedupeKey,
      `${bRows[0]?.dedupeKey} vs ${aRows[0]?.dedupeKey}`);
    check("B's row belongs to B", bRows[0]?.businessId === b.id);

    /* ── 9. null itemId falls back to the episode identity ─────────────────── */
    // Asserted on the translator directly: the domain only produces item-less
    // alerts for UNMATCHED_POS_PRODUCT, which the policy silences, so no DB path
    // would exercise this branch honestly.
    const itemless = translateInventoryAlerts([
      { id: 4242, type: "UNMATCHED_POS_PRODUCT", message: null, createdAt: T0, itemId: null, itemName: null },
      { id: 4243, type: "UNMATCHED_POS_PRODUCT", message: null, createdAt: T0, itemId: null, itemName: null },
    ] as Parameters<typeof translateInventoryAlerts>[0]);
    check("an item-less alert keeps the alert-row identity",
      itemless[0]?.entityRef.type === "inventory_alert" && itemless[0]?.entityRef.id === 4242,
      `${itemless[0]?.entityRef.type}:${itemless[0]?.entityRef.id}`);
    check("two item-less episodes do not collide with each other",
      itemless[0]?.entityRef.id !== itemless[1]?.entityRef.id);
    check("the fallback cannot collide with an item identity (different namespace)",
      itemless.every((i) => i.entityRef.type !== "inventory_item"));

    /* ── 10. a failing sync must not affect the committed movement ─────────── */
    const qtyBefore = (await prisma.inventoryItem.findUnique({ where: { id: itemA.id } }))!.currentQuantity;
    const notifsBefore = await prisma.notification.count({
      where: { businessId: { in: [a.id, b.id] }, domain: "inventory" },
    });
    const movement = await runWithTenantContext({ businessId: a.id }, () =>
      withTenantTransaction((tx) =>
        inventoryService.createMovement(
          {
            businessId: a.id, itemId: itemA.id,
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
      syncInventoryAlertNotifications(b.id, after),
    );
    const qtyAfter = (await prisma.inventoryItem.findUnique({ where: { id: itemA.id } }))!.currentQuantity;
    check("a cross-tenant sync fails rather than writing", badSync.ok === false);
    check("the failure is reported as data, not thrown", typeof badSync.error === "string");
    check("the committed movement survived the notification failure", movement !== null);
    check("stock quantity reflects only the movement", qtyAfter === qtyBefore - 1, `${qtyBefore} -> ${qtyAfter}`);
    check("the failed sync wrote nothing for either tenant",
      (await prisma.notification.count({ where: { businessId: { in: [a.id, b.id] }, domain: "inventory" } })) === notifsBefore);

    /* ── 11. resolution scope ──────────────────────────────────────────────── */
    await prisma.notification.create({
      data: {
        businessId: a.id, dedupeKey: `b${a.id}:documents:ACTION_REQUIRED:document:1`,
        domain: "documents", semanticCategory: "ACTION_REQUIRED", severity: "MEDIUM",
        entityType: "document", entityId: 1, title: "unrelated", href: "/documents",
        intendedChannels: ["IN_APP"], reason: "fixture", cooldownHours: 48,
      },
    });
    await movementThenSync(a.id, itemA.id, +50, after); // recovers -> resolves inventory
    const foreign = await prisma.notification.findFirst({ where: { businessId: a.id, domain: "documents" } });
    check("a foreign-domain notification is never resolved by this consumer", foreign?.resolvedAt === null);
    check("nothing was deleted anywhere",
      (await prisma.notification.count({ where: { businessId: a.id } })) === 3);

    /* ── 12. sales shape: several items, ONE transaction, ONE sync ───────── */
    // Mirrors app/api/inventory/sales/route.ts: a sale moves many items inside
    // a single tenant transaction, and the reconciliation runs once after the
    // commit. The sync reconciles the whole inventory domain for the business,
    // so one call covers every item the sale touched — there is no per-item
    // loop to get wrong.
    const saleItem1 = await mkItem(c.id, "sale-widget-1");
    const saleItem2 = await mkItem(c.id, "sale-widget-2");
    const saleItem3 = await mkItem(c.id, "sale-widget-3"); // stays healthy

    const saleMovements = await runWithTenantContext({ businessId: c.id }, () =>
      withTenantTransaction(
        async (tx) => {
          const out = [];
          for (const line of [
            { itemId: saleItem1.id, quantity: 8 },
            { itemId: saleItem2.id, quantity: 9 },
            { itemId: saleItem3.id, quantity: 1 },
          ]) {
            out.push(
              await inventoryService.removeStock(
                {
                  businessId: c.id,
                  itemId: line.itemId,
                  quantityDelta: line.quantity,
                  reason: InventoryMovementReason.SALE,
                },
                { tx },
              ),
            );
          }
          return out;
        },
        { timeoutMs: 15_000 },
      ),
    );
    const saleSync = await runWithTenantContext({ businessId: c.id }, () =>
      syncInventoryAlertNotifications(c.id, T0),
    );

    const saleRows = await inventoryNotifs(c.id);
    check("the whole sale committed", saleMovements.length === 3 && saleSync.ok);
    check("ONE sync covered every item the sale touched",
      saleRows.length === 2, `notifications=${saleRows.length}`);
    check("only the items that crossed the threshold notified",
      saleRows.map((r) => r.entityId).sort((x, y) => x - y).join(",") ===
        [saleItem1.id, saleItem2.id].sort((x, y) => x - y).join(","),
      saleRows.map((r) => r.entityId).join(","));
    check("the healthy item produced no notification",
      saleRows.every((r) => r.entityId !== saleItem3.id));
    check("each is keyed on its own item",
      saleRows.every((r) => r.entityType === "inventory_item") &&
      new Set(saleRows.map((r) => r.dedupeKey)).size === 2);
    check("each notified once, PUSH pending only",
      saleRows.every((r) => r.deliveries.length === 2 &&
        r.deliveries.filter((d) => d.channel === "PUSH").every((d) => d.status === "PENDING")));
    check("the sale's notifications belong to the selling business",
      saleRows.every((r) => r.businessId === c.id));

    // A repeat sale on the same still-critical items must stay quiet.
    const repeatSale = await runWithTenantContext({ businessId: c.id }, () =>
      withTenantTransaction((tx) =>
        inventoryService.removeStock(
          { businessId: c.id, itemId: saleItem1.id, quantityDelta: 1, reason: InventoryMovementReason.SALE },
          { tx },
        ),
      ),
    );
    const repeatSync = await runWithTenantContext({ businessId: c.id }, () =>
      syncInventoryAlertNotifications(c.id, new Date(T0.getTime() + 60_000)),
    );
    const afterRepeat = await inventoryNotifs(c.id);
    check("a repeat sale committed", repeatSale !== null && repeatSync.ok);
    check("a repeat sale creates no new notification", afterRepeat.length === 2);
    check("a repeat sale adds no delivery",
      afterRepeat.every((r) => r.deliveries.length === 2));
  } finally {
    await prisma.business.deleteMany({ where: { id: { in: [a.id, b.id, c.id] } } });
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
