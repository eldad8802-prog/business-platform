# Dubiz Phase 1 Design v1

> **מסמך Design — ברמת ארכיטקטורה ומבנה. *לא* Schema סופי, *לא* Migration, *לא* קוד, *לא* Runtime, *לא* משימות פיתוח.**
> מגדיר את ה**צורה** של Phase 1 לפני שנוגעים במערכת. המסמך הראשון שבו אנו *מתכננים לבנייה*, לא חוקרים.
>
> **Scope (מאושר):** Phase 1 = שכבת ה-Reality בלבד — Party Reality מחוברת וקורגיבילית. Customer+Lead · phone+taxId · additive · Billing-Frozen/Tenant-Isolation/Corrigibility/Human-Sovereignty/Local-Reality.
>
> נשען על: Readiness Review · Party Resolution Architecture · Corrigible Resolution · Impact Assessment. סטטוס: Design v1.

---

## עקרון-העל של הצורה

> **שלוש שכבות, additive בלבד. שום דבר קיים לא משתנה.**
> ```
> [Party]            ← צומת-זהות חדש (דק, per-tenant)
>    ▲ (claim)
> [Resolution Claim] ← קישור קורגיבילי: role-row → Party
>    ▲ (קורא, לא משנה)
> [Customer | Lead]  ← role-rows קיימים, ללא שינוי
> ```
> ה-Party וה-Claim הם *חדשים ומעליהם*. Customer/Lead/Billing/Conversation **נשארים בדיוק כפי שהם.**

---

## 1. מבנה שכבת ה-Party

### 1.1 מהו Party (הצומת)
**Party = עוגן-זהות דק, per-tenant.** אינו מחזיק תפקיד, אינו מחזיק נתוני-תפקיד, אינו ממזג Customer/Lead. הוא ה*דבר השלישי* שאליו role-rows מצביעים.

צורה מושגית:
```
Party {
  (id)            — מזהה הצומת
  businessId      — per-tenant (F6); אין Party חוצה-דייר
  createdAt
  (אופציונלי, optimization מאוחר: canonical-signal cache)
}
```

### 1.2 עקרונות הצורה
- **Identity-only.** ה-Party אינו נושא phone/taxId/name כ"אמת" — אלה נשארים על role-rows. זהות ה-Party *מוגדרת ע"י* האותות החזקים של חבריו (דרך ה-claims).
- **לא merge.** Party אינו איחוד שורות Customer+Lead — הוא צומת שאליו שתיהן מצביעות. (Additive; Corrigible; Billing-frozen.)
- **טוטליות.** *כל* role-row מתעגן ל-Party אחד בדיוק — כולל singleton ל-row חסר-אות-חזק (קיום-ללא-זיהוי, ER §3.2). הגרף שלם.

---

## 2. מבנה Resolution Claim (ה-Link הקורגיבילי)

> במראֶה של `InventoryPendingMatch` (claim+status+provenance+human), מוחל על Party.

### 2.1 הצורה
```
ResolutionClaim {
  businessId      — per-tenant
  subject         — איזה role-row: { roleType: CUSTOMER | LEAD, roleId }
  party           — לאיזה Party
  basis           — האות שהצדיק: { signalType: PHONE | TAX_ID, matchedValue/ref }
  confidence      — Known | Believed | Suspected | Unknown   (MVB: exact→Known/Believed)
  method          — DETERMINISTIC_EXACT   (MVB; fuzzy=OUT)
  provenance      — { source, resolvedAt, (resolvedByUserId?) }
  status          — ACTIVE | CHALLENGED | RETRACTED          (Challenge→Correction)
}
```

### 2.2 מה נשמר
- **ה-claim** ("subject שייך ל-Party"), ה-**confidence** (רצועה), ה-**basis** (איזה אות חזק), ה-**provenance** (מקור+זמן, ואדם אם אישר), ה-**status** (מחזור החיים).

### 2.3 מה *לא* נשמר
- **אין fuzzy scores** (אין fuzzy ב-MVB). **אין merge של נתוני role-rows.** **אין projection / snapshot / allocation.** **אין שינוי ל-Customer/Lead/Billing.** **אין Situation/Region/Meaning.**

### 2.4 מדוע זה קורגיבילי (ולא constraint)
- ה-claim רושם *מה* (basis), *מאיפה* (provenance), *באיזה ביטחון* (confidence), *דטרמיניסטי-או-לא* (method) → ניתן ל-**CHALLENGE** ו-**RETRACT** (un-link). זו הקורגיביליות שחסרה ל-`(businessId,phone)` unique. **גם exact-match דטרמיניסטי נשמר כ-claim, לא כ-constraint.**

