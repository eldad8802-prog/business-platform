import type { HumanInsight } from "@/lib/features/content/human-insight/types";

export type StoryPremise = {
  openingMoment:    string;
  protagonist:      string;
  emotionalCore:    string;
  conflict:         string;
  escalation:       string;
  turningPoint:     string;
  emotionalPayoff:  string;
  marketingMeaning: string;
  sceneProgression: string[];
};

export type StoryPremiseInput = {
  businessLabel:         string;
  mainOfferLabel:        string;
  audienceLabel:         string;
  goalLabel:             string;
  humanInsight:          HumanInsight;
  businessCategory?:     string;
  contentGoalPrompt?:    string;
  directionTitle?:       string;
  directionDescription?: string;
  platform?:             string;
  structure?:            string[];
  durationSeconds?:      number;
};
