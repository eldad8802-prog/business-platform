# Admin Control Center A1 — Production release

Make the platform-admin console show **true numbers** in Production, through a SELECT-only, column-scoped
read identity, and ship the A1 console (home, businesses, audit log, security) with the passkey step-up
switched **off**. Nothing here changes any business's data, any tenant policy, or the auth plane's existing grants.

**Acceptance:** `prod-admin-read-evidence.yml` PASS as `app_admin_prod`, and the owner sees real counts on
`/admin` (and on `/admin/businesses/38`, the QA tenant) after signing in with MFA.

## What Production has today (proven, read-only, 2026-10-22)

| Fact | Source | Consequence |
| --- | --- | --- |
| `ADMIN_DATABASE_URL` is **not** set in Vercel Production | `vercel env ls production` (names only) | `/api/platform-admin/overview` and `/audit` throw in `getPrismaAdmin()` → 500 |
| `app_admin` exists, NOLOGIN, no LOGIN member, no privilege on the console tables | preflight run 37138112739 | there is no identity the console could use |
| The runtime is `app_runtime_prod`, NOSUPERUSER, NOBYPASSRLS; no-context reads return 0 rows | runtime-RLS proof run 36791331075 (noContext 5/5) | the list / detail / attention services, which read through the runtime with no tenant context, return **0** on every FORCE-RLS table (documents, invoices, conversations, content runs, Gmail, WhatsApp imports, onboarding profile) — with no error |

## Artifacts

| Artifact | Kind | Effect |
| --- | --- | --- |
| `prisma/migrations/20261024090000_platform_admin_a1` | migration (release-migrate, AUTHORITY class) | `app_admin`: column-scoped SELECT on 10 tables (no password, session secret, token, document content, money or contact column), whole SELECT on `ProductUsageEvent` / `PlatformAuditEvent`, **no write anywhere**; additive `p7adm_read` on `BusinessProfile`. New `PlatformAdminPasskey` (auth plane: `app_auth` read / add / change 5 columns; no DELETE; runtime and admin plane: nothing). |
| `ops/evidence/platform-admin-a1-preflight.sql` / `-production-evidence.sql` | evidence | 10 + 2 INFO / 20 + 1 INFO checks; the proof pins the migration's sha256 |
| `scripts/ops/admin-read-login.ts` + `prod-admin-read-login.yml` | ops, OWNER GATE | `provision`: create-once / rotate `app_admin_prod` (LOGIN, INHERIT, NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE, NOREPLICATION, CONNECTION LIMIT 10), member of `app_admin` only; one transaction with post-assertions. `disable`: containment. |
| `scripts/ops/admin-read-evidence.ts` + `prod-admin-read-evidence.yml` | evidence | as `app_admin_prod`, read-only: identity, cross-tenant counts equal the owner's, secret columns refused, every admin service runs. Booleans only. |
| `.apa1/` + `platform-admin-a1-lab.yml` | CI lab | PG17, Production topology: preflight / proof / 17 injected faults / role battery (55 checks) / atomicity |

## Sequence (each owner gate is explicit)

