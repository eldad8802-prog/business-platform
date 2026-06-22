# Dubiz Supplier Domain Design v1

> **מסמך עיצוב מודל-דומיין בלבד — לא קוד, לא Prisma, לא DB, לא API, לא UI, לא מיגרציות, לא Roadmap, לא משימות.**
> אם ה-Constitution הוא **"מה נכון"**, מסמך זה הוא **"מה קיים בעולם הזה"** — הישויות, היחסים, מחזורי-החיים והגבולות של עולם הספקים.
>
> **ביטוי ישיר של:** `dubiz-supplier-domain-constitution-v1.md` (v1.1, נעול). היכן שמסמך זה והחוקה מתנגשים — **החוקה גוברת**.
>
> שפה: דומיין-מוצרי, לא DDD-טכני. "Entity / Value Object / Aggregate" משמשים רק כשהם מבהירים בעלוּת ומחזור-חיים.
>
> סטטוס: Domain Design v1 (מיושר ל-Constitution v1.2 — Representation Resolution; ללא פערים מושגיים פתוחים).

---

## חלק 0 — מפת העולם (תקציר)

```
            PARTY (זהות)
              │  role: Supplier   role: Customer  (אותו Party יכול לשאת את שניהם)
              ▼
   ┌─────── SUPPLIER (role) ───────┐
   │   Connection (capability)     │      ← מה הספק יודע לעשות
   │   Catalog → Supplier Products │      ← Reported Reality (reference)
   └───────────────┬───────────────┘
                   │ Supplier-provided Evidence (External Accounts)
                   ▼
              DRAFT (staging)  ◄── שער הקליטה האוניברסלי (ידני/CSV/קטלוג/feed)
                   │ resolution: Supplier Product ──[MAPPING]──► Inventory Item
                   ▼  commit
       PURCHASE ORDER (Commitment Reality)
                   │ settled-by (1..many)
                   ▼
            RECEIVING (Physical Settlement)
                   │ append-only
                   ▼
   INVENTORY ITEM  ◄─ System of Record (Physical Reality)  [domain קיים — נצרך, לא נבעל]
```

מילת-המפתח: **שני עולמות נפרדים, ממברנה אחת.** עולם ה-Reference (Supplier/Catalog/Evidence) ועולם ה-Record (Inventory) נפגשים רק דרך **Mapping** (זהות) ו-**Receiving** (settlement).

---

## חלק 1 — Supplier

**מהי הישות:** **תפקיד (Role) על Party**, לא ישות-שורש. ה-Party הוא נושא-הזהות; "Supplier" הוא הקרנת "מוכר-לעסק-הזה". אותו Party יכול לשאת גם Customer.

**אחריות:** להיות עוגן ה-counterparty לרכש — לשאת את ה-Connection, את ה-Catalog, את קישורי ה-Mapping, ואת היסטוריית-המחיר; ולשמש כתובת-שיגור.

**מה היא יודעת:**
- את זהותה — דרך Party (אותות establishing: taxId, phone; corroborating: email; supporting: name).
- את יכולותיה (Connection).
- את הקטלוג שלה (reference).
- אילו מ-Supplier Products שלה נפתרו ל-Inventory Items (דרך Mapping).
- היסטוריית-מחיר *שנגזרה מ-Receivings* (Projection, לא reported).

**מה היא לא יודעת:** יתרות/תשלום, תנאים-מאוכפים, ניקוד-ביצועים, ואת אמת-המלאי (Record). היא **מתייחסת** ל-Inventory Items, לעולם לא **בעלת** עליהם.

**יחסים:**
- `Party` — מארח-הזהות (1:1 עם ה-role).
- `Connection` — composition (חלק ממנה; ראה חלק 2).
- `Catalog` → `Supplier Products` — reference שבבעלותה.
- `Mapping` links — boundary objects (לא בבעלותה הבלעדית; ראה חלק 5).
- `Purchase Order` — מתייחס אליה (ההזמנה ממוענת לספק); הספק אינו בעל ה-PO.

---

## חלק 2 — Supplier Connection

**מה זה במודל:** **Capability Profile — Value Object בבעלות ה-Supplier-role.** אינו Entity (אין לו זהות עצמאית), אינו Aggregate. הוא **תכונה** שעונה על "מה הספק יודע לעשות", ונשאלת בזמן-ריצה ע"י ה-flow היחיד.

**אחריות:** להצהיר על היכולות, לספק את מנגנון-השיגור, ולהתדרדר-בחן.

