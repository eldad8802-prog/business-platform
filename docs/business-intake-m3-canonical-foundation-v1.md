# Business Intake M3 — Canonical Foundation (v1)

**Status:** implemented. Production activation is waiting on the owner's approval of migration `20260929090000_m3_canonical_intake`.
**Builds on:** M2 (`IntakeEvent` receipt ledger, WhatsApp intake stabilization; `docs/business-intake-m2-whatsapp-stabilization-v1.md`).
**Owns:** the highway. **Does not own:** the vehicles.
- M4 owns identity resolution.
- M5 owns the lead lifecycle.
- M6/M7 own the Meta, Google, telephony and commerce connectors.
- M8 owns attribution BI.

---

## 1. Why

M2 made WhatsApp intake durable and correct. But its identity was WhatsApp-shaped:
- `IntakeEvent.provider` was an enum with one value;
- `kind` was an enum of two WhatsApp event kinds;
- the processor was a `switch` over WhatsApp payload routes.

Every future source would have needed a migration just to exist, and would probably have grown its own ingestion path.

M3 makes the receipt provider-neutral and adds the layer M2 lacked: what Dubiz **understood** from an event, kept separately from what the provider **sent** and from what Dubiz **did**. It also turns the M2 lifecycle into one engine that every source shares.

## 2. The three layers

| Layer | Home | What it is | Lifetime |
|---|---|---|---|
| **Receipt** (evidence) | `IntakeEvent` | That the provider delivered event X, when, for which business and account, keyed for replay protection. | Kept. The payload is purged on completion. |
| **Normalized** (understanding) | `IntakeNormalizedEvent` | Contact **hints**, identity outcome, attribution, route target and outcome, result refs. | Kept. Contact hints are purged on completion unless identity is `unresolved`. |
| **Domain** (operational truth) | Customer / Conversation / Message / Lead / Document / … | What the business works with. | Owned by its domain. |

The layers never collapse into each other:
- The receipt never becomes a CRM record.
- The normalized record never holds message content.
- The domain never depends on the receipt existing.

## 3. The pipeline

```
provider request
   │  adapter: verify authenticity (signature / secret), parse, build receipt DRAFTS
   ▼
acceptIntake({ registry, sourceKey, accountRef, receipts })
   │  tenant ← adapter.resolveTenant(accountRef)   (trusted connection; a DB error THROWS)
   │  runTenantJob(businessId) → recordReceipts   (ON CONFLICT DO NOTHING)
   ▼
★ durability boundary: acknowledge the provider only AFTER this returns
   ▼
processIntakeEvent (provider-neutral; lib/intake/core/processor.ts)
   claim      lease via conditional UPDATE (one worker per event)
   adapter    registry.get(sourceKey); unknown source or undeclared family → dead-letter (payload KEPT)
   normalize  pure; failure → dead-letter (retrying cannot fix it)
              → IntakeNormalizedEvent (first record wins on retry)        lastStage = normalized
   route      adapter writes domain records IDEMPOTENTLY
              routed → PERSISTED + refs                                  lastStage = routed
              ignored → IGNORED (deliberate) · deferred → re-queued, attempt not counted
   enrich     optional, retry-safe (resume flag on a repeat run)
   complete   PROCESSED; payload purged; hints purged unless unresolved  lastStage = completed
   failure    retryable → FAILED with backoff (max 8), then terminal
              IntakeTerminalError → dead-letter now
```

The core (`lib/intake/core/*`) never names a provider. CI checks this (`intake-core.test.ts`, plus a negative proof).

## 4. The canonical contract (`lib/intake/core/contract.ts`)

### Receipt draft: what an adapter builds

