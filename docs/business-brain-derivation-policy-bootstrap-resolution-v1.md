# Dubiz — Derivation Policy Bootstrap & Resolution · Pre-Implementation Decision v1

> **Status: PRE-IMPLEMENTATION GOVERNANCE/PERSISTENCE DECISION — NOT SCHEMA, NOT CODE.** Read-only. Decides how a policy that exists in code (`vendor-category.policy.ts`) gains a canonical DB identity + explicit version, and how a future caller deterministically resolves `claimType = "vendor-category"` → an exact `DerivationPolicyVersion` — with **no** current/latest semantics, **no** environment-specific hardcoded IDs, **no** dynamic policy selection. Implements Contract v1 + Architecture v1 + Persistence Design v1 + Materializer pre-impl v1; Contract v1 governs.
> **Baseline:** `origin/main f5d8e3f`. Firsthand-revalidated.
> **Type:** a decision. No Prisma / migration / INSERT / seed / resolver code / branch / commit / PR.

---

## 1. Baseline & current registry facts (firsthand)
- **`DerivationPolicy`**: `id Int @id @default(autoincrement())` · `name String` — **NOT `@unique`** (deliberate, per IMPL-1: *"a governed DESCRIPTOR, NOT a DB key/identity; deliberately NOT @@unique — governance, not the database, distinguishes policies"*) · `createdAt`. **No other constraint.**
- **`DerivationPolicyVersion`**: `id` · `policyId` · `version String` · `createdAt` · `@@unique([policyId, version])` · `@@index([policyId])`. The only uniqueness is `(policyId, version)` — **keyed on the DB autoincrement `policyId`.**
- **Both tables are EMPTY** (0 rows; no seed, no writer — firsthand: no `derivationPolicy*.create` anywhere).
- **`vendor-category.policy.ts`** exports `VENDOR_CATEGORY_POLICY_NAME = "vendor-category"` (a code constant) and the candidate-set derivation (IMPL-3, merged).
- **`DerivedClaimResult.policyVersionId`** is a bare `number` the caller must supply; **nothing produces a valid one.**
- **Repo conventions:** migration-embedded `INSERT` has precedent (`20260528120000_platform_feature_access_foundation`); static code registries have precedent (`CATEGORY_RULES` in `category-decision.service.ts`); **no** prisma seed script configured.

## 2. Four concepts kept separate
| # | Concept | This case |
|---|---|---|
| 1 | **Policy Lineage** — identity of a derivation family | `vendor-category` |
| 2 | **Policy Version** — one immutable version | `vendor-category / v1` |
| 3 | **Policy Implementation** — the code function | `vendor-category.policy.ts` |
| 4 | **Claim-Type Binding** — contract: `claimType="vendor-category"` is derived by *exactly* governed version X | `vendor-category → vendor-category/v1` |
These are four different things; conflating them is the trap.

## 3. Critical rule — no environment-specific DB IDs (respected)
The design must **never** hardcode `policyVersionId = <int>`. `id` is a storage identity, non-portable across Preview/Production. Resolution must start from a **stable governed identity that is not the DB autoincrement.**

