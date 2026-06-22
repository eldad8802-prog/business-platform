# Dubiz Supplier Domain — Phase 2 Implementation Planning v1

> **תכנון מימוש מושגי בלבד — לא קוד, לא Prisma, לא Migration, לא Service implementation, לא API, לא UI.**
> Phase 2 = **Identity Learning בלבד**. הכל מעוגן ב-Constitution v1.2 ובקוד הקיים (intake / approval / matching).
>
> **הנחות נעולות:** אין Catalog · אין Measure · אין Price · אין Availability · אין Supplier APIs/Apps. SupplierProduct = Reference בלבד, נוצר ב-approval (lazy). RepresentationMapping רק מ-HUMAN_CONFIRMED (MERGE+CREATE_NEW). auto-matching לעולם לא כותב. learned mappings = קריאה/הצעה בלבד. Inventory Item = מקור-אמת יחיד. SupplierProduct לעולם לא Product Master.
>
> סטטוס: Phase 2 Implementation Planning v1.

---

## Part 1 — Exact Flow (Draft → Approval)

### היום (ללא שינוי)
1. **Draft creation** — `createSupplierPurchaseDraft` יוצר `SupplierPurchaseDraft` + `DraftLine[]` (`rawName/sku/barcode/quantity/unitType`). מריץ auto-matching (`findInventoryMatches`→`decideInventoryAction`) וכותב `DraftLine.matchedItemId/matchScore/decision` (**BELIEVED suggestion**). status=PENDING_REVIEW.
2. **Send** (אופציונלי — שיתוף).
3. **Pending** — הבעל בוחר MERGE{itemId} / CREATE_NEW{itemData} לכל שורה.
4. **Approval** — `approveSupplierPurchase` (transaction): לכל שורה → פותר ל-item (CREATE_NEW יוצר item qty=0; MERGE משתמש בקיים) → בונה PurchaseOrder(CONFIRMED) → ReceivingSession + post → מלאי → כותב `DraftLine.decision/matchedItemId/status=APPROVED`.

### מה מתווסף ב-Phase 2 — **אדיטיבי, בתוך טרנזקציית ה-approval בלבד**
מיד אחרי שכל שורה נפתרה ל-`itemId` (ולפני/אחרי כתיבת ה-DraftLine), לכל שורה שיש לה זהות-מוצר-ספק יציבה (`sku|barcode|rawName`) + supplier:
- **(0) Resolve supplier** — find-or-create `Supplier` row לפי `(businessId + normalized supplierName)` של ה-draft (גשר מ-`supplierName` החופשי ל-`supplierId` הנדרש). *(זהו הצעד היחיד שאינו מובן-מאליו; ראה Guard Rails.)*
- **(a) `ensureSupplierProduct`** — lazy materialize/lookup לפי `(supplierId + externalSku|barcode|normalizedName)`. **Reported Reality.**
- **(b) `learnRepresentationMapping`** — קישור `SupplierProduct → resolved itemId`, `identityConfidence=KNOWN`, `method=HUMAN_CONFIRMED`, `identitySignal`, `source="draft:{id}:line:{lineId}"`, `resolvedByUserId`.
- **(c)** (אופציונלי) `DraftLine.supplierProductId` forward-link.

### רגעים מדויקים
- **SupplierProduct נוצר:** בתוך טרנזקציית ה-approval, ברגע שהשורה נפתרת (MERGE **או** CREATE_NEW), אם עוד לא קיים.
- **RepresentationMapping נוצר:** מיד אחריו, אותה טרנזקציה.

### נשאר ללא שינוי
`SupplierPurchaseDraft`, `DraftLine` (למעט `supplierProductId` nullable אופציונלי), `PurchaseOrder`, `PurchaseOrderLine`, `ReceivingSession`, `ReceivingLine`, `InventoryItem`, `InventoryMovement`, ה-auto-matching, בניית ה-PO/Receiving, ועדכון המלאי. **Phase 2 רק מוסיף 2 כתיבות בתוך טרנזקציה קיימת.**

---

## Part 2 — SupplierProduct Lifecycle (Reported Reality Reference)

| שלב | מה קורה |
|---|---|
| **creation** | lazy ב-approval; find-or-create לפי `(supplierId + externalSku)` (או barcode / normalizedName fallback); `source` מוטבע; isActive=true |
| **lookup** | לפי `(supplierId + externalSku\|barcode\|normalizedName)` — ב-approval (dedup) וב-matching (קריאה) |
| **update** | **רק תכונות מדווחות** (name, isActive) מתעדכנות במקום עם provenance/timestamp, כשהספק מתאר מחדש את **אותו** מוצר. (Phase 2: רענון-שם מינימלי; היסטוריית-תכונות עמוקה נדחית) |
| **inactive** | isActive=false כשהספק חדל להציע (זמין, נדיר ב-Phase 2) |
| **correction** | אם המוצר מופה שגוי — **ה-Mapping מתוקן** (challenge/retract), לא זהות ה-SupplierProduct. ה-SupplierProduct הוא anchor-reference |

**למה זה לא Product Master:** מפתח-הזהות יציב ומתוחם-לספק; הוא **לעולם לא מחזיק** את התכונות הקנוניות של המוצר ו**לעולם לא כותב** ל-InventoryItem; ה-InventoryItem ריבוני. SupplierProduct = "איך הספק קורא למוצר", לא "מהו המוצר".

---

## Part 3 — RepresentationMapping Lifecycle (מראה את PartyResolutionClaim)

