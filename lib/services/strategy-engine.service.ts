type Input = {
  goal: "leads" | "exposure" | "trust" | "sales";
  intent: "watch" | "follow" | "message" | "sale";
  businessCategory: string;
  audienceDescription?: string;
  emotionalDriver?:
    | "curiosity"
    | "trust"
    | "desire"
    | "urgency"
    | "fear"
    | "proof";
  stage?: "TOFU" | "MOFU" | "BOFU";
  selectedFormat?: "reel" | "video" | "image" | "post";
  forcedStrategy?: Strategy["type"];
  forcedPaceDirection?: Strategy["paceDirection"];
};

export type Strategy = {
  type:
    | "pattern_break"
    | "authority"
    | "direct_result"
    | "emotional"
    | "curiosity"
    | "contrast"
    | "problem_solution"
    | "proof";

  hookStyle: string;
  narrative: string;
  ctaType: string;
  visualStyle: string;
  distributionHint: string;
  proofStyle: string;
  paceDirection: "slow" | "normal" | "fast";
  emotionDriver:
    | "curiosity"
    | "trust"
    | "desire"
    | "urgency"
    | "fear"
    | "proof";
};

function applyStrategyOverrides(
  strategy: Strategy,
  input: Pick<Input, "forcedStrategy" | "forcedPaceDirection">
): Strategy {
  return {
    ...strategy,
    type: input.forcedStrategy || strategy.type,
    paceDirection: input.forcedPaceDirection || strategy.paceDirection,
  };
}

export function runStrategyEngine(input: Input): Strategy {
  const category = input.businessCategory?.toLowerCase?.() || "";
  const isFood = category.includes("food") || category.includes("אוכל");
  const emotionalDriver = input.emotionalDriver || "curiosity";

  let baseStrategy: Strategy;

  if (input.goal === "exposure") {
    if (isFood) {
      baseStrategy = {
        type: "pattern_break",
        hookStyle: "ויזואל חזק שמגרה מיד",
        narrative: "רגע שמושך עין ואז payoff מהיר",
        ctaType: "soft",
        visualStyle: "closeup + motion",
        distributionHint: "shares",
        proofStyle: "visual_proof",
        paceDirection: "fast",
        emotionDriver:
          emotionalDriver === "proof" ? "desire" : emotionalDriver,
      };

      return applyStrategyOverrides(baseStrategy, input);
    }

    baseStrategy = {
      type: emotionalDriver === "fear" ? "contrast" : "curiosity",
      hookStyle: "משהו חד, מסקרן או שובר גלילה",
      narrative: "לגרום להישאר ולרצות לראות עוד",
      ctaType: "soft",
      visualStyle: "dynamic",
      distributionHint: "retention",
      proofStyle: "light_proof",
      paceDirection: "fast",
      emotionDriver: emotionalDriver,
    };

    return applyStrategyOverrides(baseStrategy, input);
  }

  if (input.goal === "trust") {
    baseStrategy = {
      type: emotionalDriver === "proof" ? "proof" : "authority",
      hookStyle: "פתיחה מקצועית עם היגיון ברור",
      narrative: "הסבר + הוכחה + תהליך",
      ctaType: input.intent === "follow" ? "follow" : "soft",
      visualStyle: "stable + process",
      distributionHint: "saves",
      proofStyle: "process_proof",
      paceDirection: "normal",
      emotionDriver:
        emotionalDriver === "curiosity" ? "trust" : emotionalDriver,
    };

    return applyStrategyOverrides(baseStrategy, input);
  }

  if (input.goal === "sales") {
    baseStrategy = {
      type: "direct_result",
      hookStyle: "תוצאה או הבטחה ברורה מאוד",
      narrative: "תוצאה → הוכחה → הנעה לפעולה",
      ctaType: "hard",
      visualStyle: "result-focused",
      distributionHint: "comments",
      proofStyle: "result_proof",
      paceDirection: "fast",
      emotionDriver:
        emotionalDriver === "curiosity" ? "urgency" : emotionalDriver,
    };

    return applyStrategyOverrides(baseStrategy, input);
  }

  if (input.goal === "leads") {
    baseStrategy = {
      type: "problem_solution",
      hookStyle: "כאב חד או רצון ברור שמוביל לפנייה",
      narrative: "כאב → פתרון → פעולה",
      ctaType: "message",
      visualStyle: "clear + social_native",
      distributionHint: "comments",
      proofStyle: "practical_proof",
      paceDirection: "fast",
      emotionDriver:
        emotionalDriver === "curiosity" ? "desire" : emotionalDriver,
    };

    return applyStrategyOverrides(baseStrategy, input);
  }

  baseStrategy = {
    type: "curiosity",
    hookStyle: "משהו מעניין ומושך",
    narrative: "תוכן קל לצפייה",
    ctaType: "soft",
    visualStyle: "dynamic",
    distributionHint: "retention",
    proofStyle: "light_proof",
    paceDirection: "normal",
    emotionDriver: emotionalDriver,
  };

  return applyStrategyOverrides(baseStrategy, input);
}