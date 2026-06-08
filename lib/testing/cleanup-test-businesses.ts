import { prisma } from "@/lib/prisma";

/**
 * FK-safe teardown for isolated QA scripts that create throwaway Business rows.
 * Clears billing/financial children first (H1b-1 Restrict targets) before business removal.
 */
export async function deleteTestBusinesses(businessIds: number[]): Promise<void> {
  if (businessIds.length === 0) {
    return;
  }

  const ids = [...new Set(businessIds)];

  await prisma.billingAuditEvent.deleteMany({
    where: { businessId: { in: ids } },
  });

  const billingDocumentIds = (
    await prisma.billingDocument.findMany({
      where: { businessId: { in: ids } },
      select: { id: true },
    })
  ).map((row) => row.id);

  if (billingDocumentIds.length > 0) {
    await prisma.billingDocumentLine.deleteMany({
      where: { billingDocumentId: { in: billingDocumentIds } },
    });
  }

  await prisma.financialEvent.deleteMany({
    where: { businessId: { in: ids } },
  });
  await prisma.billingDocument.deleteMany({
    where: { businessId: { in: ids } },
  });
  await prisma.billingDocumentNumberSequence.deleteMany({
    where: { businessId: { in: ids } },
  });

  await prisma.receivingLine.deleteMany({
    where: { receivingSession: { businessId: { in: ids } } },
  });
  await prisma.receivingSession.deleteMany({
    where: { businessId: { in: ids } },
  });
  await prisma.purchaseOrderLine.deleteMany({
    where: { purchaseOrder: { businessId: { in: ids } } },
  });
  await prisma.purchaseOrder.deleteMany({
    where: { businessId: { in: ids } },
  });
  await prisma.supplierPurchaseDraftLine.deleteMany({
    where: { draft: { businessId: { in: ids } } },
  });
  await prisma.supplierPurchaseDraft.deleteMany({
    where: { businessId: { in: ids } },
  });
  await prisma.inventoryMovement.deleteMany({
    where: { businessId: { in: ids } },
  });
  await prisma.inventoryAlert.deleteMany({
    where: { item: { businessId: { in: ids } } },
  });
  await prisma.inventoryItem.deleteMany({
    where: { businessId: { in: ids } },
  });
  await prisma.supplier.deleteMany({
    where: { businessId: { in: ids } },
  });

  await prisma.appointment.deleteMany({
    where: { businessId: { in: ids } },
  });
  await prisma.message.deleteMany({
    where: { businessId: { in: ids } },
  });
  await prisma.conversation.deleteMany({
    where: { businessId: { in: ids } },
  });

  await prisma.redemptionEvent.deleteMany({
    where: {
      OR: [
        { issuingBusinessId: { in: ids } },
        { redeemingBusinessId: { in: ids } },
      ],
    },
  });
  await prisma.coupon.deleteMany({
    where: { issuingBusinessId: { in: ids } },
  });
  await prisma.offer.deleteMany({
    where: { issuingBusinessId: { in: ids } },
  });

  await prisma.productUsageEvent.deleteMany({
    where: { businessId: { in: ids } },
  });
  await prisma.user.deleteMany({
    where: { businessId: { in: ids } },
  });
  await prisma.business.deleteMany({
    where: { id: { in: ids } },
  });
}
