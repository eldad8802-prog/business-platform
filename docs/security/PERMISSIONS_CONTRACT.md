# Dubiz permissions contract (binding)

**Status: BINDING** for every change that reads or writes business data, adds a table, a migration, a database
function, a role, a route, a job or a webhook. `AGENTS.md` points here. When this contract and a feature document
disagree, this contract wins until the owner changes it.

Related records (this contract does not repeat them):

- `docs/security/TENANT_RLS_INVENTORY.md` — every tenant table, how it is isolated, and every RLS exception.
- `docs/security/PENDING_TENANT_TABLES_ARCHITECTURE.md` — tables whose isolation is still an open decision.
- `docs/security/SECURITY_FOLLOWUP_REGISTER.md` — known security debt, its owner and its closing plan.
- `docs/security/RELEASE_MIGRATE_AUTHORITY_GATE.md` and `docs/RELEASE-OWNERSHIP.md` — how migrations reach Production.
- `scripts/security-lab/README.md` — the shared security lab and the privilege-model baseline.

## 1. Business isolation

1. **Every access to business data runs in a verified business context.** The database enforces it: tenant
   tables are `ENABLE` + `FORCE ROW LEVEL SECURITY`, and their policies read
   `current_setting('app.current_business_id')`, which only the tenant helpers set (transaction-local,
   `set_config(…, true)`).
