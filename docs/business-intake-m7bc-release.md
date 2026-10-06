# M7-B / M7-C — Store and phone providers: release package

Status: **CODE + LAB-PROVEN**. No migration. No provider is activated. Every source stays OFF until the platform admin enables it for one business.

Built on the M7-A foundation (`docs/business-intake-m7a-release.md`) and the decision record (`docs/business-intake-m7-decision-v1.md` §§9–15).

## 1. What ships

| Area | Content |
|---|---|
| **WooCommerce** (`commerce.woocommerce`) | Key-authorize connect: the owner types only the store address. Dubiz sends the browser to the store's own `/wc-auth/v1/authorize` (scope `read_write`) with a **sealed state**: AES-GCM, AAD bound to kind + business + expiry, 30 min. The store POSTs its keys to `/api/integrations/commerce/woocommerce/callback` (answered exactly 200). Dubiz creates the store's three order webhooks with its own per-connection secret. Webhook endpoint `/api/intake/commerce/woocommerce/<publicId>`: base64 HMAC-SHA256 over the raw body **and** the `X-WC-Webhook-Source` host must equal the bound store. The creation ping gets 200 only for an existing endpoint. |
| **WooCommerce reconciler** | Runs in the intake sweeper (the QStash schedule), per business, inside its tenant job. **Webhook health:** re-activates a webhook the store disabled; if one was deleted, replaces the whole set (survivors removed, so no double delivery). **Polling:** `modified_after` the cursor minus 2 min, `dates_are_gmt`, oldest first, 3 pages per run. The cursor never passes an order that was not recorded. A store that is merely down stays ACTIVE (its webhooks must keep delivering). Revoked keys → ERROR `WOO_KEYS_REVOKED`, and ACTIVE again as soon as the store answers. Reconnecting the same store resumes from the previous cursor. |
| **Wix** (`commerce.wix`) | The Dubiz Wix app. The owner installs it from its install link, then confirms on `/settings/connections/wix`. Binding accepts **only Wix's signed `instance`** (HMAC with the app secret); a bare instance id is refused. Dubiz then checks it is a live installation: it mints a token via client credentials and `GET /apps/v1/instance` must return the same id. Webhook `/api/intake/commerce/wix`: the JWT is verified **RS256 only** with the app public key; one live mapping per instance; an unknown installation is acknowledged and skipped. Wix retries are deduped by the event id; out-of-order delivery is ordered by `entityEventSequence`. The reconciler searches orders updated after the cursor. Uninstall → ERROR `WIX_APP_UNINSTALLED`. |
| **CloudTalk** (`telephony.cloudtalk`) | The owner creates the endpoint, pastes it into CloudTalk (event `call.ended`), then saves CloudTalk's `whsec_` signing secret and an API key in Dubiz. Both are stored encrypted; only "saved ✓" flags are ever returned. Svix verification has a 5-minute window. The CloudTalk account (`company_id`) is bound on the first verified delivery; another account → 401, and one live mapping per account. The webhook has **no answered/missed field**, so the receipt is a reference and the outcome is read from CloudTalk's call history (`answered_at`). Without a valid key the call waits (deferred) and is never guessed. Line name → attribution `line:<name>`. |
| **Voicenter** (`telephony.voicenter`) | Voicenter documents no signature, so the endpoint URL is the credential: `/api/intake/telephony/voicenter/<publicId>/<dvk_ key>`, shown once and stored as a hash. Answers in Voicenter's format `{"Err":0,"Errdesc":"OK"}`. Direction comes from `direction`/`type`; outcome from `isAnswer`/`status`. Extensions (<7 digits) are never a person. Recordings and AI data are dropped. |
| **Owner UI** | Settings → Connections → **"חנויות ושיחות"** (`StoresAndCallsPanel`). Each source shows "בקרוב" unless enabled for the business (and, for Wix, unless the app is configured). Health codes appear in plain Hebrew. |
| **Secretary** | Exceptions only, per §10: a cancel or refund on an order of a known customer with an **open lead**, and a store or phone connection the owner must fix. There is never one item per order, and no amount, name or number. |
| **Customer card** | Store order history (status, total, refund) and calls (direction, outcome, returned or not), with no number or recording. |
| **Google Ads activation** | Separate PR #701 (manual webhook path, activation checklist, attribution kept for M8). |

**Invariants (battery-proven):**
- Order ≠ Lead; Call ≠ Lead; an unknown caller is not a Customer.
- No Deal, FinancialEvent, BillingDocument, inventory sale or stock movement.
- The tenant is only the trusted connection; a body naming another business changes nothing.

