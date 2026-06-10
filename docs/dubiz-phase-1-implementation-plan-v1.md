# Dubiz Phase 1 Implementation Plan v1

> **תוכנית מימוש — עדיין *לא* קוד, *לא* migration, *לא* שינוי schema בפועל.**
> מתרגמת את `dubiz-phase-1-design-v1.md` (המאושר) לצעדי עבודה: מה ייבנה · אילו קבצים · סדר · מה נבדק — לפני נגיעה במערכת.
>
> **Scope מאושר:** Party Reality layer additive בלבד. Customer+Lead · phone+taxId · deterministic exact · corrigible claims · Billing-frozen.
>
> סטטוס: Implementation Plan v1. אחרי אישור → טיקט מימוש ראשון קטן.

---

## 1. Schema Plan (מינימלי, additive בלבד)

> שני מודלים חדשים + enums. **אפס שינוי** ל-Customer/Lead/BillingDocument/FinancialEvent. **אפס FK** מ-role-rows ל-Party.

### 1.1 `Party` (עוגן-זהות דק)
```
Party
  id          Int  @id @default(autoincrement())
  businessId  Int                       — per-tenant (F6)
  createdAt / updatedAt
  business    → Business (onDelete: Cascade)
  @@index([businessId])
```
- **identity-only.** אין phone/taxId/name. (cache קנוני = optimization עתידי, OUT.)

### 1.2 `PartyResolutionClaim` (ה-link הקורגיבילי)
```
PartyResolutionClaim
  id             Int @id @default(autoincrement())
  businessId     Int
  partyId        Int                      — FK → Party
  subjectType    PartyRoleType            — CUSTOMER | LEAD   (פולימורפי)
  subjectId      Int                      — id של role-row (לא FK — פולימורפי, לא נוגע ב-Customer/Lead)
  signalType     PartySignalType          — PHONE | TAX_ID
  signalValue    String                   — הערך הקנוני שהותאם (basis/evidence)
  confidence     PartyClaimConfidence     — KNOWN | BELIEVED | SUSPECTED | UNKNOWN
  method         PartyResolutionMethod    — DETERMINISTIC_EXACT
  source         String                   — provenance: מאיפה (BACKFILL | CUSTOMER_CREATE | LEAD_CREATE)
  resolvedByUserId Int?                   — provenance: אדם (null ב-MVB auto)
  status         PartyClaimStatus         — ACTIVE | CHALLENGED | RETRACTED
  createdAt / updatedAt
  party          → Party (onDelete: Cascade)
  business       → Business (onDelete: Cascade)
  @@index([businessId, subjectType, subjectId])   — claims של role-row
  @@index([businessId, signalType, signalValue])  — מועמדים לפי אות
  @@index([businessId, partyId])                  — חברי Party
  @@index([businessId, status])
```

### 1.3 enums חדשים
```
PartyRoleType          { CUSTOMER, LEAD }
PartySignalType        { PHONE, TAX_ID }
PartyClaimConfidence   { KNOWN, BELIEVED, SUSPECTED, UNKNOWN }
PartyResolutionMethod  { DETERMINISTIC_EXACT }
PartyClaimStatus       { ACTIVE, CHALLENGED, RETRACTED }
```

### 1.4 אינווריאנט מבני (לא FK על role-row)
- **"claim ACTIVE אחד לכל subject"** — role-row שייך ל-Party אחד בכל רגע. נאכף **ברמת ה-service** (ואופציונלית partial-index `WHERE status=ACTIVE`). **לא** עמודת `partyId` על Customer/Lead.

> **למה לא FK על subjectId:** הוא פולימורפי (Customer *או* Lead). FK יחייב back-relation על Customer/Lead = שינוי role-rows. פולימורפי = additive טהור.

---

## 2. Service Plan

> service חדש בתיקייה חדשה `lib/services/party/`. דפוס Tx במראֶה של billing-authority transition-service (הכל בטרנזקציה, idempotent).

### 2.1 `lib/services/party/party-resolution.service.ts` (חדש)
| פונקציה | תפקיד |
|---|---|
| `extractStrongSignals(roleRow)` | canonical phone (**reuse `normalizeCustomerPhone`**) + taxId |
| `findCandidatePartyBySignalTx(tx, businessId, signalType, value)` | שאילתת claims ACTIVE תואמי-אות → Party מועמד |
| `createPartyTx(tx, businessId)` | Party singleton |
| `createClaimTx(tx, {...})` | claim עם confidence/provenance/status; **idempotent** (claim ACTIVE קיים ל-subject+signal → NOOP) |
| `resolvePartyForRoleRowTx(tx, {businessId, subjectType, subjectId, signals, source})` | **הליבה** — find-or-create Party + claim. מחזיר `{party, claim, outcome}` |
| `lookupPartyForRoleRow(prisma, {businessId, subjectType, subjectId})` | read-through: role-row → Party (קריאה) |
| `lookupRoleRowsForParty(prisma, {businessId, partyId})` | Party → חברים (קריאה) |

