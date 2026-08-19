# Inventory — Audit Remediation Plan v1 (תכנון בלבד — אין יישום)

**סטטוס:** טיוטה לאישור · אין לבצע commit / push / merge / deploy / שינוי קוד / schema / DB.
**מטרה:** סבב תיקונים **אחד** שמכסה את כל 15 הליקויים, עם מינימום שינויים כפולים ומינימום סיכון לרגרסיה.
**תאריך:** 2026-06-26

---

## 0. עקרונות עבודה לסבב

1. **תשתית לפני יישום נקודתי.** שלושה ליקויים (9 הצגת שגיאה ליד שדה, 11 Feedback להצלחה, 2 הסבר לחסימה) הם *דפוס משותף* לכל הטפסים. נבנה primitive אחד ל-field-error + success-confirmation, ואז נחיל אותו על כל הטפסים — במקום לתקן כל טופס בנפרד.
2. **קיבוץ לפי קובץ.** ליקויים שנוגעים באותו קובץ מטופלים יחד (למשל 3+4 ב-`product-detail-view.tsx`, 1+2+9+11 בגיליונות התנועה).
3. **Server ↔ Client במכה אחת.** כל ולידציה עסקית (2,4,12) מתוקנת *גם* בלקוח (UX) *וגם* בשרת (אמת), כדי לא לחזור לאותם קבצים פעמיים.
4. **לא חורגים מההיקף.** אין Inventory Movements גלובלי, אין תמיכה באלפי מוצרים, אין Retail מתקדם, אין Expiration, אין פיצ'רים חדשים. כל מקום שבו תיקון "נשען" על אחד מאלה — מסומן כשאלה פתוחה, לא מיושם.

---

## 1. הבנת הממצאים — אישור + נקודות לא חד־משמעיות

