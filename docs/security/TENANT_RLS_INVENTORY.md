# Tenant / RLS inventory (canonical)

This is the single record of which tables carry tenant data, how each is isolated, and every
exception. `scripts/ci/tenant-table-rls-guard.mjs` (R3) refuses any exemption or pending decision
that is not listed here by table name.

Baseline: `main` at `0b8ba15`, 151 Prisma models plus migration-only tables, audited 2026-09-29 in
the tenant/RLS closure milestone.

## How the inventory was built

The inventory was built mechanically.

1. Every model in `prisma/schema.prisma` was checked for a tenant key: a column named `businessId`
   or ending in `BusinessId`.
2. Ownership was propagated through required foreign keys, giving 143 tenant-owned models.
3. The final RLS state was computed by replaying every migration in order: ENABLE / FORCE (including
   NO FORCE), CREATE / DROP / ALTER POLICY, and app_runtime GRANT / REVOKE.
4. Every uncovered table's read, write, bootstrap, job and admin paths were then traced in the code.

`NO ACTIVE EXPOSURE PROVEN` and `DATABASE-ENFORCED TENANT ISOLATION` are recorded separately below.
They are not the same claim.

## The original failure (preserved)

M9 reported this correctly: the tenant-context closure battery (`.tcx/context-closure-battery.mjs`)
had failed on every branch since #551, with **9 `businessId` tables under no RLS**:

`User`, `WhatsAppConnection`, `POSApiKey`, `PaymentProviderRouting`, `ProductUsageEvent`,
`InventorySale`, `InventorySaleLine`, `InventorySourceSaleLine`, `BusinessAsset`.

The audit found the true gap was **wider** than 9. Four tables key on `issuingBusinessId`: `Offer`,
`Coupon`, `RedemptionEvent` and `CouponSurfaceEvent`. Both the RLS guard and the closure battery
recognised only a column literally named `businessId`, so those four had no RLS and **no guard could
see them**.

## Classification

| Class | Meaning | Tables |
|---|---|---|
| **A** | RLS + FORCE + tenant policy (database-enforced) | 131, listed below |
| **B** | RLS present but incomplete or incorrect | none found. `ContentVariant` looks like NO FORCE in a naive replay: the P0 backfill lifts FORCE and restores it on every path, including its exception handler. Its legacy policy is FOR ALL on an indirect key (R2 covers only new tables). |
| **C** | tenant-owned, RLS absent, fixable now | **repaired by this milestone:** `InventorySale`, `InventorySaleLine`, `InventorySourceSaleLine`, `BusinessAsset`, `CouponSurfaceEvent` |
| **D** | legitimately pre-tenant, or not tenant data | see *Exceptions (D)* |
| **E** | tenant-owned with no database isolation; the design needs an owner decision | see *Pending owner decision (E)* |

### A: database-enforced (131)

Isolation comes from the table's own tenant key, or through its parent (22 child tables, for example
`ExtractedData` via `Document`, `PaymentTransaction` via `PaymentRequest`, `ContentRender` via
`ContentVariant`).

