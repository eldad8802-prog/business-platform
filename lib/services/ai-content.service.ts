import { optimizeScript } from "@/lib/services/content-optimizer.service";
import {
  getBusinessContentProfile,
  type BusinessContentProfile,
} from "@/lib/services/business-content-profile.service";

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

function getGoalLabel(goal?: string) {
  switch (goal) {
    case "leads":
      return "יותר פניות";
    case "trust":
      return "יותר אמון";
    case "exposure":
      return "יותר חשיפה";
    case "sales":
      return "יותר מכירות";
    default:
      return "תוצאה עסקית טובה יותר";
  }
}

function getAudienceLabel(audience?: string[]) {
  if (!audience || audience.length === 0) {
    return "הקהל הנכון";
  }

  if (audience.length === 1) {
    return audience[0];
  }

  return audience.join(", ");
}

function getBusinessLabel(input: GenerateScriptInput) {
  if (input.businessName?.trim()) {
    return input.businessName.trim();
  }

  if (input.businessType?.trim()) {
    return input.businessType.trim();
  }

  if (input.businessCategory?.trim()) {
    return input.businessCategory.trim();
  }

  return "העסק";
}

function getMainOfferLabel(input: GenerateScriptInput) {
  if (input.services?.length) {
    return input.services[0];
  }

  if (input.products?.length) {
    return input.products[0];
  }

  return "השירות או המוצר שלך";
}

function getDifferentiatorLabel(input: GenerateScriptInput) {
  if (input.differentiators?.length) {
    return input.differentiators[0];
  }

  return "הדרך שבה אתם מציגים את הערך שלכם";
}

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
  };
}

export async function generateScript(
  input: GenerateScriptInput
): Promise<GenerateScriptResult> {
  const context = buildContext(input);
  const hook = generateHook(input.videoPlan, context);
  const shots = generateShots(input.videoPlan, context);
  const scriptText = buildScriptText(hook, shots);
  const caption = generateCaption(input.videoPlan, context);

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

function generateHook(
  plan: VideoPlan,
  context: {
    businessProfile: BusinessContentProfile;
    businessLabel: string;
    audienceLabel: string;
    mainOfferLabel: string;
    differentiatorLabel: string;
    goalLabel: string;
  }
): string {
  const { businessProfile, audienceLabel, mainOfferLabel, goalLabel } = context;

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
    default:
      return `יש משהו שרוב העסקים מפספסים כשהם מנסים להביא ${goalLabel}.`;
  }
}

