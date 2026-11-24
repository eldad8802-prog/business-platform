# "מעבר לעוסק מורשה": real Google account + physical Android phone, on an isolated Preview

Prepared 2026-11-22; **updated 2026-11-25** for main ed3e8300, which adds the T1 wiring and T4. This is a plan only. **No OAuth setting, Production secret, Production data or Production env var is
touched.** Everything runs on a Vercel Preview of one branch, against an isolated Neon branch with synthetic accounts.

The emulated runs prove that the server never trusts the browser. Lab on main (CI e2e, 2026-11-24/25):
- app battery 54/54 unwired and 65/65 wired;
- browsers 34/34;
- flag OFF 4/4. A real Google account, a real phone and a real Preview deployment are still unverified, and are only
reported as passed after the checklist below is run on them.

## 1. Owner actions — one list

| # | Where | Exactly what | Why |
|---|---|---|---|
| O1 | Google Cloud Console → APIs & Services → Credentials | Create a **new OAuth 2.0 Client ID** (Web application) named "Dubiz preview test". Authorized redirect URI (the branch alias Vercel assigned to this branch; it stays the same across deploys of the branch): `https://business-platform-git-feat-lega-ed338e-eldads-projects-77d41b04.vercel.app/api/auth/google/callback`. Do not edit the Production client. Give the session the client ID and secret through Vercel (O3), never in chat | Real Google re-auth on the Preview. The Preview has no `GOOGLE_LOGIN_*` today |
| O2 | This machine, PowerShell | `neonctl auth` (opens the browser once). Then the session creates a branch from the Preview database, e.g. `kind-transition-device-test`, and runs `prisma migrate deploy` with **every migration on main** (including `20261221090000`, 4a's `20261223090000` / `20261223100000`, and `20261225090000`). Data on the branch is synthetic | Isolated database with the same functions as Production. `neonctl` hangs here until authenticated |
| O3 | Vercel → Project → Settings → Environment Variables, **Preview, branch `feat/legal-identity-kind-transition-ui` only** | Set:<br>• `DATABASE_URL`, `DIRECT_URL`, `AUTH_DATABASE_URL` (the Neon branch; the session supplies the values);<br>• `AUTH_PLANE_ENABLED=true`;<br>• `AUTH_GOOGLE_LOGIN_ENABLED=true`, `AUTH_GOOGLE_LOGIN_MODE=pilot`, `AUTH_GOOGLE_LOGIN_PILOT_EMAILS=<your test Gmail>,<second Gmail>`;<br>• `GOOGLE_LOGIN_CLIENT_ID`, `GOOGLE_LOGIN_CLIENT_SECRET` (from O1);<br>• `GOOGLE_LOGIN_REDIRECT_BASE_URL=https://business-platform-git-feat-lega-ed338e-eldads-projects-77d41b04.vercel.app`;<br>• `BUSINESS_KIND_TRANSITION_ENABLED=true` | Turns the feature on **for this one Preview branch only**. Production untouched |
| O4 | Vercel → Settings → Deployment Protection | A **Protection Bypass for Automation** secret, or sign in to Vercel in the phone's browser | The phone must open the Preview |
| O5 | Your phone | An Android phone with Chrome, and two Google accounts you control: **A** (will be linked) and **B** (will not be linked) | Real device, real Google |
| O6 | After the test | Approve the clean-up: delete the branch env vars (O3), the Neon branch (O2), the test OAuth client (O1). Optionally also the old leftovers on `feat/legal-identity-correction-admin` | Nothing left behind |

The session does the rest:
- creates the Neon branch after O2;
- supplies the values for O3;
- redeploys the Preview;
- creates the multi-user test business with SQL on the isolated branch only;
- drives the desktop checks and reads the database after each step.

## 2. Test accounts (isolated branch only)

| Account | How it is created | Used for |
|---|---|---|
| P: password, exempt | Signup on the Preview (email + password, kind עוסק פטור) | password re-auth, the happy path |
| G: Google-only, exempt | Signup with Google account **A**, kind עוסק פטור | Google re-auth |
| B: second Google account | Not linked to anything | "another account" refusal |
| M: two users, exempt | The session inserts a second user into P2's business (SQL on the isolated branch) | "several users" refusal |
| D: exempt with issued receipts | The session issues 2 receipts on D (existing flow), one of them after the date the owner will pick | history and old documents unchanged; the T4 count and list |
| I: exempt with an issuer declaration | Signup on the Preview + the declaration flow (email link) | the wired transition (declaration v2 written in the same transaction) |

## 3. Checklist (run on the physical Android phone; the session confirms each result in the database)

| # | Check | Pass when |
|---|---|---|
| R1 | D: `/business` → the action row in the legal card → step 1, a date earlier than today; then change the date | "מאז [תאריך] הופקו [N] מסמכים כעוסק פטור…" with the right N; N updates by itself when the date changes; "להצגת N המסמכים" opens the list; continue enabled |
| R2 | P: step 2 wrong id number | "המספר לא תואם…" + "מה עושים?" opens the sheet; back closes it |
| R3 | P: wrong password ×1, then the right one | the error, then step 3 |
| R4 | P: step 3 tick 4 of 5 → button disabled; tick 5 → confirm. Optional: while P is on step 3, the session issues one receipt for P from the desktop, then P confirms | success screen; DB: kind AUTHORIZED, VAT number = id number, one history row (PASSWORD, both dates). With the optional receipt: first "בזמן האישור השתנה מספר המסמכים…" and nothing written, then confirm again → success |
| R5 | P: back to `/business`; open the flow URL again | the history line, no action row; "העסק כבר עבר לעוסק מורשה" |
| R6 | G: step 2 "אימות עם Google" → Google asks for a fresh login with **A** → back | "אומת עם Google", the typed date and id restored; confirm → success; history says GOOGLE |
| R7 | G (new business G2): on Google press back / cancel | "האימות עם Google בוטל", nothing written |
| R8 | G2: choose account **B** | "חשבון ה-Google שבחרתם לא מחובר…", nothing written |
| R9 | G2: verify, wait more than 5 minutes, confirm | "עבר זמן רב מדי…" + "לאימות מחדש", nothing written |
| R10 | M: `/business` | the row disabled with the several-users reason; the flow page says not available |
| R11 | D: after D's transition, open the old receipts and their PDFs; the success screen and the list | byte-identical to before (the session compares the DB rows and the PDF hashes); the success screen shows the count from the history row |
| R11b | I: the transition with a live issuer declaration | success; DB: declaration v2 STATUS_CHANGE with the same digest, method and instant as the history row |
| R12 | Mid-process failure: turn airplane mode on just before "אישור ומעבר", then off and retry | the error says nothing changed; the retry succeeds once; one history row |
| R13 | Phone layout: RTL, numeric keyboard on the id field, native date picker, scroll with the fixed bottom button, back arrow in every step, text at 150 % (Android font size), 360 px | as in the approved design; nothing clipped, no side scroll |
| R14 | Flag OFF: the session removes `BUSINESS_KIND_TRANSITION_ENABLED` from the branch env and redeploys | no row on `/business`; the page says not available; the API answers 404 |

**Test environment (prepared 2026-11-25).** The branch `feat/legal-identity-kind-transition-ui` was recreated at main
ed3e8300, so the branch alias above stays the same. Until O3 is done it builds with the shared Preview settings, where
the flag is off.

The Dubiz Android **app** (Capacitor) points at Production, so testing inside the app needs a new app build. That is
not approved. This plan uses Chrome on the physical Android phone against the Preview, which is the same web code.
