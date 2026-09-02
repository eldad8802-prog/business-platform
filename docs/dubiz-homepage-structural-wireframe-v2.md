# Dubiz — Homepage v1 · Structural Wireframe · Revision 2

> **מקור סמכות ראשי:** `docs/dubiz-homepage-story-reconciliation-v1.md` (הסיפור הקנוני בן 9 השלבים). בכל סתירה — **Reconciliation v1 wins.** המסמכים הישנים משמשים רק ל-PRESERVE/STILL-VALID/REFINE שה-Reconciliation סימן.
> **סוג:** מבנה עמוד implementation-ready — layout · hierarchy · density · section boundaries · responsive/RTL · a11y. **לא** final copy, **לא** CTA wording, **לא** pricing, **לא** visual redesign, **לא** קוד. סקיצות ASCII = סכמטיות בלבד.
> **תאריך:** 2026-08-16 · **main baseline:** `bd65eeb`.

---

## 1. Source Authority & OD1
- **סמכות:** Reconciliation v1 (סיפור) > Product Truth (עוקף claim) > חוזה-התנהגות > Positioning (אסטרטגיה) > Messaging/Wireframe-v1/Visual (מבצע, חלקי superseded).
- **OD1 (מאושר):** הדף פונה ל**בעל-עסק-מפעיל** — האדם שמחזיק **בפועל** את היום־יום, גם אם יש סביבו עובדים/ספקים/לקוחות. **מותר** להראות עסק בעל פעילות רחבה (לקוחות/ספקים/כסף/מסמכים/מלאי/שיחות). **אסור:** collaboration/team-workflow/roles/assignments/multi-user (לא קיים) · "לעסק של אדם אחד" כמיצוב · "לצוות שלך" כהבטחה. המראה (שלב 2) = בעל מקצוע שקיבל עליו **תפקיד תפעולי שלם**.
- **OD2 (defer):** אין pricing/free/trial/signup/demo/onboarding. CTA = placeholder `[PRIMARY CTA]` / `[SECONDARY CTA]`.
- **OD3 (defer):** R37 לא נפתר בקופי/section.

---

## 2. Six Page Laws (מחייבות מבנית)
1. **התנגדות צמודה** — נפתרת בתוך גלילה אחת מרגע יצירתה. *(אוכף את רצף 3→4.)*
2. **שארית** — כל שלב משאיר דבר אחד בראש.
3. **קניית-גלילה** — כל שלב קונה את הבא.
4. **טענה-הוכחה** — טענה קשה-להאמין מלווה מיד בדבר-נראה.
5. **בקשה יחידה** — `[PRIMARY CTA]` אחד; חזרות כן, פעולה שנייה מתחרה לא.
6. **חוקה** — הדף=חוויית-מוצר-ראשונה: בלי פחד/הגזמה/דחיפות-מלאכותית/הבטחת-מה-שאין.

---

## 3. Desktop Page Map (רצף + density + above-fold)

