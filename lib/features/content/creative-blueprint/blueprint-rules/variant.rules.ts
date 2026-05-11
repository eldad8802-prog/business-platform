import type { BusinessContentProfile } from "@/lib/services/business-content-profile.service";
import type {
  CreativeBlueprint,
  AttentionStrategy,
  InterruptionStyle,
  PacingCurve,
  CtaPsychology,
  NarrationTone,
  StorytellingModel,
  VisualStrategy,
  SoundtrackStrategy,
  SubtitleBehavior,
} from "../types";

export type VariantStyle = "direct" | "explanatory" | "trust";

// ─── Per-field adapters ───────────────────────────────────────────────────────

function directAttentionStrategy(base: AttentionStrategy): AttentionStrategy {
  // Direct wants hard, fast interruption — not slow curiosity builds
  if (base === "curiosity_gap") return "pattern_break";
  if (base === "authority_open") return "result_first";
  return base; // pattern_break, pain_mirror, result_first stay
}

function explanatoryAttentionStrategy(base: AttentionStrategy): AttentionStrategy {
  // Explanatory opens a question or mirrors pain, then explains
  if (base === "pattern_break") return "curiosity_gap";
  if (base === "result_first") return "curiosity_gap";
  return base; // pain_mirror, authority_open, curiosity_gap stay
}

function trustAttentionStrategy(base: AttentionStrategy): AttentionStrategy {
  // Trust variant should not open aggressively — lead with credibility or empathy
  if (base === "pattern_break") return "authority_open";
  if (base === "result_first") return "pain_mirror";
  return base;
}

// ─────────────────────────────────────────────────────────────────────────────

function directInterruptionStyle(base: InterruptionStyle): InterruptionStyle {
  // Direct wants bold, fast interruption
  if (base === "question") return "bold_claim";
  return base; // verbal_hook, bold_claim, visual_shock stay
}

function explanatoryInterruptionStyle(base: InterruptionStyle): InterruptionStyle {
  // Explanatory opens with a question — draws viewer into the explanation
  if (base === "visual_shock") return "verbal_hook";
  if (base === "bold_claim") return "question";
  return base;
}

function trustInterruptionStyle(base: InterruptionStyle): InterruptionStyle {
  // Trust never opens with shock or bold claim — verbal or question only
  if (base === "visual_shock") return "question";
  if (base === "bold_claim") return "verbal_hook";
  return base;
}

// ─────────────────────────────────────────────────────────────────────────────

function directPacingCurve(base: PacingCurve): PacingCurve {
  if (base === "slow_then_fast") return "fast_throughout";
  if (base === "steady") return "fast_throughout";
  return base; // fast_throughout, fast_then_slow stay
}

function explanatoryPacingCurve(base: PacingCurve): PacingCurve {
  if (base === "fast_throughout") return "steady";
  if (base === "fast_then_slow") return "steady";
  return base; // slow_then_fast, steady stay
}

function trustPacingCurve(base: PacingCurve): PacingCurve {
  if (base === "fast_throughout") return "steady";
  if (base === "fast_then_slow") return "slow_then_fast";
  return base; // steady, slow_then_fast stay
}

// ─────────────────────────────────────────────────────────────────────────────

function directCtaPsychology(
  base: CtaPsychology,
  profile: BusinessContentProfile
): CtaPsychology {
  // Luxury/premium override — don't push urgency on premium brands
  if (profile.brandPersona === "luxury" || profile.brandPersona === "premium") {
    return "trust";
  }
  // Direct always pushes toward urgency or social proof
  if (base === "curiosity") return "urgency";
  if (base === "trust") return "urgency";
  return base; // urgency, social_proof stay
}

function explanatoryCtaPsychology(base: CtaPsychology): CtaPsychology {
  // Explanatory earns the CTA through understanding — never urgency
  if (base === "urgency") return "curiosity";
  if (base === "social_proof") return "trust";
  return base; // curiosity, trust stay
}

function trustCtaPsychology(base: CtaPsychology): CtaPsychology {
  // Trust variant closes with reassurance, not pressure
  if (base === "urgency") return "social_proof";
  if (base === "curiosity") return "trust";
  return base; // trust, social_proof stay
}

// ─────────────────────────────────────────────────────────────────────────────

function directNarrationTone(base: NarrationTone): NarrationTone {
  if (base === "warm") return "confident";
  if (base === "intimate") return "confident";
  // authoritative stays: direct for authority businesses = sharper authority, not shouted urgency
  return base; // authoritative, confident, urgent stay
}

function explanatoryNarrationTone(base: NarrationTone): NarrationTone {
  if (base === "urgent") return "authoritative";
  if (base === "intimate") return "warm";
  return base; // authoritative, warm, confident stay
}

function trustNarrationTone(base: NarrationTone): NarrationTone {
  if (base === "urgent") return "warm";
  if (base === "confident") return "authoritative";
  return base; // authoritative, warm, intimate stay
}

// ─────────────────────────────────────────────────────────────────────────────

function directStorytellingModel(base: StorytellingModel): StorytellingModel {
  if (base === "local_trust") return "problem_agitation";
  if (base === "documentary_realism") return "problem_agitation";
  if (base === "authority") return "objection_collapse";
  return base; // transformation, proof_escalation, objection_collapse, problem_agitation, curiosity_gap, expert_dominance stay
}

