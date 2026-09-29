# Proposal: database-level isolation for the five owner-decision tables

**Status: PROPOSAL, not implemented.** `Offer`, `Coupon`, `RedemptionEvent`, `ProductUsageEvent` and
`ContentFeedback` stay `PENDING_OWNER_DECISION` in `scripts/ci/tenant-table-rls-guard.mjs` until the owner
approves an architecture.

**Principle.** Public or bearer access must be an **explicit, narrow path**. It must never be the
**absence of RLS** on a tenant table. Every tenant table gets ENABLE + FORCE RLS and per-command
policies. Anything public reads a purpose-built surface that contains only what is meant to be public.

**Repo doctrine this follows**
- `docs/security-d2-provider-bootstrap-allowlist-v1.md`: a narrow, non-RLS routing table keyed on a
  unique identifier, with one sanctioned reader.
- `20260830120000_d2_p7_w4ea_payments_tenant_rls`: a SECURITY DEFINER resolver was **rejected** there as
  a privilege-escalation surface, in favour of a routing table.

So this proposal also prefers routing and projection tables to DEFINER functions.

## 1. `Offer`: issuer-owned; publicly *listed*

**Access today**
- The issuer creates, lists and edits it (session).
- The **unauthenticated** marketplace and coupon pages read title, benefit, description, image and
  validity, plus issuer profile fields.

**Proposal**
- **Tenant table.** `Offer` gets ENABLE + FORCE RLS on `issuingBusinessId`:
  - SELECT, INSERT, UPDATE for the issuer;
  - no DELETE (unpublish is a state).
- **Publication projection** `PublicOfferListing`:
  - Columns: `publicId` (UUID), title, benefit text, image, `validUntil`, and issuer **display** fields
    only (name, city, category, opening hours).
  - **Excluded:** billing phone and address (see register H2), `offer.id`, `business.id`, and exact
    coordinates. The model carries at most a coarse geo cell, so distance can only be returned as a band.
  - Written by the issuer's own tenant transaction when it publishes; deleted or updated on unpublish or
    expiry.
  - Runtime: SELECT on it for public pages. INSERT, UPDATE and DELETE only through a tenant-scoped
    policy (`issuingBusinessId = GUC`).
- **Revocation** is immediate: unpublishing removes the listing row.
- **Enumeration resistance:** UUID `publicId`; the marketplace list is paginated and bounded; no
  sequential ids are exposed.
- **Least privilege:** the public never touches `Offer`.

**Alternative (weaker, not recommended):** an additive public SELECT policy on `Offer` limited to active
rows, plus column grants. It still exposes the tenant table's row existence.

## 2. `Coupon`: issuer-owned; **bearer capability** for redemption

**Access today**
- Created by the issuer.
- Redeemed by **another** business presenting the bearer `token` (a UUID in the QR code).
- The public page is keyed by `publicId`.
- The raw `token` is stored in the table and is globally unique.

**Proposal**
- **Tenant table.** `Coupon` gets ENABLE + FORCE RLS on `issuingBusinessId`:
  - SELECT, INSERT, UPDATE for the issuer;
  - no DELETE.
  - A composite FK `(offerId, issuingBusinessId) → Offer(id, issuingBusinessId)` closes the current
    app-only issuer check. The Production preflight measured 0 mismatches today.
- **Capability table** `CouponCapability`, following the bootstrap-allowlist pattern:
  - Columns: `tokenHash` (SHA-256, unique), `couponId`, `issuingBusinessId`, `expiresAt`, `revokedAt`.
  - No RLS, justified as a bootstrap table and added to the allowlist doc.
  - Runtime SELECT **only by `tokenHash` equality** from one sanctioned module. It stores **no raw
    token**, so a table read cannot mint redemptions.
  - Written by the issuer's tenant transaction at issue time. Revocation sets `revokedAt`.
- **Redemption flow**
  1. Hash the presented token and look up the capability. Refuse if revoked or expired.
  2. `tenantTx(issuingBusinessId)`: lock the coupon, check the state, mark it redeemed.
  3. Insert the `RedemptionEvent` (section 3).

  The redeeming business comes from the **session**, never from the token.
