import { optimizeScript } from "@/lib/services/content-optimizer.service";
import {
  getBusinessContentProfile,
  type BusinessContentProfile,
} from "@/lib/services/business-content-profile.service";
import type { CreativeBlueprint } from "@/lib/features/content/creative-blueprint/types";
import {
  isLLMEnabled,
  tryGenerateWithLLM,
} from "@/lib/features/content/llm/content-llm.service";

type VideoPlan = {
  videoType: "SHORT" | "MID" | "FULL";
  durationSeconds: number;
  pace: "fast" | "medium" | "slow";
  structure: string[];
  hookStyle:
    | "pattern_break"
    | "pain_first"
    | "result_first"
    | "trust_first"
    | "offer_first";
  ctaStyle: "message_now" | "book_now" | "buy_now" | "follow" | "learn_more";
  platform: string;
  goal: string;
  contentAngle?: string;
};

/** Thin slice of direction card — optional plumbing from video plan flow. */
type SelectedDirectionInput = {
  title?: string;
  description?: string;
  whyItFits?: string;
};

type GenerateScriptInput = {
  businessType?: string;
  businessCategory?: string;
  businessName?: string;
  goal?: string;
  contentAngle?: string;
  audience?: string[];
  services?: string[];
  products?: string[];
  brandTone?: string;
  priceLevel?: "budget" | "mid" | "premium";
  differentiators?: string[];
  videoPlan: VideoPlan;
  contentGoalPrompt?: string;
  selectedDirection?: SelectedDirectionInput;
  blueprint?: CreativeBlueprint;
};

type Shot = {
  visual: string;
  voice: string;
};

type GenerateScriptResult = {
  hook: string;
  scriptText: string;
  caption: string;
  shots: Shot[];
  businessProfile: BusinessContentProfile;
};

// ─── Label helpers ─────────────────────────────────────────────────────────────

function getGoalLabel(goal?: string) {
  switch (goal) {
    case "leads":    return "יותר פניות";
    case "trust":    return "יותר אמון";
    case "exposure": return "יותר חשיפה";
    case "sales":    return "יותר מכירות";
    default:         return "תוצאה עסקית טובה יותר";
  }
}

function getAudienceLabel(audience?: string[]) {
  if (!audience || audience.length === 0) return "הקהל הנכון";
  if (audience.length === 1) return audience[0];
  return audience.join(", ");
}

function getBusinessLabel(input: GenerateScriptInput) {
  if (input.businessName?.trim())    return input.businessName.trim();
  if (input.businessType?.trim())    return input.businessType.trim();
  if (input.businessCategory?.trim()) return input.businessCategory.trim();
  return "העסק";
}

function getMainOfferLabel(input: GenerateScriptInput) {
  if (input.services?.length)  return input.services[0];
  if (input.products?.length)  return input.products[0];
  return "השירות או המוצר שלך";
}

function getDifferentiatorLabel(input: GenerateScriptInput) {
  if (input.differentiators?.length) return input.differentiators[0];
  return "הדרך שבה אתם מציגים את הערך שלכם";
}

function normalizeOptionalTrim(value?: string): string | undefined {
  const t = value?.trim();
  return t ? t : undefined;
}

// ─── Explanation cue ──────────────────────────────────────────────────────────

const EXPLANATION_USER_SNIPPET_MAX_CHARS = 100;

function clipExplanationUserSnippet(text: string, maxLen: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  if (collapsed.length <= maxLen) return collapsed;
  const slice = collapsed.slice(0, maxLen);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > maxLen * 0.45) return `${slice.slice(0, lastSpace).trim()}…`;
  return `${slice.trim()}…`;
}

function explanationVoiceWithOptionalUserCue(
  base: string,
  context: { contentGoalPrompt?: string; directionTitle?: string }
): string {
  const raw =
    normalizeOptionalTrim(context.contentGoalPrompt) ??
    normalizeOptionalTrim(context.directionTitle);
  if (!raw) return base;
  const snippet = clipExplanationUserSnippet(raw, EXPLANATION_USER_SNIPPET_MAX_CHARS);
  if (!snippet) return base;
  return `${base} זה מתחבר ישירות לנקודה שרציתם להבהיר: ${snippet}.`;
}

// ─── Context builder ──────────────────────────────────────────────────────────

function buildContext(input: GenerateScriptInput) {
  const businessProfile = getBusinessContentProfile({
    businessType: input.businessType,
    businessCategory: input.businessCategory,
    businessName: input.businessName,
    services: input.services,
    products: input.products,
    targetAudience: input.audience,
    brandTone: input.brandTone,
    primaryGoal: input.goal as "leads" | "trust" | "exposure" | "sales" | undefined,
    priceLevel: input.priceLevel,
    differentiators: input.differentiators,
  });

  return {
    businessProfile,
    businessLabel: getBusinessLabel(input),
    audienceLabel: getAudienceLabel(input.audience),
    mainOfferLabel: getMainOfferLabel(input),
    differentiatorLabel: getDifferentiatorLabel(input),
    goalLabel: getGoalLabel(input.goal),
    contentGoalPrompt: normalizeOptionalTrim(input.contentGoalPrompt),
    directionTitle: normalizeOptionalTrim(input.selectedDirection?.title),
    directionDescription: normalizeOptionalTrim(input.selectedDirection?.description),
    directionWhyItFits: normalizeOptionalTrim(input.selectedDirection?.whyItFits),
  };
}

