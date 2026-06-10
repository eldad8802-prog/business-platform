# Dubiz Party Resolution — Architecture Investigation v1

> **חקירת ארכיטקטורה מושגית — לא קוד, לא Prisma, לא טבלאות, לא API, לא מימוש, לא מפתחות-DB.**
> מטרה: לענות על שאלת ה-"איך" הראשונה במסע — **איך המוח מסיק ששתי הופעות בעולם הן אותו Party?**
>
> מעוגן בקוד הקיים. נשען על: Party Nature Investigation · Entity Resolution · Constitution · Reality Graph Investigation.
> זהו הצעד האחרון של Shared Reality Discovery לפני Brain Wiring. סטטוס: Architecture Investigation v1.

---

## חלק 0 — המסגרת: Party Resolution *הוא* Entity Resolution מוחל על Party

זיהוי-Party אינו תחום חדש. Party הוא Entity (Party Nature §8); זיהויו נשלט ע"י **Entity Resolution doc** במלואו (זהות=השערה מוחזקת §4 · רצועות ביטחון §8 · reality-vs-truth §9 · over-merge קטסטרופלי §11). **אין צורך בעקרונות חדשים — רק ביישומם על Party.** מסמך זה *ממפה את היישום*, לא ממציא מנגנון.

---

## חלק 1 — אותות הזהות הקיימים בפועל (שאלה 1)

| אות | מצב בקוד | טבע |
|---|---|---|
| **phone (קנוני)** | `normalizeCustomerPhone` — IL-aware, מנרמל ל-972, **"source of truth" לזהות Customer**; `(businessId, phone)` unique | **דטרמיניסטי, חזק** |
| **taxId (+taxIdType)** | על `Customer` (AUTHORIZED_DEALER/EXEMPT/LTD/PRIVATE_ID) — **קיים, אך *לא* בשימוש לזיהוי**, רק billing | **חזק, כמעט-ייחודי — אות סמוי לא-מנוצל** |
| **email** | על Customer/Supplier — לא מפתח | בינוני |
| **name** | בכל מקום; מפתח *רק* ל-vendors (`VendorLearning @@unique[businessId,vendorName]`) | **חלש, עמום** |
| **WhatsApp identity** | senderPhone → `normalizeCustomerPhone` (= phone) | = phone |
| **vendor normalization** | `VendorLearning` (name→category, confidence, **isGlobal**) | **name-based + נלמד** |
| providerMessageId/wamid | dedup הודעות | ❌ לא זהות-Party |

> **הממצא #1: שני מנגנוני-זיהוי נפרדים כבר קיימים** — *Customer = exact-match על phone קנוני* (דטרמיניסטי, unique constraint), ו-*Vendor = exact-match על name* (נלמד, עם confidence ו-priors). **שונים, חד-אותיים, ולא מדברים זה עם זה.**

---

## חלק 2 — המשקל הארכיטקטוני של כל אות (שאלה 2)

לפי ER §4 (זהות = תכונת-גרף, לא מחרוזת):

| שכבה | אותות | תפקיד |
|---|---|---|
| **Establishing** (חזק, כמעט-ייחודי) | **taxId** (זהות משפטית), **phone** (קנוני) | *מבסס* זהות — match → Known/Believed |
| **Corroborating** (בינוני) | email, WhatsApp-identity(=phone) | *מאשש*, לא מבסס לבד |
| **Supporting** (חלש, עמום) | name | *תומך* בלבד — לעולם לא מבסס לבד (הרבה "דוד כהן") |
| **Relational** (גרף) | רשת הקשרים/אירועים (מי קונה מה, מחובר למי) | אות עמוק (ER §4) — זהות מהמיקום בגרף |

> **הממצא #2: המערכת היום מסתמכת על אות *Establishing* יחיד פר-תפקיד** (phone ל-Customer, name ל-Vendor). הבעיה: ל-Vendor המפתח הוא דווקא ה-*Supporting* (name) — חלש. **ה-taxId (החזק ביותר) סמוי ולא-מנוצל לזיהוי כלל.**

---

## חלק 3 — Confidence בזיהוי Party (שאלה 3)

> **כיום הזיהוי בינארי:** exact phone match → Known (אותו Customer), אחרת → create-new. **אין Believed/Suspected — זו הצורה המנוונת של ER.** עובד *בתוך* תפקיד (phone ל-customers), לעולם לא *חוצה* תפקיד או אות.

