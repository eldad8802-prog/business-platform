# D2 / PRIVILEGED-WRITE-1 — BusinessFeatureAccess Control-Plane Architecture Report

READ-ONLY architecture phase. No migration, role, function, grant, policy, Preview or
Production action was taken. No branch, no PR.

## 1. Freshness

MAIN SHA = `fc63f07` (`fix(a11y): raise three interactive targets to the A-7 gating minimum (#306)`)
BASELINE = `2e7e3b7` (W4E-B-2) — confirmed ancestor of `origin/main`; 8 commits behind.

DRIFT = **ZERO in the security surface.** The 8 commits touch Leads W2, Revenue adaptive, a11y
targets, home/business-status and QA harnesses. `git diff --name-only 2e7e3b7..origin/main`
matches nothing under `schema.prisma`, `prisma/migrations/**`, `app/api/platform-admin/**`,
`lib/services/feature-access/**`, `lib/tenant/**`, `lib/prisma-admin.ts`, `scripts/ci/**`,
`scripts/security/**`. The W4E-B-2 mapping therefore still describes reality.

WORKING TREE = read from `C:/dev/bp-p7w0a` @ `2e7e3b7` (detached, clean). The main checkout
`C:/dev/business-platform` is on `feat/corporate-marketing-warm-alignment` with unrelated
uncommitted work and was not disturbed.

FILES REVIEWED =
- `prisma/schema.prisma` (models BusinessFeatureAccess, PlatformFeatureDefinition, PlatformFeaturePolicy, PlatformAuditEvent; enum BusinessFeatureAccessState)
- `prisma/migrations/20260528120000_platform_feature_access_foundation/migration.sql`
- `prisma/migrations/*_d2_p7_w4d_*/migration.sql`, `20260831120000_d2_p7_w4eb2_billing_tenant_rls/migration.sql`
- `lib/services/feature-access/` — `update-business-feature-access.service.ts`, `resolve-feature-access.ts`, `require-feature-access.ts`, `business-capabilities.service.ts`, `platform-admin-business-features.service.ts`, `platform-feature-catalog.ts`, `feature-access-mutations.ts`, `feature-access.types.ts`
- `app/api/platform-admin/businesses/[id]/features/route.ts`, `.../[featureKey]/route.ts`, `app/api/business/capabilities/route.ts`
- `lib/auth/platform-admin.ts`, `lib/prisma-admin.ts`, `lib/services/platform-admin/platform-audit.service.ts`, `lib/services/platform-admin/constants.ts`
- `lib/tenant/context.ts`, `lib/tenant/transaction.ts`, `lib/tenant/job.ts`
- `scripts/ci/admin-boundary-guard.sh`, `scripts/ci/w4-context-guard.sh`
- `scripts/security/d2-p7-w2gate-admin-grants.sql`, `d2-p7-wave1-grants.sql`, `d2-p7-w4d-grants.sql`, `d2-p7-w4eb2-grants.sql`
- `.p7w4eb2/battery.mjs`, `.p7w4e/recon.mjs`
- `docs/platform-feature-access-v1.md`, `docs/d2-w4e-deferral-decision-memos-v1.md`

## 2. Model

BUSINESSFEATUREACCESS SCHEMA =

```
id              Int      @id @default(autoincrement())     -- SERIAL, sequence BusinessFeatureAccess_id_seq
businessId      Int                                        -- FK -> Business.id  ON DELETE CASCADE
featureKey      String                                     -- FK -> PlatformFeatureDefinition.key ON DELETE CASCADE
state           BusinessFeatureAccessState                 -- ENUM('ENABLED','DISABLED','INHERIT')
reason          String?                                    -- nullable; service enforces 10..500 chars on write
updatedByUserId Int?                                       -- nullable, NO FK (plain Int — not referentially bound to User)
createdAt       DateTime @default(now())
updatedAt       DateTime @updatedAt
```

KEYS = PK `id`; UNIQUE `(businessId, featureKey)` (`BusinessFeatureAccess_businessId_featureKey_key`);
INDEX `(businessId)`; INDEX `(featureKey)`.

RELATIONS = `business Business` (Cascade), `definition PlatformFeatureDefinition` (Cascade).
`updatedByUserId` is deliberately **not** an FK — the actor is recorded but not enforced.

Semantics: **sparse overrides only** — "no row = inherit global/catalog". `state=INHERIT` is a
legal enum value that the resolver treats as *no effective override* (`hasEffectiveOverride`
matches only ENABLED/DISABLED). Today the service never writes INHERIT; it deletes.

DELETE/UPDATE semantics = INHERIT ⇒ `deleteMany({businessId, featureKey})`;
ENABLED/DISABLED ⇒ `upsert` on the composite unique.

MIGRATION HISTORY = one migration only: `20260528120000_platform_feature_access_foundation`
(tables + indexes + FKs + a definition/policy seed). No later migration touches it; the W4E-B-2
migration names it **only in a comment** explaining its deliberate absence.

CURRENT RLS = **NONE.** No `ENABLE ROW LEVEL SECURITY`, no policy, anywhere in the repo.
`.p7w4eb2/battery.mjs` asserts this positively as a drift gate — *"BusinessFeatureAccess
deliberately untouched (deferred)"*, `relrowsecurity === false`.
`scripts/ci/w4-context-guard.sh` **CI-W4EB2-17** fails the build if the name appears in the
W4E-B-2 migration outside a comment, with a negative self-proof (`v44`).

CURRENT GRANTS = **NONE in any P7 artifact.** No grant to `:ROLE` or to `app_admin` exists on
this table, on `PlatformFeatureDefinition`, or on `PlatformFeaturePolicy` (except
`GRANT SELECT ON "PlatformFeaturePolicy" TO app_admin`). There are no blanket grants anywhere
(`ALL TABLES IN SCHEMA` = 0 hits); every P7 grant is an explicit per-table, per-verb line.
⚠️ To verify live in the implementation wave: whatever privilege the Preview runtime role
currently holds on this table came from the **P4-B lab provisioning**, whose artifact is not in
`main`. This report does not assume it.

## 3. Access Graph

READERS =

| # | Site | Client | Actor | Target business | Cross-tenant |
|---|---|---|---|---|---|
| R1 | `resolve-feature-access.ts:133` `resolveFeatureAccess()` | global `prisma` | mixed | argument | depends on caller |
| R2 | `resolve-feature-access.ts:159` `resolveBusinessCapabilities()` | global `prisma` | mixed | argument | depends on caller |
| R3 | `update-business-feature-access.service.ts:129` pre-check `findUnique` | global `prisma` | PLATFORM_ADMIN | URL `[id]` | **YES** |
| R4 | `update-business-feature-access.service.ts:146` in-tx `findUnique` | `tx` (no GUC) | PLATFORM_ADMIN | URL `[id]` | **YES** |
| R5 | `update-business-feature-access.service.ts:200` post-write `findUnique` | `tx` (no GUC) | PLATFORM_ADMIN | URL `[id]` | **YES** |

Reader call-graph (proven by grep; no other importers exist):

- `require-feature-access.ts::requireFeatureAccess` → R1 — **0 callers.** Enforcement is not wired.
- `business-capabilities.service.ts` → R2 → `GET /api/business/capabilities` — tenant reads its
  **own** business (`user.businessId`, server-derived). **0 in-repo consumers** of the endpoint.
