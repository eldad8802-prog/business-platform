# P2 — Business Identity + Positioning Foundation (v1)

Status:
- **Schema:** live in Production. Migration `20261004090000_p2_business_identity` was merged in #601 and applied by release-migrate run 36951977443.
- **Production evidence:**
  - #614's 13-check catalog proof passed 13/13 (run 36960244466).
  - #615's initial-state proof passed (run 37152518364): both tables are empty under a BYPASSRLS evidence role, and the tuples-added counter is 0.
- **Application:** not yet deployed. Deploying it needs owner approval.

Delivered following the migration-first rule:

- **PR-1** (#601): the migration only. The Production evidence followed in #613 (preflight), #614 (catalog proof) and #615 (initial state).
- **PR-2** `feat/p2-business-identity`:
  - `schema.prisma`;
  - the domain, API and UI;
  - the Content Studio choice-provenance fix;
  - the knowledge-snapshot integration;
  - tests and CI.

## 1. What P2 is for

P1 taught Dubiz *what the business sells*. P2 teaches it:

- who the business is;
- what it wants to be known for;
- whom it wants to attract;
- what it wants a visitor to do;
- how it speaks;
- which claims and facts may be shown in public.

Every item keeps its provenance and its publication authority.

It is **not** a landing-page milestone. It is a foundation that a future strategy engine needs so that it can produce at least three genuinely different strategies.

## 2. Audit — what existed before P2

| Concept | Source before P2 | Owner-confirmed? | Gap |
|---|---|---|---|
| Name | `Business.name` (signup) | typed at signup | no publication authority |
| Category / sub-category / model | `BusinessProfile` (onboarding) | yes (select lists) | — (internal taxonomy) |
| City, hours | `BusinessProfile.city/openingHours` | n/a — **no app writer** | no writer, no publication authority |
| Contact (phone / email / address) | `BusinessProfile.billing*` | yes, *for invoices* | billing field ≠ permission to publish |
| Description, specialization, differentiators, positioning | — (content request bodies only) | — | **missing** |
| Target audience | bot `audienceTags` (bot-scoped); content `audienceTypes` | bot: yes; content: **always computed from the goal** | no business-level source |
| Objective | bot goals (bot-scoped); content goal (per request) | per surface | no business-level source |
| Tone | bot `voice.tone`; content `selectedDirection.tone` | bot: yes; content: **indistinguishable from the "warm" default** | no business-level source; no content provenance |
| Owner emphasis | P1 `featuredByOwner` | yes | — (reused) |
| Publication authority | only `BusinessAsset.publicUseApproved` | yes | nothing for claims or facts |
| Knowledge / provenance | M7 snapshot `AuthorityClass` + `ProvenanceRef` | — | no identity producer |

## 3. Domain design

| Concept | Canonical value lives in | Authority lives in | States |
|---|---|---|---|
| Business name, city, hours | `Business.name`, `BusinessProfile.city/openingHours` | `BusinessIdentityFactAuthority` | UNKNOWN → KNOWN → OWNER_CONFIRMED → PUBLIC_USE_APPROVED |
| Public phone / email / address | `BusinessProfile.billingPhone/Email/Address` | `BusinessIdentityFactAuthority` (explicit designation) | same |
| Description, specialization, differentiators, service area | `BusinessIdentityStatement.text` | the same row | OWNER_CONFIRMED → PUBLIC_USE_APPROVED |
| Audience, primary / secondary objective, tone, positioning | `BusinessIdentityStatement.code` (closed lists) | the same row | OWNER_CONFIRMED (internal directive; never public — enforced by CHECK) |
| Category / model | `BusinessProfile` | — | KNOWN (internal taxonomy, not a public claim) |
| Offerings, prices, fulfillment, emphasis | P1 tables | P1 | FACT |
| Derived positioning | recomputed (`identity-signals.ts`) | adoption → statement | DERIVED (MACHINE_PROPOSAL, internal only) |

**Fact authority, minimal by design.** There is one ACTIVE row per (business, fact). It holds:

- the canonical `sourceField`, fixed per fact by CHECK;
- `confirmedAt` / `By`;
- `publicUseApproved` / `At` / `By`;
- `valueHash`: the sha256 of the exact value the decision was made for. The value itself is never copied.

When the underlying value changes, the hash no longer matches and the authority **lapses on its own**. The fact goes back to KNOWN and leaves the public inventory. Approving the new value retires the old row and creates a new one.

Two rules hold throughout: fact existence ≠ permission, and billing field existence ≠ permission.

Deliberately not identity facts:

| Field | Why excluded |
|---|---|
| `billingLegalName` / `TaxId` / `VatNumber` | tax identity on invoices, governed by billing law |
| category / model | internal taxonomy, not a public claim |
| lat / long | no writer exists |
| logo / images | already governed by `BusinessAsset.publicUseApproved` |
| WhatsApp number | owned by the integration; choosing it as a channel belongs to Conversion |

**Why derived signals are not stored.**

- Their inputs are durable rows: P1 offerings and demand, `ContentRun` / `ContentEvent`, the bot profile.
- The rules are pure and versioned (`p2.signals.v2`).
- An adoption records `<version>|<signal key>><dimension>:<code>`, so the rule that proposed it is named.
- Adopted suggestions become durable OWNER_CONFIRMED statements.

There is no AI-opinion table.

## 4. Content Studio: explicit vs default (fixed in P2)

Every new `ContentRun.inputSnapshot.data` now carries `choiceProvenance` (`lib/features/content/choice-provenance.ts`):

- **tone**:
  - `OWNER_SELECTED`: the owner clicked a vibe in this flow, or carried forward one that was recorded as clicked;
  - `DEFAULTED`: there was no vibe, so `vibeToTone` filled in "warm";
  - `UNKNOWN`: the vibe was restored without a record.
- **audience**:
  - `DERIVED`: computed from the goal. This is every audience today, because Content Studio has no audience control;
  - `OWNER_SELECTED`: reserved for a future explicit control;
  - `UNKNOWN`.
- **No marker** means the run was persisted before the fix: `LEGACY_AMBIGUOUS`. Such runs are never owner evidence and are never backfilled.
- The server sanitizes the label. An `OWNER_SELECTED` label with no value is downgraded to `UNKNOWN`.

Only `OWNER_SELECTED` values feed the identity signals.

## 5. Derived signals (`p2.signals.v2`, 180-day window)

| Signal | Evidence | Minimum | Suggests |
|---|---|---|---|
| OFFERING_MIX | active services vs products | 3 | — |
| CATEGORY_BREADTH | owner category labels | 6 labelled | BREADTH (≥4 categories) or SPECIALIZATION (1; caveat) |
| FULFILLMENT_MODE | explicit service fulfillment | 1 | HOME_SERVICE / REMOTE / LOCAL customers |
| QUOTE_PRICING | service price modes | ≥2 and ≥ half | SECONDARY_OBJECTIVE REQUEST_QUOTE |
| BOOKING_DEMAND | BOOKING signals | 10 | APPOINTMENT_CUSTOMERS, BOOK |
| DEMAND_CONCENTRATION | demand signals | 20, top ≥40% | — (internal; not a popularity claim) |
| CONTENT_VARIANT_PREFERENCE | VARIANT_SELECTED picks | 5, top ≥60% | — |
| **CONTENT_TONE_PREFERENCE** | **OWNER_SELECTED** content tones only | 3, top ≥⅔ | TONE |
| **CONTENT_AUDIENCE_PREFERENCE** | **OWNER_SELECTED** content audiences only | 3 runs | NEW / RETURNING customers |
| BOT_TONE / BOT_AUDIENCE / BOT_PRIORITY | explicit bot choices | 1 | TONE / business-level audience / SPEED, PERSONAL_SERVICE |

Never derived:

- premium or value from prices;
- popularity from demand;
- speed from one appointment;
- any trait of a person;
- anything from a DEFAULTED, DERIVED, UNKNOWN or LEGACY_AMBIGUOUS content value.

## 6. Natural acquisition map

| Concept | Source | Friction | Learned naturally? | Needs confirmation? | Publication-safe? |
|---|---|---|---|---|---|
| Name / city / hours / contact | existing profile & billing | one tap per fact | value already known | yes ("נכון") | only after the explicit toggle |
| Audience, objective, positioning, tone | catalog, bookings, bot choices, explicit content tone picks | one tap per suggestion | yes (signals) | yes | no (internal directives) |
| Description, specialization, differentiators, service area | `/business/identity` | short optional text | no | owner writes it | only after the explicit toggle |

## 7. Business Memory references

Each identity knowledge item in the M7 snapshot names its canonical row twice:

- the typed `subject` (`identity-statement#id` or `identity-fact-authority#id`);
- the `provenance` (`BusinessIdentityStatement` / `BusinessIdentityFactAuthority`, id).

Its value carries:

- `dimension` / `fact`, and `code` or `hasText`;
- `status`, `source`, `sourceRef` (including the rules version);
- `ownerConfirmed`, `confirmedByUserId`;
- `publicUseApproved`.

It **never** carries statement text or a fact value. Fact currency (hash vs current value) is computed inside SQL.

`resolveIdentityProvenance(businessId, ref, tx)` resolves a reference to its row within one business. Both the businessId filter and RLS make another tenant's id resolve to `null`.

### Business under B4

Migration `20261006090000_business_tenant_write_rls` (B4) keeps `Business` **reads open**: its SELECT policy is `USING (true)`, and column privileges decide what each role sees. The runtime may read only `id`, `name`, `createdAt`, `deletionRequestedAt` and `deletedAt`.

RLS therefore does not stop a transaction scoped to business A from reading business B's name. P2 closes that gap in code, not in the database:

- `loadIdentityFactValues` first checks that the transaction's own `app.current_business_id` names the requested business, and refuses otherwise. That function is the only place P2 reads `Business`.
- Without a tenant context, it fails closed.
- The fact-currency join in the snapshot is driven from the RLS-protected authority table, so it never surfaces another tenant's `Business` row.
- P2 writes nothing to `Business`; a static test enforces this.

The RLS suite replays B4 and the Production column grants verbatim. A negative control that removes the pin makes the cross-tenant and no-context checks fail.

## 8. Proofs (isolated; Production untouched)

- **`identity.verify.test.ts`**: vocabulary and signals. Explicit vs default cannot be confused: 12 DEFAULTED, 12 LEGACY and 12 UNKNOWN runs suggest nothing, while 3 explicit picks do and defaults never top them up. Also covers the client-flow markers and the persistence marker.
- **`identity-strategy.verify.test.ts`**:
  - built on the *real* `assembleBusinessIdentity` + `publicUseInventory`, across 6 verticals;
  - every one of the five axes varies, and every pair of directions differs on ≥3;
  - P1 alone gives ≤1 axis;
  - unapproved, confirmed-only, stale and internal material is unavailable.
- **`identity.rls.db.test.ts`**:
  - replays the exact migration and runs the real code as `app_runtime`;
  - covers cross-tenant statements, fact authorities, memory loading, reference resolution and content evidence;
  - a negative control on each table turns it red.
- **`identity.db.test.ts`**:
  - CHECKs and partial indexes;
  - history and public-use authority;
  - the fact-authority lifecycle, including lapse on change;
  - JS hash = SQL hash;
  - content provenance end to end;
  - memory references resolving to ACTIVE rows with no text.
- **`snapshot.test.ts`**: stable references; two specializations are two pointers; lapsed authority is excluded.
- **No drift**: `prisma migrate diff` (migration-built database → `schema.prisma`) reports no difference.
- **`ops/evidence/sec-p2-business-identity-production-evidence.sql`**: a 13-check read-only catalog proof, including the ledger checksum of the reviewed file.

## 9. Gaps (deliberately not in P2)

- **P2 identity**:
  - Content Studio and the bot do not yet *read* identity (pre-fill / compose context);
  - city and hours still have no app writer (P2 can only authorize them once they exist);
  - Content Studio has no explicit audience control (audiences remain DERIVED);
  - the legacy coupon pages already display name / city / hours without P2 authority. A future landing surface must read `publicUseInventory`.
- **Later: Trust**: proof behind claims (experience, certifications, reviews); response-time evidence.
- **Later: Asset authority**: which images may represent which strategy (the `BusinessAsset` flag exists).
- **Later: Conversion**: page-level CTA preference and channel choice (call / WhatsApp / booking / quote).
- **Later: BI**: `LandingBusinessContext`, readiness, strategy selection, composition.
