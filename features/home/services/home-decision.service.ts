import { HeroAction } from "../types/home.types";

type DecisionSignals = {
  hasOpenConversations: boolean;
  hasActivity: boolean;
  hasUnusedOffers: boolean;
};

export function getHomeHeroAction(signals: DecisionSignals): HeroAction {
  const { hasOpenConversations, hasActivity, hasUnusedOffers } = signals;

  if (hasOpenConversations) {
    return {
      actionKey: "CONVERSATIONS",
      title: "יש לך לקוחות שמחכים לתשובה",
      description: "ענה עכשיו לפני שהם מתקדמים הלאה",
      ctaLabel: "ענה ללקוחות",
      ctaHref: "/inbox",
      reason: "open_conversations",
    };
  }

  if (!hasActivity) {
    return {
      actionKey: "CONTENT",
      title: "אין פעילות כרגע",
      description: "בוא נייצר תוכן שיביא לקוחות",
      ctaLabel: "צור תוכן",
      ctaHref: "/content",
      reason: "no_activity",
    };
  }

  if (hasUnusedOffers) {
    return {
      actionKey: "OFFERS",
      title: "יש לך מבצע פעיל שאפשר לקדם",
      description: "היכנס לשכבת המבצעים והקופונים כדי להמשיך משם",
      ctaLabel: "פתח מבצעים וקופונים",
      ctaHref: "/revenue",
      reason: "active_offer",
    };
  }

  return {
    actionKey: "PRICING",
    title: "רוצה לשפר רווחיות?",
    description: "בדוק תמחור נכון לשירותים שלך",
    ctaLabel: "בדוק תמחור",
    ctaHref: "/pricing",
    reason: "fallback",
  };
}