## 4. Identity-sufficiency audit → **INSUFFICIENT (firsthand)**
Can the current schema resolve `(governed name) + (version label)` → a unique `DerivationPolicyVersion` deterministically?
- **No.** `DerivationPolicy.name` is **not unique** → `findUnique(name)` is impossible; name→policy is `findFirst`/`findMany` = **0/1/many, ambiguous** (and `findFirst` for identity is explicitly forbidden here).
- The only unique key, `(policyId, version)`, requires the **unstable DB `policyId`** — which §3 forbids hardcoding and which a governed identity must not be.
> **There is no stable, unique, governed lineage identity today.** Safe `findUnique`-based resolution is therefore **not possible on the current substrate.** A minimal additive revision is required: **a stable unique governed lineage identity** (§ Verdict / conceptual minimum).
- **Governance tension (must be surfaced):** the substrate was deliberately built *without* DB uniqueness (IMPL-1; and RIA's `RiaPolicyLineage` RP5 shares this "governed identity is NOT a DB key, duplicates legal" stance). Deterministic resolution now makes that stance insufficient. Resolving it means a **conscious, minimal relaxation**: introduce exactly one DB-unique governed handle for resolution — justified because the inert-identity phase had no resolver, and a resolver needs `findUnique`. **This is an owner/governance decision.**

## 5. Bootstrap strategy alternatives
| | determinism | governance | replay | env parity | immutability | op-risk | explicitness | accidental-mutation |
|---|---|---|---|---|---|---|---|---|
| **B1 · migration-seeded canonical registry** | **5** | **5** | **5** | **5** | 5 | 4 | **5** | **5 (none)** |
| B2 · explicit idempotent bootstrap command | 4 | 4 | 3 | 4 | 5 | 3 | 4 | 4 |
| B3 · runtime lazy creation | 1 | 1 | 2 | 2 | 3 | 1 | 2 | **1 (high)** |
| B4 · static code registry only (no rows) | 3 | 4 | 3 | 3 | 5 | 4 | 4 | 5 |
- **B3 rejected (high suspicion):** policy authority must **never** be created accidentally inside a user/derivation flow.
- **B4 insufficient:** the Projection FK (RESTRICT) needs a real `DerivationPolicyVersion` **row** — code-only can't satisfy the FK.
- **B1 (recommended):** an additive migration seeds exactly `vendor-category` lineage + `v1` version → DB state is **deterministic, part of deploy history, governance-explicit, no runtime mutation, env-parity via the same migration.** Repo precedent exists (`platform_feature_access`). *(The seed migration is a separate implementation slice; not written here.)*
> **D1 recommendation: B1 — migration-seeded canonical registry.**

## 6. Resolution strategy alternatives
| | safety | governance | env parity | simplicity | no-precedence | future-proof |
|---|---|---|---|---|---|---|
| **R1 · explicit code binding → `findUnique(governedKey, versionLabel)`** | **5** | **5** | **5** | 4 | **5** | 4 |
| R2 · DB mapping table `claimType → PolicyVersion` | 4 | 4 | 4 | 2 | 5 | 4 |
| R3 · current/latest pointer | 1 | 1 | 3 | 3 | **1 (forbidden)** | 2 |
| R4 · caller supplies arbitrary `policyVersionId` | 1 | 2 | 1 | 5 | 3 | 2 |
- **R3 forbidden** by the contract (no current/latest/active).
- **R4 dangerous:** a caller could pin a version that doesn't match the claimType's implementation.
- **R2** adds a table for a single **static, code-authored** binding — over-engineered; the binding is a governed code constant, the DB only holds canonical rows.
- **R1 (recommended):** a governed **code binding** `claimType "vendor-category" → { policyKey: "vendor-category", versionLabel: "v1" }`, resolved by **`findUnique` on the (governed unique key, version label)** → the exact `DerivationPolicyVersion.id`. Deterministic, no precedence, env-portable (no id in code). **Requires the §4 unique governed key.**
> **D2 recommendation: R1 — explicit code binding + `findUnique` on the governed identity.**

## 7. Binding vs selection (this is binding, not selection)
`vendor-category` implementation **v1** is **explicitly bound** to `vendor-category/v1`. This is a **static governed binding**, not dynamic policy selection — so it needs **no** `current/latest/active/priority`. When a `v2` implementation is authored, moving to it is a **deliberate governed change of the binding + a new seeded row**, never a "newest wins" query.

## 8. Version label = identity, not precedence
`v1`/`v2` are **identity labels**. Higher number ≠ active/current/winner. The resolver reads the label as an exact key, never as an ordering.

## 9. Code ↔ policy provenance
Minimum: a **governed exported descriptor** in `vendor-category.policy.ts` — `{ policyKey: "vendor-category", versionLabel: "v1" }` — matching the seeded canonical row. **No hashes / serialization / framework.** The function's semantics for a version label are pinned by **repo/git history** of that file under that label; we do **not** persist source code. **Governed rule:** changing derivation semantics ⇒ a **new** version label + a **new** seeded row (never re-labeling under the same version). *(Boundary: deep source-archival is out of scope; the version label + git history is the provenance handle.)*

## 10. Historical replay
A Claim derived under `v1` stays explainable after `v2`: the `v1` row **remains** (append-only registry), `v2` is **added, not overwritten**; the `v1` implementation is recoverable from repo history under its label. The Projection pins the exact `policyVersionId` (its `v1` row), so replay resolves to `v1` regardless of later versions. **Boundary noted:** we do not archive source beyond git.

## 11. Registry immutability
Policy/version rows are canonical governance metadata: **no update-in-place, no rename that rewrites identity, no changing semantics under the same version label.** New semantics ⇒ new version identity. (Consistent with IMPL-1's RESTRICT + append-only stance.)

## 12–13. First canonical policy = exactly `vendor-category/v1` = the merged candidate-set semantics
The first (and only) seeded policy is lineage **`vendor-category`** + version **`v1`**, and `v1` **identifies precisely the IMPL-3 candidate-set semantics already merged**: every distinct owner-supported category stays a candidate · no majority · no recency winner · no confidence · conflicting propositions coexist. **No** customer/inventory/RIA rows; **no** future policies; and **once `v1` is sealed, its behavior may never change under the same label.**

## 14. Tenant semantics
The registry stays **GLOBAL / platform-authored** — **no `businessId`** on Policy/Version (already the case; INV-9 governs learned Claims, not the algorithm). Only Claims are tenant-local.

## 15. Failure cases → fail closed
| case | behavior |
|---|---|
| lineage row missing | resolver **fails closed** (no row → no `policyVersionId`); Writer never invents one |
| version row missing | fail closed |
| duplicate lineage identity | **prevented** by the new unique governed key (the whole point of §4) |
| duplicate version label | prevented by `@@unique([policyId, version])` |
| unknown claimType | resolver fails closed (no binding) |
| claimType bound to a wrong lineage's version | prevented — binding names the governed lineage key; `findUnique` is on that key |
| DB id differs Preview↔Prod | **irrelevant** — resolution is by governed key, never id |
| `v2` added but binding still `v1` | correct — binding is explicit; `v1` keeps resolving until the binding is governed-changed |
| `v1` row exists but code constant says `v2` | resolver fails closed (no `v2` row) — surfaced, not guessed |
| Writer gets an arbitrary `policyVersionId` | Writer validates existence (Materializer §10) and rejects if absent; **resolution is not the Writer's job** |
> Every failure is **fail-closed**; none fabricates a policy identity. Whether the Writer should resolve → **no** (§16).

## 16. Writer boundary consequence
| W-A · Writer gets a resolved `policyVersionId`, validates existence | W-B · Writer resolves name/version itself | W-C · Writer gets a governed descriptor, does the exact lookup |
- **W-B rejected** — puts resolution/selection inside the narrow persistence Writer.
- **W-A (recommended):** a **governed resolver (upstream, in the Orchestrator)** turns the code binding → `findUnique` → `policyVersionId`; the **Writer only validates existence** and rejects if absent. Keeps the Writer narrow (Materializer §14). *(W-C is acceptable but pushes a lookup into the Writer; prefer resolution fully upstream.)*
> **D3 recommendation: W-A — resolution belongs upstream of the Writer; the Writer validates, never selects.**

## 17. Bootstrap deployment boundary & ordering
The bootstrap requires DB mutation (schema revision + seed) → a **separate, explicit task before any real projection.** Do **not** mix Policy bootstrap · Writer implementation · Writer activation.
> **Recommended order:** (1) **this POLICY design** → (2) **schema revision** (add the unique governed lineage identity) + **registry bootstrap** (seed `vendor-category/v1`) as an additive migration → (3) **Production deploy** (gated release-migrate) → (4) **W1** persistence Writer → (5) **W2** orchestration + governed resolver → (6) **shadow activation.** Confirmed correct: resolution/registry must exist and be deployed before a real projection can be written.

## 18. Not solving broader policy selection
Out of scope: tenant-specific policies · multiple eligible versions · rollout cohorts · experimentation · automatic upgrade · policy composition · current-version UI. **Goal is only:** exact deterministic binding of `vendor-category` code v1 ↔ canonical Policy Version `v1`.

## Candidate decisions
> **D1 — Registry Bootstrap Strategy = B1** (migration-seeded canonical registry).
> **D2 — claimType → Policy Version Resolution = R1** (explicit governed code binding → `findUnique` on the governed identity).
> **D3 — Writer receives/resolves policy identity = W-A** (resolved upstream; Writer validates existence only).

## Conceptual minimum (NOT Prisma)
1. **Schema revision (the required fix):** add to `DerivationPolicy` **one stable, unique, governed lineage identity** that is **not** the autoincrement id — recommended: a `key String @unique` (a governed slug, e.g. `"vendor-category"`), keeping `name` as a free human descriptor (preserves IMPL-1's name-as-descriptor intent while adding the missing governed handle). *(Alternative: make `name` itself `@unique` — simpler but reverses IMPL-1's explicit "name is not a key"; owner's call.)* Migration is **additive** and safe (table empty; no writer). No tenant, no precedence, no currentness.
2. **Canonical rows (seed):** exactly one `DerivationPolicy { key:"vendor-category", name:"vendor-category" }` + one `DerivationPolicyVersion { policy, version:"v1" }`. Immutable, append-only.
3. **Governed binding (code):** `VENDOR_CATEGORY_POLICY = { policyKey:"vendor-category", versionLabel:"v1" }` in the derivation module.
4. **Resolver (upstream, later slice):** `resolve(claimType) → findUnique(policy by key) → findUnique(version by (policyId, versionLabel)) → policyVersionId`; fail-closed if any row absent.
- **Forbidden:** hardcoded numeric id · current/latest/active/preferred · `businessId` on Policy/Version · findFirst-for-identity · update-in-place/rename · runtime lazy creation · confidence · precedence on version label.

## Schema implications
- **Yes — a minimal additive schema revision is required** (§4): a unique governed lineage identity on `DerivationPolicy`. Without it, no safe `findUnique` resolution exists. This is the reason the verdict is C, not A.

## Implementation prerequisites (ordered)
1. Owner ratifies **D1/D2/D3** + the schema-revision shape (`key @unique` vs `name @unique`).
2. Schema revision + bootstrap seed migration (additive) → gated Production deploy.
3. Then W1 (already designed) becomes usable with a real, resolved `policyVersionId`.

## STOP conditions
READ-ONLY. No Prisma change / migration / INSERT / seed / resolver code / Writer code / branch / commit / PR. The schema revision + seed is a **separate** implementation task pending owner approval.

---

## Verdict
Firsthand, the current Policy substrate **cannot** support safe, deterministic `claimType → PolicyVersion` resolution: `DerivationPolicy.name` is deliberately non-unique and the only unique key is on the unstable DB `policyId`, so no governed `findUnique` handle exists (and `findFirst`-for-identity is forbidden). Resolution therefore requires a **minimal additive revision** — one stable, unique, governed lineage identity — after which **D1=B1 (migration-seeded registry)**, **D2=R1 (explicit code binding + findUnique)**, and **D3=W-A (resolve upstream, Writer validates)** are ready and coherent, sealing `vendor-category/v1` to the already-merged candidate-set semantics.

> **C — EXISTING POLICY SUBSTRATE INSUFFICIENT / REVISION REQUIRED.**
> *Required revision: add one unique governed lineage identity to `DerivationPolicy` (recommended: `key String @unique`; alternative: `name @unique`). With it, D1/D2/D3 are ready to implement as a separate additive bootstrap slice, deployed before W1 is exercised. Owner decision: the revision shape + ratifying D1/D2/D3.*

---

*Derivation Policy Bootstrap & Resolution Decision v1 · READ-ONLY. Implements Contract v1 + Architecture v1 + Persistence Design v1 + Materializer pre-impl v1; Contract v1 governs. No code/schema/migration/INSERT/seed/resolver/Writer; VendorLearning / Evidence Adapter / Memory Deriver / Claim substrate / RIA / C0 / C1 unmodified and unactivated.*
