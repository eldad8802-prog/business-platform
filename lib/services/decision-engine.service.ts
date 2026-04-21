type Goal = "leads" | "trust" | "exposure" | "sales";

type Intent = "message" | "follow" | "watch" | "sale";

type Strategy =
  | "pain"
  | "urgency"
  | "authority"
  | "social_proof"
  | "mistake"
  | "opportunity"
  | "desire"
  | "trust"
  | "comparison"
  | "objection_break"
  | "curiosity"
  | "clarity";

type Tone = "soft" | "balanced" | "aggressive";

type DecisionResult = {
  strategy: Strategy;
  angle: string;
  tone: Tone;
  ctaType: Intent;
};

type FlowInput = {
  goal: Goal;
  goalDescription: string;
  intent: Intent;
  audienceDescription: string;
};

type BusinessContext = {
  category?: string;
  subcategory?: string;
};

type Signals = {
  urgency: number;
  trust: number;
  conversion: number;
  awareness: number;
  emotion: number;
};

// ---------------------
// SIGNAL EXTRACTION
// ---------------------

function extractSignals(input: FlowInput): Signals {
  let signals: Signals = {
    urgency: 0,
    trust: 0,
    conversion: 0,
    awareness: 0,
    emotion: 0,
  };

  // Goal
  if (input.goal === "leads" || input.goal === "sales") {
    signals.conversion += 0.8;
    signals.urgency += 0.6;
  }

  if (input.goal === "trust") {
    signals.trust += 0.9;
  }

  if (input.goal === "exposure") {
    signals.awareness += 0.9;
  }

  // Intent
  if (input.intent === "message" || input.intent === "sale") {
    signals.conversion += 0.5;
  }

  if (input.intent === "watch") {
    signals.awareness += 0.5;
  }

  // Free text (goalDescription)
  const text = input.goalDescription.toLowerCase();

  if (text.includes("דחוף") || text.includes("מהר")) {
    signals.urgency = 1;
  }

  if (text.includes("לקוחות")) {
    signals.conversion += 0.5;
  }

  if (text.includes("אמון") || text.includes("יסמכו")) {
    signals.trust = 1;
  }

  // Audience
  const audience = input.audienceDescription.toLowerCase();

  if (audience.includes("לחץ")) {
    signals.urgency += 0.5;
  }

  if (audience.includes("לא יודע") || audience.includes("מתלבט")) {
    signals.awareness += 0.5;
    signals.trust += 0.3;
  }

  return signals;
}

// ---------------------
// STRATEGY FILTERING
// ---------------------

function getStrategiesByGoal(goal: Goal): Strategy[] {
  switch (goal) {
    case "leads":
      return ["pain", "urgency", "mistake"];
    case "trust":
      return ["authority", "social_proof", "trust"];
    case "exposure":
      return ["curiosity", "mistake", "opportunity"];
    case "sales":
      return ["pain", "urgency", "objection_break", "comparison"];
    default:
      return ["pain"];
  }
}

// ---------------------
// SCORING
// ---------------------

function scoreStrategy(strategy: Strategy, s: Signals): number {
  switch (strategy) {
    case "pain":
      return s.conversion + s.urgency;

    case "urgency":
      return s.urgency * 1.2;

    case "authority":
      return s.trust;

    case "social_proof":
      return s.trust * 0.8;

    case "mistake":
      return s.awareness;

    case "opportunity":
      return s.awareness * 0.7;

    case "objection_break":
      return s.conversion * 0.9;

    case "comparison":
      return s.conversion * 0.6;

    case "curiosity":
      return s.awareness * 0.9;

    case "trust":
      return s.trust;

    case "desire":
      return s.emotion;

    case "clarity":
      return s.awareness;

    default:
      return 0;
  }
}

// ---------------------
// STRATEGY SELECTION
// ---------------------

function selectStrategy(goal: Goal, signals: Signals): Strategy {
  const possible = getStrategiesByGoal(goal);

  let best: Strategy = possible[0];
  let bestScore = -1;

  for (const s of possible) {
    const score = scoreStrategy(s, signals);

    if (score > bestScore) {
      best = s;
      bestScore = score;
    }
  }

  return best;
}

// ---------------------
// ANGLE SELECTION
// ---------------------

function selectAngle(strategy: Strategy, s: Signals): string {
  if (strategy === "pain") {
    if (s.urgency > 0.8) return "pressure";
    if (s.trust < 0.4) return "lack_of_confidence";
    if (s.awareness > 0.6) return "uncertainty";
    return "frustration";
  }

  if (strategy === "authority") {
    return "experience";
  }

  if (strategy === "mistake") {
    return "common_mistake";
  }

  if (strategy === "urgency") {
    return "time_pressure";
  }

  if (strategy === "social_proof") {
    return "others_success";
  }

  return "default";
}

// ---------------------
// TONE
// ---------------------

function selectTone(s: Signals): Tone {
  if (s.urgency > 0.8) return "aggressive";
  if (s.trust > 0.7) return "soft";
  return "balanced";
}

// ---------------------
// MAIN FUNCTION
// ---------------------

export function runDecisionEngine(
  input: FlowInput,
  business: BusinessContext
): DecisionResult {
  const signals = extractSignals(input);

  const strategy = selectStrategy(input.goal, signals);

  const angle = selectAngle(strategy, signals);

  const tone = selectTone(signals);

  return {
    strategy,
    angle,
    tone,
    ctaType: input.intent,
  };
}