| # | ממצא | ברור? | הערה |
|---|------|-------|------|
| 1 | Bottom Sheets חופפים ל-Bottom Nav | ✅ עם דיוק | הגיליונות עצמם (`movement-sheet`, edit) כבר משתמשים ב-`env(safe-area-inset-bottom)` ו-z-index 201 מעל הנאב (100). **המוקדים האמיתיים:** (א) מודאל היציאה של הוויזארד ב-z-index **60** — *מתחת* לנאב (100), כלומר מוסתר חלקית; (ב) לאמת ש-`inv-bottombar` (BottomActionBar) לא מתנגש; (ג) במכשירים ללא notch (safe-area=0) ה-padding 30px עלול להיות צמוד מדי. ראה §2.1. |
| 2 | חסימת מלאי שלילי ללא Feedback | ✅ | `movement-sheet.tsx:78` מחשב `invalid = after<0` ומשבית כפתור — בלי טקסט. צריך הודעה מסבירה. |
| 3 | עריכת מוצר חלקית (ספק/קטגוריה) | ✅ | אישור: ב-edit (`product-detail-view.tsx:330-352`) אין שדות ספק/קטגוריה; ה-PATCH (`items/[id]/route.ts:175-186`) לא מקבל `supplierName`; ה-API client (`lib/api/inventory.ts`) מקבל `categoryId` אך לא `supplierName`. |
| 4 | ולידציות עסקיות חסרות | ⚠️ חלקית | חסר: כמות התחלתית שלילית (קיים בלקוח, חסר בשרת? — נאמת), אין ולידציית יחס בין `reorderPoint`↔`minimumQuantity`. **מחיר<עלות מוסכם שלא משנים.** שאלה פתוחה Q1. |
| 5 | ספקים/קטגוריות בטקסט חופשי | ✅ עם הסתייגות | קטגוריה: datalist + dedup case-insensitive (חלש). ספק: input חופשי לגמרי, לא עובר דרך `supplier-identity-learning.service`. **תיקון מלא = חיבור לדומיין הספקים — חורג מהיקף.** ראה §2.5 + Q2. |
| 6 | Purchase Wizard לחיצה כפולה | ⚠️ לחקור | מועמדי שורש: `ctaDisabled={!canSubmit}` שתלוי ב-`actionLoading`/state שעדיין לא מוכן בפיינט הראשון; effect של `persistDraft` שרץ על כל שינוי `order` וגורם re-render; `queueMicrotask(load)` בניווט. צריך לאתר במדויק בסבב. |
| 7 | Discoverability (כל המוצרים / מרכז הרכש) | ✅ | בית המלאי (`app/(shell)/inventory/page.tsx`) מגיע ל-`/inventory/items` רק דרך כפתור הסריקה/אריח "שווי מלאי". אין כניסה ל"מרכז רכש" (רק "הזמנה מספק" → new). `InventoryBottomNav` מושבת (`return null`). |
| 8 | Product Card — מה מציגים | ⚠️ מוצר | שאלת מוצר. בנוסף: צריך לאמת **היכן** `inventory-item-card.tsx` בשימוש בפועל (הבית משתמש ב-`InventoryProductRow`, לא בכרטיס). Q3. |
| 9 | שגיאות לא ליד השדה | ✅ | כל הטפסים מציגים שגיאה ברמת-טופס (תחתית), לא inline. דורש primitive משותף. |
| 10 | שמות ארוכים | ✅ | בכרטיס (`inventory-item-card.tsx:107-116`) אין ellipsis → גלישה. בשורות יש `text-overflow:ellipsis`. |
| 11 | Feedback להצלחה | ✅ | קיים inline ירוק בחלק מהטפסים; גיליון התנועה נסגר ללא אישור. אין toast מערכתי. |
| 12 | Threshold logic vs ניסוח | ✅ | הלוגיקה `<=` (`inventory-design.tsx:806,809`; `inventory.service.ts`), הניסוח "מתחת לזה". כשכמות == סף כבר מסומן קריטי/נמוך, בניגוד למשתמע מ"מתחת". יישור ניסוח↔לוגיקה. Q4. |
| 13 | ניסוחים לא טבעיים | ✅ | "נזק או קלקול", "ללא מחיר", "מתחת לזה —", "ספק:" כתחילית מיותרת בתג. |
| 14 | 404 לא ממותג | ✅ | אין `app/not-found.tsx` כלל. ברירת מחדל של Next. |
| 15 | Hydration | ✅ | `app/(shell)/inventory/page.tsx:122` `new Date().getHours()` ב-`useMemo([])` → SSR≠client. `inventory-movements-list.tsx:50` `toLocaleString` ללא `"use client"`. |

---

## 2. תוכנית ביצוע (מקובצת לאצוות לפי קוד משותף)

> סדר הביצוע מתוכנן כך שתשתית משותפת נבנית פעם אחת ואז מוחלת. תלות מסומנת.

### Batch A — תשתית טפסים: שגיאות inline + Feedback הצלחה + הסבר חסימה
**מכסה ליקויים: 2, 9, 11** (+ תשתית ש-Batch B נשען עליה)

- **גישה:**
  1. הוספת primitive `inv-field__error` (טקסט אדום מתחת לשדה) + תמיכה ב-`aria-invalid` ל-`inv-field`. CSS ב-`inventory-foundation.css.ts`.
  2. הוספת primitive Feedback אחיד להצלחה (אפשרות מועדפת: toast קליל מערכתי קיים אם יש; אחרת שדרוג ה-success-box הקיים לאחיד + auto-dismiss). **Q5 — האם מותר להוסיף toast?**
  3. **חסימת מלאי שלילי (2):** ב-`movement-sheet.tsx` להחליף "כפתור מושבת בשקט" בהודעה: כשהפעולה תוריד מתחת ל-0 — להציג טקסט מסביר ליד שדה הכמות + Highlight, ולא להסתמך על disable שקט.
- **קבצים:** `inventory-foundation.css.ts`, `inventory-primitives.css.ts`, `movement-sheet.tsx`, `movement-modal.tsx`, `inventory-movement-form.tsx`.
- **תלות:** **קודם** Batch B/C (שמשתמשים באותו primitive). אין תלות הפוכה.

### Batch B — טופס מוצר: עריכת ספק/קטגוריה + ולידציות עסקיות
**מכסה ליקויים: 3, 4, 12 (חלק ולידציה)**