| Field | Meaning |
|---|---|
| `family` | The stable business meaning: `MESSAGE`, `LEAD`, `FORM_SUBMISSION`, `CALL`, `COMMERCE`, `EMAIL`, `DOCUMENT`, `CUSTOM` (enum `IntakeEventFamily`). Adding a family is an architecture decision. |
| `eventType` | The adapter's finer type (`message.received`, `lead.submitted`, `call.missed`). A dotted lower-case identifier with a CHECK. **No migration per type.** |
| `externalEventId` + `dedupeBasis` | The deterministic receipt identity (§6). |
| `providerAccountRef` | The business's own account at the provider (a phone number id, page/form id, store id). Routing evidence, not a person. |
| `occurredAt` | Business time as the provider reports it. Null when absent or implausible, **never invented**. |
| `payload` | The minimal envelope needed to process the event. Personal data until processed, then purged. |
| `metadata` | Non-personal facts kept after the purge. |

A draft deliberately has **no `businessId`**. `sourceKey` is a registry key (`whatsapp`, `meta.lead_ads`, …), so a new source is code, not DDL.

### What an adapter implements (`IntakeAdapter`)

```ts
sourceKey, families, normalizerVersion        // "meta.lead_ads", ["LEAD"], "meta.lead_ads@1"
resolveTenant(accountRef) → businessId | null // trusted connection; THROWS on DB error
normalize(event) → NormalizedIntake | {code}  // pure, deterministic
route(ctx, normalized, event) → routed | ignored | deferred   // idempotent domain writes
enrich?(ctx, routed, event, resume)           // optional follow-up
listTenants?()                                // bootstrap reader for the sweeper
```

`IntakeTerminalError(code)` ends an event now. Any other thrown error is retried.

## 5. Trust boundary and tenant resolution

- **Authenticity** belongs to the adapter's route (HMAC signature, secret path, OAuth). The core never authenticates a provider.
- **The tenant** comes **only** from `adapter.resolveTenant(accountRef)`, a lookup of a *governed connection* (WhatsApp: `phone_number_id → WhatsAppConnection`).
  - `acceptIntake` has no `businessId` parameter.
  - A payload naming a business is ignored. The battery proves a payload claiming business B is recorded under the resolver's business A.
- **An unknown account** records nothing (`unknown_account`).
- **A resolver database error throws**, so the provider is not acknowledged and redelivers.
- **Every write is tenant-scoped.** Everything runs in `runTenantJob` / `withTenantTransaction`, where FORCE RLS decides which rows exist.
- The WhatsApp webhook keeps its proven M2 structure: its routing gate *is* the WhatsApp resolver, and it calls `recordReceipts(businessId, "whatsapp", …)` with the gate-resolved tenant.

**Future connections (an M6 gate).** A new connector needs a governed `accountRef → businessId` lookup that runs **before** a tenant context exists, as `WhatsAppConnection` does. That is a bootstrap (pre-context) read surface, which the security model lists explicitly (`docs/security-d2-provider-bootstrap-allowlist-v1.md`). M3 deliberately does **not** add a generic `IntegrationConnection` table. Adding such a pre-context surface is an owner security decision to take with the first real connector.

## 6. Event identity and idempotency (`event-identity.ts`)

- **`deriveEventIdentity({ providerEventId, accountScope? })`** returns `sha256(<id>)`, or `sha256(id␟scope␟<id>)` for providers whose ids are unique only per account. `dedupeBasis = provider_event_id`.
- **`deriveEventIdentity({ fingerprint: [...] })`** covers providers that send no id. The adapter **names** the canonical facts (e.g. form id + submission time + normalized email/phone). `dedupeBasis = content_fingerprint`, recorded on the receipt.
- **Neither an id nor a fingerprint** means `MissingEventIdentityError`. The receipt is refused; it is never keyed by something random (which would silently disable dedupe) or accidental (which would silently merge events).
- **DB-enforced:** a unique index on `(businessId, sourceKey, externalEventId)`.
  - The same id from two businesses, or from two sources, never collides.
  - A concurrent duplicate hits `ON CONFLICT DO NOTHING` (proven with 6 concurrent deliveries → 1 receipt).
