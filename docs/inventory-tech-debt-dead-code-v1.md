# Inventory — Tech Debt: Dead Code Register v1

**מטרה:** תיעוד קוד מת שזוהה במהלך סבב ה-Inventory Audit Remediation, לתחזוקה עתידית בלבד.
**סטטוס:** **אינו חלק מסבב ה-Production הנוכחי.** אין לטפל כעת — מסמך ייחוס בלבד.
**תאריך:** 2026-06-26

---

## רקע

במהלך מיפוי פיצ'ר ה-Inventory לצורך סבב התיקונים, התגלה אשכול קומפוננטות שאינן מיובאות מאף נתיב חי. התצוגה החיה של רשימת המוצרים היא `InventoryProductRow` (מתוך `inventory-primitives.tsx`, דרך re-export ב-`inventory-design.tsx`), בשימוש ב-`app/(shell)/inventory/items/page.tsx` ובעמוד הבית. הקומפוננטות שלהלן הן שרידים של איטרציה קודמת.

---

## 1. אשכול רשימת המוצרים הישנה (Dead)

### `components/inventory/inventory-list.tsx`
- **סטטוס:** מת. `InventoryList` אינו מיובא מאף קובץ (grep: רק הגדרה עצמית + מסמכים).
- **חמור:** הקובץ מכיל **שגיאת תחביר** — שורת `import InventoryItemCard …` תקועה *בתוך* ה-JSX (סביב שורה 36). הקובץ מעולם לא היה עובר קומפילציה אילו היה בשימוש. ראיה חזקה שהוא נטוש.

### `components/inventory/inventory-item-card.tsx`
- **סטטוס:** מת. מיובא **רק** על ידי `inventory-list.tsx` המת.
- זהו ה"כרטיס" שעלה ב-Audit (#8 תוכן, #10 גלישת שמות) — שני הליקויים נפתרו בתצוגה החיה (`InventoryProductRow`), והכרטיס לא נגע בסבב לפי החלטת המוצר (Q3).
- חוסר `overflow/ellipsis` לשם → גלישה. רלוונטי רק אם הכרטיס יוחיה אי-פעם.

### `components/inventory/inventory-items-list-ui.tsx`
- **סטטוס:** מת. אינו מיובא מאף קובץ (grep: רק `docs/design/...md.txt`).

### `components/inventory/inventory-item-row.tsx`
- **סטטוס:** מת **בנתיב הרינדור** — `InventoryItemRow` מיובא רק על ידי `inventory-items-list-ui.tsx` המת.
- **אזהרת מחיקה:** הקובץ מייצא גם helpers (`isValidInventoryImageUrl`, `itemStockStatusLabel`, `InventoryItemRowClassPrefix`). **לאמת בנפרד** שאינם בשימוש לפני מחיקה (grep לכל סמל מיוצא), אחרת להעביר אותם לקובץ utils חי.
- הערה: בסבב הנוכחי תוקן בו ניסוח ("ללא מחיר"→"אין מחיר") אגב — שינוי לא-מזיק בקוד מת; אם הקובץ נמחק, התיקון מתבטל ממילא.

---

## 2. רשימת תנועות ישנה (Dead)

### `components/inventory/inventory-movements-list.tsx`
- **סטטוס:** מת. `InventoryMovementsList` אינו מיובא מאף קובץ. התצוגה החיה של תנועות היא `MovementRow` בתוך `product-detail-view.tsx`.
- **בעיה אילו היה חי:** הקומפוננטה אינה `"use client"` ומשתמשת ב-`new Date(date).toLocaleString("he-IL")` — מקור פוטנציאלי ל-Hydration mismatch (server↔client timezone/locale). זוהי הסיבה שליקוי #15 (Hydration) לא נבע ממנה — היא לא מורנדרת כלל. אם תוחזר לשימוש — להוסיף `"use client"` או פורמט דטרמיניסטי.

---

## 3. המלצת ניקוי (לסבב תחזוקה נפרד)

סדר מחיקה בטוח (מהקצה פנימה), עם אימות grep לכל סמל מיוצא לפני כל מחיקה:

1. `inventory-list.tsx` (שורש מת, שגיאת תחביר) →
2. `inventory-item-card.tsx` (נגרר מ-1) →
3. `inventory-items-list-ui.tsx` (שורש מת) →
4. `inventory-item-row.tsx` (נגרר מ-3 — **אך לאמת קודם את ה-helpers המיוצאים**) →
5. `inventory-movements-list.tsx` (שורש מת).

**Definition of done לסבב הניקוי:**
- `grep` מאשר 0 ייבואים חיים לכל סמל מיוצא מכל קובץ שנמחק.
- `tsc --noEmit` נקי (ביחס למצב הבסיס).
- אין שינוי התנהגותי בתצוגות החיות (`InventoryProductRow`, `MovementRow`).

> אין לבצע את הניקוי כחלק מסבב ה-Production הנוכחי.
