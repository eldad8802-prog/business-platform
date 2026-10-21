import { he } from "@/lib/i18n/messages/he";
import { createTranslator, type Translator } from "@/lib/i18n/translate";
import { HeroAction } from "../types/home.types";

const HE_T: Translator = createTranslator(he);

type DecisionSignals = {
  hasOpenConversations: boolean;
  hasActivity: boolean;
  hasUnusedOffers: boolean;
};

export function getHomeHeroAction(signals: DecisionSignals, t: Translator = HE_T): HeroAction {
  const { hasOpenConversations, hasActivity, hasUnusedOffers } = signals;

  if (hasOpenConversations) {
    return {
      actionKey: "CONVERSATIONS",
      title: t("insights.home.hero.conversationsTitle"),
      description: t("insights.home.hero.conversationsDescription"),
      ctaLabel: t("insights.home.hero.conversationsCta"),
      ctaHref: "/inbox",
      reason: "open_conversations",
    };
  }

  if (!hasActivity) {
    return {
      actionKey: "CONTENT",
      title: t("insights.home.hero.contentTitle"),
      description: t("insights.home.hero.contentDescription"),
      ctaLabel: t("insights.home.hero.contentCta"),
      ctaHref: "/content",
      reason: "no_activity",
    };
  }

  if (hasUnusedOffers) {
    return {
      actionKey: "OFFERS",
      title: t("insights.home.hero.offersTitle"),
      description: t("insights.home.hero.offersDescription"),
      ctaLabel: t("insights.home.hero.offersCta"),
      ctaHref: "/revenue",
      reason: "active_offer",
    };
  }

  return {
    actionKey: "PRICING",
    title: t("insights.home.hero.pricingTitle"),
    description: t("insights.home.hero.pricingDescription"),
    ctaLabel: t("insights.home.hero.pricingCta"),
    ctaHref: "/pricing",
    reason: "fallback",
  };
}