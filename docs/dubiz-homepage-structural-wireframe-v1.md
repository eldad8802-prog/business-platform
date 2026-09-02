# Dubiz — דף הבית הציבורי: Structural Wireframe v1

> **סוג המסמך:** Structural wireframe — layout · hierarchy · density · visual storytelling · section boundaries · responsive & RTL narrative. **לא** visual design, לא קוד, לא צבעים, לא טיפוגרפיה סופית, לא components, לא mockup high-fidelity.
> **ממשיך את:** `docs/dubiz-homepage-positioning-strategy-v1.md` + `docs/dubiz-homepage-messaging-structure-v1.md` (שניהם מאושרים כבסיס קנוני; Verdict קודם: A — READY FOR WIREFRAME).
> **תאריך:** 2026-08-15.
> **מוסכמת סקיצה:** תיבות ASCII כאן הן **סכמטיות-מבניות בלבד** — יחסי גודל, סדר, וחלוקה — לא עיצוב. אין בהן צבע, פונט או מידות סופיות.

---

## 1. Purpose & Scope

**מטרה:** להכריע layout, hierarchy, density, section boundaries, ו-responsive/RTL narrative של דף הבית — לפני קוד או עיצוב.

**Scope — כן:** מבנה, היררכיה, קומפוזיציית סקשנים, התנהגות desktop/mobile, צפיפות תוכן, קונספט ויזואלי (מה רואים, לא איך צובעים), מיקום, כוונת אינטראקציה, הכרעות responsive/RTL/נגישות ברמת מבנה.
**Scope — לא:** קוד/React/CSS/Tailwind/components/image-generation/high-fidelity/צבעים/טיפוגרפיה-סופית/אנימציות/שינוי Design-System/שינוי האתר הציבורי.

---

## 2. Canonical Inputs (נקראו firsthand)

- **מיצוב:** תפקיד לא קטגוריה; פרסונה רונן; חוד = כסף + זיכרון; אמון = 270901; חפיר = זיכרון תפעולי × חוזה התנהגות.
- **מסר ומבנה:** 12 סקשנים מאושרים; Product Truth Matrix (A/B/C); §N claims אסורים; היררכיית מסרים; מפת התנגדויות.
- **חוזה ההתנהגות:** 4 מצבים (שקט/מיידעת/מדברת/שואלת); הבעלים מחליט; שקט כברירת מחדל; מדברת במסקנות.
- **דף קיים (baseline שיוחלף):** `app/(corporate)/home/page.tsx` — Hero "מערכת ההפעלה לעסק" (פסול) → 4 cards-קטגוריות (פסול) → גלריית 8 מסכי-מובייל אמיתיים (נכס לשימוש חוזר, בקופי מתוקן) → CTA יחיד "כניסה למערכת" (פסול כ-primary). **ה-UI הקיים אינו מכתיב את הארכיטקטורה החדשה.**

---

## 3. Owner Decisions Incorporated

1. מיצוב-מילה: **"המזכירה של העסק"** — מטאפורה לתפקיד, לא אדם. ✅
2. Primary CTA: **"התחילו עכשיו"**; "כניסה למערכת" = משנית לקיים; **בלי** "בחינם"/מחיר/התחייבות עד Product-Truth. destination = Launch Decision. ✅
3. **Scheduler/push = Hard Launch Gate.** הדף **Pull-only**: "נכנסת → כבר מסודר מה דורש אותך → אתה מחליט." אסור: תזכורת-בזמן/notification/"בדיוק בזמן"/"מסביב לשעון"/"תודיע לך לפני". ✅
4. Social proof — לא blocker; לא ממציאים. ✅
5. Competitor mismatch (Finbot מול iCount) — מתועד, לא מנוחש, לא reconciled, אין מחקר חדש. ✅

---

## 4. Narrative Thesis

> **הסיפור של בעל עסק שהיה המזכירה של עצמו — ועכשיו כבר לא חייב להיות. Dubiz מסדרת את העבודה; בעל העסק נשאר בעל ההחלטה.**

מסע-הרגש (חובה לשמר, §3 בהנחיה):
> העומס שלי → יש מי שמרכז אותו → הכסף והדברים הפתוחים מקבלים סדר → אני לא צריך להחליף הכול → Dubiz מכירה את העסק → אני נשאר בשליטה → אפשר לסמוך → אני מוכן להתחיל.

**מבחן הכשל (Final Test):** אם מוחקים את הלוגו והדף עדיין מרגיש כמו SaaS גנרי — נכשל. המבחן מיושם בכל סקשן דרך **Product-story surfaces** (מצבי-עבודה אמיתיים) במקום feature-cards.

---

## 5. Desktop Page Map (סדר + above-the-fold + density)

