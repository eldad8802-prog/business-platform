/**
 * Internal briefing lines for the content LLM — not end-user script copy.
 * Archetype IDs match `lib/content/content-archetype-map.ts` card ids.
 */

const ARCHETYPE_BRIEFS: Record<string, string> = {
  "video.stop_scroll": `
## ארכיטיפ: עצירת גלילה
- מטרה: עצירה בגלילה — לא "הקדמה מסודרת" לפני שמגיעים לעניין.
- tension: משפט ראשון שמייצר סתירה, סיכון קטן, או "רגע, זה לא מה שחשבתם" — בלי צעקות.
- interruption: מיידי; בלי "היי חבר'ה" ובלי "בסרטון הזה נדבר על"; קפיצה לתוך הרעיון.
- curiosity: אפשר סימן שאלה חד אם הוא לא נשמע כמו דף נחיתה ("רוצים? מחפשים?").
- POV: מדברים אל הצופה כמו בריל — לא כמו מנחה בכנס.
- לא: משפטי "מה המוצר עושה" בפתיחה; לא הצעה רכה שמתחילה ב-"רוצה…".`,

  "video.trust": `
## ארכיטיפ: בניית אמון
- מטרה: שקט וביטחון — לא בומבסטיות, לא "אנחנו הכי טובים".
- calm authority: עובדות, עקביות, היגיון אנושי; כמו מישהו שכבר ראה את הסרט הזה מאה פעם.
- human honesty: מותר להודות במורכבות ("זה לא קסם", "זה לוקח זמן") — בלי לשבור אמון.
- POV: גובה עיניים; לא מלמעלה, לא מלמטה.
- לא: סיסמאות PR; לא "פתרון מושלם"; לא לחץ מלאכותי.`,

  "video.opinion": `
## ארכיטיפ: דעה / עמדה
- מטרה: עמדה ברורה — משהו שמישהו יכול לא להסכים איתו (בתוך הגזרה העסקית).
- POV: "אני חושב/ת ש…", "אני לא מסכים/ה עם…", "זה מה שרוב השוק עושה לא נכון" — בלי פוליטיקה ובלי ביוש.
- emotional edge: מעט חום או תסכול לגיטימי — לא ציניות רעילה.
- confidence: משפט חד → נימוק קצר → עצירה; לא לנטרל הכול ב-"אולי".
- לא: ניסוח דיפלומטי שמנסה לרצות את כולם.`,

  "video.creator": `
## ארכיטיפ: יוצר תוכן (creator-native)
- מטרה: כאילו התחלתם לצלם עכשיו — selfie / שיחה לפיד, לא סטודיו.
- imperfect energy: מותר טבעיות, משפט לא שלם, "סתם", "תשמעו" — במידה; לא תסריט מלוטש.
- conversational flow: שאלה קצרה, תגובה, הערה צדדית — כמו סטורי, לא כמו פרק פודקאסט רשמי.
- POV: חבר/ה מהפיד שמספרים משהו שגילו — לא מנחה אירועים.
- לא: "ברוכים הבאים לערוץ"; לא "היום נלמד"; לא ניסוח של מודעת מטא.`,

  "video.explain": `
## ארכיטיפ: הסבר ברור
- מטרה: בהירות — אבל עדיין ריל: בעיה אחת ברורה בראש, לא הרצאה.
- POV: מדריך אנושי — לא PowerPoint בקול; "תראו מה קורה כאן" לפני "בשלב הבא".
- pacing: משפט אחד = רעיון אחד; שלבים קצרים.
- לא: לפתוח כמו עלון ("השירות כולל את…"); לא לרדת לרשימת תכונות ב-hוק.`,

  "video.leads": `
## ארכיטיפ: פניות / צעד הבא
- מטרה: עניין לפני בקשה — הערך או התובנה לפני "דברו איתנו".
- directness: CTA אחד בסוף, ברור — לא שלושה צעדים שונים באותו ריל.
- POV: הזמנה לשיחה — לא דף נחיתה עם דחיפות מזויפת.
- לא: "השאירו פרטים" בשנייה הראשונה; לא "מבצע מטורף"; לא "רק היום!!!".`,

  "post.value": `
## ארכיטיפ: פוסט ערך
- טון: שימושי וספציפי — משפטים שנשמרים בראש, לא “טיפים גנריים”.
- POV: כמו פוסט ששווה לשמור — לא כיתוב עלון.`,
  "post.opinion": `
## ארכיטיפ: פוסט דעה
- טון: חד ואנושי — עמדה אחת ברורה.`,
  "post.trust": `
## ארכיטיפ: פוסט אמון
- טון: כנה, בלי הילוך מעל הפערים.`,
  "post.story": `
## ארכיטיפ: פוסט סיפור
- טון: זרימה נרטיבית קצרה — רגע, תפנית, מסר.`,
  "post.offer": `
## ארכיטיפ: פוסט הצעה
- טון: ברור מה מקבלים — בלי מילוי מילים שיווקיות.`,
  "post.carousel_explainer": `
## ארכיטיפ: קרוסלה מסבירה
- טון: כל “שקופית” = רעיון אחד; לא לדחוס הכול למשפט אחד.`,

  "image.product": `
## ארכיטיפ: תמונת מוצר
- טון: נקי, מדויק — המוצר במרכז, לא סלוגן ארוך.`,
  "image.before_after": `
## ארכיטיפ: לפני/אחרי
- טון: תוצאה ברורה — בלי הבטחות מוגזמות.`,
  "image.short_caption": `
## ארכיטיפ: כיתוב קצר
- טון: punch אחד — לא פסקה.`,
  "image.premium": `
## ארכיטיפ: פרימיום
- טון: מכובד ורגוע — לא “מבצע מטורף”.`,
  "image.authentic": `
## ארכיטיפ: אותנטי
- טון: חם ואנושי — לא פילטר של מותג גדול.`,
};

