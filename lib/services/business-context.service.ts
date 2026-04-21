import { prisma } from "@/lib/prisma";

export type BusinessContext = {
  businessId?: number;
  businessName?: string;
  category?: string;
  subcategory?: string;
  city?: string;
  mainService?: string;
};

type CurrentUserLike = {
  id: number;
  businessId?: number | null;
};

function extractBearerToken(req: Request) {
  const authHeader = req.headers.get("authorization") || "";
  const [type, token] = authHeader.split(" ");

  if (type !== "Bearer" || !token) {
    return "";
  }

  return token.trim();
}

async function getCurrentUserFromRequest(
  req: Request
): Promise<CurrentUserLike | null> {
  const token = extractBearerToken(req);

  if (!token) {
    return null;
  }

  const userId = Number(token);

  if (!userId || Number.isNaN(userId)) {
    return null;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      businessId: true,
    },
  });

  if (!user) {
    return null;
  }

  return user;
}

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
  const currentUser = await getCurrentUserFromRequest(req);

  if (!currentUser?.businessId) {
    return {};
  }

  return await getBusinessContextByBusinessId(currentUser.businessId);
}