זיהוי חוצה-אות הוא הסתברותי → דורש את מודל ה-Confidence המלא:

| ראיה | רצועה |
|---|---|
| אותו **taxId** | **Known** (זהות משפטית) |
| אותו **phone קנוני** | **Known/Believed** (phone יכול להיות משותף/ממוחזר — חזק לא מוחלט) |
| **email + name תואמים** | **Believed** |
| name דומה + עיר זהה | **Suspected** — לא ממזג, מסמן |
| **name בלבד** | **Unknown** — לא ממזג |

- **עדכון:** אישוש (אותות עצמאיים מסכימים) מעלה; סתירה מורידה (Constitution C2, Ingestion §5).
- **fail-safe:** בספק, **אל תמזג** (ER §8/§11 — under-merge הפיך, over-merge קטסטרופלי וחוצה-פרטיות).

> **הממצא #3: המעבר הארכיטקטוני הוא מ-*בינארי-דטרמיניסטי* ל-*מדורג-confidence*** — אך רק עבור הזנב העמום. הרוב (taxId/phone exact) נשאר Known דטרמיניסטי.

---

## חלק 4 — Provenance בזיהוי (שאלה 4)

> כל טענת-קישור ("Customer #5 = vendorName 'Acme'") רושמת *אילו אותות ומאיזה מקור* הצדיקו אותה ("אותו taxId, ממסמך #12 + billing #8").

- זה הופך כל קישור ל**בר-תיקון** (reality-vs-truth, ER §9): אם האות המקשר התברר שגוי — הקישור ניתן לפירוק.
- **Provenance הוא מה שמאפשר un-merge בטוח:** ה-over-merge הקטסטרופלי הפיך *רק* כי יודעים *למה* מיזגנו (חוק האי-משתנות — האותות append-only; הקישור בר-תיקון).
- היום אין שכבת-קישור מפורשת (הזיהוי הוא unique-constraint סמוי) → **אין provenance לקישור, אין un-merge.** זה פער ארכיטקטוני לזנב ההסתברותי.

---

## חלק 5 — אותות סותרים (שאלה 5)

| התנגשות | הכרעה |
|---|---|
| **אותו phone, שמות שונים** | כנראה *אותו* Party (phone חזק, name חלש — כינויים/שגיאות). phone מנצח; החזק את שני השמות |
| **אותו name, טלפונים שונים** | כנראה *שונים* (name חלש — שני "דוד כהן"). **לא למזג על name לבד** |
| **taxId מול phone** (אותו taxId/phone שונה, או להפך) | **המקרה הקשה** — ר' §5.1 |

### 5.1 ההתנגשות taxId↔phone = גבול אדם↔ארגון (חיבור ל-Party Nature §5)
- אותו **taxId**, phone שונה → אותה *ישות משפטית*, מגע שונה (חברה עם 2 טלפונים) → **אותו Party** (taxId מנצח לזהות-ארגון).
- אותו **phone**, taxId שונה → טלפון משותף (אדם פרטי *וגם* חברה) → **אולי שני Parties**, או Party אחד עם 2 זהויות-מס.

> **התובנה: taxId מזהה את הזהות *המשפטית/ארגונית*; phone מזהה את המגע *האנושי*. כשהם מתבדרים, אתה לרוב על גבול ה-Person↔Organization** (טלפון דוד, taxId של Acme = שני Parties + קשר represents, Party Nature §5). **פתרון ההתנגשות *משתמש* בהבחנת ה-Kind:** אל תכפה מיזוג phone-identity (אדם) עם taxId-identity (ארגון) — אולי שני Parties בקשר. **כלל-על: אות חזק מנצח; אותות חזקים סותרים → ביטחון נמוך + השאר נפרד + סמן.**

---

## חלק 6 — Lead → Customer (שאלה 6)

