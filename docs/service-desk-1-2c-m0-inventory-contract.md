# חוזה אינטגרציה M0 — מלאי ← Service Desk 1.2c

**למי:** סשן המלאי.
**מאת:** סשן Service Desk.
**מצב:** בקשה. שום דבר כאן לא מומש. Service Desk לא משנה קוד, Schema או מיגרציה של המלאי.
**בסיס:** main ב־`bf2d3a53`, 2026-11-05.

Service Desk 1.2c (חלקי חילוף בקריאת שירות) ישתמש בכותב התנועות הקיים של המלאי, `inventoryService.createMovement`. הוא יבצע בדיוק שתי פעולות:

- יציאה אחת כשחלק נלקח מהמלאי לתיקון.
- כניסה אחת כשחלק לא משומש מוחזר.

לפני ש־Service Desk יתחיל לקרוא לכותב (אבן הדרך M3), הכותב צריך להיות בטוח במקביליות. החוזה הזה מגדיר מה נדרש, איך זה ייבדק, ומתי M0 נחשב סגור.

---

## 1. המצב הקיים והבאג המדויק

`lib/services/inventory/inventory.service.ts`, `createMovement` (שורות 114–255 ב־`bf2d3a53`):

1. `tx.inventoryItem.findUnique({ where: { id: itemId } })`: קריאה רגילה, בלי `FOR UPDATE`.
2. `quantityAfter = item.currentQuantity + quantityDelta`: חישוב ב־JavaScript.
3. `if (quantityAfter < 0) throw new NegativeInventoryError()`: בדיקה בקוד בלבד.
4. `tx.inventoryMovement.create(... quantityBefore, quantityAfter ...)`.
5. `tx.inventoryItem.update({ data: { currentQuantity: quantityAfter } })`: כתיבה של **ערך מוחלט**, לא תוספת.

הטרנזקציה היא `prisma.$transaction` רגיל (דרך `tenantTx`), בלי רמת בידוד, כלומר ברמת READ COMMITTED של Postgres. אין במסד `CHECK` על `currentQuantity`. בכל קוד המלאי אין `FOR UPDATE`, `increment` או `$executeRaw`.

**הבאג (אובדן עדכון):** שתי טרנזקציות על אותו פריט, כשבמלאי 5:

1. A קוראת 5.
2. B קוראת 5.
3. A כותבת 4 (‎−1).
4. B כותבת 3 (‎−2).

המלאי הסופי הוא 3, ולא 2. יחידה אחת "נעלמה", וה־`quantityBefore` של אחת התנועות שגוי.

אותו מנגנון מאפשר גם יתרה שלילית בפועל. שתי הוצאות של היחידה האחרונה עוברות שתיהן את הבדיקה בשלב 3. אין שום הגנה במסד שתעצור את זה.

הבאג קיים היום, גם בלי Service Desk. הוא משפיע על כל מי שקורא לכותב:

- מכירה ידנית ו־POS (`recordInventorySale`).
- יישוב התאמות POS.
- קבלת סחורה (`postReceivingSession`).
- אישור רכש ספק.
- תנועה ידנית (`POST /api/inventory/movements`).

## 2. הדרישות

### R1 — עדכון אטומי או נעילה (חובה)

`createMovement` לא יאבד עדכון כשתנועות על אותו פריט רצות במקביל. שתי דרכים מקובלות. ההחלטה שלכם:

- **א (מומלצת):** עדכון אטומי מותנה, שמחזיר את הערכים:
  ```sql
  UPDATE "InventoryItem"
     SET "currentQuantity" = "currentQuantity" + $delta, "updatedAt" = now()
   WHERE "id" = $itemId AND "businessId" = $businessId
     AND "currentQuantity" + $delta >= 0
  RETURNING "currentQuantity" - $delta AS "quantityBefore", "currentQuantity" AS "quantityAfter";
  ```
  כשאין שורה מוחזרת, זה אומר שהפריט לא קיים, שייך לעסק אחר או שהכמות לא מספיקה. במקרה כזה מבחינים בין המקרים וזורקים את השגיאה הקיימת. רק אחרי זה נוצרת התנועה, עם `quantityBefore` ו־`quantityAfter` מהשורה שהוחזרה.
- **ב:** `SELECT … FROM "InventoryItem" WHERE id = $1 FOR UPDATE` בתחילת הטרנזקציה, ואחריו הקוד הקיים.

בשתי הדרכים:

- `quantityBefore` ו־`quantityAfter` של התנועה הם הערכים האמיתיים תחת הנעילה.
- סכום ה־`quantityDelta` של כל התנועות של פריט שווה לשינוי ב־`currentQuantity`.

### R2 — הגנה במסד מפני יתרה שלילית (חובה)

- `ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_currentQuantity_nonnegative" CHECK ("currentQuantity" >= 0)`. השם לבחירתכם.
- **לפני ההחלה:** בדיקת evidence לקריאה בלבד ב־Production, שסופרת שורות עם `currentQuantity < 0`. אם יש כאלה, תיקון הנתונים הוא החלטה נפרדת של הבעלים. מדובר בעסקי בדיקה בלבד, אין עסקים אמיתיים.
- כשה־CHECK נכשל, הכותב מתרגם את השגיאה ל־`NegativeInventoryError` הקיימת, ולא ל־500.

### R3 — סיבת תנועה לשימוש בחלק תיקון (חובה)

- ערך חדש ב־`InventoryMovementReason`: **`SERVICE_PART`** (הוצאה לתיקון).
- ההחזרה משתמשת בערך הקיים `RETURN`, ולכן לא נדרש ערך נוסף.
- תרגום לעברית, שימוש בדוחות ובסינון במסכי המלאי: לשיקולכם. מספיק שהערך לא ייפול כ"לא מוכר".

### R4 — עקביות סוג מול סימן (מומלץ, לא חוסם)

היום `POST /api/inventory/movements` מקבל `movementType`, `reason` ו־`quantityDelta` מהבקשה, בלי לבדוק את ההתאמה ביניהם. המלצה:

- `OUT` מחייב ערך שלילי.
- `IN` מחייב ערך חיובי.
- `SERVICE_PART` רק עם `OUT`.

Service Desk ישלח תמיד צירופים נכונים. הבקשה כאן היא שהכותב ידחה צירוף שגוי מכל מקור.

### R5 — בלי שינוי נוסף בהתנהגות

- חתימת `createMovement(input, { tx })` נשארת.
- ההתראות (LOW / CRITICAL) נשארות באותה טרנזקציה.
- השגיאות נשארות אותן מחלקות.
- אין צורך ב־idempotency בתוך הכותב. Service Desk מבטיח אותה בצד שלו: כל תנועה מקושרת לשורת חלק אחת דרך עמודת UNIQUE, ויש מפתח idempotency ביומן.

## 3. החוזה ש־Service Desk יצפה לקבל

Service Desk יקרא לכותב **בתוך הטרנזקציה שלו**: `createMovement(input, { tx })`, באותו `tx` שבו הוא מעדכן את שורת החלק וכותב את האירוע. התנועות שהוא ישלח מוגדרות ב־`InventoryMovementIntent` (`lib/services/service-desk/parts.contracts.ts`):

| פעולה | movementType | reason | quantityDelta | הערה |
| --- | --- | --- | --- | --- |
| הוצאת חלק לתיקון | `OUT` | `SERVICE_PART` | ‎−כמות השורה | פעם אחת לכל שורת חלק |
| החזרת חלק לא משומש | `IN` | `RETURN` | ‎+כמות השורה | פעם אחת לכל שורת חלק, רק אחרי הוצאה |

הכותב מתחייב ל:

1. **הצלחה:** מחזיר את שורת התנועה (לפחות `id`), כש־`quantityBefore` ו־`quantityAfter` מדויקים תחת הנעילה.
2. **כמות לא מספיקה:** זורק `NegativeInventoryError` ולא כותב כלום. Service Desk מגלגל אחורה את כל הטרנזקציה, והחלק נשאר במצבו.
3. **פריט לא קיים או של עסק אחר:** זורק `InventoryNotFoundError` או `InventoryUnauthorizedError`, כמו היום. ה־RLS הקיים (`p7w3_tenant`) נשאר.
4. **השתתפות בטרנזקציה של הקורא:** אין commit עצמאי. כשל מאוחר יותר אצל Service Desk מבטל גם את התנועה וגם את שינוי הכמות.
5. **סדר נעילות:** הכותב נועל רק את שורת הפריט. Service Desk נועל לפני כן את הקריאה ואת שורת החלק, ואחר כך את הפריט, וכך אין מעגל נעילות.

Service Desk מתחייב ל:

- לא לכתוב לעולם ל־`InventoryItem` או ל־`InventoryMovement` ישירות, רק דרך הכותב. ב־M3 תיתווסף בדיקת CI שמוודאת זאת.
- לא לשנות קבצים של מודול המלאי.
- שריון של Service Desk הוא **רך** ונשמר בטבלאות שלו בלבד. הוא לא מחייב את המלאי, את הקופה או את הקבלה. M0 לא נדרש לתמוך בו.