- `platform-admin-business-features.service.ts:107` → R2 → `GET /api/platform-admin/businesses/[id]/features`
  — **cross-tenant admin read on the tenant client.** Consumed by the live admin UI
  (`app/(platform-admin)/admin/businesses/[id]/features/page.tsx` → `business-features-surface.tsx`).
- `update-business-feature-access.service.ts:236` → R1 — admin post-write re-read.

WRITERS = exactly one —
`app/api/platform-admin/businesses/[id]/features/[featureKey]/route.ts` (PATCH)
→ `updateBusinessFeatureAccess()` → `deleteMany` (INHERIT) or `upsert` (ENABLED/DISABLED).
The historical finding is **re-proven**, not assumed.

ADMIN WRITERS = 1 (the above).
TENANT WRITERS = **0**.
BACKGROUND WRITERS = **0** — no job, cron, webhook, seed or script writes this model; the only
other write is the foundation migration's seed of *Definition/Policy*, not of overrides.

GLOBAL PRISMA SITES = all five reader sites and the writer transaction — i.e. **100 % of this
model's access runs on the tenant singleton `@/lib/prisma`**, including the two cross-tenant
admin paths. `getPrismaAdmin()` is never used here.

TRANSACTION PATH = `prisma.$transaction(async tx => …)` at
`update-business-feature-access.service.ts:145` — a **bare interactive transaction with no
tenant context and no GUC**. This is exactly the shape W4E-B-2 classified as *context-less
transaction* and repaired in the Authority ports.

BOUNDARY GAP (new finding) — `scripts/ci/admin-boundary-guard.sh` CI-2/CI-4 scope only
`lib/services/platform-admin/**`. `lib/services/feature-access/**` holds cross-tenant admin
logic and is **outside the ratchet entirely**: neither on the legacy list nor guarded.

## 4. Current Authorization

ADMIN AUTH SOURCE = `lib/auth/platform-admin.ts`. **Two independent conditions, both required:**
(a) DB — `getCurrentUser(req)` from a Bearer token, `user.role === UserRole.PLATFORM_ADMIN`;
(b) ENV — `user.email` ∈ `PLATFORM_ADMIN_EMAILS`. An unset/empty allowlist denies **everyone in
every environment**; there is deliberately no dev/test bypass (W2-GATE hardening).
`requirePlatformAdminOrResponse` maps to 401/403. **CI-3** mechanically requires this guard on
every `app/api/platform-admin/**` and `app/api/dev/**` route — no allowlist.
Platform admins carry `User.businessId` pointing at the `__PLATFORM_SYSTEM__` business row.

TARGET BUSINESS SOURCE = **URL path segment** `[id]`, parsed by `parseBusinessId` (positive
integer only), then validated by
`prisma.business.findFirst({ id, name: { not: "__PLATFORM_SYSTEM__" } })` → 404 if absent.
It is *not* body-supplied, and it is *intentionally* not the actor's own tenant. This is a
legitimate cross-tenant control-plane target — but the authorization model is **role-wide, not
target-scoped**: any PLATFORM_ADMIN may target any business. There is no per-business admin
scoping and no second factor for the mutation.

FEATURE SOURCE = URL path segment `[featureKey]`, validated against the **code** allowlist
`PLATFORM_FEATURE_KEYS` (11 keys) via `isPlatformFeatureKey` → 404 if unknown; then
`catalogEntry.mutable` → 403 `FEATURE_NOT_MUTABLE`. The DB `PlatformFeatureDefinition` row is
**not** consulted for validation — the code catalog is the authority.

ACTOR SOURCE = `auth.id` returned by `requirePlatformAdmin`, derived from the verified Bearer
token. It is **never** taken from body/query/header. Persisted twice: as
`BusinessFeatureAccess.updatedByUserId` and as `PlatformAuditEvent.actorUserId`.

STATE/REASON SOURCE = request body, strictly validated (enum of three; reason trimmed to 10–500
chars). Kill switch: `FEATURE_ACCESS_MUTATIONS_ENABLED === "true"`, else 503 before any DB work.

CURRENT AUDIT = `PlatformAuditEvent` via `createPlatformAuditEventTx(tx, …)` — **inside the same
transaction** as the mutation. Action `PLATFORM_FEATURE_ACCESS_UPDATED`, `targetType="BUSINESS"`,
`targetId=String(businessId)`, metadata `{businessId, featureKey, oldState, newState, reason,
effectiveAllowedAfter, reasonCodeAfter}`, plus ip/user-agent. Audit failure rolls the override back.

CURRENT FAILURE SEMANTICS =
- 503 kill switch → no DB work at all.
- 401/403 authorization → no DB work at all.
- 404 unknown business / unknown feature; 403 immutable feature; 400 bad body — all before the tx.
- 409 `NO_CHANGE`: checked twice — once outside the tx and once **inside** it, so a concurrent
  duplicate loses at the in-tx re-read. The in-tx throw rolls back mutation *and* audit.
- **Rejected/failed attempts are not audited at all** — no denial record for a 403/404/409.
- **No rate limiting** on any platform-admin route (0 hits for rate-limit under `app/api/platform-admin`).
- Atomicity gap: the post-transaction `resolveFeatureAccess` (line 236) reads **outside** the tx;
  it affects the response payload only, not stored truth.

## 5. Threat Model

Legend — EXPOSURE is the state **today** (no RLS on this table, tenant runtime role, Preview
posture). INVARIANT is what the target architecture must guarantee.