```
┌───────────────────────────────────────────────────────────────┐
│ HEADER  [כניסה למערכת ↩ · text]        לוגו Dubiz             │ RTL: לוגו ימין
├───────────────────────────────────────────────────────────────┤
│ 1 FOLD              ▓ first viewport ▓        Emotion↑ Density▁ │
│   [טקסט ימין] זיהוי+תוצאה+רמז-"בלי הקמה"  [Attention surface  │
│   ● 270901 (זרע-אמון)   [PRIMARY CTA][SECONDARY]  שמאל: "מה   │
│                                            כבר מסודר"]         │
├───────────────────────────────────────────────────────────────┤
│ 2 MIRROR "בעל מקצוע שהפך לפקיד"   ▓ EMOTIONAL PEAK ▓  Density▂ │
│   הצטברות: לקוחות→הודעות→מסמכים→כסף→פתוחים→לזכור (בלי מוצר)   │
├───────────────────────────────────────────────────────────────┤
│ 3 MECHANISM / DIFFERENCE          Density▃  (רגע הבידול)       │
│   קליטה: וואטסאפ · מייל · צילום → בלי הקמה/הזנה  [מיקרו-הוכחה] │
│   ╎ (יוצר את פחד הפרטיות — נצמד ל-4, אין section ביניהם)      │
├───────────────────────────────────────────────────────────────┤
│ 4 SAFETY / CONTROL / PRIVACY      Density▁  קצר, לא-הגנתי      │
│   מה נקרא/מה לא · המידע שלך שלך · שום דבר לא יוצא בלי אישורך  │
├───────────────────────────────────────────────────────────────┤
│ 5 PROOF "קיים ועובד"              Density▅  קונקרטי           │
│   מסכי-עבודה אמיתיים (כרטיס-לקוח A · גבייה פתוח/שולם) [PRIMARY]│
├───────────────────────────────────────────────────────────────┤
│ 6 LEGITIMACY מס/רו"ח              Density▂  factual            │
│   270901 · מוכר · מסודר-לרו"ח (עובדה קצרה, לא הבטחה גורפת)    │
├───────────────────────────────────────────────────────────────┤
│ 7 SELF-PROJECTION "השבוע שלך"     Density▂  Emotion↑           │
│   "פחות דברים להחזיק בראש" — רוחב כ-evidence, לא קטלוג        │
├───────────────────────────────────────────────────────────────┤
│ 8 THE ASK                         Density▁  focused            │
│   הסרת-סיכון · בלי הקמה · יציאה-עם-הנתונים · [PRIMARY CTA]    │
├───────────────────────────────────────────────────────────────┤
│ 9 TAIL — כנות Q&A (accordion)     Density▁                     │
│   רו"ח · המשכיות · "יש לי Morning"(מוסיפים) · צוות="עדיין אין"│
├───────────────────────────────────────────────────────────────┤
│ FOOTER  ניווט · משפטי · 270901 · כניסה למערכת · יצירת קשר    │
└───────────────────────────────────────────────────────────────┘
```
**Above-fold (Desktop):** eyebrow(270901 זרע) · H1-role(placeholder) · support(רמז-הקמה, שורה) · `[PRIMARY CTA]` + `[SECONDARY CTA]` · header "כניסה" · חלק מ-Attention surface. עונה: מה-זה-נותן · בשבילי · סיבה-להמשיך. **לא** בידול-מלא, **לא** feature-list, **לא** דמות.

## 4. Mobile Page Map (עצמאי)

```
┌─────────────────────┐
│ HEADER לוגו·[כניסה]  │
├─────────────────────┤
│ ▓ FIRST VIEWPORT ▓  │
│ ● 270901 (זרע)      │
│ H1-role (≤2–3)      │
│ support (משפט)      │
│ [ PRIMARY CTA ] full│ ← thumb-reach
│ [SECONDARY] link    │
├─────────────────────┤ ← קיפול ≈ כאן
│ Attention surface   │ ← "מה כבר מסודר" (1–2 items)
├─────────────────────┤
│ 2 MIRROR (הצטברות   │ ← אנכי, בונה; לא 3 cards; מספיק מקום
│   אנכית, 5–6 שלבים) │
├─────────────────────┤
│ 3 MECHANISM         │ ← 3 ערוצי-קליטה + מיקרו-הוכחה
│ 4 SAFETY (מיד,קצר)  │ ← נצמד ל-3, אין דבר ביניהם
├─────────────────────┤
│ [ PRIMARY CTA ] full│ ← חוזר אחרי הבידול+ביטחון
├─────────────────────┤
│ 5 PROOF (→→ swipe)  │ ← סקרול-אופקי מסכי-עבודה, מימין
│ 6 LEGITIMACY        │
│ 7 SELF-PROJECTION   │
│ 8 THE ASK [PRIMARY] │
│ 9 TAIL (accordion)  │
└─────────────────────┘
```
**Mobile חובה:** H1 לא נשבר ל-4 שורות; support=משפט; `[PRIMARY CTA]` גלוי בקיפול + אחרי 3/4 + בשלב 8; שלב 4 **קצר**; שלב 5 סקרול-אופקי (scroll-snap, מימין) 3–4 מסכים לא-אינסופי; שלב 9 accordion; אין horizontal-overflow לא-מכוון; Adjacent-Objection (3→4) נשמר בגלילה.

