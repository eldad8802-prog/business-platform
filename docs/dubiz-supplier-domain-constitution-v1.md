# Dubiz Supplier Domain Constitution v1.2

> **מסמך חוקה מושגי בלבד — לא קוד, לא Prisma, לא טבלאות, לא API, לא UI, לא מיגרציות, לא Roadmap, לא משימות.**
> הוא מגדיר את **המושגים והגבולות** של עולם הספקים, הרכש, הקטלוגים והקישוריות בדוביז — *מה נכון ומה לא נכון* — לפני כל תכנון.
>
> **מעמד:** כפוף לקנון העליון של דוביז ויורש אותו במלואו. היכן שמסמך זה והקנון מתנגשים — **הקנון גובר**. מסמך זה אינו ממציא פרימיטיבים אפיסטמיים; הוא **מחיל** את הפרימיטיבים הקיימים על עולם הספקים.
>
> **יורש מ:** Evidence & Reality Constitution · Signals Dissolution Note · Cross-Cutting Constitution (9 החוקים) · Party Resolution (Entity Resolution) · Situation Constitution · Business Brain Product Constitution.
>
> **מיועד להחזיק גם בעוד 5 שנים** כאשר יהיו Supplier APIs, Catalog Sync, Delivery Feeds, Status Updates ו-Supplier Apps — מבלי לשבור את הקנון.
>
> סטטוס: Constitution v1.2 (Canonically Aligned + Representation Resolution). מחליף את v1.1.

---

## עיקרון-על

דוביז מחזיקה ב**מלאי, בזהות-המוצר ובתהליך-הרכש**. ספק *רשאי* לספק קטלוג, מחיר, זמינות, קישוריות-הזמנה ועדכוני-מצב — אך **לעולם אינו הופך למקור-הרשומה ולעולם אינו מכריע**. כל דבר שמגיע מספק הוא **External Account** הנטבע ל-**Evidence** מסוג **Reported Reality**, בתחתית סולם ה-provenance.

> **בקיצור: דוביז מחזיקה את הרשומה והרצון; הספק מותר לו רק להציע, להעשיר ולהזדרז — לעולם לא להכריע ולעולם לא להחליף.**

---

## חלק 0 — מיקום בקנון (מה מסמך זה יורש)

עולם הספקים אינו תחום אפיסטמי חדש. הוא **החלה** של הקנון הקיים:

| מושג בעולם הספקים | הפרימיטיב הקנוני שהוא מחיל |
|---|---|
| זהות ספק | **Party + Entity Resolution** (Supplier = role על Party) |
| מיפוי מוצר-ספק | **Representation Resolution** — Entity Resolution (Identity) + Measure Resolution; binding-beliefs ברי-תיקון |
| קטלוג / מחיר / זמינות / סטטוס מספק | **External Account → Evidence → Reported Reality** |
| הזמנה (PO) | **Commitment Reality** (חוק שלוש ההתחשבנויות) |
| קליטה (Receiving) | **Physical Settlement** הנרשם כ-**Immutable Evidence** |
| מלאי | **System of Record של Physical Reality** (high-but-decaying) |
| סמכות הבעל | **Agency / Human Sovereignty** (חוק הריבונות) |

**אין צורך בעקרונות חדשים — רק ביישומם.** היכן שמסמך זה נדמה כממציא משהו, הוא טועה ויש לתקנו לקנון.

---

## חלק 1 — Supplier

**מהו:** **תפקיד (Role) על Party.** Supplier אינו ישות-שורש; הוא הקרנת-תפקיד "מוכר-לנו" על הקשר Party↔business. זהותו **כפופה ל-Party Resolution** ככל זהות אחרת במערכת.

**אותו Party יכול להיות:**
- **Supplier** (מוכר לעסק),
- **Customer** (קונה מהעסק),
- **Both** (שני תפקידים סימולטניים על אותו Party).

