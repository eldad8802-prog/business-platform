<div dir="rtl">

# מסמכים: המסך הראשי והצעות למסכים הפנימיים

**מצב:**
- המסך הראשי ממומש ב־[#916](https://github.com/eldad8802-prog/business-platform/pull/916) (Draft, לא מוזג). הצילומים מ־HEAD ‏`dea9edde`.
- המסכים הפנימיים הם **הצעות בלבד**. הם לא מאושרים ולא ממומשים.
- **אישורים נקודתיים (2026-11-02):** אריח ״לאמת מסמכים״ במסך הראשי סופר מכל החודשים (חריג מפורש), והסיכום הכספי נשאר חודשי. כרטיס ״מה החיבור עושה״ ב־Gmail מוצג גם במובייל. חלונות מעוצבים מחליפים את window.confirm של ״שלחתי בעצמי״ ו״בטל קישור״. שאר ההצעות עדיין ממתינות לבחינה חזותית.
- **גרסה 2 של ההצעות (2026-11-02):** עיצוב בלבד, על בסיס הפלואו הקיים. כל הצעה מעצבת מסך אחד שקיים היום ושומרת את כל היכולות שלו: אותם נתיבים, כניסות, פעולות, שלבים, טקסטים ולוגיקה. ההצעות הקודמות (איחוד מסכים, מסנן תאריך, תצוגה מקדימה ב־Gmail) בוטלו. הממצאים מתועדים לטיפול נפרד.

**מקור הצילומים:**
- צילומי המסך הראשי נלקחו מהמסך הממומש, בשרת פיתוח מקומי עם API מדומה. לא נגענו בשום עסק, והמספרים הם נתוני בדיקה.
- ההצעות הן הדמיות סטטיות באותה שפה חזותית.

**נדרש לפני סגירה:** בדיקת Preview מחוברת בעסק 9, וצילום והעלאה אמיתיים בטלפון.

---

## 1. המסך הראשי הממומש (#916)

### מובייל, 390px

**נתונים, ראש המסך.** ״חזרה״, כותרת ״מסמכים״ (Heebo 800, רק במסך הזה), סיכום חודשי, ושתי הפעולות הראשונות.

<img src="main/data__mobile.png" width="320">

**נתונים, תחתית המסך.** ״לאמת מסמכים״ עם מספר הממתינים מכל החודשים, ״למצוא מסמך״, Gmail, ‏WhatsApp (״בקרוב״, ללא שינוי) וחבילת רו״ח.

<img src="main/data__mobile-bottom.png" width="320">

**אין נתונים.** ₪0 והודעה ״אין עדיין הכנסות או הוצאות רשומות לחודש הזה״. האריח מציג ״אין מסמכים ממתינים״.

<img src="main/empty__mobile.png" width="320">

**טעינה.** הסכומים מהבהבים, והפעולות זמינות מיד.

<img src="main/loading__mobile.png" width="320">

**שגיאת טעינה.** הודעה עם ״נסה שוב״. הפעולות נשארות זמינות.

<img src="main/error__mobile.png" width="320">

**העלאה בתהליך.** ״מעלה…״. העלאה וצילום מושבתים עד הסיום.

<img src="main/uploading__mobile.png" width="320"> <img src="main/uploading__mobile-bottom.png" width="320">

**מסך צר, 360px.** בלי גלילה אופקית.

<img src="main/data__narrow.png" width="300"> <img src="main/data__narrow-bottom.png" width="300">

### דסקטופ, 1440px

**נתונים.** ארבע פעולות בשורה; Gmail/WhatsApp וחבילת רו״ח זה לצד זה; טבלת מסמכי החודש הקיימת נשמרה מתחת.

<img src="main/data__desktop.png" width="900">

**אין נתונים · טעינה · שגיאה**

<img src="main/empty__desktop.png" width="900">
<img src="main/loading__desktop.png" width="900">
<img src="main/error__desktop.png" width="900">

### סטיות מההדמיה המאושרת

| # | בהדמיה | במימוש | סיבה |
|---|---|---|---|
| 1 | ״נתונים להמחשה״ | ״נטו החודש״, ושינוי מהחודש הקודם רק כשיש השוואה אמיתית | לא מציגים ״להמחשה״; משמעות הסיכום נשמרת |
| 2 | כותרת כבדה מאוד | Heebo 800 שנטען רק במסך הזה | שאר האפליקציה נשארת 300–600 |
| 3 | חץ ״›״ מימין ל־Gmail | חץ ״‹״ משמאל | ניווט RTL קיים: חץ ״קדימה״ פונה שמאלה |
| 4 | לוגו Gmail אדום | הלוגו הרשמי שקיים באפליקציה | לא משנים סימני מותג |
| 5 | ״3 ממתינים לאישור״ | המספר האמיתי מכל החודשים (`needs_review`) | לפי הדרישה, מנתון שכבר קיים ב־API |
| 6 | תת־כותרת WhatsApp בשורה אחת | שתי שורות ב־390px ומטה | הטקסט המלא נשמר |
| 7 | סרגל תחתון בעיצוב ההדמיה | הסרגל הקיים של האפליקציה ## 2. תור אימות · `/documents/inbox`

**א1 · מובייל. חזרה, כותרת וחודש, בורר חודש, פס הממתינים בחודש, באנר ״מחודשים אחרים״, כרטיסים עם נקודות מהימנות, ״טען עוד״.**

<img src="proposals/a1.png" width="320">

**א2 · ריק, שגיאה וטעינה. הטקסטים של היום.**

<img src="proposals/a2.png" width="320">

**א3 · דסקטופ. טבלה (ספק, תאריך, קטגוריה, סכום) ופאנל פרטים עם ״פתח לאימות״.**

<img src="proposals/a3.png" width="900">

## 3. חיפוש מסמכים · `/documents/search`

**ב1 · מובייל. אותו שדה, אותם צ׳יפים (הכל, החודש, דלק, הכנסה, הוצאה), ״רשומות מאושרות בלבד״ ותגית ״אומת״.**

<img src="proposals/b1.png" width="320">

**ב2 · ריק, טעינה ושגיאה.**

<img src="proposals/b2.png" width="320">

**ב3 · דסקטופ. טבלה (ספק, תאריך, קטגוריה, סכום, סטטוס) ופאנל עם ״פתח מסמך״.**

<img src="proposals/b3.png" width="900">

## 4. אימות מסמך · `/documents/review/[id]` (מתואם עם #917)

**ג1 · מצב החלטה, מסמך פיננסי. כל החלקים באותו סדר.**

<img src="proposals/c1.png" width="320">

**ג2 · באנר כפילות, באנר נעילה, מצב ״מסמך מידע״ ושגיאה.**

<img src="proposals/c2.png" width="320">

**ג3 · חלון עריכת שדה. אותם כפתורים ואותה התנהגות.**

<img src="proposals/c3.png" width="320">

**ג4 · אישור ״שמור כמסמך מידע?״.**

<img src="proposals/c4.png" width="320">

**ג5 · בעיבוד, ״נמשך יותר מהצפוי״ (כ־60 שניות, כמו היום) ונכשל.**

<img src="proposals/c5.png" width="320">

**ג6 · אחרי אישור. ״אמת את המסמך הבא״, ״חזור למסמכים״, ״עבור לחיפוש״.**

<img src="proposals/c6.png" width="320">

**ג7 · פאנל הספק (רק כשהמתג פעיל).**

<img src="proposals/c7.png" width="320">

**ג8 · החלון של #917 בשפה החזותית, בטקסט שלו בדיוק, ו״לא מצאנו את המסמך״.**

<img src="proposals/c8.png" width="320">

**ג9 · דסקטופ מ־1280px. עמודת עריכה ותצוגת מקור דביקה, כמו היום.**

<img src="proposals/c9.png" width="900">

## 5. העלאת קובץ · `/documents/upload`

**ד1 · אזור גרירה ובחירה ו״צילום מסמך״. אותו טקסט ״עד 15MB״.**

<img src="proposals/d1.png" width="320">

**ד2 · ״בעיבוד כעת״ ושגיאה.**

<img src="proposals/d2.png" width="320">

**ד3 · כפילות. אותה תיבה ואותן שלוש פעולות.**

<img src="proposals/d3.png" width="320">

**ד4 · דסקטופ. ״בתור עכשיו״ בצד.**

<img src="proposals/d4.png" width="900">

## 6. קליטה מ-Gmail · `/documents/email`

**ה1 · לא מחובר. ״חבר Gmail״. כרטיס ״מה החיבור עושה״ מוצג גם במובייל, באותו נוסח (מאושר).**

<img src="proposals/e1.png" width="320">

**ה2 · מחובר. חשבונות, רשימה אחת, ״קלוט״, תגיות ו״ייבא הכל״.**

<img src="proposals/e2.png" width="320">

**ה3 · בחירת חשבון, סריקה, אין תוצאות, חיבור שפג ואישור ניתוק.**

<img src="proposals/e3.png" width="320">

## 7. חבילת רו״ח · `/documents/accountant-pack`

**ו1 · חודשים, סטטוס, ״מה עדיין פתוח״, ״לתשומת לב״ ו״הכן את החבילה עכשיו״.**

<img src="proposals/f1.png" width="320">

**ו2 · החבילה, ההורדות, רואה החשבון, השליחה וההיסטוריה.**

<img src="proposals/f2.png" width="320">

**ו3 · חלון השליחה.**

<img src="proposals/f3.png" width="320">

**ו6 · ״שלחתי בעצמי״: חלון מעוצב במקום window.confirm (מאושר).** אותו נוסח ואותה תוצאה. סגירה ו־Escape מתנהגים כ״ביטול״.

<img src="proposals/f6.png" width="320">

**ו7 · ״בטל קישור״: חלון מעוצב במקום window.confirm (מאושר).** אותו נוסח ואותה תוצאה. סגירה ו־Escape מתנהגים כ״ביטול״.

<img src="proposals/f7.png" width="320">

**ו4 · ״הורדה לתקופה אחרת״.**

<img src="proposals/f4.png" width="320">

**ו5 · דסקטופ.**

<img src="proposals/f5.png" width="900">


ים לאימות, בעיבוד, נכשלו.

<img src="proposals/f4a.png" width="320">

**4ב · חבילה מוכנה.**

<img src="proposals/f4b.png" width="320">

**4ג · דוחות וייצוא.** כניסה לשני מסכים קיימים שאין אליהם היום קישור: ״הכנסות והוצאות״ ו״מבנה אחיד״.

<img src="proposals/f4c.png" width="320">

---

## ממומש · #916 (צילומים מהקוד הממומש, API מדומה)

צולם מהענף ב־HEAD `8609ad8e`, בשרת מקומי עם API מדומה. אין נתוני עסק. הנתונים הם נתוני בדיקה.

### המסך הראשי · /documents

<img src="implemented/hub__mobile.png" width="300"> <img src="implemented/hub__desktop.png" width="560">

### תור אימות · /documents/inbox

<img src="implemented/inbox__mobile.png" width="300"> <img src="implemented/inbox__desktop.png" width="560">

### תור אימות · ריק

<img src="implemented/inbox-empty__mobile.png" width="300"> <img src="implemented/inbox-empty__desktop.png" width="560">

### חיפוש מסמכים · /documents/search

<img src="implemented/search__mobile.png" width="300"> <img src="implemented/search__desktop.png" width="560">

### חיפוש · אין תוצאות

<img src="implemented/search-empty__mobile.png" width="300"> <img src="implemented/search-empty__desktop.png" width="560">

### אימות מסמך · /documents/review/[id]

<img src="implemented/review__mobile.png" width="300"> <img src="implemented/review__desktop.png" width="560">

### אימות · עריכת שדה

<img src="implemented/review-edit__mobile.png" width="300">

### אימות · ״שמור כמסמך מידע?״

<img src="implemented/review-docmode-confirm__mobile.png" width="300">

### אימות · אחרי אישור

<img src="implemented/review-done__mobile.png" width="300"> <img src="implemented/review-done__desktop.png" width="560">

### אימות · בעיבוד

<img src="implemented/review-processing__mobile.png" width="300">

### אימות · נכשל

<img src="implemented/review-failed__mobile.png" width="300">

### אימות · לא נמצא

<img src="implemented/review-notfound__mobile.png" width="300">

### העלאת קובץ · /documents/upload

<img src="implemented/upload__mobile.png" width="300"> <img src="implemented/upload__desktop.png" width="560">

### קליטה מ-Gmail · לא מחובר (הכרטיס מוצג גם במובייל)

<img src="implemented/email-off__mobile.png" width="300"> <img src="implemented/email-off__desktop.png" width="560">

### קליטה מ-Gmail · מחובר

<img src="implemented/email__mobile.png" width="300"> <img src="implemented/email__desktop.png" width="560">

### חבילת רו״ח · /documents/accountant-pack

<img src="implemented/pack__mobile.png" width="300"> <img src="implemented/pack__desktop.png" width="560">

### חבילת רו״ח · חלון ״שלחתי בעצמי״

<img src="implemented/pack-manual-confirm__mobile.png" width="300">

### חבילת רו״ח · חלון ״בטל קישור״

<img src="implemented/pack-revoke-confirm__mobile.png" width="300">

### חבילת רו״ח · מתג חודשי כבוי (הורדה לתקופה)

<img src="implemented/pack-adhoc__mobile.png" width="300"> <img src="implemented/pack-adhoc__desktop.png" width="560">


---

## Production · promaxgroup.co.il (אחרי הפריסה)

הקוד שנפרס (`4d1ad82b`, ‏`dpl_meGHkaVgGvMVgaKk5mK2xmn526vA`) מוצג בדפדפן. קריאות ה־API יורטו בדפדפן ונענו בנתוני דמה, ולכן שום בקשה לא הגיעה ל־API של Production ולא נגענו בנתונים. מסכים עם פעולת כתיבה דולגו.

**email**

<img src="production/email__mobile.png" width="300"> <img src="production/email__desktop.png" width="560">

**email-off**

<img src="production/email-off__mobile.png" width="300"> <img src="production/email-off__desktop.png" width="560">

**hub**

<img src="production/hub__mobile.png" width="300"> <img src="production/hub__desktop.png" width="560">

**inbox**

<img src="production/inbox__mobile.png" width="300"> <img src="production/inbox__desktop.png" width="560">

**inbox-empty**

<img src="production/inbox-empty__mobile.png" width="300"> <img src="production/inbox-empty__desktop.png" width="560">

**pack**

<img src="production/pack__mobile.png" width="300"> <img src="production/pack__desktop.png" width="560">

**pack-adhoc**

<img src="production/pack-adhoc__mobile.png" width="300"> <img src="production/pack-adhoc__desktop.png" width="560">

**review**

<img src="production/review__mobile.png" width="300"> <img src="production/review__desktop.png" width="560">

**review-failed**

<img src="production/review-failed__mobile.png" width="300">

**review-notfound**

<img src="production/review-notfound__mobile.png" width="300">

**review-processing**

<img src="production/review-processing__mobile.png" width="300">

**search**

<img src="production/search__mobile.png" width="300"> <img src="production/search__desktop.png" width="560">

**search-empty**

<img src="production/search-empty__mobile.png" width="300"> <img src="production/search-empty__desktop.png" width="560">

**upload**

<img src="production/upload__mobile.png" width="300"> <img src="production/upload__desktop.png" width="560">


</div>
