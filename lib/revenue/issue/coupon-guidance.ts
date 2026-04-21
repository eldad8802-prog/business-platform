export type CouponGuidanceInput = {
  businessProfile: {
    category?: string;
    subCategory?: string;
    businessModel?: string;
  } | null;

  context: {
    situation?: string;
    goal?: string;
  };
};

export type CouponGuidanceOutput = {
  why: string;
  tip: string;
  example: string;
  caution: string;
};

/* =========================
   ARCHETYPE DETECTION
========================= */

function detectArchetype(category: string = "", model: string = "") {
  const c = category.toLowerCase();

  if (c.includes("beauty") || c.includes("טיפוח")) return "REPEAT_SERVICE";
  if (c.includes("restaurant") || c.includes("מסעדה")) return "OCCUPANCY";
  if (c.includes("fitness") || c.includes("אימון")) return "TIME_BASED";
  if (c.includes("shop") || c.includes("חנות")) return "INVENTORY";
  if (model === "service") return "TIME_BASED";

  return "GENERAL";
}

/* =========================
   STRATEGY RULES
========================= */

function buildGuidance(
  archetype: string,
  situation?: string,
  goal?: string
): CouponGuidanceOutput {
  // 🔥 מצב: זמן פנוי
  if (situation === "IDLE_TIME") {
    return {
      why: "כאשר יש זמן לא מנוצל, קופון יכול להפוך זמן ריק להכנסה.",
      tip: "מקד את הקופון לשעות או ימים חלשים בלבד.",
      example: "קופון לימים א׳–ג׳ בשעות הצהריים.",
      caution: "אל תפתח את הקופון לשעות חזקות.",
    };
  }

  // 🔥 מטרה: לקוחות חדשים
  if (goal === "BRING_NEW_CUSTOMERS") {
    return {
      why: "קופון יכול להיות דרך מבוקרת להביא לקוחות חדשים.",
      tip: "הגבל את הקופון לשימוש ראשון בלבד.",
      example: "קופון ללקוחות חדשים בלבד.",
      caution: "אל תאפשר שימוש חוזר לאותו לקוח.",
    };
  }

  // 🔥 לפי סוג עסק
  switch (archetype) {
    case "REPEAT_SERVICE":
      return {
        why: "השירות שלך יכול להוביל ללקוח חוזר, ולכן קופון מתאים ככניסה ראשונית.",
        tip: "התמקד בטיפול ראשון בלבד.",
        example: "קופון לטיפול ראשון בלבד.",
        caution: "אל תפגע בערך השירות שלך.",
      };

    case "OCCUPANCY":
      return {
        why: "מקומות ריקים הם הכנסה אבודה שניתן למלא עם קופון ממוקד.",
        tip: "הגבל לפי ימים או שעות.",
        example: "קופון לימי חול בלבד.",
        caution: "אל תפעיל בשעות שיא.",
      };

    case "INVENTORY":
      return {
        why: "מלאי שלא נמכר הוא כסף תקוע.",
        tip: "מקד את הקופון לפריטים מסוימים.",
        example: "קופון לפריטי סוף עונה.",
        caution: "אל תפתח לכל החנות.",
      };

    case "TIME_BASED":
      return {
        why: "זמן פנוי הוא משאב שלא ניתן להחזיר.",
        tip: "הגבל לשעות חלשות.",
        example: "קופון לשעות צהריים.",
        caution: "אל תשתמש בזמנים עמוסים.",
      };

    default:
      return {
        why: "קופון ממוקד יכול לעזור לייצר פעילות עסקית מדויקת.",
        tip: "בחר קהל יעד או זמן ספציפי.",
        example: "קופון למוצר או שירות מסוים.",
        caution: "אל תיצור קופון רחב מדי.",
      };
  }
}

/* =========================
   MAIN ENGINE
========================= */

export function getCouponGuidance(
  input: CouponGuidanceInput
): CouponGuidanceOutput {
  const category = input.businessProfile?.category || "";
  const model = input.businessProfile?.businessModel || "";

  const archetype = detectArchetype(category, model);

  return buildGuidance(
    archetype,
    input.context?.situation,
    input.context?.goal
  );
}