**זיהוי (כפוף ל-Entity Resolution):**
- זהות = **השערה מוחזקת** נושאת-confidence ו-provenance — לא מחרוזת ולא מפתח-קשיח.
- אותות establishing חזקים (taxId, phone) מבססים זהות; **name הוא Supporting בלבד** ולעולם אינו מבסס לבדו.
- **fail-safe:** בספק — אל תמזג (over-merge חוצה-תפקיד הוא הפרת בידוד וזהות).
- "קידום" שם-חופשי לספק מזוהה הוא **resolution הדרגתי על אותות חזקים**, לא הסבה על name.

**מה הוא כן:** counterparty נושא-יכולות, עוגן לקטלוג/מיפוי/היסטוריית-מחיר, וכתובת לשיגור הזמנה.

**מה הוא לא:**
- **לא CRM** — אין pipeline, אין מחזור-קשר-כמוצר.
- **לא Portal** — הספק **לעולם אינו מתחבר לדוביז ואינו משתמש בה**.
- **לא Marketplace node** — אינו discoverable, אינו מדורג, אין לו זהות-רשת.
- **לא נושא אמת פיננסית** — אין יתרות, אין AP/AR, אין אכיפת-תנאים.

**אחריותו:** לעגן מקור, ערוץ, יכולות, קטלוג, מיפוי והיסטוריית-מחיר.
**מה אסור להעמיס עליו:** יתרות, חוזים-מאוכפים, ניקוד-ביצועים, CRM, וכל Financial Settlement.

---

## חלק 2 — Supplier Connection

**מה מייצג:** ה**יכולות** שספק נתון חושף לדוביז — ערוץ-שיגור, ויכולת לספק קטלוג/מחיר/זמינות/עדכוני-מצב. זוהי **תכונה של ה-Supplier-role**, לעולם לא של ה-flow.

**מה מאפשר:**
- **העשרת קלטים** — pre-fill מ-Evidence שהספק מספק (קטלוג/מחיר/זמינות).
- **אוטומציה של שיגור** — העברת ההזמנה ישירות לספק.
- **הוספת Evidence על התקדמות** — עדכוני-מצב כ-External Accounts מעל הזמנה פתוחה.

**מה אסור לו לשנות:**
- את גרף-השלבים (אסור להוסיף/להסיר/לתזמן-מחדש/לחסום שלב).
- את מיקום סמכות-ההחלטה (תמיד אצל הבעל).
- את עקרון ה-flow היחיד.
- את ה-System of Record (המלאי).
- **אסור לו להפוך את עצמו לחובה.**

**האם חיבור משנה את ה-flow? לא. הוא רק מעשיר אותו.** ה-flow אינווריאנטי; החיבור משנה רק את *מקור-המילוי* של שלב ואת *מנגנון-השיגור* — לעולם לא את השלבים, סדרם, או מי שמכריע.

**חוק הנפילה (Degradation):** כל יכולת חייבת להתדרדר-בחן אל בסיס ה-WhatsApp/Email/PDF. יכולת שלא יכולה להתקיים עבור ספק ידני — אינה העשרה, היא גלישה (עקבי עם Fail-safe ואסימטריה, Cross-Cutting F1/F4).

---

## חלק 3 — Supplier Product

**מה מייצג:** פריט **כפי שהספק מתאר ומוכר אותו** — שורה בקטלוג הספק או בחשבוניתו (ה-SKU שלו, השם, האריזה, המחיר). זהו **External Account** מהספק; כשנקלט הוא **Evidence** מסוג **Reported Reality** — צד-שלישי *טוען* קיום/מחיר/זמינות, לא אמת.

**היחס ל-Inventory Item:** Supplier Product הוא **תיאור זר** שחייב **להתמפות** ל-Inventory Item כדי לקבל משמעות תפעולית. הוא Evidence/Reference, לא רשומה.

- **האם יכול להתקיים בלי Inventory Item?** **כן** — כ-Evidence לא-ממופה (שורת-קטלוג שעדיין לא נפתרה / שאינני מחזיק). אין לו כוח תפעולי עד שמופה.
- **האם Inventory Item יכול להתקיים בלי Supplier Product?** **כן, וזו ברירת המחדל.** ה-Inventory Item ריבוני; לרוב הפריטים אין כלל קישור לספק-מוצר.
- **מי מחזיק בזהות המוצר?** **ה-Inventory Item. תמיד.** Supplier Product הוא alias/claim שמצביע עליו, לעולם לא ההפך.