| # | Threat | Current exposure | Required invariant |
|---|---|---|---|
| **T1** | Ordinary tenant performs a privileged feature write | **CONTAINED at the app layer only.** No tenant route reaches the writer; the sole route is CI-3-guarded and double-gated (role + email allowlist). **But the DB cannot tell**: the write runs on the *same tenant runtime credential* every tenant request uses. Any code-execution bug in a tenant path can write any business's entitlements. | The tenant runtime role must hold **no write privilege** on this table. Denial must exist at the DB, not only in the router. |
| **T2** | PLATFORM_ADMIN targets an unintended business (or a compromised admin session does) | **EXPOSED by design.** Authorization is role-wide; `[id]` is any positive integer. Only mitigations: existence check, `__PLATFORM_SYSTEM__` exclusion, audit row. | Capability targets **exactly one** business per invocation, named explicitly and recorded. Blast radius of one call = one (business, feature) pair. Target-scoped admin authorization is out of scope but must remain *possible* later. |
| **T3** | Forged `featureKey` | **CLOSED.** Code allowlist (11 keys) + `mutable` flag + FK to `PlatformFeatureDefinition`. | Preserve: capability accepts only catalog keys; unknown key = 404, no mutation. |
| **T4** | The capability is reused to write a **different model** | **FULLY EXPOSED.** The "capability" today is just the tenant singleton, which can write ~50 tables. | The capability's DB privilege must be bounded to `BusinessFeatureAccess` + the approved audit target. Grant-level, not convention-level. |
| **T5** | Capability permits arbitrary SQL | **PARTIAL.** No raw SQL on this path, but the credential in use is a full Prisma client with `$queryRawUnsafe` available. | No raw-SQL surface introduced; the capability exposes named operations only. |
| **T6** | Capability permits arbitrary column mutation | **EXPOSED.** `upsert` on a general client can set any column of any row of any table. | Mutation restricted to `state`, `reason`, `updatedByUserId` on the addressed row; enforced by contract + guard. |
| **T7** | Mutation succeeds, audit fails | **CLOSED.** Same `$transaction`; audit failure rolls the mutation back. | Preserve atomicity. Any architecture that moves audit to a different connection/role **breaks this** and is disqualified unless it proves an equivalent. |
| **T8** | Audit succeeds, mutation fails | **CLOSED** by the same transaction — **but becomes CRITICAL under RLS.** A context-less `$transaction` under FORCE RLS writes **zero rows silently** while the audit row still says the change happened. This is the exact W4E-A / W4E-B-2 silent-zero class. | Under RLS a zero-row `deleteMany`/`upsert` must be *detected* and must fail the transaction — never produce a false-success audit. |
| **T9** | Replay of the same admin operation | **CLOSED / deterministic.** In-tx `isNoOp` → 409, full rollback (no second audit row). Upsert/deleteMany are idempotent. Note: replays leave **no trace at all**. | Replay stays idempotent; optionally record rejected attempts. |
| **T10** | Cross-tenant race | **LOW.** The composite unique + in-tx re-read serialise per (business, feature). Distinct targets are independent by design. Residual: two admins racing on the same pair — one gets 409 or a unique violation. | The write predicate must confine a mutation to a single business even if a `where` clause is lost — a `deleteMany` with a dropped `businessId` must not be able to clear the platform. |
| **T11** | Compromised app layer invokes the DB capability outside the authorized route | **FULLY EXPOSED** (the credential is the ubiquitous tenant singleton). | Capability credential importable only from the approved control-plane module; mechanically enforced in CI (the proven CI-2 pattern). |
| **T12** | Tenant runtime credentials read/invoke the privileged primitive | **EXPOSED** — they *are* the primitive today. | `app_runtime_*` gets **SELECT only** on this table, scoped to its own GUC; no INSERT/UPDATE/DELETE, no EXECUTE on any privileged object. |
| **T13** | `app_admin` read role becomes a writer in practice | **CLOSED today** and guarded: `p7adm_read` is `FOR SELECT` only across every wave; CI-W4EB2-18 fails any `GRANT … INSERT/UPDATE/DELETE … TO app_admin` in a wave grants file (negative self-proof `v45`). Precedent to be honest about: `app_admin` **already holds one write** — `INSERT ON "PlatformAuditEvent"` (append-only audit, W2-GATE). | Generic `app_admin` writes stay **0**. The audit append remains the single, append-only exception. A new capability must not be granted to `app_admin`. |
| **T14** | SECURITY DEFINER `search_path` / function hijack | **N/A today** (no function exists). Becomes live only if Option B is chosen. | If any DB function is ever introduced: owner ≠ superuser where possible, `REVOKE EXECUTE FROM PUBLIC`, explicit `SET search_path`, fully-qualified names, zero dynamic SQL. |
| **T15** | Preview ↔ Production privilege/credential leakage | **PARTIALLY EXPOSED.** `ADMIN_DATABASE_URL` is fail-loud with no fallback (good precedent). But the P7 substrate is inert in Production (runtime is still `neondb_owner`, BYPASSRLS), so **every DB-layer control in this design is inert in Production until the prod cutover phase.** | Any new credential is environment-scoped, fail-loud, never falls back to `DATABASE_URL`/`DIRECT_URL`, and its absence disables the capability rather than downgrading it. |

OPEN RISKS (carried, not solved by this design):

- **O-1 — actor identity is unverifiable at the DB.** No design at this layer can make the
  database confirm "this write was made by a PLATFORM_ADMIN". `actorUserId` is always an
  argument. This architecture bounds a compromised app process **by model and by target count**,
  not by actor. Stated explicitly so no proof over-claims.
- **O-2 — role-wide admin authority.** Any PLATFORM_ADMIN can target any business. Target-scoped
  admin authorization is a separate product decision.
- **O-3 — no denial audit, no rate limit** on the mutation route.
- **O-4 — Production inertness.** Until the prod runtime stops being the DB owner, all of this
  is defence-in-depth on Preview and documentation in Production.

## 6. Required Invariants

The 20 mandated invariants, restated as this design's acceptance criteria:

| # | Invariant | How it is met |
|---|---|---|
| I-1 | Ordinary tenant cannot perform a privileged feature write | Route guard (CI-3) **and** DB: runtime role has SELECT only |
| I-2 | `app_runtime_*` cannot invoke the privileged write | No DML grant; the write policy is `TO` a role the runtime is not a member of |
| I-3 | Generic `app_admin` writes remain 0 | Capability granted to a **new** role, never to `app_admin`; CI-W4EB2-18-style guard extended |
| I-4 | No BYPASSRLS | New role created NOBYPASSRLS, NOSUPERUSER, non-owner; asserted in the battery |
| I-5 | No owner runtime | No SECURITY DEFINER, no owner-owned executable reachable from the app |
| I-6 | Capability targets exactly one business | GUC-scoped write policy: `USING/WITH CHECK ("businessId" = GUC)` |
| I-7 | Capability targets exactly one feature | Code allowlist + FK + service contract (single `featureKey` argument) |
| I-8 | Only defined operations/states | Enum of three; `mutable` flag; reason validation |
| I-9 | No arbitrary SQL | No raw SQL on the path; guard forbids `$queryRaw*`/`$executeRaw*` in the control-plane module |
| I-10 | No arbitrary model access | Grants name exactly `BusinessFeatureAccess` (+ audit append + 2 read tables) |
| I-11 | Actor authorized as PLATFORM_ADMIN before the DB action | `requirePlatformAdmin` precedes the service call; CI-3 makes it unskippable |
| I-12 | Target business must exist | `business.findFirst` + `__PLATFORM_SYSTEM__` exclusion, **moved inside** the privileged transaction |
| I-13 | Feature must exist | `isPlatformFeatureKey` + FK |
| I-14 | Mutation + audit atomic | Both on the **same connection, same transaction**, same role |
| I-15 | Audit contains actor + target + feature + before/after + outcome | Already true; extended with an affected-row count |
| I-16 | Failed authorization creates no business mutation | Guard runs before any DB work; kill switch before that |
| I-17 | Failed mutation creates no false-success audit | **New**: assert affected rows ≥ 1 inside the tx; 0 rows ⇒ throw ⇒ rollback |
| I-18 | Replay deterministic / idempotent | Upsert + in-tx `isNoOp` 409; unchanged |
| I-19 | Preview/Production credential separation | Environment-scoped secret, fail-loud, no fallback |
| I-20 | CI prevents later broadening | Dedicated guard family (§17) with negative self-proofs |

## 7. Option A

DEDICATED ROLE/CLIENT = a new LOGIN role (working name `app_ctlplane_<env>`), NOSUPERUSER,
NOBYPASSRLS, non-owner, holding `SELECT, INSERT, UPDATE, DELETE ON "BusinessFeatureAccess"`
(+ its sequence) and nothing else that writes; consumed by a new Prisma client
`lib/prisma-control-plane.ts` fed by `CONTROL_PLANE_DATABASE_URL`.

