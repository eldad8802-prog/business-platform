# Dubiz Supplier Domain — Service / API Design v1

> **תכנון שירותים ו-API מושגי בלבד — לא קוד, לא Prisma, לא endpoints בפועל, לא UI.** מתרגם את DB Schema Design v1 לשכבת שירותים — בלי לבנותה.
>
> **שכבה ראשונה:** Supplier Resolution (להפוך Supplier ל-Party Role יציב), ואז הקרקע ל-SupplierProduct ו-Mapping. הסדר מחייב — Mapping נשען על SupplierProduct שנשען על Supplier מזוהה.
>
> נשען על: Constitution v1.2 · Design v1 · Implementation Design v1 · Structure Decisions v1 · DB Schema Design v1 · AGENTS supplier-domain-rules · הקוד הקיים (`resolvePartyForRoleRowTx`, `createClaimTx`, `createAnchorClaimTx`, `lookupPartyForRoleRow`, `party-backfill.deps.ts`, `supplier.service.ts`, `Customer.taxId`, Draft/PO/Receiving).
>
> סטטוס: Service/API Design v1.

---

## Part 1 — Supplier Resolution Service

**החלטה: wrapper דק `resolveSupplierParty` מעל `resolvePartyForRoleRowTx` הקיים** — לא לוגיקה חדשה. ה-wrapper ממפה שדות-Supplier לקלט הגנרי, מתייג source, ונותן seam למדיניות-ספק עתידית; כל לוגיקת ה-resolution נשארת בגנרי המוכח.

### Inputs
`{ tx, businessId, supplierId, taxId?, phone? , source, resolvedByUserId? }` → ממופה ל-`resolvePartyForRoleRowTx({ subjectType: SUPPLIER, subjectId: supplierId, signals: { phone, taxId }, source, resolvedByUserId })`.
- **name / email — לא מועברים.** (הגנרי קורא רק phone+taxId דרך `extractStrongSignals`; email אינו פרמטר כלל — בלתי-אפשרי מבנית להזינו. name מתעלם.)

### Outputs
תוצאת הגנרי: `{ party, claims, outcome, signalConflict }`. ה-wrapper מציף: `partyId`, ה-claims (עם confidence), `outcome` (APPLIED/NOOP/CONFLICT/SINGLETON), `signalConflict`.

### איך כל אות מוזן
| מקור | claim (דרך הגנרי) |
|---|---|
| `taxId` | TAX_ID → **KNOWN**, DETERMINISTIC_EXACT |
| `phone` | PHONE → **BELIEVED**, DETERMINISTIC_EXACT |
| חסר-אות | Party חדש + **anchor claim** (SELF_ANCHOR/UNKNOWN) |
| `name` | אין claim — Supporting/display |
| `email` | אין claim — contact/corroboration |

### Flow
- **Create Supplier → Resolve:** אחרי יצירת השורה, באותו tx, `resolveSupplierParty`. taxId/phone → קישור/יצירת Party; חסר → anchor מבודד.
- **Update taxId/phone → Re-resolve:**
  - *הוספת אות חדש* (היה null) → claim חדש; הגנרי מקשר ל-Party או מזהה conflict (idempotent — NOOP אם זהה).
  - *שינוי ערך-אות* (taxId X→Y) → הגנרי זורק `ConflictError` על signal-conflict; לכן ה-service **מאתגר/מבטל (RETRACT) את ה-claim הישן ויוצר חדש** (Revision). עשוי להצביע ל-Party אחר → להציף, ואם זה ימזג/יפצל Parties — לדרוש אישור.
- **Deactivate Supplier (isActive=false):** **claims נשארים ACTIVE.** זהות ≠ פעילות-תפעולית; deactivation לא מבטל זהות (הזמנות היסטוריות נשענות עליה). רק תיקון-זהות מפורש מבטל claim.
- **Merge/split עתידי:** **לא בונים עכשיו.** מסתמכים על convergence אוטומטי (אות חזק משותף → אותו Party); name-only נשאר נפרד (Suspected, ייעוצי דרך findPossibleMatches).

