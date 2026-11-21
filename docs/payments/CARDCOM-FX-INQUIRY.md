# פנייה ל־CardCom — חיוב בדולר ובאירו, התחשבנות ודוחות כספיים

**מצב:** טיוטה לשליחה על ידי בעל העסק / מנהל המערכת. שום חיוב לא בוצע ושום הגדרה לא שונתה.
**נבדק מול:** תיעוד ה־API הרשמי של CardCom, גרסה 11 (`https://secure.cardcom.solutions/swagger/v11/swagger.json`, נבדק 2026-10-22), והאינטגרציה הקיימת בדוביז (`lib/services/payments/providers/cardcom/`).

---

## חלק א׳ — נוסח הפנייה

> שלום רב,
>
> אנחנו מפעילים את דוביז, מערכת לניהול עסקים קטנים בישראל, שמתחברת ל־CardCom דרך API גרסה 11
> (LowProfile לדף תשלום, ו־GetTransactionInfoById לאימות). אנחנו רוצים לאפשר לעסקים שלנו לגבות
> גם בדולר (USD) ובאירו (EUR), ולהציג להם בדיוק כמה חויב הלקוח, כמה הופקד להם ובאיזה מטבע, ומה
> היו העמלות. נשמח לתשובות לשאלות הבאות:
>
> **1. חיוב במטבע זר**
> 1.1. האם מסוף רגיל מאפשר חיוב ב־USD וב־EUR, או שנדרש מסוף נפרד, הגדרה במסוף או אישור מחברת הסליקה?
> 1.2. האם נדרש הסכם נפרד או תוספת להסכם לכל מטבע? האם יש תנאים מיוחדים (למשל סוגי כרטיסים, כרטיסים
> זרים בלבד, עסקאות טלפוניות)?
> 1.3. האם ניתן לחייב באירו עם `ISOCoinId = 978`? האם `TransactionInfo.CoinId` יחזיר 978 לעסקה באירו?
> 1.4. האם תשלומים (installments) נתמכים בעסקאות במטבע זר?
>
> **2. מטבע ההתחשבנות וההפקדה**
> 2.1. כשהלקוח מחויב בדולר או באירו — באיזה מטבע הכסף מופקד לבית העסק? האם זה תלוי בחברת הסליקה,
> במותג הכרטיס או בהגדרת המסוף?
> 2.2. אם הסכום מומר לשקלים — מי מבצע את ההמרה, באיזה שער ובאיזה מועד (יום העסקה, יום הקליטה או יום ההפקדה)?
> 2.3. האם השדות `CurrencyOrIndexRate` ו־`EffectiveCurrencyOrIndexRate` בדוח `Financial/FinancialTransactions`
> הם שער ההמרה שהוחל בפועל? מה ההבדל ביניהם?
>
> **3. הרשאות לדוחות הכספיים**
> 3.1. האם כל חשבון עם `ApiName` ו־`ApiPassword` רשאי לקרוא `Financial/FinancialTransactions` ו־`Financial/BankDeposites`,
> או שנדרשת הפעלה או הרשאה נוספת?
> 3.2. מה תפקיד השדה `Certification` בבקשות האלה, והאם הוא חובה?
> 3.3. מה השדה `SapakNumber` ואיפה בית העסק מוצא אותו?
> 3.4. האם יש מגבלות קצב או טווח תאריכים לשליפה?
>
> **4. התאמה בין עסקה להפקדה**
> 4.1. האם `FinancialTransactions.CreditCardTransactionsId` זהה ל־`TranzactionId` שמוחזר ב־`GetTransactionInfoById`?
> אם לא — לפי איזה שדה מומלץ להתאים (`UID`, `ARN`, `ConcentrationNumber`)?
> 4.2. האם `DepositeAmount` הוא הסכום נטו לאחר כל העמלות? אילו מהשדות `IfAmtDepoCur`, `FixFeeAmtDepoCurr`,
> `FeePerTrnAmt`, `VatIfNisDepoCur` מרכיבים את סך העמלה, ובאיזה מטבע כל אחד מהם?
> 4.3. בעסקה בתשלומים — האם כל תשלום מופיע כשורה נפרדת (`PmtNo` / `NoOfPmt`) ומופקד במועד נפרד?
> 4.4. האם סכום `BankDeposites.Amount` הוא סכום השורות ב־`FinancialTransactions` עם אותו `BankDepositesId`?
>
> **5. החזרים במטבע זר**
> 5.1. ב־`Transactions/RefundByTransactionId` אין שדה מטבע. האם ההחזר מתבצע תמיד במטבע העסקה המקורית,
> ו־`PartialSum` נמדד במטבע הזה?
> 5.2. באיזה שער מומר החזר שמקוזז מהפקדה בשקלים? האם עמלות מוחזרות?
> 5.3. האם ניתן לשלוף את עסקת ההחזר לפי `ExternalRefundDealId` או `NewTranzactionId`?
>
> **6. מועדי הפקדה**
> 6.1. כמה זמן עובר מעסקה עד הפקדה, בשקלים ובמטבע זר?
> 6.2. האם `EstimateDepositeDate` מחייב או הערכה בלבד?
>
> תודה,
> [שם, תפקיד, פרטי קשר]

