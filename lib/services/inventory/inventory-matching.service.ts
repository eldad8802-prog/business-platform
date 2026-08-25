import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

type TxOptions = { tx?: Prisma.TransactionClient };

export async function findInventoryMatches({
  businessId,
  draft,
}: {
  businessId: number;
  draft: any;
}, options?: TxOptions) {
  const db = options?.tx ?? prisma;
  const items = await db.inventoryItem.findMany({
    where: {
      businessId,
      isActive: true,
    },
  });

  const matches: any[] = [];

  for (const item of items) {
    let score = 0;
    let reason = "UNKNOWN";

    // 1. Barcode match
    if (
      draft.detectedBarcode &&
      item.barcode &&
      draft.detectedBarcode === item.barcode
    ) {
      score = 100;
      reason = "EXACT_BARCODE";
    }

    // 2. Name similarity
    else if (
      draft.detectedName &&
      item.name.toLowerCase().includes(draft.detectedName.toLowerCase())
    ) {
      score = 70;
      reason = "NAME_MATCH";
    }

    // 3. Category
    else if (
      draft.detectedCategory &&
      draft.detectedCategory === "Hair Care"
    ) {
      score = 40;
      reason = "CATEGORY_MATCH";
    }

    if (score > 0) {
      matches.push({
        itemId: item.id,
        itemName: item.name,
        matchScore: score,
        reason,
      });
    }
  }

  return matches.sort((a, b) => b.matchScore - a.matchScore);
}