export type HumanInsight = {
  humanSituation: string;
  emotionalInterpretation: string;
  hiddenTruth: string;
  tension: string;
  narrativeOpportunity: string;
  viewerFeeling: string;
  payoff: string;
  creativeRoute: string;
  israeliCommunicationDirection: string;
};

export type HumanInsightInput = {
  businessLabel: string;
  mainOfferLabel: string;
  audienceLabel: string;
  goalLabel: string;
  businessCategory?: string;
  directionTitle?: string;
  directionDescription?: string;
  contentGoalPrompt?: string;
  hookStyle?: string;
  contentAngle?: string;
  /** Routes already used by earlier variants in this generation run — steer away from them. */
  avoidCreativeRoutes?: string[];
};