---

## 5. Nine Stages — Detailed Structure

> לכל שלב: Job · Thought-in · Thought-out · Hierarchy · Blocks · Surface/Visual · Proof · Objection-created · Objection-resolved · CTA · PT-constraints · Desktop · Mobile.

### 1 · FOLD — התמצאות+זיהוי
- **Job:** לקנות את 5 השניות הבאות. **In:** "מה זה, בשבילי?" **Out:** "רגע — זה מדבר על העסק שלי, ולא ידרוש הקמה."
- **Hierarchy:** H1-role(placeholder) > `[PRIMARY CTA]` > support(רמז-הקמה) > eyebrow(270901 זרע) > Attention surface.
- **Blocks:** eyebrow-trust · H1 · support(שורה) · CTA-pair · Attention surface.
- **Surface/Visual:** **Attention surface "מה כבר מסודר"** (Visual-primitive Attention) — מראה שמשהו **כבר מוין** לפני שנכנס. **STILL VALID** ובלבד שאינו מחזיר דמות: מציג **מצבים** (`מצב→למה חשוב→פעולה שלך`), לא "מזכירה עשתה". *(§7 בודק את זה.)*
- **Proof:** זרע-אמון בלבד (270901). **Objection-created:** — . **Resolved:** "לא הבנתי" + "בשבילי?" + "פרויקט?".
- **CTA:** `[PRIMARY]` + `[SECONDARY]` (זמין, לא נדחף). **PT:** בלי דמות/AI-כותרת/feature-list/שתי-פעולות/קטגוריה.
- **Desktop:** split טקסט-ימין/surface-שמאל. **Mobile:** טקסט→CTA→surface מתחת-לקיפול.

### 2 · MIRROR — היום שלו (EMOTIONAL PEAK)
- **Job:** "זה בדיוק אני" + הקלה-מאשמה. **In:** "מאיפה הם יודעים?" **Out:** "נפל עליי תפקיד, אני לא בלגניסט."
- **Hierarchy:** H2 > מבנה-הצטברות > microcopy-הקלה.
- **Blocks:** **מבנה הצטברות** (לא 3 pain-cards): לקוחות → הודעות → מסמכים → כסף → דברים פתוחים → דברים לזכור — כרצף/ערמה שגדלה.
- **Surface/Visual:** אילוסטרציה מושגית של עומס-מצטבר (Visual §2 STILL VALID); **בלי מוצר, בלי screenshot.**
- **Proof:** קונקרטיות (ארנונה, ספק שמחכה, לקוח שלא חזר) — לא "אתגרי ניהול". **Objection-created:** — . **Resolved:** "כולם אומרים שמבינים עסקים קטנים" (רק בקונקרטיות).
- **CTA:** אין (לא קוטעים הזדהות). **PT:** לא-אשם, לא-הפחדה ("מפסיד אלפי ₪"), לא-מכירה, לא-ארוך-מדי, **OD1:** בעל-מפעיל (לא freelancer, לא מנהל-צוות).
- **Desktop:** יחיד-רחב-מרוכז, מקום נדיב. **Mobile:** אנכי, 5–6 שלבי-הצטברות קצרים.