- **WhatsApp keys are byte-identical to M2**, so a redelivery that straddles the deploy still dedupes.
- **Domain idempotency** is the adapter's route contract. For example, WhatsApp uses `Message(businessId, providerMessageId)` plus a per-sender advisory lock.

## 7. Lifecycle, retry and recovery

| State (trace) | Columns |
|---|---|
| received | `RECEIVED`, no live lease |
| processing | `RECEIVED`/`PERSISTED` with a live lease (`nextAttemptAt > now`, `lastAttemptAt` set) |
| retrying | `FAILED`, `nextAttemptAt` set |
| dead_letter | `FAILED`, `nextAttemptAt` null (attempts exhausted, terminal error, malformed, unknown source or family) |
| processed | `PROCESSED` (payload purged) |
| ignored | `IGNORED` (deliberate; the code says why) |

`lastStage` (`received → normalized → routed → completed`) says how far an event got. That separates "provider delivered" (the row exists), "durably received", "normalized" and "operationally routed".

- **Retry:** backoff of 30s, 2m, 10m, 30m, 1h, 3h, 6h, 12h, up to 8 attempts. A lease expires, so a crashed worker's event becomes due again.
- **Resumable:** a normalized record is reused, `route` is idempotent, and `enrich` gets `resume = true`.
- **Poison:** an event that always fails costs one attempt per drain and dead-letters. It never blocks other events, because each is claimed on its own (proven).
- **Engine:** one `drainIntake(registry, businessId)` and one sweeper (`runIntakeSweep`) for every source. Tenants come from each adapter's `listTenants()`.
- **Scheduling:** unchanged from M2. `.github/workflows/intake-sweep.yml` is `workflow_dispatch` only. **No Production cron was added.**
- **Replay:** a dead-lettered event keeps its payload for 30 days (`FAILED_PAYLOAD_RETENTION_MS`). An operator can replay it after a fix (e.g. once an adapter for an unknown source ships).

## 8. Normalization

- **Contact hints** (`contact.ts`) reuse the repository's canonical normalizers; M3 adds none:
  - phone → `normalizeCustomerPhone` (the one Customer, Lead, Party and M2 use; `Customer(businessId, phone)` is keyed on its output);
  - email → `isPlausibleEmail`, then `normalizeEmail` (trim + lower-case).
- A malformed hint is **dropped** and recorded as an `invalid` signal. It never blocks the event.
- **Timestamps:** implausible values become null.
- **Currency:** commerce adapters normalize to ISO-4217 plus integer minor units in their route. M3 fixes no commerce schema.

## 9. Attribution preservation (`attribution.ts`)

`IntakeAttributionV1` has these fields, all optional:
- `channel`, `source`, `provider`;
- `campaign`/`campaignId`, `adSet`/`adSetId`, `ad`/`adId`, `form`/`formId`;
- `landingPage`, `utm{source, medium, campaign, content, term}`;
- `clickId`, `referralSourceType`, `referralSourceUrl`, `headline`, `firstTouchAt`.

Sanitizing rules:
- URLs keep **origin + path**. `utm_*` values are lifted; every other query string and fragment is dropped, because they carry emails, phones and tokens.
- Values are bounded and control characters stripped.
- Unknown keys are dropped.
- An empty attribution is `null`.

It is stored on `IntakeNormalizedEvent.attribution` and **retained** for M8. WhatsApp click-to-WhatsApp referrals map in as `adId`, `clickId`, `referralSourceUrl` and `headline`; the ad body is still dropped.

## 10. Identity boundary (the interface for M4)

`identityOutcome` is one of:
- `none`: no contact signal (e.g. a delivery receipt).
- `delegated`: the destination resolved the contact by its own existing deterministic rule (WhatsApp: phone → Customer inside `ingestInboundCustomerMessage`). Hints are purged on completion.
- `unresolved`: hints are **kept** for M4 to turn into an owner proposal. Nothing is merged.

