export type FoodMergedInsight = {
  hooks: string[];
  topics: string[];
  angles: string[];
};

export type ContentStructure = {
  hook: string;
  problem: string;
  value: string;
  proof: string;
  cta: string;
};

export type ComposedVariant = {
  id: string;
  ideaType: "desire" | "education" | "trust";
  structureType: string;
  label: string;
  reasonWhyItFits: string;
  hook: string;
  topic: string;
  angle: string;
  cta: string;
  contentStructure: ContentStructure;
};

type BuildFoodVariantsInput = {
  merged: FoodMergedInsight;
  businessName: string;
  effectiveServiceLabel: string;
  intent: "message" | "follow" | "watch" | "sale";
  goal: "leads" | "trust" | "exposure" | "sales";
  audienceDescription: string;
};

function getAt(items: string[], index: number, fallback: string) {
  if (!Array.isArray(items) || items.length === 0) {
    return fallback;
  }

  return items[index % items.length] || fallback;
}

function buildCTA(intent: BuildFoodVariantsInput["intent"]) {
  if (intent === "message") return "שלחו הודעה עכשיו";
  if (intent === "follow") return "עקבו אחרי לעוד";
  if (intent === "watch") return "תמשיכו לראות";
  return "הזמינו עכשיו";
}

function buildAudienceText(audienceDescription: string) {
  if (
    typeof audienceDescription === "string" &&
    audienceDescription.trim().length > 0
  ) {
    return audienceDescription.trim();
  }

  return "מי שאוהב אוכל טוב";
}

function buildDesireVariant(input: BuildFoodVariantsInput): ComposedVariant {
  const hook = getAt(
    input.merged.hooks,
    0,
    "אם אתה רעב עכשיו זה מסוכן"
  );
  const topic = getAt(input.merged.topics, 0, "מנה מובילה");
  const angle = getAt(input.merged.angles, 0, "food porn");
  const cta = buildCTA(input.intent);

  return {
    id: "food-desire",
    ideaType: "desire",
    structureType: "craving-visual",
    label: "חשק מיידי",
    reasonWhyItFits: "מתאים לתחום האוכל כי חשק מיידי מניע לפעולה מהר",
    hook,
    topic,
    angle,
    cta,
    contentStructure: {
      hook,
      problem: `${buildAudienceText(
        input.audienceDescription
      )} רואים הרבה אוכל — אבל לא כל דבר באמת יוצר חשק מיידי.`,
      value: `כאן הדגש הוא על ${topic} דרך זווית של ${angle}, כדי לייצר תחושת "בא לי עכשיו".`,
      proof: `${input.businessName} יודע להפוך ${input.effectiveServiceLabel} לחוויה שמושכת כבר מהמבט הראשון.`,
      cta,
    },
  };
}

function buildEducationVariant(input: BuildFoodVariantsInput): ComposedVariant {
  const hook = getAt(
    input.merged.hooks,
    1,
    "לא תאמין מה יש פה"
  );
  const topic = getAt(input.merged.topics, 1, "איך מכינים");
  const angle = getAt(input.merged.angles, 1, "מאחורי הקלעים");
  const cta = buildCTA(input.intent);

  return {
    id: "food-education",
    ideaType: "education",
    structureType: "curiosity-process",
    label: "סקרנות ותהליך",
    reasonWhyItFits: "מתאים כי הוא בונה עניין דרך גילוי, תהליך וייחודיות.",
    hook,
    topic,
    angle,
    cta,
    contentStructure: {
      hook,
      problem: `הרבה אנשים רואים מנה טובה אבל לא מבינים מה באמת הופך אותה לשווה.`,
      value: `כשמראים ${topic} דרך ${angle}, התוכן מרגיש אמיתי יותר ומחזק רצון לטעום.`,
      proof: `${input.businessName} לא מוכר רק ${input.effectiveServiceLabel} — הוא מציג איך האיכות והחוויה נבנות בפועל.`,
      cta,
    },
  };
}

function buildTrustVariant(input: BuildFoodVariantsInput): ComposedVariant {
  const hook = getAt(
    input.merged.hooks,
    2,
    "כולם מדברים על זה"
  );
  const topic = getAt(input.merged.topics, 2, "לקוחות");
  const angle = getAt(input.merged.angles, 2, "לקוחות נהנים");
  const cta = buildCTA(input.intent);

  return {
    id: "food-trust",
    ideaType: "trust",
    structureType: "proof-experience",
    label: "אמון וחוויה",
    reasonWhyItFits: "מתאים כי הוא מפחית חשש ומחזק ביטחון לפני הזמנה או הגעה.",
    hook,
    topic,
    angle,
    cta,
    contentStructure: {
      hook,
      problem: `לפני שמזמינים או מגיעים, אנשים רוצים לדעת שהם לא יתאכזבו.`,
      value: `תוכן שמבליט ${topic} ו-${angle} בונה אמון ומראה שיש כאן חוויה ששווה להגיע אליה.`,
      proof: `${input.businessName} מציג ${input.effectiveServiceLabel} דרך תוצאה, עקביות וחוויה שאנשים באמת זוכרים.`,
      cta,
    },
  };
}

export function buildVariants(
  input: BuildFoodVariantsInput
): ComposedVariant[] {
  return [
    buildDesireVariant(input),
    buildEducationVariant(input),
    buildTrustVariant(input),
  ];
}