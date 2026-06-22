# Dubiz Supplier Domain — Structure Decisions v1

> **מסמך החלטה ממוקד — לא קוד, לא Prisma, לא migration, לא API, לא UI.** סוגר את ארבע הכרעות-המבנה מ-Implementation Design v1, שיקבעו את צורת ה-DB/API.
>
> נשען על: Constitution v1.2 · Design v1 · Implementation Design v1 · הקוד הקיים (`Party`, `PartyResolutionClaim`, `party-resolution.service.ts`, `party-backfill.deps.ts`, `Customer.taxId`, `Supplier`).
>
> סטטוס: Structure Decisions v1.

---

## הכרעה 1 — Supplier taxId + EMAIL

**Decision:**
- **להוסיף `taxId` + `taxIdType` אופציונליים ל-Supplier** (מראה את `Customer.taxId`/`taxIdType` הקיים).
- **להוסיף `SUPPLIER` ל-`PartyRoleType`**; להזין Supplier ל-resolver הקיים (`resolvePartyForRoleRowTx`) בדיוק כמו Customer: `taxId`→**KNOWN**, `phone`→**BELIEVED**, חסר-אות→**anchor claim** (SELF_ANCHOR/UNKNOWN).
- **EMAIL לא נכנס כ-`PartySignalType`.** נשאר תכונת-contact על ה-Supplier-role; corroboration לכל היותר, לעולם לא מפתח-מיזוג.
- **ה-`Supplier` table הופך ל-role-row (subject)**; הזהות דרך **claim ל-Party** (corrigible), **בלי `partyId` FK קשיח** — בדיוק כמו Customer/Lead.
- **supplierName נשאר Supporting/display בלבד** (מאושר בקוד: name נטען אך לעולם לא נפלט כ-signal-claim).

**Rationale:**
- `taxId` הוא האות ה-establishing החזק ביותר, כבר קיים על Customer ומוזן ל-resolver; הוספתו ל-Supplier פותחת זהות ברמת KNOWN **ומאחדת Customer↔Supplier "חינם"** (אותו taxId → אותו Party).
- EMAIL לספקים חלש ומשותף (`info@`, `orders@`, `sales@`) — הפיכתו למפתח-זהות תגרום **over-merge** של שני ספקים שונים החולקים תיבה כללית. זו בדיוק הסכנה ש-Entity Resolution אוסר.
- ה-`Supplier` table כבר נושא phone/email/name/isActive; אין סיבה להחליפו — רק לעגנו לזהות.

**Rejected alternatives:**
- *EMAIL כ-signal חזק* — נדחה (over-merge של תיבות כלליות).
- *`partyId` FK קשיח על Supplier* — נדחה: שובר את ה-corrigibility (claim ניתן ל-CHALLENGE/RETRACT; FK לא).
- *להחליף את `Supplier` ב-role-table חדשה* — נדחה: שובר API/נתונים קיימים ללא צורך.

**Consequences:**
- שדה taxId חדש (אופציונלי) + ערך enum חדש `SUPPLIER` + הרחבת ה-backfill/intake להזין Supplier.
- ספק בלי taxId/phone → anchor (Party מבודד, UNKNOWN) — totality בלי זיהום, ניתן לקידום מאוחר.
- EMAIL נשאר שמיש כ-contact ול-corroboration עתידי, לא כמפתח.

---

## הכרעה 2 — Mapping Subject Identity

**Decision:** **Option A — SupplierProduct כישות-Reference מטריאלית, עם materialization עצל (lazy).**
- ה-**subject של ה-Mapping הוא SupplierProduct**, ממופתח לפי `(supplierId + externalSku | barcode | normalizedName)`.
- SupplierProduct **מתממש כשיש בו צורך**: קטלוג (import/sync) או אקט-פתרון אנושי (MERGE/CREATE_NEW) — **לא** באופן eager לכל שורת-חשבונית/CSV.
- שורת חד-פעמית שלא נפתרה נשארת **Draft-line Evidence** ואינה מממשת SupplierProduct.

**Rationale:**
- **קטלוגים עתידיים** (API/Sync) דורשים ישות מטריאלית שתישא sku יציב, package, ו-price-history — tuple לא יכול להחזיק זאת.
- **materialization עצל** מונע רעש (אלפי "מוצרים" אפמריים משורות-חשבונית); מתממש רק על קטלוג או על פתרון.
- ישות יציבה נותנת **עוגן ל-correction ול-history**; ושומרת על הקטלוג כ-reference layer נקי.

**Rejected alternatives:**
- *Option B — tuple-only על ה-Mapping* — נדחה: לא יכול להחזיק catalog metadata / price-history, מאלץ denormalization של תכונות-ספק על כל קישור, ומאבד את עתיד-הקטלוג.
- *Materialization eager לכל שורה* — נדחה: רעש אפמרי.

**Consequences:**
- ישות `SupplierProduct` חדשה (Reference): supplierId, externalSku?, barcode?, name, packageDescriptor?, source/provenance, isActive.
- **חוק-משמעת:** SupplierProduct הוא Reported Reality בלבד; לעולם לא product-master; מצביע פנימה דרך Mapping (Invariant F3).
- מפתח-זהות `(supplierId + external identifier)` משמש גם ליצירה-עצלה וגם ל-dedup של מוצרי-ספק.

---

## הכרעה 3 — Measure Home

