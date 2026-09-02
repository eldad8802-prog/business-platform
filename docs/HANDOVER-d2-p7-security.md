# HANDOVER — D2 / P7 Tenant Isolation Program

Task-scoped handover for a fresh session. The repo, `docs/`, and the auto-memory
files are the long-term source of truth; this document exists so a new agent can
continue without reconstructing chat history.

---

## 1. What the programme is

**D2 / P7** puts the Dubiz database behind PostgreSQL **Row-Level Security**, so
a compromised or buggy application path cannot read or write another business's
data. It is delivered in **waves**, each one a separate authorized mission with
a mandatory STOP + structured report at the end.

The canonical tenant chain, unchanged since W0a:

```
trusted server-derived businessId          (session / stored parent — never payload)
  → runWithTenantContext(...)              (AsyncLocalStorage)
  → withTenantTransaction((tx) => ...)     (sets app.current_business_id GUC, tx-local)
  → tenant DB work under FORCE RLS
```

Fail-closed predicate used by every policy:

```sql
"businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int
```

External calls (OCR / Vision / OpenAI / Gmail / Meta / payment providers / ITA)
**never** run inside a tenant transaction. Pattern: short DB tx → external call
→ short DB tx.

---

## 2. Environment facts (verified, load-bearing)

- **Working worktree**: `C:/dev/bp-p7w0a` (the main checkout `C:/dev/business-platform`
  is on an unrelated branch with uncommitted work — do not disturb it).
- **Preview Neon**: project `orange-shape-16620903`, branch `br-red-scene-amth33qx`,
  endpoint `ep-wispy-dawn-amr74bwz`, DB `neondb`.
  **DENY-LIST** (never touch): `ep-flat-brook-am4bhq1y`, `ep-winter-bread-ami5o8p5`.
- **Preview tenant runtime role**: `app_runtime_preview_p4b` — LOGIN, NOSUPERUSER,
  **NOBYPASSRLS**, non-owner.
- **Admin**: `app_admin` (NOLOGIN group, env-neutral) + `app_admin_preview` (LOGIN).
  Doctrine: **SELECT-ONLY**. `p7adm_read` policies are `FOR SELECT` only. There
  are no admin write grants anywhere and adding one is a STOP condition.
- **Transient secrets** live in the session scratchpad as `.p4b_pw` and
  `.w2g_admin_pw`. Pattern: set GH secrets `W1_RUNTIME_URL` / `W2G_ADMIN_PW`
  → run the Preview workflow → **delete both secrets immediately**. Never print
  or commit them.
- **Production is untouched by the whole programme.** Prod runtime is still
  `neondb_owner` (BYPASSRLS), which makes every canonical migration **inert**
  there. Prod cutover is a separate future phase. Claude has no prod access.

---

## 3. What this session completed (all MERGED to main)

| Wave | Merge SHA | Content |
|---|---|---|
| **W4B** | `71a7358` | WhatsApp — 5 tables `p7w4b_tenant`; WhatsAppConnection = provider-bootstrap no-RLS |
| **W4C** | `8effd0c` | Gmail — 3 tables `p7w4c_tenant` + 4th `p7adm_read` on EmailConnection |
| **W4D** | `169a47e` | Documents/OCR/Learning — 8 tables `p7w4d_tenant` (6 direct + 2 parent-join), 6 `p7adm_read`, learning-center moved to `prisma-admin` |
| **W4D fix** | `e581407` | PR #283 — removed an unused `import type { Prisma }` the W4D codemod leaked into the business-memory evidence adapter, breaking the ratified IMPL-2 no-type-leak contract |
| **W4E-A** | `99c2caa` | Payments — 4 tables `p7w4ea_tenant` + `PaymentProviderRouting` bootstrap surface |
| **W4E-B-1** | `b1849db` | Tax Authority OAuth **trust repair** (no RLS) |
| **W4E-B-2** | `2e7e3b7` | Billing — 8 tables `p7w4eb2_tenant` + legal numbering proven under FORCE RLS |

