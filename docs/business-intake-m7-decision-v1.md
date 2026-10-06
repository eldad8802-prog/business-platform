# Business Intake — Google + Meta closure audit and M7 (Commerce & Telephony) decision record, v1

Status: **DECISION RECORD.** This is an architecture and evidence freeze. It changes nothing in Production.
Date: 2026-10-06. Code audited at `origin/main` fc9a903b, re-based onto 776ca1ab.
Scope: owner milestone "BUSINESS INTAKE — Google + Meta Closure Audit + M7 Commerce & Telephony Architecture/Evidence Freeze".

Every claim about a provider cites an official page fetched on 2026-10-06. When a claim could not be confirmed on an official page, it is marked **UNVERIFIED**. "Ready" is never claimed on the strength of a simulator.

The audit's code-only fixes ship in the same PR as this record (§1.6). They change no schema, authority or provider state.

---

## 1. Google — state

### 1.1 Matrix

| Capability | State | One next action |
|---|---|---|
| Manual webhook (owner pastes URL + key into Google Ads → Lead form → Webhook integration) | **READY** (after the 429 fix in this PR) | none in code |
| `is_test` never creates a Lead, a Customer or retained contact hints | **READY** (code proof in §1.3; the battery now proves it too) | none |
| Enable `acquisition_google_lead_forms` for one pilot business | **BLOCKED BY OWNER** | the owner enables the feature for the first real advertiser (admin + MFA, audited) |
| Lead-form eligibility of the advertiser (policy history, privacy policy, Search/PMax) | **REQUIRES REAL BUSINESS** | confirm when onboarding the pilot that its account can create a lead-form asset |
| End-to-end proof with a real form ("Send test data", then one real lead) | **REQUIRES REAL BUSINESS** | run the M6 runbook pattern with the pilot advertiser |
| Developer token (Explorer level reaches production accounts, 2,880 ops/day) | **BLOCKED BY DUBIZ** (never applied) | apply only if automatic setup is prioritised |
| OAuth verification for the restricted `adwords` scope (multi-tenant) | **BLOCKED BY GOOGLE** (needs app verification; whether a CASA assessment applies is UNVERIFIED) | defer; submit only on the owner's decision |
| Automatic setup (`LeadFormAsset.delivery_methods[].webhook` via the API) | **BLOCKED BY DUBIZ (no code) → then GOOGLE (OAuth)** | defer |
| Backfill via `lead_form_submission_data` | **BLOCKED BY GOOGLE** (same OAuth) | defer |
| Local Services leads | **BLOCKED BY GOOGLE** (Israel availability UNVERIFIED, probably not offered) | none |

### 1.2 Answers

- **Is the manual webhook path production-ready?** **Yes, with the fix in this PR.**
  - What was audited:
    - The `dgk_` key: 32 random bytes, stored as sha256 only.
    - The key is checked by the SECURITY DEFINER resolver with `status='ACTIVE'`.
    - The body is capped at 64 KB.
    - Dubiz answers 2xx only after the receipt is durable, and 5xx on a database failure.
    - Dedupe is on `lead_id` per endpoint.
    - Attribution is kept: campaign, ad group, PMax asset group, creative and gclid.
    - The feature gate is re-checked when a webhook is ingested.
    - Revoke zeroes the key hash, and tenant isolation holds.
    - Battery §4 and §6 cover these.
  - The defect fixed here: rate limiting answered **429**, and Google's contract says "4XX — Retryable: No". A lead that hit the limit was therefore lost for good. It now answers **503 + Retry-After**, and Google retries 5xx.
- **Is automatic setup still blocked, and by what exactly?** **Yes.**
  - Dubiz has no Google Ads API client code at all.
  - The hard external gate is **Google's OAuth app verification for the restricted `https://www.googleapis.com/auth/adwords` scope**. Google's own page says "classified as a restricted scope … complete the OAuth app verification process before productionizing", and the restricted-scope policy says a security assessment applies.
  - The developer token is a smaller gate. Per the access-levels page (updated 2026-09-30), **Explorer** already reaches production accounts. The "Basic+" in the M6 document is out of date and is corrected in this PR.
  - Recommendation: **do not pursue automatic setup now.** The manual paste-in takes the owner of the business about two minutes and needs no Google approval.
- **Is it guaranteed that `is_test` submissions never create a Lead?** **Yes.**
  - The code path (§1.3) has no route to a Lead.
  - The battery did *not* prove it before this PR: the test submission reused the contact of a real lead, and the assertion could not fail. Both are fixed here.

### 1.3 `is_test` path

1. The parser sets `isTest = (is_test === true)`.
2. Normalisation sets `target = "none"`, and **after this PR also drops the contact hints and sets identity to `none`**. Before the fix, the dummy contact was kept in `IntakeNormalizedEvent`.
3. Routing applies R7_NONE and the adapter returns IGNORED `test_submission`.
4. The payload is purged.
5. Pre-resolve is read-only, so no Customer and no Lead is created.

### 1.4 Known behaviours (accepted, documented)

- **Paused or revoked endpoints answer 401.** Google does not retry a 4xx, so leads sent during a pause are not delivered to Dubiz. They stay in Google Ads (CSV export for 30 days, stored for 60). The owner UI states that a paused source receives nothing. This is consistent with "pause = stop receiving".
- **A disabled feature, an inactive business or an unknown account answers `200 {}`** and records nothing. Answering 2xx avoids an enumeration oracle.

