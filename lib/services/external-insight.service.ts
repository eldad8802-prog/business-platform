export type ExternalInsight = {
  hotTopics: string[];
  trendingHooks: string[];
  emergingAngles: string[];
};

export function getExternalInsight(): ExternalInsight {
  return {
    hotTopics: ["מנה חדשה", "שילוב מפתיע"],
    trendingHooks: ["זה הדבר הכי ממכר שתראה היום"],
    emergingAngles: ["food challenge", "reaction"],
  };
}