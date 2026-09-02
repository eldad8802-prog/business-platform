# CASA 7.2 — Dormant Payment Provider Closure Evidence (PayPal, Tranzila)

**Wave:** CASA Wave E.
**Implementation merged:** PR #327, merge commit `b8abaed`.
**Main / Production SHA at time of writing:** `9bbf68e`.
**Production deployment:** `dpl_39ANAPRTePHU6MKLYhMs1mfYAxQ6`, READY, git-triggered, holding `promaxgroup.co.il`.
**Date:** 2026-09-02.

**Scope of this document:** evidence preservation only. It records that PayPal
and Tranzila are no longer active webhook consumer capabilities in the assessed
production application. It does **not** claim that their former webhook
verification became compliant.

No secret material appears in this memo: no credential, token, callback secret,
payload or key.

---

## 1. Control objective

CASA 7.2.1 requires webhook payloads to be authenticated with HMAC-SHA256 or
stronger, verified against the raw request body, with missing or mismatched
signatures rejected. The specification is explicit that a static API key in a
header is not sufficient. CASA 7.2.2 requires signature comparison to use a
timing-safe function rather than a standard equality operator.

Dubiz had three payment webhook consumers. CardCom is the live one and is
handled separately (see §6 and §9). PayPal and Tranzila were **live,
unauthenticated, internet-reachable endpoints** whose entire verification was a
static token compared with `===`, and both answered HTTP 200 to any POST.

Two options existed: build cryptographic verification for them, or stop
offering them. A fresh production census (§2) showed **neither provider had ever
been used** — zero rows in every provider-keyed table. Inventing HMAC
verification for an integration nobody has, and which the providers as
integrated do not offer, would have produced a compliance artefact rather than a
security outcome. The capability was removed from the assessed surface instead.

One consequence shaped the design and is worth stating plainly: **disabling the
webhook alone would have been worse than doing nothing.** Tranzila's connect
route was live, the settings card was mounted, and Tranzila was the
pre-selected option. A business could have connected it, taken a real payment,
and never received the callback that confirms it. Closing the capability
therefore had to close the connect path and the catalogue at the same time.

---

## 2. Pre-remediation production truth

Established by direct read-only census of the production database immediately
before implementation, across every table carrying a `provider` column —
`BusinessPaymentConnection`, `PaymentRequest`, `PaymentTransaction`,
`PaymentWebhookEvent`, `PaymentProviderRouting`.

### PayPal

| Fact | Value |
| --- | --- |
| `BusinessPaymentConnection` rows | **0** |
| `PaymentRequest` rows | **0** |
| `PaymentTransaction` rows | **0** |
| `PaymentWebhookEvent` rows | **0** |
| Rows in any provider-keyed table | **0** |
| Connect API route | **none** — `POST /api/payments/connections/paypal` returned 404; no such route existed |
| Production credentials | **none** — the adapter reads `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` / `PAYPAL_WEBHOOK_ID` from server env; none were configured |
| Webhook | **previously reachable** and answering HTTP 200 |

PayPal was therefore dormant **and structurally un-connectable**.

### Tranzila

| Fact | Value |
| --- | --- |
| `BusinessPaymentConnection` rows | **0** |
| `PaymentRequest` rows | **0** |
| `PaymentTransaction` rows | **0** |
| `PaymentWebhookEvent` rows | **0** |
| Rows in any provider-keyed table | **0** |
| Connect capability | **previously live** — `POST /api/payments/connections/tranzila` functional for an authenticated business |
| Settings UI | **previously exposed it** — the card is mounted at `app/settings/connections/page.tsx` |
| Default selection | **previously Tranzila** — `useState<ProviderKey>("TRANZILA")` |
| Credentials | user-supplied (`merchantId` + credential), so no operator action was needed to connect |
| Webhook | **previously reachable** and answering HTTP 200 |

Tranzila was therefore dormant in data but **live as a capability**.

### CardCom

The active provider: 1 active connection, 3 `PaymentRequest` rows (2
non-terminal), 1 `PaymentTransaction`, 2 `PaymentWebhookEvent` rows.
**Explicitly outside Wave E remediation** — no CardCom implementation file was
modified.

---

## 3. Implemented controls

