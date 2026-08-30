# D2 / W4E — deferral decision memos (v1)

Reconnaissance only. Nothing in this document was implemented. Written during
W4E-A so the four things W4E-A deliberately did **not** protect are recorded
with evidence rather than left as folklore.

---

## 1. ProductUsageEvent — DEFERRED

### Why `businessId` is nullable

`ProductUsageEvent.businessId Int?` with `onDelete: SetNull`, alongside a
nullable `userId` and a `sessionId`. Two independent reasons force the null:

1. **Pre-tenant events exist by construction.** The producer that makes this
   unavoidable is `app/api/auth/login/route.ts`: `recordLoginFailure` fires for
   a failed login, where the business is frequently unknown — an unrecognised
   email has no tenant at all. A telemetry row for "someone failed to log in"
   is real and useful, and it has no owner.
2. **`SetNull` on business deletion.** A deleted business's usage rows survive
   with `businessId = NULL`, so nulls also accumulate historically.

So `NULL` today means **"no tenant is known for this event"**, and it conflates
two distinct cases: never-had-one (pre-auth) and lost-one (post-erasure).

### Producers and consumers

- **Producers**: `lib/services/product-usage/record-product-usage-event.ts`,
  called from auth login and documents upload among others. `businessId` comes
  from `input.businessId ?? null`, and callers pass a **server-derived** value
  (session/actor), not a request field.
- **Consumers**: only platform-admin analytics —
  `platform-usage-overview.service.ts` and `platform-business-detail.service.ts`,
  both still on the tenant Prisma client under the documented **CI-4 legacy
  ratchet**. There is no tenant-facing consumer at all.

### Can a client influence `businessId`?

Not through the reviewed producers: every call site passes a server-derived
actor. This was not exhaustively proven across all producers, because the model
is out of W4E scope — it must be re-proven before any RLS decision.

### Do tenant and platform events coexist?

Yes, in one table: tenant-attributed feature usage and tenant-less auth events
share the same rows and the same consumers.

### Recommendation

**Option B — explicit event scope — then C.** Add a non-nullable `scope`
discriminator (`TENANT` | `PLATFORM`) that says what a row *is*, instead of
inferring it from a null. Only then can a partial RLS architecture be correct:
a policy of the shape `scope = 'TENANT' AND businessId = GUC` is enforceable and
readable, whereas a bare `businessId = GUC` silently hides every platform row
and a `businessId IS NULL OR businessId = GUC` policy leaks every tenant-less
row to every tenant.

Rejected: **A (split model)** duplicates the write path for one column;
**D (application predicates only)** is what exists today and is exactly what the
D2 programme is removing; **E (future migration)** is not a design.

Sequencing note: the platform-admin consumers must move to `prisma-admin`
(closing their CI-4 ratchet entries) *before* RLS, or the analytics silently
zero out — the same failure mode W4D found and fixed in learning-center.

---

## 2. Marketplace: Offer / Coupon / RedemptionEvent — DEFERRED

### Relationship graph (from the schema)

```
Offer   { issuingBusinessId }                  -- NOT "businessId"
  |
  +-- Coupon { offerId, issuingBusinessId, token @unique, qrValue @unique,
  |            publicId @unique }
        |
        +-- RedemptionEvent { couponId @unique,
                              issuingBusinessId,
                              redeemingBusinessId }   -- TWO owners
```

### Why ordinary single-tenant RLS is not appropriate

1. **Two legitimate owners on one row.** `RedemptionEvent` carries both
   `issuingBusinessId` and `redeemingBusinessId`. The canonical predicate
   `businessId = GUC` cannot even be written here: the column does not exist,
   and *both* businesses have a real claim to see the row. The issuer needs it
   for redemption analytics; the redeemer needs it as proof of its own benefit.
   A correct policy is a disjunction over two roles — a different policy shape
   from every wave shipped so far.
2. **Cross-tenant writes are the product.** Redemption is business B consuming
   business A's coupon. The write legitimately crosses the tenant boundary. A
   `WITH CHECK (businessId = GUC)` predicate would forbid the feature's central
   action.
3. **Public visibility is intended.** `Coupon.publicId`, `token`, and `qrValue`
   are globally unique handles designed to be resolved by a party with no
   session at all — a consumer scanning a QR code. Offers are browsed across
   businesses by design (the ratified marketplace direction). That is a
   published surface, not a tenant-private one, and it needs a *visibility*
   model, not a tenancy predicate.
4. **The column name is not the convention.** `issuingBusinessId` rather than
   `businessId` means even the mechanical parts of the wave tooling (policy
   templates, CI shape guards, battery gates) assume something untrue here.

### Recommendation

Marketplace needs its own policy architecture — role-qualified predicates
(issuer vs. redeemer), an explicit public-read surface, and a decision on where
anonymous coupon resolution runs (bootstrap surface vs. sanctioned public
reader) — before any RLS is applied. Wave 5/6 policy work, not a tenant wave.

---

## 3. Tax Authority (ITA) OAuth — BLOCKED FROM W4E-A, owned by W4E-B

`app/api/taxes/oauth/callback/route.ts` derives the tenant from a
**`businessId` cookie**, and validates a separate `state` cookie against the
query `state` with `timingSafeEqual`. That state check is CSRF protection only:
it proves the two values match, not that either is bound to a business. Both
values are the caller's own cookies, so the identity the callback persists
against is caller-controlled, while the value it protects — an ITA
authorization token — is exactly the kind of credential that must not be
bindable to another tenant.

This is structurally the same defect W4A found and fixed for Gmail, and the fix
already exists in this codebase as a proven pattern: a signed state envelope
(HMAC over an `AUTH_TOKEN_SECRET`-derived purpose key) that binds
businessId + userId + purpose + expiry, with the callback taking its tenant
**only** from the verified envelope.

Putting `BillingAuthorityConnection` under FORCE RLS before that fix would
harden the wrong thing: the RLS predicate would faithfully enforce whatever
tenant the untrusted cookie named. **The trust handoff must be fixed first**;
then the authority tables can be protected. W4E-B.

---

## 4. BusinessFeatureAccess — BLOCKED FROM W4E-A, owned by W4E-B

Writes come from exactly one place:
`app/api/platform-admin/businesses/[id]/features/[featureKey]/route.ts` →
`updateBusinessFeatureAccess`, which performs `deleteMany` and `upsert` against
**another** business's rows. Reads are mixed: tenant runtime paths
(`require-feature-access`, `resolve-feature-access`) read a business's own
entitlements, while platform admin reads and writes across all of them.

Tenant RLS on this table would therefore require **global admin writes**, which
exceeds the ratified `app_admin` **read-only** doctrine (`p7adm_read` is
`FOR SELECT` only, by design, across every wave). Per the W4E failure policy
this is a STOP-and-classify, not a grant widening.

W4E-B must decide the privileged-write architecture first. Options worth
weighing: a separate write-capable admin role with its own audited policy set;
moving entitlement writes behind a service that assumes the target tenant's
context (admin acting *as* the tenant, which needs no new privilege); or an
explicit platform-owned entitlement model that is not tenant data at all.