```
┌──────────────────────────────────────────────────────────────┐
│ HEADER  [כניסה למערכת ↩]           לוגו Dubiz  [ניווט מינימלי]│  ← RTL: לוגו ימין
├──────────────────────────────────────────────────────────────┤
│ 1 HERO            ▓ first viewport ▓         Emotion↑ Density↓ │
│   [טקסט: ימין]                    [ויזואל: שמאל]              │
│   eyebrow(270901) · H1 · support · [התחילו עכשיו][ראו איך]   │
│                                   ┌ "מה דורש אותך היום" ┐     │
│                                   │ Attention · Attention │     │
│                                   └───────────────────────┘     │
├──────────────────────────────────────────────────────────────┤
│ 2 PAIN "בעל מקצוע שהפך לפקיד"     Emotion↑ Density low-med    │
│   [מפוצל: אייקוני-עומס]  →  [שורת-מעבר אחת]                  │
├──────────────────────────────────────────────────────────────┤
│ 3 SECRETARY / ROLE (reframe)      Density med                 │
│   Before(scattered) → Organized attention → Owner decision    │
├──────────────────────────────────────────────────────────────┤
│ 4 MONEY WEDGE (חוד 1)             Conversion↑ Density med-high │
│   [state: פתוח/שולם/דורש-טיפול]  [ויזואל: מסך גבייה אמיתי]  │
├──────────────────────────────────────────────────────────────┤
│ 5 NOTHING FALLS THROUGH (חוד 2)   Density med · breathing      │
├──────────────────────────────────────────────────────────────┤
│ 6 BREADTH (ללא dump)  ▓ density PEAK ▓  "עסק אחד → תחומים"   │
│   גלריית product-states מחוברת (לא 7 cards)                  │
├──────────────────────────────────────────────────────────────┤
│ 7 ADD, DON'T REPLACE              Density low · reassurance    │
├──────────────────────────────────────────────────────────────┤
│ 8 OPERATIONAL MEMORY              Density low · calm           │
├──────────────────────────────────────────────────────────────┤
│ 9 CONTROL / AI-ANXIETY            Density med · clear          │
│   "Dubiz מכינה/מציעה → אתה מאשר" (human-approval)             │
├──────────────────────────────────────────────────────────────┤
│ 10 TRUST + COMPLIANCE             Density low-med · factual     │
│    [Compliance/Legal]  |  [Security/Privacy/Control]           │
├──────────────────────────────────────────────────────────────┤
│ 11 PROOF (מומלץ: closing proof-strip, לא social-proof band)   │
├──────────────────────────────────────────────────────────────┤
│ 12 FINAL CTA          Emotion↑ Density↓  "תפסיק להיות המשרד"  │
│    H2 · one-liner · [התחילו עכשיו] · reassurance             │
├──────────────────────────────────────────────────────────────┤
│ FOOTER  ניווט · משפטי · 270901 · יצירת קשר                   │
└──────────────────────────────────────────────────────────────┘
```

**Desktop split-convention (RTL):** בסקשנים מפוצלים — **טקסט בימין, ויזואל בשמאל** (המבקר קורא ימין→שמאל: קודם הטענה, אז ההוכחה). קבוע לאורך כל הדף כדי לא ליצור רעש.

---

## 6. Mobile Page Map (עצמאי — לא "stack הכול")

```
┌───────────────────────┐
│ HEADER  לוגו · [כניסה]│  ← "כניסה" = קישור-טקסט קטן, לא כפתור
├───────────────────────┤
│ ▓ FIRST VIEWPORT ▓    │
│ eyebrow 270901 (שורה) │
│ H1 (≤2 שורות)         │
│ support (משפט אחד)    │
│ [ התחילו עכשיו ]  ←full│  ← primary מלא-רוחב, thumb-reach תחתון
│ ראו איך זה עובד (link)│
├───────────────────────┤  ← קו-הקיפול בערך כאן
│ Attention card #1     │  ← הויזואל מתחיל מיד מתחת לקיפול
│ (situation→why→decide)│
│ Attention card #2     │  ← אנכי, אחד-מתחת-לשני
├───────────────────────┤
│ 2 PAIN (3–4 שורות)    │  ← מקוצר; לא wall-of-pain
├───────────────────────┤
│ 3 SECRETARY (אנכי)    │  Before ↓ Organized ↓ Decision
├───────────────────────┤
│ 4 MONEY (state stack) │  פתוח/שולם — בלי "מאחר X ימים"
├───────────────────────┤
│ [ התחילו עכשיו ] (חוזר)│  ← CTA חוזר אחרי זוג החודים
├───────────────────────┤
│ 5 NOTHING FALLS       │
├───────────────────────┤
│ 6 BREADTH  →→→ swipe  │  ← סקרול אופקי: 4–5 מסכים מובילים + "עוד"
├───────────────────────┤
│ 7 ADD-DON'T-REPLACE   │
│ 8 MEMORY              │
│ 9 CONTROL             │
│ 10 TRUST (מקופל/אקורדיון אם ארוך)│
│ 11 PROOF (רזה)        │
├───────────────────────┤
│ 12 FINAL CTA [התחילו] │  ← primary חוזר, thumb-reach
└───────────────────────┘
```