A single capability switch,
[`lib/services/payments/providers/provider-availability.ts`](../lib/services/payments/providers/provider-availability.ts),
declares `DISABLED_PAYMENT_PROVIDERS = ["PAYPAL", "TRANZILA"]` and is consumed
at three chokepoints.

### PayPal

- **Callback refused upstream of `processPaymentWebhook`** in
  [`payment-webhook-handler.ts`](../lib/services/payments/payment-webhook-handler.ts).
- **No active connect capability** — there is no PayPal connect route, and the
  provider is absent from the catalogue that feeds the settings UI.

### Tranzila

- **Callback refused upstream of processing**, identically.
- **Connect disabled server-side** in `connectProviderFromDescriptor`
  ([`payment-connection.service.ts`](../lib/services/payments/payment-connection.service.ts)).
- **Direct descriptor path gated** — that function is the single code path used
  by the generic connect route *and* both backward-compatible per-provider
  wrappers, so a direct API call is refused exactly as a UI-driven one is.
- **Removed from the selectable UI catalogue** —
  `listProviderDescriptors()` in
  [`provider-registry.ts`](../lib/services/payments/providers/provider-registry.ts)
  now returns enabled providers only, and
  [`PaymentConnectionCard.tsx`](../components/settings/PaymentConnectionCard.tsx)
  renders its options from `SELECTABLE_PROVIDERS`, which contains `["CARDCOM"]`.
- **CardCom is the only selectable provider**, and the card's default selection
  moved from `TRANZILA` to `CARDCOM`.

Disabled is not deleted. Adapters, descriptors, credential shapes and the Prisma
enum values all remain, and `listAllProviderDescriptors()` was added so the full
set stays available for interpreting historical records.

### Why `DEFAULT_PROVIDER` was deliberately NOT changed

`payment-connection.service.ts` contains `const DEFAULT_PROVIDER:
PaymentProvider = "TRANZILA"`. It was audited before acting and left unchanged.

Its **only** consumer is the fallback `input.provider ?? DEFAULT_PROVIDER`
inside `connectPaymentProvider`. Every production connect route — the generic
one and both wrappers — reaches connect through `connectProviderFromDescriptor`,
which always passes `descriptor.key` explicitly. The fallback is therefore
**never evaluated in production**; its only live consumers are unit tests that
omit the field.

It is consequently **not a reachable production provider-selection bypass**: no
production request can arrive at `connectPaymentProvider` without an explicit
provider, and any request that did specify a disabled provider is refused by the
gate one level above.

Repointing the constant to CardCom was rejected for two reasons. It would have
silently changed what several existing tests exercise, and it would have created
a genuine hazard: a caller omitting `provider` while supplying another
provider's credentials would have had a CardCom connection created for them.
Future-proofing is handled structurally instead — an automated guard asserts
that no connect route calls the ungated helper directly (§8).

---

## 4. Fail-closed behaviour

Verified against the live production deployment with harmless synthetic
callbacks carrying no credentials.

| Endpoint | Result |
| --- | --- |
| `POST /api/payments/webhook/paypal` | **HTTP 404** — `{"ok":false,"error":"provider_not_supported"}` |
| `POST /api/payments/webhook/tranzila` | **HTTP 404** — `{"ok":false,"error":"provider_not_supported"}` |
| `POST /api/payments/webhook/paypal` via the generic `/[provider]` route | **HTTP 404** — same body |
| `POST /api/payments/webhook/tranzila` via the generic `/[provider]` route | **HTTP 404** — same body |
| `POST /api/payments/webhook/cardcom` (control) | **HTTP 200** — `{"ok":true}` |

**Structural ordering.** The refusal is not a branch inside processing; it is
positioned before it. In the deployed source, the capability check returns at
**line 39** of `payment-webhook-handler.ts`, and `processPaymentWebhook` is
first called at **line 43**. Nothing downstream of that return can execute:

- the payload is never parsed,
- no provider adapter is resolved and no provider verification is invoked,
- no `PaymentWebhookEvent` can be persisted,
- no `PaymentRequest` can be mutated,
- no `PaymentTransaction` can be created or updated,
- no `FinancialEvent` can be created or updated.

The response is deliberately **404 rather than the usual `200 { ok: true }`**.
The 200-always convention exists to avoid provider retry storms for a live
integration; returning it here would assert a processing outcome for a
capability that no longer exists.

---

## 5. Production mutation proof