Main has since moved on with unrelated feature work (Leads, adaptive UI). At time
of writing main was `2e87c5c`. **Always re-run the freshness gate.**

### Real defects found and fixed (not just policy work)

These matter because they were live bugs, not hypotheticals:

1. **W4D / #274 interaction** — the approved-mutation guard read `FinancialRecord`
   on the **global** client. Under FORCE RLS that returns null, so the guard never
   fired and recorded financial truth could be silently overwritten. Now
   tenant-scoped inside the tenant tx, with a 409 proof.
2. **W4E-A concurrency race** — two concurrent verified payment callbacks both
   passed the read-then-write duplicate check and created **two**
   `PaymentTransaction` rows plus a second `FinancialEvent`. Fixed with a DB
   unique `(provider, providerTransactionId)`; the migration **refuses to run**
   if legacy duplicates exist rather than guessing a winner.
3. **W4E-A silent-zero** — `payments.deps.ts` posted `FinancialEvent` on a bare
   `prisma.$transaction`; under FORCE RLS that posts **zero events in silence**.
4. **W4E-B-1 cross-tenant token binding** — the ITA OAuth callback took
   `businessId` from an **unsigned cookie** (the `state` cookie was CSRF-only and
   bound no identity), so a caller could have ITA token material persisted onto
   another tenant's connection. Two further gaps found while fixing it:
   `actorUserId` also came from a cookie yet is written to
   `oauthAuthorizedByUserId`, and pre-verification failures were attributed to
   the cookie's business — a forged cookie could mark **another tenant's**
   connection OAuth-failed.
5. **W4E-B-2 context-less transactions** — two Authority `runInTransaction`
   dependency ports carried **no businessId at all**, so they opened a
   transaction with no GUC that reads and writes nothing under FORCE RLS.

---

## 4. Canonical patterns to reuse (do not reinvent)

**Threading helpers** — one per domain, all the same shape:

```ts
// ctx-aware single DB step; NO global fallback under an established context
async function dbStep<T>(fn: (db: typeof prisma) => Promise<T>): Promise<T> {
  if (getTenantContext() !== undefined) {
    return withTenantTransaction((tx) => fn(tx as unknown as typeof prisma));
  }
  return fn(prisma);           // pure unit tests / offline scripts only
}
```

The `typeof prisma` parameter plus the cast is deliberate: a union of client
types collapses precise `select`/`include` payload types.

Existing instances: `lib/services/billing/billing-db-step.ts`,
`lib/services/billing/billing-tenant-tx.ts` (explicit businessId, fails loud
without one), plus per-file `dbStep` in the documents/payments layers.

**Bootstrap boundary** — for genuinely pre-context work, a *separately named*
helper (`bootstrapStep`) so "no global fallback" is auditable, with a CI guard
enforcing an allowlist of models it may touch. Canonical allowlist doc:
`docs/security-d2-provider-bootstrap-allowlist-v1.md`.

**Signed OAuth state** — `lib/services/integrations/gmail/signed-state.service.ts`
and `lib/services/billing/authority/billing-authority-signed-state.service.ts`.
HMAC-SHA256 over a **purpose-separated** key derived from `AUTH_TOKEN_SECRET`;
binds version, purpose, businessId, userId, (environment), nonce, iat, exp.
Cross-purpose rejection between the two envelopes is proven in both directions.

**Artifact split per wave** (three files):
1. canonical **role-free, idempotent, expand-only** Prisma migration (policies only);
2. per-environment **grants** (`:ROLE` placeholder; `app_admin` group literal is fine);
3. **rollback** that removes only that wave's policies/grants, never drops roles,
   and preserves all prior waves.

**Battery** (`.p7wXX/battery.mjs`): `BATTERY_TARGET=pg|neon`, a `VERIFY_ONLY`
read-only mode, drift gates on every prior wave's policy count, `$`-aware
`splitSql` (DO blocks are atomic), marker-based fixtures (`p7wXX-`) with a
workflow-level "fixnet" cleanup backstop, endpoint deny-list assertions.
**In the PG lab, install a pilot-EQUIVALENT policy on any protected parent** —
testing a parent-join policy against an unprotected parent proves nothing.