**כללי מובייל מחייבים:** H1 לא נשבר ל-4 שורות; support יורד למשפט אחד; Primary CTA גלוי בקיפול + חוזר אחרי §4 + בסוף; גלריית §6 = **סקרול אופקי מכוון** (לא רשת-8 שהופכת רעש), 4–5 מובילים; §10 ארוך → אקורדיון; אין horizontal-overflow לא-מכוון בשום סקשן אחר; tap-targets ≥44px; RTL: סקרול-אופקי מתחיל מימין.

---

## 7. Above-the-Fold Budget

מעל הקיפול עונים על 4 שאלות בלבד — **לא** מסבירים את כל Dubiz:
**(1) מה זה? (2) למה אכפת לי? (3) מה אני עושה עכשיו? (4) נראה אמין?**

| | Desktop first viewport | Mobile first viewport |
|---|---|---|
| **חובה** | eyebrow(270901) · H1 · support(1 שורה) · Primary CTA · secondary CTA · header "כניסה" · חלק מכרטיס-Attention נראה | eyebrow(270901 שורה) · H1(≤2) · support(משפט) · Primary CTA מלא-רוחב · header "כניסה" |
| **מיד מתחת** | כרטיס Attention מלא · אות מחיר [Launch] | 2 כרטיסי-Attention |
| **לא כאן** | רוחב מוצר, תאימות מלאה, כאב מפורט | הכול חוץ מ-4 השאלות |

---

## 8. Hero — Detailed Wireframe

```
DESKTOP (RTL — טקסט ימין, ויזואל שמאל):
┌───────────────────────────────┬──────────────────────────────┐
│  ● 270901 · מוכר ברשות המסים  │   "מה דורש אותך היום"        │
│                               │  ┌────────────────────────┐  │
│  H1: Dubiz מנהלת לך את         │  │ ● לקוח ממתין לתשובה     │  │
│  היום־יום של העסק —           │  │   3 ימים · [טיוטה מוכנה]│  │
│  ואתה נשאר עם ההחלטות         │  ├────────────────────────┤  │
│                               │  │ ● חשבונית #1042 פתוחה   │  │
│  support: עובדת על מה שכבר    │  │   ₪3,200 · [שליחת קישור]│  │
│  יש לך — וואטסאפ, מייל,       │  ├────────────────────────┤  │
│  וקבלות שאתה מצלם. בלי הקמה.  │  │ ● מסמך נקלט מוואטסאפ    │  │
│                               │  │   ספק+סכום זוהו·[אישור] │  │
│  [ התחילו עכשיו ] ראו איך זה │  └────────────────────────┘  │
└───────────────────────────────┴──────────────────────────────┘
```

- **Eyebrow:** אות אמון יחיד — `270901 · מוכר ברשות המסים`. (אם המיתוג ירצה "המזכירה של העסק" כ-eyebrow — אז ה-H1 נושא את התוצאה וה-eyebrow את התפקיד; לא שניהם אמון. **המלצה: eyebrow=אמון**, כי ה-H1 כבר עושה את התפקיד.)
- **H1:** *Dubiz מנהלת לך את היום־יום של העסק — ואתה נשאר עם ההחלטות.*
- **Support:** משפט מנגנון + חוסר-הקמה (משפט אחד במובייל).
- **CTA:** `[התחילו עכשיו]` primary + `ראו איך זה עובד` secondary (link-style). `כניסה למערכת` ב-header בלבד.
- **Trust cue:** ה-eyebrow. לא badge-wall.
- **Density:** נמוכה — הרבה נשימה, כרטיס אחד. זה רגע ה-clarity.
- **Content hierarchy:** H1 > CTA > support > eyebrow > כרטיס (הכרטיס הוא הוכחה חזותית, לא כותרת).

---

## 9. Sections 2–12 — Detailed Wireframes

> לכל סקשן: Purpose · Psychological job · Desktop · Mobile · Content-hierarchy · Density · Visual role · Product evidence · CTA · Transition · Product-Truth risk.