---

## 3. זרימת Party Resolution (מושגית)

> מופעלת כש-role-row (Customer/Lead) נוצר/משתנה עם אות חזק. **קוראת אותות, לא משנה role-rows.**

```
1. Extract strong signals     — מ-role-row: canonical phone (normalizeCustomerPhone), taxId
2. Find candidate Party        — האם קיים Party שחבריו חולקים את אותו phone/taxId? (דרך claims קיימים)
3. Resolve:
   ├─ candidate נמצא (exact strong) → claim חדש: role-row → אותו Party (cross-role!)
   ├─ אין candidate              → Party חדש (singleton) + claim
   ├─ אותות חזקים סותרים         → fail-safe: לא ממזג; Party נפרד; סמן conflict
   │   (taxId↔phone שונה = גבול אדם↔ארגון, Party-Resolution §5.1)
   └─ אות חלש בלבד (name)        → fail-safe: לא ממזג; Party משלו
4. Output = ResolutionClaim     — belief קורגיבילי, לא constraint
```

### 3.1 Lead ↔ Customer (המקרה המרכזי)
- Lead עם phone X + Customer עם phone X → **שניהם claim לאותו Party.** Lead *לא* ממוזג לתוך Customer; שתי השורות נשארות, שתיהן מצביעות ל-Party אחד. (התפר `Conversation{customerId,leadId}` הוא היכן שזה הכי גלוי.)
- Lead שהפך ל-Customer = **התקדמות-תפקיד של אותו Party** (Party-Nature), לא ישות חדשה.

### 3.2 cross-role דרך אות משותף
- ה-candidate ב-step 2 יכול להיות role-row מ*תפקיד אחר* (Customer בעוד החדש Lead) — כי ההתאמה על *אות* (phone/taxId), לא על תפקיד. **זה מה שמחבר את הגרף חוצה-תפקיד.**

### 3.3 הערת corrigibility
- ה-claim layer *תומך* ב-challenge/retract/re-link (כשאות חדש מתגלה מאוחר — Update correction). **ה*מנגנון* של re-resolution יזום (merge של שני Parties קיימים על אות מאוחר) הוא runtime — Phase 1 *מאפשר* אותו מבנית, לא חייב להפעילו אוטומטית.** (שומר Phase 1 מינימלי.)

---

## 4. Anchoring (בלי לשנות, בלי לגעת ב-Billing-Frozen)

### 4.1 העיגון = שכבת ה-Claim, לא FK על role-row
> **אסור** להוסיף `partyId` כ-FK בודד על Customer/Lead — זה היה constraint (לא belief), ולא היה נושא provenance/confidence/challenge. **העיגון חי בשכבת ה-Claim.** ה-role-row→Party *נקרא דרך claims*, לא דרך עמודה קשיחה. (cache materialized = optimization runtime, לא source-of-truth.)

### 4.2 אירועים מתעגנים *transitively*, בלי שינוי
```
BillingDocument → customerId → Customer → (claim) → Party
Conversation    → customerId/leadId → Customer/Lead → (claim) → Party
Message         → customerId → Customer → (claim) → Party
```
> **שום טבלת-אירוע אינה משתנה.** "בהינתן Party → אירועיו" = מעבר claims→role-rows→דרך ה-FKs הקיימים. (FinancialEvent re-anchoring = OUT.)

### 4.3 Billing-Frozen — נשמר מוחלטית
- **קוראים** Customer→Party (דרך claim). **לעולם לא כותבים** ל-`BillingDocument`, לא נוגעים ב-`issuedSnapshot`/`customerNameSnapshot`/taxId-identity, לא ממזגים/משנים שורת Customer. **ה-Party layer additive read-over בלבד.**

---

## 5. Definition of Done (ולא גלישה ל-Phase 2)

### 5.1 ה-Design מממש את Phase 1 אם הוא מגדיר:
1. **Party** — עוגן-זהות דק, per-tenant, identity-only, additive.
2. **ResolutionClaim** — קורגיבילי (claim+confidence+basis+provenance+status), במראֶה PendingMatch.
3. **זרימת resolution** — strong-signal exact-match (phone+taxId), cross-role (Customer+Lead), fail-safe על סתירות/אות-חלש.
4. **Anchoring** — read-through (claims + FKs קיימים), אפס מוטציה, Billing-frozen נשמר.
5. **היכולת החדשה** — "בהינתן Party → role-rows + אירועיהם (Billing+Inbox) חוצה-תפקיד".

