export type Goal = "leads" | "trust" | "exposure" | "sales";

export type ContentAngle =
  | "show_result"
  | "explain"
  | "show_difference"
  | "attention"
  | "trust"
  | "cta";

export type AudienceType =
  | "new_customers"
  | "interested"
  | "ready_to_buy"
  | "existing_customers"
  | "everyone";

export type Mode = "ai" | "camera" | "voice";

export type DirectionType =
  | "conversion"
  | "authority"
  | "proof"
  | "differentiation"
  | "attention"
  | "connection";

export type DirectionStrategy =
  | "direct_offer"
  | "objection_handling"
  | "educational_value"
  | "result_demonstration"
  | "comparison"
  | "pattern_break"
  | "authentic_story";

export type DirectionTone =
  | "direct"
  | "reassuring"
  | "expert"
  | "confident"
  | "sharp"
  | "bold"
  | "personal";

export type DirectionPace =
  | "slow_medium"
  | "medium"
  | "medium_fast"
  | "fast";

export type RecommendedFormat = "reel" | "video" | "image" | "post";

export type DirectionOption = {
  id: string;
  title: string;
  description: string;
  whyItFits: string;
  type: DirectionType;
  strategy: DirectionStrategy;
  tone: DirectionTone;
  pace: DirectionPace;
  recommendedFormat: RecommendedFormat;
  score: number;
};

type DirectionInput = {
  goal: Goal;
  contentAngle: ContentAngle;
  audienceTypes?: AudienceType[];
  mode: Mode;
};

function cloneDirection(option: DirectionOption): DirectionOption {
  return { ...option };
}

function normalizeAudienceTypes(
  audienceTypes?: AudienceType[]
): AudienceType[] {
  if (!audienceTypes || audienceTypes.length === 0) {
    return ["everyone"];
  }

  return audienceTypes;
}

const DIRECTION_LIBRARY = {
  directConversion: {
    id: "direct_conversion",
    title: "הנעה ישירה לפעולה",
    description: "תוכן חד שמוביל את הצופה לצעד הבא בצורה ברורה.",
    whyItFits:
      "זה כיוון שמתאים כשיש רצון לייצר פעולה ברורה ולא להשאיר את הקהל רק עם עניין כללי.",
    type: "conversion",
    strategy: "direct_offer",
    tone: "direct",
    pace: "fast",
    recommendedFormat: "reel",
    score: 8,
  } satisfies DirectionOption,

  objectionBreaker: {
    id: "objection_breaker",
    title: "הסרת התנגדויות",
    description: "תוכן שמפיג חששות, מפחית חיכוך ומחזק ביטחון לפני החלטה.",
    whyItFits:
      "זה כיוון מתאים כשהקהל כבר קרוב יחסית, אבל עדיין צריך ביטחון כדי לזוז קדימה.",
    type: "conversion",
    strategy: "objection_handling",
    tone: "reassuring",
    pace: "medium",
    recommendedFormat: "video",
    score: 8,
  } satisfies DirectionOption,

  authorityEducation: {
    id: "authority_education",
    title: "הסבר מקצועי",
    description: "תוכן שמסביר, עושה סדר וממצב אותך כמומחה בתחום.",
    whyItFits:
      "זה כיוון נכון כשצריך לבנות אמון דרך ידע, בהירות והבנה אמיתית של הבעיה.",
    type: "authority",
    strategy: "educational_value",
    tone: "expert",
    pace: "medium",
    recommendedFormat: "video",
    score: 8,
  } satisfies DirectionOption,

  proofAndResult: {
    id: "proof_and_result",
    title: "תוצאה והוכחה",
    description: "תוכן שמראה תוצאה מוחשית, שינוי ברור או הוכחה שהדבר עובד.",
    whyItFits:
      "זה כיוון חזק במיוחד כשיש מה להראות ורוצים לייצר רצון דרך תוצאה אמיתית.",
    type: "proof",
    strategy: "result_demonstration",
    tone: "confident",
    pace: "medium_fast",
    recommendedFormat: "reel",
    score: 8,
  } satisfies DirectionOption,

  contrastAndDifferentiation: {
    id: "contrast_and_differentiation",
    title: "הדגשת הבדל",
    description:
      "תוכן שמבליט פער, השוואה או טעות נפוצה כדי להדגיש למה הדרך שלך שונה.",
    whyItFits:
      "זה כיוון מצוין כשרוצים לעורר עניין, להבהיר בידול ולהמחיש למה לבחור בך.",
    type: "differentiation",
    strategy: "comparison",
    tone: "sharp",
    pace: "fast",
    recommendedFormat: "reel",
    score: 8,
  } satisfies DirectionOption,

  attentionHook: {
    id: "attention_hook",
    title: "פתיחה שתופסת תשומת לב",
    description:
      "תוכן שנועד לעצור גלילה מהר ולמשוך את הצופה פנימה מהשנייה הראשונה.",
    whyItFits:
      "כשצריך חשיפה או קהל חדש, קודם כל צריך לגרום לאנשים לעצור ולהישאר.",
    type: "attention",
    strategy: "pattern_break",
    tone: "bold",
    pace: "fast",
    recommendedFormat: "reel",
    score: 8,
  } satisfies DirectionOption,

  authenticConnection: {
    id: "authentic_connection",
    title: "חיבור אישי ואותנטי",
    description: "תוכן אנושי שמחבר את הקהל לעסק דרך אישיות, כנות ושקיפות.",
    whyItFits:
      "זה כיוון חזק במיוחד כשאמון נבנה דרך חיבור רגשי ולא רק דרך הסבר או מכירה.",
    type: "connection",
    strategy: "authentic_story",
    tone: "personal",
    pace: "slow_medium",
    recommendedFormat: "video",
    score: 8,
  } satisfies DirectionOption,
};

