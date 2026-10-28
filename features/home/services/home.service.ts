import { getBusinessSignals } from "@/features/signals/services/business-signals.service";
import { leadService } from "@/lib/services/crm/lead.service";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import { he } from "@/lib/i18n/messages/he";
import { createTranslator, type Translator } from "@/lib/i18n/translate";
import { HomeResponse } from "../types/home.types";
import { getHomeHeroAction } from "./home-decision.service";
import { getHomeQuickActions } from "./home-shortcuts.service";

type GetHomeDataInput = {
  businessName: string;
  businessId: number;
  ownerName?: string;
  /** Interface-language translator (the route passes getServerI18n's). Default: Hebrew. */
  t?: Translator;
};

const HE_T: Translator = createTranslator(he);

export async function getHomeData(
  input: GetHomeDataInput
): Promise<HomeResponse> {
  const { businessName, businessId, ownerName } = input;
  const t = input.t ?? HE_T;

  const [signals, leadsNeedingAttention] = await Promise.all([
    getBusinessSignals({ businessId }),
    // `Lead` is FORCE ROW LEVEL SECURITY. Counted on the global client it
    // carries no `app.current_business_id`, and the restricted runtime returns 0
    // WITHOUT raising — which is what Production served (#658). The count runs
    // in the session business's own tenant transaction, exactly like
    // getBusinessSignals above; `businessId` comes from the authenticated user,
    // never from the request.
    //
    // Meaning (Leads L1 · G-05 / G-03): the length of the ONE attention queue —
    // the SAME set /leads?view=needsAction (which `href` lands on) and the Home
    // items read, a NEW lead from today included.
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
  }, t);

  const quickActions = getHomeQuickActions(t);

  return {
    heroAction,
    quickActions,
    businessSnapshot: {
      businessName,
      greeting: t("insights.home.greeting", { name: businessName }),
      ownerName: ownerName?.trim() || undefined,
    },
    leadsAttention: {
      count: leadsNeedingAttention,
      // Lands on exactly the rows the count came from.
      href: "/leads?view=needsAction",
    },
  };
}