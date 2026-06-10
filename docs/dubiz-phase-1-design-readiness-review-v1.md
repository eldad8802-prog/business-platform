# Dubiz Phase 1 Design Readiness Review v1

> **ביקורת מוכנות — לא Design, לא Schema, לא Runtime, לא Migration, לא קוד.**
> מטרה: לוודא שאין פער ארכיטקטוני בין מה שהוגדר לבין המעבר ל-Phase 1 Design. **שער אחרון לפני חציית הקו.**
>
> נשען על: Roadmap · Party Nature · Party Resolution · Reality Graph · Corrigible Resolution · Impact Assessment. סטטוס: Readiness Review v1.

---

## חלק 1 — האם כל התלויות של Phase 1 סגורות?

| תלות | מה Design צריך ממנה | מצב |
|---|---|---|
| **Party Nature** | מה Party (Identity Primitive; roles על Relationship; Kind אורתוגונלי) | ✅ Closed |
| **Party Resolution** | איך מזהים (אותות משוקללים; phone/taxId=establishing; confidence; fail-safe; taxId↔phone=גבול אדם↔ארגון) | ✅ Closed |
| **Reality Graph** | Party=ה-blocker; Event/Commitment נגזרים-מ-Party; minimum=cross-role exact-match | ✅ Closed |
| **Corrigible Resolution** | resolution=belief נושא-provenance, לא constraint; תבנית PendingMatch | ✅ Closed |
| **Impact Assessment** | היכן נוגע (Customer/Lead/Conversation seam); Billing-frozen=גבול; blast radius צר | ✅ Closed |

> **אין שאלה מושגית או ארכיטקטונית פתוחה החוסמת Design.** מעבר לכך — הארכיטקטורה לא רק *מתירה* Design אלא **מגבילה את ההחלטה הראשונה** (חלק 6.1), מה שהוא סימן מוכנות, לא חוסר.

### 1.1 בדיקת חורים-חבויים (מה ש*לא* גלוי)
| חשד | הכרעה |
|---|---|
| היכן ה-Party-link חי ביחס ל-Customer/Lead הקיימים? | **לא חור** — הארכיטקטורה מכריעה: שכבת-זהות + link-claim *additive* מעל role-rows קיימים (לא merge הרסני). מוכתב ע"י Corrigible(belief לא constraint)+Billing-frozen+Party=Identity-Primitive (חלק 6.1) |
| מתי ה-resolution רץ (sync/async)? | **לא חור** — runtime detail; ארכיטקטונית הוא חלק מ-Ingestion→Reality (Awareness-Lifecycle) |
| האם MVB צריך human-confirmation flow? | **לא חור** — exact-match על אות חזק = Known = auto-resolve; corrigibility ב-MVB = *provenance רשום* (מאפשר ערעור עתידי), לא flow של אישור-אדם |
| Glossary hygiene / Foundation split | **לא חוסם** — לא נוגע ב-Party Resolution; דחוי |

---

## חלק 2 — Scope מדויק של Phase 1 (ההבהרה הקריטית)

> **הבהרה שחייבת להינעל לפני Design: Phase 1 ≠ MVB-מלא.**
> ה-Roadmap הגדיר את ה-MVB כפרוסה *end-to-end* (Party→Situation→surface) הפורשת Phases 1-3. **Phase 1 הוא רק השכבה הראשונה שלה — שכבת ה-Reality.**

### 2.1 נכנס ל-Phase 1
- **שכבת-זהות Party** (additive מעל role-rows קיימים).
- **Corrigible resolution על אותות חזקים בלבד**: phone (קנוני, קיים) + taxId (קיים, להפעיל). exact-match דטרמיניסטי = Known. **provenance + confidence band נרשמים.**
- **Cross-role: Customer + Lead** (שני התפקידים על תפר ה-`Conversation{customerId,leadId}`).
- **Anchoring קריא**: בהינתן Party — לאתר את ה-Customer-rows/Lead-rows שלו ואת אירועיהם (billing docs, conversations/messages) חוצה-תפקיד.
- tenant-scoped (businessId); Billing-frozen מכובד (read-only מעל Customer).

