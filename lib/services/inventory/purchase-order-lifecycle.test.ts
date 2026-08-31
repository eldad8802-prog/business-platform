// Purchase order lifecycle — the transition table, proven rather than asserted.
//
// The rule this pins down: CLOSED means the order's lifecycle is genuinely over
// (everything ordered has either arrived or been explicitly written off). It is
// NOT a synonym for "the owner pressed approve", and it must never be reached
// while goods are still expected — otherwise the receiving service refuses
// further receipts and the remaining stock can never be taken in.
//
// Each case below records action → previous status → new status, and the run
// prints the table it observed.
//
// Run: npx tsx --env-file=.env lib/services/inventory/purchase-order-lifecycle.test.ts

import assert from "node:assert/strict";
import {
  PurchaseOrderLineRemainingDecision,
  PurchaseOrderStatus,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { purchaseOrderService } from "@/lib/services/inventory/purchase-order.service";
import { receivingService } from "@/lib/services/inventory/receiving.service";
import { inventoryService } from "@/lib/services/inventory/inventory.service";
import {
  InventoryNotFoundError,
  InventoryValidationError,
} from "@/lib/services/inventory/inventory.errors";
import { supplierService } from "@/lib/services/inventory/supplier.service";

const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const table: Array<{ action: string; before: string; after: string }> = [];
let checks = 0;

function record(action: string, before: string, after: string) {
  table.push({ action, before, after });
}

function ok(name: string) {
  checks++;
  console.log(`PASS  ${name}`);
}

async function statusOf(id: number): Promise<PurchaseOrderStatus> {
  const row = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id } });
  return row.status;
}

/**
 * Can the receiving service still take goods in against this order?
 *
 * createReceivingSession runs the same guards a real receipt runs, so a session
 * that builds successfully proves the receiving screen would work. It is rolled
 * back immediately, so the probe changes nothing.
 *
 * A "no" must mean the DOMAIN refused — never that the database hiccuped. This
 * runs against a remote database, and an earlier version of this helper treated
 * every thrown error as "not reachable", so a transaction timeout silently
 * became a failed assertion about business rules. An unrecognised error is now
 * rethrown: a flaky gate that cries wolf is worse than no gate, because it
 * teaches everyone to re-run instead of read.
 */
async function receivingReachable(
  businessId: number,
  purchaseOrderId: number,
  purchaseOrderLineId: number
): Promise<boolean> {
  try {
    await prisma.$transaction(async (tx) => {
      await receivingService.createReceivingSession(
        {
          businessId,
          purchaseOrderId,
          lines: [{ purchaseOrderLineId, receivedQty: 1 }],
        },
        { tx }
      );
      throw new Error("__rollback__");
    });
    return true;
  } catch (err) {
    if (err instanceof Error && err.message === "__rollback__") return true;

    // The guards this probe is actually testing. Anything else is infrastructure.
    if (
      err instanceof InventoryValidationError ||
      err instanceof InventoryNotFoundError
    ) {
      return false;
    }

    throw err;
  }
}