// ─── Blueprint-aware hook helpers ─────────────────────────────────────────────

/**
 * Selects a hook template driven by Blueprint attention_strategy +
 * interruption_style + storytelling_model.
 * Returns undefined when no strong match exists — caller falls through to
 * the existing hookStyle switch.
 */
function tryBlueprintHook(
  blueprint: CreativeBlueprint,
  context: {
    businessLabel: string;
    audienceLabel: string;
    mainOfferLabel: string;
    goalLabel: string;
    businessProfile: BusinessContentProfile;
  }
): string | undefined {
  const { attention_strategy, interruption_style, storytelling_model } = blueprint;
  const { mainOfferLabel, goalLabel, audienceLabel, businessLabel } = context;

  // ── Transformation / before-after openers ─────────────────────────────────
  if (storytelling_model === "transformation") {
    if (attention_strategy === "result_first") {
      return `לפני שמביאים ${goalLabel} — רוב האנשים לא מבינים מה הם מפספסים.`;
    }
    if (attention_strategy === "pain_mirror") {
      return `יש רגע שבו מבינים שהדרך הישנה פשוט לא עובדת יותר.`;
    }
  }

  // ── Authority / expert dominance openers ──────────────────────────────────
  if (
    storytelling_model === "authority" ||
    storytelling_model === "expert_dominance"
  ) {
    if (interruption_style === "bold_claim") {
      return `אחרי ${businessLabel} — ברוב המקרים, אנשים לא חוזרים לשום מקום אחר.`;
    }
    if (attention_strategy === "authority_open") {
      return `${businessLabel} עובדים על זה כל יום. הנה מה שרוב האנשים לא יודעים.`;
    }
  }

  // ── Proof escalation openers ──────────────────────────────────────────────
  if (storytelling_model === "proof_escalation") {
    if (attention_strategy === "result_first") {
      return `תוצאה אמיתית. לא פרסום. תראו מה קורה כשעושים את זה נכון.`;
    }
    if (attention_strategy === "pattern_break") {
      return `הם לא האמינו שזה אפשרי — עד שראו את זה קורה.`;
    }
  }

  // ── Objection collapse openers ────────────────────────────────────────────
  if (storytelling_model === "objection_collapse") {
    if (interruption_style === "question") {
      return `חשבתם שזה לא מתאים לכם? תחכו שנייה לפני שאתם מחליטים.`;
    }
    if (interruption_style === "bold_claim") {
      return `כל מה שחשבתם שאתם יודעים על ${mainOfferLabel} — בדקו שוב.`;
    }
  }

  // ── Problem agitation openers ─────────────────────────────────────────────
  if (storytelling_model === "problem_agitation") {
    if (interruption_style === "verbal_hook") {
      return `יש בעיה שרוב ${audienceLabel} לא מדברים עליה — אבל היא עולה להם ביוקר.`;
    }
    if (attention_strategy === "pain_mirror") {
      return `אם אתם עדיין לא מקבלים ${goalLabel} — זה לא בגללכם.`;
    }
  }

  // ── Local trust openers ───────────────────────────────────────────────────
  if (storytelling_model === "local_trust") {
    if (interruption_style === "question") {
      return `מחפשים ${mainOfferLabel} שמרגיש אמיתי ולא מנותק? תקשיבו לזה.`;
    }
    return `${businessLabel} — כאן, לא בפרסום, לא בהבטחות. בפועל.`;
  }

  // ── Documentary realism ───────────────────────────────────────────────────
  if (storytelling_model === "documentary_realism") {
    return `ביום רגיל ב${businessLabel}, זה מה שבאמת קורה.`;
  }

  // ── Curiosity gap openers ─────────────────────────────────────────────────
  if (attention_strategy === "curiosity_gap") {
    return `יש משהו שרוב ${audienceLabel} לא יודעים על ${mainOfferLabel} — וכדאי לכם לדעת.`;
  }

  // ── Pattern break with visual shock ──────────────────────────────────────
  if (
    attention_strategy === "pattern_break" &&
    interruption_style === "visual_shock"
  ) {
    return `עצרו. ${goalLabel} לא מגיע ממה שאתם חושבים שהוא מגיע.`;
  }

  return undefined; // no strong blueprint match — fall through to existing logic
}

// ─── Hook generation ──────────────────────────────────────────────────────────

