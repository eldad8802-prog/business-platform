import { prisma } from "@/lib/prisma";
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
  const learning = await prisma.vendorLearning.findUnique({
    where: {
      businessId_vendorName: {
        businessId,
        vendorName,
      },
    },
  });

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