async function main() {
  const biz = await prisma.business.create({
    data: {
      name: `POLifecycle ${runId}`,
      users: {
        create: {
          email: `po-lifecycle-${runId}@example.test`,
          password: "x",
          name: "Owner",
        },
      },
    },
    include: { users: true },
  });
  const businessId = biz.id;
  const userId = biz.users[0].id;

  try {
    const supplier = await supplierService.createSupplier({
      businessId,
      name: `ספק מחזור חיים ${runId}`,
    });

    const item = await inventoryService.createItemWithInitialStock({
      businessId,
      name: `פריט מחזור ${runId}`,
      unitType: "UNIT",
      initialQuantity: 0,
      minimumQuantity: 0,
      reorderPoint: 0,
      createdByUserId: userId,
    });

    // ── 1. Draft creation ───────────────────────────────────────────────────
    const draftPo = await purchaseOrderService.createPurchaseOrder({
      businessId,
      createdByUserId: userId,
      supplierId: supplier.id,
      lines: [{ itemId: item.id, orderedQty: 10, unitCost: 5 }],
    });
    record("create (no status given)", "—", await statusOf(draftPo.id));
    assert.equal(
      await statusOf(draftPo.id),
      PurchaseOrderStatus.DRAFT,
      "a new order defaults to DRAFT"
    );
    ok("1. draft creation → DRAFT");

    // ── 2. Confirmation WITHOUT any receipt ─────────────────────────────────
    // The invariant that matters most: confirming an order must not complete it.
    const po = await purchaseOrderService.createPurchaseOrder({
      businessId,
      createdByUserId: userId,
      supplierId: supplier.id,
      status: PurchaseOrderStatus.CONFIRMED,
      lines: [{ itemId: item.id, orderedQty: 10, unitCost: 5 }],
    });
    const afterConfirm = await statusOf(po.id);
    record("confirm PO (no goods received)", "DRAFT", afterConfirm);
    assert.equal(
      afterConfirm,
      PurchaseOrderStatus.CONFIRMED,
      "confirmation must NOT close an order whose goods have not arrived"
    );
    assert.notEqual(afterConfirm, PurchaseOrderStatus.CLOSED);
    ok("2. confirmation → CONFIRMED (not CLOSED, goods not yet received)");

    const lineId = po.lines[0].id;

    // ── 3. Receiving is reachable straight after confirmation ───────────────
    assert.ok(
      await receivingReachable(businessId, po.id, lineId),
      "receiving must be reachable on a confirmed order"
    );
    ok("3. intake opening: receiving reachable while CONFIRMED");

    // A confirmed, unreceived order is NOT history.
    const confirmedFresh = await purchaseOrderService.getPurchaseOrder({
      businessId,
      purchaseOrderId: po.id,
    });
    assert.equal(confirmedFresh.lines[0].receivedQty, 0);
    assert.equal(confirmedFresh.lines[0].openQty, 10);
    ok("3. confirmed order still reports its full quantity as open");

    // ── 4. Partial receipt ──────────────────────────────────────────────────
    const partial = await receivingService.createReceivingSession({
      businessId,
      purchaseOrderId: po.id,
      createdByUserId: userId,
      lines: [{ purchaseOrderLineId: lineId, receivedQty: 4 }],
    });
    await receivingService.postReceivingSession({
      businessId,
      receivingSessionId: partial.id,
      postedByUserId: userId,
    });

    const afterPartial = await statusOf(po.id);
    record("post partial receipt (4 of 10)", "CONFIRMED", afterPartial);
    assert.notEqual(
      afterPartial,
      PurchaseOrderStatus.CLOSED,
      "a partly received order must NOT be terminal"
    );
    assert.equal(afterPartial, PurchaseOrderStatus.AWAITING_DELIVERY);
    ok("4. partial receipt → AWAITING_DELIVERY (still open, not history)");

    // Still actionable: the remainder can be taken in.
    assert.ok(
      await receivingReachable(businessId, po.id, lineId),
      "the remainder must still be receivable after a partial receipt"
    );
    ok("4. partial receipt keeps the order actionable (remainder receivable)");

    const midway = await purchaseOrderService.getPurchaseOrder({
      businessId,
      purchaseOrderId: po.id,
    });
    assert.equal(midway.lines[0].receivedQty, 4);
    assert.equal(midway.lines[0].openQty, 6, "6 units still expected");
    ok("4. quantities stay truthful mid-flight (4 received / 6 open)");

    // ── 5. Full receipt ─────────────────────────────────────────────────────
    const rest = await receivingService.createReceivingSession({
      businessId,
      purchaseOrderId: po.id,
      createdByUserId: userId,
      lines: [{ purchaseOrderLineId: lineId, receivedQty: 6 }],
    });
    await receivingService.postReceivingSession({
      businessId,
      receivingSessionId: rest.id,
      postedByUserId: userId,
    });

    const afterFull = await statusOf(po.id);
    record("post remaining receipt (6 of 10)", "AWAITING_DELIVERY", afterFull);
    assert.equal(
      afterFull,
      PurchaseOrderStatus.CLOSED,
      "an order with nothing left open is terminal"
    );
    ok("5. full receipt → CLOSED (terminal, and only now)");

    const done = await purchaseOrderService.getPurchaseOrder({
      businessId,
      purchaseOrderId: po.id,
    });
    assert.equal(done.lines[0].receivedQty, 10);
    assert.equal(done.lines[0].openQty, 0);

    const stock = await prisma.inventoryItem.findUniqueOrThrow({
      where: { id: item.id },
    });
    assert.equal(stock.currentQuantity, 10, "both receipts reached stock");
    ok("5. inventory reflects both receipts (10 units)");

    // A terminal order refuses further receipts — which is exactly why reaching
    // CLOSED early would be destructive.
    assert.equal(
      await receivingReachable(businessId, po.id, lineId),
      false,
      "a closed order must refuse further receipts"
    );
    ok("5. CLOSED is genuinely terminal (further receipts refused)");

    // ── 6. Short-closing the remainder is also a terminal completion ─────────
    const shortPo = await purchaseOrderService.createPurchaseOrder({
      businessId,
      createdByUserId: userId,
      supplierId: supplier.id,
      status: PurchaseOrderStatus.CONFIRMED,
      lines: [{ itemId: item.id, orderedQty: 10, unitCost: 5 }],
    });
    const shortLineId = shortPo.lines[0].id;

    const shortSession = await receivingService.createReceivingSession({
      businessId,
      purchaseOrderId: shortPo.id,
      createdByUserId: userId,
      lines: [{ purchaseOrderLineId: shortLineId, receivedQty: 4 }],
    });
    await receivingService.postReceivingSession({
      businessId,
      receivingSessionId: shortSession.id,
      postedByUserId: userId,
    });
    assert.equal(await statusOf(shortPo.id), PurchaseOrderStatus.AWAITING_DELIVERY);

    // The owner declares the missing 6 will never arrive. Nothing is open after
    // this, so the order's life is over and it belongs in history.
    await purchaseOrderService.setPurchaseOrderLineRemainingDecision({
      businessId,
      purchaseOrderId: shortPo.id,
      purchaseOrderLineId: shortLineId,
      decidedByUserId: userId,
      remainingDecision: PurchaseOrderLineRemainingDecision.CLOSED_SHORT,
      remainingDecisionQty: 6,
    });

    const afterShortClose = await statusOf(shortPo.id);
    record(
      "close-short the remainder (6 written off)",
      "AWAITING_DELIVERY",
      afterShortClose
    );
    assert.equal(
      afterShortClose,
      PurchaseOrderStatus.CLOSED,
      "an order whose remainder is written off has nothing left open and is terminal"
    );
    ok("6. close-short of the remainder → CLOSED");

    // ── 7. A BACKORDER decision keeps the order alive ───────────────────────
    const backPo = await purchaseOrderService.createPurchaseOrder({
      businessId,
      createdByUserId: userId,
      supplierId: supplier.id,
      status: PurchaseOrderStatus.CONFIRMED,
      lines: [{ itemId: item.id, orderedQty: 10, unitCost: 5 }],
    });
    const backLineId = backPo.lines[0].id;
    const backSession = await receivingService.createReceivingSession({
      businessId,
      purchaseOrderId: backPo.id,
      createdByUserId: userId,
      lines: [{ purchaseOrderLineId: backLineId, receivedQty: 4 }],
    });
    await receivingService.postReceivingSession({
      businessId,
      receivingSessionId: backSession.id,
      postedByUserId: userId,
    });
    await purchaseOrderService.setPurchaseOrderLineRemainingDecision({
      businessId,
      purchaseOrderId: backPo.id,
      purchaseOrderLineId: backLineId,
      decidedByUserId: userId,
      remainingDecision: PurchaseOrderLineRemainingDecision.BACKORDER,
      remainingDecisionQty: 6,
    });
    const afterBackorder = await statusOf(backPo.id);
    record("backorder the remainder (6 still due)", "AWAITING_DELIVERY", afterBackorder);
    assert.equal(
      afterBackorder,
      PurchaseOrderStatus.AWAITING_DELIVERY,
      "a backordered remainder is still expected, so the order stays open"
    );
    assert.ok(
      await receivingReachable(businessId, backPo.id, backLineId),
      "a backordered remainder must remain receivable"
    );
    ok("7. backorder keeps the order open and receivable");

    console.log("\n| Action | Before | After |");
    console.log("| --- | --- | --- |");
    for (const row of table) {
      console.log(`| ${row.action} | ${row.before} | ${row.after} |`);
    }
    console.log(`\n${checks}/${checks} lifecycle checks passed`);
  } finally {
    await prisma.receivingLine.deleteMany({
      where: { receivingSession: { businessId } },
    });
    await prisma.receivingSession.deleteMany({ where: { businessId } });
    await prisma.business.deleteMany({ where: { id: businessId } });
    await prisma.$disconnect();
  }
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
