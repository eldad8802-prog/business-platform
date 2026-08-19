# Encryption-Key Rotation — Impact Evidence Report v1 (feeds Runbook §6.1)

**Purpose:** Evidence-based input for the **product decision** on Class C cryptographic keys (Runbook §6.1): **Re-encryption Migration vs Re-connect vs explicit deferral.** Read-only; no writes; **no secret/ciphertext values** — counts, statuses, and non-secret key-version labels only.
**Method:** (a) code scan of the crypto services + Prisma schema; (b) **read-only** `count`/`groupBy` queries against the reachable DB.

## ⚠️ Critical scope caveat — this is the DEV database, not Production
The queries ran against `DATABASE_URL` host **`ep-square-grass-…neon.tech` = the DEV branch** (local `.env` is dev; confirmed by prior root-cause work). **These counts are DEV, not Production.** The §6.1 decision must be made on **Production** counts. I cannot reach Production (its `DATABASE_URL` lives in Vercel env, which I cannot read). **The same read-only script must be run by the owner against the Production `DATABASE_URL`** — its structure is in §8. Everything DB-count below is labelled `[DEV]`; everything code-derived is DB-independent and holds for Production too.

## New finding — there are FIVE cryptographic keys, not three
The Runbook §1 listed three. The code scan found **two more stores under a fifth key**, now corrected:
| Key | Protects (model.field) | AAD binding |
|---|---|---|
| `PAYMENTS_ENCRYPTION_KEY` | `BusinessPaymentConnection.credentialEncrypted` | `businessId:provider` |
| `GMAIL_TOKEN_ENCRYPTION_KEY` | `OAuthToken.accessTokenEncrypted` / `.refreshTokenEncrypted` (Gmail) | none (format-prefixed) |
| `WHATSAPP_TOKEN_ENCRYPTION_KEY` | `WhatsAppConnection.accessTokenEncrypted` | `businessId` |
| **`BILLING_AUTHORITY_ENCRYPTION_KEY`** *(was missing)* | `BillingAuthorityConnection.accessTokenEncrypted`/`.refreshTokenEncrypted` **and** `BillingAuthorityApp.clientSecretEncrypted` | `businessId:environment` / `environment` |
| `EMAIL_TOKEN_ENCRYPTION_KEY_ID` | key-**identifier** reference (not itself the AES key) | — |

→ The Runbook has been updated to add `BILLING_AUTHORITY_ENCRYPTION_KEY` as a Class C key.

## 1. Payments — `PAYMENTS_ENCRYPTION_KEY`
- Model: `BusinessPaymentConnection` (`credentialEncrypted`, `encryptionKeyId="payments-v1"`, `isActive`).
- **[DEV] result: table not present (`P2021`)** → the payments migration is **not applied on dev** (known payments migration-debt). Effective dev count = **0**.
- **[PROD] UNKNOWN — must be measured.** This is the highest-friction store to re-connect: per §6.2, each business's CardCom/Tranzila credential is stored here and, on Re-connect, must be **re-entered per business through the in-app flow**.

## 2. Gmail — `GMAIL_TOKEN_ENCRYPTION_KEY`
- Models: `EmailConnection` (status) → `OAuthToken` (`accessTokenEncrypted`, `refreshTokenEncrypted`, `encryptionKeyId`).
- **[DEV] results:** connections = **2** (both `connected`, provider `gmail`); OAuth tokens = **2** (both have a refresh token). Key-label breakdown: **1 × `gcm_v1`** (real AES-GCM) and **1 × `local-dev-v0`** (a dev-only placeholder label — not encrypted under the real prod key).
- **[PROD] UNKNOWN — must be measured.** On Re-connect, affected users must re-authorize Gmail (OAuth consent) — user-visible but self-service.

## 3. WhatsApp — `WHATSAPP_TOKEN_ENCRYPTION_KEY`
- Model: `WhatsAppConnection` (`accessTokenEncrypted`, status; **note: no `encryptionKeyId` column** — see §6).
- **[DEV] result: 0 connections.**
- **[PROD] UNKNOWN — must be measured.** On Re-connect, each business re-runs WhatsApp embedded signup — heavier than Gmail (business-level re-onboarding).

## 4. Additional encrypted credentials (answer: YES)
Beyond the three original stores:
- **`BillingAuthorityConnection`** (ITA/SHAAM access+refresh tokens) and **`BillingAuthorityApp`** (client secret) — under `BILLING_AUTHORITY_ENCRYPTION_KEY`. **[DEV] result: 0 connections, 0 apps.** **[PROD] UNKNOWN.** Re-connect here = re-auth against the Israel Tax Authority — **vendor-coordinated and heavy** (§ Runbook 5/12).
- **Gmail `refreshTokenEncrypted`** — same key as #2, already counted.

