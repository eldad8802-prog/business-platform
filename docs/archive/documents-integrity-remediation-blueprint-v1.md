# Documents Integrity Remediation Blueprint

**Status: INVESTIGATION COMPLETE — DESIGN ONLY. No code, schema, data, or production changes were made.**
**Date: 2026-08-25 · Scope: Dubiz Documents (upload → OCR → review → approval → financial record → reports → accountant export)**
**Evidence base: Production DB (Neon branch `prod-candidate-20260605`, endpoint `ep-flat-brook`, READ-ONLY) + full code trace on `main`-lineage working tree.**

סיווג ראיות בכל המסמך: **PROVEN** (ראיית DB/runtime), **CODE VERIFIED** (קריאת קוד), **CONFIG VERIFIED** (קונפיגורציה), **INFERRED** (הסקה), **UNKNOWN**.

---

## 1. Executive Findings

1. **הממצא המרכזי גדול פי 3.5 ממה שחשבנו: לא 13 אלא 47 מסמכים `approved` ללא `FinancialRecord`** — מתוך 73 מסמכים מאושרים בסך הכול. רק 26 מסמכים מאושרים יצרו רשומה כספית. 30 מה-47 נראים פיננסיים לחלוטין (סכום + כיוון expense). **PROVEN.**
2. **שורש ה-47 אינו טרנזקציה שנכשלה אלא מלכודת סיווג + UX**: פרופיל `financial_transaction` **בלתי-נגיש בכלל ב-runtime** (`guardrailRoute` מקובע ל-`"unknown"` ו-`allowUnified:false` בכל נקודות הקריאה), ולכן קבלות אמיתיות מסווגות `quote_or_order` — פרופיל שממנו **אין שום דרך ב-UI וגם לא בשרת** ליצור רשומה כספית. הכפתור הראשי מציג "אשר ושמור" — אותו נוסח בדיוק כמו אישור כספי. המשתמש בטוח שרשם הוצאה; המערכת שמרה "מסמך מידע". **PROVEN + CODE VERIFIED.**
3. **מסמך שאושר כ"מסמך" נעלם מכל המערכת**: לא ב-inbox (מסונן ל-`needs_review`), לא בחיפוש (מבוסס `FinancialRecord` בלבד), לא ב-totals, לא בחבילת רו"ח (נטענת מ-`FinancialRecord`). אין שום מסך שמציג אותו. **CODE VERIFIED.**
4. **ה-504 בחבילת רו"ח הוא deadlock, לא איטיות**: `app/api/reports/export-zip/route.ts` ממתין ל-`archive.finalize()` לפני שמישהו קורא מה-`PassThrough`; ברגע שה-ZIP עובר ~1–2MB של buffers פנימיים — הפונקציה תלויה לנצח עד שה-gateway הורג אותה. חודש קטן נכנס ל-buffer ולכן "עובד". **CODE VERIFIED** (עם הסבר מלא ב-§10).
5. **אין שום הגנת duplicates בהעלאה ידנית** — אין hash, אין שם קובץ, אין גודל, אין שאילתת בדיקה, אין constraint. Gmail ו-WhatsApp דווקא עושים dedup מלא ב-SHA-256 עם uniques ב-DB. הא-סימטריה הזו היא הפער. **CODE VERIFIED**, וכפילויות כספיות קיימות בפועל ב-Production (**PROVEN**, §5).
6. **מסמך מאושר פתוח לעריכה בלתי-מוגבלת**: אין guard על `approved`, עריכת סכום + re-approve מעדכנת את ה-`FinancialRecord` in-place. **קיים** ledger append-only (`ReviewEvent`) שמתעד belief/final לכל אישור — אבל אין לו שום UI, והכתיבה שלו בולעת שגיאות בשקט. **CODE VERIFIED + PROVEN** (76 אירועים ב-prod).
7. **המקוריים של מסמכים 1–72 כנראה אבודים**: `fileUrl` שלהם הוא `/uploads/<timestamp>` — סכמת public/uploads הישנה שנמחקה בניקוי הפרטיות (P0). ה-file route מחזיר להם 404 by-design. אלו "72 השורות השבורות" המוכרות. מסמכים מ-06/2026 ואילך יושבים ב-Cloudflare R2 פרטי עם מפתח tenant-scoped. **PROVEN (DB) + CODE VERIFIED.**
8. **מע"מ מחושב במנוע — ונזרק**: `FinancialRoles` מזהה `vatAmount`/`subtotalAmount`, משתמש בהם רק כדי לבחור את ה-gross, ואף שדה מע"מ לא קיים ב-`ExtractedData`/`FinancialRecord`. שום דוח לא צורך מע"מ. **CODE VERIFIED.**
9. **`categories.general` מערבב הכנסות והוצאות בפועל**: הטקסונומיה לא מכילה אף קטגוריית הכנסה ⇒ כל הכנסה נופלת ל-`general`; `reports/summary` סוכם קטגוריות בלי `direction`; וסה"כ ה-XLSX לרו"ח סוכם income+expense למספר אחד. **PROVEN (הכנסה 64,401 ₪ יושבת ב-general לצד הוצאות) + CODE VERIFIED.**
10. **אין מחיקה/ביטול/ארכוב בשום מקום** — אין `DELETE` handler למסמכים (לכן 405), אין שדות `deletedAt`/`voided`, אין export history, וכל export מחושב live מהמצב הנוכחי.

---

## 2. Current Architecture

```
Original file ──► R2: biz/{businessId}/documents/doc-{ts}-{rand}.{ext}   (private, no lifecycle)
      │
      ▼
Document (fileUrl=basename, mimeType, source, status, createdAt)          ◄── אין hash / filename / size
      │  upload: status=processing → after(): OCR (Google Vision) 
      ▼
ExtractedData (amount, vendorName, date, category, direction, conf…)      ◄── אין vat/net/gross
      │  + ExtractionSnapshot / SliceDecision / ExtractionEvidence (observability, best-effort)
      ▼
Review UI (output-profile resolver ► reviewMode)                          ◄── financial_transaction unreachable
      │  POST /approve { extracted, explicitFinancial }
      ▼
allowFinancial? ──NO──► Document.status=approved בלבד  ══► נעלם מה-UI     ◄── 47 המקרים
      │YES
      ▼
FinancialRecord (amount, date, vendor, direction, category, approvedAt)   ◄── documentId @unique, mutable in-place
      │
      ├─► /api/reports/summary  → totals + categories (direction-blind)   ◄── ערבוב הכנסה/הוצאה
      ├─► /api/search           → FinancialRecord בלבד
      ├─► /api/documents/inbox  → pulse (נכון, direction-split)
      └─► /api/reports/export-zip → XLSX+CSV+originals ZIP                ◄── deadlock ⇒ 504, אין artifact/היסטוריה
```

נקודות שבירת העקביות: (א) הצומת `allowFinancial` — מסמך יכול "להתאשר" בלי ייצוג כספי ובלי שום שקיפות; (ב) `FinancialRecord` mutable ללא היסטוריה גלויה; (ג) שני מקורות אמת לזמנים — כסף לפי `FinancialRecord.date` (תאריך מסמך), ספירת מסמכים לפי `Document.createdAt` (תאריך העלאה); (ד) קבצי מקור ללא hash ⇒ אין זהות קובץ.

---

