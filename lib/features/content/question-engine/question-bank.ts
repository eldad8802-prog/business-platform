import type { QuestionFamilyId, QuestionVariantDefinition } from "./types";

/**
 * Core phrasing — shared, conversational “writing room”, not market research.
 * Archetype-specific lines are prepended via `ARCHETYPE_FLAVOR` in `getVariantsForFamily`.
 */
const CORE: Record<QuestionFamilyId, QuestionVariantDefinition[]> = {
  misconception: [
    {
      id: "misconception:c0",
      text: "איזה משפט יגרום למישהו לעצור ולהגיד: רגע… זה נכון?",
      expectedAnswerType: "chips_plus_text",
      chips: ["כשאומרים ש…", "כשמניחים ש…", "כשזה נשמע הגיוני עד ש…"],
    },
    {
      id: "misconception:c1",
      text: "מה נשמע “ברור מדי”, ובפועל אצלך זה פשוט לא עובד ככה?",
      expectedAnswerType: "short_phrase",
    },
    {
      id: "misconception:c2",
      text: "איזה מיתוס קטן היית שמח לנקב בסרטון בלי להרצות?",
      expectedAnswerType: "chips_plus_text",
      chips: ["“זה תמיד…”", "“זה אף פעם לא…”", "“זה רק ל…”"],
    },
    {
      id: "misconception:c3",
      text: "מה משפט ששומעים הרבה, ואתה יודע שהוא מסתיר עיוות קטן?",
      expectedAnswerType: "free_text",
    },
    {
      id: "misconception:c4",
      text: "מה היית רוצה שאנשים יפסיקו להניח — בלי להוכיח “מי צודק”?",
      expectedAnswerType: "chips_plus_text",
      chips: ["שזה אוטומטי", "שזה מהיר", "שזה אותו דבר לכולם"],
    },
    {
      id: "misconception:c5",
      text: "איפה הדמיון של אנשים לא נפגש עם מה שאתה רואה בפועל?",
      expectedAnswerType: "free_text",
    },
    {
      id: "misconception:c6",
      text: "מה משפט שמישהו אומר בביטחון — ואתה מחייך כי זה לא בדיוק ככה?",
      expectedAnswerType: "short_phrase",
    },
    {
      id: "misconception:c7",
      text: "מה “אמת קטנה” שהיית שם על המסך בשנייה אחת של טקסט?",
      expectedAnswerType: "chips_plus_text",
      chips: ["זה לא תמיד…", "זה תלוי ב…", "זה נשבר כש…"],
    },
  ],

  confusion: [
    {
      id: "confusion:c0",
      text: "מה הנקודה שאנשים נתקעים עליה הכי מהר — בלי להסביר את כל המערכת?",
      expectedAnswerType: "chips_plus_text",
      chips: ["איפה מתחילים", "מה קורה באמצע", "מה קורה בסוף"],
    },
    {
      id: "confusion:c1",
      text: "מה היית מסביר במשפט אחד, אם היה לך רק משפט אחד?",
      expectedAnswerType: "short_phrase",
    },
    {
      id: "confusion:c2",
      text: "מה נראה מסובך מבחוץ, ובפנים זה בעצם סדר פשוט?",
      expectedAnswerType: "free_text",
    },
    {
      id: "confusion:c3",
      text: "מה השאלה הכי “טיפשית” שבעצם חושפת את כל הבלאגן?",
      expectedAnswerType: "chips_plus_text",
      chips: ["כמה זמן זה?", "מה הסיכון?", "למי זה מתאים?"],
    },
    {
      id: "confusion:c4",
      text: "איפה הכי קל לאבד קהל — כי זה נשמע טכני מידי?",
      expectedAnswerType: "free_text",
    },
    {
      id: "confusion:c5",
      text: "מה היית רוצה שמישהו יבין מיד — בלי שתצטרך “לימון” שלם?",
      expectedAnswerType: "short_phrase",
    },
    {
      id: "confusion:c6",
      text: "מה חלק שאתה תמיד מדלג עליו בראש — ואז הכל נהיה ברור?",
      expectedAnswerType: "chips_plus_text",
      chips: ["ההקשר", "הסדר", "המילה הנכונה"],
    },
    {
      id: "confusion:c7",
      text: "איך היית מצמצם את הבלבול לשורה אחת שמרגישה אנושית?",
      expectedAnswerType: "free_text",
    },
  ],

  real_moment: [
    {
      id: "real_moment:c0",
      text: "איזה רגע מהשטח בא לך פשוט לספר כמו שהוא?",
      expectedAnswerType: "free_text",
    },
    {
      id: "real_moment:c1",
      text: "מה קורה בשיחה כשמישהו סוף סוף מבין — בלי פואנטה מנופחת?",
      expectedAnswerType: "chips_plus_text",
      chips: ["שקט קצר", "שאלה אחת נכונה", "מבט שמשתנה"],
    },
    {
      id: "real_moment:c2",
      text: "איזה משפט אתה שומע לפני “אוקיי, עכשיו הבנתי”?",
      expectedAnswerType: "short_phrase",
    },
    {
      id: "real_moment:c3",
      text: "מה דבר קטן בעבודה שלך שמרגיש אמיתי ולא מצולם מראש?",
      expectedAnswerType: "free_text",
    },
    {
      id: "real_moment:c4",
      text: "מתי הצטברות של פרטים קטנים הופכת לרגע של הבנה?",
      expectedAnswerType: "chips_plus_text",
      chips: ["כשמראים דוגמה", "כשמסדרים סדר", "כשמדברים פשוט"],
    },
    {
      id: "real_moment:c5",
      text: "מה הרגע שבו השיחה הפכה מ“מכירה” ל“בן אדם מבין בן אדם”?",
      expectedAnswerType: "free_text",
    },
    {
      id: "real_moment:c6",
      text: "מה משהו קטן שקרה אתמול/השבוע שאתה עדיין זוכר בדיוק?",
      expectedAnswerType: "short_phrase",
    },
    {
      id: "real_moment:c7",
      text: "איזה רגע היית מצלם בראש — גם בלי מצלמה?",
      expectedAnswerType: "chips_plus_text",
      chips: ["במעבר", "בשקט", "בבלבול קטן", "בצחוק קל"],
    },
  ],

  opinion: [
    {
      id: "opinion:c0",
      text: "מה אתה חושב שכולם מעדיפים לא להגיד בקול — אבל אתה כן?",
      expectedAnswerType: "free_text",
    },
    {
      id: "opinion:c1",
      text: "על מה אתה לא מסכים עם “מה שכולם אומרים” — בלי ויכוח אקדמי?",
      expectedAnswerType: "chips_plus_text",
      chips: ["זה מוגזם", "זה לא תמיד נכון", "זה תלוי בהקשר"],
    },
    {
      id: "opinion:c2",
      text: "מה היית אומר ללקוח בלי לייפות — כי ככה אתה באמת חושב?",
      expectedAnswerType: "short_phrase",
    },
    {
      id: "opinion:c3",
      text: "מה דעה לא פופולרית שלך, שעדיין עוזרת כשמקשיבים באמת?",
      expectedAnswerType: "chips_plus_text",
      chips: ["פחות זה יותר", "לא צריך למהר", "כדאי לעצור ולבדוק"],
    },
    {
      id: "opinion:c4",
      text: "מה לדעתך כולם עושים “עקום” כי זה נוח?",
      expectedAnswerType: "free_text",
    },
    {
      id: "opinion:c5",
      text: "מה משפט פנימי היית רוצה שהצופה ייקח איתו אחרי הסרטון?",
      expectedAnswerType: "short_phrase",
    },
    {
      id: "opinion:c6",
      text: "איפה אתה מרגיש שיש לך עמדה — לא “עוד טיפ”?",
      expectedAnswerType: "free_text",
    },
    {
      id: "opinion:c7",
      text: "מה משפט חד שמסכם את הכיוון שלך — בלי סיסמה?",
      expectedAnswerType: "chips_plus_text",
      chips: ["פחות רעש", "יותר עומק", "יותר כנה", "יותר ברור"],
    },
  ],

  result: [
    {
      id: "result:c0",
      text: "מה שינוי קטן שאפשר לראות או להרגיש כשעושים את זה נכון?",
      expectedAnswerType: "chips_plus_text",
      chips: ["פחות חיכוך", "יותר בהירות", "יותר שקט בראש"],
    },
    {
      id: "result:c1",
      text: "איך נראה הרגע שבו מישהו מבין ש“זה עבד” — בלי מספרים גדולים?",
      expectedAnswerType: "free_text",
    },
    {
      id: "result:c2",
      text: "מה תוצאה שאנשים רוצים, אבל לא תמיד יודעים לזהות כשהיא קורית?",
      expectedAnswerType: "short_phrase",
    },
    {
      id: "result:c3",
      text: "מה הכי חשוב שיראו בעיניים — לא רק ישמעו במילים?",
      expectedAnswerType: "chips_plus_text",
      chips: ["סדר", "רוגע", "קצב", "בהירות"],
    },
    {
      id: "result:c4",
      text: "מה “לפני ואחרי” שאפשר להראות בלי להעמיס?",
      expectedAnswerType: "free_text",
    },
    {
      id: "result:c5",
      text: "מה משפט אחד מתאר נכון את התוצאה שאתה הכי גאה בה כאן?",
      expectedAnswerType: "short_phrase",
    },
    {
      id: "result:c6",
      text: "מה רגע קטן שמוכיח שהצלחה לא חייבת להיראות גדולה?",
      expectedAnswerType: "free_text",
    },
    {
      id: "result:c7",
      text: "מה היית רוצה שהצופה יזכור בעיניים — תמונה אחת בראש?",
      expectedAnswerType: "chips_plus_text",
      chips: ["סדר שולחן", "מבט", "ידיים", "מסך"],
    },
  ],

  mistake: [
    {
      id: "mistake:c0",
      text: "מה אנשים עושים כי זה נראה “נכון בהתחלה” — ואז זה נשבר?",
      expectedAnswerType: "chips_plus_text",
      chips: ["מדלגים על שלב", "מתבלבלים בפרטים", "בוחרים מהר מדי"],
    },
    {
      id: "mistake:c1",
      text: "איזו טעות חוזרת על עצמה — ואתה יודע בדיוק איך לעקוף אותה?",
      expectedAnswerType: "free_text",
    },
    {
      id: "mistake:c2",
      text: "מה דפוס שמתפוצץ לטעות יקרה — אבל אפשר לתפוס מוקדם?",
      expectedAnswerType: "short_phrase",
    },
    {
      id: "mistake:c3",
      text: "מה טיפ זעיר שחוסך טעות גדולה — בשני משפטים?",
      expectedAnswerType: "chips_plus_text",
      chips: ["לעצור ולבדוק", "לא למהר", "לשאול שאלה אחת נכונה"],
    },
    {
      id: "mistake:c4",
      text: "מה היית עושה אחרת אם היית מתחיל מההתחלה — נקודה אחת?",
      expectedAnswerType: "free_text",
    },
    {
      id: "mistake:c5",
      text: "מה טעות שאף אחד לא מתכוון אליה — ואתה רואה אותה כל הזמן?",
      expectedAnswerType: "free_text",
    },
    {
      id: "mistake:c6",
      text: "מה “אזהרה קטנה” שהיית שם על המסך בלי לייצר פאניקה?",
      expectedAnswerType: "short_phrase",
    },
    {
      id: "mistake:c7",
      text: "מה טעות שמרגישה חמודה — עד שלא?",
      expectedAnswerType: "chips_plus_text",
      chips: ["חוסכים מילה", "מדלגים על בדיקה", "מניחים הבנה"],
    },
  ],

  comparison: [
    {
      id: "comparison:c0",
      text: "מה ההבדל הכי ברור בין “הדרך הרגילה” לבין מה שאתה מציע כאן?",
      expectedAnswerType: "chips_plus_text",
      chips: ["פחות בלבול", "יותר שליטה", "יותר מהירות"],
    },
    {
      id: "comparison:c1",
      text: "לפני ואחרי — מה משתנה ביום-יום, לא רק בתיאוריה?",
      expectedAnswerType: "free_text",
    },
    {
      id: "comparison:c2",
      text: "מה מישהו מפחד לוותר עליו — למרות שהחלופה נשמעת טובה?",
      expectedAnswerType: "short_phrase",
    },
    {
      id: "comparison:c3",
      text: "איך נראה “לפני” בלי דרמה — רק עובדה קטנה שמספרת הכול?",
      expectedAnswerType: "free_text",
    },
    {
      id: "comparison:c4",
      text: "מה השוואה שמרגישה נכונה בסרטון — בלי טבלת אקסל?",
      expectedAnswerType: "chips_plus_text",
      chips: ["זמן", "עומס", "בהירות", "סיכון"],
    },
    {
      id: "comparison:c5",
      text: "מה הדרך שאנשים חושבים שזה “מספיק טוב” — ולמה לפעמים זה לא?",
      expectedAnswerType: "free_text",
    },
    {
      id: "comparison:c6",
      text: "מה צדדים שאתה הכי לא רוצה לצבוע בשחור-לבן — אבל כן להאיר?",
      expectedAnswerType: "short_phrase",
    },
    {
      id: "comparison:c7",
      text: "מה משפט שמסכם את הפער בלי להרגיש מאיים?",
      expectedAnswerType: "chips_plus_text",
      chips: ["פחות זמן אבוד", "יותר שליטה", "יותר שקט"],
    },
  ],

  story: [
    {
      id: "story:c0",
      text: "קרה לאחרונה משהו עם לקוח שממחיש את זה בלי הרבה הסבר?",
      expectedAnswerType: "free_text",
    },
    {
      id: "story:c1",
      text: "איזה מקרה קטן בעבודה מסביר הכי טוב למה זה חשוב?",
      expectedAnswerType: "chips_plus_text",
      chips: ["משהו מפתיע", "משהו שקט", "משהו מצחיק קליל"],
    },
    {
      id: "story:c2",
      text: "מה מקרה אמיתי שמראה את הבעיה בלי “להוכיח חכמים”?",
      expectedAnswerType: "free_text",
    },
    {
      id: "story:c3",
      text: "מתי ראית מישהו מבין פתאום את הערך — בלי שזה הרגיש כמו שיעור?",
      expectedAnswerType: "short_phrase",
    },
    {
      id: "story:c4",
      text: "מה סיפור קצר שאפשר לספר בלי שמות — רק תנועה ורגע?",
      expectedAnswerType: "free_text",
    },
    {
      id: "story:c5",
      text: "איזו “סצנה” מהשטח היית רוצה שהצופה יזכור אחרי זה?",
      expectedAnswerType: "chips_plus_text",
      chips: ["בקבלה", "בשיחה", "בבדיקה", "בהדגמה"],
    },
    {
      id: "story:c6",
      text: "מה התחלה של סיפור שאתה יודע שיש לה סוף טוב?",
      expectedAnswerType: "free_text",
    },
    {
      id: "story:c7",
      text: "מה רגע שאתה היית פותח איתו טריילר — בלי ספוילר?",
      expectedAnswerType: "short_phrase",
    },
  ],

  hesitation: [
    {
      id: "hesitation:c0",
      text: "מה אנשים צריכים לראות כדי להרגיש שאפשר לסמוך עליך?",
      expectedAnswerType: "chips_plus_text",
      chips: ["בהירות", "עקביות", "רוגע", "פרט קטן אמיתי"],
    },
    {
      id: "hesitation:c1",
      text: "מה השאלה שחוזרת כשמישהו “כמעט כן” אבל עדיין לא?",
      expectedAnswerType: "free_text",
    },
    {
      id: "hesitation:c2",
      text: "מה היית רוצה להרגיע בצורה כנה — לא “מכירתי”?",
      expectedAnswerType: "short_phrase",
    },
    {
      id: "hesitation:c3",
      text: "איפה הכי נכון לתת ביטחון בלי הבטחות גדולות מדי?",
      expectedAnswerType: "free_text",
    },
    {
      id: "hesitation:c4",
      text: "מה משפט של מתלבט שאתה יודע בדיוק איך לענות עליו בסרטון?",
      expectedAnswerType: "chips_plus_text",
      chips: ["אני צריך לחשוב…", "לא בטוח שזה לי…", "זה נשמע מסובך…"],
    },
    {
      id: "hesitation:c5",
      text: "מה הדבר שהכי מפחיד בפגישה הראשונה — ואיך אתה נוגע בזה בעדינות?",
      expectedAnswerType: "free_text",
    },
    {
      id: "hesitation:c6",
      text: "מה “אישור קטן” שהיית רוצה שהצופה יקבל לפני שהוא ממשיך?",
      expectedAnswerType: "short_phrase",
    },
    {
      id: "hesitation:c7",
      text: "מה עוצר רגע לפני החלטה — בלי פסיכולוגיה כבדה?",
      expectedAnswerType: "chips_plus_text",
      chips: ["מחיר", "לא בטוחים שזה להם", "לא ברור מה הלאה"],
    },
  ],

  hidden_truth: [
    {
      id: "hidden_truth:c0",
      text: "מה קורה מאחורי הקלעים שאנשים לא רואים — וזה משנה הכול?",
      expectedAnswerType: "free_text",
    },
    {
      id: "hidden_truth:c1",
      text: "מה “אמת קטנה” שמקצוענים יודעים — ולקוחות לא תמיד מבינים מיד?",
      expectedAnswerType: "chips_plus_text",
      chips: ["זה לוקח זמן", "זה תלוי בפרטים", "יש שלב שקט"],
    },
    {
      id: "hidden_truth:c2",
      text: "מה היית רוצה לחשוף בלי להרגיש כמו “לירות בכולם”?",
      expectedAnswerType: "short_phrase",
    },
    {
      id: "hidden_truth:c3",
      text: "מה חלק שנראה שולי — ובעצם הוא הלב של העניין?",
      expectedAnswerType: "free_text",
    },
    {
      id: "hidden_truth:c4",
      text: "מה אנשים לא שואלים — ואז מופתעים אחר כך?",
      expectedAnswerType: "chips_plus_text",
      chips: ["תנאים", "הכנה", "תקשורת", "ציפיות"],
    },
    {
      id: "hidden_truth:c5",
      text: "מה “סוד” מקצועי שאתה שמח לשתף כי זה עוזר לבחור נכון?",
      expectedAnswerType: "free_text",
    },
    {
      id: "hidden_truth:c6",
      text: "מה משהו שקשה להגיד בלי להישמע ציני — אבל חשוב?",
      expectedAnswerType: "short_phrase",
    },
    {
      id: "hidden_truth:c7",
      text: "מה היית מראה בחצי שנייה של “אמת” — בלי לחשוף יותר מדי?",
      expectedAnswerType: "chips_plus_text",
      chips: ["רגע עבודה", "רגע בדיקה", "רגע החלטה", "רגע שקט"],
    },
  ],
};