function generateHook(
  plan: VideoPlan,
  context: {
    businessProfile: BusinessContentProfile;
    businessLabel: string;
    audienceLabel: string;
    mainOfferLabel: string;
    differentiatorLabel: string;
    goalLabel: string;
  },
  blueprint?: CreativeBlueprint
): string {
  const { businessProfile, audienceLabel, mainOfferLabel, goalLabel } = context;

  // Blueprint-enhanced hook — runs first when blueprint is present
  if (blueprint) {
    const blueprintHook = tryBlueprintHook(blueprint, context);
    if (blueprintHook) return blueprintHook;
  }

  // ── Existing hookStyle logic (unchanged) ──────────────────────────────────
  switch (plan.hookStyle) {
    case "pain_first":
      return `אם גם אתם מרגישים שהדברים לא עובדים כמו שצריך — זה בשבילכם.`;

    case "result_first":
      return `ככה נראה תוכן שיודע להביא ${goalLabel}.`;

    case "trust_first":
      return `אם אתם רוצים להרגיש בטוחים יותר לפני שאתם בוחרים — תקשיבו לזה.`;

    case "offer_first":
      return `יש דרך להציג את ${mainOfferLabel} בצורה שגורמת לאנשים לפעול.`;

    case "pattern_break":
      return `יש משהו שרוב העסקים מפספסים כשהם מנסים להביא ${goalLabel}.`;

    default:
      if (businessProfile.hookPriority === "trust_first") {
        if (businessProfile.trustLevel === "high") {
          return `אם חשוב לכם לבחור נכון ב-${mainOfferLabel} — כדאי שתראו את זה.`;
        }
        return `יש סיבה שיותר ויותר אנשים בוחרים נכון ב-${mainOfferLabel}.`;
      }
      if (businessProfile.hookPriority === "result_first") {
        return `אם אתם רוצים ${goalLabel} — זה בדיוק סוג התוכן שעושה את ההבדל.`;
      }
      if (businessProfile.hookPriority === "offer_first") {
        return `אם חיפשתם ${mainOfferLabel} שבאמת נותן ערך — שווה לכם לעצור רגע.`;
      }
      if (businessProfile.hookPriority === "pattern_break") {
        return `רגע לפני שאתם ממשיכים לגלול — זה משהו ש-${audienceLabel} חייבים לראות.`;
      }
      return `יש משהו שרוב העסקים מפספסים כשהם מנסים להביא ${goalLabel}.`;
  }
}

// ─── Blueprint-aware visual helper ───────────────────────────────────────────

/**
 * Returns a blueprint-flavored visual description for a shot part.
 * undefined means "use the existing visualStrength-based logic."
 */
function tryBlueprintVisual(
  part: string,
  blueprint: CreativeBlueprint,
  context: { mainOfferLabel: string; businessLabel: string }
): string | undefined {
  const { visual_strategy, storytelling_model } = blueprint;
  const { mainOfferLabel, businessLabel } = context;

  switch (visual_strategy) {
    case "local_authentic":
      switch (part) {
        case "hook":
          return `פנים אמיתיות — בעל העסק, עובד, לקוח — מביטים ישירות למצלמה. לא סטודיו, לא תאורה מדהימה. אמיתי.`;
        case "pain":
          return `שוט מתוך המציאות: מקום העסק, תהליך אמיתי, סיטואציה יומיומית שה${context.businessLabel} מכיר.`;
        case "solution":
          return `ידיים עובדות, תהליך בפועל, ${mainOfferLabel} קורה ממש עכשיו — לא סרטון פרסומת.`;
        case "proof":
          return `לקוח אמיתי, תוצאה אמיתית, מקום אמיתי — ראיה שמרגישה כמו אנשים ולא כמו פרסום.`;
        case "trust":
          return `שוט קרוב של ${businessLabel} — פנים, עיניים, נוכחות אנושית שיוצרת חיבור.`;
        case "cta":
          return `שוט ישיר של בעל העסק פונה למצלמה — קריאה אחת ברורה, בלי אפקטים.`;
        default:
          return `שוט אותנטי מהשטח — מקום אמיתי, אנשים אמיתיים, אין צורך בהפקה.`;
      }

    case "stock_footage":
      switch (part) {
        case "hook":
          return `קטע stock אנכי חד ומרשים שמייצג מיד את עולם ${mainOfferLabel} — 2–3 שניות, ללא כיתוב.`;
        case "pain":
          return `stock footage שמראה בבירור את הבעיה או הפער — ללא הסבר, הויזואל מדבר.`;
        case "solution":
          return `stock footage של הפתרון, התהליך, או התוצאה — זווית חיובית, אנרגיה של קדימה.`;
        case "proof":
          return `stock footage של תוצאה, הצלחה, או שביעות רצון — מה שאנשים רוצים להיות.`;
        case "cta":
          return `stock footage נקי עם overlay טקסט — קריאה לפעולה אחת, בולטת.`;
        default:
          return `stock footage אנכי שמחזיק את הקצב ותומך במסר של ${mainOfferLabel}.`;
      }

    case "motion_graphics":
      switch (part) {
        case "hook":
          return `אנימציה קצרה שמכניסה מיד — כיתוב גדול, תנועה, צבעים של המותג. עוצרת את העין.`;
        case "explanation":
          return `אינפוגרפיקה אנימטיבית — שלבים, זרימה, מספרים. הצופה מבין בלי לשמוע מילה.`;
        case "solution":
          return `גרפיקה שמציגה את הפתרון באופן ויזואלי — חצים, אייקונים, מעבר מ-A ל-B.`;
        case "proof":
          return `מספרים גדולים בתנועה — אחוזים, כמויות, זמן. proof שמרגיש עובדתי.`;
        case "cta":
          return `CTA אנימטיבי עם כיתוב, button effect, וצבע בולט — אחת ברורה, לא יותר.`;
        default:
          return `אנימציה קצרה עם מסר אחד — נקי, מדויק, מותאם לקצב ${blueprint.pacing_curve}.`;
      }

    case "typography_heavy":
      switch (part) {
        case "hook":
          return `כיתוב גדול ובולט על מסך — 3–5 מילים. רקע נקי. שתיקה שמדברת.`;
        case "pain":
          return `משפט אחד על המסך — קטן, ישיר, מדויק. כאב בלי עיצוב מיותר.`;
        case "explanation":
          return `טקסט מופיע מילה אחר מילה — קצב איטי, כל מילה נוחתת. ללא עומס.`;
        case "solution":
          return `כיתוב מרכזי עם highlight על המילה המרכזית — הפתרון עומד לבד.`;
        case "cta":
          return `טקסט גדול, רקע צבעוני, פעולה אחת. בלי מחשבה שנייה.`;
        default:
          return `כיתוב ברור על מסך נקי — מסר אחד, ללא הסחות דעת.`;
      }

    case "ui_visuals":
      switch (part) {
        case "hook":
          return `מסך נפתח מהיר — ממשק, אפליקציה, או dashboard. מה שמדבר למי שמכיר.`;
        case "explanation":
          return `הקלטת מסך מונחית — סמן, לחיצות, ועל כל שלב כיתוב קצר שמסביר.`;
        case "solution":
          return `demo זורם של הפיצ׳ר או הפתרון — מה שה${mainOfferLabel} עושה, נראה בפועל.`;
        case "proof":
          return `תוצאות על מסך — מספרים, גרפים, dashboard. עדות של data.`;
        case "cta":
          return `מסך נקי עם כיתוב overlay — link, button, קריאה ברורה לפעולה.`;
        default:
          return `הקלטת מסך קצרה שמייצגת את ${mainOfferLabel} בפעולה.`;
      }

    case "luxury_minimal":
      switch (part) {
        case "hook":
          return `שוט סטטי, יחיד, מוקפד — אובייקט אחד או פנים אחד. שתיקה. אין עומס.`;
        case "solution":
          return `הצגה עדינה של ${mainOfferLabel} — זווית מחושבת, תאורה רכה, אין מילה מיותרת.`;
        case "proof":
          return `פרט קטן, מדויק — חומר, מרקם, תוצאה. פחות זה יותר.`;
        case "cta":
          return `שוט סיום מינימלי — טקסט רזה על רקע נקי. אלגנטי, לא לחוץ.`;
        default:
          return `שוט מינימלי אחד — מרחב, נשימה, ואחד מסר שמדבר בשקט.`;
      }

    default:
      return undefined; // hybrid or unknown → use existing visualStrength logic
  }

  // Also layer storytelling_model for proof shots specifically
  if (part === "proof" && storytelling_model === "proof_escalation") {
    return `הוכחה מצטברת — דוגמה שמובילה לדוגמה גדולה יותר. כל שוט מחזק את הקודם.`;
  }

  return undefined;
}

