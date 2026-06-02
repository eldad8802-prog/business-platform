import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export type BusinessContext = {
  businessId?: number;
  businessName?: string;
  category?: string;
  subcategory?: string;
  city?: string;
  mainService?: string;
};

export async function getBusinessContextByBusinessId(
  businessId?: number | null
): Promise<BusinessContext> {
  if (!businessId) {
    return {};
  }

  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: {
      id: true,
      name: true,
      profile: {
        select: {
          category: true,
          subCategory: true,
        },
      },
    },
  });

  if (!business) {
    return {};
  }

  return {
    businessId: business.id,
    businessName: business.name || undefined,
    category: business.profile?.category || undefined,
    subcategory: business.profile?.subCategory || undefined,
    city: undefined,
    mainService: undefined,
  };
}

export async function getCurrentBusinessContext(
  req: Request
): Promise<BusinessContext> {
  const currentUser = await getCurrentUser(req);

  if (!currentUser?.businessId) {
    return {};
  }

  return await getBusinessContextByBusinessId(currentUser.businessId);
}