import { getBusinessSignals } from "@/features/signals/services/business-signals.service";
import { HomeResponse } from "../types/home.types";
import { getHomeHeroAction } from "./home-decision.service";
import { getHomeQuickActions } from "./home-shortcuts.service";

type GetHomeDataInput = {
  businessName: string;
  businessId: number;
};

export async function getHomeData(
  input: GetHomeDataInput
): Promise<HomeResponse> {
  const { businessName, businessId } = input;

  const signals = await getBusinessSignals({ businessId });

  const heroAction = getHomeHeroAction({
    hasOpenConversations: signals.hasConversations,
    hasActivity:
      signals.hasConversations ||
      signals.hasOffers ||
      signals.hasPricingProfiles,
    hasUnusedOffers: signals.hasOffers,
  });

  const quickActions = getHomeQuickActions();

  return {
    heroAction,
    quickActions,
    businessSnapshot: {
      businessName,
      greeting: `שלום ${businessName}`,
    },
  };
}