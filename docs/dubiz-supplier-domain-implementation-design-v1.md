# Dubiz Supplier Domain — Implementation Design v1

> **עיצוב מימוש מושגי — לא קוד, לא Prisma, לא migration.sql, לא API, לא UI.** איך מתרגמים את ה-Domain Model למבני-מערכת, *לפני* שכותבים אותם.
>
> **Scope:** שתי השכבות הראשונות בלבד — **(1) Supplier as Party Role** ו-**(2) Representation Resolution / Mapping**. *לא* Draft→PO→Receiving (קיימים חלקית), *לא* קטלוג/API/UI.
>
> **נשען על:** `dubiz-supplier-domain-constitution-v1.md` (v1.2) · `dubiz-supplier-domain-design-v1.md` · `AGENTS` supplier-domain-rules · הקוד הקיים (`Party`, `PartyResolutionClaim`, `party-resolution.service.ts`, `Supplier`, `SupplierPurchaseDraft`, `PurchaseOrder`, `Receiving`) · ה-Ground-Truth Audits.
>
> סטטוס: Implementation Design v1.

---

## נקודת המוצא שהתגלתה בקוד (עובדה מכרעת)

תשתית ה-Resolution **כבר קיימת ומוכחת** — אך לא חוברה לספקים:
- `Party` (עוגן-זהות) + `PartyResolutionClaim` (קישור subject↔Party נושא **confidence + provenance + method + status**).
- שירות `resolvePartyForRoleRowTx` — exact-match דטרמיניסטי על אותות חזקים, **fail-safe על signal-conflict** (מבודד ל-Party משלו בלי לזהם), **anchor-claim** ל-subject חסר-אות, ו-conflict-detection.
- `PartyClaimConfidence` = KNOWN/BELIEVED/SUSPECTED/UNKNOWN · `PartyClaimStatus` = ACTIVE/CHALLENGED/RETRACTED (corrigibility) · `PartyResolutionMethod` = DETERMINISTIC_EXACT/SELF_ANCHOR.
- **אבל `PartyRoleType` = CUSTOMER, LEAD בלבד** — Supplier אינו role; `PartySignalType` = PHONE, TAX_ID בלבד; ל-`Supplier` יש phone/email אך **אין taxId**.

> **המשמעות:** שכבה 1 (Supplier as Party Role) היא **הרחבה של מנגנון קיים**. שכבה 2 (Mapping) היא **אותו דפוס, מוחל על מוצרים** (target = InventoryItem במקום Party, + ממד Measure). אנחנו לא ממציאים — אנחנו מכלילים.

---

## A. Current State → Target State

| היבט | מצב היום | הבעיה | מצב רצוי | מה אסור לשבור |
|---|---|---|---|---|
| **זהות ספק** | טבלת `Supplier` מנותקת; אין `partyId`; אין role | אין עוגן-זהות; Customer↔Supplier לא מתחברים | `Supplier` הוא **role-row** שנפתר ל-`Party` דרך claim | רשומות Supplier קיימות; ה-API הקיים |
| **שם ספק בזרימה** | `supplierName` string על Item/Draft/PO | מקור-אמת מדומה; כפילויות; חוסר-קישור | `supplierName` = **label/fallback** בלבד; הזהות ב-Party | snapshots היסטוריים של supplierName ב-PO (Commitment record) |
| **Supplier↔Inventory** | אין relation | אי-אפשר "מה ספק X מוכר לי" | קישור דרך **Mapping** (לא ישיר) | ריבונות ה-InventoryItem |
| **Supplier Product** | לא קיים | אין ייצוג-ספק מפורש | ישות-Reference (Reported Reality) | — (greenfield) |
| **Mapping** | החלטת `MERGE/CREATE_NEW` ב-Draft, **לא נשמרת** | אין למידה; פותרים מחדש כל פעם | **Representation Mapping** קבוע (Identity + Measure), נושא confidence/provenance, corrigible | `matchedItemId` הזמני הקיים |
| **יחידה/אריזה** | `InventoryUnitType` על הפריט בלבד | אין המרת purchase-unit↔stock-unit | **Measure** על ה-Mapping | יחידת-הפריט הפנימית |

---

## B. Conceptual System Objects

> בלי Prisma. כל אובייקט: אחריות · מה הוא מחזיק · מה הוא לא מחזיק · קשרים.