### 3 · MECHANISM / DIFFERENCE — הבידול הנראה
- **Job:** להפוך הבטחה למאמינה; רגע-הבידול-היחיד. **In:** "לא אתחיל להזין דברים." **Out:** "אה — זה עובד אחרת."
- **Hierarchy:** H2 > 3 ערוצי-קליטה > **מיקרו-הוכחה נראית**.
- **Blocks:** **רוחב-קליטה** — וואטסאפ · מייל · צילום → **בלי הקמה, בלי הזנה, בלי העברת-נתונים** + מיקרו-הוכחה (Attention/OCR-state).
- **Surface/Visual:** Before→Organized (Visual-primitive): קלט-מפוזר → משטח-מסודר. **בלי sync-arrows/logos-רחבים/realtime.**
- **Proof:** מיקרו-הוכחה מיידית (חוק טענה-הוכחה). **Objection-created:** **"אתם קוראים לי את הוואטסאפ?"** → **חייב שלב 4 מיד.** **Resolved:** "כמה עבודה זה ידרוש."
- **CTA:** אין (זורם ל-4). **PT:** בלי טכנולוגיה/OCR/מודלים · בלי "אינטגרציות" · בלי "אוטומטי לחלוטין" · Gmail=**B** (מוביל בוואטסאפ+צילום=A) · **לא להישאר לבד.**
- **Desktop:** split טקסט/Before→Organized. **Mobile:** 3 ערוצים + מיקרו-הוכחה; **נצמד ל-4.**

### 4 · SAFETY / CONTROL / PRIVACY — ההתנגדות שיצרנו (Adjacent)
- **Job:** להציל את שלב 3; היחיד שבו שליטה מופיעה — **כביטחון**. **In:** "רגע. אתם קוראים לי את הוואטסאפ?" **Out:** "שום דבר לא יוצא בלעדיי. אני עדיין בעל-הבית."
- **Hierarchy:** H2 > 3 תשובות (מה-נקרא/מה-לא · שלך-שלך · אישור-לפני-יציאה) > microcopy.
- **Blocks:** capability→concern→control, קצר.
- **Surface/Visual:** Owner-Decision primitive (פריט-מוכן + אישור-אנושי). **בלי** privacy-footer/legal-wall.
- **Proof:** בהירות (מה נקרא/לא). **Objection-created:** — . **Resolved:** פחד-הוואטסאפ (R27).
- **CTA:** אין. **PT:** **לא** "אנחנו לא מחליטים במקומך" (מכירת-מגבלה) → תמיד *"מה לא יקרה בלעדיך"* · לא-הגנתי · לא-ז'רגון-משפטי · **קצר** (אורך=חשד).
- **Desktop:** מפוצל "Dubiz מכינה | אתה מאשר". **Mobile:** אנכי, קצר מאוד.

### 5 · PROOF — קיים ועובד
- **Job:** אמינות→אמונה; לענות פרדוקס-השקט (להראות **עבודה מתבצעת**). **In:** "תראו לי." **Out:** "זה לא מצגת — זה עובד."
- **Hierarchy:** H2 > מסכי-עבודה אמיתיים + משפט-תוצאה לכל אחד.
- **Blocks:** מסכי-מובייל אמיתיים (Business-State primitive): **כרטיס-לקוח מרוכז (A)** · גבייה **פתוח/שולם (A)** · קליטת-מסמך (A).
- **Surface/Visual:** מסכים אמיתיים; מה שמוכיח = **מה קרה בהם**, לא "עיצוב יפה". סקרול-אופקי במובייל.
- **Proof:** גוף-ההוכחה. **Objection-created:** — . **Resolved:** "הכול יפה במצגת."
- **CTA:** `[PRIMARY]` (משני, אחרי שהוא כבר מאמין). **PT:** **בלי תזכורות-יזומות (C)** · בלי aging/"מי מאחר"(C) · **בלי קטלוג-פיצ'רים** · בלי הוכחה-חברתית-מומצאת(C).
- **Desktop:** גלריית-עבודה 2–3 מסכים בולטים. **Mobile:** swipe אופקי מימין.

