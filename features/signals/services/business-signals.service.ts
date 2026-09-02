import { tenantTx } from "../../../lib/tenant/tenant-tx";

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
    // CUTOVER-2A: these three counts drive derived business state (the home
    // surface reads hasConversations/hasOffers/hasPricingProfiles). Conversation
    // and PricingProfile are tenant-owned, so on the global client they carry no
    // `app.current_business_id`. Under the restricted runtime every count would
    // return 0 WITHOUT raising, and the product would confidently report "this
    // business has nothing" — a wrong answer served as a successful one. The reads
    // are sequential inside one tenant transaction rather than Promise.all,
    // because a transaction client is a single connection.
    const [conversationsCount, offersCount, pricingProfilesCount] = await tenantTx(
      businessId,
      async (tx) => [
        await tx.conversation.count({
          where: {
            businessId,
          },
        }),
        await tx.offer.count({
          where: {
            issuingBusinessId: businessId,
            isActive: true,
          },
        }),
        await tx.pricingProfile.count({
          where: {
            businessId,
            isActive: true,
          },
        }),
      ]
    );

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