היכולות הן קבוצה מדורגת (degrade-ordered):
- **Baseline (תמיד):** WhatsApp / Email / PDF — שיגור-יוצא ידני.
- **אופציונלי:** order-receiver (שיגור ישיר), catalog-provider, price-provider, availability-provider, status-emitter.

**מחזור-חיים מינימלי:** ל-Connection עשוי להיות מצב פנימי קטן עבור credentials/config (configured → active → revoked), אך זהו **תת-עניין בבעלות ה-Supplier** — אין Connection בלי Supplier.

**קשר ל-Supplier:** composition מלא. נולד ומת עם ה-Supplier-role. **לעולם לא תכונה של ה-flow** — זה ה-linchpin שמחזיק "flow אחד".

---

## חלק 3 — Supplier Product

**מהי הישות:** **Entity בתוך ה-Catalog של ספק**, בעלת זהות-בתוך-ספק (ה-SKU של הספק). היא **נושאת Reported Reality בלבד** — "פריט כפי שהספק מוכר אותו" — לעולם לא Record.

**מחזור-חיים:**
1. **מופיעה** — מיובאת מקטלוג / נראתה לראשונה בשורת-Evidence (חשבונית/הזמנה).
2. **מתעדכנת** — מחיר/זמינות חדשים = Evidence חדש (Reported Reality, נושא timestamp → ניתן להתיישנות).
3. **נפתרת** — מקבלת Mapping ל-Inventory Item (חלק 5).
4. **נמשכת/מתבטלת** — הספק חדל להציעה (deprecated).

**יחס לקטלוג:** חברה (member) ב-Catalog של ספק יחיד.

**קיימת בלי Mapping?** **כן** — Supplier Product לא-ממופה הוא מצב לגיטימי (reference שלא נפתר / שאינני מחזיק). אין לו כוח תפעולי עד שמופה.

**בעלוּת:** ה-Supplier (דרך ה-Catalog). **לא** בבעלות ה-Inventory Item.

---

## חלק 4 — Supplier Catalog

**מה זה במודל:** **Collection בבעלות ה-Supplier** — אוסף ה-Supplier Products שלו + תכונותיהם המדווחות (מחיר/אריזה/זמינות). מתוחם-לספק.

**מה הוא לא:**
- **לא Projection** — Projection נגזר מ-Record פנימי (כמו Business Status); הקטלוג מגיע **מבחוץ** (Reported Reality).
- **לא Aggregate-של-אמת** — אינו סמכותי.
- **לא Collection פנימי** — הוא מראה-החוץ של הספק.

**תפקיד במודל:** מזין **הצעות** בזמן-יצירת-הזמנה, ו**מועמדי-פתרון** בזמן-קליטה. **לעולם אינו נכנס ל-Record.** טריוּתו (freshness) חלק מביטחונו — קטלוג ישן הוא Evidence חלש יותר.

> הבחנה חשובה: ה-Catalog הוא ה-Collection; כל מחיר/זמינות בתוכו הוא **Evidence נקודתי** (Reported Reality + provenance + זמן). הקטלוג = "מה הספק מציע"; כל ערך בו = "מה הספק טוען, ומתי".

---

## חלק 5 — Product Representation Resolution (Mapping)

**הלב.** **Representation Resolution** — פתרון ייצוג-הספק מול ייצוג-דוביז. מופע שלישי של דפוס ה-Resolution הקנוני (לצד Party ו-Situation), **רחב מ-Entity Resolution**: הוא פותר את הקשר Supplier Product ↔ Inventory Item לאורך **שני ממדים**, שניהם **קישורי-אמונה (binding-beliefs)**, לא טבלת-מיפוי קשיחה:

- **Identity Resolution** — *איזה* פריט פנימי.
- **Measure Resolution** — *כיצד מתורגם* ייצוג-הספק לייצוג-הפנימי.

### 5.1 הקישור עצמו (שני ממדים)
"Supplier Product X נפתר ל-Inventory Item Y, ביחס-ייצוג M" — **אמונות מוחזקות**, לא FK. הקישור נושא:
- **Identity** + **Confidence** (Known / Believed / Suspected / Unknown).
- **Measure** — **Representation Conversion**, לא רק Quantity. פותר *כל* הבדל-ייצוג בין עולם-הספק לעולם-דוביז: יחידות, אריזה (Purchase Units), נפח, משקל, Catch-Weight, פקטורי-המרה, ו**ייצוגים עתידיים שעדיין איננו מכירים**. ("ארגז = 12 בקבוקים" הוא מופע אחד בלבד; המודל אינו נעול עליו.)
- **Provenance** — לכל ממד: אילו אותות, מאיזה מקור/אירוע ("אישר הבעל בקליטת PO #..", "barcode מקטלוג #..", "factor נצפה בקליטה").
- שני הממדים **relational** (שייכים לקשר, לא לאף צד), ברי-התיישנות, ובעלי אותה משמעת-Resolution.