M3 performs **no identity resolution**:
- it does not auto-merge;
- it creates no Party;
- it creates no irreversible link.

The existing Party engine is **not** wired in, because its behavior does not meet the frozen Business Intake identity policy. `signals` records non-personally which hints were present and valid, so M4 can decide strength: a provider id is strong within its scope, a phone is strong, an email is a candidate.

## 11. Routing boundary

The route targets are `conversation`, `message_status`, `lead`, `customer`, `commerce`, `document`, `attention` and `none`. The adapter decides the target in `normalize()` from **deterministic provider semantics**. The domain decides what a record becomes. Frozen rules:
- A WhatsApp message goes to `conversation` and is **never a Lead**. A future classifier or owner workflow may *propose* one.
- An explicit provider Lead or Form event may route to `lead`.
- An order goes to `commerce` (plus a contact); it is **never a Lead**. An abandoned checkout may later become a commerce opportunity.
- A document goes to `document`. The documents intake stays authoritative for documents.
- **BusinessProfile** (`category`, `subCategory`, `businessModel`) is available to a future routing *policy*, but it **never overrides provider truth**: a provider-confirmed order stays an order.
- **AI** never decides the tenant, authenticity, identity merges or explicit event semantics. M3 adds no LLM call.

## 12. Privacy policy

| Data | Where | Kept |
|---|---|---|
| Message text, sender number, profile name | receipt `payload` | until processed or ignored (exhausted failures: 30 days) |
| Normalized phone / email / name / provider user id | `contactHints` | until completion, unless `unresolved` (then until M4 resolves or the business is erased) |
| Which hints were present and valid | `signals` | kept (non-personal) |
| Campaign / ad / form / utm / landing path | `attribution` | kept (sanitized) |
| Domain ids | `resultRefs`, receipt pointers | kept (erasure nulls them) |
| Tokens, secrets, raw provider bodies | nowhere | never stored |

- **Message bodies** are not duplicated: the text lives in `payload` until `Message` holds it.
- **Account erasure:** `IntakeEvent` has its payload, metadata, account ref and pointers nulled. `IntakeNormalizedEvent` has `contactHints`, `attribution` and `resultRefs` nulled. The manifest, the adapter and the coverage ratchet are updated, and the baseline check reports 0 new findings.
- **Learning:** `INTAKE_EVENT_SETTLED` carries source, family, event type, outcome, route target, identity outcome, attempts and latency. It goes through the sensor catalogue's PII guard, so there is **no content and no contact value**.

## 13. Observability

- **Logs:** `logIntake(event, fields)` prints `[intake] accepted|processed|ignored|deferred|failed|dead_letter` from an **allow-list** of fields: ids, source, family, eventType, stage, outcome, routeTarget, identityOutcome, attempt, a bounded code, durationMs and resultKinds. Anything else is dropped before printing.
- **Read model:** `traceIntakeByProviderEvent(businessId, sourceKey, { providerEventId, accountScope })` answers "Meta says it delivered X — what happened?". It returns state, stage, attempts, the bounded error code, timestamps, route, result ids and attribution.
  - It never returns payload, hints or content.
  - It is tenant-scoped: the repository has no operator role that may read tenant intake (no `p7adm_read` policy on intake tables), so **no cross-tenant endpoint was added**.
  - A support endpoint can wrap it once such a role is approved.

## 14. Schema (migration `20260929090000_m3_canonical_intake`)

- **`IntakeEvent` gains:** `sourceKey`, `family`, `eventType`, `dedupeBasis`, `lastStage`.
  - `provider` and `kind` become nullable (legacy).
  - CHECK vocabularies are added.
  - New unique indexes on `(businessId, sourceKey, externalEventId)` and on `(businessId, id)`, the composite-key target.
