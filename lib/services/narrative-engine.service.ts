import { ContentPattern } from "./content-pattern-engine.service";

export type IntentType = "desire" | "trust" | "result";

type NarrativeInput = {
  pattern: ContentPattern;
  intentType: IntentType;
  businessName: string;
  serviceLabel: string;
  forcedHook?: string;
  ctaOverride?: string;
  proofStyle?: string;
};

export type Narrative = {
  hook: string;
  build: string;
  payoff: string;
  proof?: string;
  cta: string;
};

function withOverrides(
  base: Narrative,
  forcedHook?: string,
  ctaOverride?: string
): Narrative {
  return {
    ...base,
    hook: forcedHook || base.hook,
    cta: ctaOverride || base.cta,
  };
}

export function buildNarrative(input: NarrativeInput): Narrative {
  const { pattern, intentType, serviceLabel, forcedHook, ctaOverride, proofStyle } = input;

  if (pattern === "PATTERN_BREAK") {
    if (intentType === "desire") {
      return withOverrides(
        {
          hook: "אל תזוז — זה נהיה טוב יותר בעוד רגע",
          build: "תראה מה קורה כאן בשנייה אחת",
          payoff: `זה ${serviceLabel} ברמה אחרת לגמרי`,
          proof:
            proofStyle === "visual_proof"
              ? "העין קולטת את זה מיד"
              : "וזה בדיוק הרגע שתופס את העין",
          cta: "תמשיכו לראות",
        },
        forcedHook,
        ctaOverride
      );
    }

    if (intentType === "trust") {
      return withOverrides(
        {
          hook: "רואים רק את התוצאה, אבל ההבדל מתחיל כאן",
          build: "כאן קורה הדבר שבאמת משנה",
          payoff: `ככה ${serviceLabel} נראה כשעושים אותו נכון`,
          proof: "לא קיצור דרך — עבודה מדויקת",
          cta: "עקבו לעוד",
        },
        forcedHook,
        ctaOverride
      );
    }

    return withOverrides(
      {
        hook: "זה הרגע שעושה את כל ההבדל",
        build: "בהתחלה זה נראה רגיל",
        payoff: `ואז רואים למה ${serviceLabel} עובד`,
        proof: "זה לא במקרה",
        cta: "שלחו הודעה עכשיו",
      },
      forcedHook,
      ctaOverride
    );
  }

  if (pattern === "WAIT_FOR_IT") {
    if (intentType === "desire") {
      return withOverrides(
        {
          hook: "חכה לרגע הזה",
          build: "זה מתחיל רגיל לגמרי",
          payoff: "אבל הסוף הוא מה שתופס אותך",
          proof: "וזה בדיוק מה שגורם לעצור",
          cta: "תמשיכו לראות",
        },
        forcedHook,
        ctaOverride
      );
    }

    if (intentType === "trust") {
      return withOverrides(
        {
          hook: "אל תדלג על השלב הזה",
          build: "כאן רואים אם זה מקצועי או חפיף",
          payoff: "הפרטים הקטנים עושים כאן את כל ההבדל",
          proof: "וזה מה שמפריד בין סתם לבין נכון",
          cta: "עקבו לעוד",
        },
        forcedHook,
        ctaOverride
      );
    }

    return withOverrides(
      {
        hook: "עוד רגע תבין למה זה עובד",
        build: "זה לא רק איך שזה נראה",
        payoff: "זה מה שקורה בסוף שגורם לפעולה",
        proof: "ופה רואים תוצאה אמיתית",
        cta: "שלחו הודעה עכשיו",
      },
      forcedHook,
      ctaOverride
    );
  }

  if (pattern === "BEFORE_AFTER") {
    return withOverrides(
      {
        hook: "לפני זה נראה ככה",
        build: "ואחרי זה נראה אחרת לגמרי",
        payoff: `זה ההבדל כש${serviceLabel} נעשה נכון`,
        proof: "אי אפשר לפספס את הפער",
        cta: intentType === "result" ? "שלחו הודעה עכשיו" : "תמשיכו לראות",
      },
      forcedHook,
      ctaOverride
    );
  }

  if (pattern === "POV") {
    if (intentType === "desire") {
      return withOverrides(
        {
          hook: "POV: נכנסת רק להציץ",
          build: "ואז אתה רואה את זה מקרוב",
          payoff: "ומבין שאין סיכוי להמשיך לגלול",
          proof: "זה בדיוק רגע של חשק",
          cta: "תמשיכו לראות",
        },
        forcedHook,
        ctaOverride
      );
    }

    if (intentType === "trust") {
      return withOverrides(
        {
          hook: "POV: אתה רוצה לדעת אם זה באמת ברמה",
          build: "אז אתה מסתכל על הפרטים",
          payoff: "ושם רואים אם יש פה מקצוענות",
          proof: "לא מילים — ביצוע",
          cta: "עקבו לעוד",
        },
        forcedHook,
        ctaOverride
      );
    }

    return withOverrides(
      {
        hook: "POV: אתה רוצה תוצאה ולא תירוצים",
        build: "אז אתה מסתכל על מה קורה בפועל",
        payoff: "וכאן מבינים מה באמת שווה",
        proof: "תוצאה ברורה מול העיניים",
        cta: "שלחו הודעה עכשיו",
      },
      forcedHook,
      ctaOverride
    );
  }

  if (pattern === "MISTAKE") {
    if (intentType === "trust") {
      return withOverrides(
        {
          hook: "זאת הטעות שאנחנו רואים כל הזמן",
          build: "זה נראה קטן, אבל זה משנה הכל",
          payoff: "וככה עושים את זה נכון באמת",
          proof: "כאן רואים מקצועיות אמיתית",
          cta: "עקבו לעוד",
        },
        forcedHook,
        ctaOverride
      );
    }

    return withOverrides(
      {
        hook: "כאן כולם נופלים",
        build: "עושים את זה בדרך הרגילה",
        payoff: "אבל זאת בדיוק הסיבה שזה לא עובד",
        proof: "השינוי הקטן הזה משנה הכל",
        cta: intentType === "result" ? "שלחו הודעה עכשיו" : "תשמרו את זה",
      },
      forcedHook,
      ctaOverride
    );
  }

  if (pattern === "SECRET") {
    return withOverrides(
      {
        hook: "הסוד שלא באמת רואים בהתחלה",
        build: "זה לא מה שכולם חושבים",
        payoff: `זה מה שבאמת גורם ל${serviceLabel} לעבוד`,
        proof: "וכאן רואים את ההבדל",
        cta: intentType === "trust" ? "עקבו לעוד" : "תמשיכו לראות",
      },
      forcedHook,
      ctaOverride
    );
  }

  if (pattern === "PROCESS") {
    if (intentType === "trust") {
      return withOverrides(
        {
          hook: "ככה זה נראה מאחורי הקלעים",
          build: "שלב אחרי שלב, בלי לחפף",
          payoff: `וזה מה שהופך את ${serviceLabel} למדויק`,
          proof: "כאן רואים את העבודה האמיתית",
          cta: "עקבו לעוד",
        },
        forcedHook,
        ctaOverride
      );
    }

    return withOverrides(
      {
        hook: "בוא תראה איך זה קורה באמת",
        build: "לא מהר ולא סתם",
        payoff: "אלא בדיוק כמו שצריך",
        proof: "וזה מה שיוצר את התוצאה",
        cta: intentType === "result" ? "שלחו הודעה עכשיו" : "תמשיכו לראות",
      },
      forcedHook,
      ctaOverride
    );
  }

  if (pattern === "RESULT") {
    return withOverrides(
      {
        hook: "תראה את התוצאה הזאת",
        build: "זה התחיל רגיל לגמרי",
        payoff: `וזה נגמר ב${serviceLabel} שנראה אחרת`,
        proof: "כאן התוצאה כבר מדברת לבד",
        cta: intentType === "result" ? "שלחו הודעה עכשיו" : "תמשיכו לראות",
      },
      forcedHook,
      ctaOverride
    );
  }

  if (pattern === "REACTION") {
    return withOverrides(
      {
        hook: "זאת בדיוק התגובה שחיכינו לה",
        build: "ברגע שרואים את זה מקרוב",
        payoff: "מבינים למה קשה להישאר אדישים",
        proof: "זה פשוט עובד על אנשים",
        cta: intentType === "result" ? "שלחו הודעה עכשיו" : "תמשיכו לראות",
      },
      forcedHook,
      ctaOverride
    );
  }

  return withOverrides(
    {
      hook: "תראה את זה רגע",
      build: "משהו מעניין קורה כאן",
      payoff: `ככה ${serviceLabel} נראה כשהוא עובד`,
      proof: "ופה כבר מרגישים את ההבדל",
      cta: intentType === "trust" ? "עקבו לעוד" : "שלחו הודעה עכשיו",
    },
    forcedHook,
    ctaOverride
  );
}