// ─── Shot visual generation ────────────────────────────────────────────────────

function getVisual(
  part: string,
  plan: VideoPlan,
  context: {
    businessProfile: BusinessContentProfile;
    businessLabel: string;
    audienceLabel: string;
    mainOfferLabel: string;
    differentiatorLabel: string;
    goalLabel: string;
  },
  blueprint?: CreativeBlueprint
): string {
  const { businessProfile, mainOfferLabel } = context;

  // Blueprint-driven visual — runs first
  if (blueprint) {
    const bpVisual = tryBlueprintVisual(part, blueprint, {
      mainOfferLabel,
      businessLabel: context.businessLabel,
    });
    if (bpVisual) return bpVisual;
  }

  // ── Existing visualStrength-based logic (unchanged) ───────────────────────
  if (businessProfile.visualStrength === "high") {
    switch (part) {
      case "hook":        return `פריים פתיחה חזק ואנכי עם נוכחות מיידית סביב ${mainOfferLabel}.`;
      case "pain":        return "המחשה ברורה של הבעיה, התסכול או הפער שהלקוח מרגיש.";
      case "context":     return "שוט שמכניס מהר לסיטואציה ומראה למה זה רלוונטי.";
      case "explanation": return "ויזואל קצר שממחיש את הרעיון תוך כדי דיבור פשוט.";
      case "solution":    return "הדגמה של הפתרון, התהליך או הדרך הנכונה לבצע את זה.";
      case "proof":       return "לפני/אחרי, תוצאה, המחשה או דוגמה שמחזקת אמון.";
      case "result":      return "שוט תוצאה ברור שמראה מה מקבלים בפועל.";
      case "offer":       return "ויזואל ברור שמבליט את ההצעה או הערך המרכזי.";
      case "trust":       return "שוט שמרגיש אמין, מקצועי ומסודר עם נוכחות אנושית.";
      case "value":       return "שוט מהיר ומדויק עם רעיון אחד ברור.";
      case "cta":         return "שוט סיום נקי עם קריאה ברורה אחת לפעולה.";
      default:            return "שוט תומך קצר וברור שמחזיק את הקצב.";
    }
  }

  if (businessProfile.visualStrength === "low") {
    switch (part) {
      case "hook":        return "פריים נקי עם דיבור ישיר למצלמה ותחושת ביטחון.";
      case "pain":        return "שוט יציב שמדגיש את הבעיה בשפה פשוטה.";
      case "context":     return "נוכחות אנושית רגועה שמכניסה להקשר.";
      case "explanation": return "צילום מסביר בגובה העיניים בלי עומס ויזואלי.";
      case "solution":    return "דיבור ברור עם הדגשה של הדרך הנכונה.";
      case "proof":       return "המחשה של דוגמה, הוכחה או מקרה אמיתי.";
      case "trust":       return "שוט מקצועי עם שפת גוף בטוחה.";
      case "cta":         return "שוט סיום רגוע עם קריאה ברורה לפעולה.";
      default:            return "שוט מסודר ונקי שתומך במסר.";
    }
  }

  switch (part) {
    case "hook":        return "צילום קרוב ואנכי עם פתיחה חזקה.";
    case "pain":        return "המחשה של הקושי או הפער הקיים.";
    case "context":     return "שוט שמסביר למה זה רלוונטי עכשיו.";
    case "explanation": return "ויזואל תומך שמבהיר את הנקודה.";
    case "solution":    return "הצגת הפתרון או דרך העבודה.";
    case "proof":       return "תוצאה, דוגמה או המחשה שמחזקים אמון.";
    case "cta":         return "סיום חד עם קריאה אחת לפעולה.";
    default:            return `שוט תומך שמתאים לקצב ${plan.pace}.`;
  }
}

