# D2 — Tenant Isolation Migration Plan (v1)

> **Document type:** Executable **migration plan** — translates the validated D2 architecture into a safe, staged, reversible rollout.
> **This is planning, not execution.** No role, dependency, Prisma-runtime, env, migration, schema, or production-code change is performed by this document.
> **Depends on:** `docs/security-d2-tenant-isolation-architecture-v1.md` (the validated architecture — Goal LOCKED, Runtime Arch VALIDATED, Impl NOT STARTED).
> **Base:** origin/main.
>
> **Governance status (unchanged by this doc):** D2 Goal `LOCKED` · Runtime Architecture `VALIDATED` · **Production Implementation `NOT STARTED`.** This plan defines *how* implementation would proceed; approving the plan does not start it.

---

## 0. Preconditions (must all hold before Phase 1 executes)

| # | Precondition | Why | Verified how |
|---|---|---|---|
| PC1 | **Migration/Admin role** = the existing owner (`neondb_owner`), used for DDL/migrations via the **direct (unpooled)** URL only | migrations must run as owner; owner is never the runtime role | already true (current `DIRECT_URL`) |
| PC2 | **Dedicated runtime role** design ratified: `LOGIN`, **`rolbypassrls = false`**, non-owner, minimal grants + default privileges, no DDL | RLS is silently void under a bypass/owner role (Spike finding) | architecture §4 |
| PC3 | **Env separation**: distinct connection strings — migration (owner, direct) vs runtime (non-bypass role, pooled) — with no cross-use | runtime must never connect as owner "for convenience" | plan §Role-Migration |
| PC4 | **Adapter/runtime prerequisites** understood: `@prisma/adapter-neon` + `@neondatabase/serverless` + `ws`; `driverAdapters` preview feature; WebSocket lifecycle | interactive-transaction-per-query is unstable on the standard engine + PgBouncer; stable on adapter-neon (Spike B) | architecture §7, §12 |
| PC5 | **Healthy-DB validation budget**: a non-degraded environment to re-measure latency/stability (spike ran on a degraded branch — absolute numbers unverified) | avoid deciding on degraded-branch noise | architecture §12 (Unverified) |
| PC6 | **Startup guardrail** design: runtime asserts `rolbypassrls = false` (and non-owner) at boot; a bypass/owner role **fails the boot** | prevents a silent isolation-off deploy | architecture §11 |

---

## 1. Phase order — derived from dependencies (not the example order)

Dependency reasoning:
- RLS enforcement on the runtime requires the runtime to connect as a **non-bypass role** → role must exist + be granted **before** the runtime switches to it.
- Stable `SET LOCAL`-in-transaction requires the **adapter-neon driver** → the driver must be proven + live **before** the context plumbing runs transactions-per-query under load.
- The context plumbing + **background/after/cron** context must be live **before** any table gets RLS, or RLS's fail-closed behavior silently breaks those flows.
- Only then: **pilot table** RLS (read → write → FORCE) → **table-by-table expansion**.

```
P1 Runtime role provisioning (DB-side; runtime unchanged)
  └─> P2 Adapter preparation + parity/stability proof (non-prod)
        └─> P3 Driver switch (runtime → adapter-neon; still owner; NO RLS)
              └─> P4 Runtime role switch (owner → non-bypass role; adapter; NO RLS) + boot guardrail
                    └─> P5 Tenant-context plumbing (ALS + SET LOCAL in tx; NO RLS → inert)
                          └─> P6 Background/after/cron explicit context (before any FORCE RLS)
                                └─> P7 Pilot: ENABLE RLS + policy → read enforcement
                                      └─> P8 Pilot: write enforcement
                                            └─> P9 Pilot: FORCE ROW LEVEL SECURITY
                                                  └─> P10 Table-by-table expansion
```