Row counts taken before the Wave E merge and again after the synthetic
callbacks above. Identical in every table, with every newest-record timestamp
still dating from July:

| Table | Before | After | Newest record |
| --- | --- | --- | --- |
| `PaymentWebhookEvent` | 2 | **2** | 2026-07-06T15:02:10.933Z |
| `PaymentRequest` | 3 | **3** | 2026-07-06T11:04:40.920Z |
| `PaymentTransaction` | 1 | **1** | 2026-07-02T13:57:06.347Z |
| `BusinessPaymentConnection` | 1 | **1** | 2026-07-02T12:49:20.520Z |
| `FinancialEvent` | 1 | **1** | 2026-07-02T13:57:06.443Z |

**Zero PayPal rows and zero Tranzila rows**, before and after, in every one of
these tables.

The synthetic callbacks therefore caused **zero database mutation**. No
credential, token or sensitive payload was used in any probe, and none is
recorded here.

---

## 6. CardCom regression proof

Read-only verification at the same moment:

| Fact | Value |
| --- | --- |
| Active CardCom connection | **1** |
| CardCom `PaymentRequest` rows | **3** |
| Non-terminal `PaymentRequest` rows | **2** — unchanged and untouched |
| `PaymentTransaction` | **1** |
| `PaymentWebhookEvent` | **2** |
| CardCom implementation | **unchanged** — `lib/services/payments/providers/cardcom/` is byte-identical between the pre-Wave-E baseline and current main; zero CardCom files appear in the Wave E merge commit |
| CardCom callback | **still reaches its existing processing path** — the control probe returned `200 {"ok":true}`, i.e. the capability gate did not fire |

That last line is a **regression check only**. It shows the gate does not
misfire on the live provider. It is **not** evidence of CASA HMAC compliance for
CardCom, and must not be read as such. CardCom's position is unchanged and
remains governed by its own compensating-control evidence and its explicit
assessor caveat, recorded separately in
[`casa-7-2-cardcom-webhook-compensating-control-v1.md`](./casa-7-2-cardcom-webhook-compensating-control-v1.md).

---

## 7. UI and direct API evidence

**Deployed settings bundle.** The JavaScript chunks served for
`/settings/connections` were fetched from production and scanned: **no
`TRANZILA` option value and no `PAYPAL` option value** are present, while
`CARDCOM` remains. This is evidence about what actually shipped, not about what
the repository contains.

**Unauthenticated connect routes** retain safe authorization behaviour:
`POST /api/payments/connections/tranzila`, `/api/payments/connections/cardcom`
and the generic `POST /api/payments/connections` all return **401** without a
session. Authorization ordering is unchanged by Wave E.

**Evidence boundary — stated explicitly.** The authenticated Tranzila capability
refusal is supported by the **automated descriptor-path proof** (§8), not by a
state-mutating production test. No authenticated production connection attempt
was made, because the only way to exercise that path against production would
have been to try to create a real connection. The automated proof invokes
exactly the call the route makes after authorization and asserts the refusal
plus zero persistence; the same assertion exists in the deployed source. This is
weaker than a production observation and is reported as such.

---

## 8. Automated evidence

Test file: [`lib/services/payments/dormant-provider-closure.test.ts`](../lib/services/payments/dormant-provider-closure.test.ts)
Local script: `npm run verify:dormant-providers`
Result: **46/46 assertions pass** — deterministic and offline (in-memory store,
stub provider, no database, no network, no cryptographic key).

Coverage:

- **Refusal tests** — for both providers: HTTP 404, `ok:false`, and the reason
  code named.
- **Provider verification never invoked** — the handler is given a dependency
  that throws if a provider is resolved; it is never reached.
- **Zero persistence assertions** — no `PaymentWebhookEvent`, no
  `PaymentTransaction`, no `PaymentRequest`, no audit event.
- **Direct API / descriptor gate** — `connectProviderFromDescriptor` is called
  with exactly the shape each connect route passes after authorization, and must
  reject with `PaymentProviderDisabledError`; zero connection rows and zero
  audit events follow.
- **UI / catalogue guard** — the catalogue must offer CardCom only, and the
  settings picker's `SELECTABLE_PROVIDERS` must equal the server's enabled set,
  so a UI-only re-enable fails rather than shipping a provider whose callback is
  switched off.
- **Structural route guard** — every connect route must reach connect through
  the gated descriptor path and must not call the ungated helper directly.
