import type { StorytellingModel } from "@/lib/features/content/creative-blueprint/types";
import type { BusinessContentProfile } from "@/lib/services/business-content-profile.service";
import type { NarrativeBeat, NarrativeBuildInput, NarrativeProfile, StoryDensity } from "./types";

// ─── Platform ceilings / floor ────────────────────────────────────────────────

const PLATFORM_CEILING: Record<string, number> = {
  tiktok:    60,
  instagram: 90,
  facebook:  105,
};
const DURATION_FLOOR  = 30;
const DEFAULT_CEILING = 105;

// ─── Multipliers ──────────────────────────────────────────────────────────────

const PACING_MULTIPLIER: Record<"fast" | "medium" | "slow", number> = {
  fast:   0.82,
  medium: 1.0,
  slow:   1.15,
};

const DENSITY_BEAT_MULTIPLIER: Record<StoryDensity, number> = {
  light:  0.8,
  medium: 1.0,
  rich:   1.25,
};

// ─── Internal beat template ───────────────────────────────────────────────────

type BeatTemplate = {
  role: string;
  emotionalFunction: string;
  baseDuration: number;
  retentionDriver: string;
};

// ─── Beat patterns ────────────────────────────────────────────────────────────
// All patterns guarantee no two consecutive beats share the same emotionalFunction.

const BEAT_PATTERNS: Record<StorytellingModel, BeatTemplate[]> = {
  transformation: [
    { role: "hook",    emotionalFunction: "interruption",   baseDuration: 4,  retentionDriver: "עוצר גלילה" },
    { role: "context", emotionalFunction: "identification", baseDuration: 8,  retentionDriver: "הכרה עצמית" },
    { role: "pain",    emotionalFunction: "pain",           baseDuration: 8,  retentionDriver: "אמפתיה" },
    { role: "reveal",  emotionalFunction: "revelation",     baseDuration: 8,  retentionDriver: "מפנה" },
    { role: "proof",   emotionalFunction: "proof",          baseDuration: 7,  retentionDriver: "אמינות" },
    { role: "result",  emotionalFunction: "desire",         baseDuration: 8,  retentionDriver: "שאיפה" },
    { role: "cta",     emotionalFunction: "action",         baseDuration: 5,  retentionDriver: "החלטה" },
  ],
  authority: [
    { role: "hook",        emotionalFunction: "interruption", baseDuration: 4,  retentionDriver: "עוצר גלילה" },
    { role: "credibility", emotionalFunction: "trust",        baseDuration: 10, retentionDriver: "מומחיות" },
    { role: "insight",     emotionalFunction: "revelation",   baseDuration: 8,  retentionDriver: "ידע חדש" },
    { role: "proof",       emotionalFunction: "proof",        baseDuration: 8,  retentionDriver: "ראיה" },
    { role: "offer",       emotionalFunction: "desire",       baseDuration: 7,  retentionDriver: "הצעה" },
    { role: "cta",         emotionalFunction: "action",       baseDuration: 5,  retentionDriver: "החלטה" },
  ],
  proof_escalation: [
    { role: "hook",         emotionalFunction: "interruption", baseDuration: 4,  retentionDriver: "עוצר גלילה" },
    { role: "small_proof",  emotionalFunction: "trust",        baseDuration: 8,  retentionDriver: "שביב ראיה" },
    { role: "bigger_proof", emotionalFunction: "proof",        baseDuration: 10, retentionDriver: "ראיה מצטברת" },
    { role: "climax",       emotionalFunction: "desire",       baseDuration: 8,  retentionDriver: "מסקנה בלתי נמנעת" },
    { role: "cta",          emotionalFunction: "action",       baseDuration: 5,  retentionDriver: "החלטה" },
  ],
  objection_collapse: [
    { role: "hook",      emotionalFunction: "interruption",   baseDuration: 4,  retentionDriver: "עוצר גלילה" },
    { role: "objection", emotionalFunction: "identification", baseDuration: 8,  retentionDriver: "הכרה בהתנגדות" },
    { role: "reframe",   emotionalFunction: "revelation",     baseDuration: 10, retentionDriver: "ריאפריים" },
    { role: "proof",     emotionalFunction: "trust",          baseDuration: 8,  retentionDriver: "אמון" },
    { role: "offer",     emotionalFunction: "desire",         baseDuration: 7,  retentionDriver: "הצעה" },
    { role: "cta",       emotionalFunction: "action",         baseDuration: 5,  retentionDriver: "החלטה" },
  ],
  problem_agitation: [
    { role: "hook",      emotionalFunction: "interruption",   baseDuration: 4,  retentionDriver: "עוצר גלילה" },
    { role: "pain",      emotionalFunction: "pain",           baseDuration: 8,  retentionDriver: "כאב" },
    { role: "agitation", emotionalFunction: "identification", baseDuration: 8,  retentionDriver: "הגברת רלוונטיות" },
    { role: "relief",    emotionalFunction: "revelation",     baseDuration: 8,  retentionDriver: "פתרון" },
    { role: "proof",     emotionalFunction: "proof",          baseDuration: 7,  retentionDriver: "אמינות" },
    { role: "cta",       emotionalFunction: "action",         baseDuration: 5,  retentionDriver: "החלטה" },
  ],
  local_trust: [
    { role: "hook",      emotionalFunction: "interruption",   baseDuration: 4,  retentionDriver: "עוצר גלילה" },
    { role: "community", emotionalFunction: "identification", baseDuration: 8,  retentionDriver: "שייכות" },
    { role: "story",     emotionalFunction: "trust",          baseDuration: 10, retentionDriver: "אמון" },
    { role: "result",    emotionalFunction: "desire",         baseDuration: 7,  retentionDriver: "שאיפה" },
    { role: "cta",       emotionalFunction: "action",         baseDuration: 5,  retentionDriver: "החלטה" },
  ],
  expert_dominance: [
    { role: "hook",        emotionalFunction: "interruption", baseDuration: 4,  retentionDriver: "עוצר גלילה" },
    { role: "declaration", emotionalFunction: "trust",        baseDuration: 8,  retentionDriver: "הכרזת מומחה" },
    { role: "proof",       emotionalFunction: "proof",        baseDuration: 8,  retentionDriver: "ראיה" },
    { role: "insight",     emotionalFunction: "revelation",   baseDuration: 8,  retentionDriver: "תובנה" },
    { role: "cta",         emotionalFunction: "action",       baseDuration: 5,  retentionDriver: "החלטה" },
  ],
  curiosity_gap: [
    { role: "hook",          emotionalFunction: "interruption", baseDuration: 4,  retentionDriver: "עוצר גלילה" },
    { role: "tease",         emotionalFunction: "curiosity",    baseDuration: 8,  retentionDriver: "לולאה פתוחה" },
    { role: "partial_reveal",emotionalFunction: "revelation",   baseDuration: 8,  retentionDriver: "חשיפה חלקית" },
    { role: "full_reveal",   emotionalFunction: "desire",       baseDuration: 8,  retentionDriver: "גילוי" },
    { role: "cta",           emotionalFunction: "action",       baseDuration: 5,  retentionDriver: "החלטה" },
  ],
  documentary_realism: [
    { role: "hook",             emotionalFunction: "interruption",   baseDuration: 4,  retentionDriver: "עוצר גלילה" },
    { role: "authentic_moment", emotionalFunction: "identification", baseDuration: 10, retentionDriver: "אמת" },
    { role: "process",          emotionalFunction: "trust",          baseDuration: 10, retentionDriver: "אמינות" },
    { role: "result",           emotionalFunction: "desire",         baseDuration: 8,  retentionDriver: "שאיפה" },
    { role: "cta",              emotionalFunction: "action",         baseDuration: 5,  retentionDriver: "החלטה" },
  ],
};