### 6 · LEGITIMACY — מס/רו"ח (Trust body)
- **Job:** רישיון-לפעול; הסרת-סיכון בירוקרטי. **In:** "מוכר ברשות המסים? מה רו"ח יגיד?" **Out:** "מוכר, מסודר, אני לא צריך להבין בזה."
- **Hierarchy:** H2 > 270901 + מוכר + מסודר-לרו"ח (עובדות קצרות).
- **Blocks:** Compliance/Legal (קצר) — **לא badge-wall.**
- **Surface/Visual:** typography + אות-270901 עדין. **Proof:** 270901(A). **Objection-created:** — . **Resolved:** פחד-בירוקרטי + "מי אתם" (חלקית).
- **CTA:** אין. **PT:** **הבטחת-תקינות-גורפת = C (R44)** — רק "רישום/פורמט/ייצוא" · מספרי-הקצאה-live=**C** · לא-מוקדם-מדי.
- **Desktop:** בלוק factual רגוע. **Mobile:** קצר / accordion אם ארוך.

### 7 · SELF-PROJECTION — השבוע שלו
- **Job:** פונקציונלי→רגשי; כאן מתה "בשביל מה אני צריך אותה" (R25). **In:** "מה זה ישנה לי בפועל?" **Out:** "אני כבר מרגיש איך נראה השבוע שלי בלי להחזיק את זה בראש."
- **Hierarchy:** H2 > "פחות דברים להחזיק בראש" > רוחב **כ-evidence**.
- **Blocks:** רוחב-המוצר כהמחשת-הקלה (לקוחות/כסף/מסמכים/מלאי/שיחות) — **לא** "CRM+Inventory+Billing+Inbox".
- **Surface/Visual:** Business-State רגוע / illustration מושגית מינימלית. **Proof:** קונקרטיות-הקלה. **Objection-created:** — . **Resolved:** "עוד כלי שאשכח בשבועיים."
- **CTA:** אופציונלי רך. **PT:** בלי "תרוויח יותר"/שינוי-חיים · בלי מופשט ("שקט נפשי") · בלי feature-dump · **הקטגוריות=evidence לא סיפור.**
- **Desktop:** יחיד/רך. **Mobile:** קצר.

### 8 · THE ASK — הסרת-סיכון+בקשה
- **Job:** להמיר ע"י הורדת-מחיר-הכניסה. **In:** "כמה עולה, כמה קשה לצאת." **Out:** "צעד קטן — אני מנסה דבר אחד."
- **Hierarchy:** H2 > one-liner > `[PRIMARY CTA]` > reassurance (בלי-הקמה · יציאה-עם-נתונים).
- **Blocks:** הסרת-סיכון (מה-קורה-בדקות-הראשונות · יציאה-עם-הנתונים) + CTA.
- **Surface/Visual:** נקי, focused. **Proof:** — . **Objection-created:** — . **Resolved:** מחיר/התחייבות/"מה אם לא יתאים"/"כמה זמן".
- **CTA:** `[PRIMARY CTA]` (אירוע-ההמרה). **PT:** **בלי דחיפות-מלאכותית** · **בלי pricing/free לא-מוכרע (OD2)** · בלי demo/שיחת-מכירה כפעולה-ראשית · פעולה-אחת · *(טבע-הפעולה=OD2, pre-copy).*
- **Desktop/Mobile:** יחיד-ממורכז; מובייל CTA מלא-רוחב thumb-reach.

### 9 · TAIL — כנות
- **Job:** לתפוס משוכנע-שנתקע-בפרט. **In:** "רגע, ומה עם…" **Out:** "קיבלתי תשובה ישרה."
- **Hierarchy:** H2 > accordion שאלות.
- **Blocks:** accordion: רו"ח · המשכיות · **"יש לי Morning" → מוסיפים-לא-מחליפים** · **גישת-צוות → "עדיין אין" (OD1, כנה)** · ייצוא-נתונים.
- **Surface/Visual:** accordion טקסטואלי. **Proof:** כנות. **Objection-created:** — . **Resolved:** ההתנגדויות המשניות.
- **CTA:** אין (או קישור רך). **PT:** **כנות לא-שכנוע** · **צוות=C** (לא להבטיח) · לא-להתחמק (תשובה חמקנית מבטלת שלב 4) · לא-ארוך.
- **Desktop/Mobile:** accordion (a11y — §9).