---

## Part 2 — Supplier Service Changes

| method | התנהגות אחרי Party-Role |
|---|---|
| **createSupplier** | יצירה + `resolveSupplierParty` **באותו transaction**. מחזיר supplier + partyId + possibleMatches. כפילות-שורה מותרת (אין dedup-block קיים), אך מתכנסת לאותו Party אם אות-חזק משותף |
| **updateSupplier** | resolution רץ **רק אם taxId/phone השתנו** (הוספה/שינוי). שינוי name/email/notes → **בלי** resolution. שינוי-ערך-אות → retract-old + create-new claim |
| **deactivateSupplier** | isActive=false; **claims ללא שינוי**; אין re-resolution |
| **findPossibleMatches** | הופך **Party-aware**: בהוספת taxId, מציף ספקים/לקוחות החולקים אותו taxId (אותו Party). ייעוצי, **לא חוסם** — זהו משטח "זיהוי כפילויות בזהירות" |

- **מתי resolution:** create (תמיד), update (רק על שינוי-אות-חזק), backfill (batch).
- **Transaction:** כן — create+resolve אטומי (מראה את `TxOptions` הקיים).
- **Idempotency:** `createClaimTx` מחזיר NOOP אם קיים; re-resolve בטוח.
- **לא שובר קיימים:** taxId nullable; ספקים קיימים לא נוגעים עד backfill/update הבא.
- **מניעת over-merge:** convergence רק על אות-חזק; name/email לעולם לא ממזגים.

---

## Part 3 — Backfill / Lazy Upgrade (עיקרון)

- **Batch:** הרחבת `party-backfill` הקיים (dry-run + fail-closed migration guard) ב-`loadSuppliers(phone, taxId, name)` → resolve כל אחד כ-SUPPLIER. חסר-אות → anchor; phone → BELIEVED (מתכנס עם Customer החולק phone).
- **Lazy:** גם resolve-on-use — Supplier שנגע בו (update עם taxId / שימוש בזרימה) ואין לו claim → resolve אז. שני נתיבים (batch + lazy), שניהם idempotent.
- **מניעת Parties כפולים:** candidate-lookup-by-signal של הגנרי מונע כפילות לאות-חזק משותף. anchors חסרי-אות → Party משלהם (נכון — באמת לא-מזוהים); הוספת taxId מאוחר → convergence (retract anchor, link ל-Party של האות).
- **ספקי name-only:** anchor ל-Party משלהם (UNKNOWN); **לא** ממוזגים; findPossibleMatches מציף דמיון-שם ייעוצית.
- **supplierName legacy:** לא נוגעים; נשאר display/fallback.

---

## Part 4 — SupplierProduct Materialization Service

`ensureSupplierProduct(tx, { businessId, supplierId, externalSku?, barcode?, externalName, packageDescriptor?, source })`:
- **מתי קוראים:** בנקודת-**resolution** — שורת-Draft שנפתרת (MERGE/CREATE_NEW) ונושאת זהות-מוצר-ספק, **או** catalog import. **לא** לכל שורת-draft ביצירה.
- **חיפוש קיים:** לפי קדימות-מפתח: (supplierId+externalSku) → (supplierId+barcode) → (supplierId+normalizedName).
- **יצירה:** אם לא נמצא **ו**יש מזהה יציב (SKU/barcode) **או** מתבצע resolution אנושי.
- **מתי לא יוצר:** שורה עם name חלש בלבד וללא החלטת-resolution → **לא מממש** (נשאר Draft-line Evidence).
- **נמנע מ-eager:** נקרא רק ב-resolution/catalog, לעולם לא bulk per-line.
- **Reference בלבד:** isActive + source/provenance; לא נוגע במלאי; אין תכונות סמכותיות. Idempotent.

---

## Part 5 — Mapping Learning Service