| שלב | מה קורה |
|---|---|
| **creation** | ב-approval: status=**ACTIVE**, confidence=KNOWN, method=HUMAN_CONFIRMED, source/resolvedByUserId/identitySignal |
| **challenge** | אות/אדם סותר → status=**CHALLENGED** (מסומן, טרם הוחלף) |
| **revision** | הבעל ממפה מחדש את ה-SupplierProduct לפריט אחר → הישן ACTIVE→**RETRACTED**, שורה חדשה ACTIVE (partial-unique-active מאלץ ACTIVE יחיד) |
| **replacement** | זהה ל-revision — שורה חדשה גוברת; הישנה נשמרת כ-RETRACTED |

**שינוי לאורך זמן בלי מחיקת היסטוריה:** כל השורות הלא-ACTIVE (CHALLENGED/RETRACTED) **נשארות בטבלה = ההיסטוריה**; שאילתת ACTIVE = המצב הנוכחי. append-only, בדיוק כמו `PartyResolutionClaim`. אף שורה לא נמחקת.

---

## Part 4 — Matching Evolution (תרשים החלטה)

**היום:** barcode(100) → name(70) → category(40, demo-hardcode).

**אחרי Phase 2** (ה-pipeline **קורא** mappings, לא כותב):

1. **Learned ACTIVE mapping** — אם ל-draft יש supplier + `line.sku/barcode` תואם ל-`SupplierProduct` של אותו ספק עם mapping ACTIVE → **מחזיר: ה-InventoryItem הממופה, confidence=KNOWN** (pre-select, מאושר-בעל).
2. **Global barcode** — `line.barcode == item.barcode` → **מחזיר: item, EXACT.**
3. **Supplier SKU** (טרם ממופה) → **מחזיר: candidate לפי sku** (חזק-בתוך-ספק, דורש אישור).
4. **Name** substring → **מחזיר: candidate(s) חלשים** (Supporting).

(category-hardcode מוסר/מתעלם.) **הראשון שמצליח = ההצעה העליונה**; הנמוכים יותר ממלאים חלופות. ה-pipeline עדיין רק **מציע** — הבעל מאשר ב-approval; שלב 1 רשאי pre-select, שלבים 2-4 דורשים אישור.

**ההיגיון הדומייני:** confirmed+supplier-specific (learned) > deterministic-global (barcode) > supplier-proprietary (sku) > weak-fuzzy (name) — סולם provenance × ספציפיות-scope.

---

## Part 5 — Read Models (יכולות מוצר חדשות)

ברגע שקיימים SupplierProducts + Mappings — **יכולות קריאה בלבד**, אפס סמכות חדשה:
- **זיהוי-אוטומטי של אותו מוצר-ספק** — הזמנה חוזרת מאותו ספק נפתרת מראש לפריט הנכון (KNOWN), בלי הכרעה מחדש.
- **הצעות טובות יותר** — מסך ה-pending pre-fill את הפריט המאושר.
- **הפחתת review** — שורות עם learned mapping מדלגות על מצב REVIEW (pre-selected, אישור בלחיצה).
- **"מה הספק הזה מכר לי"** (read) — רשימת SupplierProducts per ספק (reference, **לא** catalog-master).
- **"מאילו ספקים קניתי את פריט X"** (read מעל mappings) — מבט חוצה-ספקים על פריט פנימי.
- **תשתית-קריאה למחיר-אחרון-per-supplier-item** — בזכות `lastPurchaseCost` + ה-mapping (read; הנתון כבר קיים מ-receivings, ללא אחסון חדש).

---

## Part 6 — Guard Rails (אסור ב-Phase 2)

- ❌ אסור ליצור `InventoryItem` אוטומטית — רק CREATE_NEW אנושי.
- ❌ אסור לשמור auto/BELIEVED mappings — רק HUMAN_CONFIRMED (KNOWN).
- ❌ אסור לעדכן `InventoryItem` מתוך `SupplierProduct` — שם/קטגוריה/יחידה/מחיר **לא זורמים פנימה**.
- ❌ אסור ש-`SupplierProduct` יהפוך למשטח-עיון-המוצרים הראשי.
- ❌ אסור למזג Parties/Suppliers לפי name/email. (find-or-create **Supplier row** לפי name = מותר; **מיזוג זהות** לפי name = אסור — ה-Party converge רק על אות-חזק.)
- ❌ אסור למחוק mappings — challenge/retract בלבד.
- ❌ אסור ש-Mapping/SupplierProduct יזיזו מלאי — רק Receiving.
- ❌ אסור להוסיף Measure/factor/price/availability/catalog.
- ❌ אסור ש-matching **יכתוב** mapping — קריאה בלבד.
- ❌ אסור לחסום approval בהיעדר supplier/sku — degrade: בלי זהות → בלי mapping, השורה עדיין נקלטת רגיל.

---

## Final Verdict

> **שאלה: אחרי Phase 2 — לפתוח Phase 3 של Catalog/Connections, או שחסרה שכבת-ביניים?**

**חסרה שכבת-ביניים אחת.** השם שלה: **Measure** (Representation Conversion).

נימוק חד: Catalog/Connections מביא **purchase-units + מחיר** (ארגז-12 @ ₪X) — ובלי ממד ה-**Measure** של ה-Mapping אי-אפשר לתרגם אותם נכון ל-stock-units ול-עלות-Record. ה-Constitution מגדיר את ה-Mapping כ-**Identity + Measure**; Phase 2 מימש Identity. הצעד הדומייני הנכון לפני Catalog הוא להשלים את **Measure**, אחרת קטלוג מחובר יהיה חצי-שמיש (זהות בלי המרת-כמות/עלות).

**הסדר הדומייני: Phase 2 = Identity → Phase 3 = Measure → Phase 4+ = Catalog/Connections.** לא roadmap — רק השלב הבא הנכון.