const baseDirectionMap: Record<
  Goal,
  Partial<Record<ContentAngle, DirectionOption[]>>
> = {
  sales: {
    cta: [
      {
        ...cloneDirection(DIRECTION_LIBRARY.directConversion),
        score: 10,
        whyItFits:
          "המטרה היא מכירה והזווית היא הנעה לפעולה, לכן נכון לבחור תוכן ישיר וממיר.",
      },
      {
        ...cloneDirection(DIRECTION_LIBRARY.objectionBreaker),
        score: 8,
        whyItFits:
          "זה מתאים כשצריך להוביל לפעולה, אבל גם להסיר חיכוך שמונע החלטה.",
      },
    ],
    trust: [
      {
        ...cloneDirection(DIRECTION_LIBRARY.objectionBreaker),
        score: 10,
        whyItFits:
          "כשהמטרה היא מכירה אבל הזווית היא אמון, צריך קודם לחזק ביטחון ולהרגיע חששות.",
      },
      {
        ...cloneDirection(DIRECTION_LIBRARY.authenticConnection),
        score: 7,
        whyItFits:
          "אפשר לקדם מכירה גם דרך חיבור אישי שמקטין התנגדות ומקרב את הקהל לעסק.",
      },
    ],
    show_result: [
      {
        ...cloneDirection(DIRECTION_LIBRARY.proofAndResult),
        score: 10,
        whyItFits:
          "מכירה דרך תוצאה עובדת מצוין כשיש מה להראות ורוצים לעורר רצון בצורה מוחשית.",
      },
    ],
    show_difference: [
      {
        ...cloneDirection(DIRECTION_LIBRARY.contrastAndDifferentiation),
        score: 10,
        whyItFits:
          "כדי למכור, לפעמים צריך קודם להמחיש למה הדרך שלך שונה וטובה יותר.",
      },
      {
        ...cloneDirection(DIRECTION_LIBRARY.proofAndResult),
        score: 7,
        whyItFits:
          "גם כשמדגישים הבדל, אפשר לחזק את זה דרך הוכחה ותוצאה אמיתית.",
      },
    ],
    explain: [
      {
        ...cloneDirection(DIRECTION_LIBRARY.authorityEducation),
        score: 8,
        whyItFits:
          "לפעמים הדרך למכירה עוברת דרך הסבר ברור שעושה סדר ומייצר ביטחון.",
      },
      {
        ...cloneDirection(DIRECTION_LIBRARY.objectionBreaker),
        score: 7,
      },
    ],
    attention: [
      {
        ...cloneDirection(DIRECTION_LIBRARY.attentionHook),
        score: 8,
        whyItFits:
          "אם רוצים למכור דרך תשומת לב, צריך קודם לעצור את הצופה ולמשוך אותו פנימה.",
      },
      {
        ...cloneDirection(DIRECTION_LIBRARY.directConversion),
        score: 7,
      },
    ],
  },

  trust: {
    explain: [
      {
        ...cloneDirection(DIRECTION_LIBRARY.authorityEducation),
        score: 10,
        whyItFits:
          "בניית אמון דרך הסבר מקצועי היא דרך חזקה, עקבית ויציבה מאוד.",
      },
      {
        ...cloneDirection(DIRECTION_LIBRARY.authenticConnection),
        score: 7,
      },
    ],
    trust: [
      {
        ...cloneDirection(DIRECTION_LIBRARY.authenticConnection),
        score: 10,
        whyItFits:
          "הזווית כאן היא אמון, ולכן חיבור אנושי, כנות ושקיפות הם כיוון טבעי וחזק.",
      },
      {
        ...cloneDirection(DIRECTION_LIBRARY.objectionBreaker),
        score: 8,
        whyItFits:
          "חלק מהאמון נבנה גם דרך מענה לחוסר ודאות וחששות של הקהל.",
      },
      {
        ...cloneDirection(DIRECTION_LIBRARY.authorityEducation),
        score: 7,
      },
    ],
    show_result: [
      {
        ...cloneDirection(DIRECTION_LIBRARY.proofAndResult),
        score: 9,
        whyItFits:
          "גם אמון אפשר לבנות דרך תוצאה מוכחת שמראה שהתהליך באמת עובד.",
      },
      {
        ...cloneDirection(DIRECTION_LIBRARY.authorityEducation),
        score: 7,
      },
    ],
    attention: [
      {
        ...cloneDirection(DIRECTION_LIBRARY.authenticConnection),
        score: 8,
      },
      {
        ...cloneDirection(DIRECTION_LIBRARY.attentionHook),
        score: 7,
      },
    ],
    show_difference: [
      {
        ...cloneDirection(DIRECTION_LIBRARY.contrastAndDifferentiation),
        score: 8,
      },
      {
        ...cloneDirection(DIRECTION_LIBRARY.authorityEducation),
        score: 7,
      },
    ],
    cta: [
      {
        ...cloneDirection(DIRECTION_LIBRARY.objectionBreaker),
        score: 8,
      },
      {
        ...cloneDirection(DIRECTION_LIBRARY.authenticConnection),
        score: 7,
      },
    ],
  },

  exposure: {
    attention: [
      {
        ...cloneDirection(DIRECTION_LIBRARY.attentionHook),
        score: 10,
        whyItFits:
          "המטרה היא חשיפה ולכן קודם כל צריך למשוך תשומת לב ולעצור גלילה.",
      },
      {
        ...cloneDirection(DIRECTION_LIBRARY.contrastAndDifferentiation),
        score: 8,
      },
      {
        ...cloneDirection(DIRECTION_LIBRARY.authenticConnection),
        score: 6,
      },
    ],
    show_difference: [
      {
        ...cloneDirection(DIRECTION_LIBRARY.contrastAndDifferentiation),
        score: 9,
        whyItFits:
          "הבדל חד, טעות נפוצה או השוואה ברורה יכולים לייצר עניין וחשיפה מהר.",
      },
      {
        ...cloneDirection(DIRECTION_LIBRARY.attentionHook),
        score: 8,
      },
    ],
    trust: [
      {
        ...cloneDirection(DIRECTION_LIBRARY.authenticConnection),
        score: 8,
        whyItFits:
          "לפעמים הדרך להגיע לקהל חדש היא דרך אישיות, סיפור אנושי ותחושת קרבה.",
      },
      {
        ...cloneDirection(DIRECTION_LIBRARY.authorityEducation),
        score: 7,
      },
    ],
    explain: [
      {
        ...cloneDirection(DIRECTION_LIBRARY.authorityEducation),
        score: 7,
        whyItFits:
          "ערך מקצועי יכול להביא חשיפה, במיוחד כשהוא קצר, ברור ונבנה נכון.",
      },
      {
        ...cloneDirection(DIRECTION_LIBRARY.attentionHook),
        score: 7,
      },
    ],
    show_result: [
      {
        ...cloneDirection(DIRECTION_LIBRARY.proofAndResult),
        score: 8,
      },
      {
        ...cloneDirection(DIRECTION_LIBRARY.attentionHook),
        score: 7,
      },
    ],
    cta: [
      {
        ...cloneDirection(DIRECTION_LIBRARY.attentionHook),
        score: 7,
      },
      {
        ...cloneDirection(DIRECTION_LIBRARY.directConversion),
        score: 6,
      },
    ],
  },

  leads: {
    show_result: [
      {
        ...cloneDirection(DIRECTION_LIBRARY.proofAndResult),
        score: 10,
        whyItFits:
          "לידים נוצרים טוב כשאנשים רואים תוצאה ורוצים גם הם להגיע אליה.",
      },
      {
        ...cloneDirection(DIRECTION_LIBRARY.directConversion),
        score: 7,
      },
    ],
    show_difference: [
      {
        ...cloneDirection(DIRECTION_LIBRARY.contrastAndDifferentiation),
        score: 9,
        whyItFits:
          "הבדל חד בין מצב רגיל לבין פתרון נכון מייצר עניין ומוביל לפנייה.",
      },
      {
        ...cloneDirection(DIRECTION_LIBRARY.proofAndResult),
        score: 8,
      },
    ],
    cta: [
      {
        ...cloneDirection(DIRECTION_LIBRARY.directConversion),
        score: 8,
        whyItFits:
          "כשצריך לידים, לפעמים עדיף פשוט לקרוא לפעולה בצורה ברורה וישירה.",
      },
      {
        ...cloneDirection(DIRECTION_LIBRARY.objectionBreaker),
        score: 7,
      },
    ],
    explain: [
      {
        ...cloneDirection(DIRECTION_LIBRARY.authorityEducation),
        score: 8,
        whyItFits:
          "הסבר טוב יכול לגרום לקהל לזהות את הצורך שלו ולהבין למה כדאי לפנות.",
      },
      {
        ...cloneDirection(DIRECTION_LIBRARY.proofAndResult),
        score: 7,
      },
    ],
    trust: [
      {
        ...cloneDirection(DIRECTION_LIBRARY.authenticConnection),
        score: 7,
        whyItFits:
          "לפעמים אנשים פונים לא בגלל ההסבר, אלא בגלל תחושת חיבור וביטחון.",
      },
      {
        ...cloneDirection(DIRECTION_LIBRARY.objectionBreaker),
        score: 7,
      },
    ],
    attention: [
      {
        ...cloneDirection(DIRECTION_LIBRARY.attentionHook),
        score: 8,
      },
      {
        ...cloneDirection(DIRECTION_LIBRARY.directConversion),
        score: 7,
      },
    ],
  },
};

