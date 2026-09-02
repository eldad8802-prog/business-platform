# Dubiz — Baseline Readiness Audit v1 (Official Baseline)

> **מטרה:** תמונת אמת אחת של המערכת בפועל. **מדידה, לא תכנון.**
> **כלל הראיה:** כל קביעה נסמכת על ראיה מהקוד/הסכימה/התצורה. מה שאין לו ראיה
> מסומן **UNVERIFIED** ואינו נחשב עובדה.
> **לא כולל:** Roadmap · פתרונות · סדר עבודה.
> **תאריך מדידה:** 2026-08-17 · ענף `feat/corporate-marketing-warm-alignment`.

---

## גבולות האודיט (מה לא נמדד)

נמדד **מצב הקוד והסכימה**. **לא** נמדדו: התנהגות ריצה בפרודקשן · **ערכי** משתני
הסביבה בפועל · מצב ה-DB בפרודקשן · מדיניות גיבוי אצל ספק ה-DB · האם אימות
Google/Meta **אושר** בפועל.

**סבב השלמה (2026-08-17):** שניים מארבעת סעיפי ה-UNVERIFIED נסגרו במדידת קוד —
**Content Studio** (נספח א') ו**דרישות סביבת הפרודקשן** (נספח ב'). שני הנותרים
אינם ניתנים לאימות מהקוד **מעצם טבעם** ונשארים UNVERIFIED (ראו §"מה שאינו ניתן
לאימות מהקוד").

---

## ⚠️ Reconciliation — 2026-08-18 · מדידה מול `origin/main`

> **תיקון מתוארך לפי Governance §7.3. אין כאן אודיט חדש** — אותה מתודולוגיה,
> על העץ הנכון.

### מה התגלה

**המדידה המקורית (2026-08-17) בוצעה על ענף `feat/corporate-marketing-warm-alignment`.**
בעת ה-Reconciliation נמצא שהענף היה **25 קומיטים מאחורי `origin/main`** — ובהם
`lib/business-memory`, תשתית חתימה קריפטוגרפית על PDF, והסרת 192 מסמכי משתמשים
מ-`public/uploads`.

**האודיט הצהיר על הענף שלו בשקיפות ולכן לא שגה בהצהרה — אך הוא תיאר עץ שאינו
`origin/main`.**

### 🔴 כשל מדידה שני — ספירת קבצי הבדיקות

| | |
|---|---|
| **המספר המקורי** | **373** קבצי בדיקה |
| **המספר הנכון** | **145** קבצים **במעקב git** על `origin/main` |
| **סיבת ההפרש** | הספירה סרקה את הדיסק וכללה את תיקיית **`.next`** — ארטיפקטים של build. העץ הישן: 376 בדיסק מול 136 במעקב. לעץ הנקי אין `.next`: 148 בדיסק מול 145 במעקב |

**המסקנה שנשענה על המספר — מבוטלת:**

> ~~"373 קבצי בדיקה — **גבוה משמעותית מהמקובל** במוצרים בשלב הזה"~~
>
> **מנוסח מחדש:** 145 קבצי בדיקה במעקב git. **כיסוי מהותי לפרויקט בגודל הזה,
> אך הטענה "גבוה משמעותית" נשענה על מספר מנופח פי 2.5 ואינה נתמכת בראיה.**

**זהו אותו סוג כשל כמו §ב.0** — לא תוצאה שגויה, אלא **שיטת מדידה שלא סוננה.**
שתי הפעמים: הסריקה נגעה במשטח שלא היה אמור להיכלל.

### המספרים הקנוניים החדשים — `origin/main`, 2026-08-18

| המדד | היה | **קנוני** |
|---|---|---|
| מודלים | 98 | **103** |
| נתיבי API | 179 | **179** |
| מסכים | 114 | **112** |
| מיגרציות | 89 | **94** |
| **קבצי בדיקה (git)** | ~~373~~ | **145** |
| תהליכי CI | 14 | **14** |

### עובדות שנשארו תקפות

`error.tsx` 0 · `not-found.tsx` 0 · `loading.tsx` 1 · אין `middleware.ts` ·
**אפס מודלי מסחר** (`C1`) · **אין `BusinessMembership`** (`C2`) · 179 נתיבי API.
**חמשת החסמים הקריטיים `C1`–`C5` — כולם פתוחים.**

### ממצאים שהתחזקו

| הממצא | היה | main | |
|---|---|---|---|
| `B15`/`X17` · `console.error` | 428 | **451** | 🔺 **גדל גם ב-main** — אינו תופעה מקומית של ענף אחד |
| `H6`/`B25`/`M8` · דריפט DS | 1,142 / 81 קבצים | **1,147 / 83** | 🔺 הדריפט ממשיך |

### פערים שנסגרו מאז

| הפער | הראיה |
|---|---|
| **`L1` / `B26`** · מסמכי משתמשים ב-`public/uploads` | **0 קבצים.** נסגר ב-`b19f2af` (192 מסמכים הוסרו) |
| **פרטים אישיים בדף יצירת קשר** | נסגר ב-`b50009c` |
| **`H1`** · הגבלת קצב | 5/179 → **10/179.** צומצם, לא נסגר |

### יכולות שנוספו מאז — לא נמדדו באודיט

| היכולת | מצב |
|---|---|
| **חתימה קריפטוגרפית על PDF** | **אינה `Missing` עוד.** נבנתה ב-`3fa9f7c`/`ad27772`. §3 באודיט ("חתימה דיגיטלית — Missing") **בטל** |
| **`lib/business-memory`** | 19 קבצים · **0 צרכנים חיצוניים** |

### הרחבת `X7` — ולא פער חדש

`X7` נוסח כ**"ארכיטקטורות מוח מתועדות היטב, אינרטיות בקוד"**. `business-memory`
נופל **בדיוק** בתוך ההגדרה: נבנה, נבדק, אפס צרכנים.

> **`X7` מתרחב לשלוש ארכיטקטורות: `referent-identity` · `detection-grammar` ·
> `business-memory`. אין צורך בפער חדש — הדפוס זהה, וההיקף גדל.**

*(נמדד ב-`C:/dev/bp-p0`, ענף `feat/p0-runtime-truth`, בסיס `2c64d0a`.)*

---

# דוח 1 — Executive Summary

**Dubiz היא מערכת גדולה ובוגרת בליבה הפיננסית, עם פער חריף בשכבות שמסביבה.**

המספרים: **98 מודלים · 179 נתיבי API · 114 מסכים · 89 מיגרציות · 373 קבצי בדיקה ·
14 תהליכי CI.** זו לא אב־טיפוס. זו מערכת בקנה מידה של מוצר חי.

**מה בשל:** החיוב תואם־הרגולציה (מספור אטומי, snapshot מוקפא, ייצוא מבנה אחיד,
OAuth ולקוח HTTP מול רשות המסים), שכבת התשלומים (שלושה ספקים, אימות חתימה על
Webhooks עם בדיקות), קליטת מסמכים ו-OCR, מלאי ורכש, ותשתית שחרור מגודרת עם אישור
אנושי.

**הפער אינו במוצר — הוא בכל מה שהופך מוצר לעסק.**

שלושה ממצאים מגדירים את התמונה:

1. **אין מנגנון גבייה. בכלל.** מתוך 98 מודלים, **אף אחד** אינו תוכנית, מנוי או
   חיוב־לקוח. המוצר יכול להוציא חשבוניות ללקוחות של המשתמש — אבל אינו יכול לגבות
   מהמשתמש עצמו.
2. **המוצר הוא חד־משתמש.** `User.businessId` הוא סקלר חובה, אין טבלת חברוּת, ותפקידי
   המשתמש הם `USER | PLATFORM_ADMIN` בלבד. עסק של שלושה אנשים אינו יכול לקבל שלוש
   כניסות — בזמן שהמיצוב ננעל במפורש על **1–3 אנשים**.
3. **המערכת עיוורת בפרודקשן.** אפס כלי ניטור שגיאות, אפס אנליטיקת מוצר. 179 נתיבים
   רצים בלי שאיש יידע כשהם נכשלים.

**המסקנה המדידה:** הליבה הפיננסית מוכנה להשקה; **מעטפת ההפעלה אינה.** הפערים
הקריטיים אינם פיצ'רים חסרים אלא **שכבות תשתית שלא נבנו** — מונטיזציה, ריבוי
משתמשים, תצפיתיות, ותזמון.

**ואי־ההתאמה החמורה ביותר** אינה בתוך תחום אחד אלא **ביניהם**: תיעוד ותכנון
(מיצוב, זהות, חוקה, ארכיטקטורות מוח) התקדמו הרבה מעבר לקוד. `lib/referent-identity`
קיים בקוד עם **אפס צרכנים**, ו-`detection-grammar` עם **שניים**. אנחנו מתכננים
מהר יותר משאנחנו מחברים.

---

# דוח 2 — Readiness Matrix

**"% משוער"** הוא הערכה של מידת הכיסוי ביחס למה שנדרש להשקה מסחרית. הוא אינדיקציה,
לא מדידה.

| # | תחום | בשלות | % | ראיה מרכזית | חסם עיקרי |
|---|---|---|---|---|---|
| 1 | **Product — ליבה פיננסית** | 🟢 | ~85% | 98 מודלים · billing/authority (74 קבצים) · payments (28) · uniform export | — |
| 1b | **Product — Content Studio** | 🟡 | ~40% | **נמדד (נספח א')** — 23 מסכים · ~9,300 שורות · 9 נתיבי API · 5 מודלים · **16/23 מסכים ללא קריאת API כלל** · מצב האשף ב-`localStorage("content_flow")` · **ContentRun/Variant/Render לא נקראים באף מסך** | היקף UI גדול מעל שכבת נתונים לא־מחוברת |
| 1c | **Product — מודולים היקפיים אחרים** | 🟡 | ~55% | coupons, inventory, revenue — בשלות לא אחידה | לא נמדדה בשלות פנימית לכל מודול |
| 2 | **UX — כיסוי מצבים** | 🔴 | ~15% | **1** `loading.tsx`, **0** `error.tsx`, **0** `not-found.tsx`, **0** `global-error` על 114 מסכים | כל שגיאת ריצה = מסך ברירת מחדל של Next |
| 2b | **UX — מצבים ריקים** | 🟡 | ~30% | 35 קבצים עם סימני Empty State · 41 עם Suspense/Skeleton | כיסוי חלקי, לא שיטתי |
| 3 | **Design System** | 🟡 | ~50% | 128 קבצים צורכים טוקנים · **81 קבצים עם 1,142 hex קשיחים** · 6 קבצי theme מקבילים | דריפט + ריבוי סמכויות |
| 4 | **Security — Auth** | 🟡 | ~55% | Bearer token ב-**localStorage** · **אין `middleware.ts`** · bcrypt · login+register מוגבלי־קצב | טוקן חשוף ל-XSS · אין שער ברמת נתיב |
| 4b | **Security — Tenant Isolation** | 🟢 | ~85% | 149/179 נתיבים מזכירים `businessId`; 30 הנותרים = webhooks/admin/health/debug מנוטרל (מחזיר 404) | אין אכיפה מרכזית — לפי נתיב |
| 4c | **Security — Rate Limiting** | 🔴 | ~10% | `@upstash/ratelimit` מותקן · **5 מתוך 179 נתיבים** מוגנים | העלאות ו-OCR חשופים לעלות/ניצול |
| 4d | **Security — Audit** | 🟡 | ~45% | 3 מודלי audit נפרדים (Platform/Billing/Payment) | **אין כיסוי** ל-CRM, מלאי, מסמכים |
| 5 | **Compliance — רשות המסים** | 🟢 | ~85% | רישום 270901 · מכונת מצבים + OAuth + לקוח HTTP · ייצוא מבנה אחיד | — |
| 5b | **Compliance — Google/Meta** | 🟡 | ~40% | חבילת הגשה קיימת כ**מסמך בלבד**; אין ראיה לאישור | **UNVERIFIED** — Gmail עלול להיות לא זמין למשתמשי קצה |
| 5c | **Compliance — Legal/Privacy** | 🟢 | ~75% | privacy · terms · data-deletion · contact — כולם קיימים | מדיניות שמירה/מחיקה לא נמדדה בקוד |
| 6 | **Infrastructure** | 🟡 | ~60% | Vercel · R2 · 89 מיגרציות · `release-migrate` מגודר באישור אנושי · 14 CI | **אין ראיה לגיבוי/DR** (UNVERIFIED) |
| 6b | **Infrastructure — תצורת ENV** | 🟡 | ~60% | **נמדד (נספח ב') · תוקן 2026-08-18** — **84 משתני Runtime** (+ קבוצת CI נפרדת); **7 חוסמי־ריצה** · ~10 ליבה · ~45 פר־אינטגרציה · ~22 כוונון | אין קובץ תיעוד/סכמת ENV אחד; אין אימות תצורה בהפעלה. **10 משתנים היו נסתרים מהמדידה המקורית** |
| 7 | **AI & Learning** | 🔴 | ~25% | `openai` ב-9 קבצים · business-brain 30 קבצים/**13 צרכנים** · detection-grammar 9/**2** · referent-identity **0 צרכנים** | רוב הארכיטקטורה **אינרטית** |
| 8 | **Business — Onboarding** | 🟡 | ~35% | מסך onboarding יחיד · register קיים | לא נמדד תוכן המסלול |
| 8b | **Business — Monetization** | 🔴 | **0%** | **אפס מודלים** של Plan/Subscription/Billing-of-customer ב-98 המודלים | **אי אפשר לגבות כסף** |
| 8c | **Business — Support** | 🔴 | ~15% | דף `contact` בלבד | אין מערכת פניות/SLA |
| 9 | **Mobile Readiness** | 🔴 | **~5%** | **אין** manifest.json · **אין** service worker · אין Capacitor/RN · אין push · אין מודל Notification · 2 קבצי PNG ב-public | לא ניתן להתקנה, לא בחנויות |
| 10 | **Operational Readiness** | 🔴 | ~20% | **אפס** תלויות ניטור שגיאות/אנליטיקה · ProductUsageEvent פנימי (7 קבצים) · BusinessFeatureAccess (דגלים) קיים · 14 CI | **עיוורון מלא בפרודקשן** |

**ממוצע משוקלל (הערכה): המערכת בכ-45% מוכנות להשקה מסחרית.**
הליבה גבוהה בהרבה; המעטפת מושכת את הממוצע למטה.

---

# דוח 3 — Master Gap Report

## 🔴 CRITICAL — חוסמי השקה

| # | הפער | ראיה | תלוי ב־ | סיכון |
|---|---|---|---|---|
| **C1** | **אין תשתית מונטיזציה** — לא תוכניות, לא מנויים, לא חיוב משתמש | 98 מודלים, אפס מהם מסחרי | — | לא ניתן לייצר הכנסה. חוסם גם הכרעת מחיר בדף הבית |
| **C2** | **אין ריבוי משתמשים** — `businessId` סקלר חובה, אין `BusinessMembership`, תפקידים = USER/PLATFORM_ADMIN | schema.prisma:34, enum UserRole | Auth refactor רוחבי | **סותר ישירות את הפרסונה הנעולה (1–3 אנשים)** |
| **C3** | **אפס תצפיתיות** — אין ניטור שגיאות, אין אנליטיקת מוצר | package.json — אפס תלויות רלוונטיות | — | כשלים בפרודקשן בלתי נראים. אין דרך לדעת אם השקה הצליחה |
| **C4** | **אפס כיסוי שגיאות ב-UI** — 0 `error.tsx`, 0 `not-found.tsx`, 0 `global-error` | 114 מסכים | — | כל תקלה מציגה מסך גנרי באנגלית ב-RTL |
| **C5** | **אין תזמון ואין מסירה** — אין cron ב-vercel.json, אין מודל Notification, אין push | vercel.json · schema | תשתית תור/cron | **"המזכירה" אינה יכולה להזכיר.** מפר את הבטחת הליבה |

## 🟠 HIGH

| # | הפער | ראיה | תלוי ב־ | סיכון |
|---|---|---|---|---|
| **H1** | **Rate limiting ב-5 מתוך 179 נתיבים** | grep על נתיבי API | — | עלות OCR/AI, ניצול העלאות. login/register **כן** מוגנים |
| **H2** | **טוקן אימות ב-localStorage** ולא ב-httpOnly cookie | lib/client-session.ts:5 | Auth refactor | חשיפת סשן ב-XSS |
| **H3** | **אין `middleware.ts`** — אין שער אימות ברמת נתיב | שורש הפרויקט | — | ההגנה תלויה בזכירה בכל נתיב בנפרד |
| **H4** | **Mobile packaging אפס** — אין PWA, אין push, אין חנויות | public/ | C5 (push) | מוצר שתוכנן לטלפון, לא ניתן להתקנה |
| **H5** | **Gmail verification לא מאומת** | מסמך הגשה בלבד | Google | מקור קליטה שמוצג בדף הבית עלול לא לעבוד |
| **H6** | **דריפט DS** — 1,142 hex קשיחים ב-81 קבצים, 6 סמכויות theme | grep | Design Language v1 | השפה שאושרה אינה נאכפת בקוד הקיים |
| **H7** | **אין ראיה לגיבוי/DR** | חיפוש בקוד ובתצורה | ספק DB | **UNVERIFIED** — אם אין, זהו CRITICAL |
| **H8** | **אין מערכת תמיכה** | דף contact בלבד | — | אין ערוץ טיפול אחרי השקה |

## 🟡 MEDIUM

| # | הפער | ראיה |
|---|---|---|
| **M1** | כיסוי audit חלקי — CRM/מלאי/מסמכים ללא audit | 3 מודלים בלבד |
| **M2** | 3 מערכות audit מפוצלות עם קוד hash כפול | schema:325/1921/2749 |
| **M3** | Empty/Loading states לא שיטתיים — 35/41 קבצים על 114 מסכים | grep |
| **M4** | Onboarding = מסך יחיד; לא נמדד שהוא מוביל ליכולות | app/onboarding |
| **M5** | `LearningEvent` קיים אך כיסוי דק (11 קבצים) | grep |
| **M6** | **Content Studio — שכבת נתונים לא־מחוברת:** 5 מודלים קיימים, `ContentRun` נכתב מנתיב אחד בלבד, ו**אף מסך אינו קורא** ContentRun/Variant/Render | נספח א' |
| **M7** | **Content Studio — מצב אשף ב-localStorage:** 16 מ-23 המסכים אינם פונים ל-API; כל זרימת היצירה נשענת על מפתח `content_flow` בדפדפן | נספח א' |
| **M8** | **Content Studio מרכז את דריפט ה-DS:** 457 מתוך 1,142 ה-hex הקשיחים (40%) נמצאים ב-17 מ-23 מסכיו | נספח א' |
| **M9** | **אין סכמת ENV אחת ואין אימות תצורה בהפעלה** — 74 משתנים מפוזרים, ללא מקור אמת יחיד | נספח ב' |

## 🟢 LOW

| # | הפער |
|---|---|
| **L1** | `public/uploads` — מסמכי משתמשים אמיתיים בתיקייה ציבורית |
| **L2** | 3 מנועי PDF במקביל |
| **L3** | נתיבי debug מנוטרלים שנשארו בקוד (מחזירים 404 — לא סיכון) |

---

## אי־ההתאמות בין תחומים — הממצא המרכזי

זה מה שהאודיט נועד למצוא. **כל אחת מהן קיימת רק בגלל שהתחומים נבדקו יחד.**

| # | אי־ההתאמה | הצדדים | חומרה |
|---|---|---|---|
| **X1** | **המיצוב מבטיח 1–3 אנשים; המוצר תומך באחד** | Positioning ↔ Schema | 🔴 |
| **X2** | **הזהות מבטיחה "מזכירה שזוכרת"; אין תזמון ואין מסירה** | Identity/Product ↔ Infra | 🔴 |
| **X3** | **מוצר מלא, אפס יכולת לגבות עליו כסף** | Product ↔ Business | 🔴 |
| **X4** | **114 מסכים בשלים מול אפס גבולות שגיאה** | UX ↔ Product | 🔴 |
| **X5** | **תצפיתיות מפגרת אחרי 179 נתיבים בפרודקשן** | Ops ↔ Product | 🔴 |
| **X6** | **המוצר טלפון־ראשון; אין אריזה למובייל** | UX ↔ Mobile | 🟠 |
| **X7** | **ארכיטקטורות מוח מתועדות היטב, אינרטיות בקוד** — referent-identity: 0 צרכנים | Docs ↔ Runtime | 🟠 |
| **X8** | **Design Language אושר; 81 קבצים חורגים ממנו** | DS ↔ Codebase | 🟠 |
| **X9** | **דף הבית מציג "מייל" כמקור קליטה; אימות Google לא מאומת** | Marketing ↔ Compliance | 🟠 |
| **X10** | **Tenant isolation נאכף פר־נתיב, בלי שער מרכזי** | Security ↔ Architecture | 🟠 |
| **X11** | **תשתית דגלי פיצ'רים קיימת; אין תשתית מדידה שתשתמש בה** | Ops ↔ Product | 🟡 |

## שרשראות תלות בין פערים

```
C1 מונטיזציה ──► חוסם: הכרעת מחיר בדף הבית
                        ריבוי תוכניות ב-BusinessFeatureAccess

C2 ריבוי משתמשים ──► דורש: Auth refactor (H2, H3)
                     חוסם: X1 (סתירת פרסונה)
                     חוסם: הרשאות פנים־עסקיות

C5 תזמון ──► דורש: cron/queue
             חוסם: push (H4) ──► חוסם: אריזת מובייל
             חוסם: X2 (הבטחת הליבה)

C3 תצפיתיות ──► חוסם: כל החלטה מבוססת־נתונים אחרי השקה
                חוסם: מדידת הצלחת C1

H7 גיבוי (UNVERIFIED) ──► אם שלילי: מקדים את כל השאר
```

**שלוש שרשראות עצמאיות** (מונטיזציה · זהות־משתמש · תזמון) ו**שתי רוחביות**
(תצפיתיות · גיבוי) שאינן תלויות באיש ואיש אינו תלוי בהן — כלומר ניתנות לביצוע
במקביל.

---

## מה שאינו ניתן לאימות מהקוד — ונשאר UNVERIFIED לצמיתות

שני הסעיפים הנותרים **אינם ניתנים לסגירה במדידת קוד**, ולא מפני שלא נמדדו אלא
מפני שהעובדה עצמה חיה מחוץ למאגר.

| # | הפריט | למה אי אפשר לאמת מהקוד | מי יכול לאמת | ההשפעה על הבסיס |
|---|---|---|---|---|
| **U1** | **מדיניות גיבוי ושחזור ב-DB** | גיבויים הם הגדרה בצד ספק ה-DB. קוד האפליקציה אינו מכיל ואינו יכול להכיל ראיה לקיומם | קונסולת ספק ה-DB | **אם אין — עולה ל-CRITICAL ומקדים את C1–C5** |
| **U2** | **אישור אימות Google/Gmail** | מצב האישור הוא רשומה ב-Google Cloud Console. במאגר קיימת **חבילת הגשה בלבד** (`docs/google-gmail-verification-submission-package-v1.md`) — הגשה אינה אישור | Google Cloud Console | משנה את H5 ואת X9; משפיע על מה שדף הבית רשאי להציג |

**סעיפים שנסגרו בסבב ההשלמה:** Content Studio (נספח א') · דרישות ENV (נספח ב').
**הערה:** נספח ב' ממפה אילו משתנים הקוד **דורש** — לא את **ערכיהם בפרודקשן**,
שאינם נגישים מהמאגר ואינם חלק מהמדידה.

---

# נספח א' — Content Studio (מדידת השלמה)

**מתודולוגיה זהה לשאר האודיט:** קיום מסך · נתיב API תומך · שכבת שירות · מודל
נתונים · נגישות מניווט · מצבי UX · אימוץ DS.

## א.1 היקף

| מדד | ערך |
|---|---|
| מסכים | **23** *(תוקן — באודיט הראשוני נרשם 24)* |
| סך שורות | **~9,300** |
| נתיבי API | **9** |
| מודלי DB | **5** — `ContentRun` · `ContentVariant` · `ContentRender` · `ContentEvent` · `ContentFeedback` |
| שירותים | **37** תחת `lib/services/` |
| נגיש מניווט | ✅ `components/navigation/action-sheet.tsx:35` |

**המסכים הגדולים:** `result` (1,175) · `creator-plan` (1,148) · `render` (698) ·
`shot-direction` (670) · `generate` (668) · `ai-assets` (602) · `archetype` (566).
**המסכים הזעירים:** `value` (67) · `style` (70) · `intent` (87) · `mode` (88).

## א.2 הממצא המרכזי — שכבת הנתונים אינה מחוברת

שלוש מדידות שיחד מגדירות את בשלות המודול:

| # | המדידה | הראיה |
|---|---|---|
| 1 | **16 מתוך 23 המסכים אינם מבצעים קריאת רשת כלל** | `ai-brief · archetype · assets · context · direction · flow · format · goal · intent · mode · (root) · setup · shot-direction · style · summary · value` |
| 2 | **מצב האשף חי בדפדפן**, במפתח יחיד | `localStorage.getItem("content_flow")` — למשל `creator-plan/page.tsx:206,261,342` |
| 3 | **`ContentRun` / `ContentVariant` / `ContentRender` — אפס קוראים** | חיפוש על `app/(shell)` ו-`app/api` החזיר **0 התאמות** |

**נגזרת מדידה:** `content-plan-persistence-v1.service.ts` (הכותב היחיד ל-`ContentRun`)
נקרא **מנתיב אחד בלבד** — `app/api/video/plan/route.ts`. כלומר: 5 מודלים קיימים,
אחד מהם נכתב מנקודה אחת, ואף אחד מהם אינו מוצג בשום מסך.

> **קביעה מדידה:** Content Studio הוא **אשף צד־לקוח בן 23 מסכים** שמצבו נשמר
> בדפדפן. שכבת הנתונים קיימת בסכימה אך **אינה סוגרת מעגל** — אין קריאה חזרה,
> ולכן אין היסטוריה, אין המשכיות בין מכשירים, ואין שחזור לאחר איבוד הלשונית.

## א.3 מצבי UX ואימוץ DS

| מדד | ערך | הערה |
|---|---|---|
| `loading.tsx` / `error.tsx` / `not-found.tsx` | **0** | עקבי עם כלל המערכת (C4) |
| קבצים הצורכים טוקנים | 14 מתוך 23 | |
| קבצים עם hex קשיח | **17 מתוך 23** | |
| מופעי hex קשיח | **457** | **40% מכלל 1,142 המופעים במערכת** |

**נגזרת:** Content Studio הוא **המוקד הגדול ביותר של דריפט ה-DS** — כ-40% מהחריגה
במערכת מרוכזת ב-23 מסכים.

## א.4 דירוג בשלות

🟡 **Partial · ~40%**

**בשל:** היקף UI · שירותים · מודלים בסכימה · נגישות מניווט · אינטגרציית LLM
(`CONTENT_LLM_*`) ורינדור (`CREATOMATE_API_KEY`).
**חסר:** סגירת מעגל נתונים · היסטוריה ושחזור · מצבי UX · יישור DS.

---

# נספח ב' — דרישות סביבת פרודקשן (84 משתני Runtime)

**מה נמדד:** אילו משתנים הקוד **דורש** ומה קורה כשהם חסרים.
**מה לא נמדד:** **ערכיהם בפועל** — אינם נגישים מהמאגר.

---

## ב.0 · תיקון מדידה — 2026-08-18

> **סעיף זה מתעד תיקון של הנספח לפי Governance §7.3. הבסיס מתוקן במדידה בלבד.**

### מה הייתה המדידה המקורית (2026-08-17)
סריקת **`process.env.NAME`** — גישה בשם מפורש — על `app/`, `lib/`, `components/`,
`next.config.ts`. **תוצאה: 74 משתנים · 4 חוסמי ריצה · ערכת מינימום 14.**

### מה נמצא כשגוי בה
**הכשל אינו בתוצאה אלא בשיטה.** הסריקה זיהתה גישה בשם מפורש בלבד, ולכן הייתה
**עיוורת מבנית** לשלושה דפוסים:

| הדפוס | הדוגמה |
|---|---|
| **גישה דינמית** `process.env[CONST]` — 34 מופעים בקוד | `const ENV_KEY_NAME = "WHATSAPP_TOKEN_ENCRYPTION_KEY"; … process.env[ENV_KEY_NAME]` |
| **`env()` בסכמת Prisma** — לא TypeScript כלל | `prisma/schema.prisma:8 · directUrl = env("DIRECT_URL")` |
| **שמות מורכבים בזמן ריצה** | `process.env[`${prefix}_${envSuffix(environment)}`]` |

**חומרת העיוורון:** דווקא **מפתחות ההצפנה** נכתבו בדפוס הדינמי. שלושה מארבעת
חוסמי הריצה שכן נמצאו — נמצאו במקרה.

### שיטת המדידה החדשה — שמונה משטחי תצורה

| # | המשטח | תוצאה |
|---|---|---|
| 1 | `process.env.NAME` ב-TS/TSX | 74 |
| 2 | **`process.env[CONST]` — גישה דינמית, כולל שמות מורכבים** | **+9** |
| 3 | **`env()` ב-`prisma/*.prisma`** | **+1** |
| 4 | `next.config.ts` | 0 |
| 5 | `vercel.json` | 0 — אין הגדרות סביבה |
| 6 | תהליכי CI (`secrets.*` · `vars.*` · בלוקי `env:`) | קבוצת CI **נפרדת** |
| 7 | סקריפטים ב-`ops/` | אין משתני Runtime חדשים |
| 8 | קבצי `.env*` | **לא נקראו** (סודות) — נבדק שאינם במעקב git |

### מה השתנה

| | לפני | אחרי |
|---|---|---|
| משתני Runtime | 74 | **84** |
| קבוצת CI | לא הופרדה | **מופרדת, אינה נספרת** |
| CRITICAL | 4 | **7** |
| ערכת מינימום מעשית | 14 | **17** |
| שיטת המדידה | משטח אחד | **שמונה משטחים** |

### עשרת המשתנים שהתגלו

| # | המשתנה | המקור | רמה |
|---|---|---|---|
| 1 | `DIRECT_URL` | `schema.prisma:8` | **CRITICAL** — גישה ישירה למסד; מיגרציות |
| 2 | `BILLING_AUTHORITY_ENCRYPTION_KEY` | `billing-authority-token-crypto.service.ts:28→44` | **CRITICAL** — fail-closed |
| 3 | `WHATSAPP_TOKEN_ENCRYPTION_KEY` | `whatsapp/token-crypto.service.ts:49→65` | **CRITICAL** — fail-closed |
| 4 | `BILLING_AUTHORITY_RUNTIME_ENVIRONMENT` | `billing-authority-env.service.ts:8→53` | INTEGRATION — **בוחר SANDBOX מול PRODUCTION מול רשות המסים** |
| 5 | `AUTHORITY_OAUTH_PATH_SEGMENT_*` | `billing-authority-env.service.ts:13` | INTEGRATION |
| 6 | `GOOGLE_VISION_CREDENTIALS_JSON` | `google-vision-ocr.service.ts:5→59` | INTEGRATION — OCR |
| 7 | `BILLING_PDF_STORAGE_ROOT` | `billing-pdf-storage.ts:14→32` | OPTIONAL — יש ברירת מחדל |
| 8 | `FEATURE_ACCESS_MUTATIONS_ENABLED` | `feature-access-mutations.ts:1` | OPTIONAL — דגל |
| 9 | `PRODUCT_USAGE_TRACKING` | `record-product-usage-event.ts:6→9` | OPTIONAL — kill switch |
| 10 | `CONVERSATION_STATE_WRITER_ENABLED` | `conversation-state.service.ts:43→46` | OPTIONAL — דגל |

### קבוצת CI — נפרדת, אינה נספרת כ-Runtime

`NEON_API_KEY` · `NEON_PROJECT_ID` · `CI_DATABASE_URL` · `PGSSLMODE` ·
`BILLING_AUTHORITY_ITA_CLIENT_ID` · `BILLING_AUTHORITY_CLIENT_SECRET` ·
`BILLING_AUTHORITY_ACCOUNTING_SOFTWARE_NUMBER` · `EVENT_*`

⚠️ **תצפית, לא מסקנה:** שלושת משתני ה-ITA אינם נצרכים בקוד האפליקציה — סימן
אפשרי לכך שאישורי הרשות נשמרים במסד ולא בסביבה. **לא אומת.**

### ✅ ממצא נלווה חיובי
`.env` · `.env.local` · `.env.production` · `.env.c2-p2-test` — **אינם במעקב git**;
`.gitignore:37` מכסה `.env*`. **אין סודות במאגר.** תוכנם לא נקרא.

## ב.1 מקרא רמות

| רמה | משמעות |
|---|---|
| **CRITICAL** | בלעדיו המערכת אינה מתפקדת בפרודקשן |
| **REQUIRED** | בלעדיו יכולת ליבה שלמה מושבתת |
| **INTEGRATION** | בלעדיו אינטגרציה מסוימת מושבתת; שאר המערכת רצה |
| **OPTIONAL** | כוונון, דגל או ברירת מחדל |
| **TEST-ONLY** | נצרך בבדיקות בלבד |

## ב.2 CRITICAL — חוסמי ריצה (7)

| משתנה | התנהגות בהיעדרו | ראיה |
|---|---|---|
| `DATABASE_URL` | **כל גישה ל-DB נכשלת.** Prisma נכשל באתחול | `schema.prisma:7` |
| **`DIRECT_URL`** ⬅ | **מיגרציות נכשלות.** דרך גישה שנייה למסד, עוקפת איגום | `schema.prisma:8` · 10 תהליכי CI |
| `AUTH_TOKEN_SECRET` | **Fail closed** — `AuthTokenConfigError`. **איש אינו יכול להתחבר** | `lib/auth-token.ts:20-32` |
| `PAYMENTS_ENCRYPTION_KEY` | **Fail closed** בהצפנת אישורי תשלום | `payment-crypto.service.ts:13,26` |
| `GMAIL_TOKEN_ENCRYPTION_KEY` | **Throw** — קליטת Gmail אינה עולה | traced |
| **`BILLING_AUTHORITY_ENCRYPTION_KEY`** ⬅ | **Fail closed** — אסימוני רשות המסים אינם ניתנים לפענוח | `billing-authority-token-crypto.service.ts:28→44` |
| **`WHATSAPP_TOKEN_ENCRYPTION_KEY`** ⬅ | **Fail closed** — אסימוני וואטסאפ אינם ניתנים לפענוח | `whatsapp/token-crypto.service.ts:49→65` |

⬅ = התגלה בסריקה החוזרת (ב.0). **שלושת החדשים היו נסתרים מהמדידה המקורית.**

## ב.3 REQUIRED — יכולות ליבה

| משתנה | בהיעדרו |
|---|---|
| `STORAGE_PROVIDER` · `R2_ACCOUNT_ID` · `R2_ACCESS_KEY_ID` · `R2_SECRET_ACCESS_KEY` · `R2_BUCKET_NAME` · `R2_PUBLIC_BASE_URL` | **אחסון קבצים מושבת** — העלאות, PDF, נכסים |
| `APP_BASE_URL` · `NEXT_PUBLIC_APP_URL` | קישורים ציבוריים שגויים (קיים fallback) |
| `PLATFORM_ADMIN_EMAILS` | **שער האדמין נסגר** (fail-closed מתועד) |
| `OPENAI_API_KEY` | כל יכולות ה-AI מושבתות |

## ב.4 INTEGRATION — פר־אינטגרציה (~40 משתנים)

| קבוצה | משתנים | בהיעדרם |
|---|---|---|
| **רשות המסים** | `AUTHORITY_API_BASE_PRODUCTION/SANDBOX` · `AUTHORITY_OAUTH_BASE_PRODUCTION/SANDBOX` · `BILLING_AUTHORITY_OAUTH_REDIRECT_BASE_URL` | הקצאת מספרים ו-OAuth מושבתים |
| **WhatsApp** | `WHATSAPP_ACCESS_TOKEN` · `WHATSAPP_APP_SECRET` · `WHATSAPP_WEBHOOK_VERIFY_TOKEN` · `WHATSAPP_GRAPH_API_VERSION` · `WHATSAPP_GRAPH_VERSION` · `WHATSAPP_PHONE_NUMBER_BUSINESS_MAP` · `WHATSAPP_ALLOWLIST_BY_BUSINESS` · `WHATSAPP_ALLOW_ENV_FALLBACK` · `WHATSAPP_MANUAL_SEED_ENABLED` · `NEXT_PUBLIC_WHATSAPP_*` (2) | קליטת וואטסאפ מושבתת. `WHATSAPP_APP_SECRET` מוחזר כ-`null` בהיעדרו → **אימות חתימת webhook אינו יכול לפעול** |
| **Google/Gmail** | `GOOGLE_OAUTH_CLIENT_ID` · `GOOGLE_OAUTH_CLIENT_SECRET` · `GOOGLE_OAUTH_REDIRECT_BASE_URL` | קליטת מייל מושבתת |
| **Meta** | `META_APP_ID` · `NEXT_PUBLIC_META_APP_ID` | Embedded Signup מושבת |
| **תשלומים** | `CARDCOM_BASE_URL` · `PAYPAL_CLIENT_ID` · `PAYPAL_CLIENT_SECRET` · `PAYPAL_ENV` · `PAYMENTS_PUBLIC_BASE_URL` | ספק/ים מושבתים (fallbacks קיימים לחלקם) |
| **Rate limiting** | `UPSTASH_REDIS_REST_URL` · `UPSTASH_REDIS_REST_TOKEN` · `RATE_LIMIT_BACKEND` · `RATE_LIMIT_REDIS_TIMEOUT_MS` | הגבלת הקצב (5 נתיבים בלבד ממילא) יורדת ל-backend חלופי |
| **POS** | `POS_INGEST_SECRET` · `POS_INGEST_BUSINESS_ID` | קליטת POS מושבתת |
| **מדיה** | `CREATOMATE_API_KEY` · `PEXELS_API_KEY` | רינדור וידאו / סטוק מושבתים |

## ב.5 OPTIONAL — כוונון ודגלים (~20)

`BILLING_PDF_RENDERER` · `BILLING_PDF_DEBUG_LOG` · `BILLING_PDF_SKIP_CACHE` ·
`BILLING_PDF_FREE_TEXT_BIDI` · `BOT_LLM_DRAFTS_ENABLED` · `BOT_LLM_DRAFTS_SHADOW` ·
`BOT_LLM_DRAFTS_DAILY_CAP` · `BOT_LLM_DRAFTS_SAMPLE_RATE` · `BOT_LLM_DRAFTS_LOG_TEXT` ·
`BOT_LLM_MODEL` · `CONTENT_LLM_ENABLED` · `CONTENT_LLM_MODEL` · `CONTENT_LLM_VARIANT` ·
`VISUAL_GEN_STOCK_ENABLED` · `VISUAL_GEN_LOG_METRICS` · `OCR_TIMEOUT_MS` ·
`AUTH_TOKEN_TTL_SECONDS` · `STORAGE_SIGNED_URL_TTL_SECONDS` · `LOCAL_STORAGE_ROOT` ·
`FORCE_MOCK_RENDER` · `COUPON_CODE_PUBLIC` · `ALLOW_INSECURE_COUPON_CODE` ·
`VERCEL_REGION` · `NODE_ENV`

## ב.6 TEST-ONLY — מאומת שאינם בקוד הריצה

| משתנה | ראיה |
|---|---|
| `TEST_DATABASE_URL` | מופיע בקבצי `.test.ts` בלבד |
| `SECURITY_BYPASS` | **אומת:** חיפוש מחוץ ל-`.test.ts` החזיר **0 התאמות**. אינו דלת אחורית בפרודקשן |

## ב.7 ערכת המינימום להרצה בפרודקשן

**חובה מוחלטת (7):** `DATABASE_URL` · **`DIRECT_URL`** · `AUTH_TOKEN_SECRET` ·
`PAYMENTS_ENCRYPTION_KEY` · `GMAIL_TOKEN_ENCRYPTION_KEY` ·
**`BILLING_AUTHORITY_ENCRYPTION_KEY`** · **`WHATSAPP_TOKEN_ENCRYPTION_KEY`**

**+ להפעלה שימושית (10):** אחסון R2 (6) · `PLATFORM_ADMIN_EMAILS` ·
`APP_BASE_URL` · `NEXT_PUBLIC_APP_URL` · `OPENAI_API_KEY`

**סה"כ מינימום מעשי: 17 משתנים.** 67 הנותרים מפעילים אינטגרציות או מכווננים
התנהגות.

**הערת טופולוגיה:** `DATABASE_URL` ו-`DIRECT_URL` הן **שתי דרכי גישה נפרדות
לאותו מסד** — מאוגדת וישירה. כל פעולה על המסד חייבת להצהיר באיזו מהן היא
משתמשת.

## ב.8 ממצא נלווה

**אין במאגר מקור אמת יחיד לתצורה** — לא `.env.example`, לא סכמת ולידציה, ולא
אימות תצורה בהפעלה. משתנה חסר מתגלה **בזמן ריצה, בנתיב הרלוונטי בלבד**. בהיעדר
תצפיתיות (C3), כשל תצורה בפרודקשן אינו מדווח לאיש. *(רשום כ-**M9**.)*

---

*Official Baseline v1 · עודכן 2026-08-17 בסבב ההשלמה. מדידה בלבד — ללא Roadmap,
ללא המלצות, ללא סדר עבודה. שני סעיפים (U1, U2) נותרים UNVERIFIED מפני שאינם ניתנים
לאימות מהקוד. כל החלטה עתידית נבחנת מול המסמך הזה. שינוי בבסיס מחייב מדידה חוזרת,
לא עדכון בהערכה.*