### 2.2 כללי ה-resolution (מאושרים)
- **taxId exact → `KNOWN`** (זהות משפטית). **phone exact → `BELIEVED`** (חזק אך משותף/ממוחזר → corrigible, ניתן לערעור). [תואם Design §2.1 "exact→Known/Believed"]
- **find-or-create:** candidate נמצא → claim cross-role לאותו Party; אין → Party singleton + claim.
- **fail-safe על סתירה:** phone→PartyA אך taxId→PartyB (גבול אדם↔ארגון) → **לא ממזג**; MVB פותר על אות-אחד-בכל-פעם, סתירה נרשמת (source/marker), אפס auto-merge.
- **fail-safe על אות-חלש:** name לבד → אין resolution; Party singleton.
- **idempotent:** subject עם claim ACTIVE → NOOP (אין כפילות).

### 2.3 reuse קיים
`normalizeCustomerPhone` (phone.ts) · דפוס Tx (billing-authority) · תבנית corrigible (InventoryPendingMatch).

---

## 3. Runtime Boundaries (שמרני — לא לשבור intake hot-path)

> **עיקרון: ב-Phase 1 *שום דבר אינו צורך Party* (אין Situation/surface) → אין דחיפות ל-real-time. לכן ה-resolution נשאר מחוץ לכל hot-path.**

| נקודה | Phase 1 |
|---|---|
| **Backfill חד-פעמי** | ✅ הנתיב העיקרי (חלק 4) |
| **WhatsApp intake `upsertCustomer`** | ❌ **לא נוגעים** — ה-hot-path נשאר זהה בדיוק. Customers שנוצרים שם נפתרים ע"י backfill / pass עוקב |
| **יצירת Customer (`app/api/customer`, billing-customer)** | ⚪ wiring *fast-follow* — קריאה ל-`resolvePartyForRoleRowTx` **best-effort, decoupled, never-blocking** (כשל ב-resolution לא שובר יצירת Customer) |
| **יצירת Lead** | ⚪ זהה — fast-follow best-effort |

> **ההמלצה השמרנית: Phase 1 = backfill בלבד כ-must.** wiring לנקודות-יצירה הוא fast-follow אופציונלי (decoupled). מאחר ש**אף אחד לא קורא Party עדיין**, גם resolution לא-מיידי תקין לחלוטין. **ה-intake hot-path אינו משתנה כלל.**

---

## 4. Backfill / Existing Data Plan

> **`lib/services/party/party-backfill.service.ts`** (חדש). חד-פעמי · idempotent · non-destructive · tenant-scoped.

| צעד | פעולה |
|---|---|
| 1 | איטרציה על Customers + Leads קיימים, **פר-business** |
| 2 | לכל role-row: `extractStrongSignals` (phone קנוני + taxId) |
| 3 | `resolvePartyForRoleRowTx` — group-by-signal בתוך business: role-rows חולקי-phone(או-taxId) → אותו Party |
| 4 | Customers+Leads עם אותו phone → **אותו Party** (cross-role) |
| 5 | role-row חסר-אות-חזק → **Party singleton** |
| 6 | idempotent: subject עם claim ACTIVE → דלג (re-runnable) |

**מובטח:** אפס delete · אפס merge של role-rows · אפס שינוי Customer/Lead/Billing · אפס חציית businessId.

---

## 5. Tests / Verification Plan

> `lib/services/party/party-resolution.service.test.ts` (+ backfill test). דפוס harness כמו billing-authority test (`fake.tx` / seeded).

