# Dubiz Supplier Domain — DB Schema Design v1

> **תכנון סכמה מושגי בלבד — לא קוד, לא Prisma, לא migration.sql, לא API, לא UI.** מתרגם את Structure Decisions v1 למבנה קונקרטי (טבלאות/שדות/enums/indexes/יחסים) — בלי לכתוב אותו.
>
> **סדר מחייב:** (1) Supplier→Party Role → (2) SupplierProduct → (3) RepresentationMapping. ה-Mapping נשען על supplierId; קודם מעגנים את Supplier כ-role-row.
>
> נשען על: Constitution v1.2 · Design v1 · Implementation Design v1 · Structure Decisions v1 · AGENTS supplier-domain-rules · הקוד הקיים (`Party`, `PartyResolutionClaim`, `party-resolution.service.ts`, `Customer.taxId`, `Supplier`, `SupplierPurchaseDraftLine`, `PurchaseOrderLine`, `ReceivingLine`).
>
> סטטוס: DB Schema Design v1.

---

## Part 1 — Supplier as Party Role

### 1.1 שדות חדשים על `Supplier`
| שדה | טיפוס | הערה |
|---|---|---|
| `taxId` | `String?` | nullable; מראה את `Customer.taxId` |
| `taxIdType` | `CustomerTaxIdType?` | reuse של ה-enum הקיים (ראה Open Q1) |

אין שדה נוסף נדרש. (phone/email/name/isActive כבר קיימים.) **לא** מוסיפים `partyId`.

### 1.2 הרחבות enum
- `PartyRoleType` += **`SUPPLIER`**.
- `PartyResolutionMethod` += **`HUMAN_CONFIRMED`**.
- `PartySignalType` — **ללא שינוי** (EMAIL אינו signal; taxId/phone קיימים).

### 1.3 הזנת `PartyResolutionClaim` (subject = SUPPLIER)
Supplier הוא subject (`subjectType=SUPPLIER`, `subjectId=supplier.id`) המוזן ל-`resolvePartyForRoleRowTx` הקיים, **ללא שינוי בטבלת ה-claim** (היא כבר פולימורפית ותומכת signal nullable):

| מקור | claim |
|---|---|
| `taxId` | signalType=`TAX_ID`, confidence=**KNOWN**, method=`DETERMINISTIC_EXACT` |
| `phone` | signalType=`PHONE`, confidence=**BELIEVED**, method=`DETERMINISTIC_EXACT` |
| חסר-אות חזק | signal=null, confidence=**UNKNOWN**, method=`SELF_ANCHOR` (anchor claim) |
| `name` | **אין claim** — Supporting/display בלבד |
| `email` | **אין claim** — contact/corroboration בלבד |

### 1.4 קשר Supplier ↔ Party — claim-only (לא FK)
הקשר מתבטא **אך ורק** דרך `PartyResolutionClaim` (subjectType=SUPPLIER → partyId). אין עמודת `partyId` על `Supplier`, ואין FK על `subjectId` (פולימורפי). זהה ל-Customer/Lead. שמירה על corrigibility (CHALLENGED/RETRACTED) ועל fail-safe (anchor/signal-conflict) — בדיוק כמנגנון הקיים.

### 1.5 Indexes & Unique constraints
| על | סוג | סיבה |
|---|---|---|
| `Supplier(businessId, taxId)` | **index, לא unique** | lookup/dedup; uniqueness תכפה merge מוקדם |
| `Supplier(businessId, phone)` | **index, לא unique** | lookup; phone יכול להיות משותף |
| `Supplier(businessId, name)` | קיים, לא unique | name חלש |
| claim `(businessId, signalType, signalValue)` | קיים index, **לא unique** | candidate lookup; ערך-אות אינו ייחודי-גלובלית |

**אסור unique** על taxId/phone/email/name ברמת `Supplier` — ייחודיות-הזהות חיה בשכבת ה-Party/claim (resolution), לא בטבלה. זהו עוגן מניעת ה-over-merge.

### 1.6 Backward compatibility
- `supplierName` היסטורי (Item/Draft/PO) — **לא נוגעים**; נשאר display/fallback.
- `Supplier` rows קיימים — backfill ל-Party (anchor; phone-claim אם יש). taxId=null → anchor עד שיתווסף.
- PO.supplierName — **snapshot immutable**; resolution additive, לא משכתב.
- Items עם supplierName — לא נוגעים; קישור עצל לפי normalized-name אפשרי, לא נדרש.

---

## Part 2 — SupplierProduct (Reference, lazy)

