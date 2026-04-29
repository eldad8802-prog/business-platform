import { prisma } from "@/lib/prisma";

export async function learnVendorCategory({
  businessId,
  vendorName,
  category,
}: {
  businessId: number;
  vendorName: string;
  category: string;
}) {
  const cleanVendorName = vendorName.trim();
  const cleanCategory = category.trim();

  if (!cleanVendorName || !cleanCategory) {
    return;
  }

  const existing = await prisma.vendorLearning.findFirst({
    where: {
      businessId,
      vendorName: cleanVendorName,
      category: cleanCategory,
    },
  });

  if (!existing) {
    await prisma.vendorLearning.create({
      data: {
        businessId,
        vendorName: cleanVendorName,
        category: cleanCategory,
        usageCount: 1,
        confidence: 0.5,
        isGlobal: false,
        lastUsedAt: new Date(),
      },
    });

    return;
  }

  const nextUsageCount = existing.usageCount + 1;

  await prisma.vendorLearning.update({
    where: {
      id: existing.id,
    },
    data: {
      usageCount: nextUsageCount,
      confidence: nextUsageCount >= 2 ? 0.9 : 0.6,
      lastUsedAt: new Date(),
    },
  });
}