function getGoalFallbackDirections(goal: Goal): DirectionOption[] {
  switch (goal) {
    case "sales":
      return [
        { ...cloneDirection(DIRECTION_LIBRARY.directConversion), score: 8 },
        { ...cloneDirection(DIRECTION_LIBRARY.objectionBreaker), score: 7 },
        { ...cloneDirection(DIRECTION_LIBRARY.proofAndResult), score: 6 },
      ];

    case "trust":
      return [
        { ...cloneDirection(DIRECTION_LIBRARY.authorityEducation), score: 8 },
        { ...cloneDirection(DIRECTION_LIBRARY.authenticConnection), score: 8 },
        { ...cloneDirection(DIRECTION_LIBRARY.objectionBreaker), score: 6 },
      ];

    case "exposure":
      return [
        { ...cloneDirection(DIRECTION_LIBRARY.attentionHook), score: 8 },
        {
          ...cloneDirection(DIRECTION_LIBRARY.contrastAndDifferentiation),
          score: 7,
        },
        { ...cloneDirection(DIRECTION_LIBRARY.authenticConnection), score: 6 },
      ];

    case "leads":
      return [
        { ...cloneDirection(DIRECTION_LIBRARY.proofAndResult), score: 8 },
        { ...cloneDirection(DIRECTION_LIBRARY.authorityEducation), score: 7 },
        { ...cloneDirection(DIRECTION_LIBRARY.directConversion), score: 6 },
      ];

    default:
      return [
        { ...cloneDirection(DIRECTION_LIBRARY.proofAndResult), score: 7 },
        { ...cloneDirection(DIRECTION_LIBRARY.authorityEducation), score: 7 },
        { ...cloneDirection(DIRECTION_LIBRARY.attentionHook), score: 6 },
      ];
  }
}