## 3. Approved-without-FinancialRecord Investigation

**המספר האמיתי כיום: 47** (השאילתה: `status='approved' AND NOT EXISTS FinancialRecord`). המספר "13" מהאודיט הקודם אינו משוחזר באף חתך שנבדק — כנראה נספרה תת-קבוצה (חלון זמן/עסק); מאז גם נוספו אישורים. **PROVEN.**

מאפייני ה-47: 36 עם סכום חלוץ; 30 עם סכום+`direction=expense` ("פיננסיים לחזות"); סכום ההוצאות החסר מה-totals: **86,550 ₪** — מתוכו 80,353 ₪ הוא מסמך 117 שהוא כמעט ודאי שגיאת OCR על כפילות (ר' אזהרה בהמשך). 46/47 עם `ReviewEvent` מתעד; רק מסמך 76 (14/06) קדם ל-ledger.

### הטבלה המלאה (47 הרשומות)

| Doc | Biz | CreatedAt | Vendor (extracted) | Amount | Dir | ReviewEvent → profileId | approvedAs |
|---|---|---|---|---:|---|---|---|
| 76 | 3 | 14/06 | תשלום = | 58 | unknown | — (קדם ל-ledger) | legacy |
| 99 | 3 | 01/07 | חניון בית הדפוס | — | unknown | non_financial | document |
| 100 | 3 | 01/07 | חניון בית הדפוס | — | unknown | non_financial (×2) | document |
| 102 | 3 | 03/07 | צ.י גל מזון בע"מ | — | expense | quote_or_order | document |
| 103 | 3 | 03/07 | Smokis smoke shop | 175 | expense | unknown_review | document |
| 104 | 3 | 03/07 | SMOKIS SMOKE SHOP | 175 | expense | quote_or_order | document |
| 105 | 3 | 03/07 | דור אלון ניהול מיתחמים | 28.9 | expense | quote_or_order | document |
| 106 | 3 | 03/07 | שפר את אלי לוי בע"מ | 640.26 | expense | quote_or_order | document |
| 107 | 3 | 03/07 | מלטיה 2000 | 25 | expense | quote_or_order | document |
| 108 | 3 | 03/07 | שפר את אלי לוי בע"מ | 487.86 | unknown | quote_or_order | document |
| 109 | 3 | 03/07 | דור אלון עטיה | 489.17 | unknown | quote_or_order | document |
| 117 | 3 | 06/07 | חניון דוגית | **80,353** | expense | quote_or_order | document |
| 118 | 3 | 06/07 | MI | 469.1 | expense | quote_or_order | document |
| 119 | 3 | 06/07 | חברת דואר ישראל בע"מ | 2,000 | unknown | quote_or_order | document |
| 120 | 3 | 06/07 | דור אלון עמית | 471.72 | unknown | quote_or_order | document |
| 122 | 7 | 08/07 | ליבוביץ את דייך בע"מ | 22.88 | expense | quote_or_order | document |
| 124 | 7 | 08/07 | צאנג מאי מסאג' | 89 | expense | quote_or_order | document |
| 126 | 7 | 12/07 | רוני בכנרת | 174 | expense | quote_or_order | document |
| 128 | 3 | 14/07 | פרץ ירידים | — | unknown | quote_or_order | document |
| 129 | 3 | 27/07 | בנזק שיווק | 129 | expense | quote_or_order | document |
| 131 | 3 | 31/07 | פרץ ידידים | — | unknown | quote_or_order | document |
| 132 | 3 | 02/08 | צ.י גל מזון בע"מ | — | expense | unknown_review | document |
| 133–152 | 3 | 07/08–10/08 | 20 קבלות אמיתיות (בן חמו, פז, אושר עד, יוחננוף, מחסני חשמל…) | 10–838 | expense | quote_or_order (19), unknown_review (1) | document |
| 154 | 3 | 10/08 | שקל & סטוק | 81.8 | expense | quote_or_order | document |
| 155 | 3 | 10/08 | יורו רנטל | 150 | expense | quote_or_order | document |
| 156 | 3 | 11/08 | דרופ שופ 6 | 200 | expense | quote_or_order | document |
| 157 | 3 | 18/08 | ריקוט 3000 בע"מ | 309.9 | expense | quote_or_order | document |
| 158 | 1 | 20/08 | SHADOW QA VENDOR | — | unknown | non_financial | document (QA) |

(133–152 קובצו לקריאוּת; הרשימה המלאה שמורה בשאילתת ה-DB בסעיף זה. כל השורות **PROVEN**.)

### סיווג Root Cause לכל רשומה

| קבוצה | רשומות | סיווג |
|---|---|---|
| קבלות אמיתיות שסווגו `quote_or_order` ואושרו בכפתור "אשר ושמור" | ~38 (103–157 למעט חריגים) | **D — approval path שלא יוצר FinancialRecord**, מופעל ע"י misclassification. זהו intentional flow ברמת הקוד אך **ACTIVE BUG** ברמת המוצר |
| מסמכים באמת לא-פיננסיים (`non_financial`) | 99, 100, 158 | **A — behavior מכוון** ("שמור כמסמך מידע") |
| `unknown_review` שאושר בלי `explicitFinancial` | 103, 132, 152 | **D**, וריאנט: המשתמש לא לחץ "זה מסמך פיננסי" |
| אישור לפני ה-ledger | 76 | **B — legacy** (מנגנון זהה, אין תיעוד) |

**לא נמצא ולוּ מקרה אחד של E (transaction חלקית)** — לכל אישור יש `ReviewEvent` עקבי עם `approvedAs:"document"`, ואפס רשומות `FinancialRecord` על מסמך שאינו `approved`. **PROVEN.**

### תשובת P0

> **כן. משתמש יכול היום, דרך ה-UI, להביא מסמך ל-`approved` בלי רשומה כספית — וזה קורה בפועל שוב ושוב (אחרון: 18/08). סיווג: ACTIVE BUG.**

שרשרת הראיות (CODE VERIFIED):
1. `output-profile-resolver.service.ts:102` — `buildSourceFromStored` מקבע `guardrailRoute:"unknown"`; שתי נקודות הקריאה (`[id]/route.ts:70`, `approve/route.ts:95`) מעבירות `allowUnified:false`; אין `allowUnified:true` בכל הריפו ⇒ `resolveProfileId` לעולם לא מחזיר `financial_transaction` ב-runtime.
2. `document-output-profile.service.ts:218-226` — מסמך "receipt-like" נופל ל-`quote_or_order` (אם יש quote markers או `documentType:"quote"`; מסמך בלי OCR text נופל לשם אוטומטית) או ל-`unknown_review`.
3. `approve/route.ts:101-103` — `allowFinancial` דורש `financial_transaction` (בלתי-אפשרי) או `unknown_review + explicitFinancial:true`.
4. ל-`quote_or_order` ה-UI לא מציג שום דרך לעבור ל-financial (`page.tsx:468-476` מציע זאת רק ל-`unknown_review`), והכפתור הראשי נקרא "אשר ושמור" (`ReviewActions.tsx:37-43`) — זהה לנוסח האישור הכספי.
5. תוצאה נצפית ב-prod: רצף 07/08 — 20 קבלות ב-40 דקות, כולן `quote_or_order`→document. **PROVEN.**

חמור מזה: **ל-`quote_or_order` אין דרך בכלל להירשם כספית** — גם משתמש שמבין את הבעיה לא יכול לתקן דרך המוצר.

---

## 4. Atomicity Analysis

`POST /api/documents/[id]/approve` — **אין `$transaction` בכלל** (וגם לא בשום מקום ב-pipeline המסמכים). רצף הכתיבות בפועל:

```
approve(documentId, {extracted, explicitFinancial})
 ├─ 1. document.findUnique (+extractedData)            [read]
 ├─ 2. resolveDocumentOutputProfile                    [read/cache]
 ├─ 3. extractedData.upsert (merge של קלט המשתמש)      [WRITE①]
 ├─ 4. if allowFinancial:
 │     ├─ ולידציות amount/vendor/direction → 400        ⚠ אחרי WRITE① — קלט כבר נשמר
 │     ├─ financialRecord.findFirst → update|create    [WRITE②]
 │     └─ if !wasAlreadyApproved:
 │         vendorLearning.upsert (try/catch, non-fatal)[WRITE③]
 ├─ 5. document.update(status="approved")              [WRITE④]
 └─ 6. recordReviewEvent (never-throws)                [WRITE⑤]
```

תשובות:
- **Prisma transaction — לא קיימת.** 5 כתיבות סדרתיות. **CODE VERIFIED.**
- **כשל אחרי WRITE② לפני WRITE④** ⇒ `FinancialRecord` על מסמך `needs_review` — כסף נספר ב-totals בעוד המסמך "ממתין". חלון קיים; ב-prod כרגע 0 מופעים (**PROVEN**), אבל אין שום דבר שמונע אותו.
- **כשל ב-400 אחרי WRITE①** ⇒ הקלט של המשתמש כבר דרס את `ExtractedData` למרות שהאישור "נכשל".
- **Retry / idempotency** — קריאה חוזרת אינה מכפילה `FinancialRecord` (בזכות `documentId @unique` + update-or-create) ואינה מנפחת `vendorLearning` (בזכות `wasAlreadyApproved`). אבל retry אחרי partial state כן מסוגל "להשלים" עם ערכים אחרים, ו-`ReviewEvent` נכתב שוב (append) — סביר בהינתן שזה ledger.
- **WRITE⑤ בולע שגיאות** (`correction-ledger.service.ts:467-470`) — audit trail יכול להיעלם בשקט בלי שאף אחד ידע. אותו דפוס גם ב-snapshots.
- גם ב-pipeline ההעלאה: `status="needs_review"` נכתב **לפני** `ExtractedData` — חלון קצר שבו ה-review נטען בלי extraction.

**מסקנה:** מודל "compensating writes + best-effort" מודע, אבל הצמד `FinancialRecord`+`Document.status` הוא ליבה כספית וחייב atomic. ה-47 orphans **אינם** תוצר של החלונות האלה — אבל החלונות אמיתיים.

---

## 5. Duplicate Root Cause

למה duplicates אפשריים היום (**CODE VERIFIED**):
- בהעלאה ידנית (`upload/route.ts`) לא נשמר ולא נבדק **שום** מזהה זהות: לא SHA-256 (ה-buffer קיים ביד ולא מחושב hash), לא ETag (מוחזר מ-R2 ונזרק), לא שם קובץ מקורי (`file.name` לא נקרא בכלל), לא גודל (נבדק ל-15MB ונזרק), לא מספר מסמך (לא מחולץ), ואין שום `findFirst` לפני `document.create`.
- `Document` ללא unique constraints רלוונטיים; `FinancialRecord.documentId @unique` מונע כפל רק על אותו Document — לא על אותה קבלה שהועלתה פעמיים.
- לעומת זאת Gmail (`@@unique([businessId, contentHashSha256])` על `EmailAttachmentImport`) ו-WhatsApp (מקביל) — מוגנים. הפער הוא בערוץ האנושי בלבד.

### כפילויות קיימות ב-Production (READ-ONLY, **PROVEN**)

Cluster = אותו עסק + ספק + סכום + תאריך מסמך (חיתוך שמרני; וריאנטים של איות אותרו ידנית):

| Cluster | Documents | FinancialRecords | ניפוח בפועל | Confidence |
|---|---|---|---:|---|
| דור אלון 28.9 ₪ 21/06 (עסק 3) | 84, 94, 101, 105, 112 (5!) | **4** | **+86.70 ₪** (נספר פי 4) | High |
| שופרסל 61.07 ₪ 08/06 (עסק 3) | 88, 89 | **2** | **+61.07 ₪** | High |
| "חכמת/חלמת הבורקס" 40 ₪ 15/06 (עסק 3) | 85, 86 (איות OCR שונה) | **2** | **+40.00 ₪** | High |
| חניון דוגית 29/04/24 (עסק 3) | 96 (36.40, יש FR) + 117 (**80,353**, orphan) | 1 | 0 היום; **פצצה של 80k אם "יתוקנו" ה-orphans באופן עיוור** | High |
| Smokis 175 ₪ 16/06 | 103, 104 | 0 | 0 (שניהם orphans) | High |
| חניון בית הדפוס 30/06 | 99, 100 | 0 | 0 | High |
| צ.י גל מזון 24/06 | 102, 132 | 0 | 0 | High |
| עסק 1 (נתוני בדיקה ישנים, 1–72) | 14 clusters, עד ×8 (דר בואי 31.9 ₪) | 0 | 0 (אף אחד לא אושר) | High |

**ניפוח כספי מוכח כיום: ‎+187.77 ₪** על עסק 3 — קטן במספרים, מוחלט כהוכחת מנגנון. בנוסף רשומות QA (160–163) מזריקות 1,234.56+1+1,000+500 ₪ לחודשים 07-08/2026 ו-12/2026.

---

## 6. Duplicate Protection Design

### שכבת נתונים (design בלבד)
- `Document.contentHashSha256 String?` + `@@index([businessId, contentHashSha256])` — **לא** unique (ר' טעם בהמשך); מחושב ב-upload/import אחיד לכל שלושת הערוצים.
- `Document.originalFilename String?`, `Document.sizeBytes Int?` — נשמרים מעכשיו (עלות אפס, ערך זיהוי גבוה).
- עתידי (עם שדרוג extraction): `ExtractedData.documentNumber String?`.
- **Retro-hashing אפשרי**: הקבצים מ-06/2026 ואילך קיימים ב-R2 — job חד-פעמי יכול לחשב hash לכל המצאי הקיים. ל-1–72 אין קובץ ⇒ אין hash (ר' §13).

### טקסונומיית זיהוי — ארבעה סוגים

| # | סוג | זיהוי | ביטחון |
|---|---|---|---|
| 1 | **Exact file duplicate** | `contentHashSha256` זהה באותו עסק | ודאי |
| 2 | **Same invoice, different scan** | לא ניתן לזהות ב-hash. זיהוי בשכבת extraction: אותו עסק + vendor מנורמל (`normalizeVendorForLearning`) + סכום זהה + תאריך מסמך זהה, כאשר לפחות המסמך אחד הוא צילום | גבוה |
| 3 | **Same accounting identity** | אותו עסק + vendor מנורמל + `documentNumber` + תאריך + סכום (כשיהיה documentNumber) | ודאי-כמעט |
| 4 | **Suspected duplicate** | אין documentNumber: vendor מנורמל + תאריך + סכום ⇒ strong; vendor + סכום בטווח ±3 ימים ⇒ weak | הסתברותי |

### מדיניות תגובה (לא constraint נאיבי!)

אין להטיל unique על (amount,date) או כל וריאציה — שתי נסיעות דלק זהות באותו יום הן לגיטימיות. במקום זה:

| רמה | טריגר | התנהגות |
|---|---|---|
| **Hard duplicate** | סוג 1 (hash זהה) או סוג 3 מלא | **BLOCK רך**: מסך "המסמך הזה כבר קיים" עם המסמך הקיים (תאריך, ספק, סכום, קישור) + כפתור מפורש "העלה בכל זאת" (owner confirmation, נרשם ב-audit) |
| **Strong suspected** | סוג 2 / סוג 4-strong | **WARN באישור**, לא בהעלאה: באנר בולט במסך ה-review + שדה "אשר שזה לא כפול" לפני יצירת FinancialRecord; ה-override נרשם |
| **Weak suspected** | סוג 4-weak | סימון שקט: badge "ייתכן כפול" בכרטיס + ב-review; ללא חסימה |

נקודות הבדיקה: (א) ב-upload — hash בלבד (זול, לפני OCR); (ב) אחרי extraction — סוגים 2–4 (יש vendor/amount/date); (ג) רגע ה-approve הכספי — בדיקה סופית מול `FinancialRecord` קיימים. UX: ההודעה תמיד מציגה את המסמך הקיים ומאפשרת לפתוח אותו.

---

## 7. Approved Document Lifecycle

### מה קיים היום (CODE VERIFIED)
- `Document.status` הוא `String` חופשי; ערכים בשימוש: `processing`, `needs_review`, `failed`, `approved`. אין enum, אין ולידציה.
- על מסמך `approved`: אותו UI בדיוק כמו pending — עריכת כל שדה (amount/vendor/date/direction/category) + שני כפתורי אישור. re-approve כספי **מעדכן את ה-`FinancialRecord` in-place** (`approve/route.ts:159-173`): `1,234.56 → 1.00` פשוט דורס את amount; אין רשומה חדשה, הישנה לא נמחקת, totals משתנים מיידית; הערך המקורי שרד רק ב-`ReviewEvent.rawBelief`/`rawFinal` (**יש** timestamp ו-actor שם — אבל שום UI לא מציג זאת, והכתיבה best-effort). re-approve כ"document" משאיר את ה-FR הישן חי — סתירה בין ה-ledger למצב.
- `FinancialRecord.approvedAt` **קיים** (default now, לא מתעדכן ב-update) — הממצא הקודם "אין approvedAt" מתוקן חלקית; `approvedBy` אין (הכיסוי הוא `ReviewEvent.reviewerUserId` מ-25/06 ואילך).

### ההמלצה: **Option B+D משולב**
- **שדות ליבה כספיים** (amount, date, direction, vendor) של מסמך שאושר כספית: עריכה רק דרך **Correction** — פעולה מפורשת שיוצרת revision (לפני/אחרי, actor, סיבה) ומעדכנת את ה-FR; לעולם לא "שמירה שקטה".
- **ביטול**: רק **Void** מפורש (סטטוס, לא מחיקה) שמנטרל את ה-FR מה-totals ומשאיר את הכול לצפייה.
- **שדות רכים** (category) — Option C: עריכה + audit event, בלי טקס.
- לא Option A (immutable מוחלט): קהל היעד הוא בעל עסק קטן שמתקן טעויות OCR ביומיום; חיכוך של void+replacement על תיקון קטגוריה יגרום לו לא לתקן. לא Option C לבד: סכום/תאריך משנים totals ותקופות — חייבים revision מלא.

זה עקבי עם עקרונות ה-Billing compliance (אין מוטציה שקטה, ביטול = רשומת lifecycle מפורשת) בלי לייבא לכאן את כל כובד המשטר של חשבוניות מס.

---

## 8. Correction / Void / Delete Design

### State machine מוצעת (בהלימה למצבים הקיימים — הרחבה, לא החלפה)

```
UPLOADED(processing) → NEEDS_REVIEW → APPROVED_FINANCIAL ⇄(correction) APPROVED_FINANCIAL
        │                  │  │            │
        ▼                  │  └─► APPROVED_DOCUMENT (מסמך מידע, בלי FR)
      FAILED ──retry──► processing          │
                           │                ▼
                           └─► ARCHIVED   VOIDED (FR מנוטרל, מסמך נשמר)
```

- הערכים `processing/needs_review/failed/approved` נשארים; מוסיפים `archived` ו-`voided` + הבחנה approved-financial/approved-document (נגזרת מקיום FR — לא צריך סטטוס נפרד, צריך **תצוגה** נפרדת).
- **Pending — Delete**: soft-delete (`archived` + `archivedAt`+actor). הקובץ ב-R2 נשאר (retention); ההיסטוריה נשארת. Hard delete אינו קיים במוצר.
- **Pending — Archive**: זהה ל-delete מבחינת מודל; ההבדל סמנטי ("לא רלוונטי" מול "בטעות") — שדה reason.
- **Approved — Void**: פעולה עם סיבה (duplicate / uploaded-by-mistake / wrong-business…). ה-`FinancialRecord` מקבל `voidedAt/voidedBy/voidReason` (או superseding revision) ויוצא מכל aggregation. המסמך נשאר נגיש.
- **Approved — Correction**: revision של שדות ליבה (ר' §7); המסמך נשאר `approved`.
- **Approved — Delete**: לא קיים. לעולם.
- **Restore**: `archived→needs_review`, `voided→approved` (עם audit event הפוך).

### Referential integrity — מה קורה לכל יישות

| יישות | delete pending (archive) | void approved | correction | restore |
|---|---|---|---|---|
| `ExtractedData` | נשארת | נשארת | מתעדכנת (עם audit) | נשארת |
| `FinancialRecord` | לא קיימת | `voided`, מוחרגת מכל סכימה | עדכון + revision | חוזרת לסכימה |
| `ReviewEvent`/snapshots | append-only, לא נוגעים | נוסף אירוע void | נוסף אירוע correction | נוסף אירוע |
| R2 object | נשאר (retention) | נשאר | נשאר | נשאר |
| search | מוחרג | מוצג עם badge "מבוטל", מוחרג מ-totals | מוצג מעודכן | חוזר |
| accountant export | מוחרג | מוחרג מה-totals; מופיע ברשימת "בוטלו" אם רלוונטי לתקופה | גרסה חדשה של package | — |
| analytics/pulse | מוחרג | מוחרג | recompute טבעי | חוזר |
| Learning (`VendorLearning`) | אין השפעה | **פיצוי נדרש** — ר' §17 | אות correction — ר' §17 | — |

⚠ הערת סכימה: כיום כל השרשרת על `onDelete: Cascade` מ-`Business` — מחיקת עסק מוחקת רשומות אך **מיתמת את אובייקטי R2 לנצח** (אין מחיקת storage בשום מקום). לטפל בתכנון ה-retention.

---

## 9. Audit Trail Design

יסוד קיים ומצוין: `ReviewEvent` append-only עם belief/final/verdicts/actor/profileId. הפערים והתכנון:

1. **להרחיב את משפחת האירועים**: `approve_financial`, `approve_document`, `correction`, `void`, `restore`, `archive`, `duplicate_override`, `export_generated`. אפשר כ-`type` על ReviewEvent מוכלל או טבלת `DocumentAuditEvent` נפרדת; before/after מלא (`rawBefore/rawAfter`), actor, סיבה חופשית + קוד סיבה.
2. **להפסיק לבלוע שגיאות על אירועים כספיים**: כתיבת האירוע חייבת להיות בתוך ה-`$transaction` של הפעולה (approve/correction/void). best-effort נשאר לגיטימי רק ל-observability (snapshots/slices).
3. **UI היסטוריה**: על כל מסמך מאושר — טאב "היסטוריה": מי אישר, מה תוקן, ממה-למה, מתי. זה כבר כמעט קיים בנתונים — חסר מסך.
4. תיקון סמנטי קטן: היום document-only approval רושם `amount: "rejected"` למרות שהמשתמש פשוט לא הגיש — להוסיף verdict `not-submitted` אמיתי (המנגנון קיים, השימוש שגוי).

---

## 10. Accountant Export Root Cause

**Root cause (CODE VERIFIED, חד-משמעי):**

> `app/api/reports/export-zip/route.ts:15-24` יוצר `archiver → PassThrough` ואז `await archive.finalize()` **לפני** שה-`Response` שקורא מה-stream בכלל נוצר. אף צרכן לא מרוקן את ה-PassThrough ⇒ backpressure ממלא ~16KB (PassThrough) + 1MB (Transform של archiver) ⇒ zip-stream נעצר ולא פולט `end` ⇒ `finalize()` לא מסתיים לעולם ⇒ Vercel gateway הורג ⇒ **504**. חודש קטן שנכנס כולו ל-buffers הפנימיים — "עובד". זה deadlock בינארי, לא איטיות ליניארית.

הוכחות תומכות: ה-test של אותו מודול (`accountant-export-zip.verify.test.ts:61-77`) והמסלול המקביל של המבנה האחיד (`uniform-export-package.service.ts:61-70`) שניהם מחברים drain **לפני** finalize — רק ה-route הזה לא.

בעיות משניות באותו מסלול (כולן CODE VERIFIED):
- `new Response(stream as unknown as BodyInit)` — Node PassThrough אינו `ReadableStream`; גם בלי ה-deadlock ה-body היה נשבר.
- הורדות מקוריים **סדרתיות** (`for…of` + `await` פר קובץ, בלי concurrency) — N×RTT; ~34 מסמכים ביולי ⇒ עשרות שניות גם אחרי תיקון ה-deadlock.
- `zlib level 9` על PDF/JPEG דחוסים — CPU לשווא; כל קובץ נבנה כ-Buffer מלא בזיכרון; אין `maxDuration`, אין `runtime` declaration, אין `functions` ב-`vercel.json` (CONFIG VERIFIED); אין `archive.on("error")`.
- הסכום ב-XLSX מערבב income+expense (ר' §15); `type:"year"` מתעלם מה-`year` שנשלח ומקבע שנה-קודמת.
- אין artifact, אין history, אין cache — כל לחיצה מחשבת הכול מחדש.

---

## 11. Accountant Package Architecture

השוואה (מלאה בוצעה; עיקרי ההערכה):

| | A. Streaming ZIP | **B. Background + stored artifact** | C. Pre-generated monthly | D. Client-side assembly | E. Manifest/batch |
|---|---|---|---|---|---|
| Scalability | בינונית (עדיין תלוי בזמן request) | **גבוהה** | גבוהה | נמוכה (mobile) | גבוהה |
| Vercel fit | דורש זהירות (Fluid/maxDuration) | **מצוין** (job קצר-לב + R2) | טוב | גרוע ב-WebView | טוב |
| Complexity | נמוכה | בינונית | בינונית-גבוהה (מתי לחדש?) | גבוהה | גבוהה |
| Reliability | בינונית | **גבוהה** (retry, artifact בדוק) | גבוהה | נמוכה | בינונית |
| UX | "המתן..." ארוך | **Generate→מוכן→Download** + היסטוריה | מיידי | גרוע | דורש כלי צד-לקוח |
| Mobile download | בעייתי לקבצים גדולים | **טוב** (signed URL) | טוב | גרוע | גרוע |
| Historical availability | אין | **מובנה** (artifacts נשמרים) | מובנה | אין | חלקי |

**המלצה: Architecture B**, בשני צעדים:
- **Interim (קטן, מיידי)**: תיקון ה-deadlock + הורדות מקבילות + `store:true` + `maxDuration` — מחזיר את הפיצ'ר הקיים לחיים בהיקפים של היום.
- **יעד**: Generate יוצר job (ניתן במסגרת request יחיד עם maxDuration מוגדל, או Vercel background function) → ה-ZIP נכתב ל-R2 תחת `biz/{id}/exports/…` → רשומת `AccountantExport` → הורדה ב-signed URL קצר-תוקף. C נדחה כי "מתי לג'נרט מחדש" הופך למנוע cache invalidation; B נותן את אותו ערך on-demand.

### Accountant Package כמושג מוצרי (לא "ZIP downloader")

Package = יחידת מסירה לרו"ח: `business, period (month), version, generatedAt, generatedBy, status (generating/ready/failed/superseded), documentCount, totalsSnapshot {income, expense, vat?}, missingFilesCount, artifactStorageKey, checksum, supersedesId`. התוכן: XLSX+CSV+מקוריים+manifest (המבנה הקיים טוב) + בעתיד עמוד "בוטלו/תוקנו מאז הגרסה הקודמת".

---

## 12. Historical Export Versioning

**הסיכון היום (PROVEN by design)**: אין שום זכר לכך ש-export הופק; מסמך backdated שנוסף ב-20/08 ליולי משנה בדיעבד את "מה שהרו"ח קיבל" בלי שאף אחד ידע. בדיוק התרחיש שהוכח באודיט (מסמך 162 — backdated ליולי).

**מודל מוצע — `AccountantExport`** (design בלבד, ללא schema בפועל): `id, businessId, periodStart, periodEnd, version (רץ פר business+period), status, generatedAt, generatedBy, documentCount, totalsSnapshot Json, artifactStorageKey, checksum, supersedesId?` + unique רעיוני `(businessId, periodStart, version)`.

**הכרעה עסקית: שילוב.**
- **ה-Package הוא immutable snapshot** — מה שנמסר לרו"ח חייב להישאר ניתן-לשחזור ביט-ביט (checksum). לעולם לא נערך.
- **ה"מצב" הוא always-live** — מסך התקופה מציג readiness חי, ואם נוספו/תוקנו מסמכים אחרי הגרסה האחרונה: באנר "החבילה של יולי אינה עדכנית — הופקה ב-31/07, מאז נוספו 2 מסמכים" + כפתור "הפק גרסה 2". v2 מסמנת את v1 כ-superseded; שתיהן נשמרות ונגישות.

---

## 13. Original File Retention

מצב עדכני:

| היבט | ממצא | סיווג |
|---|---|---|
| Provider | Cloudflare R2 (S3 SDK), `STORAGE_PROVIDER=r2`; `local` חסום בפרודקשן | CODE VERIFIED |
| Key | `biz/{businessId}/documents/doc-{ts}-{rand8}.{ext}`; ולידציית tenant על המפתח בכתיבה ובקריאה | CODE VERIFIED |
| DB reference | `fileUrl` = basename בלבד; המפתח המלא נבנה מ-`user.businessId` המאומת — הגנה חוצת-דיירים אמיתית | CODE VERIFIED |
| Public/private | `documents` נעול ל-private ברמת domain-policy; `getPublicUrl` מחזיר null | CODE VERIFIED |
| הורדה | streaming דרך route מאומת (401/403), MIME allowlist, `Cache-Control: private, no-store`; **אין** signed URLs בשימוש (הקוד קיים ולא מחובר) | CODE VERIFIED |
| Lifecycle/expiry | אין שום lifecycle בקוד/`vercel.json`; מחיקת object רק כפיצוי על כשל העלאה | CODE VERIFIED |
| קונפיגורציית ה-bucket עצמו (lifecycle rules בצד Cloudflare, versioning, replication) | לא נבדק — אין גישה לקונסולת R2 | **UNKNOWN** |
| מסמכים 1–72 (מאי 2026) | `fileUrl=/uploads/<ts>` — הסכמה הישנה שנמחקה בניקוי public/uploads; ה-file route מחזיר להם 404 by-design | PROVEN (DB) + CODE VERIFIED; שחזור: כנראה בלתי אפשרי (INFERRED) |

> **"האם קובץ שהועלה היום יהיה זמין בעוד שנה?"** — **כן, ברמת CODE VERIFIED + INFERRED**: R2 הוא אחסון durable, אין שום קוד שמוחק, אין lifecycle בקוד. אבל זה לא **PROVEN** כל עוד לא אומתה קונפיגורציית ה-bucket (lifecycle/expiry בצד Cloudflare) ולא קיים גיבוי/versioning. המלצה: לאמת בקונסולה + לקבע מדיניות retention כתובה (7 שנים — דרישת רשות המסים) + object versioning.

**Download design**: כפתור "הורד מקור" על כל מסמך. Desktop — ה-route הקיים עם `Content-Disposition: attachment`. Mobile/WebView — redirect ל-**signed URL קצר-תוקף (5 דק')** מה-adapter הקיים שכבר תומך בזה; לעולם לא URL ציבורי קבוע. תוספת קטנה: `X-Content-Type-Options: nosniff` על ה-route הקיים.

---

## 14. VAT Gap

מצב (הכול CODE VERIFIED):
- המנוע **מחשב** מע"מ: `FinancialRoles = {totalAmount, subtotalAmount, vatAmount, feeAmount}` (`financial-roles.service.ts`), מזהה תוויות "לפני מע"מ"/"כולל מע"מ"/VAT, מאמת יחס 12–25%, ואף משחזר סכומים שבורים באמצעות net+vat=gross.
- הצריכה היחידה: בחירת ה-gross. `UnifiedDocumentIntelligenceResult` לא מכיל שדה מע"מ ⇒ הנפילה היא **לפני** הפרסיסטנס; גם `rawResult` ב-snapshot לא מציל אותה. `ExtractedData`/`FinancialRecord` — אין עמודות; אף דוח לא צורך; ה-XLSX לרו"ח — בלי עמודת מע"מ.
- אירוניה ארכיטקטונית: בצד Billing (חשבוניות יוצאות) מע"מ הוא first-class (`vatAmount Decimal`, `vatRatePercent`). הצד הקולט — עיוור.

**Design הנתונים שצריך לשמר** (ללא מימוש): על `ExtractedData` וגם על `FinancialRecord`: `grossAmount` (=amount היום), `netAmount?`, `vatAmount?`, `vatRate?`, `vatMode` (`standard | exempt | mixed | unknown`). כלל עקביות רך: `|net+vat−gross| ≤ 0.02` אחרת `vatMode=unknown`. ה-minimum viable accounting integrity: **gross תמיד; net+vat כשחולצו בביטחון; לעולם לא להמציא מע"מ מחישוב יחס כשאין ראיה במסמך** (עוסק פטור/חשבונית מעורבת). צריכה ראשונה: עמודות net/vat ב-XLSX לרו"ח + סכום "מע"מ תשומות לתקופה" במסך החודש.

---

## 15. Income/Expense Classification Gap

Root cause בארבע שכבות (CODE VERIFIED + PROVEN):
1. **טקסונומיה (השורש)**: כל 14 הקטגוריות ב-`lib/constants/categories.ts` הן הוצאה; אין אף קטגוריית הכנסה ⇒ כל הכנסה נופלת מבנית ל-`general`. חמור מזה: הכלל `חשבונית מס → tax` ב-`category-rules.ts` שולח חשבוניות הכנסה לקטגוריית "מסים".
2. **מודל**: `direction` ו-`category` הם שני Strings בלתי-תלויים ולא-מאולצים; amount לא-חתום ⇒ הבאג ניתן-לייצוג.
3. **אגרגציה (הבאג הישיר)**: `reports/summary/route.ts:50` — `categories[r.category] += r.amount` בלי direction (השורה הקודמת דווקא קוראת אותו!); בנוסף `else totalExpense` הופך כל direction לא-מוכר להוצאה; וה-XLSX לרו"ח סוכם הכול למספר אחד. ה-inbox pulse דווקא עושה את זה נכון (direction-filtered aggregates) — הדפוס הנכון כבר קיים בריפו.
4. **UI**: "פירוט לפי קטגוריות · סכום פעילות" מטשטש; pie chart בדשבורד הישן מציג את הסכום המעורב כשלם; פילטר direction בדשבורד הישן בכלל לא נקרא ב-API (dead param).
5. **הלולאה שמנציחה**: בורר הקטגוריות ב-review לא מסונן לפי direction ⇒ למסמך הכנסה האפשרות הישרה היחידה היא "כללי" ⇒ `VendorLearning` לומד general להכנסות לתמיד.

הוכחת נתונים: ב-`FinancialRecord` category=general מכיל הכנסה 64,401 ₪ והוצאות רבות זו לצד זו. **PROVEN.** תיקון עקרוני (סדר): טקסונומיה מפוצלת-direction → סינון picker → groupBy (category,direction) → enum ב-schema → שמות UI.

---

## 16. UX/UI Remediation Design

עקרון-על: **הסטטוס הכספי חייב להיות מובחן ויזואלית מסטטוס המסמך.** "אושר" ≠ "נרשם כספית".

- **Documents List**: לכל מסמך — ספק, תאריך מסמך, סכום, מע"מ (כשקיים), status pill דו-ממדי: `ממתין` / `נרשם כספית ✓` / `מסמך מידע` / `מבוטל` / `כפול?`; badge חבילת רו"ח ("נכלל ב-v2 של יולי"). **חובה: טאב/פילטר שמציג גם מאושרים** — היום הם בלתי-נגישים לחלוטין.
- **Review**: השוואת `Original ↔ Extracted` עם סימון שדות ששוּנו; שני CTA נבדלים חד-משמעית: **"אשר ורשום הוצאה/הכנסה"** (primary) מול **"שמור כמסמך בלבד — לא ייכנס לדוחות"** (secondary, עם משפט אזהרה קבוע). באנר duplicate כשרלוונטי. אם המסמך זוהה לא-פיננסי אך יש בו סכום — שאלה מפורשת, לא ברירת מחדל שקטה.
- **Approved Document**: View original · Download · Correction (טופס עם סיבה) · Void · History (ציר הזמן מ-ReviewEvent). **אין** עריכה שקטה; אין "אשר ושמור" חוזר.
- **Month View** ("אוגוסט 2026"): X נרשמו כספית · Y ממתינים · Z מסמכי מידע · הוצאות · הכנסות · מע"מ תשומות · מוכנוּת לרו"ח (כולל "N מסמכים בעייתיים: בלי סכום/בלי מקור/חשודים ככפולים").
- **Accountant Package**: Generate · סטטוס הפקה · Download · גרסאות קודמות עם generatedAt + badge "Revised" + מה השתנה מאז · documentCount + checksum.
- **Month-close**: **לא** נעילה חשבונאית (Dubiz אינו מערכת הנה"ח; נעילה תילחם במסמכים מאחרים שהם החיים האמיתיים של עסק קטן). במקום: **Readiness + snapshot מוצהר** — "סמן שנמסר לרו"ח" נועל *גרסת חבילה*, לא את החודש; מסמך backdated אחרי מסירה מדליק "יולי השתנה מאז המסירה". זה נותן את כל הערך של close בלי העלות.

---

## 17. Learning Engine Impact (dependencies בלבד)

- `VendorLearning` מתנפח מכפילויות **כבר היום**: דור אלון usageCount=4, confidence מטפס ‎+0.02 לכל אישור — כל אחד מ-4 האישורים הכפולים נספר כ"שימוש". **PROVEN.** הגנת duplicates תקטין את זה מעצמה; cleanup של duplicates צריך לשקול הפחתת usageCount מקבילה (לא קריטי בהיקפים הנוכחיים).
- אישור-כמסמך אינו נוגע כלל ב-learning (ה-upsert בתוך `allowFinancial`) — טוב; אבל תיקון ה-misclassification יגדיל פתאום את זרם האישורים הכספיים — צפוי ורצוי.
- **Void של duplicate חייב לשדר אות פיצוי**: אם משתמש אישר (למד vendor/category, usageCount++) ואז ביטל כי כפול — ההחלטה vendor→category עצמה עדיין תקפה (המסמך אמיתי, רק כפול); אבל usageCount/confidence התבססו על אירוע שלא היה צריך להיספר. עיקרון: **void מסיבת duplicate ⇒ decrement usage; void מסיבת "טעות זיהוי" ⇒ גם תיקון category-belief.** לא לממש עכשיו — רק לא לתכנן lifecycle שסותר את זה.
- `ReviewEvent` הוא append-only בכוונה (Evidence↔Memory Contract): פעולות correction/void צריכות להיכתב כאירועים חדשים — לעולם לא לערוך אירועי עבר. ה-state machine המוצע ב-§8 עקבי עם זה.
- הערת פרוטוקול: verdicts של document-only מתויגים היום `rejected` במקום `not-submitted` — רעש שכדאי לתקן לפני שה-Business Brain יתחיל לצרוך את ה-ledger.

---

## 18. Production Cleanup Plan (ללא ביצוע)

| # | קבוצה | פעולה מוצעת | Auto? | Totals impact | Audit record |
|---|---|---|---|---|---|
| 1 | QA docs 160–164 + FR 23–26 + ReviewEvents + VendorLearning של "QA *" ו-"76.27"/"45.76" (עסק 3) ו-158 (עסק 1) | מחיקה מלאה אחרי סגירת החקירה (זה test data בעסק חי — אין ערך לשמרו) | **Safe-auto** לפי רשימת IDs סגורה | מוריד 2,235.56 ₪ הוצאות פיקטיביות (07-08/2026, 12/2026) | כן — script ידני מתועד |
| 2 | Duplicate FRs מהאודיט/שימוש: FR של docs 94,101,112 (דור אלון ×3 עודפים), 89 (שופרסל), 86 (בורקס) | Void (לא delete) לרשומות העודפות; לשמר את הראשונה בכל cluster | **Manual review** — אישור בעלים פר cluster (5 רשומות) | ‎−187.77 ₪ | כן — void reason=duplicate |
| 3 | 47 ה-orphans | **אסור טיפול אוטומטי.** אחרי תיקון ה-reachability: מסך "מסמכים שאושרו ללא רישום כספי" שמחזיר אותם לתור החלטה של הבעלים (רישום כספי / השארה כמסמך / void). ⚠ ליצור FR אוטומטית = להזריק 80,353 ₪ פיקטיביים (doc 117) ועוד כפילויות (103/104…) | **Manual only** | פוטנציאל ‎+~6,200 ₪ הוצאות אמיתיות (אחרי ניכוי 117 והכפולים) | כן |
| 4 | Docs 1–72 (עסק 1, מקוריים אבודים) + duplicates הפנימיים שלהם | עסק 1 הוא עסק בדיקות (INFERRED מהדפוס) — archive גורף; אם יתגלה שהוא אמיתי: להשאיר רשומות, לסמן "מקור חסר" | Semi-auto אחרי אישור שעסק 1 = test | 0 (אף אחד לא אושר) | כן |

סדר: 1 → 2 → (אחרי Wave 1) 3 → 4. כל cleanup רק אחרי שקיימים Void/Archive אמיתיים — לא למחוק ישירות ב-SQL.

---

## 19. Implementation Plan (Waves)

הסדר המוצע שוּנה מהעיקרון שהוצג בבקשה בנקודה אחת מהותית: **תיקון נגישות האישור הכספי (ה-resolver) קודם לכל דבר אחר** — כי כל יום שעובר מוסיף orphans חדשים (האחרון: 18/08), ו-Wave 2 (reconciliation) חסר טעם כשהברז עוד פתוח.

- **Wave 0 — סגירת UNKNOWNs (קצר)**: אימות קונפיגורציית R2 bucket (lifecycle/versioning) בקונסולה; אישוש שעסק 1 = test business; החלטות המוצר מ-§22.
- **Wave 1 — Financial Integrity**:
  1. **Approval reachability fix** — לגרום ל-review להגיע ל-financial כברירת מחדל כשיש אותות פיננסיים (תיקון `buildSourceFromStored`/הפרופיילים או הרחבת `hasStrongFinancialSignals`), הפרדת נוסחי הכפתורים, מחיקת הדף היתום `app/api/documents/review/[id]/page.tsx`.
  2. Approval atomicity — `$transaction` סביב ExtractedData+FR+status+ReviewEvent; ולידציות לפני כל כתיבה.
  3. Duplicate protection — hash בהעלאה + retro-hash job + שלוש רמות ההתראה.
  4. Approved lifecycle — חסימת עריכה שקטה; Correction/Void/Archive + audit events + History UI.
- **Wave 2 — Existing Data Reconciliation**: §18 בסדר 1→2→3→4.
- **Wave 3 — Accountant Package**: interim fix ל-504 (אפשר גם מוקדם יותר — הוא זעיר ועצמאי); ואז artifact+versioning (`AccountantExport`).
- **Wave 4 — Retention + Download**: כפתור הורדה (route קיים) + signed URL למובייל + מדיניות retention כתובה + טיפול ביתומי-R2 של cascade.
- **Wave 5 — Accounting Completeness**: VAT persistence מקצה-לקצה; טקסונומיית income/expense + תיקון האגרגציות (את באג `summary:50` וה-XLSX מותר וכדאי לתקן כבר ב-Wave 1 — הם שורה אחת כל אחד).
- **Wave 6 — UX Closure**: Month view, readiness, accountant history, רשימת מאושרים.

---

## 20. Risk Register

| Risk | Severity | Current exposure | Fix | Verification |
|---|---|---|---|---|
| קבלות אמיתיות "מאושרות" בלי רישום כספי, בלתי-נראות | **Critical** | 47 מסמכים, ~6.2k ₪ אמיתיים חסרים; ממשיך לקרות | Wave 1.1 + Wave 2.3 | שאילתת orphans = מוסברת-כולה; ניסוי E2E קבלה→FR |
| Totals מנופחים מכפילויות | High | ‎+187.77 ₪ מוכח; ללא הגנה — גדל | Wave 1.3 + Wave 2.2 | דוח clusters ריק מ-hard-dups פעילים |
| עריכה שקטה של מסמך מאושר משנה totals | High | פתוח לכל משתמש היום | Wave 1.4 | approved edit ⇒ 403/Correction בלבד |
| חבילת רו"ח לא שמישה בחודש אמיתי (504) | High | כל חודש אמיתי | Wave 3 interim | הפקת יולי מלאה < 30s |
| partial state כספי (FR בלי approved וכו') | Medium | חלון קיים, 0 מופעים | Wave 1.2 | invariant query ב-CI |
| Export משתנה רטרואקטיבית בלי זכר | Medium | תמיד | Wave 3 versioning | v1 checksum יציב |
| אובדן originals (עבר: 1–72; עתיד: cascade/קונפיג bucket) | Medium | 72 מסמכים כבר בלי מקור | Wave 0 + Wave 4 | בדיקת retrieval מדגמית + policy כתובה |
| מע"מ תשומות לא ניתן לחישוב | Medium | כל הנתונים | Wave 5 | net+vat בדוח רו"ח |
| קטגוריות מערבבות כיוונים (גם בדוח לרו"ח) | Medium | כל דשבורד/ייצוא | Wave 1 (השורות) + Wave 5 (טקסונומיה) | summary לפי (category,direction) |
| Ledger כספי נכתב best-effort ונבלע | Medium | כל אישור | Wave 1.2 | כשל ledger ⇒ כשל פעולה |
| QA data בתוך עסק פרודקשן חי | Low-Med | 2,235.56 ₪ פיקטיביים | Wave 2.1 | totals אחרי ניקוי |

---

## 21. Definition of Done — "Dubiz Documents = Production-grade"

1. **No silent financial divergence** — כל approve מסתיים באחת משתיים בלבד: FinancialRecord נוצר, או שהמשתמש ראה במפורש "לא יירשם כספית" ואישר.
2. **No silent approved orphan** — invariant מנוטר: `approved-financial ⇔ FinancialRecord קיים`; מסמכי-מידע מסומנים ונגישים ב-UI.
3. **Duplicate defense** — hash לכל קובץ נכנס בכל שלושת הערוצים; hard-dup חסום-עם-override; suspected מוצג.
4. **Traceable corrections** — כל שינוי שדה ליבה אחרי אישור = Correction עם before/after/actor/מוצג ב-History.
5. **Safe void semantics** — ביטול = Void משמר-היסטוריה; hard delete לא קיים.
6. **Atomic approval** — טרנזקציה אחת; כשל ledger מפיל את הפעולה.
7. **Reliable originals** — מדיניות retention כתובה ומאומתת מול R2; הורדת מקור מכל פלטפורמה דרך גישה חתומה בלבד.
8. **Scalable monthly packages** — הפקת חודש אמיתי אמינה; artifact נשמר; checksum.
9. **Historical package versions** — v1/v2 עם supersedes; "השתנה מאז המסירה" גלוי.
10. **Consistent totals** — direction-aware בכל aggregation כולל XLSX; VAT נשמר ומדווח.
11. **Tenant-safe artifacts** — כל artifact ו-signed URL תחומי-עסק; אין object access בניחוש ID (קיים היום — לשמר).
12. **Clear UX** — רשימת מאושרים, month readiness, היסטוריית חבילות.

---

## 22. Final Recommendation

### BLOCKERS (לפני כל polish)
1. **Approval reachability** — הברז שמייצר orphans פתוח עכשיו.
2. **Approved mutability** — עריכה שקטה של כסף.
3. **Duplicate hash בהעלאה** — כל יום בלעדיו מקשה על ה-reconciliation.
4. **504** — הפיצ'ר המרכזי לרו"ח לא שמיש (התיקון האינטרימי זעיר).

### ARCHITECTURAL DECISIONS (שלך, כבעל המוצר)
1. אישור lifecycle: Correction+Void (המלצת §7-§8) — או immutable מלא?
2. חבילת רו"ח: אישור Architecture B (background+artifact) ומודל ה-versioning immutable-snapshot+live-readiness (§11-§12).
3. Month-close: אישור ההמלצה "readiness בלבד, בלי נעילה" (§16).
4. גורל 47 ה-orphans: מסך החלטה-מחדש לבעלים (המלצה) — או טריאז' ידני חד-פעמי שלך?
5. עסק 1 — אישוש שהוא test business לפני archive גורף.
6. מדיניות retention רשמית (7 שנים?) לקבצי מקור.

### SAFE TO IMPLEMENT (ברור מספיק כבר עכשיו)
- תיקון deadlock ה-export (+parallel fetch, store, maxDuration).
- hash+filename+size בהעלאה + retro-hash job.
- `$transaction` על approve + הפסקת בליעת שגיאות ledger.
- שתי שורות האגרגציה (summary:50, XLSX total) + סינון category-picker לפי direction.
- הפרדת נוסחי כפתורי האישור + אזהרת "לא יירשם כספית".
- מחיקת הדף היתום `app/api/documents/review/[id]/page.tsx`.
- Cleanup קבוצה 1 (QA) — אחרי אישורך בלבד.

### DO NOT IMPLEMENT YET (דורש עוד עבודה)
- תיקון ה-classifier עצמו (למה קבלות מסווגות quote) — דורש הרצת מדגם על ה-85 snapshots הקיימים לפני שנוגעים במנוע.
- טקסונומיית קטגוריות חדשה — דורשת החלטת מוצר על הרשימה.
- VAT — אחרי שה-extraction יוכיח שהוא מחלץ net/vat אמינים על המדגם.
- Reconciliation של ה-47 — רק אחרי Wave 1.
- Learning compensation על void — רק אחרי שה-void עצמו קיים.

### סדר ביצוע אחד מומלץ
**(1)** תיקון 504 אינטרימי → **(2)** Wave 1.1 reachability + כפתורים → **(3)** Wave 1.2 atomicity+ledger → **(4)** Wave 1.3 duplicates → **(5)** Wave 1.4 lifecycle (Correction/Void/History) → **(6)** Wave 2 cleanup (1→2→3→4) → **(7)** Wave 3 Accountant Package artifact+versioning → **(8)** Wave 4 retention+download → **(9)** Wave 5 VAT+taxonomy → **(10)** Wave 6 UX closure.

---

*נספח ראיות: כל שאילתות ה-DB רצו READ-ONLY על branch `prod-candidate-20260605` (ה-branch הדיפולטי בקונסולת Neon, "production-NEW", נמצא ריק — כדאי לתקן את ה-default כדי למנוע בלבול עתידי). מסמכי QA 160–164 לא נמחקו — הם evidence פעיל.*
