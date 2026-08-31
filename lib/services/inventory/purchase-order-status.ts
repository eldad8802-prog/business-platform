import {
  Prisma,
  PurchaseOrderLineRemainingDecision,
  PurchaseOrderLineStatus,
  PurchaseOrderStatus,
  ReceivingSessionStatus,
} from "@prisma/client";

type Tx = Prisma.TransactionClient;

/**
 * Where a purchase order actually is, derived from its lines.
 *
 * WHY THIS EXISTS AS ITS OWN MODULE: two different events change what is still
 * expected from a supplier — posting a receipt (goods arrived) and writing off a
 * remainder (goods will never arrive). They live in two different services, and
 * when only the first of them settled the order, an order whose remainder was
 * short-closed sat in "בדרך" forever with nothing actually outstanding. One
 * shared rule, owned by neither caller, is what keeps them from disagreeing.
 *
 * THE RULE, and the reason for it:
 *   something still expected → AWAITING_DELIVERY   ("בדרך")
 *   nothing left expected    → CLOSED              ("היסטוריה")
 *
 * CLOSED is terminal in the strong sense: the receiving service refuses to take
 * goods in against a closed order. So reaching it early is not a cosmetic error,
 * it strands real stock — which is exactly why confirming an order must never
 * close it, and why only these two events may move the status at all.
 *
 * No status is invented here. DRAFT and CONFIRMED are set at creation; SENT is
 * part of the enum but no code path produces it; CANCELLED has no producer
 * either (order cancellation is not implemented). This function never assigns
 * any of them, and never moves an order that is already terminal.
 */
export async function settlePurchaseOrderStatus(
  tx: Tx,
  input: { businessId: number; purchaseOrderId: number }
): Promise<void> {
  // ONE round trip: the order, its lines, and each line's POSTED receipts. This
  // can run inside an already long approval transaction, so nesting the receipts
  // into the same read keeps the added cost to a single statement.
  const purchaseOrder = await tx.purchaseOrder.findFirst({
    where: { id: input.purchaseOrderId, businessId: input.businessId },
    select: {
      id: true,
      status: true,
      lines: {
        select: {
          id: true,
          status: true,
          orderedQty: true,
          remainingDecision: true,
          remainingDecisionQty: true,
          receivingLines: {
            where: {
              receivingSession: { status: ReceivingSessionStatus.POSTED },
            },
            select: { receivedQty: true },
          },
        },
      },
    },
  });

  if (!purchaseOrder) return;

  if (
    purchaseOrder.status === PurchaseOrderStatus.CLOSED ||
    purchaseOrder.status === PurchaseOrderStatus.CANCELLED
  ) {
    return;
  }

  const hasOpenQuantity = purchaseOrder.lines.some((line) => {
    // A cancelled line is not owed by anyone, so it never holds an order open.
    if (line.status === PurchaseOrderLineStatus.CANCELLED) return false;

    const received = line.receivingLines.reduce(
      (sum, r) => sum + r.receivedQty,
      0
    );

    // CLOSED_SHORT is the owner saying "this will never arrive", so it settles
    // the quantity exactly like a receipt does. BACKORDER and KEEP_OPEN say the
    // opposite — still expected — and deliberately do NOT reduce what is open.
    const closedShort =
      line.remainingDecision ===
      PurchaseOrderLineRemainingDecision.CLOSED_SHORT
        ? line.remainingDecisionQty ?? 0
        : 0;

    return line.orderedQty - received - closedShort > 0;
  });

  const nextStatus = hasOpenQuantity
    ? PurchaseOrderStatus.AWAITING_DELIVERY
    : PurchaseOrderStatus.CLOSED;

  if (nextStatus === purchaseOrder.status) return;

  await tx.purchaseOrder.update({
    where: { id: purchaseOrder.id },
    data: { status: nextStatus },
  });
}