- **The public page** reads `PublicOfferListing` by `publicId`, never `Coupon`.
- **Migration of existing tokens:** backfill `tokenHash` from `token`, then stop reading `token`. Whether
  to rotate existing QR codes is an owner decision.

## 3. `RedemptionEvent`: **dual-tenant**

**Access today**
- One row per redemption, holding `issuingBusinessId` and `redeemingBusinessId`.
- Inserted by the redeemer's request.
- The issuer reads it (my coupons).
- The public marketplace reads aggregate counts.

**Proposal**
- ENABLE + FORCE RLS with two policies:
  - SELECT `USING (issuingBusinessId = GUC OR redeemingBusinessId = GUC)`: each party sees its own
    side.
  - INSERT `WITH CHECK (issuingBusinessId = GUC AND redeemingBusinessId = current_setting('app.redeeming_business_id')::int)`.
    It is inserted inside the issuer's redemption transaction. Server code sets the second GUC from the
    redeemer's **session**, so neither party alone can fabricate the other side.
- No UPDATE and no DELETE: the table is append-only and should get the SEC-F-style guard.
- **Public popularity counts** come from a per-offer counter on `PublicOfferListing`, maintained in the
  same issuer transaction. The public never reads `RedemptionEvent`.
- **Audit:** each redemption writes an audit event into both tenants.

## 4. `ProductUsageEvent`: platform telemetry, nullable business

**Access today**
- Written best-effort from login, logout, register, documents and data-transfer, often **before** any
  tenant exists (so `businessId` is NULL).
- Read only by platform-admin overviews, currently through the tenant runtime client (register T3).
- Tenants never read it.

**Proposal: telemetry is write-only for the runtime**
- ENABLE + FORCE RLS.
- INSERT policy `WITH CHECK (businessId IS NULL OR businessId = NULLIF(current_setting('app.current_business_id', true), '')::int)`.
  A pre-login event can be written with no business; an authenticated event only for the caller's own
  business.
- **No SELECT for `app_runtime` at all.** SELECT goes to `app_admin` through the admin client, with a
  `p7adm_read` policy.
- No UPDATE and no DELETE.
- Writers inside tenant flows move to `tenantTx`. Pre-login writers stay context-less and insert only
  NULL-business rows.

**Alternative:** split into `PlatformUsageEvent` (no `businessId`) and tenant-scoped usage events. It is
cleaner, but migrates more code.

## 5. `ContentFeedback`: dead

**Facts**
- No tenant key, no FKs.
- Free-text `hook`, `idea` and `script` columns.
- **No reader or writer anywhere** in `app`, `lib`, `features` or `scripts`.
- The historical cross-tenant `/api/learning` route that used it no longer exists.

**Proposal**
1. Measure its Production row count read-only.
2. If it is 0, **drop the table.**
3. If it is not 0, **archive then drop.** Unowned free text cannot be erased per tenant.

Any future feedback feature must be a new tenant-keyed table with RLS from its first migration (guard R0
now enforces this).

## Common properties of the proposal

| Property | How it is met |
|---|---|
| Authenticated tenant access | FORCE RLS, per-command policies on the tenant key |
| Anonymous / public access | purpose-built projection (`PublicOfferListing`), approved columns only |
| Bearer capability | hashed capability table with a unique-key lookup, one reader, expiry and revocation |
| Dual tenancy | an OR'd SELECT policy, and an INSERT requiring both tenants from server-derived GUCs |
| Pre-login events | NULL-business INSERT only; no runtime SELECT |
| Dead tables | measured, then dropped |
| SECURITY DEFINER | not used, per repo doctrine; routing and projection tables instead |
| Enumeration resistance | UUID public ids, hashed tokens, bounded pagination, coarse distance |
| Tenant integrity | composite `(id, tenant)` FKs, including a new `Coupon → Offer` FK |
| Auditability | redemption audited into both tenants; capability revocation is a recorded state |

Each item becomes its own migration-first release with a restricted-role battery. Nothing here is
implemented until the owner approves it.