### Party *(קיים)*
- **אחריות:** עוגן-זהות יציב פר-business.
- **מחזיק:** id, businessId. (זהות "ריקה" — המשמעות מגיעה מה-claims.)
- **לא מחזיק:** שום מאפיין-תוכן (שם/טלפון); אלה על ה-role-rows.
- **קשרים:** ↔ `PartyResolutionClaim[]`; דרכם ↔ role-rows (Customer/Lead/**Supplier**).

### Supplier Role *(הרחבה של `Supplier` הקיים)*
- **אחריות:** להיות ה-**role-row** "מוכר-לעסק" — subject שנפתר ל-Party. עוגן ל-Connection/Catalog/Mapping/price-history.
- **מחזיק:** מאפייני-תצוגה ותפעול (name כ-**label**, phone, email, leadTime, isActive). אותות-זהות חזקים (phone, ובעתיד **taxId**) להזנת ה-resolver.
- **לא מחזיק:** את זהותו (זו ב-Party); יתרות/תשלום; אמת-מלאי.
- **קשרים:** subject ב-`PartyResolutionClaim` (subjectType = **SUPPLIER** חדש); ↔ Catalog; כתובת ל-PO.

### Supplier Contact / Channel *(חלק מ-Connection — VO על ה-Supplier-role)*
- **אחריות:** לתאר *איך* מגיעים לספק ומה הוא יודע לעשות (WhatsApp/Email/PDF baseline; אופציונלי: catalog/price/status).
- **מחזיק:** ערוצים + (בעתיד) credentials/config עם מצב configured/active/revoked.
- **לא מחזיק:** זהות; לוגיקת-flow.
- **קשרים:** composition על Supplier-role; נשאל בזמן-ריצה.

### Supplier Product *(greenfield — Reference)*
- **אחריות:** לייצג פריט **כפי שהספק מוכר אותו** (SKU שלו, שם, אריזה). Reported Reality.
- **מחזיק:** מזהי-ספק (sku/barcode/name), יחידת-רכש מוצהרת.
- **לא מחזיק:** Record; זהות-מוצר פנימית; כמות-מלאי.
- **קשרים:** member ב-Catalog של ספק; subject ב-**Representation Mapping**.

### Supplier Catalog Entry *(greenfield — Reference)*
- **אחריות:** שורת-קטלוג = Supplier Product + תכונותיו המדווחות הנוכחיות (מחיר per-purchase-unit, זמינות), נושאת timestamp.
- **מחזיק:** Evidence-מחיר/זמינות (Reported Reality + provenance + זמן).
- **לא מחזיק:** עלות-Record; אמת.
- **קשרים:** ↔ Supplier Product; ↔ Supplier (catalog).

### Representation Mapping *(greenfield — לב שכבה 2)*
- **אחריות:** קישור-אמונה **Supplier Product ↔ Inventory Item** בשני ממדים (Identity + Measure). *מקביל מבני ל-`PartyResolutionClaim`, אך target = InventoryItem.*
- **מחזיק:** הפניית-subject (supplier-product / זהות-שורת-ספק), הפניית-target (InventoryItem), **Measure**, **confidence**, **provenance/method**, **status**.
- **לא מחזיק:** מלאי; זהות-פנימית שהוא דורס; עלות-Record.
- **קשרים:** subject↔target; ↔ Mapping Evidence.

### Mapping Evidence *(provenance של ה-Mapping)*
- **אחריות:** לתעד *אילו אותות ומאיזה אירוע* הצדיקו כל ממד ("barcode תאם בקטלוג #..", "הבעל אישר ב-Draft #.. approval", "factor נצפה בקליטה #..").
- **מחזיק:** signalType (sku/barcode/name/unit), source-event, user.
- **לא מחזיק:** הכרעה (היא ב-confidence/status של ה-Mapping).
- **קשרים:** מצביע על Mapping; מאפשר un-map בטוח (כמו provenance ב-PartyResolutionClaim).

### Measure / Conversion *(payload על ה-Mapping)*
- **אחריות:** **Representation Conversion** — תרגום ייצוג-ספק↔פנימי (יחידה/אריזה/נפח/משקל/catch-weight/factor/עתידי).
- **מחזיק:** factor + יחידת-מקור (purchase-unit) + provenance + confidence משלו.
- **לא מחזיק:** כמות-מלאי; אינו קובע עלות (Receiving קובע).
- **קשרים:** ממד שני של ה-Mapping; נצרך ב-Receiving לתרגום כמות+עלות.

### Confidence / Provenance *(Value Objects — reuse)*
- **אחריות:** רצועות-ביטחון (Known/Believed/Suspected/Unknown) + מקור-הצדקה. **לעשות reuse ל-`PartyClaimConfidence`** ולדפוס ה-provenance הקיים.
- **לא מחזיק:** סמנטיקה ספציפית-לתחום — הם פרימיטיבים חוצי-מערכת.

### Legacy supplierName fallback *(demotion של הקיים)*
- **אחריות:** להמשיך להציג/לזהות ספק בזרימות ישנות וכשעוד אין Supplier-role.
- **מחזיק:** מחרוזת חופשית (כפי שהיום על Item/Draft/PO).
- **לא מחזיק:** **סמכות-זהות** — דמוטד ל-display/fallback; לעולם לא מקור-אמת.
- **קשרים:** ניתן לקידום ל-Supplier-role דרך resolution; snapshot היסטורי ב-PO נשאר immutable.

---

## C. Migration Strategy (ברמת עיקרון)

עיקרון-על: **Additive, lazy, fail-safe — אף פעם לא "ניקוי גדול" כפוי.** (תואם את דפוס `party-backfill.service.ts` הקיים.)

1. **לחיות עם supplierName:** הוא נשאר בכל מקום. אין מחיקה. כל זרימה קיימת ממשיכה לעבוד עם המחרוזת כ-fallback.
2. **קידום הדרגתי:** כשמשתמש פועל מול ספק (יצירה/בחירה), ה-supplierName **יכול** להיפתר/להיווצר כ-Supplier-role ואז ל-Party (דרך phone/taxId אם יש; אחרת **anchor-claim** ל-Party משלו — בדיוק כמו subjects חסרי-אות היום). אופציונלי, לא חוסם.
3. **Backfill בטוח:** רשומות `Supplier` קיימות נפתרות ל-Parties (anchor או לפי phone). מחרוזות supplierName על Draft/PO ניתנות לקישור ל-Supplier-role לפי **exact normalized-name** (דטרמיניסטי); עמימות → **נשאר string** (Suspected), לא ממזג.
4. **לא לשבור הזמנות ישנות:** ה-`supplierName` שנרשם על PO הוא **snapshot של Commitment** — immutable. ה-resolution הוא additive (מוסיף קישור-Party), **לעולם לא משכתב** את המחרוזת ההיסטורית.
5. **זיהוי כפילויות בזהירות (Party Resolution):** אותו **taxId/phone** → אותו Party (מתאחד, כולל Customer↔Supplier). **name בלבד → נשאר נפרד** (Suspected), מוצף ייעוצית (ה-`findPossibleMatches` הקיים כבר עושה זאת — לא חוסם, לא ממזג).

> תוצר-לוואי "חינם": ברגע ש-Supplier נפתר ל-Party לפי taxId/phone, אם אותו Party כבר נושא role של Customer — **Customer↔Supplier מתאחדים אוטומטית** (הפער ש-Party Resolution Investigation סימן).

---

## D. Mapping Learning (איך הלמידה נוצרת)

הדפוס: **כל אקט-פתרון אנושי ב-Draft הופך ל-Mapping קבוע בר-שימוש-חוזר** (היום הוא זמני ב-`matchedItemId` ונזרק).

| אירוע ב-Draft | מה נכתב כ-Mapping | confidence | provenance/method |
|---|---|---|---|
| **MERGE** (הבעל בחר InventoryItem קיים) | קישור supplier-line-identity → InventoryItem | **KNOWN** | HUMAN_CONFIRMED · "draft #X approval, user #Y" |
| **CREATE_NEW** (פריט חדש נוצר) | קישור supplier-line-identity → הפריט החדש | **KNOWN** | HUMAN_CONFIRMED |
| **auto-match לפי barcode/SKU** (לפני אישור) | מועמד-קישור | **BELIEVED** | DETERMINISTIC · "barcode match, catalog #" |
| **name-only match** | **לא נכתב כ-auto** | **SUSPECTED** | מוצף לאדם; נכתב רק אם אושר |

- **מתי לא שומרים:** כשלשורת-הספק אין מזהה יציב (אין SKU/barcode **וגם** רק name חלש) — קישור name-only מסכן false-positive עתידי. נשמר רק כ-Suspected/לא-auto-apply, דורש אישור חוזר.
- **confidence:** human-confirmed → KNOWN; barcode/SKU exact → BELIEVED; name-only → SUSPECTED (לעולם לא auto-apply).
- **provenance:** איזה אות (sku/barcode/name) + איזה אירוע (draft approval / catalog import) + user. (reuse של שדות `PartyResolutionClaim`.)
- **תיקון-משתמש:** מיפוי-מחדש בקליטה מאוחרת = **CHALLENGE** הקישור הישן + יצירת חדש (Revision). reuse של `PartyClaimStatus` (ACTIVE→CHALLENGED→RETRACTED).
- **מניעת over-merge:** לעולם לא auto-map על name לבד; **signal-conflict fail-safe** — אותו supplier-SKU שמצביע על שני פריטים שונים → conflict, לא פותר אוטומטית, מצף (מראה את `createClaimTx` conflict-detection הקיים).

---

## E. Measure / Representation Conversion

- **purchase-unit מול stock-unit:** הספק מוכר ב"ארגז"; המלאי ב"בקבוק". ה-**factor** (12) יושב על ה-Mapping (relational — שייך לזוג, לא לאף צד).
- **confidence/provenance של ה-factor:** מדווח-בקטלוג = **Reported** (נמוך); אושר-ע"י-הבעל = **KNOWN**; **נצפה-בקליטה** (אדם ספר 12 בארגז) = **Physically-Verified** (גבוה).
- **catch-weight:** ה-factor הנומינלי הוא ברירת-מחדל (Reported/נמוך); הכמות **בפועל** נלכדת ב-Receiving (Physical) ו**גוברת** לאותו אירוע. אין מנגנון חדש — סולם ה-provenance מכריע.
- **conversion correction:** ספק עבר 12→6 → **Update** (factor חדש, הישן נכון-בזמנו); factor שגוי → **Revision**. (reuse של 3 מצבי-התיקון.)
- **תרגום עלות ב-Receiving:** מחיר-ספק per-purchase-unit ÷ factor = **עלות per-stock-unit**, נרשמת כ-`lastPurchaseCost` ב-Receiving. (הרחבה של `receiving.service` הקיים, שכבר קובע `lastPurchaseCost` מ-`unitCost` — כעת דרך ה-Measure.) **העלות-Record נקבעת רק כאן.**

---

## F. Invariants (במימוש)

1. **Supplier Product לא יוצר InventoryItem בלי החלטת-משתמש.** materialization רק דרך CREATE_NEW אנושי.
2. **Mapping לא משנה מלאי.** רק Receiving כותב ל-Record.
3. **Mapping לא דורס Product Identity.** מצביע פנימה; InventoryItem לעולם לא מוגדר ע"י supplier-product (זהות או Measure).
4. **supplierName לא מקור-אמת.** display/fallback בלבד; snapshots היסטוריים immutable.
5. **Evidence מספק לא מקבל סמכות אוטומטית.** Reported Reality; pre-fill בלבד; לא דורס החלטת-בעל.
6. **Resolution fail-safe.** לא auto-merge על אות חלש (name); signal-conflict → בידוד + הצפה (party וגם mapping).
7. **כל claim (party / mapping / measure) corrigible.** challenge/retract, לעולם לא מחיקה שקטה.
8. **Supplier identity דרך Party Resolution בלבד.** הרכש לא מכונן זהות-ספק ריבונית מ-name.
9. **Measure לא קובע עלות.** עלות-Record ב-Receiving בלבד.

---

## G. Open Questions (חוסמות Implementation Design — בלבד)

ארבע, כולן **הכרעות-עיצוב תחומות** (לא מחקר):

1. **taxId על Supplier + EMAIL כ-PartySignalType.** היום ל-Supplier יש phone/email אך **לא taxId**, ו-`PartySignalType` = PHONE/TAX_ID בלבד. כדי לפתור ספקים ב-**KNOWN** (taxId = האות החזק ביותר) ולאחד מול Customers, נדרש: להוסיף taxId ל-Supplier ו/או EMAIL כ-signal. **האם להוסיף taxId ל-Supplier?** (המאפשר היחיד הגדול ביותר לזהות-ספק.)
2. **זהות ה-subject של Mapping.** כשעוד אין Supplier Product מטריאלי — האם ה-Mapping מצביע מ-**ישות Supplier Product**, או מ-**tuple זהות-שורת-ספק** (supplierId + sku|barcode|normalized-name)? משפיע אם חובה ליצור Supplier Product לפני מיפוי.
3. **בית ה-Measure.** האם Measure הוא שדות על ה-Mapping, או **sub-claim corrigible נפרד** (כדי שיהיה ניתן לאתגר/לתקן עצמאית מהזהות)? (נטייה: אותה רשומה, אך שדות בעלי provenance/confidence עצמאיים.)
4. **method enum למיפוי.** נדרש `HUMAN_CONFIRMED` (ל-`PartyResolutionMethod` יש DETERMINISTIC_EXACT/SELF_ANCHOR). מינורי — שמות.

> אלה **"איזה מבנה", לא "מה נכון"** — ולכן הן הכרעות הפתיחה של שלב ה-DB/API, לא פערים מושגיים.

---

## תשובה: האם אפשר לעבור ל-DB/API/UI?

**כן — אין פער Conceptual שמונע מימוש בטוח.** המודל הוא ביטוי ישיר של ה-Constitution v1.2, ו**הדפוס המרכזי כבר מוכח בקוד** (`PartyResolutionClaim` + `resolvePartyForRoleRowTx`), כך ששתי השכבות הן הכללה של מנגנון קיים ולא בנייה מאפס. ארבע ה-Open Questions הן הכרעות-מבנה תחומות שיש לסגור **כצעדים הראשונים** של שלב ה-DB/API — לא חקירות, ולא חוסמות-מושג. עם סגירתן, המעבר לתכנון DB/API/UI בטוח.