---

## 6. Product Truth Matrix (בתוך ה-wireframe)
| Surface/claim (שלב) | דירוג | הערה |
|---|---|---|
| רוחב-קליטה וואטסאפ/צילום (3) | **A** | הבידול הנראה |
| Gmail (3) | **B** | gated; מוביל בוואטסאפ |
| כרטיס-לקוח מרוכז (5) | **A** | **שודרג** — `customers/[id]` קיים |
| גבייה פתוח/שולם + קישורי-תשלום (5) | **A** | בלי aging |
| קליטת-מסמך/OCR-state (1,3,5) | **A** | Pull |
| בוט-טיוטות-שמאשרים (4) | **A** | human-approval |
| 270901 רישום (1,6) | **A** | לא הבטחה-גורפת |
| זיכרון-לאורך-זמן (7, רך) | **B** | לא engine-claim |
| **scheduler / "בדיוק בזמן" / התראות-יזומות / "התראות חכמות"** | **C — DO NOT USE** | Notification=0 |
| **aging / "מי מאחר" / due-date** | **C** | חסר |
| **מספרי-הקצאה live** | **C** | transport לא מאומת |
| **multi-user / team / roles** | **C** | מוצר חד-משתמש |
| **"מסביב לשעון"** | **C** | 24/7 לא מאומת |
| **הוכחה-חברתית** | **C** | אין; לא להמציא |
| **מחיר / חינם** | **C** | OD2 defer |
| sync/integrations arrows | **C** | coexistence בלבד |

## 7. Visual Spec — REUSE / ADAPT / DROP
- **REUSE:** DS v1 warm (cream/teal/Heebo/status-חם-לא-אדום; נחת ב-main) · Attention primitive · 4 primitives · CTA-יחיד · RTL rules · a11y-structure · mobile horizontal-scroll (שלב5) · accordion (6/9).
- **ADAPT:** visual-thesis → הסר "מישהו"/דמות, שמור "העבודה כבר מסודרת כשנכנסת" (מראה-עבודה, R26) · breadth → קליטה(3)/הוכחת-עבודה(5)/רוחב-כ-evidence(7), **אין קטלוג** · trust-composition → זרע(1)/פרטיות(4)/לגיטימציה(6).
- **DROP:** memory-as-differentiation illustration (Visual §8) · "מזכירה" H1/persona · מבנה-12-סקשן.
- **אין** palette/typography/card/shadow/illustration **חדשים.**

## 8. Density / Rhythm Map
```
1 Fold          ▁ low   · emotion↑        (clarity)
2 Mirror        ▂ low-med· EMOTIONAL PEAK  (recognition) ← שיא-רגש, נשימה
3 Mechanism     ▃ med    · proof-micro     (difference)
4 Safety        ▁ low    · short/calm      (fear→relief)
5 Proof         ▅ med-HIGH· concrete       (belief)      ← שיא-צפיפות
6 Legitimacy    ▂ low-med· factual         (license)
7 Self-Project  ▂ low    · emotion↑        (desire)
8 Ask           ▁ low    · focused         (convert)     ← שקט לפני הבקשה
9 Tail          ▁ low    · honest
```
רגש גבוה ב-2 ו-7; צפיפות-הוכחה ב-5; **שקט מכוון לפני 8**. לא כל 9 באותו משקל.

