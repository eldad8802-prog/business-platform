import { getBusinessSignals } from "@/features/signals/services/business-signals.service";
import { leadService } from "@/lib/services/crm/lead.service";
import { HomeResponse } from "../types/home.types";
import { getHomeHeroAction } from "./home-decision.service";
import { getHomeQuickActions } from "./home-shortcuts.service";

type GetHomeDataInput = {
  businessName: string;
  businessId: number;
  ownerName?: string;
};

export async function getHomeData(
  input: GetHomeDataInput
): Promise<HomeResponse> {
  const { businessName, businessId, ownerName } = input;

  const [signals, leadsNeedingAttention] = await Promise.all([
    getBusinessSignals({ businessId }),
    // Best-effort: Home must still render if the Leads count fails. A missing
    // badge is a smaller failure than a blank home screen.
    leadService
      .countNeedingAttention({ businessId })
      .catch((err) => {
        console.error("home leadsAttention count failed:", err);
        return 0;
      }),
  ]);

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
      ownerName: ownerName?.trim() || undefined,
    },
    leadsAttention: {
      count: leadsNeedingAttention,
      // Lands on exactly the rows the count came from.
      href: "/leads?view=needsAction",
    },
  };
}