- **New `IntakeNormalizedEvent`:**
  - a composite FK `(businessId, intakeEventId) → IntakeEvent(businessId, id)`, so it cannot reference another business's receipt even with a forged id;
  - FORCE RLS with per-command SELECT/INSERT/UPDATE policies;
  - `GRANT SELECT, INSERT, UPDATE` plus `REVOKE DELETE, TRUNCATE`.
- **Compatibility with the M2 code still running** (migration-first):
  - the backfill uses the repo's FORCE-RLS-safe pattern;
  - a `BEFORE INSERT` trigger fills `sourceKey`/`family`/`eventType` for M2-shaped inserts;
  - the M2 unique index stays.
  - A later contract migration may drop the trigger and the legacy columns.
- **CI proof:** in `m3-business-intake-ci.yml`, the real file is applied to a pre-M3 database that holds M2-shaped rows. The run proves the backfill, the trigger, the CHECKs, the unique index, the composite FK, the grants, RLS and no drift against `schema.prisma`.

## 15. How to add a connector

1. **Authenticity:** a route that verifies the provider and parses the body. No business logic.
2. **Resolver:** a governed `accountRef → businessId` connection (§5), with an owner security decision if it is a new pre-context surface.
3. **Adapter** (`lib/intake/<source>/…`): `buildReceipt` (family, eventType, identity per §6, occurredAt, minimal payload, non-personal metadata), then `normalize` (hints via `normalizeContactHints`, attribution via `sanitizeAttribution`, identity outcome, target), then an idempotent `route`, then an optional `enrich`.
4. **Register** it in `lib/intake/sources.ts`, and nowhere else.
5. **Acknowledge only after** `acceptIntake` returns. On a thrown error, answer so the provider retries.
6. **Tests:** the adapter's unit tests plus a battery modeled on `.m3/intake-foundation-battery.ts` (duplicate, concurrent, cross-tenant, retry, dead-letter).

### Examples

| Source | accountRef → resolver | family / eventType | identity | target | notes |
|---|---|---|---|---|---|
| **WhatsApp** (live) | `phone_number_id` → WhatsAppConnection | MESSAGE / `message.received`, `message.status` | wamid (M2-identical) | conversation / message_status / document / none | identity `delegated`; CTWA → attribution |
| **Meta Lead Ads** | page id or form id → Meta connection | LEAD / `lead.created` | `leadgen_id` (scope: page) | lead | fetch fields server-side; campaign/adset/ad/form ids → attribution; identity `unresolved` |
| **Google Lead Form** | form or campaign id → Google connection | LEAD / `lead.submitted` | `lead_id` (scope: form) | lead | `gcl_id` → clickId; the webhook key is verified in the route |
| **Phone / missed call** | dialed number → telephony connection | CALL / `call.missed`, `call.completed` | provider call id (scope: account) | attention (missed) or customer | the caller number is a phone hint; recordings are never stored in the payload |
| **E-commerce order** | store id → store connection | COMMERCE / `order.created`, `checkout.abandoned` | order id (scope: store) | commerce (+ contact) | **never a Lead**; currency to ISO-4217 + minor units; an abandoned checkout may become a commerce opportunity |

## 16. Proof index

| Suite | Proves |
|---|---|
| `lib/intake/core/intake-core.test.ts` | Identity, attribution, contact, registry, lifecycle states, log allow-list, core neutrality |
| `.m3/intake-foundation-battery.ts` (PG17, real migration, NOBYPASSRLS) | Migration mechanics, exact grants, RLS, tenant resolution, idempotency incl. concurrency, the failure matrix, identity and privacy boundaries, trace, second-family neutrality |
| `.m2/whatsapp-intake-battery.ts` | Every M2 guarantee, now through the core, plus the WhatsApp normalized record and signal |
| W4A / W4B / AD-2A | Isolation from the real migrations; AD-2A declares the new table |
| erasure contract | Manifest ↔ adapter ↔ coverage, 0 new findings |