### 1.5 Remaining low-priority gaps (not fixed)

- `lead_id` is truncated to 64 characters and filtered by charset. The real format is UNVERIFIED; observed IDs are int64.
- No pre-authentication IP bucket. A wrong key costs one indexed DB lookup.
- Rotate, pause and resume do not re-check `enabledSources`.

### 1.6 Code-only fixes in this PR

| Fix | File |
|---|---|
| 429 → 503 + Retry-After (lost leads) | `app/api/intake/acquisition/google/[publicId]/route.ts` |
| `PHONE_NUMBER_VERIFIED` column → phone slot | `lib/intake/acquisition/providers/google-lead-form.ts` |
| Test submissions keep no contact hints | `lib/intake/acquisition/canonical.ts` |
| Battery: the test lead gets its own contact; the assertion now discriminates | `.m6/acquisition-battery.ts` |
| Developer-token level and Meta permission list corrected | `docs/business-intake-m6-acquisition-connectors-v1.md` |

---

## 2. Meta — state

### 2.1 Five tracks

| Track | Done | Missing | Next action |
|---|---|---|---|
| **DUBIZ CODE** | Connect flow (Login for Business code → Pages → sealed 10-minute business-bound handle → ADVERTISE required → subscribe `leadgen` with the Page token → encrypted per-connection token); signed webhook (HMAC-SHA256 on the raw body, constant time, before parse); dedupe on leadgen_id per Page; deferred hydrate with token-invalid / permission / throttle handling; revoke + unsubscribe; feature gate on every step; battery §5/§9/§10 | **M-D1** long-lived token handling; **M-D2** leads for a Page whose connection is in ERROR are acknowledged and skipped (silent loss); **M-D3** Graph code 100 is terminal (may drop leads under a Leads Access Manager restriction, UNVERIFIED); **M-D4** revoking a PAUSED connection does not unsubscribe; **M-D5** privacy and data-deletion pages do not name Lead Ads | One Dubiz PR **before** any Meta activation (§2.4) |
| **META CONFIGURATION** | App exists (shared with WhatsApp) | Lead Ads Facebook Login for Business configuration (permission set; **token type chosen deliberately**: System User token "defaults to never expire", vs. a short-lived User token); Webhooks product: object `page`, field `leadgen`, callback `/api/intake/acquisition/meta` + verify token; Privacy URL `/privacy`; data-deletion **instructions** URL `/data-deletion` (an instructions URL is sufficient per Meta); app in **Live** mode | Owner creates the Lead Ads configuration (System User token type recommended) and records its id |
| **OWNER ACTION** | none | Generate and set `META_LEAD_ADS_VERIFY_TOKEN` and `ACQUISITION_CREDENTIAL_ENCRYPTION_KEY` (32 bytes; never rotated without a re-encryption plan) in Vercel Production; set `NEXT_PUBLIC_META_LEAD_ADS_CONFIG_ID`; approve the privacy/deletion copy; record the App Review screencast (English UI or captions) | After M-D1..D5 merge |
| **META REVIEW / APPROVAL** | unknown (WhatsApp review status is itself unproven) | **Business Verification**; **Access Verification (Tech Provider)**, which applies when users without a role on the app use `leads_retrieval`, `pages_manage_ads`, `pages_read_engagement`, `pages_show_list`, `ads_management` or `business_management`; **App Review — Advanced Access** for the permission set in §2.2 | Owner reads App Dashboard → Verification / App Review status (read-only look) |
| **REAL-BUSINESS LIVE PROOF** | none | After approval and Live mode: connect a real Page, send one lead from the Lead Ads Testing Tool (the tool does not work in development mode), see it in Leads with answers and campaign, disconnect; then repeat once on a Page with a Leads Access Manager restriction | after review |

### 2.2 Permission set (decided)

| Permission | Decision | Basis |
|---|---|---|
| `leads_retrieval` | REQUEST | reads `GET /{leadgen_id}`; Meta: "must include `leads_retrieval` and `pages_manage_ads`" |
| `pages_manage_ads` | REQUEST | same sentence |
| `pages_show_list` | REQUEST | `/me/accounts`; a dependency of every Page permission |
| `pages_read_engagement` | REQUEST | listed by the webhook and retrieval guides |
| `pages_manage_metadata` | REQUEST | `POST /{page}/subscribed_apps` (subscribe to leadgen) |
| `ads_management` | REQUEST | listed by both leadgen-webhook guides and as a `leads_retrieval` dependency; Dubiz makes no ads calls of its own |
| `business_management` | **DO NOT REQUEST in v1** | not in the webhook guides; listed only as a dependency (via a page summary, UNVERIFIED). Add it only if review or a Page in a business portfolio demonstrably requires it |

### 2.3 Embedded Signup and Graph versions — separate from Lead Ads (status 2026-10-06)