---

## חלק 4 — Supplier Product Mapping (Representation Resolution)

**מהו:** **Representation Resolution** — פתרון *ייצוג-הספק* מול *ייצוג-דוביז*. מופע שלישי של דפוס ה-Resolution הקנוני (לצד Party ו-Situation), אך **רחב מ-Entity Resolution**: הוא פותר את הקשר Supplier Product ↔ Inventory Item לאורך **שני ממדים**, ושניהם **binding-beliefs ברי-תיקון** (לא טבלת-מיפוי קשיחה):

- **ממד א׳ — Identity Resolution:** *איזה* פריט פנימי. (Entity Resolution קלאסי.)
- **ממד ב׳ — Measure Resolution:** *כיצד מתורגם* ייצוג-הספק לייצוג-הפנימי.

> **Measure אינו Quantity Conversion — הוא Representation Conversion.** תפקידו לפתור *כל* הבדל-ייצוג בין עולם-הספק לעולם-דוביז, כל עוד מדובר בתרגום ייצוג: יחידות (Units), אריזה (Packaging / Purchase Units), נפח (Volume), משקל (Weight), Catch-Weight, ופקטורי-המרה — וכן **ייצוגים עתידיים שעדיין איננו מכירים**. המודל **אינו נעול** על "ארגז = 12 בקבוקים"; זו רק מופע אחד של תרגום-ייצוג. כל עוד מדובר בגישור בין ייצוג-הספק לייצוג-הפנימי — זה Measure.

**שני הממדים שייכים לקשר, לא לאף צד:** כשם שהזהות שייכת לקשר (לא ל-Supplier Product לבדו ולא ל-Inventory Item לבדו), כך גם ה-Measure — הוא **relational** (תלוי בזוג ספק-מוצר↔פריט-פנימי) ובר-התיישנות. לכן שניהם יושבים על ה-Mapping.

**תכונות מחייבות (שני הממדים יורשים אותן):**
- **Binding belief** — גם הזהות וגם ה-Measure הם אמונות מוחזקות, לא מפתחות/קבועים קשיחים.
- **Confidence** — רצועה (Known / Believed / Suspected / Unknown). *Identity:* SKU/barcode = establishing → Known/Believed; name בלבד = Supporting → Suspected, לא מקשר אוטומטית. *Measure:* factor מדווח-בקטלוג = Reported (נמוך); factor נצפה-בקליטה = Physically-Human-Verified (גבוה).
- **Provenance** — נושא *אילו אותות ומאיזה מקור* הצדיקו **כל ממד** (חובה — Cross-Cutting B3).
- **Corrigible** — שני הממדים ברי-תיקון ע"י ראיה וע"י הבעל. שלושת מצבי-התיקון (Cross-Cutting B4): ספק שינה אריזה/SKU → **Update (קדימה)**; קישור/factor כוזב → **Revision (לאחור)**; ביטחון שגוי → **Recalibration**.
- **Mergeable / Splittable** — many-to-one: הרבה Supplier Products (חוצי-ספקים, חוצי-אריזות) → Inventory Item אחד, כל אחד עם ה-Measure שלו; קישור שגוי ניתן לפירוק (un-merge בטוח דרך provenance).
- **Fail-safe** — בספק, **אל תפתור אוטומטית** (לא זהות ולא Measure); החזק כ-Suspected והצף לאדם. over-resolution מזהם (הפיך); under-resolution בטוח.

**מה אסור:**
- אסור להפוך הפוך — Inventory Item **לעולם לא מוגדר ע"י** Supplier Product (לא בזהותו ולא ביחידתו).
- אסור שקישור/sync ידרוס זהות / Measure / תכונות של פריט פנימי.
- אסור שייהפך לקטלוג-מוצרים שני.
- אסור שיחסום או יזיז מלאי בעצמו.