// ─── Blueprint-aware voice tone wrapper ──────────────────────────────────────

/**
 * Applies narration_tone and narration_strategy from blueprint to a voice line.
 * The base line comes from the existing template — this function reshapes it.
 */
function applyBlueprintVoiceTone(
  base: string,
  part: string,
  blueprint: CreativeBlueprint
): string {
  const { narration_strategy, narration_tone, storytelling_model } = blueprint;

  // text_only → ultra short, no sentences
  if (narration_strategy === "text_only") {
    // Collapse to the core idea — strip filler, keep the punch
    const stripped = base
      .replace(/הרבה (פעמים|אנשים)/g, "")
      .replace(/בצורה ש(מרגישה|גורמת|עוזרת)/g, "")
      .replace(/\s+/g, " ")
      .trim();
    // Return only first sentence, max 50 chars
    const firstSentence = stripped.split(/[.?!]/)[0].trim();
    return firstSentence.length > 6 ? firstSentence : base;
  }

  // Storytelling model layers on top of tone
  if (storytelling_model === "proof_escalation" && part === "proof") {
    return `${base} ועכשיו תראו את ההוכחה הבאה.`;
  }

  if (storytelling_model === "objection_collapse" && part === "pain") {
    return `אולי אתם חושבים שאתם כבר יודעים — ${base.charAt(0).toLowerCase() + base.slice(1)}`;
  }

  if (storytelling_model === "problem_agitation" && part === "pain") {
    // Amplify the pain — add urgency
    return `${base} וזה קורה בדיוק כשהכי חשוב שלא יקרה.`;
  }

  // Narration tone reshaping
  switch (narration_tone) {
    case "authoritative":
      // Remove hedging language
      return base
        .replace(/אפשר לחשוב/g, "ברור ש")
        .replace(/יכולים לנסות/g, "חייבים")
        .replace(/כדאי לנסות/g, "הדרך הנכונה היא")
        .replace(/לפעמים/g, "לרוב");

    case "warm":
      // Add proximity — "אנחנו", "ביחד"
      if (!base.includes("אנחנו") && !base.includes("ביחד")) {
        return `${base} אנחנו כאן כדי לעזור לכם להגיע לשם.`;
      }
      return base;

    case "urgent":
      // Strip soft qualifiers, add urgency marker if CTA
      if (part === "cta") {
        return base.replace(/אם תרצו/g, "עכשיו").replace(/שווה לבדוק/g, "פעלו");
      }
      return base;

    case "intimate":
      // First-person confession feeling
      if (part === "pain" && !base.startsWith("אנחנו")) {
        return `אנחנו רואים את זה כל הזמן — ${base.charAt(0).toLowerCase() + base.slice(1)}`;
      }
      return base;

    default:
      return base;
  }
}

// ─── Shot voice generation ────────────────────────────────────────────────────

