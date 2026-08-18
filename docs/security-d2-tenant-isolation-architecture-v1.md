# D2 — Business / Tenant Isolation Architecture (v1)

> **Document type:** Canonical **architecture source of truth** for Business/Tenant Isolation (gap **D2 / Business Isolation**).
> **Contains only decisions that were proven or ratified** — not untested ideas. Anything not yet verified is marked explicitly as **Open** or **Unverified**.
> **Base:** origin/main · **Author basis:** Architecture Spike A + Spike B (empirical; see §12).
>
> ### Governance status (binding)
> - **D2 Security Goal — `LOCKED`.**
> - **D2 Runtime Architecture — `VALIDATED / READY FOR MIGRATION DESIGN`** (proven feasible in Spike B; not yet built).
> - **D2 Production Implementation — Phase 1 (runtime role provisioning) `COMPLETED / VERIFIED`** in production (2026-08-17, `ep-flat-brook`; role `app_runtime` provisioned + **inert** — the runtime still connects as `neondb_owner`). **Phase 2+** (adapter migration, runtime role switch, tenant-context plumbing, RLS enforcement) — **`NOT STARTED`.** **D2 overall — `OPEN`; Phase 1 provides no isolation.**
>
> This document does **not** claim "D2 Implemented", "RLS Ready for Production", or that the runtime uses `app_runtime`. Phase 1 provisioned an **inert** prerequisite role only; the staged Migration Plan implements the remaining phases, each separately approved.

---

## 1. Security Goal

**Invariant (LOCKED):**

> A user or request acting for **Business A** can **never read or modify** data belonging to **Business B** — **even if a route/service/query omits or mis-applies the tenant filter.**

**The distinction that defines this gap:**

| Layer | What it is | Guarantee |
|------|------------|-----------|
| **Application-level filtering** (`where: { businessId }`, an auto-injecting query extension, etc.) | code that adds the tenant predicate | **Defense-in-depth only.** A forgotten filter, an IDOR, or a raw query silently defeats it. |
| **Database RLS** (this document) | Postgres Row-Level Security enforced by the engine on every statement | **Structural backstop.** The database itself refuses cross-tenant rows regardless of application bugs. |

**Decision:** the **target** for D2 is the **DB RLS structural backstop**. Application-level filtering may remain as a complementary defense-in-depth layer but is **not** a substitute and does **not** close D2.

---

## 2. Threat Model

The threats RLS is required to neutralise (each must remain contained even when the application is buggy):

| # | Threat | Without RLS | With RLS (non-bypass role) |
|---|--------|-------------|-----------------------------|
| T1 | **Forgotten `businessId` filter** in a new/edited route or service | cross-tenant read/write | rows outside the tenant are invisible/rejected at the DB |
| T2 | **IDOR** — object fetched by `id` alone | returns another tenant's object | policy denies the row |
| T3 | **Raw SQL** (`$queryRaw`/`$executeRaw`) that bypasses app filtering | full bypass | **RLS still applies** (DB-level) — a key advantage (see §9) |
| T4 | **Background jobs** with no request context | ambiguous / global reads | **fail-closed** (zero rows) unless context is set explicitly (see §8) |
| T5 | **Admin / system operations** | broad access | must use an explicit, audited system path — **never** a silent bypass (§8, Open Decision) |
| T6 | **Context leakage between concurrent requests** (shared connection) | tenant A sees tenant B mid-flight | transaction-local context; **proven no-leak** under concurrency (§12) |
| T7 | **Missing context** | undefined | **fail-closed** (deny / zero rows) (§5, §6) |
| T8 | **Connection pooling / reused connections** | stale session context | context is **transaction-scoped**, never session-scoped (§6, §7) |
| T9 | **Bypass / owner role** | RLS silently ineffective | runtime uses a **non-`BYPASSRLS`, non-owner** role (§4) |
| T10 | **Migration-time behavior** | migrations blocked or mis-scoped by RLS | migrations run as the **owner/admin role**, deliberately (§4, §9) |

---

## 3. Runtime Architecture (request path)

Exact boundaries of the tenant-isolation chain:

```
Client request
  │  (client NEVER supplies businessId for isolation — §6)
  ▼
Route handler (nodejs runtime)
  │  auth: getCurrentUser(req) → resolves the authenticated user + user.businessId
  ▼
Tenant Context established
  │  businessId derived SERVER-SIDE from the session/user — the only source of truth
  ▼
AsyncLocalStorage (ALS)  ── per-request store holding { businessId }
  │  (nodejs only; Edge runtime is out of scope for tenant-scoped data access)
  ▼
Data access via Prisma + @prisma/adapter-neon (Neon serverless driver)
  │
  ▼
Interactive transaction  ($transaction)
  │  step 1: SET LOCAL tenant GUC  (set_config('app.current_business_id', <als.businessId>, true))
  │  step 2: the actual query/queries
  ▼
PostgreSQL RLS policy evaluates current_setting('app.current_business_id') per row
  ▼
Result: only the tenant's rows (read) / only tenant-owned writes accepted
```

**Boundary definitions:**
- **Context START:** immediately after auth resolves `user.businessId`, an ALS scope is entered for the request.
- **Context APPLIED:** inside each data-access transaction, as the transaction-local GUC (`SET LOCAL`), read from ALS.
- **Context END:** at transaction COMMIT/ROLLBACK the GUC is discarded (transaction-scoped); at request end the ALS scope exits. **No state survives onto the next request or the next pooled connection.**

---

## 4. Database Roles (explicit two-role separation)

> **⚠️ Spike finding (binding):** the current app connects as **`neondb_owner`**, which has **`rolbypassrls = true`**. **A `BYPASSRLS` role silently ignores every RLS policy — even with `FORCE ROW LEVEL SECURITY`.** Using it as the runtime role produces a **false sense of security**: policies exist but enforce nothing. This is the single most important reason the current stack is unsafe for RLS.

**Two distinct roles are mandatory:**

**A. Migration / Admin role**
- Owner privileges over the schema; runs migrations and DDL (RLS policies, tables, `FORCE ROW LEVEL SECURITY`).
- Uses the **direct (unpooled)** connection (`DIRECT_URL`).
- **Never** serves runtime application traffic.

**B. Runtime Application role**
- **`rolbypassrls = false`** (mandatory — proven necessary in §12).
- **Non-owner** (owner bypasses RLS unless FORCE; a non-owner + FORCE is unambiguous).
- **Minimal grants:** `USAGE` on the schema; `SELECT/INSERT/UPDATE/DELETE` only on the tenant tables it needs; sequence `USAGE, SELECT`.
- **Default privileges** configured so future tables are granted to it automatically (avoids a "new table silently ungranted → app breaks" footgun).
- **No** schema-management / DDL privileges.
- Runtime **must connect exclusively as this role** — never as the owner "because it's convenient".

---

## 5. RLS Policy Model

For each tenant-scoped table:

```sql
ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <t> FORCE  ROW LEVEL SECURITY;   -- subject the owner too (defence in depth vs role mistakes)

CREATE POLICY tenant_isolation ON <t>
  USING      (business_id = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK (business_id = NULLIF(current_setting('app.current_business_id', true), '')::int);
```

- **`USING`** governs which existing rows are *visible* (SELECT/UPDATE/DELETE targeting).
- **`WITH CHECK`** governs which rows may be *written* (INSERT/UPDATE result) — blocks writing a row owned by another tenant.
- **`FORCE ROW LEVEL SECURITY`** ensures even the table owner is subject to the policy (belt-and-suspenders against a role mistake).
- **Missing / invalid context is fail-closed:** `current_setting(..., true)` returns NULL when unset → `NULLIF(...,'')` → NULL → `business_id = NULL` is false → **zero rows / write denied.** (Proven in §12.)
- Coverage must include **SELECT / INSERT / UPDATE / DELETE** (a `FOR ALL` policy with both `USING` and `WITH CHECK`, as above).

---

## 6. Tenant Context Contract

**Canonical GUC (chosen convention):** **`app.current_business_id`**.
- Postgres requires a custom run-time parameter to be namespaced (dotted). `app.` is the application namespace; `current_business_id` denotes the business id of the **current request's** authenticated tenant.
- *(Chosen because it is the exact convention proven in the spike — not merely convenient. Any rename must update policies + plumbing together and be re-proven.)*

