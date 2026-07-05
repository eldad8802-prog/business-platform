# Dubiz — Documents Learning Mechanism Architecture (v1)

> **Status:** Reference / Source of Truth · **Scope:** Documents engine learning & improvement loop · **Date:** 2026-07-05
>
> מסמך זה מגדיר את **הפילוסופיה והארכיטקטורה** של מנגנון הלמידה של מנוע המסמכים ב-Dubiz — לא את המשימה שיצרה אותו. כל מי שיעבוד על מנוע המסמכים אמור להבין מכאן **למה** כל נתון נאסף, לא רק **איפה** הוא נשמר. כל שינוי במנגנון הלמידה חייב להיבדק מול המסמך הזה, ובמיוחד מול העקרונות המחייבים (§9).

---

## 1. מטרת מנגנון הלמידה

מנגנון הלמידה **אינו** תצוגה לבעל העסק ו**אינו** auto-learning שמשנה את המנוע בזמן-אמת. הוא כלי פנימי של Dubiz שמטרתו אחת:

> **לצבור ראיות שיטתיות על היכן המנוע טועה, כדי לשפר אותו לאורך זמן — בביטחון, לפי נתונים, ולא לפי תחושה.**

הבחנה מכוננת: המנגנון הוא **Evidence sink**, לא **decision maker**. הוא רושם את מה שקרה (מה המנוע חשב, מה האדם החליט), ואינו נקרא-חזרה לתוך החלטת חילוץ. החריג היחיד הוא `VendorLearning` (§4) — הלמידה היחידה שכן סוגרת לולאה על המנוע כיום, וגם היא מוגבלת בכוונה.

הצפי: אחרי עשרות מסמכים נוכל לענות **ברמת-שדה** ("באיזה שדה המנוע הכי טועה, באיזה confidence"); אחרי מאות — לפי ספק/סוג-מסמך; אחרי אלפים — להשוות גרסאות מנוע ולכייל confidence.

---

## 2. מחזור החיים של מסמך

```
Upload → OCR → החלטת מנוע (Extraction) → [Snapshot] → Review (אדם) → [ReviewEvent] → Ledger → ניתוח → שיפור מנוע → (גרסה חדשה)
                     │                        │                          │
                  best-effort           אמונת המנוע               פסיקת האדם
```

| שלב | מה קורה | Artifact נשמר | קובץ אחראי |
|---|---|---|---|
| **OCR** | Google Vision (טקסט + גיאומטריה), best-effort | `Document.ocrText` (+geometry ל-Shadow) | `google-vision-ocr.service` |
| **החלטת מנוע** | חילוץ שדות (amount/vendor/date/category/direction/documentType) + confidence | `ExtractedData` (הערך המפורסם) | `unified-extraction-engine.service` |
| **Snapshot** | תצלום אמונת-המנוע ברגע החילוץ + 6 SliceDecisions + Evidence(גיאומטריה) | `ExtractionSnapshot`, `SliceDecision`, `ExtractionEvidence` | `recordExtractionSnapshot` ב-`correction-ledger.service` |
| **Review** | האדם מאשר/מתקן במסך ה-Review | — | `app/(shell)/documents/review/[id]` |
| **ReviewEvent** | פסיקת האדם: belief מול final + verdict לכל שדה | `ReviewEvent` | `recordReviewEvent` ב-`correction-ledger.service` |
| **Ledger** | הצטברות append-only של Snapshots + ReviewEvents | (הטבלאות לעיל) | — |
| **ניתוח** | אגרגציה read-only למדדי איכות | (חישוב בלבד) | `learning-center-metrics.ts` |
| **שיפור מנוע** | Dubiz קוראת את המדדים ומשפרת ידנית; bump גרסה | חתימת גרסה חדשה | ידני |

**נקודות קריטיות:**
- ה-Snapshot נלכד **ברגע החילוץ, לפני עריכת האדם** — כך שהוא משקף את אמונת-המנוע האמיתית ולא ערך מתוקן.
- ה-Snapshot רץ ב-Phase 2 (`after()`) של זרימת ה-two-phase upload; לכן הוא **best-effort ולעולם לא מפיל** את ההעלאה.
- ה-ReviewEvent נלכד בזמן האישור; ה-`belief` נטען מ-`ExtractedData` **לפני** הדריסה שלו בערכי האדם.

---

## 3. עקרונות התכנון

