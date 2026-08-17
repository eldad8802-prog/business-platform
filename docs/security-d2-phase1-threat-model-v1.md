# D2 — Phase 1 (Runtime Role Provisioning) — Threat Model + CCR (v1)

> **Scope:** **Phase 1 only** — provision the dedicated runtime DB role + grants + default privileges. **The runtime keeps connecting as `neondb_owner`; no adapter, no ALS, no Prisma change, no RLS, no runtime switch.**
> **This is analysis, not implementation.** Nothing here creates a role, grants, migrations, dependencies, env, or code.
> **Depends on:** `docs/security-d2-migration-plan-v1.md` (Phase 1) + `docs/security-d2-tenant-isolation-architecture-v1.md`.
> **Evidence base:** read-only inspection of the dev DB (ep-square-grass), §Evidence.

---

## 1. Security Objective

**What Phase 1 achieves:**
- A dedicated **runtime application role** exists in the DB with: **`rolbypassrls = false`**, **non-superuser**, **non-owner**, minimal DML grants on the app's tables + sequence usage, and **default privileges** so future tables auto-grant.
- It lays the **one hard prerequisite** RLS cannot work without (the Spike proved `neondb_owner`/`BYPASSRLS` silently voids RLS).

**What Phase 1 explicitly does NOT achieve (no illusion of "RLS exists"):**
- ❌ **No tenant isolation whatsoever.** The runtime **still connects as `neondb_owner`** (bypassrls). Cross-tenant access is exactly as (un)protected as today.
- ❌ No RLS policy, no `FORCE`, no context, no enforcement — the new role is **unused** until Phase 4.
- **Anti-illusion assertion:** provisioning a non-bypass role changes **nothing** about live isolation. Isolation begins only when (P4) the runtime connects as this role **and** (P7+) RLS policies exist. Phase 1 is *preparation*, and this document forbids any claim of isolation from it.

---

## 2. Assets (what is harmed if Role Migration is done wrong)

| Asset | Why it matters | Phase-1 exposure |
|---|---|---|
| **Production availability** | the app must keep serving | 🟢 near-zero — runtime is untouched (still owner); the new role is unused |
| **Database integrity** | no data corruption | 🟢 near-zero — Phase 1 is additive (a role + grants); no data DDL |
| **Migration capability** | migrations must keep working | 🟢 near-zero — migrations still run as owner; the new role has no DDL |
| **Runtime privileges** | the app must retain all access it needs | 🟢 unaffected in Phase 1 (owner unchanged); *grant correctness matters at P4, not now* |
| **Future RLS correctness** | RLS must actually enforce later | 🟡 **the real Phase-1 asset** — the role's **attributes** (must be NOBYPASSRLS / non-super / non-owner) determine whether RLS will ever work |
| **Credential surface** | a new login role = a new secret | 🟡 mitigated by CCR refinement (create **NOLOGIN**; credential deferred to P4) |

---

## 3. Trust Boundaries

| Boundary | Trust posture |
|---|---|
| **Migration/Admin role** (`neondb_owner`) | high privilege: owner of all 97 tables, `createrole=true` (can provision the runtime role), `bypassrls=true`. Runs DDL/migrations via **direct URL**. **Trusted for DDL; must never be the runtime role.** |
| **Runtime role** (to be created) | **least privilege:** non-bypass, non-owner, DML-only on app tables. In Phase 1 it is **inert** (ideally NOLOGIN → cannot even authenticate). |
| **Prisma** | issues SQL as whichever role the connection string authenticates. In Phase 1, still the owner. Trust = "executes as the connected role" — it does not itself enforce isolation. |
| **Neon** | provides the Postgres + PgBouncer pooler + system roles (`cloud_admin`/`neon_service`/`neon_superuser`, all bypassrls — **Neon-internal, not app-used**). Role creation + grants are standard SQL, executed by `neondb_owner`. |
| **Application runtime** | connects with the runtime connection string. In Phase 1, unchanged (owner). Boundary crossing (owner→role) is **Phase 4**, not here. |
| **PostgreSQL** | the enforcement engine (later). In Phase 1 it only stores the role + grants; it enforces nothing new. |

---

## 4. Threat Enumeration

