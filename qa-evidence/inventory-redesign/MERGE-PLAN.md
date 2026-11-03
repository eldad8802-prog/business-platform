# שרשרת ה־PRs של המלאי: מפה, תקינות ההפרשים ותוכנית מיזוג מדורגת

נכון ל־4 בנובמבר 2026, main = `ac6b580b`. לא בוצע שום מיזוג. זו תוכנית, למימוש רק אחרי אישורך.

## מפה (HEAD מלא)
| סדר | PR | ענף | בסיס כרגע | HEAD | הפרש |
|---|---|---|---|---|---|
| 1 | #939 | `fix/i18n-proof-chunk-hash-name` | `main` | `cd371a6e560a9cb1288152b49489d09ae1736512` | 5 קבצים, ‎+163 ‎−12 |
| 2 | #926 | `fix/inventory-product-actions` | `main` | `b0dab8d1fd6e7f86bef1630a15fb591d8e57d2a4` | 18 קבצים, ‎+406 ‎−49 |
| 3 | #927 | `fix/inventory-receive-remainder` | `main` | `70d6ddbd4b1a9815bb52682545f4185dc0fca4d8` | 8 קבצים, ‎+273 ‎−22 |
| 4 | #929 | `feat/inventory-redesign-kit` | `integ/inventory-fix-pack` (`64882442` = main ישן + #926 + #927) | `014e960063659df4063b1f7eaebcd8b745de8742` | 8 קבצים, ‎+1395 ‎−233 |
| 5 | #930 | `feat/inventory-redesign-products` | `feat/inventory-redesign-kit` | `50be92c5876538f426d0f4b7b599615df60aaa63` | 15 קבצים, ‎+1630 ‎−1655 |
| 6 | #931 | `feat/inventory-redesign-orders` | `feat/inventory-redesign-kit` | `1eb8d5d4481617d355f2ece692681304e7f16191` | 20 קבצים, ‎+2059 ‎−2374 |
| 7 | #932 | `feat/inventory-redesign-ops` | `feat/inventory-redesign-kit` | `506dbfd95359ee5997d8b6609b8ef0391cc3a721` | 10 קבצים, ‎+1629 ‎−1453 |

**תלויות:**
- #939 עצמאי. הוא מקדים את #927, כי המיזוג של #927 אחרי #926 הוא שהפיל את בדיקת שם הקובץ.
- #927 עצמאי מ־#926. יש להם 4 קבצים משותפים, והמיזוג ביניהם נקי.
- #929 תלוי ב־#926 וב־#927.
- #930, #931 ו־#932 תלויים ב־#929, ולא זה בזה. יש להם קבצים משותפים קטנים, והם נבדקו בסדר 930 ← 931 ← 932.

**PRs לבדיקה בלבד, לא למיזוג:**
- #933: כל השרשרת, על main ישן.
- #935 עד #938 ו־#940: מצבי מיזוג 1 עד 5 על main `ac6b580b`.

## תקינות ההפרשים
- **#939:** רק בדיקת ה־i18n: ה־workflow, הבדיקה, מודול הכללים, הטסט, ורישום הטסט בכיסוי.
- **#929:** הערכה, הסקירה, `overview-sources`, `unit-words`, `stock-line`, `stock-tone`, וייצוא חוזר ב־`inventory-design`.
- **#930, #931, #932:** כל אחד רק בתחום שלו, ועוד תוספות כלליות קטנות לערכה. הפירוט נמצא בתיאורי ה־PRs.
- **שורת ה־baseline ב־#932:** הוסבר בתיאור ה־PR. הרשומה התיישנה כש־#926 החליף את הסכום ב־`chargedSaleTotal`.

**סימולציה של squash על main `ac6b580b`:**
- 0 התנגשויות בכל שבעת הצעדים.
- מספר הקבצים בכל squash זהה להפרש של ה־PR.
- תוכן המלאי במצב 5 זהה לעץ של #933.

## תוכנית מדורגת: אותה שגרה בכל שלב
**א. עדכון הענף על main** (רק אם צריך):

```bash
git fetch origin
git rebase --onto origin/main <הבסיס הישן> <הענף>
git push --force-with-lease origin <הענף>
gh pr edit <N> --base main
```

