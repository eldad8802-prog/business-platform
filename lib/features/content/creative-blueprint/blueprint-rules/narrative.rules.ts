import type { BusinessContentProfile } from "@/lib/services/business-content-profile.service";
import type { ContentDecision, Goal, ContentAngle } from "@/lib/features/content/decision";
import type { StorytellingModel, AttentionStrategy } from "../types";

export function resolveStorytellingModel(
  profile: BusinessContentProfile,
  decision: ContentDecision,
  goal?: Goal,
  contentAngle?: ContentAngle
): StorytellingModel {
  const { contentStyle, emotionalDriver, trustLevel, salesCycle, marketCategory, brandPersona } =
    profile;

  // Explicit angle overrides
  if (contentAngle === "show_difference") {
    // Contrast angle → collapse the objection to competition
    return trustLevel === "high" ? "objection_collapse" : "proof_escalation";
  }

  if (contentAngle === "trust") {
    // Trust angle → authority or local depending on brand persona
    return brandPersona === "personal" || brandPersona === "friendly"
      ? "local_trust"
      : "authority";
  }

  // Content style is the primary driver
  if (contentStyle === "transformation") return "transformation";

  if (contentStyle === "authority") {
    // Long sales cycle authority → build up slowly before offering
    if (salesCycle === "long") return "authority";
    // Short cycle authority → expert dominance is punchier
    return "expert_dominance";
  }

  if (contentStyle === "testimonial") {
    // Proof escalation for testimonials: small → big → close
    return "proof_escalation";
  }

  if (contentStyle === "demonstration") {
    // Demonstration with pain driver → agitate the problem first
    if (emotionalDriver === "pain" || emotionalDriver === "convenience") {
      return "problem_agitation";
    }
    // Demonstration with desire → show the result
    return "transformation";
  }

  if (contentStyle === "explanation") {
    // Explanation for high-trust markets → authority-led
    if (
      trustLevel === "high" &&
      (marketCategory === "finance" ||
        marketCategory === "legal" ||
        marketCategory === "health")
    ) {
      return "objection_collapse";
    }
    return "problem_agitation";
  }

  if (contentStyle === "offer") {
    // Offer with instant sales cycle → fast problem agitation
    if (salesCycle === "instant") return "problem_agitation";
    return "proof_escalation";
  }

  // Fallback by goal
  if (goal === "trust") return "authority";
  if (goal === "leads") return "problem_agitation";
  if (goal === "sales") return "transformation";
  if (goal === "exposure") return "curiosity_gap";

  return "problem_agitation";
}

export function resolveAttentionStrategy(
  profile: BusinessContentProfile,
  decision: ContentDecision
): AttentionStrategy {
  const { hookPriority, trustLevel, brandPersona } = profile;
  const hookStyle = decision.legacyMapping.hookStyle;

  // The hook style from the decision engine is authoritative
  switch (hookStyle) {
    case "pattern_break":
      return "pattern_break";
    case "pain_first":
      return "pain_mirror";
    case "result_first":
      return "result_first";
    case "trust_first":
      // High trust + professional → authority open works best
      return trustLevel === "high" && brandPersona !== "personal"
        ? "authority_open"
        : "pain_mirror";
    case "offer_first":
      return "curiosity_gap";
    default:
      // Profile hook priority as secondary signal
      switch (hookPriority) {
        case "pattern_break": return "pattern_break";
        case "pain_first":    return "pain_mirror";
        case "result_first":  return "result_first";
        case "trust_first":   return "authority_open";
        case "offer_first":   return "curiosity_gap";
        default:              return "pain_mirror";
      }
  }
}