### 5.2 שקלול אותות (יורש מ-Party Resolution)
| שכבה | אותות (במוצרים) | תפקיד |
|---|---|---|
| **Establishing** (חזק, כמעט-ייחודי בתוך ספק) | **supplier SKU**, **barcode/GTIN** | מבסס → Known/Believed |
| **Corroborating** (בינוני) | שם מנורמל מדויק, עקביות אריזה/יחידה | מאשש, לא מבסס לבד |
| **Supporting** (חלש) | שם דומה (fuzzy) | תומך בלבד — **לעולם לא מבסס לבד** |

### 5.3 פעולות מחזור-החיים
- **Merge** — שני Supplier Products מתכנסים ל-Inventory Item אחד (אינהרנטי ל-many-to-one).
- **Split** — קישור שגוי מפורק: Supplier Product שמופה לפריט שגוי, או שמתאים לשני פריטים (ארגז-מעורב) → revision.
- **Correction (שלושת המצבים, Cross-Cutting B4):**
  - **Update (קדימה)** — הספק שינה אריזה/SKU → קישור חדש, הישן נכון-בזמנו.
  - **Revision (לאחור)** — הקישור היה *כוזב* → un-map וגזירה-מחדש.
  - **Recalibration** — ה*ביטחון* היה שגוי → כוונן רצועה בלי לשנות את הקישור.
- **Fail-safe** — אותות חלשים/סותרים → **אל תמפה אוטומטית**; החזק כ-Suspected/Unknown והצף לפתרון-אדם. over-map מזהם (הפיך); under-map בטוח.

### 5.4 ירושה מ-Party Resolution
- **זהות = השערה, לא מחרוזת** (ER §4).
- **Provenance מאפשר un-map בטוח** (ER §4 — יודעים *למה* קישרנו).
- **fail-safe אי-מיזוג בספק** (ER §8/§11).
- **מיקום אפיסטמי:** בין Party (דטרמיניסטי-חזק) ל-Situation (סיבתי-חלש). SKU/barcode חזקים-יחסית → ברירת-מחדל גבוהה מ-Situation, אך **עדיין אמונה, עדיין בר-תיקון, עדיין fail-safe**.

### 5.5 חיבור למציאות הקיימת
החלטת ה-MERGE/CREATE_NEW הקיימת בכל שורת-Draft **היא** אקט-הפתרון האנושי:
- **MERGE** = קישור Known מאושר-אדם ל-Inventory Item קיים.
- **CREATE_NEW** = אין קישור → צור Inventory Item + קישור Known.
הפער: היום הקישור **נפתר מחדש בכל פעם** ואינו נשמר כ-link בר-שימוש-חוזר נושא-confidence. במודל זה — הקישור הוא **first-class, נמשך, בר-תיקון**.

---

## חלק 6 — Purchase Flow Domain

**שלושה מושגים, שלוש אמיתויות נפרדות** (חוק שלוש ההתחשבנויות; קריסה = cardinal sin).

### Draft — Staging Aggregate
- משטח-עבודה נזיל שבו External Accounts (ידני/CSV/קטלוג/feed) נאספים כ-Evidence, מתפרשים (שורות נפתרות ל-Inventory Items דרך Mapping), ונבדקים.
- **שער הקליטה האוניברסלי** — כל קלט חיצוני נכנס דרכו.
- בעל את שורותיו ואת החלטות-הפתרון. **טרום-מחויבות; בר-ביטול.**
- מחזור-חיים: open/in-review → **commit** (מייצר PO) | rejected/abandoned.

### Purchase Order — Commitment Aggregate (Commitment Reality)
- רשומה ש**הזמנה הוצבה** מול ספק, מצופה אספקה. בעל את שורותיו (כמויות מוזמנות + הפניות-פריט שנפתרו). מתייחס ל-Supplier.
- **תוכן-המחויבות הוא היסטוריה בלתי-משתנה** — שינויים קורים דרך *אירועים חדשים* (Receiving, close-short, cancel), לא דרך עריכה.
- **מצבים מינימליים:** `Open` (מחויב/ממתין) · `Closed` (נקלט מלא או נסגר-בחוסר) · `Cancelled`. **התקדמות (ממתין/חלקי) נגזרת מכמויות שנקלטו — לא נשמרת כסטטוס.**