- **גישה:**
  - **(3)** הוספת שדות ספק + קטגוריה ל-edit sheet (`product-detail-view.tsx`), הרחבת `updateInventoryItem` (`lib/api/inventory.ts`) ל-`supplierName`, הרחבת PATCH (`items/[id]/route.ts:175-186`) + שכבת ה-service לקבל ולשמור `supplierName` ו-`categoryId`. שימוש חוזר באותו רכיב קלט כמו ב-create (DRY).
  - **(4)** ולידציה צולבת: `reorderPoint ≥ minimumQuantity` (או ההפך — Q1), חסימת כמות התחלתית שלילית בשרת אם חסר. גם בלקוח (הודעת `inv-field__error` מ-Batch A) וגם ב-`inventory.service.ts`.
- **קבצים:** `product-detail-view.tsx`, `app/(shell)/inventory/items/create/page.tsx`, `lib/api/inventory.ts`, `app/api/inventory/items/[id]/route.ts`, `app/api/inventory/items/route.ts`, `lib/services/inventory/inventory.service.ts`, `inventory.errors.ts`.
- **תלות:** משתמש ב-primitive מ-Batch A. נוגע ב-`product-detail-view.tsx` יחד עם Batch A (edit sheet) → **לתאם בעריכה אחת**.

### Batch C — Dedup ספק/קטגוריה (במסגרת הארכיטקטורה הקיימת, ללא חריגה)
**מכסה ליקוי: 5**

- **גישה (additive, ללא דומיין ספקים מלא):**
  - קטגוריה: חיזוק הנירמול (trim + collapse whitespace + NFKC) ב-`resolveCategoryId` כדי למנוע כפילויות "קולה"/"קולה ".
  - ספק: שדרוג ה-input של הספק ל-datalist (כמו קטגוריה) המוזן מ-`supplierName`-ים קיימים + נירמול בעת שמירה. **לא** מחברים ל-`Supplier` entity / Party בסבב הזה (חורג מהיקף) — מסומן כ-Q2.
- **קבצים:** `app/(shell)/inventory/items/create/page.tsx`, `product-detail-view.tsx` (אותו רכיב קלט), אולי endpoint עזר להחזרת רשימת ספקים נצפים.
- **תלות:** משתף את רכיב הקלט עם Batch B.

### Batch D — Threshold: יישור ניסוח↔לוגיקה + ניסוחים
**מכסה ליקויים: 12, 13**

- **גישה:**
  - **(12)** החלטה אחת (Q4): או לשנות ניסוח ל"בערך זה או פחות" / "סף ומטה", או לשנות לוגיקה ל-`<`. **ברירת מחדל מוצעת: לתקן ניסוח** (פחות מסוכן מבחינת התראות/רגרסיה) — יישור כל מחרוזות ה-help/caption.
  - **(13)** תיקון מחרוזות: "נזק או קלקול"→"נזק", "ללא מחיר"→"אין מחיר", "מתחת לזה —"→"סף ומטה: …", הסרת תחילית "ספק:" כפולה בתג.
- **קבצים:** `inventory-design.tsx` (label/tone), `lib/inventory/inventory-labels.ts`, `app/(shell)/inventory/items/create/page.tsx` (help), `product-detail-view.tsx` (caption + tag), `inventory-item-row.tsx`.
- **תלות:** עצמאי. נוגע ב-`product-detail-view.tsx` → לתאם עם A/B.

### Batch E — Product Card: תוכן + שמות ארוכים
**מכסה ליקויים: 8, 10**

- **גישה:**
  - **(10)** הוספת `overflow/ellipsis` (או `line-clamp:2`) לשם בכרטיס (`inventory-item-card.tsx:107-116`).
  - **(8)** שאלת מוצר (Q3) — לאחר אישור מה להציג. קודם לאמת היכן הכרטיס בשימוש בפועל.
- **קבצים:** `inventory-item-card.tsx`, `inventory-items-list.css.ts` (אם רלוונטי).
- **תלות:** עצמאי.

