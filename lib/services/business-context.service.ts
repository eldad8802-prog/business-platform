import { getCurrentUser } from "@/lib/auth";
import { tenantTx } from "@/lib/tenant/tenant-tx";

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

  // BusinessProfile is FORCE RLS: read on the bare client its nested select came back null, so
  // video generation never received the category. Read under the business's tenant context.
  const business = await tenantTx(businessId, (tx) => tx.business.findUnique({
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
  }));

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