/** Archetype-first lines: prepended so seeds hit flavor before core. */
const ARCHETYPE_FLAVOR: Record<
  string,
  Partial<Record<QuestionFamilyId, QuestionVariantDefinition[]>>
> = {
  "video.stop_scroll": {
    misconception: [
      {
        id: "video.stop_scroll:misconception:f0",
        text: "מה משפט שמייד עושה לך “סטופ” בגלילה — כי הוא פשוט לא יושב נכון?",
        expectedAnswerType: "chips_plus_text",
        chips: ["נשמע נכון אבל…", "כולם אומרים ש…", "זה “ברור” ש…"],
      },
      {
        id: "video.stop_scroll:misconception:f1",
        text: "מה היית רוצה לנעוץ במסך בשנייה הראשונה — רק כדי לשבור שגרה?",
        expectedAnswerType: "short_phrase",
      },
      {
        id: "video.stop_scroll:misconception:f2",
        text: "איזה משפט שמישהו אומר בביטחון — ואתה יודע שזה מפיל את כולם לאותה טעות?",
        expectedAnswerType: "free_text",
      },
    ],
    mistake: [
      {
        id: "video.stop_scroll:mistake:f0",
        text: "מה טעות “חמודה” שאנשים עושים מהר — ואז מתחרטים לאט?",
        expectedAnswerType: "chips_plus_text",
        chips: ["מדלגים על שלב", "בוחרים מהר", "לא בודקים פעמיים"],
      },
      {
        id: "video.stop_scroll:mistake:f1",
        text: "מה דפוס שחוזר — ואתה יודע שהוא הורס את הסרטון לפני שהתחלתם?",
        expectedAnswerType: "short_phrase",
      },
    ],
    confusion: [
      {
        id: "video.stop_scroll:confusion:f0",
        text: "מה נקודה אחת שאם מבינים אותה — הגלילה הופכת לצפייה?",
        expectedAnswerType: "chips_plus_text",
        chips: ["מה זה בעצם", "למה זה קורה", "מה השלב הבא"],
      },
      {
        id: "video.stop_scroll:confusion:f1",
        text: "מה בלבול שאתה הכי רוצה לנקות ב־10 שניות הראשונות?",
        expectedAnswerType: "free_text",
      },
    ],
    opinion: [
      {
        id: "video.stop_scroll:opinion:f0",
        text: "מה משפט חד וקצר שיגרום למישהו להרים מבט מהטלפון?",
        expectedAnswerType: "short_phrase",
      },
      {
        id: "video.stop_scroll:opinion:f1",
        text: "מה עמדה שמרגישה “מעט מדי” — אבל בדיוק בגלל זה היא עוצרת?",
        expectedAnswerType: "free_text",
      },
    ],
  },

  "video.opinion": {
    opinion: [
      {
        id: "video.opinion:opinion:f0",
        text: "מה משפט שאתה היית אומר בקול — גם אם לא כולם יאהבו?",
        expectedAnswerType: "free_text",
      },
      {
        id: "video.opinion:opinion:f1",
        text: "על מה אתה לא מסכים עם הרוב — בלי להסביר למה הם טועים?",
        expectedAnswerType: "chips_plus_text",
        chips: ["זה מוגזם", "זה לא תמיד נכון", "זה תלוי בהקשר"],
      },
      {
        id: "video.opinion:opinion:f2",
        text: "מה POV שלך שמרגיש “חד” אבל לא צעקני?",
        expectedAnswerType: "short_phrase",
      },
    ],
    misconception: [
      {
        id: "video.opinion:misconception:f0",
        text: "מה “אמת מקובלת” שאתה חושב שהיא בעיקר הרגל — לא עובדה?",
        expectedAnswerType: "chips_plus_text",
        chips: ["כולם אומרים ש…", "נשמע הגיוני עד ש…", "זה נראה ככה אבל…"],
      },
      {
        id: "video.opinion:misconception:f1",
        text: "מה היית רוצה לשבור — בלי להיכנס לוויכוח שלם?",
        expectedAnswerType: "free_text",
      },
    ],
    hidden_truth: [
      {
        id: "video.opinion:hidden_truth:f0",
        text: "מה אמת קטנה שמשנה את הסיפור — אבל אנשים לא מדברים עליה בקול רם?",
        expectedAnswerType: "free_text",
      },
      {
        id: "video.opinion:hidden_truth:f1",
        text: "מה מאחורי הקלעים שאתה הכי רוצה להאיר — בלי לייצר דרמה?",
        expectedAnswerType: "short_phrase",
      },
    ],
    comparison: [
      {
        id: "video.opinion:comparison:f0",
        text: "מה ניגוד שמרגיש לך הכי נכון לווידאו הזה — לא כדי לנצח, כדי להבהיר?",
        expectedAnswerType: "chips_plus_text",
        chips: ["ישן מול חדש", "מהיר מול איטי", "רועש מול שקט"],
      },
    ],
  },

  "video.creator": {
    real_moment: [
      {
        id: "video.creator:real_moment:f0",
        text: "מה רגע שאתה פשוט מספר אותו לחבר — בלי “תסריט”?",
        expectedAnswerType: "free_text",
      },
      {
        id: "video.creator:real_moment:f1",
        text: "מה משפט שאתה אומר הרבה בזום/בשיחה — וזה עובד כי זה חי?",
        expectedAnswerType: "chips_plus_text",
        chips: ["רגע", "טעות קטנה", "משפט חוזר", "בדיחה קלה"],
      },
      {
        id: "video.creator:real_moment:f2",
        text: "מה בא לך להגיד בקול רגוע — כאילו המצלמה כבר שם?",
        expectedAnswerType: "short_phrase",
      },
    ],
    story: [
      {
        id: "video.creator:story:f0",
        text: "מה סיפור קצר שמתחיל באמצע — ועדיין ברור מה קורה?",
        expectedAnswerType: "free_text",
      },
      {
        id: "video.creator:story:f1",
        text: "מה מקרה קטן שאפשר לספר בלי להסביר מי זה מי?",
        expectedAnswerType: "chips_plus_text",
        chips: ["אתמול", "השבוע", "לפני רגע", "בלי שמות"],
      },
    ],
    hesitation: [
      {
        id: "video.creator:hesitation:f0",
        text: "מה אנשים מפחדים להשמיע בקול — ואתה יכול לתת להם מילה נכונה?",
        expectedAnswerType: "free_text",
      },
    ],
    opinion: [
      {
        id: "video.creator:opinion:f0",
        text: "מה דעה שאתה אומר בשיחה — לא בפוסט מלוטש?",
        expectedAnswerType: "short_phrase",
      },
    ],
  },

  "video.trust": {
    real_moment: [
      {
        id: "video.trust:real_moment:f0",
        text: "מה רגע שמרגיש לך הכי “אנושי” בעבודה — בלי לנסות להרשים?",
        expectedAnswerType: "free_text",
      },
      {
        id: "video.trust:real_moment:f1",
        text: "מה משפט שאתה אומר כשאתה רוצה להוריד את העצבים בחדר?",
        expectedAnswerType: "chips_plus_text",
        chips: ["נשים את זה בצד", "בואו נאטום", "נעשה צעד קטן"],
      },
    ],
    result: [
      {
        id: "video.trust:result:f0",
        text: "מה סימן קטן שמישהו יכול לזהות — שזה הולך לכיוון נכון?",
        expectedAnswerType: "chips_plus_text",
        chips: ["שקט", "סדר", "בהירות", "עקביות"],
      },
      {
        id: "video.trust:result:f1",
        text: "מה “אני מרגיש שזה בסדר” — בלי הבטחות גדולות?",
        expectedAnswerType: "short_phrase",
      },
    ],
    hesitation: [
      {
        id: "video.trust:hesitation:f0",
        text: "מה אנשים צריכים לראות כדי להרגיש שאפשר לנשום לרווחה?",
        expectedAnswerType: "free_text",
      },
    ],
    hidden_truth: [
      {
        id: "video.trust:hidden_truth:f0",
        text: "מה אמת קטנה שכדאי לומר מוקדם — כדי שלא יהיו הפתעות מאוחרות?",
        expectedAnswerType: "chips_plus_text",
        chips: ["זמן", "תנאים", "מה כלול", "מה לא"],
      },
    ],
  },

  "video.explain": {
    confusion: [
      {
        id: "video.explain:confusion:f0",
        text: "מה נקודה אחת שאם מבינים אותה — הכול נהיה פשוט יותר?",
        expectedAnswerType: "chips_plus_text",
        chips: ["מה זה", "למה זה", "איך זה", "מתי זה"],
      },
      {
        id: "video.explain:confusion:f1",
        text: "מה היית מסביר כמו לחבר — בלי מילים מקצועיות?",
        expectedAnswerType: "free_text",
      },
      {
        id: "video.explain:confusion:f2",
        text: "מה בלבול שאתה הכי רוצה “לפרק” לשלוש מילים?",
        expectedAnswerType: "short_phrase",
      },
    ],
    mistake: [
      {
        id: "video.explain:mistake:f0",
        text: "מה טעות נפוצה שגורמת לאנשים להבין את זה הפוך?",
        expectedAnswerType: "chips_plus_text",
        chips: ["מדלגים על בסיס", "מתבלבלים בסדר", "מערבבים מושגים"],
      },
    ],
    result: [
      {
        id: "video.explain:result:f0",
        text: "מה “אחרי שמבינים” נראה — בלי להבטיח קסמים?",
        expectedAnswerType: "free_text",
      },
    ],
    comparison: [
      {
        id: "video.explain:comparison:f0",
        text: "מה לפני/אחרי שממחיש הכי טוב את ההבדל — בלי עומס?",
        expectedAnswerType: "short_phrase",
      },
    ],
  },

  "video.leads": {
    hesitation: [
      {
        id: "video.leads:hesitation:f0",
        text: "מה עוצר מישהו רגע לפני “אוקיי, אני פנוי” — בלי לחץ מכירתי?",
        expectedAnswerType: "chips_plus_text",
        chips: ["מחיר", "זמן", "לא בטוחים", "לא ברור מה הלאה"],
      },
      {
        id: "video.leads:hesitation:f1",
        text: "מה אנשים צריכים לראות כדי להרגיש שאפשר לקחת צעד קטן?",
        expectedAnswerType: "free_text",
      },
    ],
    result: [
      {
        id: "video.leads:result:f0",
        text: "מה שינוי קטן שמישהו ירגיש מיד אחרי שעשה את הצעד הנכון?",
        expectedAnswerType: "chips_plus_text",
        chips: ["פחות חיכוך", "יותר בהירות", "יותר ביטחון"],
      },
    ],
    mistake: [
      {
        id: "video.leads:mistake:f0",
        text: "מה טעות שגורמת לאנשים לוותר לפני שבאמת הבינו?",
        expectedAnswerType: "free_text",
      },
    ],
    comparison: [
      {
        id: "video.leads:comparison:f0",
        text: "מה ההבדל הכי ברור בין “לדחות” לבין “להחליט נכון” אצלך?",
        expectedAnswerType: "short_phrase",
      },
    ],
  },
};

export function getVariantsForFamily(
  family: QuestionFamilyId,
  contentArchetypeId?: string
): QuestionVariantDefinition[] {
  const id = contentArchetypeId?.trim();
  const flavor = id ? ARCHETYPE_FLAVOR[id]?.[family] : undefined;
  const core = CORE[family];
  if (flavor && flavor.length > 0) {
    return [...flavor, ...core];
  }
  return [...core];
}

/** Core bank only — for tests that count minimum variants per family. */
export const QUESTION_BANK: Record<QuestionFamilyId, QuestionVariantDefinition[]> = CORE;