function mergeUniqueDirections(
  primary: DirectionOption[],
  fallback: DirectionOption[]
): DirectionOption[] {
  const merged: DirectionOption[] = [];
  const seen = new Set<string>();

  for (const option of [...primary, ...fallback]) {
    if (seen.has(option.id)) continue;
    seen.add(option.id);
    merged.push({ ...option });
  }

  return merged;
}

function applyAudienceAdjustments(
  option: DirectionOption,
  audienceTypes: AudienceType[]
): DirectionOption {
  const adjusted = { ...option };

  for (const audienceType of audienceTypes) {
    switch (audienceType) {
      case "new_customers":
        if (adjusted.id === "attention_hook") adjusted.score += 2;
        if (adjusted.id === "authority_education") adjusted.score += 2;
        if (adjusted.id === "direct_conversion") adjusted.score -= 1;
        break;

      case "interested":
        if (adjusted.id === "proof_and_result") adjusted.score += 2;
        if (adjusted.id === "objection_breaker") adjusted.score += 2;
        break;

      case "ready_to_buy":
        if (adjusted.id === "direct_conversion") adjusted.score += 3;
        if (adjusted.id === "objection_breaker") adjusted.score += 2;
        if (adjusted.id === "attention_hook") adjusted.score -= 1;
        break;

      case "existing_customers":
        if (adjusted.id === "authentic_connection") adjusted.score += 3;
        if (adjusted.id === "proof_and_result") adjusted.score += 2;
        if (adjusted.id === "authority_education") adjusted.score += 1;
        break;

      case "everyone":
        adjusted.score += 0;
        break;

      default:
        break;
    }
  }

  return adjusted;
}