function getVoice(
  part: string,
  plan: VideoPlan,
  context: {
    businessProfile: BusinessContentProfile;
    businessLabel: string;
    audienceLabel: string;
    mainOfferLabel: string;
    differentiatorLabel: string;
    goalLabel: string;
    contentGoalPrompt?: string;
    directionTitle?: string;
  },
  blueprint?: CreativeBlueprint
): string {
  const {
    businessProfile,
    audienceLabel,
    mainOfferLabel,
    differentiatorLabel,
    goalLabel,
  } = context;

  // ── Existing template logic (unchanged) ───────────────────────────────────
  let base: string;

  switch (part) {
    case "hook":
      base = generateHook(plan, context, blueprint);
      // hook already has blueprint applied — return directly
      return base;

    case "pain":
      if (businessProfile.emotionalDriver === "security") {
        base = `הרבה אנשים רוצים לבחור נכון, אבל בלי הסבר ברור ותחושת ביטחון הם פשוט לא מתקדמים.`;
      } else if (businessProfile.emotionalDriver === "desire") {
        base = `הרבה אנשים רוצים תוצאה טובה יותר, אבל לא תמיד יודעים מה באמת יעזור להם להגיע אליה.`;
      } else if (businessProfile.emotionalDriver === "status") {
        base = `לפעמים יש פער גדול בין איך שרוצים להיראות או להרגיש לבין מה שקורה בפועל.`;
      } else if (businessProfile.emotionalDriver === "convenience") {
        base = `הרבה פעמים אנשים פשוט מחפשים פתרון שיעשה להם את החיים קלים יותר בלי להסתבך.`;
      } else {
        base = `הרבה מ-${audienceLabel} נחשפים לתוכן כל הזמן, אבל לא תמיד מבינים למה דווקא הפתרון הזה רלוונטי עבורם.`;
      }
      break;

    case "context":
      base = `כשהמסר ברור מהשנייה הראשונה, הרבה יותר קל לגרום לאנשים להבין מהר אם זה מתאים להם או לא.`;
      break;

    case "explanation": {
      let explanationBase: string;
      if (businessProfile.contentStyle === "authority") {
        explanationBase = `מה שעושה את ההבדל הוא לא רק מה מציעים, אלא איך מסבירים את זה בצורה שמרגישה מקצועית ואמינה.`;
      } else if (businessProfile.contentStyle === "transformation") {
        explanationBase = `ברגע שמראים נכון את הדרך ואת התוצאה, התוכן הופך מיפה בלבד למשהו שבאמת מזיז אנשים.`;
      } else if (businessProfile.contentStyle === "offer") {
        explanationBase = `לא מספיק להציע משהו טוב, צריך להציג אותו בצורה שאנשים מבינים מיד למה כדאי להם לפעול.`;
      } else {
        explanationBase = `רוב העסקים מדברים יותר מדי כללי, במקום להעביר מסר אחד ברור שאנשים יכולים להבין מהר.`;
      }
      base = explanationVoiceWithOptionalUserCue(explanationBase, context);
      break;
    }

    case "solution": {
      const solutionBase = `במקום זה, מציגים את ${mainOfferLabel} בצורה ברורה, פשוטה ומדויקת יותר — כזאת שמובילה את הצופה צעד קדימה.`;
      const raw =
        normalizeOptionalTrim(context.contentGoalPrompt) ??
        normalizeOptionalTrim(context.directionTitle);
      if (!raw) {
        base = solutionBase;
      } else {
        const normalized = raw.replace(/\s+/g, " ").trim();
        const maxLen = 90;
        const snippet =
          normalized.length <= maxLen
            ? normalized
            : `${normalized.slice(0, maxLen).trim()}…`;
        base = `${solutionBase} כדי שזה ישרת את הכיוון שבחרתם: ${snippet}.`;
      }
      break;
    }

    case "proof":
      if (businessProfile.contentStyle === "testimonial") {
        base = `וכשיש הוכחה אמיתית, דוגמה או חוויה ברורה — הרבה יותר קל לאנשים להאמין שזה באמת יכול להתאים גם להם.`;
      } else if (businessProfile.contentStyle === "transformation") {
        base = `וזה בדיוק מה שעוזר להפוך צפייה סתם, להבנה אמיתית של מה אפשר לקבל כאן.`;
      } else {
        base = `ברגע שרואים תוצאה, דוגמה או היגיון ברור — המסר הופך להרבה יותר משכנע.`;
      }
      break;

    case "result":
      base = `זה הרגע שבו התוכן לא רק מסביר, אלא גם מראה בפועל מה התוצאה שאפשר להגיע אליה.`;
      break;

    case "offer":
      base = `כאן בדיוק מציגים את הערך של ${mainOfferLabel} בצורה שלא משאירה את זה באוויר.`;
      break;

    case "trust":
      base = `כשמעבירים את המסר נכון, הרבה יותר קל לבנות תחושת ביטחון ואמון כבר מהסרטון עצמו.`;
      break;

    case "value":
      base = `הערך האמיתי כאן הוא ${differentiatorLabel}, כי זה מה שעוזר לתוכן לבלוט ולהרגיש רלוונטי יותר.`;
      break;

    case "cta":
      base = getCTAByStyle(plan.ctaStyle, context, blueprint);
      // CTA already has blueprint applied — return directly
      return base;

    default:
      base = `זה מסר קצר, ברור וישיר שמקדם את הסרטון לכיוון של ${goalLabel}.`;
  }

  // Apply blueprint tone/strategy on top of the existing base line
  if (blueprint) {
    return applyBlueprintVoiceTone(base, part, blueprint);
  }

  return base;
}

// ─── CTA generation ────────────────────────────────────────────────────────────

