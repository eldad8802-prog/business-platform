# Legal identity — two paths (owner decisions 2026-11-20)

Status: branch work only. **No merge, no Production migration, no flag, no billing (A0) file.** Each step below needs
its own owner approval.

## Rule

A business file's legal identity (kind, legal name, id number) is never changed after the fact. There is no correction
request and no approver.

- **Path A — "מעבר לעוסק מורשה":**
  - same legal entity, same id number, same legal name, same file;
  - `EXEMPT_DEALER → AUTHORIZED_DEALER`;
  - VAT number = id number (individual);
  - explicit owner confirmation after a server-side re-authentication (password, or Google for Google-only accounts);
  - one transaction, full audit;
  - issued documents never change;
  - authorized → exempt stays blocked.
- **Path B — new business file:**
  - any change of legal name or id number (even one character), and individual ↔ company;
  - the old file and its documents stay as they are;
  - interim (B3, owner-accepted for planning): a separate signup;
  - multi-business per user is NOT approved for development.

## Delivered (branches / Drafts)

| PR | Branch | Content |
|---|---|---|
| (new) | `db/business-kind-transition` | Migration `20261221090000_business_kind_transition` only, plus the lab, preflight, evidence, rollback and CI workflow |
| #1204 | `feat/legal-identity-two-paths-core` | Pure core, Prisma model, erasure registration, re-auth proof (password + Google), routes behind `BUSINESS_KIND_TRANSITION_ENABLED` (OFF → 404), tests, docs (this file, screen spec, 4a package) |

### Migration (`20261221090000`)

- **`BusinessKindTransition`:**
  - append-only (UPDATE refused to everyone, DELETE only to the owner);
  - one row per business (unique);
  - FORCE RLS with per-command tenant policies;
  - runtime may SELECT only;
  - `ON DELETE RESTRICT` (Business and User are never hard-deleted by the purge).
- **Two dates:** `statusEffectiveDate` (declared; between 2000-01-01 and the confirmation day, Israel time) and
  `confirmedAt` (now).
- **`business_kind_transition_to_authorized(user, vat, date, reauth_method, reauth_at, statement_sha)`** is SECURITY
  DEFINER and granted to `app_runtime` only. It returns a status and writes nothing unless:
  - the user is in the session's business, the business is alive, and the user is its **sole** user;
  - the re-auth is PASSWORD or GOOGLE and at most 10 minutes old;
  - the kind is EXEMPT_DEALER and the identity is complete;
  - the VAT number is valid and equals the id number;
  - the date is valid;
  - **no live issuer declaration** exists (4a item 1);
  - the statement digest, recomputed in SQL, equals what the owner confirmed.
- **What it writes:** the history row, then kind + VAT number on the profile. The name, id number and confirmation
  state are untouched. The signup lock (DZL04) still refuses any later kind / name / id change.
- **Statuses:**
  - TRANSITIONED
  - NOT_ALLOWED
  - NOT_SOLE_USER
  - REAUTH_REQUIRED
  - IDENTITY_INCOMPLETE
  - NOT_EXEMPT_DEALER
  - VAT_NUMBER_INVALID
  - VAT_NUMBER_DIFFERS_FROM_TAX_ID
  - EFFECTIVE_DATE_INVALID
  - ISSUER_DECLARATION_ACTIVE
  - STATEMENT_STALE
- **Static guarantees (CI step 0):** it names no Billing / Payment / FinancialEvent table, never writes the issuer
  declaration, and the evidence files are SELECT-only.

### Re-authentication (no schema change)

- **The proof:** a stateless HMAC envelope (the platform-admin elevation pattern, with its own key label). It is bound
  to **user + session + action + method** and is valid for 5 minutes. It lives only as an httpOnly cookie on
  `/api/business/legal-identity/kind-transition` and is cleared on success.