**Contract (binding):**
- **Who sets it:** only the data-access plumbing (the Prisma-adapter transaction wrapper), reading `businessId` from ALS. No route/service sets it ad-hoc.
- **Where `businessId` comes from:** **server-side only**, from the authenticated `user.businessId`. 
- **The client NEVER supplies it** (not via header/body/query) for isolation purposes.
- **Lifetime = the transaction only** (`SET LOCAL` / `set_config(..., is_local => true)`). 
- **No leakage to the next connection/request:** because it is transaction-scoped, a pooled connection reused by another request carries **no** prior tenant context. (Proven no-leak under concurrency — §12.)

---

## 7. Transaction Model

> **Spike finding (binding):** `SET LOCAL` is **transaction-scoped**, so tenant context requires the query to run **inside a transaction**. Under load, the **standard Prisma engine over Neon's PgBouncer pooler was unstable** (interactive transactions failed with *"Unable to start a transaction in the given time"*), whereas **`@prisma/adapter-neon` + the Neon serverless driver (WebSocket) was stable** under the same conditions (§12).

**Decisions:**
- **A transaction is required** because the GUC must be set (`SET LOCAL`) and consumed by the query on the same backend, atomically.
- **`SET LOCAL` (transaction-local) is chosen** over session `SET` because pooled/reused connections must not carry tenant state between requests (§6, T8).
- **Interactive transactions** (`$transaction(async tx => { set_config(...); ...queries })`) are the execution unit; run on the **adapter-neon / serverless driver**.
- **What is forbidden:** running a tenant-scoped query **outside** a context-setting transaction; relying on session-level `SET`; connecting runtime as the owner/bypass role.
- **Nested service calls:** representative multi-query flows within one transaction share the context (proven — §12). The exact contract for **deeply nested `$transaction`** and cross-service composition is **Unverified** and belongs to the Migration Plan / Threat Model.
- **Connection / pool lifecycle:** the serverless-driver WebSocket pool needs **explicit lifecycle management** (the spike observed lingering sessions when not closed). Pool sizing/teardown under real serverless concurrency is **Unverified** (§12).

---

## 8. Background / `after()` / Cron  *(critical)*

RLS is **fail-closed**: a query with no tenant context returns zero rows. Therefore:

- A **tenant-scoped** background job **must receive `businessId` explicitly** and establish the same ALS + transaction context as a request.
- **No accidental inheritance** of a request's context — background work runs outside the request ALS scope by default.
- A job that runs **without** tenant context **fails closed** (zero rows) — this is the desired safety default, not a bug.
- **System-wide** operations (that legitimately span tenants) require an **explicit, audited system/admin mechanism** — **never a silent bypass** and **never the `BYPASSRLS`/owner role for convenience**.

> **Open Decision (not designed here):** the concrete system/admin cross-tenant mechanism (e.g. an explicit `withSystemContext()` path, a separate admin role with audited scope, or a per-operation `setTenantContext(targetBusinessId)`) is **NOT decided**. It is marked **Open** and belongs to the Migration Plan. Notably, existing document OCR runs in `after()` — this path must be explicitly handled during rollout.

---

## 9. Raw SQL

RLS protects **raw SQL too** when the connected role is non-bypass — this is a primary advantage over app-level `where`-injection (which raw queries silently escape).

| Access | Role used | RLS applies? |
|--------|-----------|--------------|
| `prisma.$queryRaw` / `$executeRaw` (runtime) | **Runtime application role** (non-bypass) | ✅ yes — still tenant-scoped (proven §12) |
| Migrations / DDL | **Migration/Admin role** (owner) | intentionally bypassed (owner runs schema changes) |
| Admin tools / diagnostics | **explicit system/admin path** (§8 Open Decision) | per the audited system mechanism, not a silent bypass |

**Rule:** any raw query on the runtime path uses the runtime role and is therefore subject to RLS; nothing on the runtime path may use the owner/bypass role.

---

## 10. Rollout Strategy (staged — not Big Bang)

Ordered phases (the **first table is NOT chosen here** — that belongs to the Migration Plan / Threat Model):

