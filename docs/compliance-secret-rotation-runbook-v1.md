# Secret Rotation Runbook v1 — G-1 (P0, Blocked External)

**Purpose:** Give the owner an evidence-based, verifiable procedure to complete **G-1 secret rotation** — the sole item gating **Phase 1 Operational Readiness**. Until G-1 has objective completion evidence, Phase 1 stays open (P0 discipline).
**Status of G-1:** `Blocked External` → owner ops action. This runbook does **not** rotate anything (no console access here); it defines *what* to rotate, *where*, *how to verify*, and *what evidence closes it*.

---

## 1. Method & evidence source (Evidence First)
The inventory below is derived from **two evidence sources**:
1. **Code scan** — every `process.env.*` read in production code (`lib/**`, `app/**`, excluding tests, `.tmp/`, `tmp_qa/`). This is authoritative for *what the running app actually needs*.
2. **Local working-tree `.env`** — variable **names only** (values never read).

**Limits (stated, not guessed):**
- I **cannot read the Vercel Production environment** (no console access). The production secret set is whatever is configured in Vercel — the owner must **reconcile this code-derived list against the actual Vercel env list** and rotate any prod-only secret not visible here.
- Local `.env` ≠ Production. Rotation that protects Production happens in **Vercel Production env** + each provider console.
- `.tmp/` and `tmp_qa/` scripts reference `AUTH_TOKEN_SECRET` locally; they are untracked/local-only and **not** part of PR #54 — but they are evidence that this secret has been handled in plaintext on dev machines, reinforcing why rotation is warranted.

## 2. Secret inventory (rotate these)
| Secret (env var) | Owning system | Read at (evidence) | Rotate where |
|---|---|---|---|
| `DATABASE_URL` / `DIRECT_URL` | **Neon** (Postgres; contains password) | `lib/prisma.ts`, `ops/release/scripts/host-probe.mjs:30` | Neon console → reset role password → update **both** in Vercel |
| `AUTH_TOKEN_SECRET` | **App** (session/JWT signing) | `lib/auth-token.ts:20` | App-managed → regenerate + set in Vercel (⚠ invalidates all sessions) |
| `OPENAI_API_KEY` | **OpenAI** | `lib/features/content/llm/content-llm.service.ts`, `concept-ai`, `script-ai`, story/human-insight engines | OpenAI dashboard → new key → revoke old |
| `GOOGLE_OAUTH_CLIENT_SECRET` | **Google Cloud** (OAuth) | `.env` (Gmail/Taxes OAuth) | GCP → Credentials → OAuth client → rotate secret |
| `GOOGLE_APPLICATION_CREDENTIALS` | **Google Cloud** (service-account key / Vision) | `.env`; Vision OCR path | GCP → IAM service accounts → new key → delete old |
| `WHATSAPP_APP_SECRET` | **Meta** | `graph.service.ts:35`, `webhook-verify.service.ts:11` | Meta App Dashboard → App Secret → reset |
| `WHATSAPP_ACCESS_TOKEN` | **Meta** | `media-fetch.service.ts:27` | Meta → regenerate token (system-user/token) |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | **Meta ↔ App** (paired) | `webhook-verify.service.ts:4` | Choose new value → set in Vercel **and** Meta webhook config together |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | **Cloudflare R2** (storage) | `lib/storage/*`, `document-storage.verify.test`, `public-asset-storage` | Cloudflare R2 → API tokens → roll → update Vercel |
| `UPSTASH_REDIS_REST_TOKEN` (+ URL) | **Upstash** (rate-limiter) | `lib/security/rate-limiter/redis-backend.ts:36-37` | Upstash console → rotate REST token |
| `CREATOMATE_API_KEY` | **Creatomate** (render) | `lib/services/creatomate.service.ts:263,316` | Creatomate dashboard → new API key |
| `PEXELS_API_KEY` | **Pexels** (stock) | `lib/features/visual-generation/orchestrator.ts:22` | Pexels account → regenerate |
| `PAYMENTS_ENCRYPTION_KEY` | **App** (encrypts stored payment-provider connections) | `lib/services/payments/payment-crypto*` | ⚠ **Special handling — see §3** |
| `GMAIL_TOKEN_ENCRYPTION_KEY` | **App** (encrypts stored Gmail OAuth tokens) | `.env`; Gmail token-crypto | ⚠ **Special handling — see §3** |
| `WHATSAPP_TOKEN_ENCRYPTION_KEY` | **App** (encrypts stored WhatsApp tokens) | `.env` | ⚠ **Special handling — see §3** |
| `EMAIL_TOKEN_ENCRYPTION_KEY_ID` | **App** (key identifier) | `.env` | Reconcile with KMS/key store; rotate the *referenced* key, not just the id |
| `POS_INGEST_SECRET` | **App** (POS ingest shared secret) | `app/api/inventory/pos/sale/route.ts:48` | Regenerate + update any POS caller that sends it |
| `BILLING_AUTHORITY_CLIENT_SECRET` (+ `BILLING_AUTHORITY_ITA_CLIENT_ID`) | **ITA / SHAAM authority OAuth** | `scripts/bootstrap-billing-authority-app.ts:139,143` | Israel Tax Authority app registration → rotate |