**Decision:** **Option A — Measure כשדות על RepresentationMapping**, עם **confidence + provenance עצמאיים משלו** (נפרדים מאלה של ה-Identity), **רוכבים על ה-corrigibility הקיימת של ה-Mapping** (status ACTIVE/CHALLENGED/RETRACTED + שורה חדשה ל-Revision). **Option B (sub-claim) שמור כשדרוג עתידי.**

**Rationale:**
- עקבי עם Representation Resolution: Measure הוא **ממד של ה-Mapping**, ולכן יושב עליו — עם confidence/provenance עצמאיים שמכבדים "שני ממדים, ברי-תיקון עצמאית".
- **Revision של Measure** (ספק עבר 12→6) = Mapping חדש/מאותגר; ההיסטוריה נשמרת דרך ה-corrigibility של ה-Mapping עצמו (שכבר append-only-corrigible).
- **catch-weight** אינו דורש sub-claim: הנומינלי על ה-Mapping (Reported), בפועל נלכד ב-Receiving (Physical) וגובר.
- פשוט לשלב 1 ולא חוסם פיצול עתידי ל-sub-claims.

**Rejected alternatives:**
- *Option B — measure sub-claim נפרד מיד* — נדחה לשלב 1: join + lifecycle נוספים עבור factor שלרוב יציב; premature. נשאר נתיב-שדרוג אם churn של Measure יצדיק versioning עצמאי.

**Consequences:**
- שדות על ה-Mapping: `purchaseUnitName`, `factor`, `measureConfidence`, `measureProvenance` (נפרדים מ-`identityConfidence`/`identityProvenance`).
- תיקון Measure = revision של ה-Mapping (שורה חדשה, הישנה נכונה-בזמנה).
- Receiving צורך את ה-factor לתרגום כמות+עלות; עלות-Record נקבעת שם בלבד.

---

## הכרעה 4 — HUMAN_CONFIRMED Method

**Decision:** **כן — `HUMAN_CONFIRMED` נכנס כ-resolution method רשמי.**
- ב-**Mapping** (enum מתודה משלו): `DETERMINISTIC_EXACT` (barcode/SKU machine match), `HUMAN_CONFIRMED` (MERGE/CREATE_NEW של הבעל), `SELF_ANCHOR` (fallback).
- ב-**Party Resolution**: להוסיף `HUMAN_CONFIRMED` ל-`PartyResolutionMethod` (קיים: DETERMINISTIC_EXACT, SELF_ANCHOR) — לאישור-בעל של זהות-ספק/קישור.
- `resolvedByUserId` + `source` נשארים ה-**provenance** (מי/מאיפה); `method` הוא ה-**HOW** (הדרגה האפיסטמית).

**Rationale:**
- ה-canon: הבעל הוא **source of truth** (Human-Confirmed Reality), לא רק approver. קישור human-confirmed הוא הדרגה הגבוהה ביותר.
- `method` ≠ `provenance`: ה-method קובע את תקרת-האמון ואת סמנטיקת-התיקון — **קישור HUMAN_CONFIRMED לא נדרס בשקט ע"י ניחוש-מכונה חלש מאוחר**. זה הופך מדיניות זו למפורשת ובת-שאילתה.
- מבדיל "exact external evidence" (מכונה) מ"החלטת בעל" — בדיוק ההבחנה שביקשת.

**Rejected alternatives:**
- *להסתפק ב-provenance (`source`/`resolvedByUserId`)* — נדחה: לא מבטא את דרגת-האמון ולא מגן מפני override-אוטומטי חלש.
- *להשתמש ב-DETERMINISTIC_EXACT גם להחלטת-אדם* — נדחה: מערבב שתי דרגות-אמון שונות מהותית.

**Consequences:**
- ערך enum `HUMAN_CONFIRMED` נוסף (ב-Mapping method, וגם ב-PartyResolutionMethod). **Additive** — claims קיימים נשארים DETERMINISTIC_EXACT/SELF_ANCHOR.
- מדיניות override: weak-auto לא דורס HUMAN_CONFIRMED (רק human או ראיה חזקה-יותר).

---

## סיכום ההכרעות

| # | הכרעה |
|---|---|
| 1 | Supplier מקבל taxId/taxIdType אופציונליים; SUPPLIER נכנס ל-PartyRoleType; resolution דרך phone/taxId+anchor; **EMAIL לא signal**; Supplier=role-row, זהות דרך claim (לא FK); name=Supporting |
| 2 | **SupplierProduct מטריאלי (lazy)**, subject של ה-Mapping, ממופתח `(supplierId + external id)`; שורה חד-פעמית לא-פתורה נשארת Evidence |
| 3 | **Measure = שדות על ה-Mapping** עם confidence/provenance עצמאיים, על גבי corrigibility קיימת; sub-claim שמור לעתיד |
| 4 | **HUMAN_CONFIRMED = method רשמי** (Mapping + Party); method=HOW, provenance=WHO/WHERE |

---

## מסקנה

ארבע הכרעות-המבנה **סגורות**, וכולן מתיישבות עם Constitution v1.2 ועם הדפוס המוכח בקוד (`PartyResolutionClaim`). הן קובעות באופן חד-משמעי את הישויות, המפתחות, ה-enums והקשרים שיידרשו.

> **אפשר לעבור ל-DB Schema Design מלא.** אין אי-ודאות מבנית שנותרה: ידועים השדות החדשים (Supplier.taxId, ערכי-enum SUPPLIER/HUMAN_CONFIRMED), הישויות החדשות (SupplierProduct, RepresentationMapping עם Measure-fields), ומודל-הקישור (claim corrigible, לא FK). שלב ה-DB Schema Design יתרגם אותן למבנה קונקרטי.
