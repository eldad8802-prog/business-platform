import { prisma } from "../../../lib/prisma";

export type BusinessSignals = {
  hasConversations: boolean;
  hasOffers: boolean;
  hasPricingProfiles: boolean;
};

type GetBusinessSignalsInput = {
  businessId: number;
};

export async function getBusinessSignals(
  input: GetBusinessSignalsInput
): Promise<BusinessSignals> {
  const { businessId } = input;

  try {
    const [conversationsCount, offersCount, pricingProfilesCount] =
      await Promise.all([
        prisma.conversation.count({
          where: {
            businessId,
          },
        }),
        prisma.offer.count({
          where: {
            issuingBusinessId: businessId,
            isActive: true,
          },
        }),
        prisma.pricingProfile.count({
          where: {
            businessId,
            isActive: true,
          },
        }),
      ]);

    return {
      hasConversations: conversationsCount > 0,
      hasOffers: offersCount > 0,
      hasPricingProfiles: pricingProfilesCount > 0,
    };
  } catch (error) {
    console.error("getBusinessSignals error:", error);

    return {
      hasConversations: false,
      hasOffers: false,
      hasPricingProfiles: false,
    };
  }
}