### Batch F — Purchase Wizard double-click
**מכסה ליקוי: 6**

- **גישה:** איתור שורש (לוג/בדיקה ידנית): לבדוק האם הכפתור מתחיל `disabled` ונדרשת לחיצה "להעיר"; לייצב `canSubmit`/`actionLoading`; אם השורש הוא re-render מ-`persistDraft` effect — לעשות debounce/להוציא מנתיב הרינדור; אם זה ניווט — לוודא prefetch/מצב מוכן. תיקון נקודתי בלבד.
- **קבצים:** `order-wizard-context.tsx`, `order-wizard-shell.tsx`, `inventory-design.tsx` (BottomActionBar), עמודי `new/`, `new/cart/`, `new/confirm/`.
- **תלות:** עצמאי. **אזור רגיש** (ראה §3).

### Batch G — Discoverability
**מכסה ליקוי: 7**

- **גישה:** הוספת כניסות ברורות בבית המלאי: קישור מפורש "כל המוצרים" וקישור "מרכז הרכש" (`/inventory/supplier-purchases`). אפשרות: הוספת אריח/quick-action, או הפעלת `InventoryBottomNav` המושבת. **Q6 — איזה דפוס ניווט מועדף.**
- **קבצים:** `app/(shell)/inventory/page.tsx`, אולי `inventory-design.tsx` (`InventoryBottomNav`).
- **תלות:** עצמאי.

### Batch H — 404 ממותג + Hydration
**מכסה ליקויים: 14, 15**

- **גישה:**
  - **(14)** יצירת `app/not-found.tsx` ממותג בשפת העיצוב.
  - **(15)** ברכת הבית: להעביר חישוב השעה ל-`useEffect`/state (או `suppressHydrationWarning` ממוקד). `inventory-movements-list.tsx`: לוודא פורמט תאריך עקבי שרת↔לקוח (`"use client"` / פורמט דטרמיניסטי).
- **קבצים:** `app/not-found.tsx` (חדש), `app/(shell)/inventory/page.tsx`, `inventory-movements-list.tsx`.
- **תלות:** עצמאי. (14) נוגע ברמת-app ולא רק inventory — Q7.

### Batch I — Bottom Sheet / Nav overlap
**מכסה ליקוי: 1**

- **גישה:** (א) העלאת z-index של מודאל יציאת הוויזארד מ-60 לערך מעל הנאב (≥200) או הסתרת הנאב כשמודאל פתוח; (ב) אימות `inv-bottombar` לא חופף; (ג) חיזוק ה-bottom padding בגיליונות לערך מינימלי גם כש-safe-area=0; (ד) מעבר ידני על כל גיליון בפיצ'ר (movement, edit, sheets בוויזארד) לאימות.
- **קבצים:** `order-wizard-shell.tsx`, `inventory-primitives.css.ts`, `inventory-design.tsx` (bottombar), `bottom-bar.tsx` (קריאה בלבד לאימות z-index).
- **תלות:** חופף ל-Batch F (קבצי הוויזארד) → לתאם.

---

## 3. סיכונים

| אזור | סיכון רגרסיה | בדיקה נדרשת לאחר תיקון |
|------|--------------|------------------------|
| `inventory.service.ts` (ולידציות 2,4) | **גבוה** — שכבת ה-System of Record; ולידציה חדשה עלולה לחסום מסלולים קיימים (Receiving, POS sale, drafts) | להריץ את כל הבדיקות הקיימות תחת `lib/services/inventory/*.test.ts`; לוודא ש-Receiving/POS לא נשברים |
| Threshold logic (12) | **גבוה אם משנים `<=`→`<`** — משנה אילו פריטים מסומנים קריטי/נמוך, משפיע על התראות, על "דורש טיפול" בבית, ועל `inventory-alert.service` | לכן ברירת המחדל לתקן **ניסוח** ולא לוגיקה. אם בכל זאת לוגיקה — לאמת alerts + home attention |
| PATCH מוצר (3) — הוספת `supplierName`/`categoryId` | בינוני — נתיב כתיבה; לוודא שלא דורס שדות בטעות (partial update) | בדיקת עריכת מוצר מלאה: שינוי ספק/קטגוריה בלבד לא משנה כמות/מחירים |
| Wizard (6) | בינוני־גבוה — מצב ה-context/persistDraft שביר; שינוי timing עלול לשבור שמירת טיוטה או beforeunload | מעבר מלא בוויזארד 3 שלבים + רענון באמצע + "שמור טיוטה" |
| primitive שגיאה/Feedback (A) | בינוני — מוחל על *כל* הטפסים בבת אחת | רגרסיה ויזואלית על כל טופס שנגעו בו |
| `product-detail-view.tsx` | בינוני — נוגעים בו מ-A, B, C, D | לרכז את כל השינויים בו לעריכה מתואמת אחת, לבדוק edit sheet שלם |
| 404 ברמת-app (14) | נמוך־בינוני — משפיע על כל האפליקציה, לא רק inventory | לוודא שלא משבש routing קיים |
| Hydration (15) | נמוך | בדיקת קונסול ללא אזהרות hydration בבית + ברשימת תנועות |