### 2.1 שדות
| שדה | טיפוס | הערה |
|---|---|---|
| `id` | `Int` | PK |
| `businessId` | `Int` | tenant |
| `supplierId` | `Int` | **FK → Supplier** (owned) |
| `externalSku` | `String?` | מזהה הספק |
| `barcode` | `String?` | GTIN |
| `name` | `String` | שם הספק למוצר |
| `normalizedName` | `String?` | מחושב, ל-matching/dedup חלש |
| `packageDescriptor` | `String?` | אריזה **מוצהרת** ("case of 12") — Reported, descriptive (ה-factor המספרי חי על ה-Mapping) |
| `source` | `String` | provenance ("catalog:7", "draft:123:line:45", "csv:9") |
| `isActive` | `Boolean` | active/deprecated |
| `createdAt`/`updatedAt` | `DateTime` | |

**ללא price.** מחיר מדווח הוא Evidence נדיף (Reported Reality); שמירת currentPrice כאן תתייחס אליו כתכונה יציבה. unitCost הקיים על שורות Draft/PO/Receiving נושא את המחיר התפעולי. price-evidence/history = תוספת עתידית (לא שלב 1).

### 2.2 יחסים
- `supplier` (FK).
- `mappings` (`RepresentationMapping[]`).

### 2.3 Unique keys & Indexes
| על | סוג | סיבה |
|---|---|---|
| `(supplierId, externalSku)` | **@@unique** | SKU ייחודי-לספק. NULLs distinct (Postgres) → שורות חסרות-SKU אינן מוגבלות — בדיוק הרצוי |
| `(supplierId, barcode)` | @@unique (אופציונלי) | barcode ייחודי-לספק |
| `(supplierId, normalizedName)` | **index, לא unique** | dedup חלש בלבד |
| `(businessId)`, `(supplierId)`, `(businessId, barcode)` | index | lookup |

### 2.4 Lifecycle
`isActive` boolean (לא נדרש enum-status לשלב 1).

### 2.5 הגבלות (משמעת)
- **לא product master** — Reported Reality בלבד; מצביע פנימה דרך Mapping.
- **לא יוצר InventoryItem** — materialization של פריט רק דרך MERGE/CREATE_NEW אנושי.
- **שורה חד-פעמית לא-פתורה נשארת Draft-line Evidence** — לא מממשת SupplierProduct.
- **יכול להתקיים בלי Mapping** (unmapped = מצב לגיטימי).

---

## Part 3 — RepresentationMapping (Identity + Measure)

### 3.1 שדות — Identity dimension
| שדה | טיפוס | הערה |
|---|---|---|
| `id` | `Int` | PK |
| `businessId` | `Int` | tenant |
| `supplierProductId` | `Int` | **FK → SupplierProduct** (subject) |
| `inventoryItemId` | `Int` | **FK → InventoryItem** (target) |
| `identityConfidence` | `PartyClaimConfidence` | **reuse** (C-Root יחיד) |
| `identitySignal` | `MappingSignalType?` | `EXTERNAL_SKU`/`BARCODE`/`NAME` — איזה אות ביסס |
| `identityMethod` | `RepresentationResolutionMethod` | `DETERMINISTIC_EXACT`/`HUMAN_CONFIRMED` |
| `source` | `String` | provenance ("draft:123:line:45", "catalog:7") |
| `resolvedByUserId` | `Int?` | WHO |
| `status` | `PartyClaimStatus` | **reuse**: ACTIVE/CHALLENGED/RETRACTED |

### 3.2 שדות — Measure dimension (על אותה שורה, provenance/confidence עצמאיים)
| שדה | טיפוס | הערה |
|---|---|---|
| `purchaseUnitName` | `String?` | יחידת-הרכש ("CASE") |
| `factor` | `Float?` | nominal: 1 purchase-unit = factor stock-units. null/1 = 1:1 |
| `measureConfidence` | `PartyClaimConfidence` | **נפרד** מ-identityConfidence |
| `measureSource` | `String?` | provenance של ה-factor ("catalog", "user", "receiving:88") |

- **stockUnitName** — מושמט; נגזר מ-`InventoryItem.unitType`.
- **nominal/actual:** ה-`factor` כאן הוא **nominal בלבד**. ה-**actual** נלכד per-event ב-`ReceivingLine` (Part 4). אין צמד nominal/actual על ה-Mapping.
- **catch-weight לא נשבר:** ה-Mapping נותן את הציפייה (nominal/Reported); ה-Receiving רושם את הכמות בפועל (Physical) ו**גוברת**. עלות per-stock-unit מחושבת מהכמות-בפועל, לא מ-nominal.

### 3.3 Corrigibility & Revision
- `status` reuse של `PartyClaimStatus`.
- **Revision = שורה חדשה, לא עדכון-במקום.** שינוי זהות/factor: הישנה → RETRACTED (נשמרת), חדשה → ACTIVE. (B1/חוק האי-משתנות + B4.)
  - **Update** (ספק 12→6): שורה חדשה, הישנה נכונה-בזמנה.
  - **Revision** (זהות שגויה): ישנה RETRACTED, חדשה ACTIVE.
  - **Recalibration** (confidence בלבד): עדכון-במקום מותר (הפרופוזיציה לא משתנה).