## 5. Would Re-connect hurt existing customers, and how many?
Re-connect impact is **proportional to the Production active count** of each store (all `[PROD] UNKNOWN` here). Severity ranking by re-connect friction (code-derived, DB-independent):

| Store | Re-connect action for the customer | Friction | Customers affected |
|---|---|---|---|
| Gmail | Re-authorize OAuth consent | Low (self-service) | = prod `EmailConnection(connected)` — **measure** |
| WhatsApp | Re-run embedded signup | Medium (business re-onboarding) | = prod `WhatsAppConnection` — **measure** |
| Payments (CardCom/Tranzila) | Re-enter provider credential **per business** | High (manual, per-business) | = prod active `BusinessPaymentConnection` — **measure** |
| Billing Authority (ITA) | Re-auth vs the Tax Authority | High (vendor-coordinated) | = prod `BillingAuthorityConnection` — **measure** |
| **[DEV] observed** | — | — | Gmail **2**, all others **0** |

If Production resembles DEV (near-zero except a handful of Gmail), Re-connect harms **almost no one**. If Production holds real payment/authority connections, Re-connect is materially disruptive.

## 6. Is there infrastructure for a safe Re-encryption Migration? (answer: PARTIAL — new dev required)
Code-evidenced (holds regardless of DB):
- **Key-version columns exist** on **4 of 5** stores (`encryptionKeyId` on `BusinessPaymentConnection`, `OAuthToken`, `BillingAuthorityConnection`, `BillingAuthorityApp`). Payments even ships a version label `"payments-v1"` with the comment *"persisted … for future rotation."* → a **foundation** for versioned keys.
- **Gaps that block a safe migration today:**
  1. **No dual-key read path.** Every `loadEncryptionKey()` reads exactly **one** env var. To decrypt-with-old and re-encrypt-with-new, the code must hold **both** keys at once — not currently possible.
  2. **No migration tooling.** A code scan for re-encryption/rotation scripts found **none** (matches were unrelated test fixtures).
  3. **WhatsApp has no `encryptionKeyId` column** → can't distinguish old vs new-key rows without a schema add or format change.
- **AAD is not a blocker:** a migration re-encrypts with the same AAD (`businessId:provider`, `businessId`, `businessId:environment`), all available on each row.
- **Conclusion:** a safe migration = **new development** — a dual-key-aware, idempotent/resumable script per store (+ a WhatsApp keyId/format add), gated behind a maintenance window. Modest but non-trivial; it does **not** exist yet.

## 7. Evidence-based recommendation
The final call is the product owner's. On the evidence available now:

**Provable facts:** (a) no re-encryption tooling exists → Migration = build-first; (b) the encryption keys live only in **Vercel env + local `.env`, not in git history** (per the G-1 definition) → **no evidence of actual exposure** — this is *hardening*, not incident response; (c) DEV shows near-zero stored ciphertext (only 2 Gmail tokens, 1 of them a dev placeholder).

**Recommendation — split G-1, defer Class C explicitly:**
1. **Rotate Class A + Class B now** (infrastructure + third-party provider secrets). These are the exposure-relevant secrets and unblock the ordered close. Class C is **not** required for that.
2. **Class C (all five encryption keys): explicit, recorded deferral** to a planned follow-up — *not* a silent skip. Rationale: no evidence of key exposure (not in git), so no emergency; rotating now would force either un-built Migration tooling or a customer-disruptive Re-connect for zero security gain.
3. **Before executing any Class C rotation**, run the §8 script against **Production** to get real counts, then choose per store:
   - **Re-connect** if the prod active count is low / mostly Gmail (cheapest, no tooling);
   - **Re-encryption Migration** (build the tooling) if prod holds meaningful **payment** or **authority** connections, where re-entry is high-friction/vendor-coordinated.

**What would change this recommendation:** any evidence that an encryption key itself leaked (→ immediate rotation, accept Re-connect disruption), or a Production count showing large high-friction (payments/authority) populations (→ justify building Migration tooling before rotating).

## 8. Reproduce on Production (owner action)
Run the same **read-only** logic (counts/groupBy only, no ciphertext selected) with the **Production** `DATABASE_URL`. Report per store: total, by-status, `with-ciphertext` (non-null encrypted column), and `by encryptionKeyId`. Feed the numbers into §5/§7 to finalize the §6.1 decision. The script used for DEV is available on request (it prints only aggregates and never secret values).

---
**Status of §6.1:** remains **OPEN — awaiting product decision.** No Re-encryption Migration and no Re-connect will be executed before an explicit, documented decision.