function applyModeAdjustments(
  option: DirectionOption,
  mode: Mode
): DirectionOption {
  const adjusted = { ...option };

  if (mode === "camera") {
    if (
      adjusted.id === "attention_hook" ||
      adjusted.id === "proof_and_result" ||
      adjusted.id === "contrast_and_differentiation"
    ) {
      adjusted.score += 1;
      adjusted.recommendedFormat = "reel";
    }

    if (
      adjusted.id === "authentic_connection" ||
      adjusted.id === "objection_breaker" ||
      adjusted.id === "authority_education"
    ) {
      adjusted.recommendedFormat = "video";
    }
  }

  if (mode === "voice") {
    if (
      adjusted.id === "authority_education" ||
      adjusted.id === "authentic_connection" ||
      adjusted.id === "objection_breaker"
    ) {
      adjusted.score += 2;
      adjusted.recommendedFormat = "video";
    }

    if (adjusted.id === "attention_hook") {
      adjusted.score -= 1;
    }
  }

  if (mode === "ai") {
    if (
      adjusted.id === "attention_hook" ||
      adjusted.id === "proof_and_result" ||
      adjusted.id === "contrast_and_differentiation"
    ) {
      adjusted.score += 1;
    }
  }

  return adjusted;
}

function applyAudienceAndModeAdjustments(
  option: DirectionOption,
  input: Pick<DirectionInput, "audienceTypes" | "mode">
): DirectionOption {
  const audienceTypes = normalizeAudienceTypes(input.audienceTypes);
  const withAudience = applyAudienceAdjustments(option, audienceTypes);
  return applyModeAdjustments(withAudience, input.mode);
}

export function getDirectionOptions(input: DirectionInput): DirectionOption[] {
  const base =
    baseDirectionMap[input.goal]?.[input.contentAngle] ||
    getGoalFallbackDirections(input.goal);

  const fallback = getGoalFallbackDirections(input.goal);

  const merged = mergeUniqueDirections(base, fallback);

  const enriched = merged.map((option) =>
    applyAudienceAndModeAdjustments(option, {
      audienceTypes: input.audienceTypes,
      mode: input.mode,
    })
  );

  return enriched.sort((a, b) => b.score - a.score).slice(0, 3);
}