**איך מגן על אמת המלאי:** הוא **ממברנת-Resolution** שבולעת את כל השונוּת החיצונית — בזהות (שינויי-שם/SKU) **ובייצוג** (אריזות/יחידות/נפח/משקל) — כ-binding-beliefs ברי-תיקון, כך שה-**Inventory Item** הריבוני נשאר יציב **ביחידה אחת קוהרנטית**. כל אי-ודאות חיצונית נעצרת בשכבת-הפתרון, מוחזקת בביטחון מפורש, ולעולם אינה מטפסת לרשומה כעובדה.

---

## חלק 5 — Supplier Catalog

**מהו:** שכבת **Reference** — אוסף ה-Supplier Products שספק מציע (מחירים/אריזות/זמינות), מתוחם-לספק. אפיסטמית: גוף של **Reported Reality** (טענות הספק).

**מה הוא לא:** לא מלאי, לא System of Record, לא product-master, לא marketplace listing.

**האם מקור-רשומה? לא. Reference / Reported Reality בלבד** — provenance נמוך (Provider-Attested / Interpreted), תקרת-ביטחון נמוכה.

**מתי נכנס לתהליך:** ביצירת-הזמנה (להציע מה להזמין) ובקליטה (לסייע לפתור שורות מול Inventory Items דרך ה-Mapping).
**מתי יוצא:** **לעולם אינו נכנס ל-System of Record.** הוא מתממש לרשומה **אך ורק דרך Receiving (Physical Settlement) + Mapping**. הקטלוג עצמו נשאר External/Reference תמיד — הוא מזין הצעות ו-Evidence, ולעולם אינו נשמר כרשומה תפעולית.

---

## חלק 6 — Draft · Purchase Order · Receiving

שלושה מושגים, שלושה רגעים, שלוש אמיתויות נפרדות. **קריסתם לאחד אסורה** — הקריסה היא ה-cardinal sin "Settlement-collapse" (Evidence & Reality, Part VII).

מעוגן ב**חוק שלוש ההתחשבנויות** (Evidence & Reality, Part IV): `Committed`, `Physical Settlement`, ו-`Financial Settlement` הם **אורתוגונליים** ואסור להסיק אחד מהשני.

| מושג | מהו אפיסטמית | תפקיד |
|---|---|---|
| **Draft** | טרום-מחויבות (Pre-commitment) | משטח staging + reconciliation; **שער הקליטה האוניברסלי** לכל External Account (ידני / CSV / קטלוג / feed). שם Accounts נטבעים ל-Evidence ומתפרשים (matching → Mapping). נזיל, בר-ביטול |
| **Purchase Order** | **Commitment Reality** | רשומה ש**מחויבות הוזמנה** מספק. ודאות גבוהה *שהמחויבות קיימת*; **אינה אומרת דבר** על אספקה או תשלום. **לא מלאי. לא כסף.** |
| **Receiving** | **Physical Settlement** | האירוע הפיזי שקרה (סחורה התקבלה). נרשם כ-**Immutable Evidence** עם provenance **לפי אופן האימות**: `Physically-Human-Verified` כשאדם סופר ומאשר (הדרגה הרשומה החזקה ביותר), `Provider-Attested` כשתעודת-משלוח/feed טוענת ומתקבלת. **הכניסה היחידה ל-System of Record מתוך עולם-הספקים**, כתנועת-מלאי append-only |

