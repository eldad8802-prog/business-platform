type Profile = {
  category?: string;
  subCategory?: string;
  businessModel?: string;
};

export function getGuidance(profile?: Profile | null) {
  if (!profile) {
    return baseGuidance();
  }

  const { businessModel, category } = profile;

  // 🟢 שירותים
  if (businessModel === "service") {
    if (category === "Beauty") {
      return {
        why: "אם יש שעות פנויות ביומן, קופון יכול לעזור למלא זמן שלא מנוצל.",
        tip: "הגבל את הקופון לשעות או ימים חלשים בלבד.",
        example: "קופון לטיפול ראשון בימים א׳–ג׳ בשעות הצהריים.",
        caution: "אל תפתח את הקופון לשעות שאתה כבר מלא בהן.",
      };
    }

    if (category === "Fitness") {
      return {
        why: "קופון יכול לעזור להביא מתאמנים לשעות פחות עמוסות.",
        tip: "כדאי למקד את הקופון לאימונים או שעות מסוימות.",
        example: "קופון לאימון ניסיון בשעות הבוקר.",
        caution: "אל תשתמש בקופון בשעות שיא.",
      };
    }

    return {
      why: "אם יש לך זמן פנוי ביומן, קופון יכול לייצר הכנסה נוספת.",
      tip: "מקד את הקופון לזמן או שירות מסוים.",
      example: "קופון לשעות חלשות בלבד.",
      caution: "אל תפתח את הקופון לכל היומן.",
    };
  }

  // 🟡 מוצרים
  if (businessModel === "product") {
    if (category === "Retail") {
      return {
        why: "אם יש לך מלאי שלא זז, קופון יכול לעזור להזיז סחורה.",
        tip: "מקד את הקופון לפריטים או קטגוריות מסוימות.",
        example: "קופון על פריטי סוף עונה בלבד.",
        caution: "אל תיצור קופון על כל החנות.",
      };
    }

    if (category === "Food") {
      return {
        why: "קופון יכול לעזור למכור מוצרים בזמנים שקטים.",
        tip: "שלב את הקופון עם זמן או מוצר ספציפי.",
        example: "קופון למנות נבחרות בשעות שקטות.",
        caution: "אל תפעיל קופון על כל התפריט.",
      };
    }

    return {
      why: "קופון יכול לעזור להזיז מוצרים שלא נמכרים.",
      tip: "מקד את הקופון למוצרים ספציפיים.",
      example: "קופון לפריטים נבחרים בלבד.",
      caution: "אל תוריד מחיר על הכל.",
    };
  }

  // 🔵 hybrid
  if (businessModel === "hybrid") {
    return {
      why: "קופון יכול לעזור להזיז גם שירותים וגם מוצרים.",
      tip: "בחר מוצר או שירות אחד ממוקד.",
      example: "קופון לשירות מסוים או מוצר עם מרווח גבוה.",
      caution: "אל תערבב יותר מדי דברים בקופון אחד.",
    };
  }

  return baseGuidance();
}

function baseGuidance() {
  return {
    why: "קופון יכול לייצר הכנסה במצבים שלא מנוצלים.",
    tip: "כדאי למקד את הקופון למצב מסוים.",
    example: "קופון לשימוש בתנאים מסוימים.",
    caution: "אל תיצור קופון רחב מדי.",
  };
}