`learnRepresentationMapping` — מופעל מ-**Draft approval (MERGE/CREATE_NEW)**.
- **טריגר:** שורת-Draft אושרה עם MERGE (→פריט קיים) או CREATE_NEW (→פריט חדש) = ה-resolution האנושי.
- **מתי לומדים:** כשיש זהות-מוצר-ספק יציבה. שלבים: `ensureSupplierProduct` → יצירת RepresentationMapping (SupplierProduct→InventoryItem).
- **מתי לא לומדים:** name-only חד-פעמי ללא מזהה יציב → **לא נשמר** (או SUSPECTED non-auto). נשאר ה-`matchedItemId` הזמני.
- **identityConfidence:** human MERGE/CREATE_NEW → **KNOWN** (HUMAN_CONFIRMED); auto barcode/SKU → BELIEVED (DETERMINISTIC_EXACT); name-only → SUSPECTED.
- **identityProvenance:** source=`draft:{id}:line:{lineId}`, resolvedByUserId, identitySignal (EXTERNAL_SKU/BARCODE/NAME).
- **method:** HUMAN_CONFIRMED כשהבעל הכריע.
- **Append-only/corrigible:** יוצר ACTIVE. אם קיים ACTIVE ל-supplierProduct:
  - אותו target → **NOOP**.
  - target אחר → **RETRACT הישן + ACTIVE חדש** (Revision; partial-unique-active מאלץ retract-first).
- **Conflict:**
  - supplierProduct כבר mapped לפריט אחר → re-map אנושי = retract+new (מותר; הבעל מתקן). ניסיון auto/חלש → **חסום** (לא דורס HUMAN_CONFIRMED).
  - אותו externalSku בשם חדש → ה-SupplierProduct ממופתח ב-SKU; השם מתעדכן, ה-mapping עומד.
  - משתמש מתקן mapping → retract+new; הישן נשמר כהיסטוריה.

---

## Part 6 — Measure Conversion Service

helpers של **derivation בלבד** (לא כותבים מלאי):
- **קריאת factor:** מ-ה-mapping ה-ACTIVE (`factor`, nominal). אין mapping / factor null → **1:1**.
- **purchaseQty → stockQty:** `stockQty = purchaseQty × factor`.
- **purchaseUnitCost → stockUnitCost:** `stockUnitCost = purchaseUnitCost / factor`.
- **catch-weight ב-Receiving:** ה-nominal מ-pre-fill מציפה ציפייה; הקולט מזין את ה-**actual** (stock-units, או purchase-units + factor נמדד). ה-ReceivingLine שומר snapshot של ה-factor **בפועל**; `receivedQty` (stock-units) הוא האמת. עלות per-stock-unit מחושבת מה-actual.
- **Snapshots:** ב-PO commit → purchaseUnitName/purchaseQty/conversionFactorSnapshot (nominal). ב-Receiving → purchaseUnitName/receivedPurchaseQty/conversionFactorSnapshot (actual). נכתבים ע"י שירותי ה-PO/Receiving מערכי ה-helper, immutable.
- **אין factor:** 1:1 (ברירת-מחדל בטוחה).
- **factor challenged/retracted:** הזמנות **חדשות** → ה-factor ה-ACTIVE הנוכחי; PO/Receiving **קיימים** → ה-snapshot גובר (היסטוריה immutable; retract לא משכתב עבר).

> **אינווריאנט:** conversion הוא derivation בלבד; **לעולם לא כותב מלאי.** מלאי זז רק ב-Receiving POST הקיים.

---

## Part 7 — API Surface (design-level)

| תחום | endpoint | public/internal | משתמש | מתי |
|---|---|---|---|---|
| **Supplier** | create (+resolve) | public | UI ספקים | **now** |
| | update (+conditional re-resolve) | public | UI | **now** |
| | list / get / deactivate | public | UI | now (קיימים) |
| | resolve / re-resolve | **internal** | side-effect של create/update/backfill | now |
| **SupplierProduct** | list by supplier | public | UI קטלוג | later |
| | search catalog | public | UI | later |
| | materialize | **internal** | side-effect של draft/catalog | now (internal) |
| **Mapping** | create/confirm | **internal** | side-effect של draft approval | now |
| | challenge / retract | public | UI תיקון | **later (Phase 2)** |
| | suggest mappings | internal/read | pending UI | later |
| | list for supplier/product | internal/read | — | later |
| **Draft** | approve MERGE/CREATE_NEW → learn mapping | הרחבת endpoint **קיים** | זרימת קליטה | now (additive בתוך approve) |
| **Receiving** | receive using factor snapshot | הרחבת endpoints **קיימים** | קליטה | **later (Phase 2)** — Phase 1 נשאר 1:1 |
| | correction אם factor שגוי | public | UI | later |