### 2.2 נשאר בחוץ (מפורש)
- **Situation / Region / Attention / Recommendation / Learning** → Phases 2-5. **Phase 1 *אינו* מציף situation.**
- **Supplier / vendorName / counterpartyName / supplierName** → phase תפקיד-ספק.
- **FinancialEvent re-anchoring** (counterparty→Party) → Phase 2+.
- **Fuzzy / name-based resolution** (זנב Suspected) → מאוחר (fail-safe: נשאר נפרד).
- **Human-confirmation flow / UI** → מאוחר.
- **Role/Relationship extraction** (roles off entities) → L3.
- **Memory / Character / full Context** → מאוחר.

> **התובנה: "Phase 1 MVB" שבכותרת = השכבה התחתונה של ה-MVB, לא ה-MVB השלם.** Phase 1 מספק **גרף-Party מחובר וקריא** — לא awareness מוצפת. ה-awareness המוצפת היא תוצר Phases 2-3 *מעל* היסוד הזה.

---

## חלק 3 — Definition of Done ל-Phase 1

**היכולת החדשה שלא קיימת היום:**
> **המערכת יכולה לענות: "בהינתן Party המזוהה מאות חזק — אילו Customer-rows, Lead-rows ואירועיהם (billing, conversations) חוצה-פיצ'ר שייכים לאותו גורם אמיתי?"** = גרף-Party מחובר, חוצה-תפקיד, קריא.

קריטריוני סיום:
1. **זיהוי חוצה-תפקיד עובד** — Lead שהפך ל-Customer (phone משותף) נפתר ל-**Party אחד**; שני אנשים שונים ללא אות משותף → **שני Parties**; אות חלש בלבד (name) → **לא ממזג**.
2. **כל link הוא belief קורגיבילי** — confidence (Known ל-exact) + provenance (איזה אות, מקור) + revisable (ניתן לערעור/ביטול) — **לא constraint עיוור**.
3. **Additive ולא-הרסני** — `Customer.@@unique([businessId,phone])` ו-Billing snapshots **ללא שינוי**.
4. **Tenant isolation נשמר** — Party פר-דייר; אפס קישור חוצה-דייר.
5. **בר-בדיקה ברמת הגרף** — בלי תלות בשכבות Meaning/Attention.

> **DoD ברמת ה-Reality, לא ברמת ה-surface.** ההצלחה נמדדת בכך שהגרף מחובר וקריא — לא בכך שמשהו מוצף למשתמש.

---

## חלק 4 — הנחות שאסור להפר

| הנחה | בתוך Phase 1 |
|---|---|
| **Billing Frozen** | לקרוא Customer; **לעולם לא** לשנות snapshots מונפקים / `customerNameSnapshot` / `issuedSnapshot` / taxId-identity. Party-link הוא *additive read-over*, לא מוטציה/merge של שורות |
| **Tenant Isolation (F6)** | Party פר-דייר (businessId); אפס link חוצה-דייר; אפס אות חוצה-דייר |
| **Corrigibility (חוק 7)** | כל link נושא-provenance ובר-תיקון — *גם* exact-match דטרמיניסטי. **אסור constraint עיוור** (זו ההפרה שכבר קיימת ב-phone-resolution) |
| **Human Sovereignty (חוק 8)** | auto-resolve מותר על אות חזק, אך אדם תמיד יכול לערער/לבטל link; אישור-אדם (כשיהיה) ריבוני, למידה רק מסמנת |
| **Local Reality over Priors** | Phase 1 = **אותות מקומיים בלבד** (phone/taxId של הדייר הזה); **אפס priors גלובליים/ענפיים** ב-resolution של MVB (אלה phase למידה מאוחר). "Local decides" מסופק טריוויאלית — MVB מקומי-בלבד |

---

## חלק 5 — סיכונים ארכיטקטוניים אחרונים (לא Implementation)