| # | מקרה | צפוי |
|---|---|---|
| 1 | Customer+Lead, אותו phone, אותו business | **אותו Party** (cross-role) |
| 2 | שני role-rows, taxId זהה | **אותו Party** (כלל taxId→KNOWN) |
| 3 | Lead עם name בלבד (אין phone/taxId) | **Party singleton**, לא merge |
| 4 | שני Leads, אותו name, טלפונים שונים | **שני Parties** (אין name-merge) |
| 5 | BillingDocument | **ללא שינוי** (assert אפס כתיבה ל-billing) |
| 6 | אותו phone בשני businesses שונים | **שני Parties** (tenant isolation) |
| 7 | claim שנוצר | כולל **provenance + confidence + status** |
| 8 | re-run backfill | **אפס claims/Parties כפולים** (idempotent) |
| 9 | phone→PartyA, taxId→PartyB (סתירה) | **fail-safe: לא merge**, נרשם |
| 10 | lookup read-through | role-row→Party ו-Party→members מחזירים נכון |
| 11 | regression | intake/customer/lead creation עובדים ללא שינוי |

---

## 6. Safety Constraints (מפורש)

| ❌ אסור | מימוש |
|---|---|
| שינוי Billing frozen snapshots | אפס כתיבה ל-BillingDocument/issuedSnapshot/customerNameSnapshot |
| `partyId` FK על Customer/Lead | claim פולימורפי בלבד; subjectId לא-FK |
| Fuzzy matching | method=DETERMINISTIC_EXACT בלבד |
| Name-based merge | name אינו אות establishing; אף פעם לא ממזג |
| Supplier / Vendor | subjectType ∈ {CUSTOMER, LEAD} בלבד |
| FinancialEvent re-anchor | FinancialEvent ללא נגיעה |
| UI / Human-confirmation flow | resolvedByUserId=null (auto); אין מסך |
| Global / Industry priors | אותות מקומיים בלבד (phone/taxId של הדייר) |
| שינוי intake hot-path | `conversation-intake` ללא שינוי |
| migration שמשנה טבלה קיימת | ADD בלבד (Party + Claim + enums) |

---

## 7. Definition of Done

| קריטריון | אימות |
|---|---|
| Party graph קריא ל-Customer/Lead | `lookupPartyForRoleRow` / `lookupRoleRowsForParty` עובדים |
| כל Customer/Lead מקבל Party דרך claim | backfill = כיסוי טוטלי (כולל singletons) |
| exact phone/taxId מחבר cross-role | test #1, #2 ירוקים |
| כל חיבור = corrigible claim | claim נושא confidence+provenance+status; challenge/retract אפשריים מבנית; test #7 |
| המערכת הקיימת ללא שינוי התנהגותי | regression #11 ירוק; intake hot-path לא נגע |
| Billing untouched | test #5; אפס כתיבה ל-billing |
| Tenant isolation | test #6 |
| idempotent | test #8 |

---

## 8. הצעת חיתוך לטיקטים (אחרי אישור התוכנית)

| טיקט | תוכן | סיכון |
|---|---|---|
| **T1 (ראשון, קטן)** | Schema additive (Party + PartyResolutionClaim + enums) + `party-resolution.service` (ליבה: find-candidate/create-party/create-claim/resolve/lookup) + unit tests (#1-4,#7,#9,#10). **ללא backfill, ללא wiring לפרודקשן.** | נמוך — מבנה + לוגיקה טהורה, מנותק מכל נתיב חי |
| **T2** | `party-backfill.service` + backfill tests (#5,#6,#8) + הרצת backfill | בינוני — נוגע בדאטה קיים (אך additive/idempotent) |
| **T3 (fast-follow, אופציונלי)** | wiring decoupled לנקודות-יצירה Customer/Lead (best-effort) + regression (#11) | נמוך — decoupled, never-blocking |

> **T1 הוא הטיקט הראשון המומלץ:** מבנה + service + בדיקות, **מנותק לחלוטין מכל נתיב חי** — אפס סיכון לפרודקשן, מאמת את הליבה לפני נגיעה בדאטה.

---

## נספח — קבצים שכנראה ניגע בהם

| קובץ | שינוי |
|---|---|
| `prisma/schema.prisma` | **ADD** Party · PartyResolutionClaim · 5 enums (additive בלבד) |
| `lib/services/party/party-resolution.service.ts` | **חדש** — ליבת ה-resolution + lookups |
| `lib/services/party/party-backfill.service.ts` | **חדש** — backfill (T2) |
| `lib/services/party/party-resolution.service.test.ts` | **חדש** — tests |
| `lib/services/integrations/whatsapp/phone.ts` | **reuse בלבד** (`normalizeCustomerPhone`) — ללא שינוי |
| `app/api/customer`, lead-creation | **ללא שינוי ב-T1/T2**; wiring decoupled ב-T3 בלבד |
| Customer / Lead / BillingDocument / FinancialEvent | **ללא שינוי, לעולם** |
