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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  InventoryMovementReason,
  InventoryMovementType,
  InventoryUnitType,
  PurchaseOrderStatus,
  SupplierPurchaseDraftStatus,
} from "@prisma/client";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

import { prisma } from "../prisma";
import { runWithTenantContext } from "../tenant/context";
import { withTenantTransaction } from "../tenant/transaction";
import { inventoryService } from "../services/inventory/inventory.service";
import { purchaseOrderService } from "../services/inventory/purchase-order.service";
import { receivingService } from "../services/inventory/receiving.service";
import { approveSupplierPurchase } from "../services/inventory/supplier-purchase-approval.service";
import {
  createPendingMatch,
  rejectPendingMatch,
  resolvePendingMatchWithExistingItem,
  resolvePendingMatchWithNewItem,
} from "../services/inventory/pending-match.service";
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
  const d = await prisma.business.create({ data: { name: "consumer-D-pos" } });
  const e = await prisma.business.create({ data: { name: "consumer-E-receiving" } });
  const g = await prisma.business.create({
    data: {
      name: "consumer-G-unmatched",
      users: { create: { email: `unmatched-${Date.now()}@example.test`, password: "x", name: "Owner" } },
    },
    include: { users: true },
  });
  const f = await prisma.business.create({
    data: {
      name: "consumer-F-approval",
      users: { create: { email: `approval-${Date.now()}@example.test`, password: "x", name: "Owner" } },
    },
    include: { users: true },
  });

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

    /* ── 13. POS shape: key-derived tenant, one sync, duplicate-safe ─────── */
    // Mirrors app/api/inventory/pos/sale/route.ts: the tenant comes from a
    // POSApiKey row, the whole ingest (duplicate check, matching, movements,
    // external-sale record) runs in ONE transaction, and reconciliation runs
    // once after the commit.
    const posKeyHash = "test-pos-key-hash-" + d.id;
    const posKey = await prisma.pOSApiKey.create({
      data: { businessId: d.id, keyHash: posKeyHash, source: "POS", active: true },
    });
    const posItem1 = await prisma.inventoryItem.create({
      data: { businessId: d.id, name: "pos-1", sku: "POS-SKU-1", unitType: InventoryUnitType.UNIT, currentQuantity: 10, minimumQuantity: 3 },
    });
    const posItem2 = await prisma.inventoryItem.create({
      data: { businessId: d.id, name: "pos-2", sku: "POS-SKU-2", unitType: InventoryUnitType.UNIT, currentQuantity: 10, minimumQuantity: 3 },
    });
    const posItem3 = await prisma.inventoryItem.create({
      data: { businessId: d.id, name: "pos-3", sku: "POS-SKU-3", unitType: InventoryUnitType.UNIT, currentQuantity: 10, minimumQuantity: 3 },
    });

    // TENANT AUTHORITY: resolved from the key row, exactly as the route does.
    // Note what is NOT consulted — no businessId is taken from the payload.
    const resolved = await prisma.pOSApiKey.findUnique({
      where: { keyHash: posKeyHash },
      select: { businessId: true, active: true },
    });
    check("the POS tenant is resolved from the key row",
      resolved?.businessId === d.id && resolved.active === true);

    async function posIngest(externalSaleId: string, lines: Array<{ sku: string; quantity: number }>, now: Date) {
      const posBusinessId = resolved!.businessId; // server-derived, never from the payload
      const outcome = await runWithTenantContext({ businessId: posBusinessId }, () =>
        withTenantTransaction(
          async (tx) => {
            const dup = await tx.inventoryExternalSale.findUnique({
              where: { businessId_externalSaleId: { businessId: posBusinessId, externalSaleId } },
            });
            if (dup) return { kind: "skipped" as const };
            for (const line of lines) {
              const item = await tx.inventoryItem.findFirst({
                where: { businessId: posBusinessId, sku: line.sku, isActive: true },
              });
              if (!item) continue;
              await inventoryService.removeStock(
                { businessId: posBusinessId, itemId: item.id, quantityDelta: line.quantity, reason: InventoryMovementReason.SALE },
                { tx },
              );
            }
            await tx.inventoryExternalSale.create({
              data: { businessId: posBusinessId, externalSaleId, source: "POS" },
            });
            return { kind: "processed" as const };
          },
          { timeoutMs: 20_000 },
        ),
      );
      const sync = await runWithTenantContext({ businessId: posBusinessId }, () =>
        syncInventoryAlertNotifications(posBusinessId, now),
      );
      return { outcome, sync };
    }

    const pos1 = await posIngest("SALE-001", [
      { sku: "POS-SKU-1", quantity: 8 },
      { sku: "POS-SKU-2", quantity: 9 },
      { sku: "POS-SKU-3", quantity: 1 },
    ], T0);
    let posRows = await inventoryNotifs(d.id);
    check("the POS sale was processed", pos1.outcome.kind === "processed" && pos1.sync.ok);
    check("ONE sync covered every line of the POS sale", posRows.length === 2, `notifications=${posRows.length}`);
    check("only the items that crossed the threshold notified",
      posRows.map((r) => r.entityId).sort((x, y) => x - y).join(",") ===
        [posItem1.id, posItem2.id].sort((x, y) => x - y).join(","),
      posRows.map((r) => r.entityId).join(","));
    check("the healthy POS item produced no notification",
      posRows.every((r) => r.entityId !== posItem3.id));
    check("notifications belong to the KEY's business",
      posRows.every((r) => r.businessId === posKey.businessId && r.businessId === d.id));
    check("identity is the item, reusing the existing logical model",
      posRows.every((r) => r.entityType === "inventory_item"));
    check("PUSH stays PENDING, IN_APP is SENT, nothing external",
      posRows.every((r) =>
        r.deliveries.length === 2 &&
        r.deliveries.find((x) => x.channel === "PUSH")?.status === "PENDING" &&
        r.deliveries.find((x) => x.channel === "IN_APP")?.status === "SENT"));

    // Duplicate delivery of the same externalSaleId: the domain skips it, and
    // the sync still runs but has nothing new to say.
    const posDup = await posIngest("SALE-001", [{ sku: "POS-SKU-1", quantity: 8 }], new Date(T0.getTime() + 60_000));
    const afterDup = await inventoryNotifs(d.id);
    check("a duplicate POS sale is skipped by the domain", posDup.outcome.kind === "skipped");
    check("a duplicate POS sale creates no new notification", afterDup.length === 2);
    check("a duplicate POS sale adds no delivery",
      afterDup.every((r) => r.deliveries.length === 2));
    check("a duplicate POS sale moved no stock",
      (await prisma.inventoryItem.findUnique({ where: { id: posItem1.id } }))!.currentQuantity === 2);

    // Cross-tenant: another business's key can never produce notifications here.
    const otherRowsBefore = await inventoryNotifs(c.id);
    const crossPos = await runWithTenantContext({ businessId: d.id }, () =>
      syncInventoryAlertNotifications(c.id, T0),
    );
    check("a POS sync for another business is refused", crossPos.ok === false);
    check("the other business's notifications are untouched",
      (await inventoryNotifs(c.id)).length === otherRowsBefore.length);

    /* ── 14. the POS route derives its tenant only from the key ──────────── */
    // Structural, because this is a security property the pure functions cannot
    // defend: the day someone reads a businessId out of the POS payload, this
    // fails rather than the guarantee quietly disappearing.
    const posRoute = readFileSync(
      join(REPO_ROOT, "app", "api", "inventory", "pos", "sale", "route.ts"), "utf8");
    const assigns = posRoute.split(/\r?\n/).filter((l) => /^\s*businessId = /.test(l));
    check("businessId is assigned exactly twice in the POS route", assigns.length === 2,
      JSON.stringify(assigns));
    check("both assignments are server-derived (key row, env)",
      assigns.some((l) => l.includes("dbKey.businessId")) && assigns.some((l) => l.includes("envBusinessId")));
    check("no businessId is ever read from the request payload",
      !/businessId\s*[:=]\s*(body|payload|request)\b/.test(posRoute) &&
      !/(body|payload)\.businessId/.test(posRoute));
    check("the POS sync is called with the server-derived tenant",
      /syncInventoryAlertNotifications\(businessId, new Date\(\)\)/.test(posRoute));
    check("the POS sync runs outside the transaction callback",
      posRoute.indexOf("syncInventoryAlertNotifications(businessId") >
      posRoute.indexOf('outcome.kind === "skipped"') - 1200);

    /* ── 15. receiving: the interesting outcome is RESOLUTION ────────────── */
    // Receiving adds stock, so the natural proof here is recovery, not a new
    // alert: an item that was critically low is replenished, the domain
    // resolves its alert, and the sync closes the matching notification.
    const recvItem = await mkItem(e.id, "recv-widget");

    // Drive it critical first, so there is something for receiving to resolve.
    const recvCritical = await movementThenSync(e.id, recvItem.id, -8, T0); // 10 -> 2
    let recvRows = await inventoryNotifs(e.id);
    check("a critical condition exists before receiving",
      recvRows.length === 1 && recvRows[0].resolvedAt === null && recvCritical.sync.ok);
    const recvNotificationId = recvRows[0]!.id;

    const supplier = await prisma.supplier.create({
      data: { businessId: e.id, name: "recv-supplier" },
    });
    const po = await purchaseOrderService.createPurchaseOrder({
      businessId: e.id,
      supplierId: supplier.id,
      status: PurchaseOrderStatus.CONFIRMED,
      lines: [{ itemId: recvItem.id, orderedQty: 20, unitCost: 5 }],
    });
    const session = await receivingService.createReceivingSession({
      businessId: e.id,
      purchaseOrderId: po.id,
      lines: [{ purchaseOrderLineId: po.lines[0].id, receivedQty: 20 }],
    });
    check("creating a DRAFT session moves no stock and notifies nothing",
      (await prisma.inventoryItem.findUnique({ where: { id: recvItem.id } }))!.currentQuantity === 2 &&
      (await inventoryNotifs(e.id)).length === 1);

    // Exactly what the post route does: commit, then reconcile.
    const posted = await runWithTenantContext({ businessId: e.id }, () =>
      withTenantTransaction(
        (tx) => receivingService.postReceivingSession(
          { businessId: e.id, receivingSessionId: session.id },
          { tx },
        ),
        { timeoutMs: 15_000 },
      ),
    );
    const recvSync = await runWithTenantContext({ businessId: e.id }, () =>
      syncInventoryAlertNotifications(e.id, new Date(T0.getTime() + 60_000)),
    );

    const qtyAfterReceiving = (await prisma.inventoryItem.findUnique({ where: { id: recvItem.id } }))!.currentQuantity;
    recvRows = await inventoryNotifs(e.id);
    check("the receipt committed and added stock", posted !== null && qtyAfterReceiving === 22, `qty=${qtyAfterReceiving}`);
    check("the domain resolved its alert after replenishment",
      (await prisma.inventoryAlert.count({ where: { itemId: recvItem.id, type: "CRITICAL_STOCK", isResolved: false } })) === 0);
    check("ONE sync closed the notification", recvSync.resolved === 1, `resolved=${recvSync.resolved}`);
    check("it is the same notification row, now resolved",
      recvRows.length === 1 && recvRows[0].id === recvNotificationId && recvRows[0].resolvedAt !== null);
    check("resolution deleted nothing", recvRows.length === 1);
    check("receiving added no delivery rows", recvRows[0]?.deliveries.length === 2);

    // A second post of the same session is refused by the DRAFT state guard.
    let secondPostThrew = false;
    try {
      await runWithTenantContext({ businessId: e.id }, () =>
        withTenantTransaction(
          (tx) => receivingService.postReceivingSession(
            { businessId: e.id, receivingSessionId: session.id },
            { tx },
          ),
          { timeoutMs: 15_000 },
        ),
      );
    } catch {
      secondPostThrew = true;
    }
    check("a second post of the same session is refused", secondPostThrew);
    check("the refused post moved no further stock",
      (await prisma.inventoryItem.findUnique({ where: { id: recvItem.id } }))!.currentQuantity === 22);
    check("the refused post changed no notification",
      (await inventoryNotifs(e.id)).length === 1);

    // Cross-tenant containment for this route's identity too.
    const recvCross = await runWithTenantContext({ businessId: e.id }, () =>
      syncInventoryAlertNotifications(d.id, T0),
    );
    check("a receiving sync for another business is refused", recvCross.ok === false);

    /* ── 16. the receiving route syncs only after a committed post ───────── */
    // Structural: a throw anywhere in the transaction must skip the sync, which
    // is true only while the call sits AFTER the awaited transaction and INSIDE
    // the try. If someone moves it, this fails rather than the guarantee
    // quietly becoming untrue.
    const recvRoute = readFileSync(
      join(REPO_ROOT, "app", "api", "inventory", "receiving-sessions", "[id]", "post", "route.ts"), "utf8");
    const txIdx = recvRoute.indexOf("withTenantTransaction");
    const syncIdx = recvRoute.indexOf("syncInventoryAlertNotifications(user.businessId");
    // The SUCCESS response, not the error handler — handleInventoryError also
    // returns NextResponse.json({...}) and sits earlier in the file.
    const respIdx = recvRoute.indexOf("success: true");
    const catchIdx = recvRoute.indexOf("} catch (error) {", txIdx);
    check("the receiving route calls the shared sync", syncIdx > 0);
    check("the sync runs after the transaction", syncIdx > txIdx);
    check("the sync runs before the success response", syncIdx < respIdx);
    check("the sync sits inside the try, so a throw skips it", syncIdx < catchIdx);
    check("the sync uses the server-derived tenant",
      /runWithTenantContext\(\{ businessId: user\.businessId \}/.test(recvRoute));
    check("exactly one sync call in the receiving route",
      (recvRoute.match(/syncInventoryAlertNotifications\(/g) || []).length === 1);

    /* ── 17. supplier-purchase approval: one compound committed fact ─────── */
    // This flow is not a simple receipt. ONE transaction creates the purchase
    // order, creates the receiving session, POSTS it into inventory, and marks
    // the draft approved. The sync therefore belongs after the whole thing, and
    // the proof is again resolution: goods arrive, the critical item recovers.
    const apprItem = await mkItem(f.id, "approval-widget");
    const apprUserId = f.users[0]!.id;

    const apprCritical = await movementThenSync(f.id, apprItem.id, -8, T0); // 10 -> 2
    let apprRows = await inventoryNotifs(f.id);
    check("a critical condition exists before approval",
      apprRows.length === 1 && apprRows[0].resolvedAt === null && apprCritical.sync.ok);
    const apprNotificationId = apprRows[0]!.id;

    const draft = await prisma.supplierPurchaseDraft.create({
      data: {
        businessId: f.id,
        supplierName: "approval-supplier",
        source: "MANUAL",
        status: SupplierPurchaseDraftStatus.PENDING_REVIEW,
        lines: { create: [{ rawName: "approval-widget", quantity: 20 }] },
      },
      include: { lines: true },
    });

    // Exactly what the approve route does: commit, then reconcile.
    const approved = await runWithTenantContext({ businessId: f.id }, () =>
      withTenantTransaction(
        (tx) => approveSupplierPurchase(
          {
            draftId: draft.id,
            businessId: f.id,
            userId: apprUserId,
            lines: [{ lineId: draft.lines[0]!.id, action: "MERGE", itemId: apprItem.id }],
          },
          { tx },
        ),
        { timeoutMs: 20_000 },
      ),
    );
    const apprSync = await runWithTenantContext({ businessId: f.id }, () =>
      syncInventoryAlertNotifications(f.id, new Date(T0.getTime() + 60_000)),
    );

    const apprQty = (await prisma.inventoryItem.findUnique({ where: { id: apprItem.id } }))!.currentQuantity;
    apprRows = await inventoryNotifs(f.id);
    check("the approval committed", approved !== null && apprSync.ok);
    check("the compound transaction received the goods once", apprQty === 22, `qty=${apprQty}`);
    check("a purchase order and a posted receiving session were created together",
      (await prisma.purchaseOrder.count({ where: { businessId: f.id } })) === 1 &&
      (await prisma.receivingSession.count({ where: { businessId: f.id, status: "POSTED" } })) === 1);
    check("the draft is APPROVED",
      (await prisma.supplierPurchaseDraft.findUnique({ where: { id: draft.id } }))!.status ===
        SupplierPurchaseDraftStatus.APPROVED);
    check("the domain resolved its alert after replenishment",
      (await prisma.inventoryAlert.count({ where: { itemId: apprItem.id, type: "CRITICAL_STOCK", isResolved: false } })) === 0);
    check("ONE sync closed the notification", apprSync.resolved === 1, `resolved=${apprSync.resolved}`);
    check("it is the same notification row, now resolved",
      apprRows.length === 1 && apprRows[0].id === apprNotificationId && apprRows[0].resolvedAt !== null);
    check("approval added no delivery rows", apprRows[0]?.deliveries.length === 2);
    check("nothing was deleted", apprRows.length === 1);

    // Repeat approval: the atomic PENDING_REVIEW -> APPROVED transition means
    // only one caller can ever win. A second attempt rolls the whole thing back.
    let secondApprovalThrew = false;
    try {
      await runWithTenantContext({ businessId: f.id }, () =>
        withTenantTransaction(
          (tx) => approveSupplierPurchase(
            {
              draftId: draft.id,
              businessId: f.id,
              userId: apprUserId,
              lines: [{ lineId: draft.lines[0]!.id, action: "MERGE", itemId: apprItem.id }],
            },
            { tx },
          ),
          { timeoutMs: 20_000 },
        ),
      );
    } catch {
      secondApprovalThrew = true;
    }
    check("a second approval of the same draft is refused", secondApprovalThrew);
    check("the refused approval applied no stock twice",
      (await prisma.inventoryItem.findUnique({ where: { id: apprItem.id } }))!.currentQuantity === 22);
    check("the refused approval created no second purchase order",
      (await prisma.purchaseOrder.count({ where: { businessId: f.id } })) === 1);
    check("the refused approval created no second receiving session",
      (await prisma.receivingSession.count({ where: { businessId: f.id } })) === 1);
    check("the refused approval changed no notification",
      (await inventoryNotifs(f.id)).length === 1);

    // Repeated synchronisation on unchanged truth changes nothing.
    const apprResync = await runWithTenantContext({ businessId: f.id }, () =>
      syncInventoryAlertNotifications(f.id, new Date(T0.getTime() + 120_000)),
    );
    const afterResync = await inventoryNotifs(f.id);
    check("a repeated sync writes nothing new",
      apprResync.ok && afterResync.length === 1 && afterResync[0].deliveries.length === 2);

    const apprCross = await runWithTenantContext({ businessId: f.id }, () =>
      syncInventoryAlertNotifications(e.id, T0),
    );
    check("an approval sync for another business is refused", apprCross.ok === false);

    /* ── 18. the approve route syncs only after the committed approval ───── */
    const apprRoute = readFileSync(
      join(REPO_ROOT, "app", "api", "inventory", "supplier-purchases", "[id]", "approve", "route.ts"), "utf8");
    const aTx = apprRoute.indexOf("withTenantTransaction");
    const aSync = apprRoute.indexOf("syncInventoryAlertNotifications(user.businessId");
    const aResp = apprRoute.indexOf("return NextResponse.json(result)");
    const aCatch = apprRoute.indexOf("} catch (error) {", aTx);
    check("the approve route calls the shared sync", aSync > 0);
    check("the sync runs after the approval transaction", aSync > aTx);
    check("the sync runs before the success response", aSync < aResp);
    check("the sync sits inside the try, so a rollback skips it", aSync < aCatch);
    check("the sync uses the server-derived tenant",
      /runWithTenantContext\(\{ businessId: user\.businessId \}/.test(apprRoute));
    check("exactly one sync call in the approve route",
      (apprRoute.match(/syncInventoryAlertNotifications\(/g) || []).length === 1);
    check("receiving.service still contains no notification logic",
      !readFileSync(join(REPO_ROOT, "lib", "services", "inventory", "receiving.service.ts"), "utf8")
        .includes("syncInventoryAlertNotifications"));

    /* ── 19. unmatched resolution: the path that DECREASES stock ─────────── */
    // Every other wired flow either adds stock (receiving, approval) or sells
    // matched goods. This one applies a POS line that could not be matched at
    // ingest time, so it is the path that can CREATE a critical-stock
    // notification at resolution time.
    const unmUserId = g.users[0]!.id;
    const unmItem = await mkItem(g.id, "unmatched-widget"); // qty 10, min 3

    const pending = await runWithTenantContext({ businessId: g.id }, () =>
      withTenantTransaction((tx) =>
        createPendingMatch(
          {
            businessId: g.id,
            externalSaleId: "UNMATCHED-001",
            metadata: { externalSaleId: "UNMATCHED-001", sku: null, barcode: null, name: "mystery", quantity: 8, source: "POS" },
          },
          { tx },
        ),
      ),
    );
    check("a pending match exists and moved no stock",
      pending !== null &&
      (await prisma.inventoryItem.findUnique({ where: { id: unmItem.id } }))!.currentQuantity === 10 &&
      (await inventoryNotifs(g.id)).length === 0);

    // LINK_EXISTING, exactly as the route runs it: commit, then reconcile.
    const linked = await runWithTenantContext({ businessId: g.id }, () =>
      withTenantTransaction(
        (tx) => resolvePendingMatchWithExistingItem(
          { pendingMatchId: pending.id, businessId: g.id, userId: unmUserId, itemId: unmItem.id },
          { tx },
        ),
        { timeoutMs: 15_000 },
      ),
    );
    const linkSync = await runWithTenantContext({ businessId: g.id }, () =>
      syncInventoryAlertNotifications(g.id, T0),
    );

    const unmQty = (await prisma.inventoryItem.findUnique({ where: { id: unmItem.id } }))!.currentQuantity;
    let unmRows = await inventoryNotifs(g.id);
    check("the resolution committed and decreased stock exactly once",
      linked !== null && unmQty === 2, `qty=${unmQty}`);
    check("the pending match is RESOLVED",
      (await prisma.inventoryPendingMatch.findUnique({ where: { id: pending.id } }))!.status === "RESOLVED");
    check("crossing the threshold CREATED a critical notification",
      unmRows.length === 1 && unmRows[0].severity === "CRITICAL" && unmRows[0].resolvedAt === null,
      `count=${unmRows.length}`);
    check("it is keyed on the item, reusing the existing identity",
      unmRows[0]?.entityType === "inventory_item" && unmRows[0]?.entityId === unmItem.id);
    check("the sync reported it", linkSync.ok && linkSync.written.length === 1);
    check("PUSH pending, IN_APP sent, nothing external",
      unmRows[0]?.deliveries.length === 2 &&
      unmRows[0]?.deliveries.find((x) => x.channel === "PUSH")?.status === "PENDING" &&
      unmRows[0]?.deliveries.find((x) => x.channel === "IN_APP")?.status === "SENT");

    // A second resolution of the same pending match cannot apply stock twice.
    let secondResolveThrew = false;
    try {
      await runWithTenantContext({ businessId: g.id }, () =>
        withTenantTransaction(
          (tx) => resolvePendingMatchWithExistingItem(
            { pendingMatchId: pending.id, businessId: g.id, userId: unmUserId, itemId: unmItem.id },
            { tx },
          ),
          { timeoutMs: 15_000 },
        ),
      );
    } catch {
      secondResolveThrew = true;
    }
    check("a second resolution is refused", secondResolveThrew);
    check("the refused resolution applied no stock twice",
      (await prisma.inventoryItem.findUnique({ where: { id: unmItem.id } }))!.currentQuantity === 2);
    check("the refused resolution changed no notification",
      (await inventoryNotifs(g.id)).length === 1);

    // REJECT moves no stock, so the route deliberately does not sync there.
    const pending2 = await runWithTenantContext({ businessId: g.id }, () =>
      withTenantTransaction((tx) =>
        createPendingMatch(
          {
            businessId: g.id,
            externalSaleId: "UNMATCHED-002",
            metadata: { externalSaleId: "UNMATCHED-002", sku: null, barcode: null, name: "mystery-2", quantity: 1, source: "POS" },
          },
          { tx },
        ),
      ),
    );
    const qtyBeforeReject = (await prisma.inventoryItem.findUnique({ where: { id: unmItem.id } }))!.currentQuantity;
    await runWithTenantContext({ businessId: g.id }, () =>
      withTenantTransaction((tx) =>
        rejectPendingMatch({ pendingMatchId: pending2.id, businessId: g.id, userId: unmUserId }, { tx }),
      ),
    );
    check("REJECT moves no stock",
      (await prisma.inventoryItem.findUnique({ where: { id: unmItem.id } }))!.currentQuantity === qtyBeforeReject);
    check("REJECT changed no notification", (await inventoryNotifs(g.id)).length === 1);

    /* ── 20. CREATE_NEW cannot commit — a pre-existing domain defect ─────── */
    // resolvePendingMatchWithNewItem creates the item at currentQuantity 0 and
    // immediately delegates to the existing-item resolver, which removes the
    // sale quantity. 0 - quantity is negative, so createMovement throws
    // NegativeInventoryError and the whole transaction rolls back.
    //
    // Asserted rather than assumed, and asserted as it ACTUALLY behaves. The
    // branch is wired at the correct post-commit position so it works the day
    // the domain defect is fixed, but nothing here pretends it commits today.
    const pending3 = await runWithTenantContext({ businessId: g.id }, () =>
      withTenantTransaction((tx) =>
        createPendingMatch(
          {
            businessId: g.id,
            externalSaleId: "UNMATCHED-003",
            metadata: { externalSaleId: "UNMATCHED-003", sku: null, barcode: null, name: "mystery-3", quantity: 5, source: "POS" },
          },
          { tx },
        ),
      ),
    );
    const itemsBefore = await prisma.inventoryItem.count({ where: { businessId: g.id } });
    const notifsBeforeNew = (await inventoryNotifs(g.id)).length;
    let newItemThrew = false;
    try {
      await runWithTenantContext({ businessId: g.id }, () =>
        withTenantTransaction(
          (tx) => resolvePendingMatchWithNewItem(
            {
              pendingMatchId: pending3.id,
              businessId: g.id,
              userId: unmUserId,
              itemData: { name: "brand-new", unitType: "UNIT" },
            },
            { tx },
          ),
          { timeoutMs: 15_000 },
        ),
      );
    } catch {
      newItemThrew = true;
    }
    check("CREATE_NEW rolls back: a new item starts at 0 and the sale goes negative", newItemThrew);
    check("the rolled-back branch left no orphan inventory item",
      (await prisma.inventoryItem.count({ where: { businessId: g.id } })) === itemsBefore);
    check("the rolled-back branch left the pending match PENDING",
      (await prisma.inventoryPendingMatch.findUnique({ where: { id: pending3.id } }))!.status === "PENDING");
    check("a rolled-back branch runs no sync and writes no notification",
      (await inventoryNotifs(g.id)).length === notifsBeforeNew);

    const unmCross = await runWithTenantContext({ businessId: g.id }, () =>
      syncInventoryAlertNotifications(f.id, T0),
    );
    check("an unmatched sync for another business is refused", unmCross.ok === false);

    /* ── 21. the resolve route: two syncs, and never on REJECT ───────────── */
    const unmRoute = readFileSync(
      join(REPO_ROOT, "app", "api", "inventory", "unmatched", "[id]", "resolve", "route.ts"), "utf8");
    const uLink = unmRoute.indexOf('body.action === "LINK_EXISTING"');
    const uNew = unmRoute.indexOf('body.action === "CREATE_NEW"');
    const uReject = unmRoute.indexOf('body.action === "REJECT"');
    const syncPositions = [...unmRoute.matchAll(/syncInventoryAlertNotifications\(user\.businessId/g)].map((m) => m.index);
    check("exactly two syncs in the resolve route", syncPositions.length === 2, `n=${syncPositions.length}`);
    check("one sync inside the LINK_EXISTING branch",
      syncPositions.some((i) => i > uLink && i < uNew));
    check("one sync inside the CREATE_NEW branch",
      syncPositions.some((i) => i > uNew && i < uReject));
    check("NO sync in the REJECT branch", !syncPositions.some((i) => i > uReject));
    check("both syncs use the server-derived tenant",
      (unmRoute.match(/runWithTenantContext\(\{ businessId: user\.businessId \}/g) || []).length >= 2);
    check("the route still supplies { tx } to the resolver",
      (unmRoute.match(/\{ tx \}/g) || []).length === 3);
    check("pending-match.service still contains no notification logic",
      !readFileSync(join(REPO_ROOT, "lib", "services", "inventory", "pending-match.service.ts"), "utf8")
        .includes("syncInventoryAlertNotifications"));
  } finally {
    const ids = [a.id, b.id, c.id, d.id, e.id, f.id, g.id];
    // ReceivingLine.itemId is RESTRICT, so it blocks the Business cascade from
    // reaching InventoryItem. Clear the receiving chain first; everything else
    // cascades from Business as usual.
    await prisma.receivingSession.deleteMany({ where: { businessId: { in: ids } } });
    await prisma.business.deleteMany({ where: { id: { in: ids } } });
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