- **Party Nature: אותו Party, התקדמות-תפקיד.** ארכיטקטונית: Lead ו-Customer עם *אותם אותות-זהות* (phone) הם *אותו Party*; "Lead"/"Customer" הם תפקידים על הקשר לעסק, וה-role התקדם.
- **כיום:** Lead ו-Customer ישויות נפרדות — *שתיהן נושאות phone, אך אין זיהוי ביניהן* (`Lead.phone` ו-`Customer.phone` משתמשים באותו אות, לא נפתרים יחד). הקוד כבר חושד: `Conversation` נושא customerId+leadId.
- **הארכיטקטורה צריכה לחשוב:** Lead.phone ו-Customer.phone → *אותו מפתח-establishing* → אותו Party. ההתקדמות Lead→Customer = שינוי-תפקיד על קשר, לא ישות חדשה. **פער קונקרטי: אותו אות (phone) משמש את שתי הישויות אך לא מזהה ביניהן.**

---

## חלק 7 — Customer ↔ Supplier (שאלה 7)

- **Party Nature: אותו Party, שני תפקידים סימולטניים.** Customer ו-Supplier עם אותם אותות = *אותו Party* עם שני תפקידים.
- **הקשרים שנוצרים:** Party↔business (תפקיד-לקוח: קונה מאיתנו) **וגם** Party↔business (תפקיד-ספק: מוכר לנו) — שני role-relationships על Party אחד.
- **כיום:** Customer (phone-keyed) ו-Supplier (name-keyed) משתמשים ב*אותות שונים* → **גם אם אותו אדם, המערכת לא יכולה לקשר.** פער קונקרטי: מנגנוני-זיהוי שונים פר-תפקיד מונעים זיהוי-חוצה-תפקיד מבנית.

---

## חלק 8 — מה כבר קיים להישען עליו (שאלה 8)

| רכיב | מה הוא נותן ל-Party Resolution |
|---|---|
| **`normalizeCustomerPhone`** | resolver phone קנוני דטרמיניסטי — **היסוד**. כבר "source of truth" לזהות. הערה בקוד: "extending to full E.164 הוא strict superset בלי שינוי call-site" |
| **`(businessId, phone)` unique** | ה-exact-match הקיים (Known דטרמיניסטי) |
| **`VendorLearning`** | resolver name-based עם **confidence + isGlobal (priors)** — מנגנון *שני* קיים, מדגים confidence+priors |
| **`taxId`/`taxIdType`** | אות חזק קיים, **לא-מנוצל לזיהוי** — קטיף-קל |
| **`Conversation{customerId,leadId}`** | הרמז הקיים "אולי אותו Party" |

> **הממצא #8: הזיהוי כבר קיים — בצורתו המנוונת (exact-match חד-אותי) ומבודד פר-תפקיד.** הארכיטקטורה אינה "לבנות resolver מאפס" — אלא **להכליל את ה-resolver הקיים להיות חוצה-תפקיד ורב-אות, עם confidence לזנב העמום.**

---

## חלק 9 — Minimum Party Resolution (שאלה 9)

> מ-Reality Graph §5: הגרף נשבר על Party. כדי לחבר — צריך ש-5 הקרנות-התפקיד יזוהו לזהות אחת.

**ה-Minimum אינו resolver הסתברותי מלא.** הוא:

> **להכליל את ה-exact-match הדטרמיניסטי הקיים (phone) להיות *חוצה-תפקיד*, ולהוסיף את האותות החזקים הקיימים (taxId, email) כמפתחות-זיהוי משותפים.**

| מה | למה זה המינימום |
|---|---|
| **phone חוצה-תפקיד** | כבר קנוני; כבר ה-source-of-truth ל-Customer; להחיל על Lead/Supplier/counterparty |
| **taxId כמפתח** | אות establishing הכי חזק, קיים, לא-מנוצל — קטיף מיידי |
| **email כמאשש** | קיים |
| הזנב העמום (name-only) | **נשאר נפרד / Suspected** — fail-safe, לא חלק מהמינימום |

### 9.1 העיקרון
> **הרוב הניתן-לזיהוי מתאחד דטרמיניסטית** (taxId/phone exact = Known) ומחבר את הגרף **בלי fuzzy matching.** המקרים העמומים (name-only) נשארים נפרדים (fail-safe) — שיפור עתידי, לא מינימום. **המינימום בטוח כי הוא נשען על אותות חזקים בלבד; over-merge נמנע במבנה.**
>
> וזה כבר חצי-קיים: phone קנוני עובד (ל-Customer), VendorLearning מדגים confidence+priors, taxId שוכב מוכן. **המינימום = להפוך את ה-resolver הקיים מ-per-role ל-cross-role, ולהפעיל את ה-taxId הסמוי.**