**הקשר המפורש ל-Evidence & Reality:**
- **PO = Commitment Reality** — "an order was placed" (Part II / Part IV "Committed"). אסור להציגו כ-Physical Settlement ("הוזמן" ≠ "הגיע") או כ-Financial Settlement ("הוזמן" ≠ "שולם").
- **Receiving = Physical Settlement**, וה**רשומה** שלו היא **Evidence בלתי-משתנה** (חוק האי-משתנות, Cross-Cutting #3), נושאת provenance לפי אופן האימות (Physically-Human-Verified / Provider-Attested). תנועת-המלאי היא ה-Observation ה-append-only; כמות-המלאי הנוכחית היא **interpretation נגזרת ובת-תיקון**.
- **Financial Settlement בלתי-נצפה** בדוביז (Evidence & Reality, Part IV). לכן עולם הספקים **אינו טוען דבר על תשלום**; האמת הפיננסית שייכת ל-Documents.

> **למה הם לא אותו דבר:** הם נושאים שלוש אמיתויות נפרדות — *staging-של-טרום-מחויבות* מול *מחויבות* מול *settlement פיזי*. קריסתם הורסת את היכולת להבחין בין "הוזמן" ל"הגיע" ל"שולם" — וזו בדיוק ההפרה שהקנון אוסר.

---

## חלק 7 — Supplier-provided Evidence (לשעבר "Supplier Signals")

> מסמך זה **אינו** מכיר בפרימיטיב "Signal" (עקבי עם Signals Dissolution Note). כל דבר שמגיע מספק הוא **External Account** הנטבע ל-**Evidence**.

**מהו:** כל נתון שמקורו מחוץ לדוביז, מספק — מחיר, זמינות, מצב-הזמנה, תוכן-קטלוג, תעודת-משלוח. כולם **External Accounts** → **Evidence** מסוג **Reported Reality** (צד-שלישי טוען משהו).

**האם הוא אמת? לא.** הוא **Evidence** — witness-statement נושא-provenance, לא רשומה ולא עובדה על העולם.
**האם הוא המלצה? מבחינת מעמדו — הוא קלט ייעוצי:** רשאי ל-pre-fill, להציע, ולעטר הזמנה פתוחה.

**מעמדו במערכת (כפוף ל-Laws of Claiming, Evidence & Reality Part VI):**
- provenance: **Provider-Attested** או **Interpreted/Machine-Inferred** — תקרת-ביטחון נמוכה.
- **אסור** לשנות את ה-System of Record אוטומטית.
- **אסור** לדרוס החלטת-בעל.
- **אסור** להציגו כעובדה היכן שהוא נוגע ברשומה, בלי אישור-בעל (איסור No-category-promotion: Reported ≠ Observed).
- עדכוני-מצב מספק הם **annotations מעל הזמנה פתוחה**, **לא** מצבי-מחזור-חיים חדשים-חובה. (זה מונע החייאת lifecycle כבד דרך הדלת האחורית.)

**מחיר, Measure ועלות-Record:** ספק מדווח מחיר **per purchase-unit** (₪X לארגז) — זהו Evidence (Reported Reality) על ה-Supplier Product. ה-**Measure** ב-Mapping ממיר *גם כמות וגם מחיר* ליחידות-מלאי. **עלות-ה-Record (per stock-unit) נקבעת אך ורק ב-Receiving (Physical Settlement)** — ה-Evidence-מחיר *מיידע* אותה, לעולם לא *קובע* אותה. (Catch-weight: ה-Measure הנומינלי הוא Reported/נמוך; הכמות בפועל נלכדת ב-Receiving כ-Physically-Verified ו**גוברת** — נפתר ע"י סולם ה-provenance, בלי מנגנון חדש.)

---

## חלק 8 — Authority & Provenance (שני צירים נפרדים)

ההיררכיה **Owner > Inventory > Supplier** היא **היררכיית סמכות-החלטה ורשומה — לא היררכיית עוצמת-ראיה.** אלה שני צירים שונים, ואין לבלבלם:

**ציר א׳ — סמכות (מי מכריע ומי מחזיק את הרשומה):**
| דרגה | תפקיד | מקור קנוני |
|---|---|---|
| **Owner** | **Agency Authority** — הריבון; מזיז רצון; הכרעה סופית | חוק הריבונות (Cross-Cutting #8); Human Sovereignty (Product Const. 2.3) |
| **Inventory** | **Operational Record** — System of Record של Physical Reality | חוק האי-משתנות (#3) על התנועות |
| **Supplier Evidence** | **External Account** — טענה חיצונית, ייעוצית | Reported Reality (Evidence & Reality Part II) |

**ציר ב׳ — עוצמת-ראיה (כמה ביטחון ראיה נושאת):** נשלט ע"י **סולם ה-provenance** (Evidence & Reality Part III): `Physically-Human-Verified > Observed > Provider-Attested > Interpreted > Human-Entered`.

> **חשוב — הצירים אינם זהים:** קליטה *Physically-Human-Verified* היא ראיה **חזקה** יותר מערך שהבעל הקליד ידנית ("Human-Entered — low as fact, rots over time"). לכן סמכות-ההחלטה של הבעל **אינה** אומרת שכל נתון שהזין הוא הראיה החזקה ביותר. הבעל **מכריע**; הרשומה הפיזית **מעידה**. ערבוב שני הצירים הוא confidence-laundering.

---

## חלק 9 — Invariants (חוקים שאסור להפר; תקפים גם בעוד 5 שנים)

גם כשיהיו Supplier APIs, Catalog Sync, Delivery Feeds, Status Updates ו-Supplier Apps:

1. **Inventory Item הוא ה-System of Record של Physical Reality** — high-but-decaying, **לא אמת אבסולוטית**. (staleness היא חלק מביטחונו; Cross-Cutting #4, A8.)
2. **Supplier Product לעולם לא מחליף Inventory Item** — רק נפתר אליו (Identity + Measure) דרך binding-beliefs ברי-תיקון.
3. **כל מידע חיצוני נכנס דרך Draft** כ-External Account הנטבע ל-Evidence. אין דלת אחורית ל-System of Record.
4. **ה-System of Record משתנה רק דרך תנועות append-only.** מתוך עולם-הספקים, **הנתיב היחיד הוא Receiving (Physical Settlement)** — שום קטלוג/feed/עדכון-מצב/External Account לא נוגע ברשומה ישירות ולא עורך תנועה קיימת. (תנועות לא-ספקיות — מכירה/תיקון/נזק — הן מחוץ לתחום מסמך זה.)
5. **Supplier הוא Role על Party**; זהותו כפופה ל-Party Resolution. **Connection הוא תכונה של ה-Supplier-role**, לעולם לא מצב-משתמש ולא ענף-flow.
6. **Flow אחד לכל הספקים.** היכולת מסתעפת פנימית; המשתמש לא בוחר מסלול.
7. **נפילה מובטחת אל WhatsApp/Email/PDF.** כל יכולת מתדרדרת-בחן לבסיס הידני.
8. **Catalog הוא Reference / Reported Reality**, לעולם לא System of Record ולעולם לא מקור-הכרעה.
9. **PO = Commitment Reality. Receiving = Physical Settlement.** הם נפרדים; קריסתם היא cardinal sin (Settlement-collapse).
10. **Supplier-provided Evidence = Reported Reality, ייעוצי, provenance נמוך** — לעולם לא רשומה, לעולם לא דורס החלטת-בעל. עדכוני-מצב הם annotations, לא מצבי-חובה.
11. **זהות-המוצר נשמרת בדוביז.** Mapping מצביע פנימה בלבד; לעולם לא הפוך.
12. **שום יכולת חיצונית אינה הופכת לחובה.** העשרה היא אופציה הפיכה, לא תנאי.
13. **Financial Settlement אינו נצפה בעולם הספקים.** אין כאן טענות על תשלום; אמת פיננסית = Documents.
14. **כל פתרון (Supplier identity, ו-Mapping על שני ממדיו — Identity ו-Measure) נושא confidence + provenance ובר-תיקון.** בספק — fail-safe: אל תפתור אוטומטית.
15. **Measure הוא Representation Conversion, לא רק Quantity.** הוא פותר כל הבדל-ייצוג (יחידה / אריזה / נפח / משקל / catch-weight / עתידי) בין עולם-הספק לעולם-דוביז, על ה-Mapping. מחיר מדווח per-purchase-unit מתורגם דרכו; **עלות-Record נקבעת ב-Receiving בלבד**.

---

## חלק 10 — Anti-Goals (מה Supplier Domain *לא* יהיה)

- **לא ERP** — אין מחזור-חיי-הזמנה כבד, אין workflows רב-שלביים, אין multi-role-permissions.
- **לא Marketplace** — אין discovery של ספקים/מוצרים, אין דירוגים, אין רשת דו-צדדית, אין onboarding של זרים.
- **לא Supplier CRM** — אין pipeline, אין ניהול-קשר-כמוצר, אין ניקוד-ביצועים.
- **לא Three-way-matching engine** — אין התאמת PO↔משלוח↔חשבונית כמנוע.
- **לא AP automation / מערכת חשבונאות** — אין יתרות, GL, או Financial Settlement. זה **Documents**.
- **לא Supplier Portal** — הספק לעולם אינו ישות-משתמש בדוביז.
- **לא Catalog-as-master** — הקטלוג לעולם אינו ה-product master; ה-Inventory Item הוא.
- **לא Auto-procurement** — אין auto-PO שמסיר את הבעל מסמכות-ההחלטה; הצעות נשארות הצעות.
- **לא Signal-as-primitive** — "Signal" אינו אובייקט שהמערכת מאחסנת/מעבדת; הכול Evidence/Belief.

---

## מסקנה — מהו Supplier Domain בדוביז

> **Supplier Domain בדוביז הוא שכבת-עוגנים ו-Evidence חיצונית בשירות ה-System of Record הפנימי — ולא להפך.**
>
> ה-**Supplier** הוא Role על Party (כפוף ל-Party Resolution), נושא-יכולות, לא CRM ולא portal. ה-**Connection** הוא תכונה שלו שמעשירה את ה-flow היחיד ולעולם לא משנה אותו. ה-**Catalog** ועדכוני-המצב הם **Reported Reality** — External Accounts הנטבעים ל-Evidence, בתחתית סולם ה-provenance. ה-**Supplier Product** הוא תיאור-זר שחייב להיפתר פנימה; ה-**Mapping** הוא **Representation Resolution** — פותר זהות *וגם* ייצוג (Identity + Measure) כ-binding-beliefs נושאי-confidence-ו-provenance, ברי-תיקון ו-fail-safe — הבולע את כל השונוּת החיצונית כדי שה-**Inventory Item** הריבוני (ה-System of Record של Physical Reality) יישאר יציב ביחידה אחת קוהרנטית. ו-**Draft → PO → Receiving** הם שלושת רגעי-האמת הנפרדים — טרום-מחויבות, **Commitment Reality**, ו-**Physical Settlement** — שדרכם בלבד, ורק ב-Receiving, משתנה הרשומה.
>
> דוביז מחזיקה את הרשומה ואת הרצון; הספק מותר לו רק להציע, להעשיר ולהזדרז — לעולם לא להכריע ולעולם לא להחליף.

---

## נספח — מקור קנוני לכל התאמה

| התאמה | מקור קנוני |
|---|---|
| הסרת "Signal" כפרימיטיב → Evidence / Reported Reality / External Account | Signals Dissolution Note |
| PO = Commitment Reality (לא Intent) | Evidence & Reality Part II/IV; חוק שלוש ההתחשבנויות |
| Receiving = Physical Settlement כ-Immutable Evidence | Evidence & Reality Part III/IV; Cross-Cutting חוק #3 |
| Supplier = Party Role; זהות כפופה ל-Party Resolution | Party Nature · Party Resolution · Entity Resolution |
| Mapping = **Representation Resolution** (Identity + Measure) | Party Resolution · Situation Constitution (דפוס Resolution Engine); Cross-Cutting B4 (3 מצבי-תיקון) |
| **Measure = Representation Conversion** על ה-Mapping; מחיר per-purchase-unit → עלות-Record ב-Receiving | Evidence & Reality Part III/IV; חוק שלוש ההתחשבנויות **(v1.2 closure)** |
| Inventory = System of Record של Physical Reality + staleness | Evidence & Reality Part II; Cross-Cutting #4, A8 |
| Authority ≠ Evidence-strength (שני צירים) | Cross-Cutting חוק #8 (ריבונות) + Evidence & Reality Part III (provenance) |
| כל קישור נושא confidence + provenance, fail-safe | Cross-Cutting B3, F1; Entity Resolution |
| אמת פיננסית מחוץ לתחום | Evidence & Reality Part IV; Product Constitution (Documents = financial-truth engine) |
