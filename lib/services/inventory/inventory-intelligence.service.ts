import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

type TxOptions = { tx?: Prisma.TransactionClient };

type SuggestedAction =
  | {
      type: "CREATE_ITEM";
      suggestedName: string;
      confidence: number;
    }
  | {
      type: "LINK_EXISTING";
      itemId: number;
      itemName: string;
      confidence: number;
    };

type InventoryInsight = {
  type: "REPEATED_UNMATCHED_PRODUCT";
  key: string;
  count: number;
  message: string;
  severity: "LOW" | "MEDIUM" | "HIGH";
  suggestedActions: SuggestedAction[];
};

export const inventoryIntelligenceService = {
  async getInsights(
    businessId: number,
    options?: TxOptions
  ): Promise<InventoryInsight[]> {
    const db = options?.tx ?? prisma;
    const pending = await db.inventoryPendingMatch.findMany({
      where: {
        businessId,
        status: "PENDING",
      },
    });

    const items = await db.inventoryItem.findMany({
      where: {
        businessId,
        isActive: true,
      },
    });

    const counter: Record<string, number> = {};

    for (const p of pending) {
      const metadata = p.metadata as any;

      const key =
        metadata?.sku || metadata?.barcode || metadata?.name || "UNKNOWN";

      counter[key] = (counter[key] || 0) + 1;
    }

    const insights: InventoryInsight[] = [];

    for (const key in counter) {
      const count = counter[key];

      if (count < 3) continue;

      const severity: InventoryInsight["severity"] =
        count >= 5 ? "HIGH" : "MEDIUM";

      const matchedItem = items.find((item) =>
        item.name.toLowerCase().includes(key.toLowerCase())
      );

      const suggestedActions: SuggestedAction[] = [
        {
          type: "CREATE_ITEM",
          suggestedName: key,
          confidence: 0.7,
        },
      ];

      if (matchedItem) {
        suggestedActions.push({
          type: "LINK_EXISTING",
          itemId: matchedItem.id,
          itemName: matchedItem.name,
          confidence: 0.8,
        });
      }

      insights.push({
        type: "REPEATED_UNMATCHED_PRODUCT",
        key,
        count,
        severity,
        message: `המוצר "${key}" מופיע ${count} פעמים כמכירה לא מזוהה — כנראה שהוא לא מוגדר במלאי.`,
        suggestedActions,
      });
    }

    return insights;
  },
};