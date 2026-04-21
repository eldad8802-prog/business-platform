import OpenAI from "openai";
import { Strategy } from "./strategy-engine.service";
import { ContentTaste } from "./content-taste-engine.service";
import { DistributionPlan } from "./content/distribution.service";
import {
  LocalizationRules,
  applyLocalizationPostProcessing,
} from "./content/localization.service";
import { PlatformIntelligence } from "./platform-intelligence.service";
import { ScriptType } from "./script-type-engine.service";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

type Input = {
  concept: {
    idea: string;
    visual: string;
    hook: string;
  };
  businessName: string;
  serviceLabel: string;
  audienceDescription: string;
  selectedFormat: "reel" | "video" | "image" | "post";
  intentType: "desire" | "trust" | "result";
  strategy: Strategy;
  taste: ContentTaste;
  forcedHook: string;
  distribution: DistributionPlan;
  localizationRules: LocalizationRules;
  platformData: PlatformIntelligence;
  userIntentText?: string;
  scriptType: ScriptType;
};

export type ScriptResult = {
  scriptText: string;
  shots: {
    visual: string;
    voice: string;
  }[];
  caption: string;
};

function getScriptTypeRules(scriptType: ScriptType): string {
  if (scriptType === "moment") {
    return `
- לבנות את התוכן כרצף של רגעים קטנים
- להתחיל מרגע שמרגיש שכבר קורה
- פחות הסבר, יותר "מה רואים / מה קורה / מה משתנה"
- כל שורה צריכה לדחוף את הרגע הבא
- לא לכתוב כמו טקסט שיווקי
`;
  }

  if (scriptType === "reaction") {
    return `
- לבנות את התוכן כמו תגובה אמיתית למה שרואים
- מותר משפטים קצרים ושבורים
- מותר טון יומיומי או עקיצה קטנה
- להרגיש כאילו מישהו הגיב ברגע אמת
- לא להישמע מתוסרט
`;
  }

  if (scriptType === "demo") {
    return `
- לבנות את התוכן דרך פעולה אמיתית שרואים
- כל שורה צריכה ללוות שלב או תנועה
- פחות "להסביר", יותר "להראות תוך כדי"
- חשוב שתהיה תחושת התקדמות
`;
  }

  if (scriptType === "authority") {
    return `
- לבנות את התוכן כמו מישהו מקצועי שמראה משהו אמיתי
- לא תאגידי, לא פלצני, לא מרצה
- לשלב היגיון, תהליך והוכחה
- שהביטחון יבוא מהפעולה, לא מהמילים
`;
  }

  if (scriptType === "mistake") {
    return `
- לבנות את התוכן סביב טעות, פספוס או משהו שעושים לא נכון
- לפתוח ישר בבעיה או ברגע שמסמן את הבעיה
- לעבור מהר למה נכון
- לשמור על חדות וקונפליקט
`;
  }

  if (scriptType === "comparison") {
    return `
- לבנות את התוכן דרך ניגוד ברור
- לפני/אחרי, נכון/לא נכון, רגיל/אחר
- כל שורה צריכה לחזק את ההבדל
- לא להסביר יותר מדי, לתת לניגוד לעשות את העבודה
`;
  }

  if (scriptType === "story") {
    return `
- לבנות מיני סיפור עם התחלה, שינוי וסיום
- לא ספרותי ולא דרמטי מדי
- שהסיפור ירגיש כמו משהו שבאמת קרה
- כל שורה צריכה להרגיש כמו רגע בתוך רצף
`;
  }

  return `
- לבנות תוכן ישיר, חד וברור
- להגיד מהר מה הנקודה
- להוביל לפעולה בלי להישמע כמו מודעה
- לשמור על דיבור טבעי
`;
}
function getStoryInstructions(scriptType: string) {
  if (scriptType === "story") {
    return `
לבנות סיפור ברור:
- התחלה (מצב רגיל)
- שינוי / רגע
- תוצאה

כל שורה מתקדמת את הסיפור
`;
  }

  if (scriptType === "moment" || scriptType === "reaction") {
    return `
לבנות מיני סיפור:
- התחלה רגועה
- רגע קטן של שינוי
- תגובה או הבנה

לא רשימת משפטים — רצף
`;
  }

  if (scriptType === "demo") {
    return `
לבנות סיפור של תהליך:
- התחלה
- פעולה
- תוצאה

שירגיש כמו ליווי אמיתי
`;
  }

  if (scriptType === "authority") {
    return `
לבנות סיפור הסבר:
- בעיה
- למה זה קורה
- מה עושים נכון
`;
  }

  return `
אין צורך בסיפור מלא — אבל כן זרימה טבעית
`;
}

