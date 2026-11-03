# שרשרת ה־PRs של המלאי: מפה, תקינות ההפרשים ותוכנית מיזוג

לא בוצע שום מיזוג. זו תוכנית, למימוש רק אחרי אישורך.

## מפה
| PR | ענף | בסיס | HEAD | תלוי ב |
|---|---|---|---|---|
| #926 | `fix/inventory-product-actions` | `main` | `b0dab8d1fd6e7f86bef1630a15fb591d8e57d2a4` | — |
| #927 | `fix/inventory-receive-remainder` | `main` | `70d6ddbd4b1a9815bb52682545f4185dc0fca4d8` | — (נפרד מ־#926; יש להם 4 קבצים משותפים, והמיזוג ביניהם נקי) |
| #929 | `feat/inventory-redesign-kit` | `integ/inventory-fix-pack` (= main `6db37e5b` + #926 + #927, `64882442`) | `014e960063659df4063b1f7eaebcd8b745de8742` | #926, #927 |
| #930 | `feat/inventory-redesign-products` | `feat/inventory-redesign-kit` | `50be92c5876538f426d0f4b7b599615df60aaa63` | #929 |
| #931 | `feat/inventory-redesign-orders` | `feat/inventory-redesign-kit` | `1eb8d5d4481617d355f2ece692681304e7f16191` | #929 |
| #932 | `feat/inventory-redesign-ops` | `feat/inventory-redesign-kit` | `506dbfd95359ee5997d8b6609b8ef0391cc3a721` | #929 |

**PRs לבדיקה בלבד, לא למיזוג:** ‏#933 (כל השרשרת, merge), ו־#935 עד #938 (מצבי מיזוג 1 עד 4, ראו בהמשך).

## תקינות ההפרשים
- **#929 (8 קבצים):** ערכת העיצוב, מסך הסקירה, `overview-sources`, `unit-words`, `stock-line`, `stock-tone`, וייצוא חוזר של `getStockTone` מתוך `inventory-design.tsx`. אין בו קוד של #926 או #927.
- **#930 (15 קבצים):** רק מסכי המוצרים, ובנוסף:
  - 35 שורות CSS כלליות בערכה.
  - שדה אופציונלי ב־`lib/api/inventory.ts`.
  - נתיב העריכה ב־`route-registry`.
  - מפתח התרגום `toProductDetails` בעברית ובאנגלית.
  - עדכון guard של #926 למבנה החדש. ההתנהגות הנבדקת זהה, ו־37/37 עוברות.
- **#931 (20 קבצים):** רק ההזמנות, ובנוסף:
  - 15 שורות CSS ו־prop בשם `up` ב־`InvMenu`.
  - שני שדות אופציונליים ב־DTO.
  - נתיב פרטי הזמנת הרכש ב־`route-registry`.
  - מילות יחידה בשירות ה־PDF והשיתוף.
- **#932 (10 קבצים):** רק ספירה, מכירה, טיוטות, שיוך ודורש טיפול, ובנוסף:
  - 9 שורות בערכה.
  - `pos-match.ts`.
  - מחיקת רשומה אחת מ־`cross-currency-sum-guard.baseline.json`.
- **הרשומה שנמחקה ב־#932:** השורה שהיא מתעדת ב־`sales/create` הוסרה ב־#926, ש־החליף אותה ב־`chargedSaleTotal`. לכן הרשומה "מיושנת" (STALE) מרגע ש־#926 ממוזג. ה־guard במצב report-only, ולכן #926 ירוק למרות זאת. אפשרות לבחירתך: להעביר את המחיקה ל־#926. לא שיניתי את #926.
- **קבצים משותפים ל־#930 עד #932:** `kit.css.ts`, `kit.tsx`, `lib/api/inventory.ts` ו־`route-registry.ts`. בסימולציה הם התמזגו בלי התנגשות.

## סימולציה של מיזוג squash, מקומית ובלי מיזוג אמיתי
התחלתי מ־main הנוכחי (`49969bbe`): squash של #926, אחר כך #927, ואז #929, #930, #931 ו־#932. כל PR שוכתב (rebase) על תוצאת הצעד הקודם.
- **התנגשויות:** 0 בכל צעד.
- **התוצאה הסופית:** זהה בדיוק לעץ ש־CI בדק ב־#933 (`refs/pull/933/merge`).
- **הענף של כל מצב** נדחף כ־PR בדיקה נפרד, כדי שה־CI ירוץ על מצב המיזוג של כל PR:

| מצב | תוכן | PR | CI |
|---|---|---|---|
| 1 | main + #926 + #927 | #935 | ראו את הדוח |
| 2 | + #929 | #936 | ראו את הדוח |
| 3 | + #930 | #937 | ראו את הדוח |
| 4 | + #931 | #938 | ראו את הדוח |
| 5 | + #932 | = #933 | 42 עברו |

אזהרה לגבי בדיקת `i18n en chunk` ב־PRs של המצבים: היא תמיד משווה ל־`origin/main`. לכן במצבים 2 ו־3 היא נכשלת על `/inventory`, כי main הנוכחי עדיין לא כולל את #929. במצב המיזוג האמיתי #930 עובר 704/704 בהרצה מקומית. ראו `I18N-PROOF.md`.

## סדר מיזוג מוצע (squash), אחרי אישורך
1. **#926:** squash ל־main.
2. **#927:** לבצע rebase על main, להמתין ל־CI ירוק במצב הזה, ואז squash. צפוי כשל לא חוסם ב־`i18n en chunk`, בבדיקת שם ה־chunk (ראו `I18N-PROOF.md`). זו החלטה שלך.
3. **#929:** להעביר את הבסיס ל־main ולשכתב רק את הקומיטים שלו:
   ```
   git fetch origin
   git rebase --onto origin/main origin/integ/inventory-fix-pack feat/inventory-redesign-kit
   git push --force-with-lease origin feat/inventory-redesign-kit
   gh pr edit 929 --base main
   ```
   להמתין ל־CI של #929 עצמו, ואז squash.
4. **#930, ואחריו #931 ואחריו #932, אחד בכל פעם.** בכל PR לשכתב על main החדש (`014e9600` הוא קצה הערכה הישן):
   ```
   git fetch origin
   git rebase --onto origin/main 014e9600 feat/inventory-redesign-products
   git push --force-with-lease origin feat/inventory-redesign-products
   gh pr edit 930 --base main
   ```
   להמתין ל־CI של ה־PR במצב הזה, ואז squash. לחזור על התהליך עבור `orders` (#931) ו־`ops` (#932). הסדר הזה נבדק בסימולציה. סדר אחר לא נבדק, אבל הקבצים המשותפים קטנים.
5. **בסיום:** לסגור את #933 ואת #935 עד #938 בלי מיזוג, ולמחוק את `integ/inventory-fix-pack` ואת `ci/inventory-state-*`.

**לפני כל מיזוג:** `release/verify` חובה, וכל הבדיקות של ה־PR עצמו במצב שבו הוא ממוזג. CI של #933 לא מחליף אותן.