PROS =
- Blast radius is enforced by the **database**, not by convention: the credential physically
  cannot write another model (T4, T6) — the strongest available answer to those threats.
- Reuses proven machinery end to end: the `lib/prisma-admin.ts` fail-loud pattern, the CI-2
  import-isolation guard, the per-table/per-verb grants artifact, the `:ROLE` placeholder.
- Keeps `app_admin` read-only (I-3, T13) and needs no DB function (T14 stays N/A).
- Audit atomicity is trivially preserved: grant the same role `SELECT, INSERT ON "PlatformAuditEvent"`
  and mutation + audit share one transaction on one connection (I-14, T7, T8).

CONS =
- A **new credential** in every environment: provisioning, a Vercel secret, rotation, and the
  Neon "never drop/recreate a role" discipline. Real operational cost.
- It is, honestly, "a new writer client". Narrowness comes from grants + CI, not from the shape
  of the API. Any module that imports it can write any row of that one table for any business —
  unless a policy also constrains the target (see the composition in §12).
- Does nothing for T2 / O-1: the DB still cannot verify the actor.

Variant **A2** — *skip the new role; grant `app_admin` single-table DML instead.* Cheapest (no
new secret; `app_admin` already has the audit INSERT precedent). Rejected: `app_admin` is the
shared credential of ~6 admin read services (platform-overview, learning-center, audit list,
businesses, attention, usage). Granting it entitlement-write hands write authority to an
analytics blast radius, and it dissolves the "app_admin = read-only + audit append" doctrine
that CI-W4EB2-18 enforces and that three waves have leaned on. Kept on the record as the
fallback if the owner refuses a second credential.

BLAST RADIUS = one table (+ audit append) for **all** businesses; per-call target unconstrained
unless composed with a policy.

VERDICT = **NECESSARY BUT NOT SUFFICIENT ALONE.** Adopted as the privilege layer of the
recommendation; composed with §9 to bound the per-call target.

## 8. Option B

SECURITY DEFINER = an owner-owned function, conceptually
`set_business_feature_access(target_business_id int, feature_key text, desired_state text, actor_user_id int, reason text)`,
`REVOKE EXECUTE FROM PUBLIC`, `GRANT EXECUTE TO <caller role>`, `SET search_path = pg_catalog, public`,
fully-qualified names, zero dynamic SQL, invoked from Prisma via `$queryRaw`.

PROS =
- Theoretically the tightest DB surface: the caller needs **no table privilege at all**; the only
  thing it can do is the one operation, with validation compiled into the function body.
- Would let `app_admin` keep zero table writes while still performing the operation.

CONS =
- **Owner privilege becomes reachable from the application.** The function must be owned by a
  role that can write the table; in this project that is the DB owner (BYPASSRLS-equivalent).
  That directly contradicts I-4 / I-5 and mission rules 10–11 — a scoped bypass is still a
  bypass, and it sits *inside* the security substrate rather than outside it.