- **Historical compatibility** — every descriptor remains resolvable, and the
  Prisma enum values for both disabled providers are still present.
- **CardCom regression coverage** — CardCom still connects, never returns its
  secret, and its webhook still reaches processing.

**CI wiring.** Both steps run in the blocking `ci-1-guard` job of
[`.github/workflows/ci-1-prisma-centralization.yml`](../.github/workflows/ci-1-prisma-centralization.yml):

- `Dormant payment providers stay closed (PayPal + Tranzila)`
- `Wave E negative proof (removing the webhook capability gate must be caught)`

**Structural negative proof.** The second step removes the capability gate from
the handler and requires the matrix to fail. A suite that cannot detect its own
removal is not evidence. A second negative proof — re-adding Tranzila to the UI
picker alone — was verified locally to fail the matrix as well.

---

## 9. CASA interpretation

For **PayPal** and **Tranzila**: their former static-token verification
implementations may remain in source for historical and provider compatibility,
but they are **no longer reachable as active production webhook consumer
capabilities**. They are therefore removed from the active assessed webhook
surface.

This document makes **no claim** that:

- PayPal implements HMAC;
- Tranzila implements HMAC;
- their former verifier became compliant;
- `timingSafeEqual` was added to either adapter;
- all of CASA 7.2.1 is PASS;
- all of CASA 7.2.2 is PASS;
- CASA 7.2.3 is closed.

Explicitly preserved:

- **CardCom — ASSESSOR / COMPENSATING-CONTROL CAVEAT.** Unchanged by Wave E and
  documented separately.
- **CASA 7.2.3 (replay protection via signed timestamps) — OPEN.** Not addressed
  by Wave E for any provider, including WhatsApp.

WhatsApp is a separate integration and was not modified: zero WhatsApp files
appear in the Wave E merge commit, and `app/api/integrations/whatsapp/` is
byte-identical between the pre-Wave-E baseline and current main.

---

## 10. Evidence boundaries

- **No authenticated production Tranzila connection was created for testing.**
  The authenticated capability refusal rests on automated and deployed-code
  evidence, not on a production observation.
- **No real payment was generated**, and no payment flow was initiated for any
  provider.
- **No existing CardCom record was mutated.** All database access was read-only.
- **The dormant provider adapter code remains in source**, deliberately, so
  historical records would remain interpretable.
- **This evidence proves unreachability and disablement, not cryptographic
  compliance.** It is an argument about the assessed surface, not about the
  quality of the code that was switched off.
- **External CASA assessor acceptance is NOT claimed.**
- **A Letter of Validation is NOT claimed.**
- **Google OAuth verification completion is NOT claimed.**

---

## 11. Subsequent revert clarification

Wave E merged at **`b8abaed`**. Production subsequently moved to **`9bbf68e`**,
which is a **revert of `31d69e6`** — an unrelated authentication and billing
commit. Vercel cancelled the in-flight `b8abaed` build as superseded and built
`9bbf68e` instead, which is why the deployed SHA is not the Wave E merge commit.

**That revert did not revert Wave E.** Verified rather than assumed:

- **Ancestry** — `git merge-base --is-ancestor b8abaed origin/main` succeeds, so
  the Wave E merge is contained in current main.
- **Files present** — `provider-availability.ts` and
  `dormant-provider-closure.test.ts` both exist at current main.
- **Controls intact at current main** — the webhook capability gate is present
  and still precedes processing (line 39 before line 43); the server-side
  connect gate is present; the catalogue filter is present; and
  `SELECTABLE_PROVIDERS` is `["CARDCOM"]`.
- **Untouched since the merge** — a diff of `b8abaed..origin/main` restricted to
  `lib/services/payments`, `components/settings/PaymentConnectionCard.tsx` and
  the CI workflow returns **no files**. The revert changed authentication,
  billing and schema files only, and no payment, provider or webhook file.
- **Runtime confirms it** — the production refusal probes in §4 were executed
  against the `9bbf68e` deployment.

One consequence to record accurately: because `31d69e6` was reverted, the "real
logout" / `tokenVersion` work it introduced is **not active** in production.
Nothing in this memo depends on it.

---

## Change history

| Date | Change |
| --- | --- |
| 2026-09-02 | v1 — initial evidence record for the Wave E dormant-provider closure, written after production proof. |