`Appointment`, `BillingAuditEvent`, `BillingAuthorityConnection`, `BillingAuthoritySubmission`, `BillingDocument`, `BillingDocumentLine`, `BillingDocumentNumberSequence`, `BillingPaymentAllocation`, `BillingReceiptPayment`, `BotGoalSelection`, `BusinessAsset`, `BusinessBankAccount`, `BusinessBot`, `BusinessBotKnowledge`, `BusinessBotLearningSuggestion`, `BusinessBotMemoryPolicy`, `BusinessBotProfile`, `BusinessBotRecommendation`, `BusinessBotSettings`, `BusinessBotSetupDraft`, `BusinessFeatureAccess`, `BusinessInsight`, `BusinessObligation`, `BusinessObligationOrientation`, `BusinessPaymentConnection`, `BusinessProfile`, `BusinessService`, `Cheque`, `CollaborationDeal`, `CollectionAction`, `Commitment`, `ContentEvent`, `ContentRender`, `ContentRun`, `ContentVariant`, `Conversation`, `CouponSurfaceEvent`, `CrmAttachment`, `CrmNote`, `Customer`, `Deal`, `DerivedClaimCandidate`, `DerivedClaimEvidenceLink`, `DerivedClaimProjection`, `Document`, `EmailAttachmentImport`, `EmailConnection`, `EntityLinkProposal`, `ExternalTransaction`, `ExternalTransactionMatchRejection`, `ExtractedData`, `ExtractionEvidence`, `ExtractionSnapshot`, `FinancialDocument`, `FinancialEvent`, `FinancialRecord`, `HistoricalFiscalDocument`, `ImportRun`, `ImportRunRow`, `InboundEmailAddress`, `InboundEmailAttachmentImport`, `InboundEmailAuthorizedSender`, `InboundEmailMessage`, `InboundEmailSenderChallenge`, `Installment`, `InstallmentWorkflow`, `IntakeEvent`, `InventoryAlert`, `InventoryCategory`, `InventoryDraft`, `InventoryExternalSale`, `InventoryItem`, `InventoryMovement`, `InventoryPendingMatch`, `InventorySale`, `InventorySaleLine`, `InventorySourceSaleLine`, `KnowledgeMeasure`, `KnowledgeMeasureEvidenceLink`, `Lead`, `LearningEvent`, `LearningSignal`, `Message`, `MessageAnalysis`, `Notification`, `NotificationDelivery`, `OAuthToken`, `OutboundExecution`, `OutcomeActionEvent`, `OutcomeAssessment`, `OutcomeDecision`, `OutcomeObservation`, `OutcomeRecommendation`, `POSProductMapping`, `Party`, `PartyResolutionClaim`, `PayablesAuditEvent`, `PayablesMatchRejection`, `Payee`, `Payment`, `PaymentAccountingSettlement`, `PaymentAllocation`, `PaymentAuditEvent`, `PaymentDestination`, `PaymentEvidence`, `PaymentPreparation`, `PaymentRequest`, `PaymentTransaction`, `PricingCalculation`, `PricingProfile`, `PricingRecommendation`, `PurchaseOrder`, `PurchaseOrderLine`, `ReceivingLine`, `ReceivingSession`, `Recommendation`, `RecommendationOutcome`, `ReplySuggestion`, `ReviewEvent`, `RiaCanonicalReferent`, `RiaPolicyLineage`, `ServiceCostProfile`, `SliceDecision`, `Supplier`, `SupplierPurchaseDraft`, `SupplierPurchaseDraftLine`, `Task`, `TemporalKnowledge`, `Usage`, `VendorLearning`, `WhatsAppAttachmentImport`.

Migration-only tables that have no Prisma model yet are held to the same bar by guard rule R0 (for
example the P1 offering tables, which ship their own RLS).

### C: repaired by `20260929090000_tenant_rls_closure`

| Table | Tenant key | Policies (per command) | Runtime grant | Before |
|---|---|---|---|---|
| `InventorySale` | `businessId` | SELECT, INSERT | SELECT, INSERT | no RLS; hand grant in `scripts/security/d2-p7-wave3-grants.sql` |
| `InventorySaleLine` | `businessId` | SELECT, INSERT | SELECT, INSERT | no RLS; hand grant |
| `InventorySourceSaleLine` | `businessId` | SELECT, INSERT, UPDATE | SELECT, INSERT, UPDATE | no RLS; hand grant |
| `BusinessAsset` | `businessId` | SELECT, INSERT | SELECT, INSERT | no RLS; **no grant at all** (default privileges: arwd) |
| `CouponSurfaceEvent` | `issuingBusinessId` | SELECT, INSERT | SELECT, INSERT | no RLS; invisible to every guard |

- DELETE and TRUNCATE are revoked on all five, and UPDATE is revoked wherever the application never
  updates.
- Parent/child tenant integrity was **already** database-enforced by the composite `(id, businessId)`
  foreign keys these tables were created with. No backfill or row rewrite is needed.

Code changes made first, so that FORCE cannot break a legitimate flow:
- `BusinessAsset`'s service ran on the global client with no tenant GUC. It now runs inside
  `tenantTx(businessId)`.
- The public coupon page's surface-event write now runs inside `tenantTx(issuingBusinessId)`. The
  issuer is resolved from the coupon row, never from the request.

### D: exceptions (legitimately pre-tenant, or not tenant data)

