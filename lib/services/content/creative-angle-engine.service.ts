type GoalType = "leads" | "exposure" | "trust" | "sales";
type IntentType = "watch" | "follow" | "message" | "sale";

export type CreativeAngleType =
  | "mistake"
  | "secret"
  | "pov"
  | "reaction"
  | "unexpected"
  | "comparison"
  | "process_truth"
  | "myth_break"
  | "speed"
  | "emotion";

export type CreativeAngle = {
  angleType: CreativeAngleType;
  description: string;
  hookDirection: string;
  emotionalTrigger: string;
};

type Input = {
  goal: GoalType;
  intent: IntentType;
  businessCategory?: string;
  audienceDescription?: string;
  variantId?: "desire" | "trust" | "result";
};

function isFoodBusiness(category?: string) {
  const value = (category || "").toLowerCase();

  return (
    value.includes("food") ||
    value.includes("restaurant") ||
    value.includes("אוכל") ||
    value.includes("מסעדה") ||
    value.includes("מטבח") ||
    value.includes("מזון")
  );
}

function pickFromList<T>(items: T[]): T {
  const index = Math.floor(Math.random() * items.length);
  return items[index];
}

export function getCreativeAngle(input: Input): CreativeAngle {
  const food = isFoodBusiness(input.businessCategory);

  if (input.goal === "trust" || input.variantId === "trust") {
    return pickFromList([
      {
        angleType: "process_truth",
        description: "התוכן בנוי סביב אמת מקצועית שרואים רק כשמסתכלים על התהליך",
        hookDirection: "לפתוח בשלב שרוב האנשים לא שמים לב אליו",
        emotionalTrigger: "ביטחון ומקצועיות",
      },
      {
        angleType: "myth_break",
        description: "התוכן שוברת תפיסה שגויה נפוצה בתחום",
        hookDirection: "לפתוח במה שאנשים חושבים ואז לשבור את זה",
        emotionalTrigger: "גילוי ואמון",
      },
      {
        angleType: "secret",
        description: "התוכן חושף משהו שלא תמיד רואים מהצד",
        hookDirection: "לפתוח ברמז או פרט נסתר",
        emotionalTrigger: "סקרנות עם תחושת עומק",
      },
    ]);
  }

  if (input.goal === "sales" || input.variantId === "result") {
    return pickFromList([
      {
        angleType: "comparison",
        description: "התוכן בנוי על ניגוד חד בין לפני/אחרי או רגיל/נכון",
        hookDirection: "לפתוח בהבדל ברור מאוד",
        emotionalTrigger: "רצון בתוצאה",
      },
      {
        angleType: "speed",
        description: "התוכן בנוי על מהירות, יעילות או קיצור דרך לתוצאה",
        hookDirection: "לפתוח במהירות או payoff מהיר",
        emotionalTrigger: "דחיפות ותועלת",
      },
      {
        angleType: "unexpected",
        description: "התוכן בנוי על תוצאה שלא ציפו לה או רגע מפתיע",
        hookDirection: "לפתוח במשהו שנראה קטן אבל נגמר בגדול",
        emotionalTrigger: "הפתעה שמובילה לפעולה",
      },
    ]);
  }

  if (input.goal === "leads" || input.intent === "message") {
    return pickFromList([
      {
        angleType: "mistake",
        description: "התוכן בנוי סביב טעות נפוצה שגורמת לאנשים לפספס תוצאה",
        hookDirection: "לפתוח ישר בטעות או בפספוס",
        emotionalTrigger: "פחד להמשיך לא נכון",
      },
      {
        angleType: "reaction",
        description: "התוכן בנוי כמו תגובה מיידית למשהו שרואים",
        hookDirection: "לפתוח במשפט קצר שמרגיש כמו תגובה אמיתית",
        emotionalTrigger: "עניין וקרבה",
      },
      {
        angleType: "comparison",
        description: "התוכן בנוי על הבדל חד שגורם להבין מהר מה עדיף",
        hookDirection: "לפתוח בניגוד שמבהיר מה לא עובד ומה כן",
        emotionalTrigger: "בהירות ורצון לפעול",
      },
    ]);
  }

  if (food) {
    return pickFromList([
      {
        angleType: "reaction",
        description: "התוכן בנוי על תגובה לרגע ויזואלי חזק או מגרה",
        hookDirection: "לפתוח כאילו תופסים רגע אמיתי באמצע",
        emotionalTrigger: "חשק מיידי",
      },
      {
        angleType: "pov",
        description: "התוכן בנוי מנקודת מבט של הצופה שנכנס לרגע",
        hookDirection: "לפתוח כאילו הצופה כבר בתוך הסיטואציה",
        emotionalTrigger: "חיבור מיידי",
      },
      {
        angleType: "unexpected",
        description: "התוכן בנוי על רגע קטן שנהיה הרבה יותר מעניין משציפו",
        hookDirection: "לפתוח במשהו רגיל ואז להפוך אותו",
        emotionalTrigger: "הפתעה ועניין",
      },
    ]);
  }

  return pickFromList([
    {
      angleType: "pov",
      description: "התוכן בנוי מנקודת מבט ישירה של הצופה או הלקוח",
      hookDirection: "לפתוח כאילו הצופה כבר בתוך הסיטואציה",
      emotionalTrigger: "הזדהות",
    },
    {
      angleType: "emotion",
      description: "התוכן בנוי סביב תחושה או רגש שהקהל מזהה מיד",
      hookDirection: "לפתוח במשפט קצר עם תחושה ברורה",
      emotionalTrigger: "רגש",
    },
    {
      angleType: "reaction",
      description: "התוכן בנוי כמו רגע אמיתי שמגיבים אליו",
      hookDirection: "לפתוח כמו תגובה ולא כמו תסריט",
      emotionalTrigger: "ספונטניות",
    },
  ]);
}