function buildPrompt(input: Input) {
  const platformSection = `
התאמה לפלטפורמה:

פלטפורמה: ${input.platformData.platform}
מטרה אלגוריתמית: ${input.platformData.distributionGoal}

חוקי פתיחה:
${input.platformData.hookRules.join("\n")}

מבנה:
${input.platformData.structureRules.join("\n")}

ויזואל:
${input.platformData.visualRules.join("\n")}

CTA:
${input.platformData.ctaRules.join("\n")}

אסור:
${input.platformData.doNotDo.join("\n")}
`;

  const userSection = input.userIntentText
    ? `
כוונת המשתמש (חשוב מאוד):
${input.userIntentText}

חוקים:
- אל תתעלם מזה
- אל תחליף את זה ברעיון אחר
- תשתמש בזה כבסיס לתוכן
- תכתוב כאילו זה יוצא ממנו
- אל תתחיל מאפס — המשך את הכיוון שלו
`
    : "";

  const scriptTypeSection = `
סוג תסריט:
${input.scriptType}

חוקים לסוג הזה:
${getScriptTypeRules(input.scriptType)}
`;

  return `
אתה יוצר תוכן שיווקי ברמה גבוהה מאוד ל-Reels / TikTok / Instagram / Facebook.

המטרה שלך:
לא לכתוב "תסריט טוב".
אלא לבנות תוכן שמרגיש אמיתי, חי, מצולם, ושאפשר ממש לראות אותו קורה.

🚫 איסורים מוחלטים:
- לא להישמע כמו AI
- לא להישמע כמו פרסומת
- לא להישמע כמו תסריט מוקרא
- לא משפטים גנריים כמו "רוב האנשים", "אם גם אתה", "העסק שלך", "זה ההבדל", "ככה זה נראה"
- לא משפטים כלליים שלא רואים בעיניים
- לא ניסוחים "יפים" מדי
- לא פסקאות
- לא שורות מתות שלא מקדמות כלום

✅ חוקים קריטיים:
- עברית טבעית בלבד
- משפטים קצרים
- מותר חצי משפט
- מותר משפט שבור
- מותר ניסוח לא מושלם אם הוא נשמע אמיתי
- עדיף אנושי על מושלם
- עדיף רגע אמיתי על ניסוח מרשים
- כל שורה חייבת להיות משהו שאפשר ממש לדמיין או לצלם
- כל שורה חייבת להרגיש כמו המשך של מה שהיה לפני

הכי חשוב:
אל תכתוב "טקסט".
תכתוב רצף של רגעים.

כל רגע צריך להיות אחד מאלה:
- משהו שרואים
- משהו שקורה
- משהו שמישהו עושה
- משהו שמישהו שם לב אליו
- תגובה
- שינוי קטן
- תוצאה

כללי לוקליזציה:
- preferredTone: ${input.localizationRules.preferredTone}
- bannedPhrases: ${input.localizationRules.bannedPhrases.join(" | ")}
- antiGenericRules: ${input.localizationRules.antiGenericRules.join(" | ")}
- shortSentenceRules: ${input.localizationRules.shortSentenceRules.join(" | ")}

${platformSection}

${userSection}

${scriptTypeSection}

סוג וריאציה:
${input.intentType}

אסטרטגיה:
- type: ${input.strategy.type}
- hookStyle: ${input.strategy.hookStyle}
- ctaType: ${input.strategy.ctaType}
- visualStyle: ${input.strategy.visualStyle}
- distributionHint: ${input.strategy.distributionHint}
- proofStyle: ${input.strategy.proofStyle}
- paceDirection: ${input.strategy.paceDirection}
- emotionDriver: ${input.strategy.emotionDriver}

טעם התוכן:
- tone: ${input.taste.tone}
- energy: ${input.taste.energy}
- pace: ${input.taste.pace}
- style: ${input.taste.style}
- flavorWords: ${input.taste.flavorWords.join(", ")}
- antiGenericRules: ${input.taste.antiGenericRules.join(" | ")}

תוכנית הפצה:
- primaryGoal: ${input.distribution.primaryGoal}
- triggerType: ${input.distribution.triggerType}
- ctaApproach: ${input.distribution.ctaApproach}
- ctaText: ${input.distribution.ctaText}
- pacingHint: ${input.distribution.pacingHint}
- packagingHint: ${input.distribution.packagingHint}
- retentionHint: ${input.distribution.retentionHint}

מידע:
- עסק: ${input.businessName}
- שירות: ${input.serviceLabel}
- קהל: ${input.audienceDescription || "כללי"}
- פורמט: ${input.selectedFormat}

רעיון בסיס:
${input.concept.idea}

ויזואל:
${input.concept.visual}

HOOK שחובה להתחיל איתו:
${input.forcedHook}

איך לחשוב:
- אל תסביר מה קורה — תראה מה קורה
- אל תכתוב על הרגע — תכתוב את הרגע
- אל תדבר כמו משווק — תדבר כמו בן אדם
- אם שורה נשמעת כמו מודעה, תכתוב אותה מחדש
- אם שורה נשמעת כללית, תהפוך אותה לקונקרטית
- אם אפשר להפוך רעיון לפעולה, תבחר בפעולה
- אם אפשר להפוך משפט לתגובה, תבחר בתגובה

מבנה רצוי:
- פתיחה שמרגישה שכבר נכנסנו לסיטואציה
- עוד רגע קטן שמגלה משהו
- עוד רגע שמחזק או משנה
- payoff ברור
- סיום טבעי

דוגמא לסגנון טוב:
"בהתחלה זה נראה רגיל
ואז שמים לב לידיים
פה זה קורה
עוד שנייה רואים את זה
וזה כל ההבדל"

דוגמא לסגנון לא טוב:
"זהו תהליך מקצועי שמראה את ההבדל"
"ככה זה נראה כשעושים את זה נכון"
"זה הרגע שעושה את כל ההבדל"

כלל קריטי:
אם המשתמש נתן כוונה —
אל תכתוב מעליה.
תבנה עליה.

מה אני רוצה ממך:
1. scriptText שהוא רצף של רגעים, לא רשימת משפטים
2. 3 עד 5 shots בלבד
3. בכל shot:
   - visual = משהו מאוד קונקרטי שרואים
   - voice = משהו שבאמת אפשר להגיד מול מצלמה או מעל וידאו
4. caption קצר, טבעי, חד ולא תבניתי
5. שהתוצאה תרגיש מותאמת לישראל
6. שהתוצאה תרגיש מצולמת, לא כתובה
7. שהתוצאה תתאים באמת לסוג התסריט שנבחר

📦 פלט JSON בלבד:

{
  "scriptText": "שורות קצרות, כל שורה בשורה חדשה",
  "shots": [
    {
      "visual": "מה רואים בפועל",
      "voice": "מה אומרים בדיוק"
    }
  ],
  "caption": "כיתוב קצר"
}
`;
}