| # | Threat | Real in Phase 1? | Consequence & control |
|---|---|---|---|
| TH1 | **Wrong grants** (grant on wrong objects) | low | additive; owner unaffected. Verify exact grant set (§7). |
| TH2 | **Excessive grants** (e.g. `BYPASSRLS`, superuser, DDL, `_prisma_migrations`) | 🔴 **the key threat** | a bypass/super/owner-equivalent role **defeats future RLS = false security**. Control: assert attributes NOBYPASSRLS/NOSUPERUSER/non-owner; grant **DML only**, exclude `_prisma_migrations` + DDL. |
| TH3 | **Missing grants** (a table not granted) | low **in P1** | zero runtime impact now (owner still serves); would surface at **P4** as permission errors. Control: grant across the app-table surface + **default privileges**; verify coverage before P4. |
| TH4 | **Owner accidentally reused** (runtime points at owner) | n/a in P1 | Phase 1 does not switch the runtime. Guard belongs to P4 (boot-assert). |
| TH5 | **Runtime still using owner** | ✅ **intended in P1** | this is the designed Phase-1 state (no switch yet). Not a defect. |
| TH6 | **Runtime cannot start** | 🟢 no | runtime unchanged in P1; the new role is inert/NOLOGIN. Start-failure risk is P4. |
| TH7 | **Migrations break** | 🟢 no | migrations run as owner; the new role has no DDL and is not involved. |
| TH8 | **Future tables missing privileges** | 🟡 | if `ALTER DEFAULT PRIVILEGES` is not set (or set for the wrong creating role), new tables won't auto-grant → P4/P10 breakage. Control: set default privileges **FOR ROLE `neondb_owner`** (the table creator). |
| TH9 | **Default-privileges mistakes** (wrong schema/role/verbs) | 🟡 | silent until a new table appears. Control: verify default privileges apply to a freshly-created probe table (§7). |
| TH10 | **Connection-string mistakes** | n/a in P1 | no new connection string is used in P1 (NOLOGIN → none needed). Risk is P4. |
| TH11 | **Rollback hazards** (grants block `DROP ROLE`; `DROP OWNED BY` denied on Neon) | 🟡 | **Non-prod finding:** `DROP OWNED BY <role>` is **permission-denied for `neondb_owner` on Neon** (`42501`). Control (proven clean in non-prod): **explicit REVOKE** (table DML + sequences + schema usage + default privileges) then `DROP ROLE`. NOLOGIN → no sessions. |

**Indirectly-scoped tables (newly found — feeds P7, not P1):** 32 of 97 tables have **no direct `businessId`** (child tables like `BillingDocumentLine`, `OAuthToken`, `PurchaseOrderLine`, and genuinely-global `Platform*`). The architecture's `business_id`-column RLS policy (§5) does **not** cover them. **Not a Phase-1 issue** (Phase 1 = grants only), but a **new precondition for P7** (policy-model must handle parent-scoped + global tables).

---

## 5. Failure Modes

| Failure | Cause | Detection | Impact | Recovery | Rollback |
|---|---|---|---|---|---|
| Role created with `BYPASSRLS`/super | wrong `CREATE ROLE` flags | `SELECT rolbypassrls,rolsuper` = must be false | future RLS silently void | `ALTER ROLE ... NOBYPASSRLS NOSUPERUSER` | drop + recreate correctly |
| Missing table grant | table omitted / new table | grant-coverage probe (§7); surfaces at P4 | none in P1; P4 permission errors | grant the missing table | n/a (additive) |
| Default privileges not applied | `ALTER DEFAULT PRIVILEGES` missing/wrong role | probe: create temp table as owner → check auto-grant | future tables ungranted | set default privileges FOR `neondb_owner` | reset default privileges |
| Excessive grant (`_prisma_migrations`/DDL) | over-broad `GRANT` | grant audit (§7) | least-privilege violation; if BYPASSRLS → false security | `REVOKE` the excess | as above |
| Partial DDL apply | connection drop mid-provision (Neon dev cold-suspend) | re-inspect actual PG state; re-run idempotent provisioning | inconsistent role state (owner/runtime unaffected) | re-apply idempotently (retry-safe) | explicit REVOKE + `DROP ROLE` |
| Rollback blocked (`DROP OWNED BY` denied on Neon) | Neon role-management semantics (`42501`) | `permission denied` on `DROP OWNED BY` | cannot remove via `DROP OWNED BY` | use **explicit REVOKE** of all grants + default privileges | then `DROP ROLE` (proven clean in non-prod) |