### Receiving — Settlement Aggregate (Physical Settlement)
- אירוע: מה הגיע פיזית. בעל את שורותיו (כמויות שנקלטו). מתייחס ל-PO + Inventory Items.
- נרשם כ-**Immutable Evidence** (provenance לפי אופן-אימות: human-counted=Physically-Human-Verified, feed=Provider-Attested).
- **הנתיב היחיד מעולם-הספקים ל-Record**: מייצר תנועת-מלאי append-only.

### יחסים
- `Draft` ──commit──► `PO` (Draft נפתר ל-PO אחד; staging תמיד קודם ל-commit).
- `PO` ──settled-by──► `Receiving` (1..many — אספקות חלקיות לאורך זמן).
- `Receiving` ──► `InventoryMovement` ──► `Inventory Item` (כניסת ה-Record).
- **מסלול-מהיר** ("הסחורה כבר כאן"): Draft שמתחייב ל-PO **ו**יורה Receiving מלא — **כשני אירועים שנורים יחד, לא אירוע אחד מאוחד.** ההפרדה המושגית נשמרת גם בקיצור.

---

## חלק 7 — Supplier-provided Evidence

**מה הוא:** כל External Account מספק — תוכן-קטלוג, מחיר, זמינות, מצב-הזמנה, תעודת-משלוח — הנטבע ל-**Evidence** מסוג **Reported Reality** (provenance: Provider-Attested / Interpreted; נושא timestamp).

**מה אינו Evidence-ספק:** Record (מלאי), Mapping (קישור), Commitment (PO), Physical Settlement (Receiving). ואינו "Signal".

**יחס ל-Draft:** **נכנס דרך ה-Draft בלבד** (שער הקליטה). order-confirmation feed → יוצר Draft; קטלוג → מזין הצעות ל-Draft-בבנייה; תעודת-משלוח → מ-pre-fill Receiving מוצע. כל קלט-ספק הופך לחומר-Draft.

**יחס ל-Mapping:** Evidence-ספק (שורות-קטלוג/חשבונית) הוא **חומר-הגלם** שה-Resolution ממפה. ה-Evidence נושא את מזהי-הספק (SKU/barcode/name); ה-Mapping פותר אותם ל-Inventory Items. Evidence-מחיר מעדכן את המחיר-המדווח של ה-Supplier Product ו**מיידע** (אך לעולם לא **קובע**) עלות — עלות-Record נקבעת רק ב-Receiving.

**יחס ל-Record:** **אין ישיר.** Evidence מיידע; רק Receiving כותב.

---

## חלק 8 — Aggregates · Boundaries · Ownership

### Aggregates (אשכולות שמשתנים יחד, עם שומר אחד)
| Aggregate | בעל | תוכן |
|---|---|---|
| **Party (+roles)** | Party Resolution domain | זהות + role-ים (Supplier/Customer) |
| **Supplier** | עולם-הספקים | role-anchor + Connection (VO) + הפניית-זהות |
| **Supplier Catalog** | ה-Supplier | Supplier Products + תכונות מדווחות |
| **Mapping/Resolution** | שכבת-הפתרון | קישורי binding-belief — **boundary object** בין ספק למלאי |
| **Inventory Item** | Inventory domain (קיים) | ה-Record; כמות נגזרת מתנועות append-only |
| **Purchase Order** | עולם-הספקים | מחויבות + שורות מוזמנות |
| **Receiving** | עולם-הספקים | אירוע-settlement + שורות שנקלטו |
| **Draft** | עולם-הספקים | staging + החלטות-פתרון (transient) |

### Boundaries (הקווים הקריטיים)
1. **גבול Reference↔Record** — Catalog/Evidence (reference) חוצה למלאי (record) **רק דרך Receiving + Mapping**. ה-Mapping היא הממברנה.
2. **גבול Commitment↔Settlement** — PO (מחויב) ו-Receiving (settled) נפרדים; התקדמות-נגזרת מקשרת, לעולם לא קורסת.
3. **גבול Identity** — זהות-ספק נפתרת ב-Party domain, לא מומצאת בעולם-הרכש.
4. **גבול Financial** — כסף/תשלום מחוץ לחלוטין; שייך ל-Documents.