function generateShots(
  plan: VideoPlan,
  context: {
    businessProfile: BusinessContentProfile;
    businessLabel: string;
    audienceLabel: string;
    mainOfferLabel: string;
    differentiatorLabel: string;
    goalLabel: string;
  }
): Shot[] {
  const structure = plan.structure?.length ? plan.structure : ["hook", "value", "cta"];

  return structure.map((part) => ({
    visual: getVisual(part, plan, context),
    voice: getVoice(part, plan, context),
  }));
}

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
  }
): string {
  const { businessProfile, mainOfferLabel } = context;

  if (businessProfile.visualStrength === "high") {
    switch (part) {
      case "hook":
        return `פריים פתיחה חזק ואנכי עם נוכחות מיידית סביב ${mainOfferLabel}.`;
      case "pain":
        return "המחשה ברורה של הבעיה, התסכול או הפער שהלקוח מרגיש.";
      case "context":
        return "שוט שמכניס מהר לסיטואציה ומראה למה זה רלוונטי.";
      case "explanation":
        return "ויזואל קצר שממחיש את הרעיון תוך כדי דיבור פשוט.";
      case "solution":
        return "הדגמה של הפתרון, התהליך או הדרך הנכונה לבצע את זה.";
      case "proof":
        return "לפני/אחרי, תוצאה, המחשה או דוגמה שמחזקת אמון.";
      case "result":
        return "שוט תוצאה ברור שמראה מה מקבלים בפועל.";
      case "offer":
        return "ויזואל ברור שמבליט את ההצעה או הערך המרכזי.";
      case "trust":
        return "שוט שמרגיש אמין, מקצועי ומסודר עם נוכחות אנושית.";
      case "value":
        return "שוט מהיר ומדויק עם רעיון אחד ברור.";
      case "cta":
        return "שוט סיום נקי עם קריאה ברורה אחת לפעולה.";
      default:
        return "שוט תומך קצר וברור שמחזיק את הקצב.";
    }
  }

  if (businessProfile.visualStrength === "low") {
    switch (part) {
      case "hook":
        return "פריים נקי עם דיבור ישיר למצלמה ותחושת ביטחון.";
      case "pain":
        return "שוט יציב שמדגיש את הבעיה בשפה פשוטה.";
      case "context":
        return "נוכחות אנושית רגועה שמכניסה להקשר.";
      case "explanation":
        return "צילום מסביר בגובה העיניים בלי עומס ויזואלי.";
      case "solution":
        return "דיבור ברור עם הדגשה של הדרך הנכונה.";
      case "proof":
        return "המחשה של דוגמה, הוכחה או מקרה אמיתי.";
      case "trust":
        return "שוט מקצועי עם שפת גוף בטוחה.";
      case "cta":
        return "שוט סיום רגוע עם קריאה ברורה לפעולה.";
      default:
        return "שוט מסודר ונקי שתומך במסר.";
    }
  }

  switch (part) {
    case "hook":
      return "צילום קרוב ואנכי עם פתיחה חזקה.";
    case "pain":
      return "המחשה של הקושי או הפער הקיים.";
    case "context":
      return "שוט שמסביר למה זה רלוונטי עכשיו.";
    case "explanation":
      return "ויזואל תומך שמבהיר את הנקודה.";
    case "solution":
      return "הצגת הפתרון או דרך העבודה.";
    case "proof":
      return "תוצאה, דוגמה או המחשה שמחזקים אמון.";
    case "cta":
      return "סיום חד עם קריאה אחת לפעולה.";
    default:
      return `שוט תומך שמתאים לקצב ${plan.pace}.`;
  }
}

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
  }
): string {
  const {
    businessProfile,
    audienceLabel,
    mainOfferLabel,
    differentiatorLabel,
    goalLabel,
  } = context;

  switch (part) {
    case "hook":
      return generateHook(plan, context);

    case "pain":
      if (businessProfile.emotionalDriver === "security") {
        return `הרבה אנשים רוצים לבחור נכון, אבל בלי הסבר ברור ותחושת ביטחון הם פשוט לא מתקדמים.`;
      }

      if (businessProfile.emotionalDriver === "desire") {
        return `הרבה אנשים רוצים תוצאה טובה יותר, אבל לא תמיד יודעים מה באמת יעזור להם להגיע אליה.`;
      }

      if (businessProfile.emotionalDriver === "status") {
        return `לפעמים יש פער גדול בין איך שרוצים להיראות או להרגיש לבין מה שקורה בפועל.`;
      }

      if (businessProfile.emotionalDriver === "convenience") {
        return `הרבה פעמים אנשים פשוט מחפשים פתרון שיעשה להם את החיים קלים יותר בלי להסתבך.`;
      }

      return `הרבה מ-${audienceLabel} נחשפים לתוכן כל הזמן, אבל לא תמיד מבינים למה דווקא הפתרון הזה רלוונטי עבורם.`;

    case "context":
      return `כשהמסר ברור מהשנייה הראשונה, הרבה יותר קל לגרום לאנשים להבין מהר אם זה מתאים להם או לא.`;

    case "explanation":
      if (businessProfile.contentStyle === "authority") {
        return `מה שעושה את ההבדל הוא לא רק מה מציעים, אלא איך מסבירים את זה בצורה שמרגישה מקצועית ואמינה.`;
      }

      if (businessProfile.contentStyle === "transformation") {
        return `ברגע שמראים נכון את הדרך ואת התוצאה, התוכן הופך מיפה בלבד למשהו שבאמת מזיז אנשים.`;
      }

      if (businessProfile.contentStyle === "offer") {
        return `לא מספיק להציע משהו טוב, צריך להציג אותו בצורה שאנשים מבינים מיד למה כדאי להם לפעול.`;
      }

      return `רוב העסקים מדברים יותר מדי כללי, במקום להעביר מסר אחד ברור שאנשים יכולים להבין מהר.`;

    case "solution":
      return `במקום זה, מציגים את ${mainOfferLabel} בצורה ברורה, פשוטה ומדויקת יותר — כזאת שמובילה את הצופה צעד קדימה.`

    case "proof":
      if (businessProfile.contentStyle === "testimonial") {
        return `וכשיש הוכחה אמיתית, דוגמה או חוויה ברורה — הרבה יותר קל לאנשים להאמין שזה באמת יכול להתאים גם להם.`;
      }

      if (businessProfile.contentStyle === "transformation") {
        return `וזה בדיוק מה שעוזר להפוך צפייה סתם, להבנה אמיתית של מה אפשר לקבל כאן.`;
      }

      return `ברגע שרואים תוצאה, דוגמה או היגיון ברור — המסר הופך להרבה יותר משכנע.`;

    case "result":
      return `זה הרגע שבו התוכן לא רק מסביר, אלא גם מראה בפועל מה התוצאה שאפשר להגיע אליה.`;

    case "offer":
      return `כאן בדיוק מציגים את הערך של ${mainOfferLabel} בצורה שלא משאירה את זה באוויר.`;

    case "trust":
      return `כשמעבירים את המסר נכון, הרבה יותר קל לבנות תחושת ביטחון ואמון כבר מהסרטון עצמו.`;

    case "value":
      return `הערך האמיתי כאן הוא ${differentiatorLabel}, כי זה מה שעוזר לתוכן לבלוט ולהרגיש רלוונטי יותר.`;

    case "cta":
      return getCTAByStyle(plan.ctaStyle, context);

    default:
      return `זה מסר קצר, ברור וישיר שמקדם את הסרטון לכיוון של ${goalLabel}.`;
  }
}

function getCTAByStyle(
  ctaStyle: VideoPlan["ctaStyle"],
  context: {
    businessProfile: BusinessContentProfile;
    businessLabel: string;
    audienceLabel: string;
    mainOfferLabel: string;
    differentiatorLabel: string;
    goalLabel: string;
  }
): string {
  const { mainOfferLabel } = context;

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

function buildScriptText(hook: string, shots: Shot[]) {
  const lines: string[] = [];

  lines.push(hook);

  shots.forEach((shot, index) => {
    if (index === 0) return;
    lines.push(shot.voice);
  });

  return `${lines.join(". ")}.`;
}

function generateCaption(
  plan: VideoPlan,
  context: {
    businessProfile: BusinessContentProfile;
    businessLabel: string;
    audienceLabel: string;
    mainOfferLabel: string;
    differentiatorLabel: string;
    goalLabel: string;
  }
) {
  const { businessProfile, goalLabel } = context;

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
    case "leads":
      return "רוצים לשמוע עוד? שלחו הודעה ונחזור אליכם 👇";

    case "sales":
      return "אם זה מתאים לכם — זה הזמן לעבור לשלב הבא 👇";

    case "trust":
      return "לעוד תכנים כאלה — תעקבו אחרי העמוד 👍";

    case "exposure":
      return "מכירים מישהו שזה יכול לעזור לו? תשלחו לו 🙌";

    default:
      return "לפרטים נוספים דברו איתנו 👇";
  }
}