---

## 6. Blast Radius (if Phase 1 fails mid-way)

- **Breaks:** effectively **nothing user-facing.** The runtime still authenticates as `neondb_owner` and serves normally throughout Phase 1. A half-created role / partial grants is an **inert artifact**.
- **Does NOT break:** production availability, data integrity, migrations, runtime privileges — all ride on `neondb_owner`, which Phase 1 never touches.
- **Recoverable:** fully. The only persistent artifacts are a role + grants, removable via **explicit REVOKE** of all grants (+ default privileges) → `DROP ROLE` (proven clean in non-prod; **`DROP OWNED BY` is permission-denied on Neon**). With **NOLOGIN**, there are no sessions to terminate.
- **Net:** Phase 1's production blast radius is **≈ zero** — this is precisely why it is the correct first step (isolate provisioning from the risky switch).

---

## 7. Verification Plan (objective)

Run in **non-prod first, then prod**; each is a concrete query:

1. **runtime still works** — app health 200 + representative read/write flows succeed (runtime unchanged = expected pass).
2. **migrations still work** — a no-op/`prisma migrate status` (owner, direct URL) reports healthy; a shadow migration applies cleanly.
3. **role is non-bypass** — `SELECT rolbypassrls FROM pg_roles WHERE rolname='<runtime>'` → **false**; `rolsuper` → false.
4. **role is not owner** — `SELECT count(*) FROM pg_tables WHERE tableowner='<runtime>'` → **0**.
4b. **role is a member of NO group** (the correct Neon check for privilege escalation) — no row in `pg_auth_members` where the role is the *member*. *Neon auto-adds the creator (`neondb_owner`) as a member **of** the role with `inherit_option=false` — platform behavior, **not** escalation; do NOT assert "the role has no members".*
5. **grants complete** — for every app table the runtime needs, `has_table_privilege('<runtime>','<t>','SELECT/INSERT/UPDATE/DELETE')` → true; sequences `has_sequence_privilege(...,'USAGE,SELECT')` → true. `_prisma_migrations` → **no** grant (excluded).
6. **default privileges correct** — as owner, create a temp table; assert the runtime role **automatically** has DML on it; drop the temp table.
7. **NOLOGIN (if adopted)** — `SELECT rolcanlogin` → false (no usable credential until P4).

---

## 8. Rollback Proof (system returns to working, not just "role deleted")

Rollback = restore the prior **effective-privilege state** — identical *effective* privileges (owner + `PUBLIC`), ownership, memberships, default privileges, and runtime behavior; **not** necessarily a byte-identical catalog representation (see the note after step 4). **Proof obligations, not assertions:**
1. **Before:** capture that the runtime works as `neondb_owner` (health 200, flows) — the baseline.
2. **Rollback action (Neon-correct):** **explicit REVOKE** table DML + sequences + schema `USAGE` FROM `<runtime>` → reverse the `ALTER DEFAULT PRIVILEGES` → `DROP ROLE <runtime>`. (**Not** `DROP OWNED BY` — permission-denied for `neondb_owner` on Neon, `42501`; proven in non-prod.)
3. **After — prove the system still works:** re-run the **same** baseline checks (health 200, representative flows, migrations) → identical to "before". 
4. **Prove the role is gone:** `SELECT count(*) FROM pg_roles WHERE rolname='<runtime>'` → 0; `SELECT ... FROM pg_default_acl` shows no residual default privileges for it.
Because the runtime never depended on the role in Phase 1, step 3 is guaranteed to pass — but it is **verified, not assumed.**

> **Catalog-representation caveat (Production evidence, 2026-08-17 · ep-flat-brook):** `GRANT … ON ALL` materializes explicit ACL entries; after the reverse `REVOKE`, PostgreSQL may leave an **explicit owner-only ACL** where the object had `relacl = NULL`. Since `relacl = NULL` *is* the default privileges, this is a **catalog-representation change, not a privilege change** — provided the effective grants are unchanged and **no** additional grantee (and no `app_runtime`) remains. Rollback is verified on **effective privileges**, not a catalog byte/MD5 fingerprint (which may be kept as a **diagnostic only**). See Migration Plan §6.1 (Rollback invariant).