**ב. בדיקת ה־HEAD החדש:** מוודאים שההפרש של ה־PR מכיל רק את הקבצים שלו, באותו מספר קבצים:

```bash
git diff --stat origin/main...<הענף>
```

כדי לוודא שהתוכן זהה למה שנבדק, משווים לענף המצב:

```bash
git diff <ענף המצב המתאים> <הענף> -- <קבצי ה־PR>
```

התוצאה צריכה להיות ריקה.

**ג. CI:** ממתינים לכל הבדיקות על ה־HEAD החדש. `release/verify` חובה. כל כשל מאובחן לפני מיזוג. ראו את סעיף כשל הזיכרון בהמשך.

**ד. squash merge**, אחרי אישורך לאותו PR.

**ה. רישום:** HEAD מלא של ה־commit שמוזג ב־main, ושל ה־HEAD הבא בתור.

| שלב | PR | פקודת עדכון (א) | המצב הצפוי (ב) | CI מקדים במצב המיזוג |
|---|---|---|---|---|
| 1 | #939 | אין צורך (בסיס main) | — | #939 עצמו |
| 2 | #926 | `git rebase origin/main fix/inventory-product-actions`. ה־CI הקיים שלו רץ על main ישן (`6db37e5b`) | main + #939 + #926 | חלק ממצב 1 (#935) |
| 3 | #927 | `git rebase origin/main fix/inventory-receive-remainder` | `ci/inventory-state-1` | #935 |
| 4 | #929 | `git rebase --onto origin/main origin/integ/inventory-fix-pack feat/inventory-redesign-kit` | `ci/inventory-state-2` | #936 |
| 5 | #930 | `git rebase --onto origin/main 014e9600 feat/inventory-redesign-products` | `ci/inventory-state-3` | #937, והבדיקה המקומית 704/704 |
| 6 | #931 | `git rebase --onto origin/main 014e9600 feat/inventory-redesign-orders` | `ci/inventory-state-4` | #938 |
| 7 | #932 | `git rebase --onto origin/main 014e9600 feat/inventory-redesign-ops` | `ci/inventory-state-5` | #940 |

ב־`i18n en chunk` של PRs המצבים 2 עד 5, כשל על `/inventory` הוא צפוי. הבדיקה משווה תמיד ל־main הנוכחי, ו־main עדיין לא כולל את #929. אחרי ש־#929 ימוזג, הבדיקה של #930 תרוץ מול main שכולל אותו. ההרצה המקומית במצב הזה עברה 704/704 (ראו `I18N-PROOF.md`).

**בסיום:** לסגור בלי מיזוג את #933, את #935 עד #938 ואת #940. למחוק את `integ/inventory-fix-pack` ואת `ci/inventory-state-*`.

## אם כשל הזיכרון ב־build חוזר
ההופעה הקודמת הייתה ב־#938, בריצה 41706586132, בשלב TypeScript של `next build`, על Node 20 שבו הערימה מוגבלת לכ־2 GB. הריצה החוזרת עברה, והקוד זהה לזה שעבר במצבים 3 ו־5.

**אבחון לפני הרצה חוזרת:**
1. **איפה נפל:** לוודא בלוג שהכשל הוא `heap out of memory` בשלב `Running TypeScript`, ולא שגיאת קוד.
2. **שחזור באותה מגבלה:** לבנות את אותו HEAD מקומית עם `NODE_OPTIONS=--max-old-space-size=2048 npm run build`. אם הבנייה נכשלת באופן עקבי, זה הקוד. אם היא נכשלת רק לפעמים, זה גבול.
3. **השוואה ל־main:** להריץ את אותה בנייה על main באותה מגבלה ולהשוות את שיא הזיכרון, כדי לראות אם השרשרת מקרבת את הבנייה לגבול.
4. **מסקנה:** אם הקוד אחראי, לתקן בקוד. אם זה הגבול של ה־runner, שינוי ה־workflow (למשל הגדלת `max-old-space-size`) הוא שינוי תשתית ודורש אישור נפרד. בינתיים לא לבצע ריצה חוזרת עיוורת.