Migration-first: the migration ships alone (#754); the application code (#753) merges only after it is applied.

0. **Merge #754** (migration-only). Nothing in Production changes: no code reads the new shape.
1. **Preflight** — run `prod-readonly-evidence.yml` with `ops/evidence/platform-admin-a1-preflight.sql` (from
   `main`). Expect checks 1–10 PASS (check 1 needs `20261022090000_task_reminders_push` applied first).
2. **GATE M — migration.** Approval record `ops/release-approvals/20261024090000_platform_admin_a1.json` in its
   own PR (sha256, decision link, `preflightRun`); then `release-migrate` with
   `expected_migrations=20261024090000_platform_admin_a1` (plus only what the owner approved alongside it).
   Then run the proof `ops/evidence/platform-admin-a1-production-evidence.sql`: 20/20 PASS (21 is INFO).
2b. **Merge #753** (application, rebased on main). Vercel deploys it. Until step 5 the console **says** its data
   plane is not connected (503 `ADMIN_DATA_PLANE_UNAVAILABLE`) on the home, business list and business card
   instead of showing zeros. Business feature access, MFA and everything outside `/admin` are unaffected.
   Passkeys stay off.
3. **Owner — secret.** One password: 48 characters of `[A-Za-z0-9_-]`
   (`openssl rand -base64 36 | tr '+/' '-_' | tr -d '='`). DIRECT URL (not `-pooler`):
   `postgresql://app_admin_prod:<password>@<direct host of ep-flat-brook-am4bhq1y>/neondb?sslmode=require&connection_limit=3`.
   Store it as the **environment** secret `ADMIN_DATABASE_URL` in `production-db`. Never paste it anywhere else.
4. **GATE L — login.** Run `prod-admin-read-login.yml` → `provision`. Then `prod-admin-read-evidence.yml`: must PASS.
5. **GATE V — Vercel.** Production only, Sensitive: `ADMIN_DATABASE_URL` = the same URL. Redeploy.
6. **Owner glance.** Sign in, MFA, open `/admin`: real counts; `/admin/businesses` search and filters; a business
   card shows its documents / invoices / conversations; `/admin/audit` loads (it 500s today).
7. **Later, separate decision — passkeys.** `PLATFORM_ADMIN_PASSKEY_ENABLED=true` (needs `AUTH_PLANE_ENABLED=true`
   and `APP_BASE_URL=https://<production host>`). Then add a passkey on `/admin/security` from each device.

No intermediate state is permissive: code without the URL → 503; URL without the login → 500 (no fallback to any
other identity); everything → admin + MFA required, reads only, column-scoped.

## Containment and rollback

| Situation | Action | Latency |
| --- | --- | --- |
| Any doubt about the read plane | `prod-admin-read-login.yml` → `disable` (NOLOGIN + revoke membership + terminate sessions) | immediate, no deploy; the console answers 500/503, never another identity |
| Stop the console's cross-tenant reads entirely | remove `ADMIN_DATABASE_URL` in Vercel + redeploy | next deployment |
| Passkeys misbehave | remove `PLATFORM_ADMIN_PASSKEY_ENABLED` (+ redeploy); TOTP keeps working; rows stay (revoke via `/admin/security`) | next deployment |
| Undo the migration's grants | not needed for containment (the group has no LOGIN member after `disable`); a reverse migration would `REVOKE SELECT (…) ON … FROM app_admin`, `DROP POLICY p7adm_read ON "BusinessProfile"` | release-migrate |

Never drop `app_admin_prod` (the Neon pooler caches role OIDs). Rotation = re-run `provision` with a new URL in
both places.

## Factor changes (hardened in review)

| Rule | Where |
| --- | --- |
| Adding / removing a passkey, replacing the authenticator, and enrolling an authenticator while a passkey exists need a step-up from the **last 5 minutes** (a still-valid 15-minute elevation is not enough). The answer is the existing `403 ADMIN_MFA_REQUIRED`, so the console simply asks for a fresh code. | `freshStepUpRefusal` in `lib/auth/platform-admin.ts`; `lib/auth/admin-factor-change.test.ts` |
| The authenticator is **replaced atomically** (`/mfa/replace/begin` → `/mfa/replace/confirm`): the new seed travels encrypted in a 10-minute envelope bound to the seed it replaces; the old app and old recovery codes keep working until a code from the new app is proven, then one conditional update swaps them. There is no reset route and never a moment without a factor. | `lib/auth/admin-mfa-replacement.ts`, `admin-mfa.service.ts` |
| Passkey assertions are accepted only for a challenge issued **after** the last accepted one (`lastChallengeIssuedAt`, compare-and-set), so neither the last nor an older still-live assertion can be replayed (synced passkeys keep `signCount` 0). | `finishPasskeyAuthentication` |
| `app_admin` column grants are exactly the columns the services read (unused `User.role/termsAcceptedAt/signupAttribution`, `BusinessProfile.category/subCategory/city/onboardingGoal`, `BillingDocument.documentType/issuedAt`, `AuthSession.createdAt/idleExpiresAt/revokedAt` removed). | migration, preflight 5, proof 5, battery |

## Known, not changed here

- **Elevation is still stateless (15 min, HMAC) and not bound to a session.** Revoking a session does not end an
  elevation minted on it until it expires; rotating `AUTH_TOKEN_SECRET` ends all. A server-side, revocable
  elevation needs a table (a migration) and touches the ratified CASA guard and the tax-authority OAuth branch —
  deferred to A2 with the "disconnect all admin devices" action rather than half-done here. The 5-minute rule above
  limits what a stolen elevation can turn into.
- **No notification on factor changes yet.** They are audited (PlatformAuditEvent); the security Push to the owner
  belongs to A3 (OpsEvent + Web Push).

- `scripts/ops/control-plane-login.ts` restates `NOSUPERUSER NOBYPASSRLS NOREPLICATION` on its **rotation** path;
  PostgreSQL 16+ refuses that from a non-superuser (42501, reproduced in the A1 lab). Its first provisioning
  (CREATE) worked; a rotation would fail closed. `admin-read-login.ts` avoids it.
- `/dev/learning-center` reads tables outside the A1 grant set; it stays Preview-only.
- The attention item "content runs failed" can never fire (`ContentRun` is only written COMPLETED).
- `app_runtime` still holds its reviewed SELECT+INSERT on `PlatformAuditEvent` — the audit append stays there by design.
