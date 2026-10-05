import { getBusinessSignals } from "@/features/signals/services/business-signals.service";
import { leadService } from "@/lib/services/crm/lead.service";
import { tenantTx } from "@/lib/tenant/tenant-tx";
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
    // `Lead` is FORCE ROW LEVEL SECURITY. Counted on the global client it
    // carries no `app.current_business_id`, and the restricted runtime returns 0
    // WITHOUT raising — which is what Production served (#658). The count runs
    // in the session business's own tenant transaction, exactly like
    // getBusinessSignals above; `businessId` comes from the authenticated user,
    // never from the request.
    //
    // Meaning is deliberately unchanged: this is the narrow "needs action" count
    // (follow-up due, or an untouched new lead from before today) — the SAME
    // predicate as /leads?view=needsAction, which `href` lands on.
    //
    // Best-effort: Home must still render if the Leads count fails. A missing
    // badge is a smaller failure than a blank home screen.
    tenantTx(businessId, (tx) => leadService.countNeedingAttention({ businessId }, { tx })).catch((err) => {
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