## 9. Implementation Units (per stage)
| שלב | יחידה |
|---|---|
| 1 Fold | **composition** (existing PrimaryCta + Attention composition) + **fixture** (Attention items curated סטטיים) |
| 2 Mirror | **new** אילוסטרציה מושגית מינימלית (icon-based) + composition |
| 3 Mechanism | **composition** (Before→Organized) + **fixture** (מיקרו-הוכחה) |
| 4 Safety | **composition** (Owner-Decision) — reuse bot-config surface אם מתאים |
| 5 Proof | **reuse** מסכי `/landing/*` (קופי מתוקן) + **fixture** (כרטיס-לקוח אמיתי/placeholder) |
| 6 Legitimacy | **composition** (typography + 270901 cue) |
| 7 Self-Projection | **composition** (Business-State) / illustration מינימלית |
| 8 Ask | **reuse** PrimaryCta (placeholder wording) |
| 9 Tail | **new/adapt** accordion (a11y) |
> effort אמיתי: 1–2 אילוסטרציות מושגיות (2,7) + קומפוזיציית Attention (1). השאר reuse/composition. **אין** מערכת-מוצר חדשה נדרשת.

## 10. Accessibility Structure (נעול מבנית)
- **Heading:** H1 יחיד (Fold) · H2/שלב · H3/פריט. אין דילוגי-רמה.
- **Landmarks:** `<header>/<main>/<footer>`, `<section>` per שלב, reading-order=DOM (גם כשויזואל בשמאל).
- **CTA semantics:** טקסט מפורש (placeholder), לא אייקון-בלבד; existing-user נבדל במילים.
- **Accordion (6/9):** button+aria-expanded+region; פתיח-במקלדת.
- **Horizontal content (5 mobile):** נגיש-מקלדת, focus-order הגיוני, לא lock-scroll.
- **Keyboard:** סדר לוגי; focus-visible (ring DS v1).
- **Mobile reading order:** Adjacent-Objection (3→4) נשמר ב-DO;.
- **Reduced-motion:** הבנה מלאה ללא אנימציה.
- **אין מידע בצבע-בלבד:** כל status עם טקסט.

## 11. Remaining Blockers
- **Structural:** אין. המבנה שלם.
- **Non-structural (pre-copy, כבר-נדחו):** OD2 מחיר+טבע-פעולה (חוסם קופי שלב 8) · OD3 R37 (מחקר) · 3 הפרות-הקופי הקיימות (הסרה ב-v1). אף אחד אינו חוסם מבנה/wireframe.

## 12. Supersession
> **`dubiz-homepage-structural-wireframe-v2.md` supersedes the structural decisions of `dubiz-homepage-structural-wireframe-v1.md` wherever they conflict** — במיוחד מבנה-12-הסקשן, מיקום-Hero של "מזכירה"/שליטה, ותזמון-Trust.
> **נשמר מ-v1** (ו-Reconciliation אישר): 4 primitives · RTL rules · accessibility-structure · Attention-Card · density-כעיקרון. **נשמר מ-Visual-Spec:** DS v1 warm, REUSE-פריטים (§7).

## 13. Readiness Verdict
> **A — STRUCTURE READY FOR PRE-COPY.**

תשעת השלבים ממומשים למבנה עמוד עם hierarchy, blocks, density/rhythm, desktop/mobile maps, PT-matrix, a11y ו-implementation-units. אין structural blocker (OD1 הוכרע; המבנה שלם). הפריטים הנותרים (OD2 מחיר+פעולה · OD3 · הסרת-קופי) הם **non-structural, נדחו במפורש ל-pre-copy**, וחוסמים **קופי בלבד**. לכן מוכן לשער ה-pre-copy.

## 14. Exact Next Recommended Stage
**Pre-Copy Gate** — לסגור OD2 (מודל-מחיר + טבע-הפעולה-הראשונה) ו-OD3 (סיכום-מחקר R37 אם קיים), ולנעול את רשימת-הסרת-הקופי; **ואז** Homepage v1 Copywriting על בסיס המבנה הזה. *(Visual direction כבר REUSE — DS v1 warm; אין שלב-עיצוב חדש נדרש לפני copy.)*

---

*Structural Wireframe v2. אינו קוד/עיצוב/קופי. Supersedes v1 (§12). כפוף ל-Reconciliation v1, Product Truth, וחוזה-ההתנהגות.*