1. **Write-only / Shadow.** ה-Correction Ledger (Snapshot/Slice/Evidence/ReviewEvent) נרשם ואינו נקרא-חזרה להחלטת חילוץ. הוא ראיה, לא מנוע.
2. **Raw נשמר מילולית.** ללא entity-resolution, ללא נירמול, ללא ניחוש. `null`/`unknown` הם ערכי-אמת. כל נגזרת (normalized/outcome) נשמרת **לצד** הגולמי, לא במקומו.
3. **Append-only.** רק `create`. שורות לא מתעדכנות ולא נמחקות. כל מסמך×גרסה = שורה בלתי-משתנה.
4. **Never-throws.** כשל ב-ledger **לעולם** לא מפיל upload/approve. כל recorder עטוף try/catch.
5. **Version-stamped.** כל שורה חתומה ב-`liveEngineVersion`/`sliceEngineVersion` → השוואת-גרסאות מובנית מעצם הבנייה.
6. **Additive + discriminated.** הרחבות הן עמודות nullable + ערכי-String פתוחים → מצב/סוג/גרסה חדשים נכנסים בלי migration.
7. **Field-keyed generic.** ה-SliceDecision גנרי לפי `fieldKey` → שדה חדש נכנס כ-fieldKey חדש בלי שינוי סכימה.
8. **OCR text לא משוכפל.** נשמר hash בלבד (`ocrTextHash`), לא הטקסט.

---

## 4. מודל הנתונים

### שכבת החילוץ (הערך המפורסם)
- **`Document`** — הרשומה: `status` (processing/needs_review/approved/failed), `ocrText`, `source`, `mimeType`, `fileUrl`.
- **`ExtractedData`** (1:1 ל-Document) — הערך שהמשתמש רואה: amount, vendorName, date, category, direction, confidenceScore, amount/vendor/categoryConfidence. ⚠️ **נדרס בעת אישור** בערכי האדם.
- **`FinancialRecord`** (1:1) — נוצר באישור כספי; ה-final המאושר.

### שכבת הלמידה (ה-Ledger — Shadow, append-only)
- **`ExtractionSnapshot`** (per חילוץ) — אמונת-המנוע: vendorName, documentType, direction, amount, date, category, confidences, isFinancial, amountEligible, financialEvidenceLevel, guardrailRoute, `liveEngineVersion`, `sliceEngineVersion`, `ocrEngine/Version`, `ocrTextHash`, `geometryAvailable`, `sourceChannel`, `occurredAt`, `rawResult`.
- **`SliceDecision`** (6 שורות per snapshot) — החלטה per-שדה: `fieldKey` (amount/vendor/date/documentType.extracted, direction.interpreted, category.classified), `engineValue`, `legacyValue`, `confidenceLabel`, `producedBy` (slice/legacy), `layer`/`stage`. amount מיוצר גם ב-**Shadow slice** נפרד להשוואה.
- **`ExtractionEvidence`** (per snapshot, כשיש גיאומטריה) — `ocrGeometry`, `reasoningBlob`, `geometryHash`.
- **`ReviewEvent`** (per אישור) — פסיקת אנוש: לכל שדה `{belief, final, verdict, delta{old,new}}` (verdict ∈ confirmed/corrected/rejected/not-submitted), + `approvedAs`, `explicitFinancial`, `profileId`, `reviewerUserId`, `rawBelief`, `rawFinal`.

### שכבת הלמידה הפעילה (החריג — נקרא-חזרה)
- **`VendorLearning`** (per עסק+ספק) — `vendorName`, `category`, `confidence`, `usageCount`. **הלמידה היחידה שמשפיעה על המנוע:** `category-decision.service` קורא אותה כדי להציע קטגוריה למסמך הבא מאותו ספק. נכתבת ב-approve.

### הממשק
- **Learning Center** (`app/dev/learning-center` + `app/api/dev/learning-center`) — אנליטיקה **read-only, platform-admin, גלובלית** מעל 4 טבלאות ה-Ledger. לא per-business, ולא כולל `VendorLearning`.

---

## 5. שלושת פערי הלכידה והפתרון

> פערים **ארכיטקטוניים** — נתון שאם לא נלכד ברגע האמת, **לא ניתן להשלמה רטרואקטיבית**. לכן נסגרים לפני צבירת נפח.

| פער | הבעיה | הפתרון (additive) | Migration |
|---|---|---|---|
| **1. Survivorship bias** | חילוץ נכשל/ריק (`extracted=null`) → **אין snapshot**. הכשלים הקשים ביותר בלתי-נראים ללמידה. | הסרת שער `if (extracted)`; כתיבת snapshot תמיד עם `extractionOutcome` (`ok`/`empty_ocr`/`extraction_failed`). | `+ExtractionSnapshot.extractionOutcome` |
| **2. Vendor identity** | ספק נשמר כטקסט גולמי → 5 וריאנטים = 5 ספקים. אין ניתוח per-ספק ולא זיכרון אמין. | חיווט `normalizeVendorForLearning` (כבר קיים, לא בשימוש) כמפתח-קיבוץ **לצד** הגולמי. **דחוי:** rekey+merge של `VendorLearning`. | `+vendorNameNormalized` (nullable) |
| **3. documentType עיוור** | סוג-המסמך שולט על כל הניתוב, אך נשמר **בלי confidence ובלי verdict** — לעולם לא נדע אם המנוע צדק בו. | הזרמת `documentType.confidence` הקיים → snapshot; הוספת `documentType` ל-verdict-pipe (final=not-submitted עד ל-UI). | `+ExtractionSnapshot.documentTypeConfidence` |