### 2 · PAIN — "בעל מקצוע שהפך לפקיד"
- **Purpose/Psych:** relevance — "זה בדיוק אני". מזיז מ"מי אתם" ל"הם מבינים אותי".
- **Desktop:** יחיד/רחב-מרוכז. שורת 5–6 אייקוני-עומס קומפקטיים (וואטסאפ · כסף · מסמכים · לקוחות · "בראש" · מערכות) בשורה אחת, מעל **שורת-מעבר אחת**. לא grid גדול.
- **Mobile:** 3–4 שורות טקסט קצרות + אייקונים בזוגות; לא wall-of-pain.
- **Hierarchy:** H2 ("פתחת עסק כדי לעבוד במקצוע שלך — לא כדי להיות המשרד של עצמך") > שורת-מעבר > אייקונים.
- **Density:** נמוכה-בינונית. **Visual role:** אילוסטרציית עומס מפוצל (Visual Grammar #2 "scattered"), **לא** צילום מסך.
- **Product evidence:** אין (סקשן רגשי). **CTA:** אין.
- **Transition:** "הבעיה אינה שחסרה עוד אפליקציה — חסר מי שמרכז את העבודה" → פותח את §3.
- **PT risk:** נמוך. אין claim מוצרי.

### 3 · SECRETARY / ROLE — reframe מרכזי
- **Purpose/Psych:** הופך מטאפורה למנגנון; משנה "עוד כלי" ל"מישהי שמחזיקה לי את זה".
- **Desktop:** **Visual Grammar #2+#3** בשלושה שלבים אופקיים (RTL, ימין→שמאל): `קלט מפוזר → תשומת-לב מסודרת → החלטת הבעלים`. טקסט-כותרת מעל, שלושת השלבים מתחת.
- **Mobile:** אותם שלושה שלבים **אנכית** (חץ כלפי מטה).
- **Hierarchy:** H2 ("מישהי שמחזיקה לך את העסק — ואת ההחלטות משאירה לך") > 3 שורות-עבודה (רואה/מכינה/מגישה) > microcopy.
- **Density:** בינונית. **Visual role:** דקדוק "scattered→organized→decision"; **לא** "כולל CRM+Billing".
- **Product evidence:** כרטיס-Attention (אותו primitive מה-Hero), מודגם.
- **CTA:** רך אופציונלי ("ראו איך זה עובד"). **Transition:** "הנה מי שלוקח את זה ממך" → מוביל לחוד הכסף.
- **PT risk:** **גבוה** — כאן מתפתה לומר "מזכירה בזמן". **אכיפה: Pull only.** ניסוח = "כשאתה נכנס, כבר מחכה מסודר".

### 4 · MONEY WEDGE — חוד 1
- **Purpose/Psych:** conversion — הכאב המדיד (מזומן תקוע). "הם פותרים את מה שהכי כואב בכיס."
- **Desktop:** מפוצל — טקסט(ימין) + **Business-State surface**(שמאל): רשימת גבייה עם תגי `פתוח / שולם / דורש טיפול`. מבוסס על מסך הגבייה האמיתי.
- **Mobile:** כותרת + state-stack אנכי (3 שורות) + CTA חוזר מתחת.
- **Hierarchy:** H2 ("עבודה שהסתיימה זה לא כסף שנכנס — Dubiz דואגת לחלק השני") > 3 state-items > microcopy "קישור תשלום בלחיצה".
- **Density:** בינונית-גבוהה (זה רגע ה"proof"). **Visual role:** Visual Grammar #4 "Business State" + #1 "Attention".
- **Product evidence:** מרכז הגבייה + קישורי תשלום (Tranzila/Cardcom/PayPal) — **קיים (A)**.
- **CTA:** משני ("התחילו עכשיו"). **Transition:** "וזה לא נגמר בכסף — יש עוד דברים שאסור שייפלו" → §5.
- **PT risk:** **גבוה** — אסור `מאחר X ימים`/aging/"רודפת אחרי החייבים". מותר `פתוח/שולם/דורש טיפול` + "שליחת קישור".

### 5 · NOTHING FALLS THROUGH — חוד 2
- **Purpose/Psych:** conversion רגשי — הקלת העומס המנטלי ("הראש שלי הוא לא מערכת ההפעלה").
- **Desktop:** יחיד-מרוכז או מפוצל-קל; **Attention-list** של "פתוח ודורש תשומת לב" (פנייה שלא נענתה · מסמך שנקלט · תשלום קבוע לבחור).
- **Mobile:** state-stack אנכי קצר.
- **Hierarchy:** H2 ("הראש שלך הוא לא מערכת ההפעלה של העסק — זה התפקיד של Dubiz") > 3 פריטי-Attention.
- **Density:** בינונית · breathing אחריו. **Visual role:** Visual Grammar #1 "Attention" (מסגור Pull).
- **Product evidence:** שיחות (מה עוד לא ענית) + התחייבויות (בחירה מרשימה, נראות בתדריך) — **קיים, בקופי Pull**.
- **CTA:** אין. **Transition:** "כל אלה — סביב עסק אחד" → §6.
- **PT risk:** גבוה — אסור "לעולם לא שוכחת" (מוחלט) / "מתריעה". מותר "לא מפוזר רק בזיכרון שלך".

### 6 · BREADTH WITHOUT DUMP — density peak
- **Purpose/Psych:** רוחב **אחרי** שהערך ברור; "מגניב, יש עוד" ולא "גנרי".
- **Desktop:** **לא 7 feature-cards.** גלריית **product-states מחוברת** סביב "עסק אחד": לקוחות · שיחות · מסמכים · חשבוניות · גבייה · מלאי/רכש · תמונת-מצב — כל אחד מסך-מובייל אמיתי + משפט-תוצאה. קומפוזיציה שמדגישה **חיבור לעסק אחד** (למשל טבעת/ציר סביב "העסק שלך"), לא רשת מנותקת.
- **Mobile:** **סקרול אופקי** מכוון — 4–5 מובילים (מסמכים · גבייה · שיחות · חשבונית · [עוד]).
- **Hierarchy:** H2 ("כל מה שהיום מפוזר בעשר מערכות — סביב עסק אחד") > גלריה > משפט-תוצאה לכל מסך.
- **Density:** **גבוהה (שיא)** — מוצדק: זה רגע "הרוחב". **Visual role:** מסכי-מובייל אמיתיים (נכס קיים) + Visual Grammar #4.
- **Product evidence:** המסכים הקיימים ב-`/landing/*` — **בקופי מתוקן (N)**.
- **CTA:** אין. **Transition:** מעורר "אבל אצטרך להעביר לשם הכול?" → §7 עונה.
- **PT risk:** בינוני — כרטיס-לקוח (B: לאמת שנשלח); התחייבויות/מלאי בקופי Pull; אין "התראות חכמות".

### 7 · ADD, DON'T REPLACE
- **Purpose/Psych:** מוריד את ההתנגדות החוסמת ("כבר יש לי דברים שעובדים").
- **Desktop:** יחיד-מרוכז, רגוע. אמירה + microcopy "כוללת חשבונית מוכרת מול רשות המסים". **בלי** logos/integration-arrows.
- **Mobile:** בלוק טקסט קצר + אות 270901.
- **Hierarchy:** H2 ("לא צריך להחליף כלום כדי להתחיל — מוסיפים את Dubiz") > support > 270901.
- **Density:** **נמוכה — breathing space מכוון** אחרי שיא §6. **Visual role:** רגוע; אולי "לצד מה שיש לך" (co-exist), לא sync.
- **Product evidence:** חשבונית תקינה + 270901 — **קיים (A)**.
- **CTA:** משני. **Transition:** "ואם נשארים — היא רק מכירה אותך יותר" → §8.
- **PT risk:** **גבוה** — אסור integration/sync arrows/logos. **coexistence בלבד.**

### 8 · OPERATIONAL MEMORY (חפיר, בשפת לקוח)
- **Purpose/Psych:** מעמיק העדפה — סיבה **להישאר**.
- **Desktop:** יחיד, מושגי, שקט. אולי מטאפורת "תמונה שנעשית פחות מפוזרת עם הזמן".
- **Mobile:** בלוק קצר.
- **Hierarchy:** H2 ("ככל שהיא איתך יותר, היא מכירה את העסק שלך יותר") > support רך.
- **Density:** **נמוכה · calm.** **Visual role:** מושגי — **לא** "learning engine"/גרפים.
- **Product evidence:** אין claim ספציפי. **CTA:** אין. **Transition:** "אבל אם היא מכירה כל-כך — מי בשליטה?" → §9.
- **PT risk:** **גבוה** — אסור "לומדת את ההתנהגות שלך" כ-engine. מותר "צוברת תמונה שימושית על העסק".

### 9 · CONTROL / AI-ANXIETY — differentiator
- **Purpose/Psych:** מנטרל "המערכת תעשה דברים בשמי". "מורידה עבודה בלי לקחת שליטה."
- **Desktop:** **Visual Grammar #3 "Owner Decision"** — פריט מוכן ע"י Dubiz + פקד `אישור/עצירה` של הבעלים. אולי מפוצל: "Dubiz מכינה" | "אתה מאשר".
- **Mobile:** אנכי — פריט-מוכן מעל, פקד-אישור מתחת.
- **Hierarchy:** H2 ("Dubiz עושה את העבודה — אתה מקבל את ההחלטות") > 4 המצבים בשפת-לקוח > microcopy "כל מילה של הבוט מאושרת לפני שיוצאת".
- **Density:** בינונית · clear. **Visual role:** human-approval; **לא** autopilot/agent.
- **Product evidence:** מסך גבולות/הפעלת הבוט (`bot-config.webp`) — **קיים (A)**.
- **CTA:** אין. **Transition:** "עכשיו כשברור שאתה בשליטה — אפשר לדבר אמון" → §10.
- **PT risk:** בינוני — אסור "פועלת לבד"/autonomous.

### 10 · TRUST + COMPLIANCE
- **Purpose/Psych:** לנטרל (לא למכור). *reason not to reject.*
- **Desktop:** **שתי עמודות מופרדות במפורש:** `[Compliance/Legal]` | `[Security/Privacy/Control]`. hierarchy, לא קיר-badges.
- **Mobile:** שני בלוקים; אם ארוך → אקורדיון.
- **Hierarchy:** H2 ("מסודר מול רשות המסים — ומסודר לרואה החשבון שלך") > עמודה-A (270901 · מספור רציף · מבנה אחיד) > עמודה-B (הנתונים שלך שלך · אתה מאשר לפני שמשהו יוצא).
- **Density:** נמוכה-בינונית · factual. **Visual role:** אות רישום + ניסוח עובדתי.
- **Product evidence:** 270901 (A) · חשבוניות/מבנה-אחיד (A). **מספרי הקצאה — `[CLAIM REQUIRES VERIFICATION]` (B, transport לא מאומת).**
- **CTA:** אין. **Transition:** "ואם עדיין לא מכירים אותנו — הנה למה בכל זאת" → §11.
- **PT risk:** **גבוה** — אסור להציג "מספרי הקצאה עובדים" כשנשלח; רק claims מוכחים.

### 11 · PROOF — **CURRENT → PROPOSED → WHY**
- **CURRENT (במסמך המסר):** "Social Proof" כסקשן עצמאי.
- **PROPOSED:** **לא band של testimonials/logos** (אין evidence). במקום — **closing proof-strip**: הוכחה **מצטברת** שכבר פזורה בדף (product-states אמיתיים §4/§6 · 270901 §10 · מודל שליטה §9), מסוכמת בשורה אחת רזה: "הוכחה במסכים אמיתיים, לא בהבטחות." אם/כאשר יהיו 3–5 לקוחות עם ציטוט+תוצאה+הרשאה — **כאן** ייכנס band אמיתי.
- **WHY:** להמציא social-proof = פסול (Owner Decision 4 + §N). הוכחת-מוצר/תאימות/שליטה כבר נבנתה לאורך הדף; band ריק/מזויף פוגע. שינוי **תוכן הסקשן**, לא **הסדר**.
- **Desktop/Mobile:** רצועה רזה יחידה. **Density:** נמוכה. **CTA:** אין (מוביל ישר ל-12).
- **PT risk:** **גבוה אם ממציאים** — כאן דווקא ה-guard.

### 12 · FINAL CTA
- **Purpose/Psych:** סוגר את הסיפור שנפתח ב-Hero (לא פותח חדש).
- **Desktop/Mobile:** יחיד-ממורכז. H2 emotional + one-liner + primary + reassurance.
- **Hierarchy:** H2 ("תפסיק להיות המשרד של העסק שלך") > one-liner (חוסר-הקמה) > `[התחילו עכשיו]` > reassurance קצר ("בלי הקמה · מתחילים ממה שכבר יש לך").
- **Density:** נמוכה · emotion↑. **Visual role:** נקי, נשימה.
- **Product evidence:** אין. **CTA:** primary. **PT risk:** אסור pricing claim לא-מאושר.

---

## 10. Visual Grammar (4 patterns בלבד — §23)

1. **Attention Item** — הפרימיטיב החתום: `מצב → למה חשוב → החלטה/פעולה שלך`. (Hero, §3, §5). **לעולם לא** "שלחתי/הזכרתי".
2. **Before → Organized** — מפוצל/מזווג: קלט מפוזר → משטח מסודר אחד. (§2, §3, §6).
3. **Owner Decision** — פריט-מוכן + פקד-אישור אנושי. (§3, §9).
4. **Business State** — קריאת-סטטוס שקטה `פתוח/שולם/דורש-טיפול`. (§4, §6, §8).

**כלל:** רק 4 האלה חוזרים לאורך הדף — כדי שיירגש **מוצר אחד, סיפור אחד**, לא 12 שפות ויזואליות.

---

## 11. Density / Rhythm Map (§24)

```
Hero        ▁ low   · emotion HIGH      (clarity, נשימה)
Pain        ▂ low-med· emotion HIGH      (recognition)
Secretary   ▃ med                        (reframe)
Money       ▅ med-high· conversion       (proof מדיד)  ← עלייה
Nothing     ▃ med    · breathing after
Breadth     ▇ HIGH (peak)                (הרוחב)       ← שיא
Add-Replace ▁ low    · reassurance        (breathing)  ← ירידה מכוונת
Memory      ▁ low    · calm
Control     ▃ med    · clear
Trust       ▂ low-med· factual
Proof       ▁ low
Final CTA   ▁ low    · emotion HIGH       (close)
```

**כוונה:** לא 12 סקשנים באותו משקל. עלייה הדרגתית לצפיפות-שיא ב-Breadth, ואז **ירידה מכוונת** (Add→Memory) לנשימה לפני העומק (Control/Trust) והסגירה. רגש גבוה בקצוות (Hero, Final), מדיד באמצע (Money).

---

## 12. CTA Placement Map

| מיקום | CTA | משקל |
|---|---|---|
| Header | כניסה למערכת | קישור-טקסט (existing user) |
| Hero | **התחילו עכשיו** + ראו איך זה עובד | primary + secondary |
| אחרי §4 (חודים) | התחילו עכשיו | primary חוזר (מובייל בעיקר) |
| §7 / §9 | התחילו עכשיו | משני, לא דוחק |
| Final §12 | **התחילו עכשיו** | primary סוגר |

**כלל:** primary אחד ויזואלית בכל viewport; "כניסה למערכת" לעולם לא מתחרה; אין ריבוי CTAs מתחרים באותו מסך.

---

## 13. Trust / Proof Architecture

- **שכבה 1 — Compliance/Legal (לא-לדחות):** 270901 (A, eyebrow + §10) · מספור רציף/מבנה-אחיד (A) · **מספרי הקצאה = `[CLAIM REQUIRES VERIFICATION]`** (B).
- **שכבה 2 — Security/Privacy/Control (לסמוך למסור כסף+וואטסאפ):** "הנתונים שלך שלך" · "אתה מאשר לפני שמשהו יוצא" · מודל השליטה (§9).
- **שכבה 3 — Proof-as-accumulation:** product-states אמיתיים לאורך §4/§6 + §11 closing-strip. **אין social-proof מומצא.**
- **כלל:** תאימות יורדת בדף (§10), לא פותחת. אמון בקיפול = אות בודד (270901).

---

## 14. Product Truth Guardrail Table (§25)

| Wireframe element | Claim implied | Truth status | Safe? | Required change |
|---|---|---|---|---|
| Hero attention card | "Dubiz כבר מיינה ומגישה לי מה שדורש טיפול" | A (Pull: תדריך/remaining-allocatable/OCR קיימים) | ✅ | להציג רק states קיימים; בלי "שלחתי/הזכרתי" |
| Attention card — "טיוטה מוכנה" | הבוט הכין טיוטה, אני מאשר | A | ✅ | בלי "ענה ללקוח לבד" |
| Attention card — "מסמך נקלט מוואטסאפ, זוהה" | OCR קלט+זיהה ספק/סכום | A | ✅ | Gmail = "גם", לא ראשי (B) |
| Money — פתוח/שולם/דורש-טיפול | רואים סטטוס תשלום ברמת חשבונית | A | ✅ | בלי "מאחר X ימים"/aging |
| Money — "מאחר / התיישנות" | aging/due-date | **C (חסר)** | ❌ | **להסיר** — אין תנאי-תשלום |
| Money — "רודפת אחרי החייבים" | תזכורת אוטומטית ללקוח | **C (אין push)** | ❌ | **להסיר** — רק "קישור בלחיצה" |
| Nothing-falls — "לעולם לא שוכחת / מתריעה בזמן" | scheduler/push | **C** | ❌ | "לא מפוזר רק בזיכרון שלך" (Pull) |
| Breadth — כרטיס לקוח | דף כרטיס-לקוח מלא בפרודקשן | **B (בבנייה)** | ⚠️ | לאמת שנשלח לפני הכתרה |
| Breadth — התחייבויות/מלאי "התראות חכמות" | push/alerts | **C** | ❌ | "רואים במבט אחד" (Pull) |
| Memory | "לומדת את ההתנהגות שלך" (engine) | ⚠️ | ⚠️ | "מכירה את העסק לאורך זמן" (בלי engine-claim) |
| Control — human approval | הבעלים מאשר לפני פעולה | A | ✅ | בלי autonomous/autopilot |
| Compliance — 270901 | רשום ומוכר | A | ✅ | ניסוח מדויק מהמסמך |
| Compliance — מספרי הקצאה | transport חי עובד | **B (לא מאומת)** | ⚠️ | `[CLAIM REQUIRES VERIFICATION]` |
| Add-don't-replace — sync/logos arrows | אינטגרציה עם המערכת הקיימת | **C (coexist בלבד)** | ❌ | "עובדת לצד מה שיש לך"; בלי arrows/logos |
| Final CTA — "בחינם"/מחיר | מודל מסחרי | ⚠️ (לא מאומת) | ⚠️ | בלי pricing עד Product-Truth |

> **כלל §25:** גם ויזואל בלי טקסט יוצר claim — חץ-sync, badge-"בזמן", clock-icon, live-dashboard — כולם נבדקו כאן ומוסרים אם מרמזים C.

---

## 15. RTL Requirements (§21 — RTL-first, לא "היפוך")

- **זרימת קריאה:** ימין→שמאל. בסקשנים מפוצלים — **טקסט ימין, ויזואל שמאל** (קבוע).
- **חצי-התקדמות (§3/§9):** מצביעים **שמאלה** (כיוון הקריאה). Before(ימין) → Organized(אמצע) → Decision(שמאל).
- **Timelines/state-lists:** מתחילים מימין.
- **Icon/text:** אייקון מוביל **מימין** לטקסט.
- **סקרול אופקי (§6 מובייל):** הפריט הראשון בימין, swipe שמאלה ל"עוד".
- **CTA:** primary מיושר לזרימה; במובייל מלא-רוחב (ניטרלי-כיוון).
- **מספרים/מטבע:** ₪ ומספרים נשארים קריאים ב-RTL (bidi) — לבדוק ב-visual, לא כאן.

---

## 16. Accessibility Requirements (רמת מבנה — §22)

- **Heading hierarchy:** H1 יחיד (Hero) · H2 לכל סקשן · H3 לפריטים בתוך סקשן. אין דילוגי-רמה.
- **Reading order = DOM order:** גם כשהויזואל בשמאל — ה-DOM = טקסט לפני/אחרי בסדר הגיוני; לא לסמוך על סדר-ויזואלי בלבד.
- **Semantic boundaries:** `<section>` per סקשן, `<header>/<main>/<footer>`, landmark-ים.
- **CTA clarity:** טקסט מפורש ("התחילו עכשיו"), לא אייקון-בלבד; מצב existing-user מובחן במילים.
- **אין מידע ויזואלי-בלבד:** כל state (פתוח/שולם/דורש-טיפול) עם **טקסט**, לא רק צבע/אייקון. כל אות-אמון עם טקסט.
- **Tap targets:** ≥44px, מרווח מספיק, thumb-reach לתחתית במובייל.
- **Product visuals = text equivalent:** לכל מסך-מוצר alt/caption שמסביר את התוצאה.
- **Animation-independent:** הדף מובן במלואו ללא אנימציה; אנימציה = קישוט בלבד; לכבד `prefers-reduced-motion` (visual-stage).

---

## 17. Implementation Risk Register (§26)

| רכיב | סיכון effort | המלצה |
|---|---|---|
| Hero attention-card | בינוני | **סטטי, curated, מייצג** — לא live-embed, לא personalized. זול ובטוח. |
| Product-screens gallery (§6) | **נמוך** | לשמש חוזר את המסכים הקיימים `/landing/*` — **רק לתקן קופי (N)**. אין fixtures חדשים. |
| Personalized/dynamic Hero | גבוה | **להימנע** — Hero סטטי. |
| Live dashboard embeds | גבוה | **להימנע** — מצבים סטטיים מייצגים. |
| אנימציות מורכבות | בינוני | להגביל ל-reveal/transition עדין; לא תלוי-הבנה. |
| מובייל אינטראקציות אופקיות (§6 swipe) | בינוני | סקרול-אופקי פשוט (CSS scroll-snap) — לא carousel מותאם-אישית. |
| Custom illustrations (§2 pain, §8 memory) | בינוני-גבוה | **הסיכון היקר האמיתי** — 2 אילוסטרציות מושגיות בלבד; לשקול iconography פשוט תחילה. |
| מספרי-הקצאה/כרטיס-לקוח screenshots | תלוי-מוצר | תלוי אימות (B) — לא לייצר fixtures מטעים. |

**סיכום:** רק שני פריטים דורשים effort אמיתי — **אילוסטרציות מושגיות** (§2/§8) ו**קומפוזיציית כרטיס-Attention** ב-Hero. כל השאר זול (שימוש-חוזר במסכים + layout).

---

## 18. Explicit Exclusions (מבני)

- אין Hero→Feature-Cards→Dashboard-Screenshot→Logos→CTA.
- אין 4/7 feature-cards גנריים.
- אין logos/integration-sync arrows (coexist בלבד).
- אין social-proof band מומצא.
- אין live-dashboard/personalized-hero.
- אין push/scheduler/clock/"בזמן"/"מסביב לשעון" בשום ויזואל.
- אין aging/"מאחר X ימים".
- אין badge-wall בקיפול.
- אין "כניסה למערכת" כ-primary.
- כל 11 המסרים האסורים (§8 מיצוב) + §N (מסר) — מחייבים.

---

## 19. Remaining Owner Decisions

*(קטנות; אינן חוסמות layout — ניתנות להכרעה במקביל ל-visual design.)*
1. **§11 Proof-fold** — מאשר את PROPOSED (closing proof-strip במקום social-proof band)? *(המלצתי: כן.)*
2. **Hero eyebrow** — 270901 (אמון) מול "המזכירה של העסק" (תפקיד). *(המלצתי: 270901.)*
3. **אות מחיר מתחת-לקיפול** — האם/כיצד לרמוז מחיר (תלוי מודל תמחור — Launch).
4. **כרטיס-לקוח בפרודקשן** — לאמת לפני הכתרתו ב-§6 (B).
5. **מספרי הקצאה** — אימות transport לפני ניסוח סופי ב-§10 (B).

---

## 20. Readiness Verdict

> **A — READY FOR VISUAL DESIGN.**

**נימוק:** ה-layout, ה-hierarchy, גבולות הסקשנים, מפת ה-density/rhythm, הדקדוק הויזואלי (4 patterns), מפות desktop/mobile, ה-above-the-fold, ה-RTL, הנגישות ברמת-מבנה, ומפת ה-CTA — **סגורים**. כל הכרעה מבנית שדרשה הכרעה (כולל §11 proof-fold) הוכרעה כאן עם CURRENT→PROPOSED→WHY. הפריטים ב-§19 הם **אימותי Product-Truth/Launch**, לא חוסמי-layout, וניתנים להכרעה במקביל ל-visual direction. אין structural/Product-Truth blocker שמונע התחלת visual design. ה-Product Truth guardrails (§14) + Hard Launch Gate (scheduler) **נשארים מחייבים** לכל שלב הבא.

**מבחן הכשל:** אם מוחקים את הלוגו — הדף עדיין מספר "בעל עסק שהיה המזכירה של עצמו ועכשיו כבר לא", דרך product-states אמיתיים ומסע-רגש, ולא feature-cards גנריים. ✅ עובר.

---

*מסמך wireframe מבני. אינו משנה קוד/עיצוב/DS/אתר ציבורי. כפוף למיצוב, למסר, ולחוזה ההתנהגות; כל רכיב כפוף ל-Product Truth (§14) ול-Hard Launch Gate (scheduler/push).*