- **Precedent against.** W4E-A explicitly rejected a `SECURITY DEFINER` resolver over
  `PaymentRequest` on exactly this reasoning ("puts a privilege-escalation surface into the
  security substrate; a routing index with no business data does not"). Reversing that precedent
  requires the alternatives to have failed — they have not.
- Re-introduces **raw SQL** on the privileged path (Prisma cannot call functions typed;
  `$queryRaw` on the control-plane path) — in tension with I-9 and with the substrate's
  no-raw-SQL direction (W4E-B-2 took raw `$transaction` from 15 → 0).
- New threat surface that does not otherwise exist: T14 (`search_path`, function hijack, EXECUTE
  leakage to `PUBLIC` on redeploy), plus migration portability and a genuinely awkward rollback
  (dropping a function other code may reference).
- **Buys no actor trust.** `actor_user_id` is still an argument (O-1). The one thing only a
  definer could add — DB-verified identity — is exactly what it cannot deliver.
- RLS interaction is subtle and easy to get wrong: inside a definer function the effective role
  changes, so tenant policies evaluate against the *owner*, which under FORCE RLS behaves
  differently than reviewers expect.

SEARCH_PATH SAFETY = achievable (`SET search_path` on the function + fully-qualified names), but
it is a control that must be *added and guarded*, whereas Option A has no equivalent hazard.

ACTOR TRUST = **no improvement** over Option A.

BLAST RADIUS = smallest on paper (one operation), largest on failure (owner privilege).

VERDICT = **REJECTED.** It trades a bounded, auditable credential for a scoped owner-privilege
escape hatch and a raw-SQL callsite, to buy narrowness that grants already provide.

## 9. Option C

CONTROL-PLANE SERVICE + NARROW PRIMITIVE = the application authorizes PLATFORM_ADMIN, builds an
explicit operation object, and executes it through the **existing** tenant substrate, entering
the *target* business's context:

```
requirePlatformAdmin(req)                              -- role + email allowlist, fail-closed
  → runTenantJob({ businessId: targetBusinessId }, …)  -- explicit, server-derived target
    → withTenantTransaction(tx => …)                   -- sets app.current_business_id = target
      → mutation + audit on ONE connection
```

This needs **no new DB object at all** — `lib/tenant/job.ts` and `lib/tenant/transaction.ts`
already implement precisely this primitive, and `runWithTenantContext` blocks a silent tenant
switch (entering tenant B while tenant A is established throws). Admin routes establish no
ambient tenant context, so entering the target's context is legal and unambiguous.

PROS =
- Zero new DB surface, zero new credential, zero new function. Uses the most-proven primitives
  in the programme.
- The GUC makes the target **explicit and single-valued**, a real blast-radius reduction against
  the dominant observed failure class in this programme — application bugs (W4D's disarmed
  guard, W4E-A's race, W4E-B-2's context-less transactions). A `deleteMany` that loses its
  `businessId` clause still cannot escape the GUC business.

CONS (fatal in the naive form) =
- Executed on the **tenant runtime role**, it requires `INSERT/UPDATE/DELETE` on
  `BusinessFeatureAccess` for `app_runtime_*`. That gives every tenant request path the ability
  to write **its own** entitlements — self-service privilege escalation, and entitlements are
  precisely the thing a tenant must never self-modify. It violates I-1 / I-2 and inverts T1.
- Audit atomicity would additionally require granting the tenant runtime `INSERT` on
  `PlatformAuditEvent` — i.e. letting tenants forge platform audit rows. Unacceptable.

VERDICT = **ADOPTED AS THE EXECUTION MODEL, REJECTED AS THE PRIVILEGE MODEL.** Its structure is
right; it must not run on the tenant credential. Composing it with Option A's dedicated role
removes both cons while keeping both benefits — that composition is the recommendation.

## 10. Option D

MODEL OWNERSHIP REDESIGN = stop treating `BusinessFeatureAccess` as tenant-owned data and
classify it as **control-plane configuration targeting a business** (`businessId` as *subject*,
not *owner*): admin-only storage, with tenant-facing reads served through a projection.

PROS =
- It is **factually the correct classification**, and the access graph proves it: 0 tenant
  writers; the only wired tenant read (`GET /api/business/capabilities`) has 0 in-repo consumers;
  `requireFeatureAccess` has 0 callers. The row's meaning is *the platform's decision about a
  business*, not the business's data.
- Under this framing the whole tension dissolves — there is no tenant ownership to reconcile.

CONS =
- The schema change itself (renaming `businessId` → `targetBusinessId`, revisiting the Cascade FK
  and the composite unique) is explicitly **out of scope** for this task, and would touch the
  unique constraint every reader depends on.
- It does not remove the need for a writer credential; it only stops mis-describing the table.
- Removing tenant RLS entirely would leave the reachable `/api/business/capabilities` endpoint
  with **no DB-level tenant containment** — a regression in defence-in-depth for a live route,
  even if nothing currently calls it.

VERDICT = **ADOPT THE CLASSIFICATION, NOT THE MIGRATION.** The table is documented as
control-plane; the tenant keeps a **read-only, GUC-scoped** policy so the live endpoint retains
DB-level containment. No schema change in this programme.

## 11. Comparison Matrix

Scale: ✅ strong · ◐ partial · ❌ weak / violating.

| Criterion | A (role+client) | A2 (app_admin DML) | B (SECURITY DEFINER) | C (tenant substrate) | D (ownership redesign) | **C′ = A ∘ C (recommended)** |
|---|---|---|---|---|---|---|
| Least privilege | ✅ one table | ◐ one table, shared credential | ✅ one operation | ❌ tenant self-write | ◐ | ✅ one table **and** one business per call |
| Blast radius | ◐ all businesses | ◐ all businesses, wide importer set | ✅ / ❌ owner on failure | ❌ | ◐ | ✅ one (business, feature) |
| RLS compatibility | ◐ needs a policy anyway | ◐ | ◐ definer changes effective role | ✅ native | ❌ removes tenant RLS | ✅ native, role-qualified |
| `app_admin` doctrine | ✅ untouched | ❌ breaks it | ✅ untouched | ✅ untouched | ✅ | ✅ untouched |
| Credential risk | ◐ new secret | ✅ none | ✅ none | ✅ none | ◐ | ◐ new secret (fail-loud, env-scoped) |
| Actor trust (O-1) | ❌ app-side | ❌ app-side | ❌ app-side | ❌ app-side | ❌ | ❌ app-side (no option solves it) |
| Audit atomicity | ✅ same role + tx | ✅ | ◐ inside function | ❌ needs tenant audit INSERT | ✅ | ✅ same role, same tx |
| Testability (PG17) | ✅ | ✅ | ◐ definer semantics | ✅ | ◐ | ✅ |
| Migration complexity | ◐ role + grants | ✅ grants only | ❌ function + rollback | ✅ none | ❌ schema | ◐ policies + grants + role |
| Operational complexity | ◐ | ✅ | ◐ | ✅ | ❌ | ◐ |
| Rollback | ✅ revoke | ✅ revoke | ◐ drop function | ✅ | ❌ | ✅ drop policies + revoke |
| CI enforceability | ✅ CI-2 pattern | ◐ nothing to isolate | ◐ SQL-shape guards | ✅ | ◐ | ✅ import + grant + policy + context guards |
| Future extensibility | ✅ | ◐ | ◐ per-op function sprawl | ✅ | ✅ | ✅ |
| Risk of becoming a generic bypass | ◐ | ❌ high | ❌ high | ❌ | ◐ | ◐ **lowest of the writable options** |

## 12. Recommended Architecture

RECOMMENDED OPTION = **C′ — Control-Plane Capability Role, executed through the existing tenant
context substrate, with role-qualified GUC-scoped policies.** (Option A's privilege model ∘
Option C's execution model ∘ Option D's classification.)

WHY = it is the smallest authority surface that still satisfies every invariant, and it is built
entirely from primitives this programme has already proven:

1. **Model containment** comes from grants — the credential can write exactly one table (T4, T6).
2. **Target containment** comes from the GUC-scoped write policy — one business per invocation,
   even if application code loses a `where` clause (T10, and the whole application-bug class).
3. **Tenant containment** comes from role-qualified policies — the runtime role gets `FOR SELECT`
   only, so a compromised tenant path cannot self-grant an entitlement (T1, T12).
4. **Code containment** comes from CI import isolation — the proven CI-2 pattern (T11).
5. **Audit atomicity** is preserved unchanged: one role, one connection, one transaction (T7, T8).
6. `app_admin` stays read-only + audit-append; no BYPASSRLS; no owner runtime; no function; no
   raw SQL (I-3, I-4, I-5, I-9).

WHY NOT OTHERS =

- **B** buys narrowness that grants already provide, at the price of an app-reachable owner
  privilege, a raw-SQL callsite, and a new threat class — and it does not deliver the one thing
  only a definer could (DB-verified actor). It also reverses a standing W4E-A decision.
- **C alone** requires tenant self-write on entitlements plus tenant INSERT on the platform audit
  table — an inversion of the threat model.
- **A alone** leaves the per-call target unbounded; adding the GUC policy costs nothing and
  removes an entire bug class.
- **A2** is cheapest and is the honest fallback, but it broadens the *shared* admin credential
  and dissolves a doctrine three waves depend on.
- **D**'s classification is adopted; its schema change is unnecessary and out of scope.

DESIGN REFINEMENT (recommended, cheap, strictly reduces privilege): **drop `DELETE` from the
capability.** The `INHERIT` enum value already exists and the resolver already treats it as "no
effective override". Writing `state = INHERIT` instead of `deleteMany` makes the operation a pure
upsert, removes DELETE from the grant set entirely, and preserves the `reason`/`updatedByUserId`
of the un-override action instead of destroying it. Cost: the table stops being strictly sparse —
bounded by businesses × 11 keys. `docs/platform-feature-access-v1.md` ("no row = inherit") stays
true; "row with state=INHERIT" becomes an additional, already-supported way to say the same thing.

HONEST LIMIT = per O-1, no arrangement at this layer makes the database verify that the actor was
a PLATFORM_ADMIN. This architecture bounds a compromised application **by model and by target
count**, not by actor. The proof plan must not claim otherwise.

## 13. Exact Privilege Surface

DB ROLE = one new per-environment LOGIN role, working name `app_ctlplane_preview` (Preview),
member of **no** group — explicitly *not* a member of `app_admin`, so it does not inherit the
`p7adm_read` global-SELECT surface. Attributes: `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE
NOINHERIT`, non-owner, no `neon_superuser`. Created once and password-rotated only (Neon pooler
caches role OIDs).

TABLE PRIVILEGES (the complete set — nothing else, ever):

```sql
GRANT USAGE ON SCHEMA public                                   TO :CTL_ROLE;
GRANT SELECT, INSERT, UPDATE ON "BusinessFeatureAccess"        TO :CTL_ROLE;   -- no DELETE (see §12)
GRANT USAGE, SELECT ON SEQUENCE "BusinessFeatureAccess_id_seq" TO :CTL_ROLE;
GRANT SELECT, INSERT ON "PlatformAuditEvent"                   TO :CTL_ROLE;   -- append-only audit
GRANT USAGE, SELECT ON SEQUENCE "PlatformAuditEvent_id_seq"    TO :CTL_ROLE;
GRANT SELECT ON "Business"                                     TO :CTL_ROLE;   -- target existence check
GRANT SELECT ON "PlatformFeaturePolicy"                        TO :CTL_ROLE;   -- effective-state computation
```

Tenant runtime role (`:ROLE`) gains **read only**:

```sql
GRANT SELECT ON "BusinessFeatureAccess" TO :ROLE;
GRANT SELECT ON "PlatformFeaturePolicy" TO :ROLE;   -- if not already held; required by the capabilities read
```

`app_admin` gains **read only**: `GRANT SELECT ON "BusinessFeatureAccess" TO app_admin;`

Denied to every role, unchanged: DDL, `_prisma_migrations`, `CREATE` on schema, ownership, role
management, BYPASSRLS, GRANT OPTION, and any DELETE on this table.

FUNCTION EXECUTE = **none.** No DB function is introduced (Option B rejected).

RLS INTERACTION = see §16.

ADMIN CLIENT = `lib/prisma-admin.ts` unchanged (SELECT-oriented + audit append). It gains a new
*read* consumer once `platform-admin-business-features.service.ts` is migrated onto it.

TENANT CLIENT = `lib/prisma.ts` unchanged. Its only new capability on this model is a GUC-scoped
`SELECT`.

CONTROL-PLANE CLIENT = new `lib/prisma-control-plane.ts`, a verbatim copy of the
`lib/prisma-admin.ts` contract: lazy, cached on `globalThis`, and **fail-loud** —
`CONTROL_PLANE_DATABASE_URL` missing ⇒ throw at first use, with *no* fallback to
`DATABASE_URL` / `ADMIN_DATABASE_URL` / `DIRECT_URL`. A misconfigured environment must surface as
an error, never as an owner connection or a silently-zeroed write.

SECRETS/ENV = one new environment-scoped secret `CONTROL_PLANE_DATABASE_URL` (Preview first;
Production only at the future prod-cutover phase). The transient provisioning password follows
the established discipline: set a GH secret → run the Preview workflow → **delete the secret
immediately**; never printed, never committed. The existing kill switch
`FEATURE_ACCESS_MUTATIONS_ENABLED` is retained and remains the outermost gate.

## 14. Operation Contract

Conceptual only — no code in this task.

INPUT

```
authorizedActorUserId : int      -- from requirePlatformAdmin() ONLY; never body/query/header
targetBusinessId      : int      -- URL path segment, positive integer
featureKey            : enum     -- one of the 11 PLATFORM_FEATURE_KEYS
desiredState          : enum     -- ENABLED | DISABLED | INHERIT
reason                : string   -- trimmed, 10..500
correlationId         : string?  -- optional; no substrate exists today, so OPTIONAL, not invented
```

AUTHORIZATION (all before any DB work, in order)

1. `FEATURE_ACCESS_MUTATIONS_ENABLED === "true"`, else 503.
2. `requirePlatformAdmin(req)` — DB role `PLATFORM_ADMIN` **and** `PLATFORM_ADMIN_EMAILS`
   membership; empty allowlist denies everyone. 401/403.
3. The service accepts `authorizedActorUserId` **only** as a parameter produced by (2); it never
   re-derives an actor and never reads one from the payload.

VALIDATION

- `featureKey` ∈ code catalog, else 404; `catalogEntry.mutable`, else 403 `FEATURE_NOT_MUTABLE`.
- `desiredState` ∈ the three enum values, else 400. `reason` length, else 400.
- `targetBusinessId` exists and is not `__PLATFORM_SYSTEM__`, else 404 — **executed inside the
  privileged transaction**, not before it (today it is a pre-transaction read on the wrong client).
- In-transaction no-op re-check ⇒ 409 `NO_CHANGE`, full rollback.

MUTATION

- Client: the control-plane client only. Context: `runTenantJob({ businessId: targetBusinessId })`
  → `withTenantTransaction`, so `app.current_business_id = targetBusinessId` for the whole tx.
- Exactly one table: `BusinessFeatureAccess`. Exactly one row: the `(targetBusinessId, featureKey)`
  composite unique. Exactly three mutable columns: `state`, `reason`, `updatedByUserId`.
- Single upsert (no DELETE — `INHERIT` is stored as a state, §12).
- **Affected-row assertion (new, I-17):** if the write reports 0 affected rows, throw and roll
  back. Under FORCE RLS a lost context silently writes nothing; the transaction must fail loudly
  instead of emitting a success audit.

AUDIT — same transaction, same connection, same role:
`PlatformAuditEvent { actorUserId, action: PLATFORM_FEATURE_ACCESS_UPDATED, targetType: "BUSINESS",
targetId: String(targetBusinessId), metadata: { businessId, featureKey, oldState, newState, reason,
effectiveAllowedAfter, reasonCodeAfter, affectedRows }, ip, userAgent }`.

OUTPUT = the existing minimal DTO (`changed`, `generatedAt`, `business{id,name}`,
`feature{PlatformAdminBusinessFeatureItem}`). The post-write effective-state re-read moves
**inside** the transaction so the response cannot describe a state the transaction did not commit.

FAILURE/ROLLBACK = every failure path is atomic: authorization/kill-switch fail before any DB
work; validation, no-op, zero-affected-rows and audit failure all throw inside the transaction and
roll back mutation **and** audit together. No partial state, and no success audit without a
committed mutation.

## 15. Audit Design

AUDIT MODEL = **`PlatformAuditEvent`** — the existing, canonical, append-only, cross-tenant
control-plane audit trail (schema comment: *"Append-only audit trail for platform-level admin
actions (cross-tenant)"*). Its action constant `PLATFORM_FEATURE_ACCESS_UPDATED` already exists.
**No new audit table is introduced.** `BillingAuditEvent` is domain-specific to Billing and is not
appropriate here.

WRITE AUTHORITY = `app_admin` holds `SELECT, INSERT` (W2-GATE, the single sanctioned admin write);
the new control-plane role gets the identical append-only pair. No role gets UPDATE or DELETE on
it — append-only is preserved by grant, not by convention.

ACTOR SOURCE = `authorizedActorUserId`, produced by `requirePlatformAdmin` from a verified Bearer
token. Note `PlatformAuditEvent.actorUserId` **is** FK-bound to `User` (unlike
`BusinessFeatureAccess.updatedByUserId`, which is a plain `Int?`).

TARGET = `targetType="BUSINESS"`, `targetId=String(targetBusinessId)`, plus `featureKey`,
`oldState`, `newState` in metadata. Before/after are already recorded, plus the resolved effective
access after the change.

ATOMICITY = mutation and audit are the same transaction on the same connection under the same
role. This is the property that disqualified Option B variants which would have split them.

FAILURE AUDIT = **currently absent and deliberately kept out of the first slice.** Denied attempts
(403/404/409) leave no record. Recording them is desirable (O-3) but must not be built naively: a
failure-logging path that writes with the *attempted* target as its tenant context is exactly the
shape that produced the W4E-B-1 defect, where pre-verification failures were attributed to a
forged business. If added later, denial records must be written **outside** any tenant context, as
control-plane rows attributed to the **actor**, never to the attempted target.

## 16. RLS Strategy

BUSINESSFEATUREACCESS RLS = `ENABLE` + `FORCE ROW LEVEL SECURITY`, with **three role-qualified
policies** — the first time this substrate uses a role-qualified *write* policy, but the
role-qualified *read* form (`p7adm_read … FOR SELECT TO app_admin`) is proven across five waves.

```sql
-- tenant: read-only, own business only
CREATE POLICY p7pw1_tenant_read ON "BusinessFeatureAccess"
  FOR SELECT TO :ROLE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- platform admin: cross-tenant read (existing doctrine, SELECT only)
CREATE POLICY p7adm_read ON "BusinessFeatureAccess"
  FOR SELECT TO app_admin USING (true);

-- control plane: the capability — DML, but confined to the GUC-named business
CREATE POLICY p7pw1_ctl_write ON "BusinessFeatureAccess"
  TO :CTL_ROLE
  USING      ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);
```

The predicate is the unchanged, proven fail-closed shape: with no GUC,
`current_setting(…, true)` yields `''`, `NULLIF` yields NULL, and the comparison is NULL ⇒ no
rows. A context-less control-plane transaction therefore affects **zero rows** — which the
affected-row assertion (I-17) converts from a silent no-op into a loud failure.

TENANT READ = `GET /api/business/capabilities` keeps working, but its service **must be moved into
`withTenantTransaction`**. ⚠️ Prerequisite, not a live bug: `resolveBusinessCapabilities` runs on
the global client with no context; the moment RLS is enabled it would read **zero overrides**, and
a `DISABLED` entitlement would silently resolve to *allowed* — a **fail-open** regression. This is
the most dangerous item in the whole slice and must be fixed in the same wave that enables the
policy, with an explicit proof.

ADMIN READ = `getPlatformAdminBusinessFeatures` currently performs a **cross-tenant read on the
tenant client**; under RLS the admin UI would show every business as "no override" (fail-open
display). It must migrate to `getPrismaAdmin()` + `p7adm_read` + `GRANT SELECT … TO app_admin`.
This also closes the CI-4 scope gap found in §3.

PRIVILEGED WRITE = passes the policy because the control-plane role matches `p7pw1_ctl_write`
**and** the transaction set the GUC to the target. Two independent conditions at the DB layer;
neither alone suffices. No `BYPASSRLS`, no owner, no definer.

WHY SAFE =

- The tenant role cannot write: its only policy is `FOR SELECT`, and it holds no DML grant —
  policy and privilege both deny (T1, T12).
- The control-plane role cannot touch another model: no grant exists (T4, T6).
- The control-plane role cannot touch more than one business per transaction: the GUC is
  transaction-local and single-valued, and `runWithTenantContext` refuses a nested switch (T10).
- `app_admin` cannot write: `FOR SELECT` policy, no DML grant, CI guard (T13).
- Honest limit: none of this constrains *which* business an authorized admin targets (T2 / O-2),
  nor proves the actor (O-1).

CONTROL-PLANE NEIGHBOURS STAY UNPROTECTED, DELIBERATELY: `PlatformFeatureDefinition`,
`PlatformFeaturePolicy`, `PlatformAuditEvent`, `Business`, `User` have no `businessId` ownership
semantics and remain global control-plane tables with no RLS — consistent with every prior wave.

## 17. CI Guards

PLANNED GUARDS (new family `CI-PW1-1..15`, same shape as the 46-guard family, each with a negative
self-proof in `--self-test`):

| # | Guard | Fails when |
|---|---|---|
| PW1-1 | No generic `app_admin` write | any `GRANT … INSERT/UPDATE/DELETE … TO app_admin` in the wave grants file, except the pre-existing `PlatformAuditEvent` append |
| PW1-2 | No BYPASSRLS / SUPERUSER | role provisioning contains `BYPASSRLS` or `SUPERUSER` |
| PW1-3 | No owner runtime, no definer | migration contains `SECURITY DEFINER` or `OWNER TO` |
| PW1-4 | Capability table allowlist | control-plane grants name any table other than `BusinessFeatureAccess`, `PlatformAuditEvent`, `Business`, `PlatformFeaturePolicy` |
| PW1-5 | No raw SQL on the control-plane path | `$queryRaw*` / `$executeRaw*` appears in `lib/services/feature-access/**` or the control-plane module |
| PW1-6 | No dynamic model/table | the control-plane client is dereferenced with a computed property (`client[x]`) instead of a literal model |
| PW1-7 | Route authorization | the PATCH route lacks `requirePlatformAdmin` (extends CI-3 to assert it on this route by name) |
| PW1-8 | Import isolation | `lib/prisma-control-plane` imported outside `lib/services/feature-access/**` + its own file + tests (the CI-2 pattern) |
| PW1-9 | Not reachable from tenant runtime | any `app/api/**` route outside `app/api/platform-admin/**` transitively imports the control-plane client |
| PW1-10 | Target provenance | `targetBusinessId` derived from `req.json()` / `searchParams` / a header anywhere on this path |
| PW1-11 | Actor provenance | `actorUserId` assigned from anything other than the `requirePlatformAdmin` result |
| PW1-12 | Audit required | the mutation transaction body lacks a `createPlatformAuditEventTx` call |
| PW1-13 | Single-model mutation | the control-plane transaction writes any model other than `businessFeatureAccess` and `platformAuditEvent` |
| PW1-14 | Environment separation | the control-plane client falls back to `DATABASE_URL` / `ADMIN_DATABASE_URL` / `DIRECT_URL` |
| PW1-15 | Rollback artifact exists | a `scripts/security/d2-pw1-*-rollback.sql` is missing, or drops a role instead of revoking |

Plus two **extensions to existing guards**, both closing real gaps found in §3:

- **CI-4 scope**: extend the admin-boundary ratchet from `lib/services/platform-admin/**` to
  `lib/services/feature-access/**`, so cross-tenant admin reads there can never sit on the tenant
  client again.
- **Battery drift gate**: the `.p7w4eb2` assertion "BusinessFeatureAccess stays untouched" and
  `CI-W4EB2-17` must be **retired in the same PR** that enables RLS — otherwise the new wave fails
  the previous wave's guard. This is a deliberate, reviewed doctrine change, not an incidental edit.

NEGATIVE PROOFS = every guard above gets a `--self-test` fixture that *introduces* the violation
into a clean tree and asserts the guard fails, matching the existing `v43`/`v44`/`v45` pattern.

## 18. PG17 Proof Plan

Battery `.pw1/battery.mjs`, `BATTERY_TARGET=pg`, `VERIFY_ONLY` read-only mode, `$`-aware
`splitSql`, marker-prefixed fixtures (`pw1-`), endpoint deny-list assertion, and drift gates on
every prior wave's policy count (`p4b_tenant`=5, `p7w1`=14, `p7w2`=24, `p7w3`=15, `p7w4b`=5,
`p7w4c`=3, `p7w4d`=8, `p7w4ea`=4, `p7w4eb2`=8, `p7adm_read`=10). Two fixture businesses A and B,
each with overrides, plus a live tenant-equivalent parent so nothing is proven against an
unprotected neighbour.

| # | Assertion | Expected |
|---|---|---|
| P-1 | Authorized operation on target A as `:CTL_ROLE` with GUC=A | **succeeds**, 1 row affected |
| P-2 | Same operation on target B | **succeeds** — cross-tenant is the legitimate feature |
| P-3 | `:CTL_ROLE` with GUC=A attempts to write B's row | **0 rows** (policy denies) |
| P-4 | `:CTL_ROLE` with **no GUC** attempts any write | **0 rows** ⇒ affected-row assertion throws ⇒ rollback |
| P-5 | `:CTL_ROLE` `UPDATE` with the `businessId` predicate dropped entirely | affects **only** the GUC business — blast-radius proof |
| P-6 | `:CTL_ROLE` attempts a `WITH CHECK` escape (`SET businessId = B` under GUC=A) | **rejected** |
| P-7 | Tenant runtime role `INSERT` / `UPDATE` / `DELETE` on the table | **permission denied** (no grant) |
| P-8 | Tenant runtime `SELECT` with GUC=A | sees **only** A's rows |
| P-9 | Tenant runtime `SELECT` with no GUC | **0 rows** (fail-closed) |
| P-10 | `app_admin` `SELECT` across businesses | sees **all** rows (`p7adm_read`) |
| P-11 | `app_admin` any write on the table | **permission denied** |
| P-12 | `:CTL_ROLE` writes any other model (5 samples across waves) | **permission denied** on every one |
| P-13 | `:CTL_ROLE` arbitrary DDL / `CREATE` / `_prisma_migrations` | **denied** |
| P-14 | `:CTL_ROLE` role attributes | `NOSUPERUSER`, `NOBYPASSRLS`, non-owner, not a member of `app_admin`, no `neon_superuser` |
| P-15 | `:CTL_ROLE` attempts `SET ROLE` / privilege escalation | **denied** |
| P-16 | Audit row written in the same tx | present, with the correct actor/target/before/after |
| P-17 | Forced mutation failure after the audit insert | **both** rolled back — no orphan audit |
| P-18 | Forced audit failure after the mutation | **both** rolled back — override unchanged |
| P-19 | 20 concurrent operations on the **same** (business, feature) | exactly one commits; others 409 / unique-violation; no duplicate row |
| P-20 | Concurrent operations on **different** businesses | all succeed, no interference |
| P-21 | Replay of an identical operation | 409 `NO_CHANGE`, **no** second audit row, no state change |
| P-22 | Raw-SQL attack via the control-plane connection (`DROP`, cross-table `UPDATE`) | **denied** by grants |
| P-23 | `EXECUTE` on any function as `:CTL_ROLE` | no privileged function exists (asserted: 0 rows) |
| P-24 | `search_path` manipulation | N/A by construction — asserted as "no SECURITY DEFINER object exists" |
| P-25 | Tenant capabilities read under RLS returns a **DISABLED** override correctly | the fail-open regression proof — must show `allowed=false`, not `allowed=true` |
| P-26 | Admin features read on the admin client under RLS shows the override | fail-open display proof |
| P-27 | Prior-wave drift | all ten policy counts unchanged; synthetic residue 0 |
| P-28 | Rollback artifact | removes only PW1 policies/grants; every prior wave intact; no role dropped |

PREVIEW = **not in this task and not in the first implementation slice's early phases.** Only
after PG17 is fully green, and only through the established preview workflow. No Production.

## 19. Preview Plan

Future gate, for the implementation task only — stated so it is not improvised later:

1. Provision `app_ctlplane_preview` on Preview (`orange-shape-16620903` / `br-red-scene-amth33qx` /
   `ep-wispy-dawn-amr74bwz` / `neondb`), create-once + password-rotate, DENY-LIST
   (`ep-flat-brook-am4bhq1y`, `ep-winter-bread-ami5o8p5`) asserted by the battery before any DDL.
2. Transient secret discipline: set the GH secret → run the workflow → **delete it immediately**;
   never printed, never committed.
3. Apply the canonical migration (policies only, role-free, idempotent, expand-only), then the
   per-environment grants artifact with `:ROLE` / `:CTL_ROLE` substituted textually.
4. Run the full battery against `BATTERY_TARGET=neon`; then `VERIFY_ONLY` after merge.
5. Set `CONTROL_PLANE_DATABASE_URL` as a Preview-scoped environment variable; confirm the
   fail-loud path (unset ⇒ capability throws, never degrades).
6. Confirm the `FEATURE_ACCESS_MUTATIONS_ENABLED` posture explicitly before enabling anything.
7. Preview lags main — check for missing columns before diagnosing a battery failure as a bug; a
   guarded, expand-only catch-up of an already-merged migration has been needed twice.

## 20. Production

PRODUCTION TOUCHED = **NO.**

Nothing in this task read from, wrote to, or planned an action against Production. Production's
runtime is still `neondb_owner` (BYPASSRLS), which makes every canonical P7 migration — and this
design's policies — **inert** there. Production cutover remains a separate, future, explicitly
approved phase. Claude has no Production access.

## 21. Decision

BUSINESSFEATUREACCESS = **RESOLVED — architecture selected.** Control-plane capability role,
executed through the existing tenant-context substrate, with role-qualified GUC-scoped policies
(Option C′ = A ∘ C, adopting D's classification). It is classified as **control-plane
configuration targeting a business**, not tenant-owned data, and is protected by a tenant
read-only policy, an admin read policy, and a single-table GUC-scoped write policy.

GENERIC APP_ADMIN WRITES = **NO** — unchanged at 0. The only `app_admin` write remains the
pre-existing append-only `INSERT ON "PlatformAuditEvent"`.

BYPASSRLS = **NO.**

OWNER RUNTIME = **NO** — and no `SECURITY DEFINER` object; Option B explicitly rejected.

GENERIC PRIVILEGED PRISMA = **NO.** A *dedicated* control-plane client is introduced, bounded by
DB grants to one writable table plus an append-only audit target, fail-loud on a missing
credential, and mechanically isolated from tenant code by CI. It is not a general-purpose
privileged client.

READY FOR IMPLEMENTATION = **YES**, conditional on one owner decision (below).

BLOCKER = none technical. **One owner decision is required before implementation:** approval to
introduce a second database credential (`app_ctlplane_preview` + `CONTROL_PLANE_DATABASE_URL`)
with its provisioning and rotation burden. If the owner declines a second credential, the fallback
is variant **A2** (single-table DML granted to `app_admin`) — cheaper, but it widens the shared
admin credential and dissolves the read-only `app_admin` doctrine that CI-W4EB2-18 enforces; this
report does **not** recommend it.

Three items must be inside the implementation slice, not deferred — each is a latent fail-**open**
or fail-silent that the policy itself would activate:

1. `resolveBusinessCapabilities` must move into `withTenantTransaction` (else a `DISABLED`
   entitlement silently resolves to *allowed* — §16, proof P-25).
2. `getPlatformAdminBusinessFeatures` must move to the admin client (else the admin UI shows every
   business as "no override" — §16, proof P-26).
3. `updateBusinessFeatureAccess`'s bare `prisma.$transaction` must become a context-bearing
   control-plane transaction with an affected-row assertion (else a context-less write emits a
   success audit for a mutation that never happened — §14, proofs P-4 / P-17 / P-18).

STOP.
