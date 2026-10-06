# Business Intake M6 — First-wave acquisition connectors (v1)

Status: built and proven in CI; **every source OFF**; migration `20261009090000_m6_acquisition_connections` awaits the owner gate (#612 process). Code: #630. Migration: #627.

## 1. What M6 does

A business connects an acquisition source; real leads from it enter the same brain as every other lead — Business Intake (M3) → identity (M4) → the canonical Lead and its lifecycle (M5) → Secretary → learning — with the source kept as context and attribution, never as a separate CRM.

## 2. First wave (frozen against the official documentation, 2026-10-04)

| Source | Official mechanism | Multi-tenant onboarding | Classification |
|---|---|---|---|
| **Website form** | Dubiz endpoint per connection | Owner creates an endpoint in Dubiz | **LIVE-capable** (enable per business) |
| **Google Ads lead form** | Lead form "Webhook integration": URL + key; JSON POST with `google_key` (no signature); 200 `{}`; 5xx retried (developers.google.com/google-ads/webhook) | Owner pastes the Dubiz URL + key into the lead form (official, no Google approval). Automatic setup via the Google Ads API (`LeadFormAsset.delivery_methods`) needs a developer token (Explorer or higher reaches production accounts — access-levels page, 2026-09-30) and **OAuth app verification of the restricted `adwords` scope** (the hard gate). 4xx is never retried by Google, so a rate-limited lead is answered 503 (see docs/business-intake-m7-decision-v1.md §1) | **LIVE-capable** via the advertiser-configured webhook; API onboarding **EXTERNALLY BLOCKED** |
| **Meta Lead Ads** (Facebook + Instagram lead ads — Instagram leads belong to the Page) | Page subscribed to `leadgen`; signed notification (X-Hub-Signature-256); answers read with `GET /{leadgen_id}` and the Page token (Graph v25) | Facebook Login for Business → owner picks a Page (ADVERTISE task) → Dubiz subscribes it | **READY-BUT-EXTERNALLY-BLOCKED**: App Review (Advanced Access: `leads_retrieval`, `pages_manage_ads`, `pages_manage_metadata`, `pages_read_engagement`, `pages_show_list`, `ads_management`), Business Verification, Access Verification (Tech Provider), privacy policy + data-deletion URL, app in Live mode. Dev mode serves app-role users only. Decided list: docs/business-intake-m7-decision-v1.md §2.2 |
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

**Durable retry.** The existing intake sweeper (`/api/intake/sweep`, CRON_SECRET) runs every 10 minutes from `.github/workflows/intake-sweep.yml` (protected `cron` environment, main-only — the same shape as payment settlement recovery), with a daily Vercel cron (GET) as backstop. Each receipt is claimed under a lease (one worker per receipt), so overlapping runs are safe; every write is keyed by the receipt; each tenant is entered server-side under its own RLS context. Before any retry the adapter re-checks the receipt's connection: a **revoked** connection settles the receipt IGNORED (`connection_revoked`) — no Lead, no provider call. Failures are visible as receipt status + code, the run's counts in the workflow summary, and a red run when any business fails (battery §9).

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

## 9. Owner experience (Settings → חיבורים → מקורות לידים)

One panel, three sources, no ids / tokens / developer terms:

* **טופס באתר** — optional site address → "חיבור טופס" → the address and a secret code, shown **once**, plus "העתקת הוראות למפתח" (the exact technical text for whoever built the site). Per form: last lead time, "קוד חדש", "השהיה / הפעלה", "ניתוק".
* **Google Ads** — "חיבור Google Ads" → address + key, shown once, with the three steps in Google Ads (Webhook integration → paste → "Send test data"; the test never becomes a Lead).
* **Facebook ו-Instagram** — shown as "ממתין לאישור של Meta" until Dubiz's Meta app is approved and configured (`meta.available`). Then "התחברות עם Facebook" (Facebook Login for Business, code flow) → choose a Page → connected; a connection whose token Meta revoked shows "דורש חיבור מחדש" with a reconnect button. The browser never holds a usable Meta token: the server exchanges the login code and returns only a sealed, business-bound, 10-minute handle.
* A source not switched on for the business is shown as "בקרוב".

## 10. Environment

| Variable | Who creates it | Where | Needed now (all sources OFF)? |
|---|---|---|---|
| `CRON_SECRET` | exists | Vercel Prod + GitHub `cron` env | already set — the retry schedule uses it |
| `ACQUISITION_CREDENTIAL_ENCRYPTION_KEY` | **Dubiz** (32 random bytes, hex/base64) | Vercel Prod only | only before connecting Meta (encrypts Page tokens). Never rotate without a re-encrypt plan. |
| `META_LEAD_ADS_VERIFY_TOKEN` | **Dubiz** (random string) | Vercel Prod + typed once in the Meta app's Webhooks (object `page`) | only before Meta |
| `META_LEAD_ADS_APP_SECRET` | **Meta** (App Dashboard → Settings → Basic) | Vercel Prod only | only before Meta; **not needed** when Lead Ads uses the same app as WhatsApp — it falls back to `WHATSAPP_APP_SECRET` |
| `NEXT_PUBLIC_META_LEAD_ADS_CONFIG_ID` | **Meta** (Facebook Login for Business → Configurations) | Vercel Prod | only before Meta; public, not a secret |
| `META_APP_ID` / `NEXT_PUBLIC_META_APP_ID` | Meta | exists | already set (WhatsApp) |

Website forms and Google lead forms need **no** new variable. Secrets are entered by the owner directly in Vercel / GitHub — never pasted in chat, logs or evidence.

## 11. Meta Lead Ads — readiness checklist (nothing here is changed without a separate owner approval)

Done now, no Meta change: the code, the webhook endpoint, signature verification, the deferred-until-reconnect path, the owner UI (hidden until available), the privacy / data-deletion pages (exist: `/privacy`, `/data-deletion`).

Requires an owner action in Meta (blocked until then):

1. **Business Verification** of the business that owns the Dubiz app (Business Settings → Security Center).
2. **App Review — Advanced Access** for `leads_retrieval`, `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata` (subscribe the Page to `leadgen`), `pages_manage_ads`, `ads_management`. `business_management` is **not** requested in v1 (only if review or a portfolio-owned Page demonstrably needs it). Also required: Access Verification (Tech Provider) and the app in Live mode. Decided list and the Dubiz fixes required before activation: docs/business-intake-m7-decision-v1.md §2.
3. **Facebook Login for Business configuration** requesting exactly those permissions → its id is `NEXT_PUBLIC_META_LEAD_ADS_CONFIG_ID`.
4. **Webhooks**: object `page`, field `leadgen`, callback `https://promaxgroup.co.il/api/intake/acquisition/meta`, verify token = `META_LEAD_ADS_VERIFY_TOKEN`.
5. **App settings**: Privacy Policy URL (`/privacy`), User data deletion → instructions URL (`/data-deletion`), app icon, category, contact email. Both pages should name lead-form answers explicitly (today they describe WhatsApp / CRM data) — a text change for owner approval.
6. **Screencast per permission**: owner logs in → Settings → מקורות לידים → "התחברות עם Facebook" → chooses a Page → a test lead from Meta's Lead Ads Testing Tool arrives in Leads with its answers and campaign → "ניתוק". Test Page and test lead only — never a real customer.
7. Per advertiser, after approval: if the Page restricts lead access, the Page owner grants Dubiz access in **Leads Access Manager**.

## 12. Owner decisions / external blockers

1. Release order: the P3-A migrations (#635) are pending ahead of M6 in Production; M6 is applied through the #612 gate only after them.
2. Enable a source for a real business (platform-admin feature override) — not yet approved.
3. Meta: §11.
4. Google API onboarding (optional; not needed for webhooks): developer token + restricted-scope verification.