**Guard family**: `scripts/ci/w4-context-guard.sh`, currently
CI-W4-1..5 + W4B-1..3 + W4C-1..3 + W4D-1..5 + W4E-1..10 + W4EB1-1..5 +
W4EB2-1..18, with `--self-test` negative proofs — **46/46**. Runs as a
**blocking** step inside the wave battery workflows and CI-1.

---

## 5. Current policy state on Preview (verified read-only from main)

```
p4b_tenant   =  5   (pilot: Appointment, BillingDocument, Conversation, Customer, PaymentRequest)
p7w1_tenant  = 14   p7w2_tenant  = 24   p7w3_tenant  = 15
p7w4b_tenant =  5   p7w4c_tenant =  3   p7w4d_tenant =  8
p7w4ea_tenant=  4   p7w4eb2_tenant= 8
p7adm_read   = 10   (SELECT-only, admin group)
```

Synthetic residue: **0**. All prior substrate intact.

---

## 6. What remains — the security tail (READ-ONLY inventory, nothing started)

| Model / area | Class | Why it is not closed |
|---|---|---|
| **BusinessFeatureAccess** | PRIVILEGED ADMIN WRITE | Only writer is the platform-admin route, cross-tenant **by design** (`deleteMany` + `upsert` on another business). RLS would require **global admin writes**, breaking the read-only `app_admin` doctrine. Deferred three waves running. |
| **Offer / Coupon / RedemptionEvent** | CROSS-TENANT PRODUCT MODEL | `RedemptionEvent` has **two** owners (`issuingBusinessId`, `redeemingBusinessId`); cross-tenant writes *are* the feature; `publicId`/`token`/`qrValue` are designed for session-less resolution. Needs role-qualified policies + an explicit public-read surface. |
| **ProductUsageEvent** | DEFERRED SEMANTICS | `businessId` nullable conflates "never had a tenant" (pre-auth login failures) with "lost one" (`SetNull`). Recommendation: add an explicit `scope` discriminator first, then partial RLS. Its only consumers are platform-admin analytics still on the CI-4 legacy ratchet — migrate them to `prisma-admin` first or they silently zero. |
| **ContentFeedback, DerivationPolicy(+Version)** | TENANT RLS CANDIDATE | No direct `businessId`; ownership needs a parent mapping. Small future P7 slice. |
| **Conversation DELETE debt** | DEFERRED SEMANTICS | Account-deletion deletes Conversation but the runtime has no DELETE grant (pilot posture). Belongs to a privacy/erasure slice. |
| Platform*/BillingAuthorityApp | INTENTIONALLY GLOBAL | No `businessId` — control-plane data. |
| User, Business, POSApiKey, WhatsAppConnection, PaymentWebhookEvent, PaymentProviderRouting | BOOTSTRAP | Pre-context identity resolution; in the ratified allowlist. |

Full reasoning: `docs/d2-w4e-deferral-decision-memos-v1.md`.

**Recommended next objective**: *not* another P7 wave, but a dedicated
**privileged-write / control-plane architecture** task for `BusinessFeatureAccess`.
It is the single blocker that recurred in three consecutive waves. Options already
sketched: a narrow single-purpose capability; a SECURITY DEFINER function with
exact arguments; admin acting *as* the tenant (needs no new privilege); or an
explicit platform-owned entitlement model that is not tenant data at all.

---

## 7. How the owner runs these missions (working conventions)

- Each wave arrives as a **numbered mission** with explicit STOP conditions and a
  **required report format with an exact footer**. Follow the format literally.
- **Merges never happen inside an implementation mission.** They are a separate
  "FINAL MERGE GATE + CLOSURE" mission with its own freshness gate.
- **Freshness gate every time**: fetch origin/main, diff against the wave's
  surface, and reconcile *semantically* — never blindly rebase. Main moves fast
  (other people ship UI/features daily).
- **No stale green**: if the head changes for any reason, every relied-upon check
  is re-run on the new head.