function getCTAByStyle(
  ctaStyle: VideoPlan["ctaStyle"],
  context: {
    businessProfile: BusinessContentProfile;
    businessLabel: string;
    audienceLabel: string;
    mainOfferLabel: string;
    differentiatorLabel: string;
    goalLabel: string;
  },
  blueprint?: CreativeBlueprint
): string {
  const { mainOfferLabel } = context;

  // Blueprint cta_psychology enhances each CTA style
  if (blueprint) {
    const { cta_psychology } = blueprint;

    switch (ctaStyle) {
      case "message_now":
        if (cta_psychology === "urgency") {
          return `הזמן לפעול הוא עכשיו. שלחו הודעה — ונתחיל ביחד.`;
        }
        if (cta_psychology === "trust") {
          return `אין מחויבות. שלחו הודעה ונבדוק יחד אם זה מתאים לכם.`;
        }
        if (cta_psychology === "curiosity") {
          return `רוצים לדעת מה זה יכול לעשות בשבילכם? שלחו הודעה.`;
        }
        if (cta_psychology === "social_proof") {
          return `אלפי אנשים כבר עשו את זה. הצעד הבא — שלחו הודעה.`;
        }
        break;

      case "book_now":
        if (cta_psychology === "urgency") {
          return `המקומות מוגבלים. קבעו עכשיו לפני שזה מתמלא.`;
        }
        if (cta_psychology === "trust") {
          return `ניפגש, נדבר, ואם זה לא מתאים — אין כלום. קבעו.`;
        }
        if (cta_psychology === "curiosity") {
          return `מה תמצאו בפגישה? קבעו ותגלו.`;
        }
        break;

      case "buy_now":
        if (cta_psychology === "urgency") {
          return `מחיר זה, הצעה זו — לא תמיד פה. עברו עכשיו.`;
        }
        if (cta_psychology === "social_proof") {
          return `הרבה אנשים כבר עברו. הצטרפו אליהם עכשיו.`;
        }
        break;

      case "follow":
        if (cta_psychology === "social_proof") {
          return `עוד ${context.audienceLabel} כבר עוקבים. הצטרפו.`;
        }
        if (cta_psychology === "curiosity") {
          return `יש עוד הרבה שלא שיתפנו עדיין. עקבו כדי לא לפספס.`;
        }
        break;

      case "learn_more":
        if (cta_psychology === "curiosity") {
          return `יש פרטים שלא דיברנו עליהם כאן. לחצו לעוד.`;
        }
        if (cta_psychology === "trust") {
          return `קחו את הזמן שלכם — יש עוד מידע שיעזור לכם להחליט.`;
        }
        break;
    }
  }

  // ── Existing CTA templates (unchanged fallback) ───────────────────────────
  switch (ctaStyle) {
    case "message_now":
      return `אם זה מדבר אליכם, זה הזמן לשלוח הודעה ולבדוק איך ${mainOfferLabel} יכול להתאים גם לכם.`;

    case "book_now":
      return `אם אתם רוצים להתקדם, זה הזמן לקבוע ולהפוך את זה לצעד אמיתי.`;

    case "buy_now":
      return `אם זה בדיוק מה שחיפשתם, אפשר לעבור עכשיו לשלב הבא ולפעול.`;

    case "follow":
      return `אם זה נתן לכם ערך, תעקבו — כי יש עוד הרבה תוכן כזה שיכול לעזור לכם.`;

    case "learn_more":
      return `אם אתם רוצים להבין איך זה יכול לעבוד גם אצלכם, שווה לבדוק עוד פרטים ולהתקדם.`;

    default:
      return `אם זה רלוונטי לכם, דברו איתנו ונמשיך משם.`;
  }
}

// ─── Shot list builder ────────────────────────────────────────────────────────

function generateShots(
  plan: VideoPlan,
  context: {
    businessProfile: BusinessContentProfile;
    businessLabel: string;
    audienceLabel: string;
    mainOfferLabel: string;
    differentiatorLabel: string;
    goalLabel: string;
    contentGoalPrompt?: string;
    directionTitle?: string;
  },
  blueprint?: CreativeBlueprint
): Shot[] {
  const structure = plan.structure?.length ? plan.structure : ["hook", "value", "cta"];

  return structure.map((part) => ({
    visual: getVisual(part, plan, context, blueprint),
    voice: getVoice(part, plan, context, blueprint),
  }));
}

// ─── Caption generation ───────────────────────────────────────────────────────

function generateCaption(
  plan: VideoPlan,
  context: {
    businessProfile: BusinessContentProfile;
    businessLabel: string;
    audienceLabel: string;
    mainOfferLabel: string;
    differentiatorLabel: string;
    goalLabel: string;
  },
  blueprint?: CreativeBlueprint
): string {
  const { businessProfile, goalLabel } = context;

  // Blueprint caption — platform_behavior.captionStrategy + cta_psychology
  if (blueprint) {
    const { platform_behavior, cta_psychology, storytelling_model } = blueprint;
    const hashtagNote =
      platform_behavior.hashtagCount > 0
        ? ` #${platform_behavior.hashtagCount > 5 ? "השתמשו ב-10 האשטגים מפוקסים" : "5 האשטגים רלוונטיים"}`
        : "";

    if (platform_behavior.captionStrategy === "short_punch") {
      // Max ~10 words, no fluff
      if (cta_psychology === "urgency") {
        return `עכשיו או מחר. הצעד הבא — אצלנו.${hashtagNote}`;
      }
      if (cta_psychology === "social_proof") {
        return `אחרים כבר עשו את הצעד. תורכם.${hashtagNote}`;
      }
      return `${goalLabel}? תתחילו כאן.${hashtagNote}`;
    }

    if (platform_behavior.captionStrategy === "storytelling") {
      if (storytelling_model === "transformation") {
        return `לפני → אחרי. זה לא קסם — זה מה שקורה כשעושים את זה נכון. רוצים לשמוע עוד? 👇${hashtagNote}`;
      }
      if (storytelling_model === "local_trust") {
        return `אנחנו לא עוד פרסומת. אנחנו אנשים אמיתיים שעושים עבודה אמיתית. שלחו הודעה ונדבר. 👇${hashtagNote}`;
      }
      return `${goalLabel} — זה אפשרי. אנחנו מסבירים איך. קראו, שתפו, פנו. 👇${hashtagNote}`;
    }

    if (platform_behavior.captionStrategy === "keyword_rich") {
      return `${context.mainOfferLabel} | ${goalLabel} | ${context.businessLabel}. לפרטים ופנייה — לינק בביו.${hashtagNote}`;
    }
  }

  // ── Existing caption logic (unchanged fallback) ───────────────────────────
  if (businessProfile.brandPersona === "luxury") {
    return `כשרוצים ${goalLabel}, מציגים את זה נכון. לפרטים נוספים — דברו איתנו ✨`;
  }

  if (businessProfile.brandPersona === "personal") {
    return `אם זה דיבר אליכם, שלחו הודעה ונבדוק יחד מה נכון לכם 👇`;
  }

  if (businessProfile.brandPersona === "energetic") {
    return `רוצים ${goalLabel}? זה הזמן לפעול 👇`;
  }

  switch (plan.goal) {
    case "leads":    return "רוצים לשמוע עוד? שלחו הודעה ונחזור אליכם 👇";
    case "sales":    return "אם זה מתאים לכם — זה הזמן לעבור לשלב הבא 👇";
    case "trust":    return "לעוד תכנים כאלה — תעקבו אחרי העמוד 👍";
    case "exposure": return "מכירים מישהו שזה יכול לעזור לו? תשלחו לו 🙌";
    default:         return "לפרטים נוספים דברו איתנו 👇";
  }
}