## 2. Lab results

| Suite | Result |
|---|---|
| `lib/intake/m7bc-core.test.ts` (no DB) | 18/18 |
| `.m7bc/battery.ts`: PG17, real M6 + M7-A migrations, Production RLS replayed, NOBYPASSRLS runtime, **real routes + registered adapters + sweeper**, providers stood in from their official contracts | 96/96 |
| `.m7a/battery.ts` (lab simulators now stand in for the registered keys) | 82/82 |
| `.m6/acquisition-battery.ts` | 116/116 |
| m7a / m6 / intake / identity / sensors / coverage / lead core suites | all pass |

**Battery coverage:**
- **Connect:** sealed-state forgery, read-only keys, the same store / installation / account claimed by another business, a feature OFF.
- **Webhooks:** ping, wrong secret, another store host, unknown endpoint, trash/draft, malformed.
- **Idempotency:** duplicates and parallel duplicates (6× / 4× / 5×); out-of-order delivery (Woo modification time, Wix sequence).
- **Reconciler:** missed-order recovery, disabled and deleted webhooks, store down, keys revoked then recovered, uninstall.
- **CloudTalk outcome:** deferred until a valid key, then missed or answered from the call history.
- **Voicenter:** JSON and form bodies, a call returned by an outbound call, wrong key, paused.
- **Secretary and customer card:** exceptions only (above).
- **Tenancy, PII:** B and C hold nothing; no PII in learning signals.

## 3. Migrations

**None in this PR.** All provider state lives in the existing encrypted credential bundle:
- WooCommerce: keys, webhook ids, cursor, Dubiz origin.
- Wix: cursor.
- CloudTalk: secret and API key.

Two design items need a schema change and are prepared separately as **one decision package**, stopped before Production:
- **Demand signals from orders.** `OfferingDemandSignal` PURCHASE needs a `COMMERCE` source value and an order-line reference; a line maps to an offering only on an exact single match.
- **Owner-defined business-line roles** ("campaign DID"). Today calls are labelled by CloudTalk's own line name, or by the DID's last 4 digits for Voicenter.

## 4. E17 — real-provider readiness

| Provider | What the owner obtains | Where it is configured (never in chat) | Then |
|---|---|---|---|
| **WooCommerce** | A real store on HTTPS (WooCommerce ≥ 3.x REST v3); the store admin approves Dubiz | Nothing to configure: the keys arrive by the store's callback and are stored encrypted | Admin enables `commerce_woocommerce` for the business (admin + MFA). Owner: Settings → Connections → WooCommerce → store address → approve. Proof = first real order + one reconciler run |
| **Wix** | A Wix developer account and the **Dubiz Wix app**: OAuth app; permissions to read eCommerce orders; webhooks for order created/updated/approved/canceled/payment; external dashboard page = `https://<prod>/settings/connections/wix` | Vercel **Production** env: `WIX_APP_ID`, `WIX_APP_SECRET`, `WIX_APP_PUBLIC_KEY` (PEM), `WIX_APP_INSTALL_URL` | Admin enables `commerce_wix`. Owner installs from the link and confirms. **UNVERIFIED, first thing checked:** that Wix passes the signed `instance` to the external dashboard page (binding stays closed otherwise), and the JWT algorithm (RS256 assumed; anything else is refused) |
| **CloudTalk** | A CloudTalk account (self-serve); a webhook subscription to `call.ended`; an API key | Entered by the owner in Dubiz (encrypted): the `whsec_` signing secret and the API key ID + secret | Admin enables `telephony_cloudtalk`. Proof = one missed and one answered real call |
| **Voicenter** | **Blocked on Voicenter.** Only they can confirm: CDR push authentication or source IPs, retry policy, `ivruniqueid` stability, content type, DID format, partner terms and pricing | The full CDR URL (with its key) is given to Voicenter Backoffice / support | Admin enables `telephony_voicenter` only after Voicenter's written confirmation. Nothing about their API was guessed beyond their public CDR page |
| **Google Ads** (PR #701) | A real Google Ads lead form | The owner pastes the Dubiz URL + key into the form's webhook integration and presses "Send test data" | Admin enables `acquisition_google_lead_forms`. Automatic OAuth setup stays blocked on the restricted `adwords` verification (D3) |

## 5. Production blast radius when merged + deployed (no activation)

- **Code only.** New routes answer 401 / 503 / "not enabled". The reconciler finds no store connection and does nothing.
- **Owner UI:** the panel shows every source as "בקרוב".
- **Customer card / briefing:** two extra empty sections (no rows exist).

**Rollback:** revert the PR. No data or schema involved.