- **Password:** login's per-IP limit and per-account ledger and lock, with a timing equaliser.
- **Google:** `prompt=login&max_age=0`.
  - The ID token is verified in full and Google's `auth_time` must be ≤ 5 minutes old.
  - The Google account must resolve to the **same** signed-in user.
  - It shares the registered callback. The branch is taken only when its own signed cookie's state matches, so the
    ordinary sign-in is unchanged (tests C5 and C6).
- A token without a session id cannot re-authenticate.
- The method follows the account: a password → PASSWORD, none → GOOGLE.

### Tests

- **Lab (local PG18, Production role topology, real `migrate deploy`):**
  - proof 11/11;
  - preflight fails exactly 2, 3 and 4 after the apply (+7, a lab-ledger artefact);
  - battery K1–K11: 52/52;
  - rollback reverts whole;
  - atomicity (fails on its last statement → nothing left).
- **Pure / handler suites** (security-gate manifest `legal-identity-two-paths.json`):
  - identity-change-policy;
  - kind-transition;
  - sensitive-reauth (proof, Google state, callback branch, shared-callback routing);
  - kind-transition-handlers (OFF → 404, session-bound, proof checks, no DB call on refusal).
- The SQL statement digest equals the app's on a fixed vector (evidence check 11, lab K2, unit S2).

## Old frozen work: verdict and what is reusable

Development stopped (owner 11-20). Nothing is closed or deleted without separate approval.

| Item | Verdict | Reusable |
|---|---|---|
| #1148 correction migration (request table, four-eyes) | Not needed | `scripts/ci/tenant-table-rls-guard.mjs` R2 change (recognises column-level GRANTs): a general guard improvement, could be proposed on its own. `.sli/correction-battery.ts` structure (already mirrored in `.bkt/battery.ts`) |
| #1152 correction request screens | Not needed | `lib/legal-identity/signed-in-as.ts` + `components/legal-identity/signed-in-as.tsx` (client guard against an account switch in another tab), for the transition page. The back-nav registration pattern. Not reused: attachment storage / erasure (no attachments); its password check (superseded by `lib/auth/sensitive-reauth.ts`, which adds the login ledger / lock and the Google path) |
| #1154 approver console | Not needed (no approver) | `docs/legal-identity-activation-runbook.md` structure, for the new activation runbook. CI red at freeze (M6 battery, i18n en chunk, verify) not investigated, per owner |
| #1179 preflight / evidence for #1148 | Not needed | The pattern only, re-done for 20261221090000 |
| `feat/legal-identity-completion-prompt` (no PR) | Not needed now (32 test / pilot businesses) | — |

## Owner decisions still open

1. Status start date earlier than the Dubiz update: the gap-notice proposal (4a package §2). Inform only, no blocking.
2. Uniform export for historical periods (4a §3).
3. Open 0%-VAT drafts after the transition: notice only, or block issuing until reviewed (4a §4).
4. New wording for the messages that point to a correction request or to support (4a §5), and retiring
   `LEGAL_IDENTITY_CORRECTION_ENABLED`.
5. Businesses with several users: today refused (NOT_SOLE_USER). Who may transition later?
6. The screen: design approval (screen spec). Placement; is the typed id number kept?
7. Path B (B3) help text: "open a new account with another email".

## Merge and activation order (each step = separate owner approval)

1. Merge the migration PR, then the read-only Production preflight (`business-kind-transition-preflight.sql`) → all
   PASS.
2. Approval record → `release-migrate` of 20261221090000 → evidence 11/11. Announce to the other sessions first, and
   keep only one release in flight.
3. 4a ships its items 1–6 (STATUS_CHANGE writer, gap notice, uniform export, drafts, messages, numbering lab).
4. Merge #1204 with the flag OFF; verify 404 in Production.
5. Screen implementation after design approval; real-phone test on a test business in an isolated Preview.
6. The owner sets `BUSINESS_KIND_TRANSITION_ENABLED=true`.