// ─── Story density ─────────────────────────────────────────────────────────────

const RICH_MODELS = new Set<StorytellingModel>([
  "transformation",
  "curiosity_gap",
  "proof_escalation",
  "objection_collapse",
  "problem_agitation",
]);
const MEDIUM_MODELS = new Set<StorytellingModel>(["authority", "expert_dominance"]);

function computeStoryDensity(
  storytellingModel: StorytellingModel,
  goal: string,
  style: string,
  emotionalArcLength: number,
  businessProfile?: BusinessContentProfile
): StoryDensity {
  let score = 0;

  if (RICH_MODELS.has(storytellingModel))        score += 2;
  else if (MEDIUM_MODELS.has(storytellingModel)) score += 1;

  if (goal === "trust")                          score += 2;
  else if (goal === "leads" || goal === "sales") score += 1;

  if (style === "trust")                  score += 2;
  else if (style === "explanatory")       score += 1;

  if (emotionalArcLength >= 5)            score += 2;
  else if (emotionalArcLength >= 3)       score += 1;

  if (businessProfile) {
    if (businessProfile.salesCycle === "long")  score += 1;
    if (businessProfile.trustLevel === "high")  score += 1;
  }

  if (score <= 3) return "light";
  if (score <= 6) return "medium";
  return "rich";
}

// ─── Engine ───────────────────────────────────────────────────────────────────

export function buildNarrativeProfile(input: NarrativeBuildInput): NarrativeProfile {
  const { variantBlueprint, businessProfile, goal, platform, style, resolvedPace } = input;
  const storytellingModel  = variantBlueprint.storytelling_model;
  const emotionalArcLength = variantBlueprint.emotional_arc?.length ?? 0;

  const storyDensity = computeStoryDensity(
    storytellingModel,
    goal,
    style,
    emotionalArcLength,
    businessProfile
  );

  const templateBeats = BEAT_PATTERNS[storytellingModel] ?? BEAT_PATTERNS.authority;
  const densityMul    = DENSITY_BEAT_MULTIPLIER[storyDensity];
  const pacingMul     = PACING_MULTIPLIER[resolvedPace];
  const ceiling       = PLATFORM_CEILING[platform] ?? DEFAULT_CEILING;

  // Build beats: hook/cta durations are fixed, middle beats scaled by density.
  const beats: NarrativeBeat[] = templateBeats.map((bt, i) => {
    const isEdge   = i === 0 || i === templateBeats.length - 1;
    const duration = isEdge ? bt.baseDuration : Math.round(bt.baseDuration * densityMul);
    return {
      role:              bt.role,
      emotionalFunction: bt.emotionalFunction,
      durationSeconds:   duration,
      retentionDriver:   bt.retentionDriver,
    };
  });

  // Filler prevention: no two consecutive beats with the same emotionalFunction.
  // Patterns are designed to never trigger this, but it acts as a safety net.
  for (let i = 1; i < beats.length; i++) {
    if (beats[i].emotionalFunction === beats[i - 1].emotionalFunction) {
      beats[i] = { ...beats[i], emotionalFunction: beats[i].emotionalFunction + "_escalation" };
    }
  }

  // estimatedDurationSeconds = sum of beat durations × pacing multiplier, clamped.
  const rawTotal = beats.reduce((sum, b) => sum + b.durationSeconds, 0);
  const estimatedDurationSeconds = Math.max(
    DURATION_FLOOR,
    Math.min(ceiling, Math.round(rawTotal * pacingMul))
  );

  return { narrativeBeats: beats, estimatedDurationSeconds, storyDensity };
}