**נקודות רגישות מיוחדות:** `inventory.service.ts` הוא ה-System of Record של מציאות פיזית (לפי חוקת הדומיין). כל שינוי ולידציה שם — additive בלבד, לא לגעת בלוגיקת movements/receiving.

---

## 4. שאלות פתוחות (החלטות מוצר — לא מניח הנחות)

- **Q1 (ליקוי 4):** מהו היחס התקין בין `reorderPoint` ל-`minimumQuantity`? ההנחה הטבעית: `reorderPoint ≥ minimumQuantity` (מזמינים מחדש *לפני* שמגיעים לסף הקריטי). לאשר את הכלל ואת ההתנהגות כשהם שווים.
- **Q2 (ליקוי 5):** לסבב הזה — להסתפק ב-datalist + נירמול טקסט לספק (additive, בתוך היקף), נכון? חיבור מלא של שדה הספק ל-`Supplier`/Party entity הוא שינוי דומייני שחורג מההיקף — לאשר שנשאר בחוץ.
- **Q3 (ליקוי 8):** מה להציג בכרטיס המוצר? אפשרויות: (א) כמות + סטטוס מלאי בלבד; (ב) כמות + שווי מלאי; (ג) כמות + מחיר מכירה. + לאשר: האם הכרטיס (`inventory-item-card.tsx`) בכלל בשימוש פעיל, או שהתצוגה הראשית היא השורות (`InventoryProductRow`)?
- **Q4 (ליקוי 12):** לתקן **ניסוח** (מועדף, בטוח) או **לוגיקה** (`<=`→`<`)? שינוי לוגיקה משפיע על התראות וייתכן רגרסיה.
- **Q5 (ליקוי 11):** מותר להוסיף רכיב toast מערכתי קליל ל-Feedback הצלחה, או להישאר עם הודעות inline בלבד?
- **Q6 (ליקוי 7):** דפוס הניווט המועדף ל-Discoverability — אריחים/quick-actions בבית, או הפעלת ה-`InventoryBottomNav` המושבת?
- **Q7 (ליקוי 14):** עמוד 404 — ברמת כל האפליקציה (`app/not-found.tsx`) או ספציפי ל-inventory? (ברירת מחדל מוצעת: ברמת-app, כי כרגע אין כלל.)

---

## 5. סדר ביצוע מוצע לסבב (לאחר אישור)

1. **A** (תשתית שגיאה/Feedback) →
2. **B** + **C** (טופס מוצר, משתמשים ב-A; מתואם ב-`product-detail-view.tsx`) →
3. **D** (ניסוח/threshold, מסיים את הנגיעות ב-`product-detail-view.tsx`) →
4. **I** + **F** (וויזארד + overlap, קבצים משותפים) →
5. **G** (discoverability) →
6. **E** (כרטיס) →
7. **H** (404 + hydration) →
8. הרצת כל בדיקות ה-inventory + מעבר ידני לפי טבלת הסיכונים.

> אין להתחיל יישום עד אישור התוכנית והשאלות הפתוחות (Q1–Q7).