- **Deadline.** Meta: "Embedded Signup v2 **and v3** will be deprecated on **October 15, 2026**, including their public preview versions. Migrate your integration to v4."
- **Today.** The launch sends `extras: { setup, featureType: "whatsapp_business_app_onboarding", sessionInfoVersion: "3" }` with the existing configuration `1955709398385145`.
- **v4 code.** Draft PR **#690** matches, byte for byte, what Meta's own Embedded Signup Builder generates for that configuration with ES Version v4 + "WhatsApp Business App Onboarding": `extras: { "version": "v4", "featureType": "whatsapp_business_app_onboarding" }`. The configuration id is unchanged. Runbook: `docs/whatsapp-embedded-signup-v4-switch.md` (on #690).
- **Unresolved.** Meta's pages disagree: "version is determined inside of the extras object" vs. v4 needs "a new … configuration … with products" and "extras … purposely empty". Creating a new configuration with Products is not available to Dubiz yet. Meta states that v4 products need advanced access for their permissions, which is pending App Review.
- **Status (owner, 2026-10-06):**
  - Business Verification: IN REVIEW. App Review: IN REVIEW. Access Verification: NOT STARTED (blocked on Business Verification). Direct Meta support: unavailable.
  - **Blocked externally.** The Production switch is not approved, and #690 stays a draft.
- **Graph versions:**
  - Lead Ads uses v25.0, supported until 2028-07-29. OK.
  - WhatsApp server calls use v23.0, supported until 2027-10-08. Not urgent.

### 2.4 Required Dubiz PR before Meta activation (M-D1..D5)

- **M-D1: long-lived tokens.**
  - If the configuration uses System User tokens, record that and set `credentialExpiresAt = null`.
  - Otherwise, exchange the code → user token, then `fb_exchange_token` → a long-lived user token, then `/me/accounts`. Meta documents that "Long-lived Page access token[s] do not have an expiration date".
  - Store `credentialExpiresAt` from `debug_token`.
- **M-D2: no silent loss for ERROR connections.**
  - The resolver should accept `ACTIVE` and `ERROR`: the receipt is stored and the hydrate is deferred until the owner reconnects.
  - This changes the M6 resolver SQL, so it is a **migration** and ships with the M7-A migration (§13).
- **M-D3:** Graph code 100 with a permission subcode → deferred, not terminal.
- **M-D4:** revoking a PAUSED connection still unsubscribes the Page.
- **M-D5:** the privacy and data-deletion pages name Lead Ads, Page tokens and lead-form answers, and how they are deleted.

---

## 3. Commerce — forensic audit of what exists

**Summary.** Dubiz has many order-like structures. None of them is "a customer bought something from this business through an external store". Not one is reusable as commerce order truth.

| Structure | What it is | Reuse in M7? |
|---|---|---|
| `Customer` | Canonical per business, unique (businessId, phone) | **REUSE.** The buyer resolves to a Customer through M4. |
| `IdentityLink` / `IdentityProposal` | phone, email, provider (scope `<sourceKey>:<account>`), hashed | **REUSE.** Store customer id = a provider identifier. |
| `InventoryExternalSale` / `InventorySale(Line)` / `InventorySourceSaleLine` | Stock-movement dedupe and stock deduction only; no customer, no money | **NOT** order truth. Stock movement from orders is out of the first wave (§15 D7). |
| `POSApiKey` / POS route | No RLS, no route creates keys, route is BLOCKED in coverage | **DO NOT REUSE** (M7 uses AcquisitionConnection credentials) |
| `POSProductMapping` | external SKU → InventoryItem | **REUSE the pattern** for order lines (optional mapping) |
| `Deal` | Hangs off a Lead | **NO.** An order is not a deal and never touches a Lead. |
| `PurchaseOrder` | Supplier side | NO |
| `BillingDocument` | Legal tax document | **NEVER auto-created** (a store often invoices through iCount or Green Invoice already) |
| `FinancialEvent` | Dubiz money ledger | Not written in wave 1. Order revenue is an analytics fact, not booked money. |
| `PaymentRequest` / `Transaction` / `PaymentWebhookEvent` | Dubiz-originated collections | NO (the callback-routing pattern informs the design) |
| `OfferingDemandSignal` PURCHASE | Demand learning | **REUSE** as a learning sink (no PII) |
| Routing | `COMMERCE` family; `R5_COMMERCE` → target `commerce`, executor **unavailable** (dead-letter); `R0_FORBIDDEN_LEAD` forbids target `lead` for any non-LEAD family | **REUSE.** R0 already enforces Order ≠ Lead. M7 adds the core `commerce` handler. |
| M3 contract | store id → connection; `order.created` / `checkout.abandoned`; dedupe on order id per store; ISO-4217 currency + integer minor units; "an order is never a Lead" | **REUSE** as the frozen contract |

---

## 4. Telephony — forensic audit of what exists

- **There is no telephony code**: no adapter, no source, no destination, no store.
- **Already reserved:**
  - the `CALL` family;
  - `Lead.nextActionKind='call'`;
  - `ConversationChannel.PHONE` (unused);
  - `IdentityLink.kind='phone'`;
  - the M3 design sketch: "dialed number → telephony connection; `call.missed` / `call.completed`; provider call id scoped to the account; recordings never in the payload".
- **Routing today:** R0 forbids a call from becoming a Lead (frozen). A CALL with target `attention` or `customer` falls to **R8_ATTENTION_DEFAULT**, which runs the adapter's own `route()`. There is **no `call` route target**, and `IntakeNormalizedEvent.routeTarget` has a DB CHECK, so adding one is a migration.
- **Identity:** a phone is STRONG evidence in M4. It is `resolved` or `unresolved`, never ambiguous, and `conflict` happens only against another strong identifier. "A phone is never linked deterministically" (M4).
- **Normalisation:** `normalizeCustomerPhone` maps hidden or anonymous caller ID to `null`, so such callers are never identifiers.
- **Secretary (M5):** there is no call reason. `CUSTOMER_WROTE` derives from `Conversation.customerLastInboundAt` and **must not** be reused for calls (the Secretary would say "the customer wrote").
- **Learning:** the sensor contract's `FORBIDDEN_KEY` blocks `phone`, `name` and similar keys. Coverage CI fails on any model, route or sensor that is not owned by a feature.