---

## 9. Preconditions re-check (any new since the Migration Plan?)

- ✅ **Role creation is possible** — `neondb_owner` has `rolcreaterole=true` (evidence). No new blocker.
- ✅ **Default-privileges creator identified** — all tables owned by `neondb_owner`; default privileges must be set **FOR ROLE `neondb_owner`**. (Refines PC2.)
- 🟡 **NEW precondition — for P7, not P1:** 32 tables are **not** directly `businessId`-scoped → the architecture's RLS policy model (§5) is **incomplete** for parent-scoped/global tables. **Must be resolved before the pilot (P7).** Recorded as an Open Decision; does **not** block Phase 1.
- ✅ No other new precondition. Neon system roles (all bypassrls) are internal, not app-used — irrelevant to Phase 1.

---

## 10. CCR — adversarial challenge (try to refute Phase 1)

**Attempt 1 — a simpler way?** Could we skip a dedicated role and make RLS work otherwise? **No** — the Spike *proved* the default owner bypasses RLS; a non-bypass role is mandatory. Phase 1 is the minimal provisioning of that mandatory prerequisite. *Refutation fails.*

**Attempt 2 — a safer way?** ✅ **Yes, found one:** create the role **`NOLOGIN`** in Phase 1 (grants + default privileges only) and add `LOGIN PASSWORD` at **Phase 4** (the switch). This removes the "unused login credential" window entirely — Phase 1 introduces **no authenticable secret**. **This refines the Migration Plan's Phase 1** (Plan currently implies a LOGIN role). *Adopt.*

**Attempt 3 — less blast radius?** Phase 1 is already ≈zero prod blast (runtime untouched). NOLOGIN drives the credential surface to nil too. Hard to beat. *No better option.*

**Attempt 4 — combine with Phase 4 to avoid an idle role?** That would merge provisioning + switch → if grants are wrong, the **switch breaks the app** (larger, coupled blast). Separating (P1 provision, P4 switch) lets grant-coverage be proven **before** anything depends on it. *Separation is safer; combining is worse.*

**Attempt 5 — reason not to do it at all?** The role sits idle until P4. With NOLOGIN there is no downside (no credential, no runtime path, fully reversible). Not doing it just blocks all of D2. *No valid reason to skip.*

**Attempt 6 — least-privilege vs broad grant?** Granting DML on *all* app tables is slightly excessive but avoids a missed-table break at P4; a tight least-privilege set needs a full query-surface audit and risks omissions. **Decision:** grant DML on all app tables **except `_prisma_migrations`** (runtime never touches it) + default privileges — balances simplicity, least-privilege intent, and P4 safety.

### Verdict

> **A — Phase 1 (Runtime Role Provisioning) remains the correct first increment**, with **one adopted refinement**: create the role **NOLOGIN** (credential deferred to Phase 4), grant **DML-only** on app tables excluding `_prisma_migrations`, set **default privileges FOR `neondb_owner`**, and assert **NOBYPASSRLS / non-super / non-owner**.

**Required Migration-Plan update before execution:** Phase 1 → "create role **NOLOGIN**; LOGIN+password added at Phase 4". Record the **P7 precondition** (RLS policy model for the 32 indirectly-scoped/global tables) as an Open Decision.

**Still true after CCR:** Impl `NOT STARTED`; Phase 1 provides **no** isolation and must never be represented as such.

---

## Evidence (read-only, dev DB ep-square-grass)
- Roles: `neondb_owner` — `rolsuper=false`, **`rolbypassrls=true`**, `rolcanlogin=true`, **`rolcreaterole=true`**; Neon system roles `cloud_admin`(super)/`neon_service`/`neon_superuser` all bypassrls (internal).
- Schema: **97 base tables** (65 with direct `businessId`, **32 without**), **89 sequences**, 0 views; **all tables owned by `neondb_owner`**; `_prisma_migrations` present.

*End — Threat Model + CCR for Phase 1 only. No role, grant, migration, dependency, Prisma, env, or code change is performed.*