function explanatoryStorytellingModel(base: StorytellingModel): StorytellingModel {
  if (base === "local_trust") return "authority";
  if (base === "transformation") return "proof_escalation";
  if (base === "problem_agitation") return "objection_collapse";
  if (base === "documentary_realism") return "expert_dominance";
  return base; // authority, proof_escalation, objection_collapse, expert_dominance, curiosity_gap stay
}

function trustStorytellingModel(base: StorytellingModel): StorytellingModel {
  if (base === "problem_agitation") return "proof_escalation";
  if (base === "curiosity_gap") return "documentary_realism";
  if (base === "objection_collapse") return "authority";
  return base; // local_trust, documentary_realism, proof_escalation, authority, expert_dominance stay
}

// ─────────────────────────────────────────────────────────────────────────────

function explanatoryVisualStrategy(
  base: VisualStrategy,
  profile: BusinessContentProfile
): VisualStrategy {
  // Explanatory benefits from graphic / data-driven visuals
  if (base === "hybrid" || base === "stock_footage") {
    if (
      profile.marketCategory === "technology" ||
      profile.marketCategory === "education" ||
      profile.contentStyle === "explanation"
    ) {
      return "motion_graphics";
    }
    if (
      profile.marketCategory === "finance" ||
      profile.marketCategory === "legal"
    ) {
      return "typography_heavy";
    }
  }
  return base; // all other strategies stay
}

function trustVisualStrategy(
  base: VisualStrategy,
  profile: BusinessContentProfile
): VisualStrategy {
  // Trust prefers authenticity or premium stillness — not generic stock
  if (base === "stock_footage" || base === "hybrid") {
    if (profile.brandPersona === "luxury" || profile.brandPersona === "premium") {
      return "luxury_minimal";
    }
    if (
      profile.brandPersona === "personal" ||
      profile.brandPersona === "friendly" ||
      profile.marketCategory === "home" ||
      profile.marketCategory === "health"
    ) {
      return "local_authentic";
    }
  }
  return base; // local_authentic, luxury_minimal, motion_graphics, typography_heavy stay
}

// ─────────────────────────────────────────────────────────────────────────────

function trustSoundtrackStrategy(base: SoundtrackStrategy): SoundtrackStrategy {
  if (base === "energetic") return "subtle";
  return base; // none, subtle, emotional stay
}

function directSubtitleBehavior(base: SubtitleBehavior): SubtitleBehavior {
  // Direct always uses subtitles — no missing the message
  if (base === "minimal") return "always_on";
  return base;
}

// ─── Main adapter ─────────────────────────────────────────────────────────────

/**
 * Adapts a base CreativeBlueprint for a specific variant style.
 * Pure function — no side effects, no mutations.
 * Returns base unchanged if no specific adaptations apply.
 */
export function adaptBlueprintForVariant(
  base: CreativeBlueprint,
  variantStyle: VariantStyle,
  profile: BusinessContentProfile
): CreativeBlueprint {
  switch (variantStyle) {
    case "direct":
      return {
        ...base,
        attention_strategy: directAttentionStrategy(base.attention_strategy),
        interruption_style: directInterruptionStyle(base.interruption_style),
        pacing_curve: directPacingCurve(base.pacing_curve),
        cta_psychology: directCtaPsychology(base.cta_psychology, profile),
        narration_tone: directNarrationTone(base.narration_tone),
        storytelling_model: directStorytellingModel(base.storytelling_model),
        subtitle_behavior: directSubtitleBehavior(base.subtitle_behavior),
        // visual_strategy and visual_identity stay — direct doesn't change visual world
        // soundtrack_strategy stays — direct doesn't change audio world
        blueprint_reasoning: `${base.blueprint_reasoning} | variant:direct → urgency/speed/conversion`,
      };

    case "explanatory":
      return {
        ...base,
        attention_strategy: explanatoryAttentionStrategy(base.attention_strategy),
        interruption_style: explanatoryInterruptionStyle(base.interruption_style),
        pacing_curve: explanatoryPacingCurve(base.pacing_curve),
        cta_psychology: explanatoryCtaPsychology(base.cta_psychology),
        narration_tone: explanatoryNarrationTone(base.narration_tone),
        storytelling_model: explanatoryStorytellingModel(base.storytelling_model),
        visual_strategy: explanatoryVisualStrategy(base.visual_strategy, profile),
        // subtitle_behavior stays — explanatory doesn't force always_on
        // soundtrack stays — explanatory doesn't change audio
        blueprint_reasoning: `${base.blueprint_reasoning} | variant:explanatory → depth/clarity/curiosity`,
      };

    case "trust":
      return {
        ...base,
        attention_strategy: trustAttentionStrategy(base.attention_strategy),
        interruption_style: trustInterruptionStyle(base.interruption_style),
        pacing_curve: trustPacingCurve(base.pacing_curve),
        cta_psychology: trustCtaPsychology(base.cta_psychology),
        narration_tone: trustNarrationTone(base.narration_tone),
        storytelling_model: trustStorytellingModel(base.storytelling_model),
        visual_strategy: trustVisualStrategy(base.visual_strategy, profile),
        soundtrack_strategy: trustSoundtrackStrategy(base.soundtrack_strategy),
        // subtitle_behavior stays per trust variant
        blueprint_reasoning: `${base.blueprint_reasoning} | variant:trust → credibility/safety/social-proof`,
      };

    default:
      return base;
  }
}