1. **Runtime infrastructure** — provision the runtime application role (non-bypass, minimal grants, default privileges); switch the runtime data layer to `@prisma/adapter-neon` + serverless driver.
2. **Context propagation** — ALS per request + the transaction wrapper that sets `app.current_business_id`.
3. **Validation with NO policies on production tables** — verify context propagation, transaction stability, and fail-closed behavior on **non-production** / shadow tables before any production table has RLS.
4. **Pilot table** — enable RLS + FORCE + policy on a single, well-understood tenant table.
5. **Read verification** — prove cross-tenant reads are blocked for the pilot table.
6. **Write verification** — prove cross-tenant writes are blocked.
7. **`FORCE ROW LEVEL SECURITY`** confirmed active for the pilot.
8. **Table-by-table expansion** — each table gated, verified, reversible.
9. **Post-rollout monitoring** — fail-closed error rates, transaction failures, latency.

---

## 11. Failure Modes + Rollback

| Failure mode | Detection | Expected behavior | Rollback boundary |
|---|---|---|---|
| **Missing context** | zero-row / permission-denied errors on legit reads | **fail-closed** (safe default) | fix the caller to establish context; no schema rollback |
| **Wrong context** | data anomalies / audit | policy scopes to the wrong tenant → visible as "empty"/mismatch | fix context source; investigate as an incident |
| **Adapter failure** | connection errors from serverless driver | requests error out (no silent cross-tenant) | revert runtime to prior driver (per-deploy) |
| **Transaction failure** | tx-start errors / P2028 | request fails; **no partial cross-tenant leak** | driver/pool tuning; revert if systemic |
| **Connection exhaustion** | pool timeouts under load | throttling/errors | pool sizing; revert driver if needed |
| **Background job without context** | zero rows | **fail-closed** (safe) | job must pass `businessId`; do not add a bypass |
| **Runtime accidentally uses owner role** | 🔴 RLS silently ineffective | **cross-tenant exposure** — the worst case | detect via a startup assertion (`rolbypassrls=false` check); block deploy |
| **Migration accidentally uses runtime role** | migration permission errors | migration fails (non-owner lacks DDL) | run migrations as owner only |

**Mandatory guardrail:** the runtime must **assert at startup** that its connection role has `rolbypassrls = false` (and is not the owner) — a bypass/owner runtime role must **fail the boot**, not silently disable isolation.

---

## 12. Evidence Appendix (Spike A / Spike B)

**Proven (empirical, non-production dev DB, fixture table, two tenants):**
- `neondb_owner` has **`rolbypassrls = true`** → RLS **bypassed even with `FORCE`** (read returned all tenants; missing-context returned all rows). *False sense of security confirmed.*
- Under a **dedicated non-`BYPASSRLS` role**: **read isolation, write isolation, missing-context fail-closed, no context-leak under concurrency, nested multi-query context** — **all passed.**
- **Standard Prisma engine + pooled Neon (PgBouncer):** interactive transactions **unstable** under spike load — **22/24 concurrency and 22/24 burst failed** ("Unable to start a transaction in the given time").
- **`@prisma/adapter-neon` + Neon serverless driver (WebSocket), same non-bypass role, same degraded conditions:** **24/24 passed, 0 failures** — RLS invariants + transaction stability.

**Explicitly UNVERIFIED (must NOT be treated as proven):**
- Healthy-branch **latency** (spike ran against a **degraded** dev branch; absolute latency numbers are not representative — only the *relative* stability A-vs-B is evidence).
- Real **production concurrency** and pool sizing.
- **Deep nested `$transaction`** / full cross-service composition.
- Full **background / `after()` / cron** flows under RLS in the real app.
- Serverless-driver **connection/pool lifecycle cleanup** (lingering sessions were observed).
- The **admin / system cross-tenant path** (Open Decision, §8).

---

## Cross-references
- Gap register: `docs/security-gap-matrix.md` (Business Isolation / D2). *Note: the D2 rows there reference impact-review / decision-package docs that are **not present** in the repo; this document supersedes those references as the canonical D2 architecture.*
- Strategic plan: `docs/security-master-plan-v1.md`.
- Binding principles: `docs/security-constitution-v1.md`; program: `docs/security-engineering-program-v1.md`.

*End of document — architecture source of truth. No production code, roles, migrations, or dependency changes are introduced by this document.*