- **History בלי DB כבד:** השורות הלא-פעילות (RETRACTED/CHALLENGED) **הן** ההיסטוריה — באותה טבלה, append-only. active = `status=ACTIVE`. אין טבלת-audit נפרדת לשלב 1 (מראה את `PartyResolutionClaim`).

### 3.4 Constraints
| כלל | מימוש | סיבה |
|---|---|---|
| **mapping ACTIVE יחיד ל-supplierProduct** | partial unique `(supplierProductId) WHERE status=ACTIVE` | SupplierProduct נפתר לפריט אחד; מונע הצבעה-כפולה (over-merge מבני) |
| **InventoryItem מקבל הרבה SupplierProducts** | `inventoryItemId` **לא unique** | many-to-one — הליבה |
| **supplierProduct ל-כמה items?** | לא בו-זמנית (שלב 1) | רק דרך revision; mixed-case/bundle = עתידי |
| מניעת over-merge | אין auto-map על name לבד; signal-conflict → לא פותר, מצף; fail-safe=no-mapping | |
| split/correction | status transitions + שורות חדשות | |

### 3.5 enums חדשים
- `RepresentationResolutionMethod { DETERMINISTIC_EXACT, HUMAN_CONFIRMED }` — **SELF_ANCHOR מושמט** (ל-mapping תמיד יש target קונקרטי; אין מה לעגן). *(ראה Open Q2 — חידוד מול Structure Decisions.)*
- `MappingSignalType { EXTERNAL_SKU, BARCODE, NAME }`.
- **reuse:** `PartyClaimConfidence`, `PartyClaimStatus`.

### 3.6 Indexes
`(businessId)`, `(supplierProductId)`, `(inventoryItemId)`, `(businessId, status)`.

---

## Part 4 — Integration with Draft / PO / Receiving (DB only)

**עיקרון:** הפניות (id) ל-traceability; **snapshots (values)** לכל מה שמשפיע על Commitment/Settlement — כדי שהיסטוריה לא תישבר אם Mapping/factor ישתנו.

| טבלה | תוספת | סוג | למה |
|---|---|---|---|
| `SupplierPurchaseDraftLine` | `supplierProductId` | `Int?` nullable | forward-link; null לשורה חד-פעמית |
| | *(mappingId לא נדרש)* | — | back-link חי ב-`Mapping.source="draft:..line:.."` |
| `PurchaseOrderLine` | `supplierProductId` | `Int?` | traceability |
| | `purchaseUnitName` | `String?` | **snapshot** |
| | `purchaseQty` | `Float?` | **snapshot** — כמה purchase-units הוזמנו |
| | `conversionFactorSnapshot` | `Float?` | **snapshot** ה-factor בעת ה-commit |
| `ReceivingLine` | `purchaseUnitName` | `String?` | **snapshot** |
| | `receivedPurchaseQty` | `Float?` | **snapshot** — כמה purchase-units התקבלו |
| | `conversionFactorSnapshot` | `Float?` | **snapshot** ה-factor **בפועל** באירוע זה (catch-weight/actual) |

- `PurchaseOrderLine.orderedQty` ו-`ReceivingLine.receivedQty` נשארים ב-**stock-units** (היחידה הקנונית). שדות ה-purchase-unit הם snapshot-context immutable.
- **מה חייב snapshot:** factor, purchaseUnitName, purchaseQty, unitCost, supplierName — כל ערך שהשפיע על רשומת-מחויבות/settlement. שינוי עתידי ב-Mapping **לא** משכתב היסטוריה.
- כל התוספות **nullable/additive** — שורות קיימות נשארות תקפות.

---

## Part 5 — Additive Migration Shape (עיקרון)

- **טבלאות חדשות:** `SupplierProduct`, `RepresentationMapping`.
- **שדות חדשים:** Supplier(taxId, taxIdType) · DraftLine(supplierProductId) · POLine(supplierProductId, purchaseUnitName, purchaseQty, conversionFactorSnapshot) · ReceivingLine(purchaseUnitName, receivedPurchaseQty, conversionFactorSnapshot) — **כולם nullable**.
- **enum extensions:** PartyRoleType+=SUPPLIER · PartyResolutionMethod+=HUMAN_CONFIRMED · enums חדשים: RepresentationResolutionMethod, MappingSignalType.
- **indexes:** כמפורט (Supplier taxId/phone non-unique; SupplierProduct unique (supplierId,externalSku); Mapping partial-unique active).
- **backfill:** הרחבת `party-backfill` ל-SUPPLIER (anchor / phone-claim; taxId=null→anchor). קישור supplierName→Supplier לפי normalized-name — best-effort, לא חוסם. **אין** backfill ל-SupplierProduct/Mapping (greenfield).
- **נשאר nullable:** taxId, taxIdType, factor, purchaseUnit*, supplierProductId, כל ה-snapshots.
- **אסור לחייב בשלב 1:** taxId, factor, SupplierProduct/Mapping per line.