- Chat responses in **Hebrew**; code, paths, and commit messages in English.
- Report honestly: distinguish **PASS** from **SAFETY-ABORT** (a test that
  deliberately refuses without `TEST_DATABASE_URL`) from **pre-existing baseline
  failure** from a **real** failure.

---

## 8. Traps that cost time in this session (read before touching anything)

- **`$?` after a pipeline ending in `| tail` is tail's exit code.** This produced
  a false "all green" once. Use `cmd >/dev/null 2>&1 || FAIL=...`.
- **The `verify:*` suite is not fully wired into CI.** Only 1 of 64 scripts ran in
  any workflow before #283; `release-ci-verify` is **report-only**
  (`continue-on-error` on every step) and its green means very little. Inventory:
  `docs/ci-verify-coverage-inventory-v1.md`. If a wave relies on a verifier, wire
  it into a **blocking** job.
- **DB-backed `verify:*` scripts need a real `.env` and a freshly generated Prisma
  client**, or they fail with misleading errors. Copy `.env` from the main
  checkout, run `npx prisma generate`, and **delete the copied `.env` afterwards**.
  They also fail intermittently when the whole directory runs in parallel against
  the shared dev DB — re-run standalone before calling a suite broken.
- **Codemods**: write them to `.cjs` files and run with `node` (Windows Git Bash
  heredocs mangle backslashes/regex). Always report misses; a codemod that dies
  mid-list silently skips everything after it. Always finish with a leftovers grep.
- **TS narrowing does not flow into a `dbStep` closure** — hoist consts before it.
- **`prisma format` reflows the whole schema.** Edit `schema.prisma` byte-exactly
  via `git cat-file -p` + `git hash-object -w` + `git update-index --cacheinfo`,
  and never run `prisma format` afterwards.
- **Injected imports land inside multi-line `import {` blocks** unless you insert
  after the last line ending in `;`.
- **`grep -q` treats `[]` as a character class** — `@@unique([businessId, ...])`
  needs `grep -qF`. And a migration **comment** naming a deferred table will trip
  a naive presence guard.
- **Neon pooler caches role OIDs** — never drop+recreate a role name; create once
  and rotate the password.
- **A failed `gh pr merge --delete-branch` can still have deleted the branch and
  closed the PR.** Verify the real state before "recovering".
- **Preview lags main.** Twice a battery needed a *guarded, expand-only* catch-up
  of an already-merged migration. Check for missing columns before assuming a bug.

---

## 9. Prohibited / rejected approaches

- **Never** grant `app_admin` INSERT/UPDATE/DELETE, `BYPASSRLS`, or ownership.
- **Never** protect a table whose live paths are not fully wired — a half-wired
  FORCE RLS turns a working module into a harder failure. (This is why W4E was
  split: Billing had 18/18 routes with no tenant context.)
- **Never** enable RLS on top of a broken trust boundary — it enforces the *wrong*
  tenant faithfully. (This is why B-1 came before B-2.)
- **Rejected**: a `SECURITY DEFINER` resolver over `PaymentRequest` for the payment
  webhook. It needs no new table but puts a privilege-escalation surface into the
  security substrate; a routing index with no business data does not.
- **Never** remove a legitimately required `DELETE` grant for aesthetics — prove it
  tenant-safe instead (W4E-B-2 needs it on three tables for draft replace-as-set).
- **Never** redesign legal document numbering. Semantics are frozen: upsert on
  `(businessId, documentType)`, `increment: 1`, allocated number = `nextNumber - 1`,
  inside the issuance transaction, no fiscal/annual dimension.

---

## 10. Exact next action

Nothing is in flight. No open PR, no branch awaiting work, no Preview mutation
pending. `feat/d2-p7-w4eb2` is merged and its remote branch deleted.

Start the next session by stating the objective. If it is the security tail, the
recommended first objective is the **BusinessFeatureAccess privileged-write
architecture decision** (§6) — a design task, not a P7 wave.

Relevant memory files (auto-loaded): `project_d2_tenant_isolation_design.md`
(the full wave-by-wave record) and `MEMORY.md` (index).
