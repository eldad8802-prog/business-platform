# Control plane — Production cutover

Make the audited platform-admin feature-access write path
(`PATCH /api/platform-admin/businesses/{id}/features/{featureKey}`) genuinely operational in Production,
through the least-privilege `app_ctlplane` identity, without changing any real business's enrollment.

**Acceptance:** `CONTROL PLANE PRODUCTION READY = YES`, shown by a bounded mechanism proof on the QA
sandbox tenant (business 38). Enrolling businesses 3 and 9 (and running #584) is a separate, later decision.

## What Production had (preflight, run 36791336257, read-only)

| Fact | Consequence |
| --- | --- |
| PW-2 migration `20260901090000` applied: `app_ctlplane` NOLOGIN group, RLS + FORCE on `BusinessFeatureAccess`, tenant SELECT policy, control-plane INSERT/UPDATE policies pinned to the transaction GUC | Row-level boundaries already exist. |
| `app_ctlplane` holds **no** table privileges; no LOGIN member | The mutation path cannot work. |
| `CONTROL_PLANE_DATABASE_URL`, `FEATURE_ACCESS_MUTATIONS_ENABLED` absent in Vercel | The route answers 503 before auth. |
| `app_admin` exists, NOLOGIN, no LOGIN member, **no** privileges on the five tables | The Preview artifact's `REVOKE SELECT … FROM app_admin` is a no-op here; not repeated, asserted instead. The admin features screen reads through the tenant substrate (`runTenantJob` + `withTenantTransaction`), and `ADMIN_DATABASE_URL` is Preview-only. |
| `app_runtime` (→ `app_runtime_prod`) holds SELECT/INSERT/UPDATE/DELETE on `BusinessFeatureAccess`, `PlatformFeaturePolicy`, `PlatformFeatureDefinition`, `PlatformAuditEvent` — from the owner's default ACL, not a reviewed grant | `PlatformFeaturePolicy` has **no RLS**: the tenant runtime could set `globalEnabled`/`emergencyDisabled` for any feature and bypass the control plane. No code writes either table at runtime. |
| `PlatformAuditEvent`: no RLS, no triggers | Control-plane INSERT-only append is sufficient. |
| Zero overrides, zero feature-access audit events; QA tenant 38 active, 1 user, 0 overrides | Clean baseline; 38 is a harmless proof target. |

## Artifacts

| Artifact | Kind | Effect |
| --- | --- | --- |
| `prisma/migrations/20261003090000_control_plane_production_privileges` | migration (release-migrate) | `app_ctlplane`: SELECT+INSERT and column-scoped UPDATE (`state`, `reason`, `updatedByUserId`, `updatedAt`) on `BusinessFeatureAccess`; INSERT on `PlatformAuditEvent`; SELECT (`id`,`name`) on `Business`; SELECT on `PlatformFeaturePolicy`; USAGE on the two sequences. `app_runtime`: keeps SELECT only on the three feature tables, SELECT+INSERT on the audit (loses UPDATE/DELETE), loses the override sequence. |
| `scripts/ops/control-plane-login.ts` + `prod-control-plane-login.yml` | ops, OWNER GATE | `provision`: create-once/rotate `app_ctlplane_prod` (LOGIN, INHERIT, NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE, NOREPLICATION, CONNECTION LIMIT 5), member of `app_ctlplane` only; password taken from `CONTROL_PLANE_DATABASE_URL`, stored as a SCRAM-SHA-256 verifier computed on the runner (RFC 7677 vectors verified); one transaction with post-assertions. `disable`: containment. |
| `scripts/ops/control-plane-evidence.ts` + `prod-control-plane-evidence.yml` | evidence | `verify` (rolled-back identity/boundary proof) and `proof` (after the UI mutation). |
| `scripts/ci/privwrite-guard.sh` | CI | Rules 1–4, 9, 10 now also bind the new migration. |

## Sequence (each owner gate is explicit)

0. **Merge** this PR (no Production effect).
1. **GATE M — migration.** Apply `20261003090000` via release-migrate. It must be the only pending
   migration, or be applied together only with migrations the owner has separately approved.
2. **Owner — secret.** Generate one password: 48 characters of `[A-Za-z0-9_-]` (e.g.
   `openssl rand -base64 36 | tr '+/' '-_' | tr -d '='`). Build the DIRECT URL (not the `-pooler` host):
   `postgresql://app_ctlplane_prod:<password>@<direct host of ep-flat-brook-am4bhq1y>/neondb?sslmode=require`.
   Store it as GitHub **environment** secret `CONTROL_PLANE_DATABASE_URL` in `production-db`. Never paste it anywhere else.
3. **GATE L — login.** Run `prod-control-plane-login.yml` with `provision`.
4. **Verify (no flag yet).** Run `prod-control-plane-evidence.yml` with `verify`. Must PASS before step 5.
5. **GATE V — Vercel.** In Vercel project `business-platform`, Production only, Sensitive:
   `CONTROL_PLANE_DATABASE_URL` = the same URL; `FEATURE_ACCESS_MUTATIONS_ENABLED` = `true`. Redeploy
   (environment variables apply only to a new deployment). No intermediate state is permissive:
   URL without flag → 503 before auth; flag without URL → 500, no write; both → admin + MFA required.
6. **Mechanism proof (owner, UI).** As user 9 with MFA, on `/admin/businesses/38/features`:
   `knowledge_derivation` → **DISABLED** (reason ≥ 10 chars), then → **INHERIT**. Effective access stays
   OFF throughout (default OFF, global OFF), so nothing changes for the QA tenant.
7. Run `prod-control-plane-evidence.yml` with `proof`. Must PASS.
8. Regression: the admin features page for 3/9 still renders; `prod-derive-preenrollment-proof.yml`
   still answers sentinel 400 / CRON 401 / 3 and 9 → 403 `not_enrolled`.

## Containment and rollback

| Situation | Action | Latency |
| --- | --- | --- |
| Any doubt about the control plane | `prod-control-plane-login.yml` → `disable` (NOLOGIN + revoke membership + terminate sessions) | Immediate, no deploy. The route then fails closed (500, no write). |
| Stop the admin route entirely | Remove `FEATURE_ACCESS_MUTATIONS_ENABLED` in Vercel + redeploy | Next deployment (rate limits apply). |
| Undo the proof rows | None needed: the QA row ends at `INHERIT` (= no override). Rows are never deleted by design. | — |
| Runtime regression from the revocations | `GRANT INSERT, UPDATE, DELETE ON "<table>" TO app_runtime;` for the specific table, as owner, only after owner approval — it re-opens the bypass it closes, so it is a last resort. | Immediate. |

Never drop `app_ctlplane_prod` (the Neon pooler caches role OIDs). Rotation = re-run `provision` with a new
URL in both places.