---

## 5. Provider research (official sources, fetched 2026-10-06)

### 5.1 Commerce

| | WooCommerce | Wix eCommerce | Shopify | Konimbo |
|---|---|---|---|---|
| Israeli presence (third party: Store Leads 2026-10-02 / ShopRank 06-2026) | 19,576 stores / 47.5% | 8,560 / 9.9% | 12,034 / 24.4% | 865 worldwide, 97.9% IL / 5.8% |
| Approval to serve many stores | **none** | **none** for an unlisted app (install link); App Market listing has an automated review | Partner account + App Store review (applies even to an unlisted public app, per a Shopify staff forum answer); **Protected customer data Level 2**; `read_all_orders` approval for history beyond 60 days; mandatory GDPR webhooks | Token issued by the store owner; possibly a paid API add-on (UNVERIFIED) |
| Auth | per-store REST key + secret via `/wc-auth/v1/authorize` (posted to an HTTPS callback) | OAuth app ("API keys aren't available for third-party Wix apps") | OAuth; since 2026-01-01 custom apps are created only in the Dev Dashboard (one store, no review) | static token |
| Events | `order.created/updated/deleted/restored`; refund and cancel arrive as `order.updated` (refund detail via `/orders/{id}/refunds`) | Order Created/Updated/Approved/Canceled/Payment Status Updated/Fulfilled; Refund Completed | `orders/*`, `refunds/create` | new order only; no refund or cancel |
| Signature | `X-WC-Webhook-Signature` = base64 HMAC-SHA256 (per-webhook secret) | body is a **JWT** verified with the app public key | `X-Shopify-Hmac-Sha256` base64 HMAC-SHA256 (app secret) | **none** |
| Retries | **none.** Disabled after more than 5 consecutive failures (`woocommerce_max_webhook_delivery_failures`) | up to 12 over about 47 h; **1,250 ms** response timeout | 8 over 4 h; an API-created subscription is deleted after 8 failures | undocumented |
| Stable event id | **none** (`X-WC-Webhook-Delivery-ID` changes per attempt) | envelope `id`; `entityEventSequence` per entity | `X-Shopify-Webhook-Id` per delivery; `X-Shopify-Event-Id` per action | none |
| Tenant key | the Dubiz per-connection URL (publicId) + secret; `X-WC-Webhook-Source` cross-check | `instanceId` (+ siteId) | `X-Shopify-Shop-Domain` | — |
| History import | REST `/orders` (paged) | Orders API | `read_all_orders` (approval) | REST, 100 calls / 10 min |
| PII risk | normal | normal | Level 2 obligations (encrypted backups, access logs, incident policy) | **order payload contains card token, last 4 digits and national ID** |

Others:
- **iStores** has a new-order webhook; no signature or retry documentation found.
- **Exitshop and Wobily**: no public API found.
- **Tranzila and Cardcom** are payment processors and **iCount and Green Invoice** are invoicing tools, not stores. They confirm that M7 must never auto-issue tax documents.

### 5.2 Telephony