// ─── Script text builder ──────────────────────────────────────────────────────

function buildScriptText(hook: string, shots: Shot[]) {
  const lines: string[] = [];
  lines.push(hook);
  shots.forEach((shot, index) => {
    if (index === 0) return;
    lines.push(shot.voice);
  });
  return `${lines.join(". ")}.`;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function generateScript(
  input: GenerateScriptInput
): Promise<GenerateScriptResult> {
  const context = buildContext(input);

  // ─── LLM execution layer ───────────────────────────────────────────────────
  // Runs before templates when CONTENT_LLM_ENABLED=true and a blueprint is present.
  // Any failure or invalid output falls through silently to the template path.
  if (input.blueprint && isLLMEnabled()) {
    const llmResult = await tryGenerateWithLLM({
      blueprint: input.blueprint,
      context: {
        businessLabel:      context.businessLabel,
        audienceLabel:      context.audienceLabel,
        mainOfferLabel:     context.mainOfferLabel,
        differentiatorLabel: context.differentiatorLabel,
        goalLabel:          context.goalLabel,
        contentGoalPrompt:  context.contentGoalPrompt,
        directionTitle:     context.directionTitle,
        directionDescription: context.directionDescription,
        businessCategory:   input.businessCategory,
      },
      plan: {
        platform:  input.videoPlan.platform,
        videoType: input.videoPlan.videoType,
        structure: input.videoPlan.structure?.length
          ? input.videoPlan.structure
          : ["hook", "value", "cta"],
      },
    });

    if (llmResult) {
      const lastIdx = llmResult.shots.length - 1;
      const shots: Shot[] = llmResult.shots.map((s, i) => ({
        visual: s.visual,
        // Normalize: shots[0].voice = hook for display consistency
        // shots[last].voice = cta when the LLM provided an explicit CTA
        voice:
          i === 0
            ? llmResult.hook
            : i === lastIdx && llmResult.cta
            ? llmResult.cta
            : s.voice,
      }));
      return {
        hook:            llmResult.hook,
        scriptText:      buildScriptText(llmResult.hook, shots),
        caption:         llmResult.caption,
        shots,
        businessProfile: context.businessProfile,
      };
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  const hook = generateHook(input.videoPlan, context, input.blueprint);
  const shots = generateShots(input.videoPlan, context, input.blueprint);
  const scriptText = buildScriptText(hook, shots);
  const caption = generateCaption(input.videoPlan, context, input.blueprint);

  const optimized = optimizeScript({
    hook,
    scriptText,
    caption,
    shots,
    businessProfile: context.businessProfile,
    videoPlan: input.videoPlan,
  });

  return {
    hook: optimized.hook,
    scriptText: optimized.scriptText,
    caption: optimized.caption,
    shots: optimized.shots,
    businessProfile: context.businessProfile,
  };
}

// ─── Legacy entry point (generateAIContent) ───────────────────────────────────

type GenerateAIContentInput = {
  type?: string;
  category?: string;
  goal?: string;
  audience?: string | string[];
  valueType?: string;
  style?: string;
  mode?: string;
};

export async function generateAIContent(input: GenerateAIContentInput) {
  const audience = Array.isArray(input.audience)
    ? input.audience
    : input.audience
      ? [input.audience]
      : [];

  return generateScript({
    businessCategory: input.category,
    goal: input.goal,
    audience,
    brandTone: input.style,
    contentAngle: input.valueType,
    videoPlan: {
      videoType: "SHORT",
      durationSeconds: 30,
      pace: "medium",
      structure: ["hook", "pain", "solution", "proof", "cta"],
      hookStyle: "pattern_break",
      ctaStyle: "message_now",
      platform: "instagram",
      goal: input.goal ?? "leads",
      contentAngle: input.valueType,
    },
  });
}
