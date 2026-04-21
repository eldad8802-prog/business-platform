type Shot = {
  visual: string;
  voice?: string;
};

type SelectedFormat = "reel" | "video" | "image" | "post";
type VariantId = "desire" | "trust" | "result";

export type ShotRequest = {
  id: string;
  shotType: "video" | "image";
  durationSeconds: number;
  title: string;
  exactInstruction: string;
  whatMustBeVisible: string;
  framing: string;
  movement: string;
  whyNeeded: string;
  fallbackOption?: string;
};

type Input = {
  shots: Shot[];
  selectedFormat: SelectedFormat;
  variantId: VariantId;
  businessCategory?: string;
  serviceLabel?: string;
};

function isVisualFormat(format: SelectedFormat) {
  return format === "reel" || format === "video";
}

function getShotType(format: SelectedFormat): "video" | "image" {
  return isVisualFormat(format) ? "video" : "image";
}

function getDurationSeconds(
  format: SelectedFormat,
  variantId: VariantId,
  index: number
) {
  if (!isVisualFormat(format)) {
    return 0;
  }

  if (index === 0) {
    return variantId === "desire" ? 3 : 4;
  }

  if (variantId === "trust") {
    return 5;
  }

  if (variantId === "result") {
    return 4;
  }

  return 4;
}

function getFraming(variantId: VariantId, index: number) {
  if (index === 0) {
    return "צילום אנכי, קרוב וברור, שהדבר המרכזי יהיה במרכז הפריים";
  }

  if (variantId === "trust") {
    return "צילום חצי-קרוב או בינוני, שיראו גם את הפעולה וגם את הידיים או הכלי";
  }

  if (variantId === "result") {
    return "צילום ברור עם פוקוס על התוצאה או הערך, בלי עומס בפריים";
  }

  return "צילום קרוב או בינוני, נקי וממוקד, בלי פרטים מיותרים ברקע";
}

function getMovement(variantId: VariantId, format: SelectedFormat) {
  if (!isVisualFormat(format)) {
    return "לשמור על פריים יציב ונקי";
  }

  if (variantId === "desire") {
    return "תנועה עדינה או יד חיה, שירגיש טבעי ולא מבוים מדי";
  }

  if (variantId === "trust") {
    return "תנועה מינימלית, יציבה ונקייה, כדי לשדר מקצועיות";
  }

  return "תנועה טבעית קלה או מצלמה יציבה, לפי מה שמראה טוב יותר את התוצאה";
}

function getWhyNeeded(
  variantId: VariantId,
  index: number,
  format: SelectedFormat
) {
  if (!isVisualFormat(format)) {
    return index === 0
      ? "זה נותן בסיס ויזואלי ברור לפוסט או לתמונה הראשית"
      : "זה מחזק את ההבנה, האמון או ההבדל שהתוכן צריך לייצר";
  }

  if (index === 0) {
    if (variantId === "desire") {
      return "זה השוט שצריך לעצור גלילה ולגרום להמשיך לראות";
    }

    if (variantId === "trust") {
      return "זה השוט שצריך לגרום לצופה להרגיש שיש כאן מקצועיות אמיתית";
    }

    return "זה השוט שצריך להבהיר מהר מה יוצא לצופה מזה";
  }

  if (variantId === "trust") {
    return "זה בונה אמון דרך תהליך, דיוק או הוכחה";
  }

  if (variantId === "result") {
    return "זה מחזק את תחושת התוצאה או הדחיפה לפעולה";
  }

  return "זה מוסיף עניין, המשכיות ותנועה לתוכן";
}

function getFallbackOption(
  variantId: VariantId,
  shotType: "video" | "image",
  serviceLabel?: string
) {
  if (shotType === "image") {
    return "אם אין את הצילום המדויק, אפשר להעלות תמונה נקייה וברורה שממחישה את אותו רגע או את אותה תוצאה";
  }

  if (variantId === "trust") {
    return `אם אין לך את הרגע הזה, אפשר לצלם שלב אחר בתהליך של ${serviceLabel || "העבודה"} מזווית ברורה`;
  }

  if (variantId === "result") {
    return "אם אין לך את השוט הזה, אפשר לצלם תוצאה סופית ברורה או שימוש אמיתי בתוצאה";
  }

  return "אם אין לך את הרגע הזה, אפשר לצלם קלוזאפ חזק אחר שמושך תשומת לב מיד";
}

function cleanVisualText(text: string) {
  return text?.trim() || "רגע ברור מתוך העבודה";
}

function buildExactInstruction(
  shot: Shot,
  shotType: "video" | "image",
  durationSeconds: number
) {
  const visual = cleanVisualText(shot.visual);

  if (shotType === "image") {
    return `תצלם תמונה שמראה ${visual}. חשוב שהתמונה תהיה ברורה, מוארת ונקייה, בלי עומס מסביב.`;
  }

  return `תצלם וידאו של ${durationSeconds} שניות שמראה ${visual}. לא צריך לביים יותר מדי — העיקר שיראו ברור מה קורה בפריים.`;
}

function buildWhatMustBeVisible(shot: Shot, variantId: VariantId) {
  const visual = cleanVisualText(shot.visual);

  if (variantId === "trust") {
    return `חייבים לראות את הפעולה עצמה, את הדיוק, ואת מה שגורם לזה להיראות מקצועי. במקרה הזה: ${visual}.`;
  }

  if (variantId === "result") {
    return `חייבים לראות את התוצאה או את הערך בפועל, ולא רק אווירה. במקרה הזה: ${visual}.`;
  }

  return `חייבים לראות את הדבר המרכזי שתופס את העין. במקרה הזה: ${visual}.`;
}

function buildTitle(index: number, variantId: VariantId) {
  if (index === 0) {
    if (variantId === "desire") return "שוט פתיחה מושך";
    if (variantId === "trust") return "שוט פתיחה שבונה אמון";
    return "שוט פתיחה שמוביל לתוצאה";
  }

  if (variantId === "trust") return `שוט תהליך ${index + 1}`;
  if (variantId === "result") return `שוט תוצאה ${index + 1}`;
  return `שוט עניין ${index + 1}`;
}

export function buildShotRequests(input: Input): ShotRequest[] {
  const shotType = getShotType(input.selectedFormat);

  return input.shots.map((shot, index) => {
    const durationSeconds = getDurationSeconds(
      input.selectedFormat,
      input.variantId,
      index
    );

    return {
      id: `shot_request_${index + 1}`,
      shotType,
      durationSeconds,
      title: buildTitle(index, input.variantId),
      exactInstruction: buildExactInstruction(shot, shotType, durationSeconds),
      whatMustBeVisible: buildWhatMustBeVisible(shot, input.variantId),
      framing: getFraming(input.variantId, index),
      movement: getMovement(input.variantId, input.selectedFormat),
      whyNeeded: getWhyNeeded(input.variantId, index, input.selectedFormat),
      fallbackOption: getFallbackOption(
        input.variantId,
        shotType,
        input.serviceLabel
      ),
    };
  });
}