**Not secrets — no rotation** (evidence: names are flags / URLs / model names / public ids): `NODE_ENV`, all `NEXT_PUBLIC_*`, `*_BASE_URL`, `*_MODEL`/`*_VARIANT`/`*_ENABLED`, `STORAGE_PROVIDER`, `RATE_LIMIT_BACKEND`, `META_APP_ID`, `GOOGLE_OAUTH_CLIENT_ID`, `R2_ACCOUNT_ID`/`R2_BUCKET_NAME`, `CARDCOM_BASE_URL`, `PAYMENTS_PUBLIC_BASE_URL`. `PLATFORM_ADMIN_EMAILS` is sensitive config but not a rotatable credential.

## 3. Special-handling secrets (do NOT naively swap)
1. **Encryption keys** (`PAYMENTS_ENCRYPTION_KEY`, `GMAIL_TOKEN_ENCRYPTION_KEY`, `WHATSAPP_TOKEN_ENCRYPTION_KEY`, and the key behind `EMAIL_TOKEN_ENCRYPTION_KEY_ID`): existing **stored ciphertext** (OAuth tokens, encrypted payment connections) was encrypted with the *current* key. Swapping the env var **breaks decryption** of all stored records. Two valid paths — this is a **product/eng decision, not a mechanical swap**:
   - **(a) Re-encryption migration** — decrypt-with-old → re-encrypt-with-new for every stored record, then retire the old key; or
   - **(b) Re-connect required** — accept that stored tokens/connections become invalid and users must re-authenticate / re-enter connections.
   Mark these `Unknown — requires product decision` until a path is chosen. If G-1 is scoped to *exposed-credential* rotation only, these app-managed keys may be rotated on path (b) or deferred with an explicit, recorded decision.
2. **CardCom / payment-provider API credentials:** code reads only `CARDCOM_BASE_URL` from env — the actual terminal/API credentials are **not** env vars; they are supplied **per-connection** (stored encrypted via `PAYMENTS_ENCRYPTION_KEY`). Rotation = rotate at the CardCom (and Tranzila) provider console **and re-enter via the in-app connection flow** — not an env change. *(Owner to confirm storage location.)*
3. **`DATABASE_URL` / `DIRECT_URL`:** rotate the Neon role password once, then update **both** vars in Vercel **atomically** (a mismatch breaks either runtime or migrations, which use `DIRECT_URL`).
4. **`WHATSAPP_WEBHOOK_VERIFY_TOKEN`:** the value in Vercel **must equal** the value in the Meta webhook config, or webhook (re)subscription verification fails.
5. **`AUTH_TOKEN_SECRET`:** rotating **logs everyone out** (existing tokens no longer verify). Rotate during a low-traffic window and expect re-login.

## 4. Recommended rotation order (dependency-safe)
1. Low-blast-radius provider keys first (OpenAI, Pexels, Creatomate, R2, Upstash) — rotate at provider → update Vercel → verify.
2. Meta set together (`WHATSAPP_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN` + Meta webhook config).
3. Google set (`GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_APPLICATION_CREDENTIALS`).
4. ITA/SHAAM (`BILLING_AUTHORITY_CLIENT_SECRET`), `POS_INGEST_SECRET`.
5. `AUTH_TOKEN_SECRET` (expect logout) and **Neon** DB URLs (atomic Vercel update) — highest blast radius, do last in a window.
6. **Encryption keys** — only after a §3 decision (migration vs re-connect).

## 5. Per-service verification (evidence the new secret works)
Rotate → redeploy/restart so Vercel picks up the new env → run the matching check:
- **Neon:** `GET /api/health` returns healthy DB; a read query succeeds.
- **Auth:** log in fresh → session cookie issued and accepted.
- **OpenAI:** trigger one content/AI action → 200 (no auth error).
- **Google OAuth / Gmail:** run Gmail connect status/scan → 200 (per prior E2E harness).
- **Vision (SA key):** one OCR path succeeds.
- **Meta/WhatsApp:** webhook re-verify handshake passes; inbound media fetch works.
- **R2:** upload + signed-URL fetch of a document succeeds.
- **Upstash:** rate-limiter backend responds (no fallback-to-memory warning).
- **Creatomate/Pexels:** one render / one stock lookup returns 200.
- **Payments:** re-entered CardCom connection completes a sandbox/low-value transaction.
- **ITA/SHAAM:** authority OAuth start/callback completes in sandbox.

## 6. G-1 completion criteria (flips Blocked External → Completed)
G-1 may be marked **Completed** only when **all** hold, with recorded evidence:
1. Every §2 secret rotated at its provider **and** updated in Vercel Production (old credentials revoked).
2. Every §5 verification passed **against Production** with the new secrets (capture check/output per service).
3. §3 special-handling secrets each have a **recorded decision** (rotated-with-migration / re-connect / explicitly deferred with rationale) — no silent skip.
4. The Vercel-env ↔ code-inventory reconciliation is done (no prod-only secret left unrotated).
5. Reports updated: this runbook's checklist ticked, the **Final Release Report §4** and **System Audit G-1** moved to `Completed` **with the evidence links**.

Only after §6 is satisfied does the ordered close proceed: **merge PR #54 → main Required checks green → Production Deploy succeeds → Production smoke test / no regression → formally close Phase 1 → open WP2.**

## 7. What I can / cannot do
- **Cannot:** access any provider console or Vercel env; therefore cannot rotate or read live secret values. This is the reason G-1 is `Blocked External`.
- **Can (on your signal, once you supply rotation evidence):** update the reports/audit to move G-1 → `Completed`, then execute the merge + post-merge verification steps in order.