## 4. בדיקות נדרשות (ב־PR של M0)

במעבדת PG17 בטופולוגיית Production (role `app_runtime`, FORCE RLS), כמו המעבדות הקיימות:

| # | בדיקה | צפוי |
| --- | --- | --- |
| T1 | 20 טרנזקציות מקבילות, כל אחת ‎−1, על פריט עם 20 | כולן מצליחות, הכמות הסופית 0, 20 תנועות, ‏`quantityBefore` ייחודי בכל תנועה (20…1) |
| T2 | 20 טרנזקציות מקבילות, כל אחת ‎−1, על פריט עם 5 | בדיוק 5 מצליחות ו־15 מקבלות `NegativeInventoryError`. הכמות הסופית 0, אף פעם לא שלילית. 5 תנועות |
| T3 | ערבוב מקביל של ‎+3 ו־‎−2 (‏10 מכל סוג) | הכמות הסופית = התחלה + 10 = סכום ה־delta. אין אובדן עדכון |
| T4 | עדכון ישיר `currentQuantity = -1` כ־app_runtime | נדחה על ידי ה־CHECK |
| T5 | createMovement בתוך tx שנזרקת בו שגיאה אחרי הקריאה | אין תנועה, והכמות לא השתנתה (rollback מלא) |
| T6 | התראות LOW / CRITICAL תחת מקביליות | בדיוק התראה פתוחה אחת לכל פריט וסוג |
| T7 | פריט של עסק B מתוך הקשר של עסק A | נדחה, ושום דבר לא נכתב |
| T8 | ‏`SERVICE_PART` עם `OUT` | מתקבל. עם `IN`: נדחה (אם R4 מומש) |
| T9 | רגרסיה: מכירה, POS, קבלה, אישור רכש, תנועה ידנית | ההתנהגות הקיימת לא השתנתה (חוץ מהדחייה של מקרי מרוץ) |
| T10 | ‏preflight / evidence ב־Production | ה־CHECK קיים ו־validated. ערך ה־enum קיים. 0 שורות שליליות |

## 5. תנאי קבלה: מתי M0 סגור ו־Service Desk יכול להתחיל M3

כל התנאים הבאים, יחד:

1. PR של M0 ממוזג ל־main באישור הבעלים. כללי migration-first נשמרים: מיגרציה (CHECK + enum) ב־PR נפרד או לפי RELEASE-OWNERSHIP.
2. המיגרציה של M0 הוחלה ב־Production דרך release-migrate, עם evidence ירוק: ה־CHECK קיים, ‏`SERVICE_PART` קיים ו־0 שורות שליליות.
3. בדיקות T1–T7 ירוקות במעבדה, והריצה מקושרת ב־PR.
4. `createMovement` נשאר עם אותה חתימה ומשתתף ב־`tx` של הקורא (סעיף 3).
5. סשן המלאי מאשר בכתב שאין שינוי נוסף מתוכנן לכותב שישבור את החוזה בסעיף 3.

עד שכל התנאים מתקיימים, Service Desk לא קורא לכותב. M1 (הליבה הטהורה) לא תלוי ב־M0, וממשיך בינתיים.

## 6. סדר בתור המיגרציות

ב־2026-11-05 תור Production חסום עד שחרור `20261110100000_acquisition_resolve_paused_hold` (#953). אחריו ממתינה `20261113090000_service_external_work` (Service Desk 1.2b). מיגרציית M0 תקבל חותמת אחרי כל המיגרציות הממתינות בזמן הכתיבה, כדי לעמוד ב־PREFIX INVARIANT של release-migrate. אין לפתוח אותה לפני שהבעלים מאשר.

## 7. מחוץ לתחום של M0

- שריון קשיח או עמודת `reservedQuantity`: לא נדרש. החלטה ק‑2 היא שריון רך.
- הצגת "שמור לתיקונים" במסך המלאי: אופציה עתידית. Service Desk יספק פונקציית קריאה.
- תיקון שני פגמים קיימים שמדווחים בנפרד. הם לא חוסמים את Service Desk:
  - פרסום קבלה (`postReceivingSession`) ללא מעבר DRAFT→POSTED מותנה. פרסום כפול במקביל יכול להוסיף מלאי פעמיים.
  - יישוב התאמות POS שמשבש מלאי (docs/learning/SENSOR_COVERAGE.md:260).