| Table | Why no tenant RLS | Protection instead |
|---|---|---|
| `User` | auth plane: read by email or token before any tenant exists | column-level grants (`20260908180000_d2_user_business_privilege_narrowing`); `password` readable only by `app_auth` |
| `WhatsAppConnection` | provider bootstrap: `phone_number_id` → business (`docs/security-d2-provider-bootstrap-allowlist-v1.md`) | unique-key lookup, one sanctioned module, token AES-GCM with `businessId` as AAD |
| `POSApiKey` | provider bootstrap: SHA-256 of the POS key → business | hash-only storage; SELECT/UPDATE grant |
| `PaymentProviderRouting` | provider bootstrap: provider reference / callback secret → business; the routing row is a hint re-verified under the routed GUC | routing columns only; no DELETE |
| `PaymentWebhookEvent` | pre-tenant landing log of raw provider events; no tenant column | bootstrap allowlist; not tenant-readable |
| `AuthSession`, `AuthSessionSecret` | per-user auth plane, no tenant | all `app_runtime` privileges revoked; `app_auth` column grants (`20260908200000`) |
| `PlatformAdminMfa`, `PlatformAuditEvent` | platform plane, not tenant data | **see findings:** reached through the tenant runtime client, so grant hardening is owed |
| `Business` | the tenant root | read at login and signup, before a tenant exists |
| `PlatformFeatureDefinition`, `PlatformFeaturePolicy`, `BillingAuthorityApp`, `DerivationPolicy`, `DerivationPolicyVersion` | global configuration and catalogues | no tenant data |

### E: pending owner decision (tenant-owned, **no database isolation yet**)

| Table | Why it cannot simply be FORCE-RLS'd | Decision needed |
|---|---|---|
| `Offer` | issuer-owned, but the **unauthenticated** marketplace and coupon pages read it | a public-read design: additive column-restricted policy, or a public projection |
| `Coupon` | redeemed by **another** business by bearer token, and read by `publicId` on public pages | the repo's bootstrap pattern: a narrow routing table `token/publicId → coupon, issuer`, then work under `tenantTx(issuer)`; adding it to the bootstrap allowlist is an architecture decision |
| `RedemptionEvent` | two-tenant row (`issuingBusinessId` and `redeemingBusinessId`) | policy shape: SELECT for issuer OR redeemer; INSERT by the redeemer for another tenant's coupon |
| `ProductUsageEvent` | platform telemetry with a **nullable** `businessId` (pre-auth and registration rows) | split pre-tenant rows out, or a policy that admits NULL-business inserts; move admin reads to the admin client |
| `ContentFeedback` | no tenant key and no reader or writer at all | drop it, or add `businessId` before any reuse |

Application-level safety today, from the trace (not database-enforced):
- every owner mutation re-checks the issuer against the session;
- the coupon secret is never in public DTOs;
- redemption refuses self-redemption.

## Tenant context (runtime)

**How the GUC is set**
- The GUC is set **transaction-locally**: `set_config('app.current_business_id', $1, true)` inside
  `withTenantTransaction`. It resets at commit or rollback, so a pooled connection cannot carry a
  stale tenant.
- The value is parameterized and never set at session level.

**How isolation holds**
- Missing context: under FORCE RLS reads return zero rows, and writes fail WITH CHECK.
  `withTenantTransaction` throws a `TenantContextError` with no context, and `tenantTx` refuses a
  non-positive id.
- Switching tenant inside an established context is refused
  (`refusing to switch tenant context inside an established context`).
- Jobs use `runTenantJob` or per-business `tenantTx`. The crons (settlement recovery, reconciliation,
  intake sweep) iterate business ids and open one tenant transaction per business.
- No application path uses an owner or BYPASSRLS connection. The admin, auth and control-plane
  clients are separate NOBYPASSRLS roles, and each fails loudly when unconfigured.

**Findings, not changed in this milestone**

| Finding | Classification |
|---|---|
| 16 `dbStep` helpers fall back to the global client when no context is set, returning silent empty results | fix: make them throw |
| Nested `withTenantTransaction` opens a second top-level transaction | fix: an ALS guard |
| `POSApiKey` erasure DELETEs, but the hand grant has none | verify the Production grant |
| The legacy POS env-secret comparison is not constant-time | fix |
| `PlatformAuditEvent`, `PlatformAdminMfa` and one platform-usage read use the tenant runtime client | move to the admin plane and revoke |
| `/api/knowledge/derive` accepts any `businessId` with `CRON_SECRET` | owner review |
| The execution status of `20260908180000`, and the default `AUTH_PLANE_ENABLED` | owner review |
| The public coupon page reads the issuer's `BusinessProfile` through the global client, so FORCE RLS returns no profile (a **product bug, not a leak**) | fix |
| `recordInventorySourceSaleLines` swallows a unique violation inside a transaction. Postgres aborts the transaction, so a same-transaction replay fails its later queries (a **product defect in the POS retry path**, found by the closure battery, unrelated to RLS) | fix: savepoint, or `createMany({ skipDuplicates })` |