2. **`tenantTx(businessId, tx => …)` (`lib/tenant/tenant-tx.ts`) is the default** for request handlers and services.
   Asynchronous and provider-driven work (webhooks, `after()`, retries, sweeps) uses
   `runTenantJob({ businessId }, …)` (`lib/tenant/job.ts`). Code already under `runWithTenantContext` uses
   `withTenantTransaction`. Never read or write a tenant table through the bare runtime client: under the
   Production role a context-less read silently returns **zero rows or `null`**, and a nested `include` of a tenant
   relation silently drops it (the #898 bugs). Writes fail; reads do not, so tests must assert data, not status.
3. **The `businessId` is server-derived** — from the session (`getCurrentUser`/`getAuthContext`), a verified provider
   mapping row, a signed token resolved by a SECURITY DEFINER lookup, or a stored parent row. Never from a request
   body, a query string, a header, or a route id on its own. An admin route that lets a platform admin choose a
   business is the only exception, and it goes through §2.4.
4. **No context leaks.** The context is transaction-local and lives in AsyncLocalStorage; nothing may cache a
   transaction client, a context or a `businessId` across requests, and a job must never inherit a context it was
   not explicitly given (`runTenantJob` throws on a silent switch).
5. **Cross-business access** exists only through a named, reviewed mechanism with a fixed input and output contract:
   a SECURITY DEFINER lookup (§4), the admin read role (§2.4), or the control plane. Each one is listed in
   `TENANT_RLS_INVENTORY.md`.

## 2. Database roles and privileges

### 2.1 The roles (Production names; Preview and the lab mirror them)

| Role | Kind | Used by | May |
|---|---|---|---|
| `neondb_owner` | LOGIN, owner, CREATEROLE + BYPASSRLS | `release-migrate` only | own every object, run migrations |
| `app_runtime` | NOLOGIN group | the application (`lib/prisma.ts`) via a LOGIN member | tenant data under RLS |
| `app_auth` | NOLOGIN group | sign-in, sessions, tokens (`authDb()`, `lib/prisma-auth.ts`) | identity tables + `auth_*` functions |
| `app_admin` | NOLOGIN group | the platform admin console (`lib/prisma-admin.ts`) | named read policies, audited writes |
| `app_ctlplane` | NOLOGIN group | feature access control (`lib/prisma-control-plane.ts`) | feature policy / overrides |
| `task_maintenance` | NOLOGIN group | retention jobs | EXECUTE on the retention functions only |

Each environment connects through LOGIN roles that are **members** of a group (`INHERIT`), e.g. `app_runtime_prod`,
`app_runtime_preview`. Privileges are granted to the **group**, never to a LOGIN role.

### 2.2 Rules

1. **Least privilege.** A role holds only the privileges its code paths use. A privilege nobody uses is debt.
2. **No BYPASSRLS** for any application role. Only the migration owner has it.
3. **`neondb_owner` is never a runtime credential** — not for the app, not for Preview, not for a test.
4. **No grant to an environment LOGIN role** when the group can carry it (the lab counts these: section `L`).
5. **No blanket DELETE.** Production's owner default privileges give `app_runtime` `SELECT, INSERT, UPDATE, DELETE`
   on every new table; that is a fallback, not a decision. **Every migration that creates a table states the
   table's privileges explicitly** (GRANT what is needed, REVOKE what is not) — at least: append-only tables
   (audit, events, ledgers, issued documents) have no UPDATE/DELETE for the runtime; a table the runtime never
   deletes from has no DELETE.
6. **Secrets and credentials tables** (MFA secrets, API keys, provider tokens, OAuth material) are readable only by
   the role whose code path needs them, never by the general runtime, and are never selected into logs or evidence.

### 2.3 Separation

- runtime ≠ auth: the runtime has no access to `AuthSession`, `AuthSessionSecret` or the `auth_*` functions; the
  auth role touches only identity tables. Google sign-in requires the auth plane (`AUTH_PLANE_ENABLED=true`).
- admin and control plane are separate roles with separate clients; neither is used by ordinary routes.
- migrations run only as the owner, only through `release-migrate`.

### 2.4 Admin

Platform-admin routes require admin + MFA (`PLATFORM_ADMIN_MFA_REQUIRED=true` in Production), use the admin or
control-plane client, read only through named `app_admin` policies, and write a `PlatformAuditEvent` in the same
transaction as every mutation.

## 3. Row-level security

1. **Every table with a tenant key** (`businessId` or `…BusinessId`, directly or through a required parent) is
   `ENABLE` + `FORCE ROW LEVEL SECURITY` with policies **per operation the runtime needs** (`FOR SELECT`, `FOR INSERT
   … WITH CHECK`, …). `FOR ALL` is acceptable only when every operation is needed.
2. **No policy lets one business reach another's rows.** `USING (true)` is allowed only for a role that is not the
   runtime and only when listed in `TENANT_RLS_INVENTORY.md` with its reason.
3. **Every exception** (a tenant table without RLS, a permissive policy, a definer lookup across businesses) is listed
   in `TENANT_RLS_INVENTORY.md` with its reason and a test. CI (`tenant-table-rls-guard`) refuses unlisted ones.
4. **Never enable RLS on an existing table** before every consumer is mapped and moved into a tenant context (or a
   definer lookup), and the change is proven in the security lab as the runtime role. Enabling RLS silently empties
   every context-less read.

## 4. SECURITY DEFINER functions

1. `SET search_path = pg_catalog, public, pg_temp` (`pg_temp` **last**, so a session's temporary table can never
   shadow a public table) — or schema-qualify every object in the body.
2. Owned by the migration owner; `REVOKE EXECUTE … FROM PUBLIC`; `GRANT EXECUTE` only to the group that calls it.
3. Never a way around business isolation: it either takes the business from `app.current_business_id`, or it is a
   narrow lookup whose input is a secret/hash/public id and whose output is the minimum the caller needs (typically
   a business id and a status) — never a row dump, never password/token hashes, never other businesses' data.
4. Its input/output contract is written in the migration next to it.

## 5. Migrations

1. **No silent skip.** A migration that grants to a role must fail if the role is missing
   (`IF NOT EXISTS (… pg_roles …) THEN RAISE EXCEPTION …`), not skip the grant. (45 older migrations skip; they are
   recorded debt, not a pattern to copy.)
2. **No privilege change without a test** in the security lab as the real role, and an updated
   `ops/security/privilege-model.baseline.txt` (CI fails otherwise).
3. **No migration reaches Production except through `release-migrate`** with its approval record and preflight
   (`docs/security/RELEASE_MIGRATE_AUTHORITY_GATE.md`). After it is applied, the Production privilege model is checked
   with `ops/evidence/privilege-model-production-assert.sql`.
4. Schema-sensitive changes ship as two PRs (database first, then code) — `docs/RELEASE-OWNERSHIP.md`.

## 6. Checklist for a new feature

- [ ] Every new table: tenant key → RLS + FORCE + per-operation policies; explicit GRANT/REVOKE for each role.
- [ ] Every data access in a tenant helper; `businessId` from the server only.
- [ ] Public / anonymous / provider entry points resolve the business through a verified mapping or a definer
      lookup (§4) and are listed in the inventory.
- [ ] A test as the real runtime role (security lab or a lab built the same way): own data visible, another business's
      data invisible, writes into another business refused.
- [ ] The privilege-model baseline is updated and the diff reviewed.
- [ ] No secrets in logs, evidence or test fixtures.

## 7. Exceptions

An exception to this contract needs a line in `TENANT_RLS_INVENTORY.md` (isolation) or
`SECURITY_FOLLOWUP_REGISTER.md` (debt) with reason, owner and closing plan, and the owner's explicit approval. An
exception list may not grow in the same PR that relies on it without that approval.