**"Validation without RLS on production tables"** (the user's example phase) = **P5**: context propagation + transaction stability are proven on real production traffic while **no** table yet has any RLS policy (the plumbing is inert).

---

## 2. Phases — detail

For each phase: **Scope · Dependencies · Risk · DoD · Evidence · Production verification · Rollback boundary · Stop conditions.**

### P1 — Runtime role provisioning
- **Scope:** create the non-bypass runtime role in each env; grant `USAGE` on schema, `SELECT/INSERT/UPDATE/DELETE` on all current tenant tables, `USAGE,SELECT` on sequences; configure **default privileges** so future tables are auto-granted. Runtime **still connects as owner**.
- **Dependencies:** PC1–PC3.
- **Risk:** 🟢 Low — additive; runtime unchanged; zero behavior change.
- **DoD:** role exists; `rolbypassrls=false`; non-owner; grant-coverage over the full current tenant-table surface (+ default privileges verified).
- **Evidence:** a grant-coverage probe — the role can perform the app's read/write surface on every tenant table (run in a non-prod env first).
- **Production verification:** role + grants present; runtime unaffected (still owner) — no user-facing change.
- **Rollback boundary:** DB — `DROP OWNED BY <role>; DROP ROLE <role>` (reverse migration, **not** git revert).
- **Stop conditions:** any table lacks a needed grant → complete grants before proceeding.

### P2 — Adapter preparation + parity/stability proof (non-prod)
- **Scope:** install `@prisma/adapter-neon` + `@neondatabase/serverless` + `ws`; enable `driverAdapters` preview; build the adapter client path. Prove parity + stability on a **healthy** non-prod env. Runtime still on the standard engine (or behind a flag).
- **Dependencies:** PC4, PC5 for the driver's **role-independent** part (query parity + transaction stability + lifecycle) — this part may run **in parallel with P1**; **P1** is required only for the **RLS-invariant re-proof** under the adapter (which needs the non-bypass role). No circular dependency: P1 never depends on P2.
- **Risk:** 🟢 Low (non-prod) — dependency + client-generation change, not yet the runtime path.
- **DoD:** adapter client returns identical results to the standard client for the app's representative query surface; interactive-transaction burst/concurrency stable on a **healthy** branch (re-measure — Spike ran degraded); connection lifecycle clean (no leaked sessions).
- **Evidence:** parity test + the Spike-B battery on a healthy branch + pool-lifecycle check.
- **Production verification:** none (non-prod).
- **Rollback boundary:** revert deps + client generation (git/package).
- **Stop conditions:** parity mismatch, transaction instability on a healthy branch, or unmanageable connection lifecycle → do not proceed to P3; reassess driver strategy.

### P3 — Driver switch (runtime → adapter-neon; still owner; NO RLS)
- **Scope:** switch the runtime data layer to the adapter-neon client. Runtime **still connects as owner**; **no** RLS anywhere. Isolates "does the adapter work under real traffic" from role + RLS variables.
- **Dependencies:** P2.
- **Risk:** 🟡 Medium — real-traffic driver change (connection model, transaction handling).
- **DoD:** app fully functional on adapter-neon under real traffic; latency/error budgets within tolerance; no connection exhaustion.
- **Evidence:** Preview + production smoke; error-rate + latency monitoring vs baseline.
- **Production verification:** health endpoints 200; representative flows work; no elevated 5xx/timeouts.
- **Rollback boundary:** revert the runtime client to the standard engine (per-deploy git revert + redeploy); no DB change to undo.
- **Stop conditions:** elevated errors/latency/connection exhaustion → revert.

### P4 — Runtime role switch (owner → non-bypass role; adapter; NO RLS) + boot guardrail
- **Scope:** switch the runtime connection string to authenticate as the **non-bypass role** (via adapter). Add the **boot assertion** (`rolbypassrls=false` + non-owner, else fail boot). Still **no** RLS policies → behavior identical **iff** grants are complete.
- **Dependencies:** P1 (grants), P3 (driver).
- **Risk:** 🟡 Medium — this is the real-world grant-coverage test; a missing grant surfaces as a permission error.
- **DoD:** app fully functional as the non-bypass role; boot assertion passes; zero permission-denied in logs.
- **Evidence:** production smoke across representative flows; log scan for `permission denied`; boot-assertion log line.
- **Production verification:** health 200; representative read/write flows succeed; startup assertion confirms non-bypass role.
- **Rollback boundary:** switch the runtime connection string back to owner (env change — **instant, reversible**).
- **Stop conditions:** any permission-denied / missing-grant / boot-assertion fail → revert env to owner, complete grants, retry.

### P5 — Tenant-context plumbing (ALS + SET LOCAL in transaction; NO RLS → inert)
- **Scope:** per-request ALS holding server-derived `businessId`; a data-access wrapper/extension that runs queries inside an interactive transaction setting `set_config('app.current_business_id', <als>, true)`. **No** RLS policy exists → the GUC is set but **unused (inert)**. This is the "validation without RLS on production tables" phase.
- **Dependencies:** P3 (adapter — stable transactions), P4 (role).
- **Risk:** 🟡 Medium — changes execution to transaction-per-query for real traffic (even though inert).
- **DoD:** transaction-per-query stable under real traffic; ALS context correctly populated per request (server-derived only); **no functional regression**; latency within budget.
- **Evidence:** production smoke + latency/error monitoring; a diagnostic confirming the GUC is set per request (without enforcing).
- **Production verification:** representative flows unchanged; no elevated errors/latency; no connection exhaustion.
- **Rollback boundary:** code revert of the plumbing (redeploy) — safe because inert (no RLS depends on it yet).
- **Stop conditions:** transaction instability / latency regression / ALS context gaps → revert plumbing.

### P6 — Background / `after()` / cron explicit context (before any FORCE/ENABLE RLS)
- **Scope:** enumerate **every** background/`after()`/cron path that touches tenant tables (known: documents **OCR in `after()`**); give each **explicit** `businessId` context via the same plumbing; ensure fail-closed jobs are handled. **No** table those jobs touch may get RLS before this is done.
- **Dependencies:** P5.
- **Risk:** 🔴 High if skipped — RLS fail-closed would silently break OCR/background (zero rows). Doing it first neutralises that.
- **DoD:** each tenant-scoped background path establishes explicit context; a job without context **fails closed** by design (not accidentally); jobs verified functional with context.
- **Evidence:** an inventory of background/after/cron paths + per-path context wiring + a verification that each still works.
- **Production verification:** background flows (OCR, imports, jobs) succeed with context; no silent-empty results.
- **Rollback boundary:** code revert of the per-job context wiring (jobs return to pre-plumbing behavior; since no RLS yet, safe).
- **Stop conditions:** any tenant-scoped background path unaccounted for → do not enable RLS on tables it touches.

### P7 — Pilot: ENABLE RLS + policy → read enforcement
- **Scope:** on the chosen **pilot table** (criteria §5): `ENABLE ROW LEVEL SECURITY` + the tenant policy. Because the runtime is now the non-bypass role (P4), the policy **enforces immediately** for runtime reads.
- **Dependencies:** P5, P6; pilot table selected per §5.
- **Risk:** 🟡 Medium — first real enforcement; a missed context path fails-closed.
- **DoD:** cross-tenant **read** blocked (A cannot see B); same-tenant read works; missing-context → zero rows; no context leak under concurrency — all on the pilot table.
- **Evidence:** cross-tenant negative test + same-tenant positive test + concurrency test (pilot).
- **Production verification:** pilot-table reads correct per tenant; no elevated empty-result errors on legit reads.
- **Rollback boundary:** DB — `DROP POLICY ...; ALTER TABLE ... DISABLE ROW LEVEL SECURITY` (reverse migration).
- **Stop conditions:** any legit read returns empty (missed context) or any cross-tenant read succeeds → rollback + fix.

### P8 — Pilot: write enforcement
- **Scope:** verify `WITH CHECK` blocks cross-tenant writes on the pilot; same-tenant writes work.
- **Dependencies:** P7.
- **Risk:** 🟡 Medium.
- **DoD:** A cannot INSERT/UPDATE a B-owned row; same-tenant writes succeed.
- **Evidence:** cross-tenant write negative + same-tenant write positive (pilot).
- **Production verification:** pilot writes correct; no legit-write failures.
- **Rollback boundary:** same as P7 (drop policy / disable RLS).
- **Stop conditions:** cross-tenant write succeeds, or legit writes blocked → rollback + fix.

### P9 — Pilot: FORCE ROW LEVEL SECURITY
- **Scope:** `ALTER TABLE <pilot> FORCE ROW LEVEL SECURITY` — subject even the owner to the policy (defense-in-depth vs an accidental owner-path).
- **Dependencies:** P7, P8.
- **Risk:** 🟡 Medium — any legitimate owner-path to the pilot (e.g. a migration/job on owner) now scoped.
- **DoD:** FORCE active; owner-path access to the pilot is scoped/handled; runtime unaffected.
- **Evidence:** `relforcerowsecurity=true`; owner-path audit for the pilot.
- **Production verification:** no owner-path breakage for the pilot.
- **Rollback boundary:** DB — `ALTER TABLE ... NO FORCE ROW LEVEL SECURITY`.
- **Stop conditions:** an owner-path breaks → assess (fix the path or defer FORCE).

### P10 — Table-by-table expansion
- **Scope:** repeat P7–P9 per tenant table, one at a time, each gated + verified + reversible; post-rollout monitoring.
- **Dependencies:** pilot fully green.
- **Risk:** 🟡 Medium, bounded per table.
- **DoD:** each table enforced (read+write+FORCE), verified; monitoring shows no fail-closed regressions.
- **Evidence:** per-table negative/positive/concurrency tests; fail-closed error-rate monitoring.
- **Production verification:** per-table, same as pilot.
- **Rollback boundary:** per-table drop-policy / disable / no-force.
- **Stop conditions:** any table's verification fails → rollback that table; do not batch.

---

## 3. Role Migration (owner → dedicated runtime role, no outage / no privilege gap)

- **Provision fully first (P1):** create the role + grant the **entire** current tenant-table surface + **default privileges** for future tables. A privilege gap is prevented by completeness + a pre-switch grant-coverage probe.
- **Verify before switching (P4 DoD):** on a staging/preview replica, run the app's representative query surface as the role; zero permission errors.
- **Switch atomically + reversibly:** the runtime connection string flips owner→role in one env change; **no DDL** at switch time. Because **no RLS exists yet**, the role's effective access equals the owner's (minus DDL) → **no behavior change** if grants are complete.
- **Boot guardrail:** the runtime asserts `rolbypassrls=false` + non-owner at boot; a wrong role **fails the boot** (never a silent isolation-off).
- **Rollback:** flip the env back to owner — instant.
- **Never** run migrations as the runtime role, and **never** run runtime as the owner.

---

## 4. Driver / Prisma-Runtime Migration (staged)

- **Prepare + prove on non-prod (P2):** install adapter deps + `driverAdapters`; prove (a) **query parity** vs the standard client, (b) **transaction stability** under representative load on a **healthy** branch (re-measure — spike was degraded), (c) **connection lifecycle** (no leaked WebSocket sessions).
- **Switch runtime with owner + no RLS (P3):** isolate the driver change from role/RLS. Real-traffic smoke + monitoring.
- **Must be proven before the real runtime uses it:** parity, healthy-branch stability, lifecycle — all green in P2, then P3 smoke.
- **Rollback:** revert to the standard engine (per-deploy).

---

## 5. Pilot Strategy — selection criteria (table NOT chosen here)

The pilot table must be:
- **Tenant-owned** (has a `businessId` and is strictly single-tenant).
- **Low-risk** and **not financial/legal-critical** in the first pilot (⛔ not Billing / documents / authority / payments).
- **Understood traffic** (predictable read/write patterns).
- **Read/write verifiable** (easy to construct cross-tenant negative + same-tenant positive tests).
- **Simple rollback** (few dependencies; disabling RLS restores prior behavior cleanly).
- **Few/simple background paths** touching it (so P6 coverage for it is tractable).

> **Open Decision:** the concrete pilot table is **NOT selected** here — it belongs to the first pilot increment's own Threat Model, chosen against these criteria on current `origin/main`.

---

## 6. Rollback — real, per layer (not git-revert alone)

| Layer | Rollback mechanism | Type |
|---|---|---|
| **Runtime role** (P1/P4) | flip runtime env back to owner; `DROP OWNED BY <role>; DROP ROLE <role>` | env + reverse DB migration |
| **Runtime adapter/driver** (P3) | revert client to standard engine; redeploy | code/deploy |
| **Context plumbing** (P5/P6) | code revert (safe — inert without RLS); redeploy | code/deploy |
| **RLS policy** (P7/P8) | `DROP POLICY ...; ALTER TABLE ... DISABLE ROW LEVEL SECURITY` | reverse DB migration |
| **FORCE RLS** (P9) | `ALTER TABLE ... NO FORCE ROW LEVEL SECURITY` | reverse DB migration |

**Rollback ordering — reverse / LIFO (binding):** layers roll back in the **reverse** of the order they were applied. A layer's rollback assumes **all later layers are already rolled back (or were never applied)** — e.g. the context plumbing (P5) may be removed only once no table has RLS (P7+ already rolled back), since live RLS depends on the plumbing to set context. Never roll back an earlier layer while a later one is still live.

**Rule:** any layer that changed DB/infra state has an explicit **reverse migration** — a git revert alone is insufficient for role/policy/FORCE changes.

---

## 7. Production Gates (all green before advancing a phase)

- **CI** (`release/verify`) green.
- **Preview** deploy green.
- **DB verification** — expected role/grant/policy/FORCE state present (and only that).
- **Cross-tenant negative test** — A cannot read/write B.
- **Same-tenant positive test** — A's own read/write works.
- **Concurrency / context-leak test** — interleaved A/B, no leak.
- **Background-flow verification** — OCR/imports/jobs succeed with explicit context (from P6 onward).
- **Boot guardrail** — runtime asserts non-bypass role (from P4 onward).

---

## 8. Explicit Non-Goals (must NOT enter this migration)

- D1 / session redesign; httpOnly-cookie migration.
- MFA.
- Unrelated auth refactors; Authorization Gateway (1.5) build.
- Broad IDOR sweep.
- Schema cleanup / unrelated data migrations.
- Any unrelated infrastructure migration.
- Adopting `where`-injection as *the* isolation solution (it is defense-in-depth only, not a substitute — architecture §1).

---

## 9. Open Decisions (remain Open — not assumptions)

- **Admin / system cross-tenant mechanism** (explicit, audited path) — architecture §8; required before any system-wide job pattern.
- **Pilot table** selection — §5.
- **Context-plumbing mechanism** — global Prisma client extension vs explicit per-repository transaction wrapper (both set the GUC; choose in P5's design).
- **Connection pool sizing / lifecycle** under real serverless concurrency — architecture §12 (Unverified).
- **Healthy-branch latency budget** — to be measured in P2 (spike numbers were degraded).
- **`neondb_owner` vs a distinct migration role** — whether to keep the existing owner as the migration role or introduce a separate admin role.

---

## 10. First Increment (smallest safe step; NOT executed here)

> **First increment = Phase 1 — Runtime role provisioning.**

- **What:** create the dedicated **non-`BYPASSRLS`, non-owner** runtime role + full grants over the current tenant-table surface + **default privileges** for future tables — in a **non-production** environment first, then production. **The runtime keeps connecting as owner; no RLS anywhere; no driver/plumbing/code change.**
- **Why it is the smallest safe advance:** it is **additive** (a new role), **fully reversible** (`DROP OWNED BY` + `DROP ROLE`), **zero runtime/behavior impact** (runtime unchanged), and it lays the **foundational prerequisite** the entire architecture rests on — **without enabling any RLS enforcement on production**.
- **Parallel zero-prod-footprint precursor:** the **adapter parity/stability proof (P2)** on a healthy non-prod branch can run alongside — it touches no production and de-risks the driver decision. (Its dependency install is itself a change, so it is scoped as P2, not folded into P1.)
- **Explicitly deferred:** driver switch, role switch, context plumbing, and all RLS enablement are **later** increments, each separately approved.

**This document performs none of the above.** Execution of the first increment requires its own approval (and, per this stage's constraint, no role creation / dependency install / Prisma change / env change / migration / production code happens now).

---

## Cross-references
- Architecture (source of truth): `docs/security-d2-tenant-isolation-architecture-v1.md`.
- Gap register: `docs/security-gap-matrix.md` (D2). Strategic: `docs/security-master-plan-v1.md`. Principles/program: `docs/security-constitution-v1.md`, `docs/security-engineering-program-v1.md`.

*End of document — migration plan only. No production, role, dependency, Prisma-runtime, env, migration, schema, or code change is introduced.*