### Ownership (תקציר)
זהות→Party Resolution · reference→Supplier · קישורים→שכבת-Mapping (boundary) · Record→Inventory (נכתב רק ב-Receiving) · Commitment→PO · Settlement→Receiving · **הכרעה→הבעל (ריבון)**.

---

## חלק 9 — Domain Invariants

1. **Supplier Product לעולם לא נושא Record** — רק Reported Reality.
2. **כמות Inventory Item נגזרת מתנועות append-only בלבד**; מעולם-הספקים — רק תנועת Receiving.
3. **Receiving אינו יכול לקרות אלא מול שורת-PO מחויבת שנפתרה ל-Inventory Item.** (אי-אפשר ליישב את מה שלא הוזמן וזוהה.)
4. **כל Mapping הוא קישור-אמונה נושא confidence + provenance, בר-תיקון**; אותות חלשים/סותרים → אין auto-map (fail-safe).
5. **PO הוא מחויבות; כמויותיו המחויבות הן היסטוריה בלתי-משתנה** — שינוי דרך אירועים חדשים, לא עריכה.
6. **זהות-ספק נפתרת דרך Party/Entity Resolution**; הרכש לעולם לא מכונן זהות-ספק ריבונית מ-name.
7. **Evidence-ספק נכנס רק דרך Draft**; אינו כותב Record ואינו קובע עלות (רק Receiving קובע).
8. **יכולות Connection אופציונליות ומתדרדרות לבסיס הידני**; שום יכולת אינה נדרשת להשלמת ה-flow.
9. **Catalog/מחיר/זמינות הם Reported Reality בת-התיישנות**; גילן חלק מביטחונן; לעולם לא מוצגות כעובדה-נוכחית בלי ההסתייגות.
10. **אותו Party יכול לשאת Supplier+Customer בו-זמנית** בלי קונפליקט.

---

## חלק 10 — Future Readiness

כל יכולת עתידית נכנסת **לתוך תפקיד קיים**, בלי לשנות זהות-ישות:

| יכולת עתידית | נכנסת כ- | פוגעת בזהות? |
|---|---|---|
| **Supplier API** | יכולת Connection + מקור-Evidence; מייצר Drafts | לא |
| **Catalog Sync** | מעדכן Supplier Catalog (Reported Reality) + מזין מועמדים ל-Resolution | לא |
| **Delivery Feeds** | מייצר Receiving מוצע (Physical-Settlement Evidence, Provider-Attested); הבעל מאשר / opt-in auto | לא |
| **Status Updates** | annotations של Reported Reality על PO פתוח — **לא מצבי-lifecycle חדשים** | לא |
| **Supplier Apps** | עוד ערוץ Connection; אותו flow | לא |

**המודל future-ready בהבנייה:** כל החמישה מתנקזים ל-{Connection / Evidence / Draft / Mapping / Receiving} — שכבות שכבר קיימות במודל. אין צורך בישות חדשה, ואין שינוי זהות.

---

## חלק 11 — פערים מושגיים (סטטוס)

המודל הוא **ביטוי ישיר** של ה-Constitution. הפער היחיד שזוהה ב-Design v1 **נסגר ב-Constitution v1.2**:

1. **נסגר ✅ — תרגום-ייצוג (Measure).** הפער ("ה-Mapping פותר זהות *וגם* יחידה") הוכרע: ה-Mapping הוא **Representation Resolution** (Identity + Measure), ו-**Measure = Representation Conversion** (יחידה/אריזה/נפח/משקל/catch-weight/עתידי) — מעוגן ב-Constitution v1.2 חלק 4 + invariant 15. אין עוד פער פתוח.
2. **הבהרה: Draft תמיד קודם ל-PO** — גם "הזמנה ישירה" נושאת staging מרומז. לא פער, חידוד.
3. **הבהרה: היסטוריית-מחיר היא Projection** (נגזרת מ-Receivings), **נבדלת מהמחיר-המדווח** (Reported Reality בקטלוג). שני מושגי-מחיר, מקורות שונים.

---

## מסקנה

המודל הזה הוא **ביטוי ישיר של ה-Constitution (v1.2)** — כל ישות, גבול ומחזור-חיים נגזר מחוק קנוני. הפער המושגי היחיד (תרגום-ייצוג ב-Mapping) **נסגר** עם אימוץ **Representation Resolution**. **לא נותרו פערים מושגיים מהותיים.** ה-Domain Model שלם ומוכן לשמש בסיס לתכנון מימוש (DB/API/UI) — מבלי לשבור את זהות הדומיין כשייכנסו APIs, Sync, Feeds, Status ו-Apps.