---

## Part 6 — Risks / Rejected DB Designs

| נדחה | סיבה |
|---|---|
| `partyId` FK קשיח על Supplier | שובר corrigibility; הקשר = claim |
| `email` unique | תיבות משותפות → over-merge / חסימת-לגיטימי |
| `supplierName` unique כמפתח-זהות | name חלש/Supporting; ייחודיות שגויה |
| unique גלובלי `(businessId, taxId/phone)` ב-Supplier | כופה merge מוקדם; dedup בשכבת Party |
| SupplierProduct כמוצר-מלאי | Reference בלבד; לא ב-System of Record |
| Mapping שמעדכן מלאי | רק Receiving כותב |
| Measure כקבוע לא-מתוקן | binding-belief בר-תיקון; revision בשורות |
| מחיקת supplierName legacy מוקדם | היסטוריה immutable; fallback |
| עדכון Mapping in-place שמאבד היסטוריה | append-only corrigible rows |

---

## Final Output

### 1. Schema מומלץ (תקציר)
שתי טבלאות חדשות (`SupplierProduct`, `RepresentationMapping`) + הרחבת `Supplier` ל-role-row (taxId) המוזן ל-Party Resolution הקיים + snapshots additive על Draft/PO/Receiving lines. שום FK קשיח Supplier↔Party; הקשר = claim corrigible. reuse מקסימלי של הפרימיטיבים הקיימים (Confidence/Status/Claim).

### 2. טבלת ישויות
| ישות | אחריות | מפתח-זהות | קשרים |
|---|---|---|---|
| `Supplier` (מורחב) | role-row "מוכר-לנו" | claim ל-Party (taxId/phone) | →Party (claim), →SupplierProduct |
| `PartyResolutionClaim` (reuse) | קישור subject↔Party corrigible | (businessId, signalType, signalValue) | Supplier/Customer/Lead → Party |
| `SupplierProduct` (חדש) | Reference למוצר-ספק | (supplierId, externalSku) | →Supplier, →Mapping |
| `RepresentationMapping` (חדש) | פתרון Identity+Measure | partial-unique active per supplierProduct | SupplierProduct→InventoryItem |
| `*Line` (מורחב) | snapshots לשמירת היסטוריה | — | →SupplierProduct (nullable) |

### 3. החלטות שננעלו
- Supplier=role-row, taxId אופציונלי, claim-only (לא FK), EMAIL לא signal, name Supporting.
- SupplierProduct מטריאלי-עצל, unique (supplierId, externalSku), בלי price, Reference בלבד.
- RepresentationMapping: Identity+Measure על שורה אחת, confidence/provenance עצמאיים, corrigible append-only, ACTIVE יחיד per supplierProduct, many-to-one ל-InventoryItem.
- Snapshots על PO/Receiving lines; orderedQty/receivedQty ב-stock-units.
- reuse PartyClaimConfidence/Status; enums חדשים RepresentationResolutionMethod/MappingSignalType; PartyResolutionMethod+=HUMAN_CONFIRMED.

### 4. שאלות פתוחות (לא חוסמות API/Service)
1. **`taxIdType` enum:** reuse `CustomerTaxIdType` (אפס churn, אך שם Customer-specific) מול enum ניטרלי `TaxIdType`. נטייה: reuse כעת, ניטרול עתידי. — מינורי.
2. **השמטת `SELF_ANCHOR` ממתודת ה-Mapping** (Structure Decisions ציין אותו כ-fallback). חידוד: ל-mapping תמיד target — אין מה לעגן. לאשר את ההשמטה.
3. **Mixed-case / bundle** (SupplierProduct → כמה InventoryItems) — **עתידי, לא שלב 1**. לוודא שהמבנה אינו חוסם הוספה עתידית (partial-unique active per supplierProduct לא חוסם טבלת-decomposition עתידית נפרדת).
4. **`normalizedName`** — לשמור עמודה מחושבת מול לחשב on-the-fly. — מינורי, החלטת-ביצוע.

### 5. האם אפשר לעבור ל-API / Service Design?
**כן.** הסכמה המומלצת חד-משמעית: ידועים הטבלאות, השדות, ה-enums, ה-indexes, ה-constraints, ה-snapshots ומודל-הקישור. ארבע השאלות הפתוחות הן מינוריות/עתידיות ואינן חוסמות. **המעבר ל-API/Service Design בטוח.**