export function getArchetypeWritingBrief(
  archetypeId?: string
): string | undefined {
  const id = archetypeId?.trim();
  if (!id) return undefined;
  const brief = ARCHETYPE_BRIEFS[id];
  return brief?.trim() || undefined;
}

/** Template fallback path — single line, no user text pasted. */
export function getArchetypeExplanationTemplateHint(
  archetypeId?: string
): string | undefined {
  switch (archetypeId?.trim()) {
    case "video.creator":
      return `כשמסבירים את זה כמו לחבר מול המצלמה — לא כמו מצגת — זה נכנס מהר בלי להרגיש עוד סרטון שיווק.`;
    case "video.explain":
      return `כשמפרקים את זה לשלבים קצרים, הרבה יותר קל לצופה להבין מה הוא באמת מקבל ולמה זה בשבילו.`;
    case "video.opinion":
      return `כשיש עמדה ברורה ולא מנסים לרצות את כולם — זה נשמע אמין, ואנשים נשארים לשמוע.`;
    case "video.trust":
      return `כשמדברים בגובה העיניים ובלי להגזים — זה בונה אמון הרבה יותר מכל סיסמה חזקה.`;
    case "video.stop_scroll":
      return `אם הופכים את זה לרגע אחד חד — במקום הסבר ארוך — יותר אנשים נעצרים לשנייה ואז מבינים.`;
    case "video.leads":
      return `כשמראים ערך לפני שמבקשים משהו — הצעד הבא מרגיש טבעי, לא לוחץ.`;
    default:
      return undefined;
  }
}

/** Appended after the default solution sentence — still no user quoting. */
export function getArchetypeSolutionVoiceAddon(
  archetypeId?: string
): string | undefined {
  switch (archetypeId?.trim()) {
    case "video.creator":
      return `מרגיש כמו משהו שהייתם מספרים לפיד — לא כמו מודעה.`;
    case "video.explain":
      return `צעד אחר צעד, בלי עומס ובלי מילים מיותרות.`;
    case "video.opinion":
      return `עמדה ברורה עוזרת לצופה להבין מה אתם באמת מנסים להגיד.`;
    case "video.trust":
      return `בלי רעש — רק מה שבאמת חשוב לדעת לפני שמחליטים.`;
    case "video.stop_scroll":
      return `קצר, חד, ואז ממשיכים לסיפור.`;
    case "video.leads":
      return `כשזה ברור, קל יותר לקחת צעד קטן קדימה.`;
    default:
      return undefined;
  }
}