**סה"כ ~3 עמודות additive-nullable, expand-only, בלי rewrite.** ה-migration המסוכן היחיד (מיזוג ספקים היסטורי) מבודד ונדחה.

---

## 6. הערך העתידי של כל נתון שנאסף

לכל נתון: מה נלכד · למה חשוב · אילו החלטות יאפשר.

### `extractionOutcome`
- **מה:** לכל מסמך — האם החילוץ הצליח ולמה לא. קודם: רק הצלחות.
- **למה:** מסיר survivorship bias; המכנה הופך לכל המסמכים.
- **מאפשר:** להכריע אם ה-ROI ב-OCR/preprocessing (אם `empty_ocr` דומיננטי) מול לוגיקת-חילוץ; לזהות ערוץ/סוג-קובץ בעייתי.

### `vendorNameNormalized`
- **מה:** מפתח-ספק יציב לצד הגולמי.
- **למה:** בלעדיו כל מדד per-ספק הוא רעש; הזיכרון הפעיל (`VendorLearning`) מתפצל.
- **מאפשר:** תבניות/priors per-ספק; תיקון mislearned vendor→category; זיכרון-ספק אמין.

### `documentTypeConfidence` (+ verdict-pipe)
- **מה:** כמה המנוע בטוח בסוג-המסמך, + חריץ verdict.
- **למה:** documentType הוא החלטת השורש; שגיאה בו פוסלת את כל השדות במורד מול הפרופיל הלא-נכון.
- **מאפשר:** לבדוק אם type-detection הוא **הגורם השורשי** לטעויות במורד (קורלציה type-confidence↔corrections), ולכוון תקציב שיפור upstream מול downstream.

### שלוש השאלות לכל נתון חדש
1. **מידע חדש:** קיום+סיבת כשל (1), זהות-ספק (2), בטחון-סוג (3) — שלושתם לא נאספו קודם.
2. **שיפור מנוע:** תעדוף OCR-מול-חילוץ (1), תבניות-ספק (2), upstream-מול-downstream (3).
3. **הרחבה בלי לגעת בלמידה:** ✅ לכל השלושה (String פתוח / חישוב-מחדש מ-raw / זרימה למבנה verdict קיים).

---

## 7. מדדים ודוחות — אחרי 50 / 500 / 5000 מסמכים

🆕 = תלוי בשדה מ-§5. תיוג מוכנות-נפח.

| # | דוח | שאלה | טבלאות/שדות | החלטה | 50 | 500 | 5000 |
|---|---|---|---|---|---|---|---|
| 1 | **שיעור כשלי חילוץ** 🆕 | כמה מפיקים כלום ולמה? | `extractionOutcome` × `source`/`mimeType` | OCR מול חילוץ; ערוץ בעייתי | ✅ | חיתוך-ערוץ | מגמה לאורך זמן |
| 2 | **correction rate/שדה** | איפה המנוע הכי חלש? | `ReviewEvent.verdicts` | תעדוף extractor; ספי auto-approve | ✅ | יציב | קוהורטות |
| 3 | **confidence גבוה שתוקן** 🆕 | איפה בטוח **וטועה**? | confidences × `verdict='corrected'` | כיול confidence; בטיחות auto-approve | 🟠 | ✅ | calibration |
| 4 | **ספקים עם הכי תיקונים** 🆕 | לאיזה ספק חוזר טועה? | `vendorNameNormalized` × corrections | תבניות per-ספק | 🔴 | ✅ | פרופילי-ספק |
| 5 | **Category confusion** | אילו קטגוריות מתחלפות? | `verdicts.category.delta` | תיקון מסווג; מיזוג/פיצול קטגוריות | 🟠 | ✅ | matrix מלא |
| 6 | **השוואת גרסאות** 🆕 | האם גרסה חדשה שיפרה? | `liveEngineVersion`/`sliceEngineVersion` × outcomes | לקדם/לגלגל-אחורה גרסה | 🔴 | דורש bump | ✅ |

**דוח 7 (מתקדם):** `documentTypeConfidence` נמוך מנבא correction גבוה במורד? → תעדוף upstream מול downstream.