---

## Part 8 — Invariants / Failure Modes (במימוש השירותים)

1. **אין `partyId` FK קשיח** — זהות דרך claims corrigible.
2. **אין merge לפי email/name** — רק convergence על אות-חזק.
3. **אין SupplierProduct בלי supplier** (FK חובה).
4. **אין Mapping בלי החלטת-משתמש או evidence חזק (SKU/barcode)** — name-only לעולם לא auto.
5. **Mapping לא מזיז מלאי. factor לא מזיז מלאי. רק Receiving POST מזיז.**
6. **weak auto לא דורס HUMAN_CONFIRMED.**
7. **Resolution idempotent** (NOOP על re-run); שינוי-ערך-אות = retract+new (מפורש, corrigible).
8. **Deactivation ≠ ביטול-זהות** (claims נשארים).
9. **Snapshots immutable** — שינוי mapping/factor לא משכתב היסטוריית commitment/settlement.
10. **fail-safe:** signal-conflict → Party מבודד, הצפה, לא auto-merge.
11. **בידוד דייר:** הכל לפי businessId (דפוס קיים).

---

## Part 9 — What can be deferred

- Supplier APIs (חיצוניים/מחוברים) · Catalog Sync · Supplier Apps · Delivery Feeds.
- Price History / SupplierCatalogEntry (price evidence).
- Sub-claims ל-Measure (שדות מספיקים).
- Manual Party merge/split UI (מסתמכים על convergence + ייעוצי).
- Mapping challenge/retract UI (Phase 2).
- Measure conversion ב-Receiving / catch-weight (Phase 2).
- Mixed-case / bundle decomposition.
- suggest-mappings ב-pending UI.

---

## Final Answer

### 1. האם ה-Design סגור מספיק למעבר ל-Implementation Phases?
**כן.** שכבת ה-Supplier Resolution מוגדרת מלאה כ-wrapper דק מעל מנגנון מוכח; השכבות הבאות (SupplierProduct/Mapping/Measure) מתוכננות ברמת-שירות עם טריגרים, inputs, conflict-handling ו-invariants ברורים.

### 2. מה חייב להיות Phase 1 (ורק זה)
> **Phase 1 = Supplier כ-Party Role יציב. שום דבר אחר.**
- `Supplier.taxId/taxIdType` + ערך enum `SUPPLIER` + `HUMAN_CONFIRMED` (additive).
- `resolveSupplierParty` (wrapper דק מעל `resolvePartyForRoleRowTx`).
- `createSupplier`/`updateSupplier` מחווטים ל-resolution (conditional, transactional, idempotent).
- Backfill ספקים → Party (batch דרך runner קיים) + lazy on-use.
- `findPossibleMatches` הופך Party-aware (ייעוצי).

### 3. מה אסור להכניס ל-Phase 1 (כדי לא להתפזר)
- **SupplierProduct materialization** · **Mapping learning** · **Measure conversion** — Phase 2.
- קטלוג · price history · APIs מחוברים · correction UIs · manual merge · catch-weight — Phase 2+.
- הטבלאות `SupplierProduct`/`RepresentationMapping` עצמן יכולות להמתין ל-Phase 2; Phase 1 נוגע רק בזהות.

> **העיקרון:** Phase 1 מייצב את הזהות (Supplier=Party Role) — הקרקע שעליה Phase 2 בונה SupplierProduct ו-Mapping בלי זהות חלשה או כפולה. זה הסדר שמנע מאיתנו לבנות Mapping על חול.