function safeParse(text: string) {
  try {
    const cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) {
      return null;
    }

    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function postProcessResult(result: ScriptResult): ScriptResult {
  return {
    scriptText: applyLocalizationPostProcessing(result.scriptText),
    caption: applyLocalizationPostProcessing(result.caption),
    shots: result.shots.map((shot) => ({
      visual: applyLocalizationPostProcessing(shot.visual),
      voice: applyLocalizationPostProcessing(shot.voice),
    })),
  };
}

function buildFallback(input: Input): ScriptResult {
  const cta = input.distribution.ctaText;

  if (input.scriptType === "reaction") {
    return postProcessResult({
      scriptText: `${input.forcedHook}

רגע

תראה מה קורה פה

זה בדיוק הקטע`,
      shots: [
        {
          visual: "שוט פתיחה חד עם תגובה או מבט ברור",
          voice: input.forcedHook,
        },
        {
          visual: "רגע קצר שמבליט את ההפתעה או התגובה",
          voice: "רגע",
        },
        {
          visual: "שוט שמראה מה בדיוק קרה כאן",
          voice: "תראה מה קורה פה",
        },
      ],
      caption: "זה הקטע שתופס עין ישר 👇",
    });
  }

  if (input.scriptType === "authority" || input.intentType === "trust") {
    return postProcessResult({
      scriptText: `${input.forcedHook}

פה רואים את ההבדל

לא טריק

פשוט עושים את זה נכון`,
      shots: [
        {
          visual: "שוט יציב ונקי של תחילת התהליך",
          voice: input.forcedHook,
        },
        {
          visual: "הדגמה אמיתית של שלב מקצועי",
          voice: "פה רואים את ההבדל",
        },
        {
          visual: "שלב ברור שמראה דיוק או תשומת לב",
          voice: "פשוט עושים את זה נכון",
        },
      ],
      caption: "ככה זה נראה כשלא מחפשים קיצורי דרך",
    });
  }

  if (input.scriptType === "comparison") {
    return postProcessResult({
      scriptText: `${input.forcedHook}

זה לפני

זה אחרי

ופה רואים מה באמת עובד`,
      shots: [
        {
          visual: "שוט פתיחה שמציג משהו חד וברור",
          voice: input.forcedHook,
        },
        {
          visual: "הצגה של המצב הראשון",
          voice: "זה לפני",
        },
        {
          visual: "הצגה של המצב השני או התוצאה",
          voice: "זה אחרי",
        },
      ],
      caption: "לפעמים ההבדל נראה קטן. בפועל הוא הכל 👇",
    });
  }

  if (input.intentType === "desire" || input.scriptType === "moment") {
    return postProcessResult({
      scriptText: `${input.forcedHook}

זה הקטע

תראה את זה רגע

ואז תבין למה קשה להתעלם מזה`,
      shots: [
        {
          visual: "קלוזאפ חזק עם תנועה עדינה על החלק הכי מושך",
          voice: input.forcedHook,
        },
        {
          visual: "צילום קרוב של הרגע הכי מעניין או מגרה",
          voice: "זה הקטע",
        },
        {
          visual: "שוט שמראה את הדבר מקרוב ובחדות",
          voice: "תראה את זה רגע",
        },
      ],
      caption: "אל תגלול. זה בדיוק הרגע ששווה לראות 👇",
    });
  }

  return postProcessResult({
    scriptText: `${input.forcedHook}

ככה זה נראה כשזה עובד

זאת התוצאה

${cta}`,
    shots: [
      {
        visual: "שוט פתיחה ברור שמראה תוצאה",
        voice: input.forcedHook,
      },
      {
        visual: "צילום שמבליט את הערך או התוצאה",
        voice: "ככה זה נראה כשזה עובד",
      },
      {
        visual: "תוצאה סופית או שימוש אמיתי",
        voice: "זאת התוצאה",
      },
    ],
    caption: `${cta} 👇`,
  });
}

export async function runScriptAI(input: Input): Promise<ScriptResult> {
  try {
    const prompt = buildPrompt(input);

    const response = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.9,
    });

    const text = response.choices[0]?.message?.content || "";
    const parsed = safeParse(text);

    if (!parsed || !parsed.scriptText || !Array.isArray(parsed.shots)) {
      return buildFallback(input);
    }

    const result: ScriptResult = {
      scriptText:
        typeof parsed.scriptText === "string" ? parsed.scriptText : "",
      shots: Array.isArray(parsed.shots)
        ? parsed.shots.map((shot: any) => ({
            visual:
              typeof shot?.visual === "string"
                ? shot.visual
                : "שוט לא הוגדר",
            voice: typeof shot?.voice === "string" ? shot.voice : "",
          }))
        : [],
      caption: typeof parsed.caption === "string" ? parsed.caption : "",
    };

    return postProcessResult(result);
  } catch (error) {
    console.error("SCRIPT AI ERROR:", error);
    return buildFallback(input);
  }
}