**מפת תלות:** 2 ו-5 עובדים היום; 6 מוכן-תשתית; 1/3/4 נפתחים בזכות הפערים. סגירת 3 העמודות היא מה שהופך את החבילה מ"חלקית" ל"מכסה את כל צירי האיכות".

---

## 8. יכולות עתידיות — מה יגיע בלי לגעת בלמידה, ומה ידרוש הרחבה

| הרחבה | דורש שינוי? | למה |
|---|---|---|
| שדה חדש (VAT, מספר-חשבונית) | ❌ | `fieldKey` חדש ב-SliceDecision |
| גרסת מנוע חדשה | ❌ | חתימת-גרסה קיימת → השוואה אוטומטית |
| מצב-כישלון חדש | ❌ | ערך `extractionOutcome` חדש (String) |
| נירמול-ספק טוב יותר | ❌ | חישוב-מחדש מה-raw השמור |
| מדדים חדשים (confusion, calibration) | ❌ | הנתון כבר נשמר — רק שכבת-חישוב |
| **אות-אנוש חדש** (verdict ל-documentType, "סיבת תיקון") | ✅ | נתון חדש, לא נגזר — דורש נקודת-לכידה (בד"כ UI) |

**כלל:** יכולות **נגזרות** — בלי שינוי במנגנון. רק **אותות-אנוש חדשים** דורשים לכידה חדשה — ולכן מקדימים את הצינורות הזולים שלהם (verdict-pipe ל-documentType) כדי שיהיו מוכנים מראש.

---

## 9. עקרונות מחייבים (Non-negotiables — לא לשבור)

כל שינוי במנגנון הלמידה חייב לכבד את אלה. סטייה מחייבת עדכון המסמך הזה **תחילה**.

1. **Raw נשמר תמיד.** נגזרת נשמרת לצד הגולמי, לעולם לא במקומו. (מאפשר חישוב-מחדש עתידי.)
2. **Append-only.** רק `create` ל-Ledger. אין update/delete על ראיות. (מיזוג ספקים = פעולה מבוקרת ומתועדת בנפרד, לא חלק מהזרימה.)
3. **Never-throws.** כשל ב-ledger לא מפיל upload/approve. לעולם.
4. **Shadow / Write-only.** ה-Correction Ledger לא נקרא-חזרה להחלטת חילוץ. שינוי זה = שינוי ontology שדורש ratification.
5. **Version-stamped.** כל שורה חותמת גרסת-מנוע. שינוי בלוגיקת המנוע מחייב bump גרסה — אחרת ההשוואה מזדהמת.
6. **Additive-only הרחבות.** עמודות nullable, ערכי-String פתוחים. אין שינוי הרסני, אין שינוי משמעות של עמודה קיימת.
7. **לכידה ברגע-האמת.** אמונת-מנוע נלכדת בזמן חילוץ (לפני עריכה); פסיקת-אנוש בזמן אישור. נתון שלא נלכד ברגע הנכון = אבוד לצמיתות.
8. **הכל נלכד — גם כשלים.** no-extraction הוא artifact למידה, לא היעדר-נתון. (מונע survivorship bias.)
9. **הפרדת שכבות.** Documents = עובדות (extracted); Business = פרשנות (category/direction). ה-Ledger מתייג `layer`/`stage` בהתאם. לא לערבב.

---

## נספח — מיפוי קבצים

| תפקיד | קובץ |
|---|---|
| כתיבת Snapshot/ReviewEvent | `lib/services/documents/ledger/correction-ledger.service.ts` |
| פייפליין חילוץ (Phase 2) | `lib/services/documents/process-document-pipeline.service.ts` |
| מנוע חילוץ מאוחד | `lib/services/documents/unified-extraction-engine.service.ts` |
| זיהוי סוג-מסמך | `lib/services/documents/document-type.service.ts` |
| נירמול ספק (קיים, לחיווט) | `lib/services/documents/vendor-normalization.service.ts` (`normalizeVendorForLearning`) |
| למידת ספק (כתיבה) | `lib/services/documents/vendor-learning.service.ts` + `app/api/documents/[id]/approve/route.ts` |
| למידת ספק (קריאה-לתוך-החלטה) | `lib/services/documents/category-decision.service.ts` |
| אנליטיקה (read-only) | `lib/services/learning-center/learning-center-data.ts` + `learning-center-metrics.ts` |
| ממשק (platform-admin) | `app/dev/learning-center/` + `app/api/dev/learning-center/` |

---

*גרסה 1 — מסמך ייחוס. עדכונים למנגנון הלמידה מתחילים כאן, לא בקוד.*