### 5.2 מבחן "לא גלש ל-Phase 2"
> ה-Design **חוצה את הקו ל-Phase 2 אם** הוא מזכיר: Region · Situation · Meaning · Relevance · Attention · surface · Recommendation · Learning · Memory · Character · Context-עשיר.
> **Phase 1 עוצר בגרף המחובר.** הוא *מאפשר* שיחושבו Situations מעליו — אך אינו מחשב אף אחת.

---

## 6. Explicit Non-Goals

| לא נכנס | phase/מיקום |
|---|---|
| **Supplier / vendorName / counterpartyName / supplierName** | phase תפקיד-ספק |
| **Situation / Region** | Phase 2 |
| **Attention / Relevance** | Phase 3 |
| **Recommendation** | Phase 4 |
| **Learning / Priors** | Phase 5 |
| **FinancialEvent Re-Anchoring** | Phase 2+ |
| **Fuzzy / name-based Matching** | מאוחר (זנב Suspected; MVB strong-only) |
| **UI / Human-confirmation Flow** | מאוחר (MVB auto-resolve על אות חזק) |
| **Role/Relationship extraction** | L3 refinement |
| **Memory / Character / full Context** | Phase 6 |
| **Global/Industry Priors** | Phase 5 (Phase 1 = local-only) |
| **`partyId` FK קשיח על Customer/Lead** | לעולם — מפר Corrigibility (link=belief) |
| **כל מוטציה ל-Customer/Lead/Billing** | לעולם — Additive + Billing-frozen |

---

## 7. תאימות להנחות-אל-תפר (אימות)

| הנחה | איך הצורה שומרת עליה |
|---|---|
| **Billing Frozen** | Party-layer additive read-over; אפס כתיבה ל-BillingDocument/Customer; snapshots נשארים קפואים (§4.3) |
| **Tenant Isolation** | Party ו-Claim per-businessId; אין Party/claim/אות חוצה-דייר (§1.1) |
| **Corrigibility** | Claim נושא basis+provenance+confidence+status; challenge/retract נתמכים; *גם exact* הוא claim לא constraint (§2.4) |
| **Human Sovereignty** | claim נושא `resolvedByUserId?`; אדם יכול לערער/לבטל; auto-resolve על אות חזק לא חוסם ערעור (§2.1) |
| **Local Reality** | resolution על אותות *מקומיים בלבד* (phone/taxId של הדייר); אפס priors (§6) |

---

## 8. תמצית הצורה

> **Phase 1 = שלוש שכבות additive: Party (עוגן דק) + ResolutionClaim (link קורגיבילי) מעל Customer/Lead הקיימים (ללא שינוי).**
> זרימה: extract strong signal → find candidate → claim (או singleton/fail-safe). Lead↔Customer מתחברים דרך אות משותף, cross-role, בלי merge. Anchoring = read-through; אירועים מתעגנים transitively דרך FKs קיימים; Billing-frozen מוחלט.
> **התוצר: גרף-Party מחובר, קורגיבילי, per-tenant — היכולת לשאול "מי אותו גורם" חוצה-תפקיד. עוצר בגרף; לא מחשב Situation; לא מציף.**

> **הצעד הבא (כשיאושר ה-Design): ירידה ל-Schema/Migration/Implementation בפועל** — הפעם הראשונה שנכתב קוד. עד אז, זו הצורה.

---

## נספח — מקור כל החלטת-צורה

| החלטה | מקור |
|---|---|
| Party=עוגן-זהות דק, additive, identity-only | Party-Nature; Readiness §6.1 |
| Claim=belief קורגיבילי, לא constraint; במראֶה PendingMatch | Corrigible-Resolution |
| strong-signal exact-match (phone/taxId), fail-safe | Party-Resolution §2/§9 |
| taxId↔phone=גבול אדם↔ארגון | Party-Resolution §5.1 |
| anchoring read-through, אפס מוטציה, Billing-frozen | Impact-Assessment §5; Readiness §4 |
| singleton ל-row חסר-אות (קיום ללא זיהוי) | ER §3.2 |
| Non-Goals + עצירה בגרף | Roadmap §3; Readiness §2 |
