# Business Intake M6 — First-wave acquisition connectors (v1)

Status: built and proven in CI; **every source OFF**; migration `20261009090000_m6_acquisition_connections` awaits the owner gate (#612 process). Code: #630. Migration: #627.

## 1. What M6 does

A business connects an acquisition source; real leads from it enter the same brain as every other lead — Business Intake (M3) → identity (M4) → the canonical Lead and its lifecycle (M5) → Secretary → learning — with the source kept as context and attribution, never as a separate CRM.

## 2. First wave (frozen against the official documentation, 2026-10-04)

| Source | Official mechanism | Multi-tenant onboarding | Classification |
|---|---|---|---|
| **Website form** | Dubiz endpoint per connection | Owner creates an endpoint in Dubiz | **LIVE-capable** (enable per business) |
| **Google Ads lead form** | Lead form "Webhook integration": URL + key; JSON POST with `google_key` (no signature); 200 `{}`; 5xx retried (developers.google.com/google-ads/webhook) | Owner pastes the Dubiz URL + key into the lead form (official, no Google approval). Automatic setup via the Google Ads API (`LeadFormAsset.delivery_methods`) needs a developer token (Basic+) and restricted-scope OAuth verification | **LIVE-capable** via the advertiser-configured webhook; API onboarding **EXTERNALLY BLOCKED** |
| **Meta Lead Ads** (Facebook + Instagram lead ads — Instagram leads belong to the Page) | Page subscribed to `leadgen`; signed notification (X-Hub-Signature-256); answers read with `GET /{leadgen_id}` and the Page token (Graph v25) | Facebook Login for Business → owner picks a Page (ADVERTISE task) → Dubiz subscribes it | **READY-BUT-EXTERNALLY-BLOCKED**: App Review (Advanced Access: `leads_retrieval`, `pages_manage_metadata`, `pages_read_engagement`, `pages_show_list`, `ads_management` + deps), Business Verification, privacy policy + data-deletion URL. Dev mode serves app-role users only |
| Google Local Services Ads | API polling (`local_services_lead`), developer token | — | Not in the first wave |
| Google Business Profile chat | Shut down 2024-07-31 | — | **NOT-SUPPORTED** |

No connector fakes a provider: Meta's Graph read is stubbed only in tests (a hook refused in production).

## 3. One connector architecture

```
provider payload ─adapter─▶ AcquisitionLeadV1 ─▶ receipt (family LEAD, deduped) ─acceptIntake─▶ IntakeEvent
   ─ACK─▶ processor: [hydrate] ─▶ normalizeAcquisitionLead (one normalizer) ─▶ M4 identity ─▶ R4
   ─▶ routeToLead ─▶ Lead + lifecycle "created" + Secretary + sensors
```

* `lib/intake/acquisition/canonical.ts` — the ONE canonical lead; per fact `supplied | not_supplied | not_applicable`.
* Adapters (`providers/*`) only parse their provider. After the adapter boundary nothing knows the provider.
* Core additions (provider-neutral): `IntakeAdapter.hydrate` (a notification-only provider completes its receipt before the pure normalize; retry / defer / dead-letter), `NormalizedIntake.leadIntent` → `Lead.intentSnapshot`.
* No new queue, retry or CRM: durability, idempotency, backoff, dead-letter, the sweeper, identity, routing and the Lead are M2–M5's.

## 4. Tenant model (security boundary)

`AcquisitionConnection` (FORCE RLS, no DELETE policy) binds a provider resource to ONE business, created only by the owner:

* Meta — Page id (inside Meta's signed body) → business; one LIVE mapping per Page (partial unique index).
* Google / website — an opaque random endpoint id + a shared key stored only as sha256.

Inbound requests resolve ONLY through four SECURITY DEFINER lookups (equality on a unique value, ids only). A request's own `businessId` (or anything else in it) is never trusted; an unknown endpoint / Page, a paused or revoked connection, a source OFF for the business, or a quarantined business → nothing is written. No default tenant exists.

## 5. Delivery

2xx only after the receipt is durable; a DB failure → 5xx → the provider retries; the unique `(business, source, externalEventId)` makes any redelivery (including parallel) a no-op. Meta: token invalid / permission missing → the receipt is **deferred** (the connection turns ERROR for the owner) and processed after reconnect — Meta keeps leads ~90 days. Google `is_test` → recorded, never a Lead.

## 6. Attribution (for M8)

`IntakeNormalizedEvent.attribution` (IntakeAttributionV1): provider, platform, campaign / ad set / ad / form ids and names, click id (gclid), UTM, landing page (origin + path only), first touch. Receipt metadata (kept after the payload purge, non-personal): ids, provider, test flag, fact status, answer count. Person-level history across sources is reconstructable through M4 identity (`identityCustomerId`).

## 7. Secretary and learning

* The Secretary's lead card: "נכנסו היום 7 לידים חדשים · 3 מפייסבוק/אינסטגרם, 2 מגוגל, 2 מהאתר" — a line on the existing card; no new inbox, no notifications.
* `LEAD_LIFECYCLE_STARTED` v2 carries `intakeSource` (closed vocabulary). No PII in learning (asserted by the battery).

## 8. Threat model

| Threat | Control |
|---|---|
| Forged webhook | Meta: HMAC-SHA256 over the raw body, constant-time; Google / web: key hash match |
| Replay / duplicate | Receipt idempotency per provider id and connection; parallel-safe |
| Tenant spoofing | Tenant only from the definer lookup; request fields ignored |
| Cross-tenant mapping | One live mapping per Page; RLS on every table; B's context cannot see / change A's state (battery) |
| Stolen / leaked key | Keys never stored (hash only); rotate / revoke; per-business and per-IP rate limits |
| Stolen Page token | AES-256-GCM with row-bound AAD, own key; header not URL; `appsecret_proof` |
| Stale / revoked token | Deferred, connection ERROR, retried after reconnect |
| Malformed / oversized | Strict parsers; body caps (web 32 KB, Google 64 KB, Meta 512 KB) |
| Bot spam (browser forms) | Exact origin allowlist, honeypot, per-IP limits |
| PII in logs / evidence | Allow-listed intake logger; no payload logged; evidence counts only |
| Unauthorized connect / disconnect | Owner session + feature gate; RLS confines every action |
| Owner loses provider authorization | Connection ERROR, visible to the owner, leads deferred not lost |
| Erasure | Account erasure revokes connections in place, clears token + label; payloads purged; attribution nulled |

## 9. Owner decisions / external blockers

1. Approve and apply the migration (#627) through the #612 gate.
2. Provide env (none read until a source is enabled): `ACQUISITION_CREDENTIAL_ENCRYPTION_KEY`, `META_LEAD_ADS_APP_SECRET`, `META_LEAD_ADS_VERIFY_TOKEN`.
3. Meta: App Review + Business Verification + data-deletion URL; subscribe the app's webhook to `/api/intake/acquisition/meta`.
4. Google API onboarding (optional): developer token + restricted-scope verification.
5. Enable a source for a real business (platform-admin feature override).
6. Owner-facing connect UI (settings) — the API is complete; a UI pass is the next increment.