## Guard (systemic fix)

**How the hole happened**
- The P0 tables were merged as migration-only (#544) three hours **before** the RLS guard existed.
- The guard evaluated **schema models**, so a migration-only PR had nothing to check.
- When the models arrived (#551), the tables were **exempted inside the same PR they unblocked**.
- Separately, only a column named exactly `businessId` counted as a tenant key.

**What `tenant-table-rls-guard.mjs` now enforces** (25 self-tests, each rule proven able to fail)
- Every `…BusinessId` column is a tenant key.
- **R0** checks tenant tables from the migrations' own `CREATE TABLE` statements, model or not.
- `PENDING_OWNER_DECISION` is separate from `EXEMPT`, printed on every run, and ratcheted.
- **R3** requires every exception to appear in this document.

The closure battery (`.tcx/context-closure-battery.mjs`) is unchanged. Its rule is at most the five
deliberate uncovered `businessId` tables. After the closure, exactly those remain: `User`,
`WhatsAppConnection`, `POSApiKey`, `PaymentProviderRouting` and `ProductUsageEvent`.

## Related records

- Security follow-up register: [SECURITY_FOLLOWUP_REGISTER.md](SECURITY_FOLLOWUP_REGISTER.md). It includes the high-priority `/api/knowledge/derive` authority finding.
- Architecture proposal for the five pending tables: [PENDING_TENANT_TABLES_ARCHITECTURE.md](PENDING_TENANT_TABLES_ARCHITECTURE.md).

## Production preflight (run 36508953537, 2026-09-29, read-only)

**Runtime:** `app_runtime_prod`, NOSUPERUSER, NOBYPASSRLS, a member of `app_runtime`.

**The five tables hold 0 rows in Production.** So:
- there are 0 NULL or orphan tenant keys;
- every child/parent tenant-agreement count is 0;
- the runtime currently holds SELECT, INSERT, UPDATE and DELETE on all five, with RLS off. That is the gap the migration closes.

**ContentVariant:** RLS + FORCE confirmed live, 45 rows across 3 businesses, 0 parent mismatches.

**Pending `Coupon → Offer` issuer mismatches:** 0.

## Proof

- Lab battery: `.m0/tenant-rls-closure-battery.ts`, as a measured NOSUPERUSER + NOBYPASSRLS role on
  the shipped migration.
- Production proof (2026-09-29), all as `app_runtime_prod` (NOSUPERUSER, NOBYPASSRLS, a member of
  `app_runtime`):
  1. **Deployment order held.** #572 (`2e4c063`) was first refused by the Vercel quota. It reached
     Production through the normal deploy of `a9c6892` (#571), which contains it and both writer
     changes. Only then was #573 merged (`3f3a023`).
  2. **Migration.** `release-migrate` run 36518805858 applied exactly
     `20260929090000_tenant_rls_closure`, byte-identical to the reviewed file.
  3. **Post-migration read-only proof, run 36596361224.** An earlier identical run, 36519348274, failed
     with a transient client error and passed on re-run.
     - All five tables: RLS **and FORCE** on.
     - Policies exactly as designed: SELECT and INSERT, plus UPDATE only on
       `InventorySourceSaleLine`, with no FOR ALL.
     - Runtime privileges now equal the application's authority: no DELETE anywhere, no UPDATE except
       source lines. Before the migration the runtime held SELECT, INSERT, UPDATE and DELETE on all
       five.
     - **Zero rows visible without a tenant.** Integrity counts are all 0.
  4. **The tenant-context closure battery passes:** 108 of 113 tenant tables under RLS, with the five
     deliberate uncovered tables remaining.
  5. **What Production did not prove.** The five tables hold 0 rows, so cross-tenant read and write
     refusals and the product flows are proven in the lab battery (42/42) against the identical DDL,
     not by Production writes. No Production row was created for proof.