---

## חלק 10 — הארכיטקטורה המושגית בתמצית

```
אותות (phone/taxId/email/name/גרף)
   │ משוקללים: Establishing > Corroborating > Supporting
   ▼
טענת-קישור ("R1 = R2 = אותו Party")
   │ נושאת Confidence (Known/Believed/Suspected/Unknown)
   │ נושאת Provenance (אילו אותות, מאיזה מקור)
   ▼
Party (זהות מעוגנת)  ← roles (Customer/Lead/Supplier) על ה-Party↔business Relationship
   │
   ├─ אותות סותרים → אות חזק מנצח; חזקים-סותרים → ביטחון↓ + השאר נפרד + סמן (גבול אדם↔ארגון)
   ├─ fail-safe: בספק אל תמזג (over-merge קטסטרופלי+חוצה-פרטיות)
   └─ reality-vs-truth: קישור בר-תיקון דרך Provenance (un-merge בטוח)
```

### 10.1 איך Identity נוצרת/מתחזקת/מתעדכנת/מקבלת Confidence
- **נוצרת:** הופעה ראשונה (אות) → Party provisional (אולי Unknown-identity, קיום בלי זיהוי — ER §3.2).
- **מתחזקת:** אות establishing (taxId/phone) → Known.
- **מתעדכנת:** אישוש מעלה ביטחון; סתירה מורידה; אות חדש מקשר תפקיד נוסף.
- **Confidence:** מהתכנסות אותות *עצמאיים* (Ingestion §5), יחסי-לסיכון (Constitution C4): מיזוג שמסתיר ריכוז/חוצה-פרטיות דורש ביטחון גבוה יותר.

---

## חלק 11 — ההכרעה: סוף Shared Reality Discovery

> **איך המוח מסיק ששתי הופעות הן אותו Party?** ע"י **השוואת אותות-זהות משוקללים** (taxId/phone establishing · email מאשש · name תומך · גרף עמוק), **הפקת טענת-קישור נושאת-Confidence-ו-Provenance**, **הכרעת סתירות לפי עוצמת-אות** (עם גבול אדם↔ארגון ב-taxId↔phone), ו**fail-safe של אי-מיזוג בספק**. כל זה הוא **Entity Resolution מוחל על Party** — תחום שכבר הוגדר.

**המינימום לחיבור הגרף:** להכליל את ה-exact-match הדטרמיניסטי הקיים (phone) ל-cross-role, ולהפעיל את taxId הסמוי. דטרמיניסטי, בטוח, חצי-קיים. **הזנב ההסתברותי (name-based, Suspected) הוא שיפור עתידי, לא חלק מהמינימום.**

> **זהו סוף ה-Shared Reality Discovery.** שאלת הזהות הוכרעה ברמת המושגים: *מה* Party (Identity Primitive), *איך* מזהים (אותות משוקללים + confidence + provenance + fail-safe), ו*מה המינימום* (exact-match חוצה-תפקיד על אותות חזקים). **המוח מוכן ל-Wiring** — החיווט הראשון הוא הכללת ה-resolver הקיים ל-cross-role. שאלות ה-"מהו X" הסתיימו; שאלות ה-"איך" מתחילות, וזו הראשונה שבהן הוכרעה.

---

## נספח — מקור לכל ממצא

| ממצא | מקור |
|---|---|
| phone קנוני = source-of-truth, IL-aware, E.164-extensible | `lib/services/integrations/whatsapp/phone.ts` |
| זיהוי Customer = upsert על (businessId, phone) | `conversation-intake.service.ts` |
| taxId/taxIdType קיים (billing, לא-לזיהוי) | `lib/billing/customer-tax-identity.ts` |
| Vendor = name-match נלמד + confidence + isGlobal | `VendorLearning` (schema) |
| Conversation{customerId, leadId} | schema |
| Party = Identity Primitive; roles על Relationship | Party Nature Investigation |
| זהות=השערה, רצועות, reality-vs-truth, over-merge קטסטרופלי | Entity Resolution §4/§8/§9/§11 |
| Confidence: התכנסות עצמאית, יחסי-לסיכון, fail-safe | Constitution C2/C4, Ingestion §5 |
| Party הוא ה-blocker; חצי-איחוד קיים | Reality Graph Investigation §5 |
