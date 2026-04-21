import { KnowledgePack } from "./internal-knowledge.service";
import { ExternalInsight } from "./external-insight.service";

export function mergeInsights(
  knowledge: KnowledgePack,
  external: ExternalInsight
) {
  return {
    hooks: [
      ...knowledge.hooks.desire,
      ...external.trendingHooks,
    ],

    topics: [
      ...knowledge.topics.product,
      ...external.hotTopics,
    ],

    angles: [
      ...knowledge.angles.visual,
      ...external.emergingAngles,
    ],
  };
}