| | Voicenter (IL cloud PBX) | CloudTalk | Twilio | Aircall | 3CX | Bezeq / Partner / Cellcom Centrex |
|---|---|---|---|---|---|---|
| Delivery | CDR Notification: HTTP POST after the call | Svix webhooks: `call.started/ringing/answered/ended`, `recording_ready` | StatusCallback | `call.created/answered/hungup/ended` | CRM template journaling | **no public API** (toolbar / partnership) |
| Business fields | `ivruniqueid`, direction, caller, `DID`, `duration`, `isAnswer`, `status` ANSWER/ABANDON/NOANSWER, epoch time | `call_id`, `call_uuid`, direction, `external_number`, `internal_number`, `duration`, `talking_time`, `is_voicemail` | `CallSid`, From, To, Direction, CallStatus | (call object UNVERIFIED) | CallType, Number, Duration | — |
| Signature | **none documented** | Svix HMAC-SHA256, ±5 min | HMAC-SHA1 over URL + params | **token in the body** | per template | — |
| Retries / idempotency | re-sends on failure (policy on Voicenter's side); dedupe on `ivruniqueid` | 50 retries over about 11.5 h; stable `event_id`; 30-day replay | UNVERIFIED | 50 retries, then disabled | none | — |
| History | Call Log API (10,000 per request, 30 req/min, **authorized source IP only**) | call API | REST Calls | API | no | — |
| Tenant mapping | DID → connection | account + internal number | AccountSid + To | account | one PBX = one business | — |
| Israel | native | IL numbers, "don't require business documentation" (vendor) | IL numbers ($5.50/month local); IL regulatory bundle UNVERIFIED | IL local only | via the customer's trunk | native |
| Access | contract via Voicenter Backoffice; price not published | self-serve SaaS | self-serve | self-serve | per install | carrier contract |

**Not viable:**
- CallRail does not operate in Israel.
- Yemot HaMashiach is an IVR niche product with community-only documentation.

### 5.3 Recording law

- Israel's Secret Monitoring Law is commonly read as one-party consent. That reading comes from secondary sources; the statute itself was not read.
- Storage obligations under the Privacy Protection Law are UNVERIFIED and need legal review.
- **Recordings and transcripts are out of M7.** They are a separate, authority-gated capability.

---

## 6. Provider selection

### Commerce first wave: **WooCommerce, then Wix eCommerce**

**WooCommerce**
- Largest Israeli base.
- **Zero external approvals**, a per-store HMAC secret, and an onboarding flow the owner of the business completes alone.
- Its weaknesses are known and engineerable:
  - it never retries, so Dubiz adds a **polling reconciler** (`/orders?modified_after=`);
  - no stable event id, so Dubiz uses a **content-derived event identity**;
  - webhooks auto-disable, so Dubiz adds a **webhook-health check**.

**Wix eCommerce**
- No review for an install-link app.
- The cleanest event contract: a signed JWT, 12 retries over about 47 h, a stable envelope id and a per-entity sequence.
- One constraint: the receipt must be **acknowledged within 1,250 ms**. Dubiz already acknowledges after the receipt and processes afterwards.

**Wave 1b: Shopify**
- Excellent API, but serving many stores needs **App Store review + Protected customer data Level 2 + `read_all_orders`**. These are commitments the owner must take on deliberately.
- A single-store Dev Dashboard custom app can serve one pilot without review, if a pilot asks for it.
- The Shopify shop domain already fits the M6 `externalResourceId` CHECK.

**Deferred: Konimbo.** No signature, no refund or cancel events, and the order payload carries card details and national ID. Revisit only with a signed-webhook commitment from Konimbo.

### Telephony first wave: **Voicenter (primary), CloudTalk (second)**

**Voicenter**
- The Israeli SMB cloud-PBX incumbent. Its post-call CDR is exactly the business event Dubiz needs.
- DID → business is a clean tenant key.
- **Before any build, the owner must confirm with Voicenter:**
  1. whether CDR delivery can carry a shared secret, an HMAC or a published source-IP list;
  2. the API pricing and contract;
  3. that Dubiz can be a partner or integrator for many accounts.
- Until then Dubiz authenticates with a per-connection secret URL key: the M6 `web.form` / Google `dgk_` pattern, stored as a sha256 hash only.
- The Call Log history API needs a fixed egress IP, the same problem class as the ITA integration. **History import is out of wave 1.**

**CloudTalk**
- Best verified webhook hygiene (Svix HMAC, stable `event_id`, 50 retries, replay), and Israeli numbers.
- Self-serve, so it can be proven end to end without a partnership.
- It is the lower-risk path to a **REAL-PROVIDER-PROVEN** call pipeline.

**Twilio** stays an option for a later "Dubiz number / call-forward" product, which carries a larger scope.

---

## 7. Canonical M7 architecture

```
provider webhook ──► /api/intake/{commerce|telephony}/<provider>/<publicId>
   │  verify (HMAC / JWT / per-connection key), size cap, tenant = connection (never the payload)
   ▼
IntakeEvent receipt (unique businessId, sourceKey, externalEventId)  ── 2xx only after this
   ▼  drain (after(), sweeper retries — QStash */10 + backstops)
adapter.normalize ─► IntakeNormalizedEvent (family COMMERCE | CALL)
   ▼
M4 pre-resolve identity (read-only) ─► decideRoute
   ├─ COMMERCE ─► R5_COMMERCE ─► core handler routeToCommerce   (executor "unavailable" → "core")
   │      ├─ identity resolved            → CommerceOrder.customerId = that Customer
   │      ├─ unresolved + valid phone     → create Customer (same rule as the lead destination)
   │      ├─ unresolved, email only/none  → order with customerId NULL (no Customer invented)
   │      └─ conflict / candidate         → customerId NULL + IdentityProposal (owner decides)
   │      upsert CommerceOrder (by externalOrderId) + append CommerceOrderEvent
   │      NEVER a Lead (R0 frozen), NEVER BillingDocument/FinancialEvent, NEVER stock movement (wave 1)
   └─ CALL ─► R9_CALL (new, before R8) ─► core handler routeToCall
          ├─ resolved           → CallActivity.customerId (+ leadId if the Customer has an OPEN lead: evidence only)
          ├─ unresolved         → CallActivity, no customer, callerHash for grouping; owner may create (owner act)
          ├─ hidden/invalid     → CallActivity, anonymous
          └─ conflict           → no customer + IdentityProposal
          NEVER a Lead (R0 frozen), NEVER an IdentityLink from a call, NEVER a lead stage move
   ▼
Secretary (read model)  ·  sensors (categorical, no PII)  ·  attribution (on the order/call row)
```

**Invariants (frozen):**
- **I1:** Order ≠ Lead and Call ≠ Lead. R0 stays frozen, and no M7 code path writes `Lead`, `LeadLifecycleEvent` or `Deal`.
- **I2:** the tenant always comes from the connection resolved server-side. The payload's store or account id is a cross-check only.
- **I3:** the provider answer is 2xx only after a durable receipt. Processing happens afterwards and is retried by the sweeper.
- **I4:** one receipt per provider event (unique key). One order row per (business, source, externalOrderId). One call row per (business, source, providerCallIdHash).
- **I5:** no silent merge. Uncertain identity produces an `IdentityProposal` and is never attached. A call never creates an `IdentityLink`, because caller ID is spoofable.
- **I6:** AI and automation never turn an order or a call into a lead. Only an **owner act** does (`actorType OWNER_USER`, with the receipt as evidence).
- **I7:** no PII in sensors or learning, only categories. Payloads are purged after processing per the M3 retention policy.
- **I8:** recordings, transcripts and card data are dropped at receipt build and never stored.

---

## 8. Reuse vs new schema

| Need | Decision | Invariant |
|---|---|---|
| Receipts, normalised events, retries, DLQ, sweeper | **REUSE** M3 `IntakeEvent` / `IntakeNormalizedEvent` | I3, I4 |
| Families | **REUSE** `COMMERCE`, `CALL` (no enum change) | — |
| Identity | **REUSE** M4 resolve, pre-resolve and proposals; `provider` identifier scope `<sourceKey>:<connection>` for the store customer id | I5 |
| Connection (tenant mapping, key hash, encrypted credentials, revoke, resolvers) | **EXTEND `AcquisitionConnection`**: widen the `sourceKey` CHECK (`commerce.woocommerce`, `commerce.wix`, `telephony.voicenter`, `telephony.cloudtalk`) and the `source_shape` CHECK. The tenant key is the Dubiz per-connection **publicId URL**, so the WooCommerce site URL never needs to fit `externalResourceId`. Wix `instanceId`, the Voicenter DID and the CloudTalk account fit the existing `^[A-Za-z0-9_.:-]{1,64}$`. | One table, one resolver set, one revoke path; partial unique on live `(sourceKey, externalResourceId)` prevents cross-business collision |
| Route target `call` | **EXTEND** `ROUTE_TARGETS` + `IntakeNormalizedEvent.routeTarget` CHECK (migration) | Every CALL with identity goes through R9, never through R8 |
| Commerce core handler | **NEW code** (`core-destinations.ts` gets `commerce`) | I1 |
| Order truth | **NEW** `CommerceOrder` (businessId, connectionId, sourceKey, externalOrderId, customerId?, status `placed/paid/fulfilled/cancelled/refunded/partially_refunded`, currency ISO-4217, totalMinor, refundedMinor, placedAt, providerUpdatedAt, providerSequence?, attribution JSON (utm/landing/referrer only), createdAt/updatedAt; **no leadId column**); unique (businessId, sourceKey, externalOrderId) | I1, I4. Status moves only forward by `providerUpdatedAt`/sequence, so a stale redelivery cannot regress status. |
| Order lines | **NEW** `CommerceOrderLine` (orderId, externalSku?, title, quantity, unitMinor, inventoryItemId? via a POSProductMapping-like map) | No stock movement in wave 1 |
| Order history | **NEW** append-only `CommerceOrderEvent` (orderId, intakeEventId UNIQUE, kind, occurredAt); runtime has no UPDATE/DELETE | Replays are visible; idempotent per receipt |
| Call activity | **NEW** `CallActivity` (businessId, connectionId, sourceKey, providerCallIdHash, direction `inbound/outbound`, outcome `answered/missed/voicemail/rejected`, durationSec, occurredAt, businessNumberRef (DID label, not a person), customerId?, leadId? (evidence link, read-only for M5), callerHash? (HMAC with a per-business salt, only when unresolved), callerPresent bool, intakeEventId UNIQUE, returnedAt?); unique (businessId, sourceKey, providerCallIdHash) | No phone stored in clear; Option B (Conversation/Message PHONE) **rejected** because it would trip `CUSTOMER_WROTE` and text semantics |
| Lifecycle | **NO change** to `LeadLifecycleEvent` in wave 1. The Secretary reads `CallActivity` directly. | M5 truth untouched |
| Erasure | **EXTEND** the erasure/deletion map with all three new tables | — |
| Features | **NEW** catalog rows `commerce_woocommerce`, `commerce_wix`, `telephony_voicenter`, `telephony_cloudtalk` (default OFF, platform-admin override) + `feature-coverage.ts` ownership | — |

---

## 9. Tenant, security, privacy

- **RLS:**
  - FORCE RLS on `CommerceOrder`, `CommerceOrderLine`, `CommerceOrderEvent` and `CallActivity`.
  - Policies are per command, keyed on `app.business_id`, mirroring M6.
  - The runtime has no DELETE. The `CommerceOrderEvent` runtime has INSERT + SELECT only.
  - The control plane (`app_ctlplane`) gets no grants on these tables.
- **Resolvers:** the SECURITY DEFINER resolvers are extended in the same function family, so each new source keeps exactly one resolver.
- **Collision:** the partial unique on live `(sourceKey, externalResourceId)` means a store or DID can be live on only one business. A second business gets 409, the same as Meta Pages today.
- **Signatures and keys:**
  - The signature is verified before parsing. A failure answers 401. Unknown or paused connections answer 401 too; for WooCommerce, which disables the webhook after failures, the health check reports the disabled webhook to the owner.
  - Per-connection secrets are stored hashed when Dubiz only verifies them, and AES-GCM encrypted with business-bound AAD when Dubiz must call the provider (WooCommerce and Wix tokens).
- **PII:**
  - The payload is purged after processing.
  - Card data, national ID, recording URLs and transcript fields are dropped at receipt build (I8).
  - Caller numbers for unknown callers are kept only as a salted hash.
- **Proof obligations:** the M6 battery pattern applies (wrong business, unknown resource, disabled, revoked, parallel duplicates). §12 lists each proof.

---

## 10. Secretary

- **Calls:**
  - New fact-class reason `MISSED_CALL_UNRETURNED`. It applies to a Customer or open lead with a missed inbound call, and no later outbound call, `returnedAt` or completed `call` next action.
  - On an open lead it ranks next to `CUSTOMER_WROTE`. A new suggestion rule `S5_CALL_BACK@1` → `nextActionKind='call'` (already allowed).
  - Calls from unknown numbers get a separate **"unknown callers"** digest: count + last time, grouped by `callerHash`. No name or number is invented. The owner can open the number and create a customer (owner act).
  - Repeat calls collapse into one item per person.
- **Commerce:**
  - Wave 1 adds **no attention item per order**. Orders are business-as-usual.
  - Only exceptions surface: a refund or cancel on a known Customer with an open lead, a connection unhealthy (WooCommerce webhook disabled, reconciler failing), or an identity proposal.
  - The Customer card shows order history.
- **Never:** the Secretary never says "the customer wrote" for a call, and never proposes "convert to lead" automatically. Converting a call to a lead is an explicit owner button with the call as evidence.

---

## 11. Learning and BI signals

- **New sensors** (catalog entries with domain, version and past-tense names; payload is categories only; `FORBIDDEN_KEY` enforced):
  - `COMMERCE_ORDER_RECORDED`: sourceKey, status, currency, totalMinor bucket, lineCount bucket, customerKind new/returning/unknown, attribution channel.
  - `COMMERCE_ORDER_STATUS_CHANGED`.
  - `CALL_RECORDED`: direction, outcome, duration bucket, callerPresent, identity state, businessNumber role.
  - `MISSED_CALL_RETURNED`: latency bucket.
- **Existing sinks reused:**
  - `OfferingDemandSignal` PURCHASE, only when a line maps to an offering.
  - `INTAKE_EVENT_SETTLED` and `INTAKE_IDENTITY_RESOLVED`, unchanged.
- **Attribution:**
  - Orders keep utm, landing and referrer from the provider. WooCommerce Order Attribution fields are present on recent versions; exact field availability per store is UNVERIFIED.
  - Calls are attributed by **business number role** (e.g. a campaign-dedicated DID) set by the owner on the connection.
  - A Customer's first touch is not rewritten by an order or a call. First touch stays with M6 acquisition.
- **Coverage CI:**
  - Each new model, route and sensor is owned in `feature-coverage.ts`.
  - Commerce → a new `commerce` CHANNEL feature; telephony → a new `telephony` CHANNEL feature.

---

## 12. Evidence matrix (required proofs × target level)

**Levels:**
- **CODE** = CODE-PROVEN (unit/static)
- **LAB** = LAB-PROVEN (PG17 + Production RLS + NOBYPASSRLS runtime + real routes)
- **PROD** = PRODUCTION-DEPLOYED (migration applied + read-only evidence)
- **REAL** = REAL-PROVIDER-PROVEN (a real provider event in Production for a real business)
- **EXT** = BLOCKED EXTERNALLY

A simulator or local server never yields REAL.

| # | Proof | Commerce target | Telephony target | How |
|---|---|---|---|---|
| E1 | Migration and schema exactly as recorded | PROD | PROD | release-migrate approved-prefix gate; preflight + post-check evidence SQL |
| E2 | FORCE RLS + per-command policies + no DELETE + no ctlplane grants | LAB → PROD | LAB → PROD | replay-rls lab; `prod-readonly-evidence` |
| E3 | Duplicate / redelivery / parallel deliveries → 1 receipt, 1 order or call row | LAB | LAB | battery: same payload ×N concurrently |
| E4 | Stale redelivery does not regress order status | LAB | n/a | battery: `updated` with an older `providerUpdatedAt` |
| E5 | Wrong business (connection of A, store id of B) → refused, nothing written | LAB | LAB | battery |
| E6 | Unknown store / DID / publicId → 401, nothing written | LAB | LAB | battery |
| E7 | Disabled feature / paused / revoked → refused or ignored as specified | LAB | LAB | battery |
| E8 | Signature failure (bad HMAC, bad JWT, expired timestamp) → 401 before parse | LAB | LAB | battery |
| E9 | Live-resource collision across businesses → 409 | LAB | LAB | battery |
| E10 | Customer identity: known phone → that Customer; new phone (commerce) → new Customer | LAB | LAB (known only) | battery |
| E11 | Uncertain identity → no attach + IdentityProposal; never an IdentityLink from a call | LAB | LAB | battery |
| E12 | Order ≠ Lead / Call ≠ Lead: zero `Lead`/`LeadLifecycleEvent`/`Deal` rows across every scenario | LAB → PROD | LAB → PROD | battery + post-activation evidence SQL |
| E13 | Secretary: missed call surfaces once, clears on return; refund exception surfaces | LAB | LAB | battery over `lead-briefing` |
| E14 | Learning without PII: sensor payload key scan + value scan for phone/email patterns | LAB | LAB | battery + `prod-readonly-evidence` |
| E15 | Attribution kept on the order/call row | LAB | LAB | battery |
| E16 | Provider failure → retry → recovery; WooCommerce reconciler catches a missed webhook | LAB | LAB | battery with the stubbed provider down, then up |
| E17 | Real provider event for a real business, end to end | **REAL** (needs a real store) | **REAL** (needs a real account; Voicenter contract) | owner-run runbook + read-only evidence |

**Today, every row is at level 0.** Nothing in M7 exists yet.

---

## 13. Migration plan

**One migration, `M7-A` (`<timestamp>_m7_commerce_telephony_foundation`, with a timestamp later than the newest migration on main when M7-A is built)**, applied only through the approved-prefix release gate after its own preflight. It contains:

1. The `AcquisitionConnection` CHECK widening (sourceKey + source_shape). Resolver functions are extended for the new sources.
2. **M-D2:** the Meta resolver accepts `ERROR` (leads are kept while a reconnect is pending).
3. The `IntakeNormalizedEvent.routeTarget` CHECK gains `call`.
4. Tables `CommerceOrder`, `CommerceOrderLine`, `CommerceOrderEvent` and `CallActivity`, with FORCE RLS, per-command policies, grants (runtime; no DELETE; INSERT/SELECT only on events) and indexes.
5. Feature catalog rows (OFF).

Additive only. No backfill. Rollback = leave the objects unused; the features stay OFF.

Evidence:
- `ops/evidence/m7-foundation-preflight.sql`, which proves the objects are absent and M6 is unchanged.
- `ops/evidence/m7-foundation-postcheck.sql`, which proves every E1/E2 item.

---

## 14. Implementation plan (four large milestones)

| Milestone | Content | Exit level | Owner gate |
|---|---|---|---|
| **M7-A Foundation** | Migration §13 + core `commerce` and `call` handlers + R9 + Secretary call reasons + sensors + coverage + Meta M-D1/D3/D4/D5 + a full battery (E2–E16 with a synthetic provider) | LAB, then PROD (applied, features OFF) | approve migration apply; approve deploy |
| **M7-B Commerce wave 1** | WooCommerce (key-authorize flow, HMAC webhook, content event identity, reconciler on the QStash schedule, webhook health) + Wix (app, OAuth, JWT webhook, 1,250 ms acknowledgement) + owner UI in Lead Sources → "Store" | LAB | owner creates the Wix app (developer account); owner enables one real store → E17 REAL |
| **M7-C Telephony wave 1** | CloudTalk (Svix) + Voicenter (CDR, per-connection key; HMAC/IP if Voicenter provides one) + "unknown callers" digest + callback closure | LAB | owner contacts Voicenter (signature, pricing, partner); owner enables one real account → E17 REAL |
| **M7-D Proof and release** | Production evidence SQL for E12/E14 after first activation; runbooks like M6 website | PROD + REAL per provider | each activation |

**Outside M7:** WhatsApp Embedded Signup v4 (§2.3): code ready as draft #690, blocked externally on Meta approvals; the Production switch needs a separate owner approval.

---

## 15. Owner decisions (only these)

| # | Decision | Owner decision (2026-10-06) |
|---|---|---|
| D1 | **WhatsApp Embedded Signup v4** | **Blocked externally** on Meta approvals; code ready as draft #690 (§2.3); Production switch not approved |
| D2 | Meta Lead Ads: go for Business Verification + Access Verification + App Review (`leads_retrieval`, `pages_manage_ads`, `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`, `ads_management`; not `business_management`), with the Login configuration on **System User** tokens | Business Verification and App Review are **in review**; Access Verification not started. The Dubiz M-D PR comes before Lead Ads activation |
| D3 | Google automatic setup (restricted `adwords` OAuth verification) | **APPROVED.** No for now; the manual webhook is the path |
| D4 | Commerce first wave = WooCommerce + Wix; Shopify in 1b (App Store review + Protected customer data Level 2 commitments) | **APPROVED** |
| D5 | Telephony first wave = CloudTalk (self-serve, provable) + Voicenter (after a commercial and signature confirmation from Voicenter) | **APPROVED**; Voicenter depends on its commercial and technical confirmation |
| D6 | Connection model = **extend `AcquisitionConnection`** (CHECK widening), not a new table | **APPROVED** |
| D7 | Orders do **not** move stock and do **not** write `FinancialEvent` / `BillingDocument` in wave 1 | **APPROVED** |
| D8 | Unknown caller → **no automatic Customer** (an owner act creates one); unknown buyer with a valid phone → Customer created (as with leads) | **APPROVED** |
| D9 | Recordings and transcription: out of M7, a separate capability after legal review | **APPROVED** |
| D10 | Apply the M7-A migration in Production, when its lab proofs are green | **NOT APPROVED.** Decided only after M7-A is built and proven in the lab |

---

## Final recommendation

```
GOOGLE  = MANUAL WEBHOOK PRODUCTION READY (429→503 fix in this PR); AUTO-SETUP BLOCKED BY GOOGLE (restricted adwords OAuth) — deferred; LIVE PROOF REQUIRES REAL BUSINESS
META    = DUBIZ CODE NEEDS ONE PR (long-lived token, ERROR-connection lead loss, revoke-paused, privacy copy); THEN BLOCKED BY META REVIEW (Business Verification + Access Verification + App Review Advanced Access) + OWNER CONFIG; WHATSAPP EMBEDDED SIGNUP v4 = code ready (draft #690), BLOCKED EXTERNALLY on Meta approvals
WEBSITE = WAITING FOR FIRST REAL BUSINESS
M7 COMMERCE FIRST WAVE  = WooCommerce + Wix eCommerce (Shopify wave 1b; Konimbo deferred)
M7 TELEPHONY FIRST WAVE = CloudTalk + Voicenter (Voicenter after a signature/commercial confirmation)
M7 READY FOR IMPLEMENTATION = YES — M7-A foundation (code + lab) on the approved D3–D9; Production apply and every provider activation remain owner gates
```
