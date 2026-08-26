import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { getTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

// D2/P7-W4D: run a single DB step on a short tenant transaction when a tenant
// context is established (all document routes set one); outside a context the
// step runs directly (pure unit tests / offline scripts). Under an
// established context there is NO fallback to the global client.
async function dbStep<T>(
  fn: (db: typeof prisma) => Promise<T>
): Promise<T> {
  if (getTenantContext() !== undefined) {
    // TransactionClient supports the same query surface these callbacks use;
    // the cast keeps precise select/include payload types.
    return withTenantTransaction((tx) => fn(tx as unknown as typeof prisma));
  }
  return fn(prisma);
}
import { CATEGORY_RULES } from "@/lib/constants/category-rules";

type CategoryResult = {
  category: string;
  confidence: "high" | "medium" | "low";
};

function getLearningConfidence(count: number): "high" | "medium" | "low" {
  if (count >= 3) return "high";
  if (count === 2) return "medium";
  return "low";
}

function matchKeyword(text: string): string | null {
  const lower = text.toLowerCase();

  for (const rule of CATEGORY_RULES) {
    for (const keyword of rule.keywords) {
      if (lower.includes(keyword.toLowerCase())) {
        return rule.category;
      }
    }
  }

  return null;
}

export async function decideCategory(
  businessId: number,
  vendorName: string,
  text: string
): Promise<CategoryResult> {
  // 1. learning
  const learning = await dbStep((db) => db.vendorLearning.findUnique({
    where: {
      businessId_vendorName: {
        businessId,
        vendorName,
      },
    },
  }));

  if (learning) {
    return {
      category: learning.category,
      confidence: getLearningConfidence(learning.usageCount),
    };
  }

  // 2. keyword
  const keyword = matchKeyword(text + " " + vendorName);
  if (keyword) {
    return {
      category: keyword,
      confidence: "medium",
    };
  }

  // 3. fallback
  return {
    category: "general",
    confidence: "low",
  };
}