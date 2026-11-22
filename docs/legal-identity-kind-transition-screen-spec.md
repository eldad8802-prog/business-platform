# "מעבר לעוסק מורשה": screen spec + sketch (FOR OWNER DECISION, not implemented)

The owner asked for a spec and a sketch only (11-20): **stop before implementing the design**. No page, component or
style is built. The API it would call exists behind `BUSINESS_KIND_TRANSITION_ENABLED` (OFF → 404).

The screen is Hebrew, RTL and mobile-first (360 px first; desktop is the same column, max-width ~560 px). It uses the
existing business-details look. No new visual language.

## Entry point

- On the business details screen (`/business`), only when GET `.../kind-transition` answers `eligibility.eligible`:
  - a secondary row-action "מעבר לעוסק מורשה" beside the business kind ("עוסק פטור").
- Not eligible but exempt: the action is visible and disabled, with the block message:
  - several users;
  - a live issuer declaration (until 4a);
  - incomplete identity.
- Already transitioned: no action. A history line instead: "עבר לעוסק מורשה ב־<confirmedAt> · מעמד מ־<statusEffectiveDate>".
- Route: `/business/legal-identity/kind-transition` (back-nav registered, like the other business pages).

## Step 1: הסבר

```
┌──────────────────────────────────────┐
│ →  מעבר לעוסק מורשה          שלב 1/3 │
├──────────────────────────────────────┤
│ המעבר נעשה באותו תיק עסק.            │
│                                      │
│ ✓ השם המשפטי ומספר הזהות לא משתנים    │
│ ✓ מסמכים שכבר הונפקו לא משתנים        │
│ ✓ מסמכים חדשים — כעוסק מורשה, עם מע״מ │
│ ✓ חשבוניות מס ממוספרות מסדרה חדשה     │
│                                      │
│ ⓘ דוביז לא משנה את הרישום ברשות       │
│   המסים. יש לבצע את המעבר רק אחרי     │
│   שנרשמת שם כעוסק מורשה.              │
│                                      │
│ שם או מספר שגוי? זה לא מעבר — צריך     │
│ לפתוח תיק עסק חדש.  [מה זה אומר?]     │
│                                      │
│ ┌──────────────────────────────────┐ │
│ │            המשך                  │ │
│ └──────────────────────────────────┘ │
└──────────────────────────────────────┘
```

Content: `KIND_TRANSITION_EFFECTS` (server) plus the Path B explanation. "מה זה אומר?" opens a sheet with the
new-business-file explanation (B3: today this means a separate signup with another email; see the open questions).

## Step 2: פרטים ואישורים

```
┌──────────────────────────────────────┐
│ →  מעבר לעוסק מורשה          שלב 2/3 │
├──────────────────────────────────────┤
│ השם המשפטי          ישראל ישראלי  🔒  │
│ מספר זהות           123456782     🔒  │
│                                      │
│ הקלד/י שוב את מספר הזהות *           │
│ [ _ _ _ _ _ _ _ _ _ ]                │
│ מספר עוסק מורשה *                    │
│ [ _ _ _ _ _ _ _ _ _ ]                │
│ לעוסק יחיד — זהה למספר הזהות          │
│ המעמד נכנס לתוקף ברשות המסים בתאריך * │
│ [ 01/11/2026  📅 ]   (עד היום)        │
│                                      │
│ ☐ אני רשום/ה כעוסק מורשה ברשות המסים… │
│ ☐ מדובר באותו אדם, שם ומספר…          │
│ ☐ מסמכים שכבר הונפקו נשארים כפי שהם…   │
│ ☐ מרגע האישור — מסמכים כעוסק מורשה…    │
│ ☐ המעבר לא ניתן לביטול עצמי בדוביז     │
│                                      │
│ ┌──────────────────────────────────┐ │
│ │            המשך                  │ │  ← disabled until all valid
│ └──────────────────────────────────┘ │
└──────────────────────────────────────┘
```

- Numbers: `inputmode="numeric"`, LTR inside the RTL page, 9 digits.
- Errors come from POST `.../preview` (`problems[]`), one per field, below the field. They never echo the value.
- A date later than today shows inline "אפשר לחזור לכאן בתאריך התחילה". The date picker's max is today (Israel time).
- If the date is earlier than today, an inline notice: "מסמכים שהונפקו מאז כעוסק פטור לא ישתנו. את הטיפול בהם כדאי
  לתאם עם רואה החשבון." The gap count is a 4a item.
- "המשך" calls preview → `statementSha256` is kept for step 3.

## Step 3: סיכום, אימות ואישור

```
┌──────────────────────────────────────┐
│ →  מעבר לעוסק מורשה          שלב 3/3 │
├──────────────────────────────────────┤
│ סיכום                                │
│ עוסק פטור  ←  עוסק מורשה              │
│ מספר עוסק מורשה      123456782        │
│ תחילת המעמד ברשות המסים  01/11/2026   │
│ מועד העדכון בדוביז       עם האישור    │
│                                      │
│ אימות זהות                           │
│ [ סיסמה ••••••••     ] [אימות]       │   ← password account
│   — או —                             │
│ [ אימות מחדש עם Google ]              │   ← Google-only account
│ ✓ אומת (תקף ל־5 דקות)                 │
│                                      │
│ ┌──────────────────────────────────┐ │
│ │       אישור ומעבר לעוסק מורשה     │ │  ← enabled only after ✓
│ └──────────────────────────────────┘ │
│              ביטול                    │
└──────────────────────────────────────┘
```

- **Password:** POST `.../reauth/password` → httpOnly proof cookie (the page never sees it) → ✓.
- **Google:** POST `.../reauth/google` → `{url}` → full redirect to Google (prompt=login) → back to this page with
  `?reauth=ok|cancelled|stale|other_account|error`.
  - The typed input is kept in `sessionStorage` (no secrets; the numbers are the owner's own) so step 3 is restored.
- **Confirm:** POST `.../kind-transition` with input + `statementSha256`.
- **Result screens:**
  - TRANSITIONED → success card + "חזרה לפרטי העסק" + a notice about open drafts (4a item 4).
  - REAUTH_REQUIRED → back to "אימות זהות".
  - STATEMENT_STALE → "פרטי העסק השתנו — יש להתחיל מחדש" → step 1.
  - Any other refusal → its Hebrew message + "לא נשמר שום שינוי".

## States to design (owner)

- Loading, offline / 5xx: "לא נשמר שום שינוי".
- 401 session expired.
- Google return states: cancelled / stale / other_account / error.
- Rate limited; password locked (with the retry time).
- The disabled entry-point reasons.
- The success screen.

## Open product questions for this screen

1. **Placement:** a row-action on `/business`, or also from the billing area (4a's declared-status screen)?
2. **Typed id number in step 2:** required (current API) or a tick-box? It is the same-entity proof; recommended:
   keep it.
3. **Path B help sheet text:** today = "open a new account with another email" (B3). Approve the wording.