---

## חלק ב׳ — מה כבר ידוע מהתיעוד הרשמי

| נושא | ממצא | מקור |
|---|---|---|
| קוד מטבע | `ISOCoinId`: ‏1 = ILS, ‏2 = USD, ואחרת קוד ISO 4217 מספרי — ולכן 978 לאירו **תואם לתיעוד** | `CreateLowProfile.ISOCoinId`, `TransactionInfo.CoinId` |
| נתוני עסקה | `TransactionInfo` מחזיר `Amount` ו־`CoinId` בלבד. **אין** עמלה, נטו, שער או מטבע הפקדה | `TransactionInfo` |
| דוח עסקאות כספי | `POST /api/v11/Financial/FinancialTransactions`: מטבע עסקה (`CreditCardCurrency`), מטבע הפקדה (`DepositeCurrency`), סכום הפקדה (`DepositeAmount`), עמלות (`IfAmtDepoCur`, `FixFeeAmtDepoCurr`, `FeePerTrnAmt`), מע"מ על העמלה (`VatIfNisDepoCur`), שער (`CurrencyOrIndexRate`, `EffectiveCurrencyOrIndexRate`), תאריך הפקדה משוער, מזהה הפקדה (`BankDepositesId`), מספר תשלום (`PmtNo`) | `FinancialTransactions` |
| דוח הפקדות | `POST /api/v11/Financial/BankDeposites`: מזהה, תאריך, סכום, מטבע וחשבון בנק | `BankDeposites` |
| הרשאות | שני הדוחות דורשים `ApiName` **וגם** `ApiPassword`, ואולי גם `Certification`. דוביז כבר שומרת את `apiName` ו־`apiPassword` בחיבור (מוצפנים) | `FinancialTransactionsReq`, `BankDepositesReq`, `cardcom.provider.ts:157` |
| החזר | ל־`RefundByTransactionId` יש `PartialSum` ו־`CancelOnly`, **אבל אין שדה מטבע** | `RefundByTransactionIdReq` |

**לא ידוע מהתיעוד** (ולכן מופיע בפנייה): אם המסוף מאושר למטבע זר, אם נדרש הסכם, מטבע ההפקדה בפועל, משמעות השערים, ההרשאה לדוחות, ההתאמה בין המזהים, וההחזרים.

---

## חלק ג׳ — איך דוביז תשתמש בדוחות (תכנון, לא מומש)

רשומת `PaymentSettlementFact` (PR #769) מיועדת בדיוק לנתונים האלה. הזרימה:

1. **חיוב** (קיים היום): העסקה מאומתת דרך `GetTransactionInfoById`, ונרשמת עובדה `CHARGED`: הסכום והמטבע של הלקוח, `source=PROVIDER`.
2. **משיכה יומית** (עתידי, אחרי אישור): קריאה ל־`FinancialTransactions`, עם `FromCreateDate` ו־`ToCreateDate` בחלון של כמה ימים, כדי לא לפספס שורות מאוחרות.
   - כל שורה מותאמת לעסקה בדוביז לפי המזהה ש־CardCom יאשר (שאלה 4.1).
   - עבור כל שורה נרשמות שלוש עובדות, כולן עם `source=PROVIDER` ו־`sourceRef` (מזהה השורה ב־CardCom):
     - `SETTLED`: הסכום ומטבע ההפקדה, עם השער שהוחל.
     - `FEE`: סך העמלות במטבע ההפקדה. הרכב השדות נקבע לפי התשובה לשאלה 4.2.
     - `NET`: הסכום שהופקד בפועל.
3. **בדיקת עקביות:** `NET = SETTLED − FEE`, רק כשכל השלושה באותו מטבע.
   - אי־התאמה **לא נחסמת ולא נמחקת**. העובדות נשמרות כ־"לבדיקה" (החלטת הבעלים, PR #769).
   - שום חישוב לא מערב שני מטבעות.
4. **הפקדה:** `BankDeposites` משמש להתאמה מול שורת הבנק (`ExternalTransaction`, הקיים כבר בדוביז). זו התאמה בלבד ולא מקור לסכום.
5. **מה לא עושים:**
   - לא מחליפים נתון של CardCom בהמרה לפי שער בנק ישראל.
   - לא מציגים הערכה כסכום שהתקבל.
   - לא מפיקים מסמך מס. ההחזקה מ־PR #766 נשארת עד לאישור רואה החשבון.

**תנאים להפעלה:**
- תשובות CardCom לסעיפים 1, 3 ו־4.
- החלת migration ‏20261026090000.
- PR קוד נפרד: משיכה ידנית תחילה, ורק אחר כך cron, באישור.
- אישור הבעלים.
