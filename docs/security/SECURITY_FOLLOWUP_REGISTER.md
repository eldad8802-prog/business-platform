# Security follow-up register

Findings from the tenant/RLS closure audit (2026-09-29). None of them is fixed by the closure migration,
which is deliberately limited to its five tables. Each entry says what is **proven**, what is
**inferred**, and what decision or fix it needs.

## HIGH PRIORITY — owner review

### H1. `/api/knowledge/derive`: one shared machine secret grants cross-tenant write authority, with no second boundary

**What is proven, from the code (`app/api/knowledge/derive/route.ts`)**

- **Authentication.** It is `decideRecoveryAuth` only: a `CRON_SECRET` bearer, constant-time,
  ≥ 32 characters, failing closed when unset. This part is sound.
- **Scope of that one secret.** `CRON_SECRET` is shared by four routes:
  - settlement recovery;
  - reconciliation;
  - the intake sweep;
  - knowledge derive.

  It lives in the Vercel environment **and** as a GitHub repository secret, readable by any workflow in
  the repository.
- **Tenant choice.** The tenant comes from the query string (`?businessId=`). Nothing else is checked:
  - no server-authoritative mapping from the caller to that business;
  - no allowlist;
  - no per-business authorization.
- **No lifecycle gate.** The derive path calls neither `runTenantJob` nor
  `assertBusinessAcceptsWrites`. It uses `runWithTenantContext` and `tenantTx` directly, so **a business
  in account-deletion quarantine can still be derived**.
- **No invocation audit and no rate limit.** `maxDuration` is 120 s per call.

**What a holder of `CRON_SECRET` can do for ANY tenant id**

- **Write derived rows:** `KnowledgeMeasure`, `TemporalKnowledge`, `BusinessInsight`, identity
  `EntityLinkProposal` / `PartyResolutionClaim` projections, and M9 `OutcomeRecommendation` /
  `OutcomeActionEvent` / `OutcomeObservation` / `OutcomeAssessment`.
  - The **content** is deterministic from that tenant's own evidence. The caller cannot inject values.
    This is write *authority*, not write *content*.
- **Trigger a Brain shadow run** (`?brain=shadow`): that tenant's minimized context (aliases, no money,
  names or ids) is sent to OpenAI, at a cost of up to 1,200 output tokens per call.
- **Receive the response:** counts, rule and version codes, and isolation facts. It carries **no
  business values**, so **no cross-tenant data is disclosed through the response**.

**Threat classification**

Privileged machine credential → cross-tenant **write and processing authority** without a
server-authoritative second boundary. The consequences:

1. **Account-deletion quarantine bypass.** New derived rows can be written for a business whose owner
   asked for deletion, and its knowledge can be sent to the model provider. This is a concrete erasure
   and privacy defect, not hypothetical.
2. **Cost and load amplification** across all tenants, with no rate limit.
3. **Blast radius.** Leaking one secret (any workflow, any log mishap) grants payment-recovery,
   reconciliation, intake and derive authority together.

It is **not** a cross-tenant read or exfiltration path.

**Proposed fixes (not implemented; they need owner approval)**

- Gate derive on `assertBusinessAcceptsWrites`. This is a small, clear fix; it could ship immediately.
- A dedicated `KNOWLEDGE_DERIVE_SECRET`, separate from payment secrets.
- An invocation audit row per call: business id, caller workflow run id, brain flag.
- A per-business and global rate limit.
- Optionally, only accept calls whose GitHub OIDC token proves the `knowledge-derive.yml` workflow on
  `main`.

### H2. The public marketplace exposes issuer contact data and a precise caller-derived distance

**What is proven**

- `app/api/revenue/coupons/active` and the public coupon details page are **unauthenticated**.
- `active-coupons.service.ts` returns the issuer's `billingAddress`, `billingPhone`, `openingHours`,
  category, business model, `offer.id` and `business.id`.
- It returns an exact `distanceKm` computed from caller-supplied `lat` / `lng`. Repeated queries from
  different points allow **trilateration** of the business's stored coordinates.

**Decision needed**

- Should billing contact data be public at all?
- Should distance be coarse, for example a band or a rounded bucket?

The pending-tables proposal below routes public reads through an explicit publication projection that
would carry only the approved fields.

## TENANT HARDENING

| # | Finding | Proven where | Proposed fix |
|---|---|---|---|
| T1 | 16 `dbStep` helpers `return fn(prisma)` when no tenant context is set: a silent empty result instead of an error | e.g. `lib/services/payments/payment-store.prisma.ts:197`, `lib/documents/pending-review.ts:9`, `lib/reports/accountant-export-zip.ts:11` (full list in the audit notes of `TENANT_RLS_INVENTORY.md`) | throw `TenantContextError`, like `lib/business-status/loaders.ts` does |
| T2 | Nested `withTenantTransaction` / `tenantTx` for the **same** tenant opens a second top-level transaction on another pooled connection. The inner one commits independently and can exhaust the pool. Switching tenant **is** refused. | `lib/tenant/transaction.ts` header ("Do NOT nest") | an AsyncLocalStorage "in tenant transaction" flag that refuses nesting |
| T3 | `PlatformAuditEvent` and `PlatformAdminMfa` are reached through the **tenant runtime client**, so `app_runtime` holds privileges on platform-plane tables. One platform-usage read also uses it. | `lib/auth/admin-mfa.service.ts`, `platform-audit.service.ts:65-92`, `platform-usage-overview.service.ts:130` | move to the admin / control-plane clients; revoke `app_runtime`; add the SEC-F append-only guard to `PlatformAuditEvent` |

## OTHER SECURITY / HARDENING

| # | Finding | Status |
|---|---|---|
| O1 | POS key erasure runs `DELETE`, but the hand grant script gives `POSApiKey` SELECT and UPDATE only | **Production preflight:** `app_runtime_prod` **does** hold DELETE (default privileges), so erasure works today. The script and the effective state disagree. Record the grant in a migration. |
| O2 | The legacy POS env-secret fallback compares with `!==`, which is not constant-time (`app/api/inventory/pos/sale/route.ts:114-127`) | remove the fallback, or use `timingSafeEqual` |

## PRODUCT DEFECTS (found by the audit, not security)

| # | Finding | Proposed fix |
|---|---|---|
| P1 | `recordInventorySourceSaleLines` swallows a unique violation **inside** a transaction. Postgres aborts the transaction, so later queries in it fail (the POS retry path). Found by the closure battery. | `createMany({ skipDuplicates: true })` or a SAVEPOINT |
| P2 | The public coupon page reads the issuer's `BusinessProfile` through the global client. Under FORCE RLS the profile comes back empty. | read it inside `tenantTx(issuer)` or through the publication projection |