| # | סיכון ארכיטקטוני | מיטיגציה (מההחלטות הנעולות) |
|---|---|---|
| 1 | **Scope creep מ-Reality ל-Situation/surface** — פיתוי "להראות משהו" ע"י איגוד Phases 2-3 ל-1 | DoD ברמת-גרף, לא surface (חלק 3). Phase 1 לא מציף |
| 2 | **link-as-constraint** — Design יושיט יד ל-unique/FK קשיח (פשוט יותר), יפר Corrigibility | ה-link *חייב* belief נושא-provenance, גם ל-exact-match |
| 3 | **breach של Billing-frozen** — פיתוי להוסיף partyId FK ל-BillingDocument או למזג Customer | link-layer additive בלבד; BillingDocument/Customer ללא שינוי |
| 4 | **over-merge מהנחת phone-unique** — phone משותף (2 אנשים) / phone ממוחזר | phone=חזק-לא-מוחלט (Known/Believed); taxId חזק יותר לארגון; אותות-חזקים-סותרים → לא למזג + סמן (taxId↔phone=גבול אדם↔ארגון) |
| 5 | **Lead→Customer כ-merge-then-delete** | additive link (אותו Party, התקדמות-תפקיד), לא הריסת שורת Lead |

> כל החמישה כבר **מוכרעים ע"י החלטות נעולות** — אינם חורים, אלא גבולות ש-Design חייב לכבד.

---

## חלק 6 — מוכנות

### 6.1 הארכיטקטורה מגבילה את ההחלטה הראשונה (= סימן מוכנות)
> Design לא מתחיל מלוח ריק. שלוש החלטות נעולות *מכתיבות* את כיוון ההחלטה הראשונה:
> - **Resolutions=beliefs לא constraints** → שכבת link/resolution, לא merge הרסני.
> - **Billing-frozen** → Customer-rows נשארות; ה-link additive מעליהן.
> - **Party=Identity Primitive; roles על Relationship** → Party=צומת-זהות נבדל; Customer/Lead=הקרנות-תפקיד.
>
> ⇒ הכיוון מוכתב: **שכבת-זהות Party + link-claims קורגיביליים הממפים role-rows קיימים ל-Party, additive, בלי לגעת ב-role-rows.** Design ממלא צורה, לא ממציא כיוון.

### 6.2 ההכרעה

> ## ✅ READY
>
> **כל התלויות הארכיטקטוניות של Phase 1 סגורות. אין חור ארכיטקטוני שלא ראינו.** הארכיטקטורה לא רק מתירה Design — היא מגבילה את ההחלטה הראשונה (§6.1), מספקת אותות (phone/taxId), תבנית (PendingMatch), תפר (Conversation), וגבול-רגישות יחיד ברור (Billing-frozen).
>
> **תנאי-נעילה יחיד לפני Design:** לאשר את הבהרת ה-Scope (חלק 2) — **Phase 1 = שכבת ה-Reality של ה-MVB (גרף-Party מחובר וקריא), *לא* ה-MVB השלם end-to-end.** זה אינו חור; זו מסגרת-scope שמונעת scope-creep.
>
> **NOT READY היה דורש:** שאלת "מהו/איך X" פתוחה, או גבול-רגישות לא-ממופה, או תלות לא-סגורה. **אף אחד מאלה אינו קיים.**

### 6.3 הצעד הבא
> אם מאושר — המסמך הבא הוא **Phase 1 Design** עצמו: הצורה הקונקרטית של שכבת-הזהות וה-link הקורגיבילי, על phone+taxId, cross-role Customer+Lead, תוך כיבוד Billing-frozen. **שם, בפעם הראשונה במסע, נוגעים ב-schema/קוד בפועל.**

---

## נספח — צ'ק-ליסט המוכנות

| בדיקה | מצב |
|---|---|
| Party Nature סגור | ✅ |
| Party Resolution Architecture סגור | ✅ |
| Reality Graph (Party=blocker) סגור | ✅ |
| Corrigible Resolution (belief לא constraint) סגור | ✅ |
| Impact Assessment (blast radius + Billing-frozen) סגור | ✅ |
| אותות חזקים קיימים (phone/taxId) | ✅ |
| תבנית קורגיבילית קיימת (PendingMatch) | ✅ |
| תפר זיהוי קיים (Conversation{customerId,leadId}) | ✅ |
| גבול-רגישות ממופה (Billing-frozen) | ✅ |
| הנחות-אל-תפר מוגדרות (חלק 4) | ✅ |
| Scope MVB מובהר (Phase 1 = Reality-layer) | ⚠️ **לאישור** (חלק 2) |
| חור ארכיטקטוני לא-ראוי | ❌ אין |
| **מוכנות ל-Phase 1 Design** | **✅ READY** (בכפוף לאישור §2) |
