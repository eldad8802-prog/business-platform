# Secret Rotation Runbook v1 — G-1 (P0, Blocked External)

**Purpose:** A complete **operational** procedure — usable a year from now by someone who was not involved in the project — to rotate every secret Dubiz consumes and to prove, with objective evidence, that rotation succeeded **and** the system still works. G-1 is the sole item gating **Phase 1 Operational Readiness**; it stays open until both evidence types (below) exist.
**This document does not rotate anything** (no console/Vercel/GitHub-secret access here). It defines *what*, *where*, *how*, *how to verify*, *how to roll back*, and *what evidence closes G-1*.

---

## 1. Canonical scope — code-derived, not manual (Evidence First)
The secret list is **derived from evidence**, never hand-maintained. Any secret the code/config consumes is in scope even if older docs never named it. Three evidence sources were swept:

| Source | What it covers | Evidence method |
|---|---|---|
| **Vercel Production env** (app runtime) | secrets read via `process.env.*` in `lib/**`, `app/**` | code scan (excl. tests, `.tmp/`, `tmp_qa/`) |
| **GitHub Actions secret store** | secrets read via `${{ secrets.* }}` in `.github/workflows/**` | workflow scan |
| **Local `.env`** (dev copy) | variable **names** only (values never read) | name extraction |

**Indirect-consumption sweep (per your instruction — don't stop at `process.env`):**
- **GitHub Actions** — found: `DATABASE_URL`, `DIRECT_URL`, `NEON_API_KEY`, `CI_DATABASE_URL`, `GITHUB_TOKEN`. This is a **second, independent secret store** from Vercel.
- **Vercel Build** — `vercel.json` uses only `npm install` / `npm run build`; **no build-time secret injection** (no evidence of extra build secrets).
- **Libraries** — R2/AWS-SDK usage reads **explicit `R2_*`** vars (no implicit `AWS_*` credential chain in evidence). Prisma reads `DATABASE_URL`/`DIRECT_URL` (already mapped).
- **Anything without evidence is marked "no evidence"** and is **not** invented into the list.

**Critical cross-store finding:** `DATABASE_URL` and `DIRECT_URL` exist in **both** Vercel env **and** the GitHub Actions store. A Neon password rotation must update the value in **both stores**, or CI/migrations break while runtime works (or vice-versa).

**Stated limits:** I cannot read the actual Vercel env or GitHub secret values. The owner must **reconcile this code-derived list against the live Vercel env list and the live GitHub Actions secret list**, and rotate any store-only secret not visible in code.

## 2. Master rotation table (all 9 attributes per secret)
Legend — **Self-service** = rotate without vendor contact · **ZDT** = Zero-Downtime achievable · **Re-enc** = re-encryption of stored ciphertext required · **Re-conn** = end-users must re-connect/re-auth · **Risk** = blast radius.

| # (order) | Secret | Source / store | Self-service? | ZDT? | Re-enc? | Re-conn? | Risk |
|---|---|---|---|---|---|---|---|
| 1 | `PEXELS_API_KEY` | Pexels (ext) + Vercel | Yes | Yes | No | No | LOW |
| 2 | `CREATOMATE_API_KEY` | Creatomate (ext) + Vercel | Yes | Yes | No | No | LOW |
| 3 | `OPENAI_API_KEY` | OpenAI (ext) + Vercel | Yes | Yes (overlap keys) | No | No | MED |
| 4 | `UPSTASH_REDIS_REST_TOKEN` (+URL) | Upstash (ext) + Vercel | Yes | Yes (falls back to memory) | No | No | MED |
| 5 | `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | Cloudflare R2 (ext) + Vercel | Yes | Yes (create new token first) | No | No | HIGH |
| 6 | `POS_INGEST_SECRET` | App + Vercel + POS callers | Yes (coordinate callers) | No (callers must update) | No | No | MED |
| 7 | `WHATSAPP_APP_SECRET` | Meta (ext) + Vercel | Yes | No (paired verify) | No | No | HIGH |
| 8 | `WHATSAPP_ACCESS_TOKEN` | Meta (ext) + Vercel | Yes | Yes (regen token) | No | No | HIGH |
| 9 | `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | Meta ↔ Vercel (paired) | Yes (both sides together) | No | No | No | HIGH |
| 10 | `GOOGLE_OAUTH_CLIENT_SECRET` | Google Cloud (ext) + Vercel | Yes | Yes (add secret before removing old) | No | No | HIGH |
| 11 | `GOOGLE_APPLICATION_CREDENTIALS` (SA key) | Google Cloud (ext) + Vercel | Yes | Yes (new key, then delete old) | No | No | HIGH |
| 12 | `BILLING_AUTHORITY_CLIENT_SECRET` (+ ITA client id) | Israel Tax Authority (ext) + Vercel | **Vendor-coordination** | No | No | Possibly (re-auth) | HIGH |
| 13 | `NEON_API_KEY` | Neon (ext) + **GitHub Actions** | Yes | Yes | No | No | HIGH |
| 14 | `CI_DATABASE_URL` | Neon (ext) + **GitHub Actions** | Yes | Yes (CI only, not prod) | No | No | MED |
| 15 | `AUTH_TOKEN_SECRET` | App + Vercel | Yes | **No — logs out all sessions** (see §4.3) | No | **Re-login** | HIGH |
| 16 | `DATABASE_URL` / `DIRECT_URL` | Neon (ext) + Vercel **and** GitHub Actions | Yes (both stores) | Near-ZDT with sequencing; brief window | No | No | **CRITICAL** |
| 17 | `PAYMENTS_ENCRYPTION_KEY` | App + Vercel; encrypts **stored** payment connections | Yes | **Depends on path (§4.1)** | **Yes** | Maybe (CardCom §4.2) | **CRITICAL** |
| 18 | `GMAIL_TOKEN_ENCRYPTION_KEY` | App + Vercel; encrypts **stored** Gmail tokens | Yes | **Depends on path (§4.1)** | **Yes** | Maybe (re-connect) | **CRITICAL** |
| 19 | `WHATSAPP_TOKEN_ENCRYPTION_KEY` | App + Vercel; encrypts **stored** WhatsApp tokens | Yes | **Depends on path (§4.1)** | **Yes** | Maybe (re-connect) | **CRITICAL** |
| 20 | `EMAIL_TOKEN_ENCRYPTION_KEY_ID` | App/key-store reference | Reconcile w/ key store | Depends | **Yes (referenced key)** | Maybe | **CRITICAL** |
| — | `GITHUB_TOKEN` | GitHub Actions (auto per-run) | **N/A — auto-provisioned, not manually rotatable** | — | — | — | N/A |
| — | CardCom / Tranzila provider creds | **DB, per-business** (encrypted via `PAYMENTS_ENCRYPTION_KEY`), **not env** | Vendor + in-app re-entry (§4.2) | No | tied to #17 | **Yes, per business** | HIGH |

**Not secrets — no rotation** (evidence: flags / URLs / model names / public ids): `NODE_ENV`, `NEXT_PUBLIC_*`, `*_BASE_URL`, `*_MODEL`/`*_VARIANT`/`*_ENABLED`, `STORAGE_PROVIDER`, `RATE_LIMIT_BACKEND`, `META_APP_ID`, `GOOGLE_OAUTH_CLIENT_ID`, `R2_ACCOUNT_ID`/`R2_BUCKET_NAME`, `CARDCOM_BASE_URL`, `PAYMENTS_PUBLIC_BASE_URL`. `PLATFORM_ADMIN_EMAILS` = sensitive config, not a rotatable credential.

## 3. Per-secret operational detail (source · coordination · verify · rollback)
For each secret, rotation = **create/obtain new → update every store that holds it → redeploy → verify → revoke old**. Rollback (unless noted) = **re-instate the previous value in the store(s) and redeploy**; keep the old credential active until verification passes, then revoke.

- **Provider API keys (1–5, OpenAI/Pexels/Creatomate/Upstash/R2):** self-service in the provider console. ZDT: create the **new** key, set it in Vercel, redeploy, verify, then revoke the old. Rollback = revert Vercel value (old key still valid until you revoke it — revoke only after verification).
- **`POS_INGEST_SECRET` (6):** regenerate, update Vercel **and every POS caller** that sends it. Not ZDT — callers with the old secret get rejected until updated. Rollback = restore old value in Vercel and callers.
- **Meta set (7–9):** rotate `WHATSAPP_APP_SECRET` + regenerate `WHATSAPP_ACCESS_TOKEN` in Meta; choose a new `WHATSAPP_WEBHOOK_VERIFY_TOKEN` and set it **in Vercel and in the Meta webhook config together** (mismatch fails re-subscription). Verify: webhook re-verify handshake + inbound media fetch. Rollback = restore prior values on both sides.
- **Google set (10–11):** add a **new** OAuth client secret before deleting the old; for the SA key, create a **new** key then delete the old. Verify: Gmail connect status/scan 200; one Vision OCR path. Rollback = keep old secret/key until verified.
- **ITA/SHAAM (12):** **vendor-coordination** with the Israel Tax Authority app registration; may force re-auth. Verify: authority OAuth start/callback in sandbox. Treat as `requires vendor coordination`.
- **`NEON_API_KEY` (13) / `CI_DATABASE_URL` (14):** GitHub Actions store; rotate in Neon, update the GitHub secret. Verify by re-running the relevant workflow (release-infra-registry / release-ci-verify) green. Not prod-runtime.
- **`AUTH_TOKEN_SECRET` (15):** see §4.3.
- **`DATABASE_URL`/`DIRECT_URL` (16):** reset the Neon role password once; update **both vars in Vercel and in GitHub Actions**, atomically. Verify: `GET /api/health` DB-healthy + a read query; a migration dry-run uses `DIRECT_URL`. Rollback = the Neon password reset is one-way, so **rollback = reset again to a known value and re-propagate**; keep a maintenance window.
- **Encryption keys (17–20):** **do not swap naively — §4.1.**

## 4. Three findings that must NOT be "smoothed over"
### 4.1 Encryption keys — a PRODUCT decision, not an engineering one
`PAYMENTS_ENCRYPTION_KEY`, `GMAIL_TOKEN_ENCRYPTION_KEY`, `WHATSAPP_TOKEN_ENCRYPTION_KEY`, and the key behind `EMAIL_TOKEN_ENCRYPTION_KEY_ID` protect **already-stored ciphertext** (payment connections, OAuth tokens). Replacing the env value **breaks decryption of every stored record**. **No autonomous decision** — the two alternatives, with trade-offs, for the product owner to choose:

| | **A. Re-encryption Migration** | **B. Re-connect (invalidate stored)** |
|---|---|---|
| **How** | Support dual keys; decrypt-with-old → re-encrypt-with-new for every stored record; retire old key | Set new key; treat all stored ciphertext as invalid; users re-authenticate / re-enter connections |
| **Pros** | Zero user impact; no re-auth; fully transparent | Simple; no migration code; guarantees old key truly gone |
| **Cons** | Requires migration code + dual-key window + careful ordering; more engineering | User-visible disruption; every integration must be re-connected; possible payment/intake gap until re-done |
| **Impact** | Eng effort, low user impact | Low eng effort, high user/ops impact |
| **Best when** | There are live stored tokens/connections that must survive | Few/no live stored records, or a clean-slate is acceptable |

**Status:** `Unknown — requires product decision`. If G-1 is scoped only to *exposed-credential* rotation, these app-managed keys may be deferred with an **explicit recorded decision** — never silently skipped.

### 4.2 CardCom / payment-provider credentials — rotation is NOT a Vercel value swap
Evidence: app code reads only `CARDCOM_BASE_URL` from env. The actual provider API credentials are stored **per business in the database**, encrypted via `PAYMENTS_ENCRYPTION_KEY`. Therefore rotating CardCom requires, **for each business**:
1. Rotate the credential at the **CardCom (and Tranzila) provider console**.
2. **Re-enter** the new credential through the **in-app connection flow** (which re-encrypts it into the DB).
3. Verify a **sandbox/low-value transaction** completes for that business.
A single Vercel env change does **nothing** for these. *(Owner to confirm exact DB storage/flow.)* If encryption-key rotation (§4.1) path B is chosen, **all** businesses' stored CardCom credentials are invalidated and must be re-entered.

### 4.3 `AUTH_TOKEN_SECRET` — all active sessions WILL drop (expected)
Rotating this invalidates every issued session token: **all logged-in users are signed out and must log in again.** This is **expected behavior, not a fault.** Plan: rotate in a low-traffic window, communicate to users if needed, expect a re-login spike. There is no ZDT path — session invalidation is the point of the rotation.

## 5. Two required evidence types (both mandatory to close G-1)
Rotation is **not** complete on either one alone:
- **Evidence of Rotation** — proof the secret value was actually replaced (provider console showing new key + old revoked; Vercel/GitHub store showing updated value/timestamp; old credential confirmed rejected).
- **Evidence of Functionality** — proof the system still works on the new secret (the §7 per-service check passing **against Production** after redeploy, with captured output).

## 6. Real-time operational checklist (fill during rotation → this becomes the closure artifact)
Tick each row live. The completed table is the objective record of *what was done, when, by whom, and the verification result*.

| # | Secret | Rotated at (provider/store) | By (person) | Date/time | Evidence of Rotation (link) | Evidence of Functionality (§7 check + result) | Old revoked? | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | PEXELS_API_KEY | | | | | | | |
| 2 | CREATOMATE_API_KEY | | | | | | | |
| 3 | OPENAI_API_KEY | | | | | | | |
| 4 | UPSTASH_REDIS_REST_TOKEN | | | | | | | |
| 5 | R2_ACCESS_KEY_ID / SECRET | | | | | | | |
| 6 | POS_INGEST_SECRET | | | | | | | |
| 7 | WHATSAPP_APP_SECRET | | | | | | | |
| 8 | WHATSAPP_ACCESS_TOKEN | | | | | | | |
| 9 | WHATSAPP_WEBHOOK_VERIFY_TOKEN | | | | | | | |
| 10 | GOOGLE_OAUTH_CLIENT_SECRET | | | | | | | |
| 11 | GOOGLE_APPLICATION_CREDENTIALS | | | | | | | |
| 12 | BILLING_AUTHORITY_CLIENT_SECRET | | | | | | | |
| 13 | NEON_API_KEY (GH Actions) | | | | | | | |
| 14 | CI_DATABASE_URL (GH Actions) | | | | | | | |
| 15 | AUTH_TOKEN_SECRET | | | | | | | sessions dropped (expected) |
| 16 | DATABASE_URL / DIRECT_URL (Vercel **+** GH Actions) | | | | | | | both stores |
| 17 | PAYMENTS_ENCRYPTION_KEY | | | | | | | §4.1 decision: ____ |
| 18 | GMAIL_TOKEN_ENCRYPTION_KEY | | | | | | | §4.1 decision: ____ |
| 19 | WHATSAPP_TOKEN_ENCRYPTION_KEY | | | | | | | §4.1 decision: ____ |
| 20 | EMAIL_TOKEN_ENCRYPTION_KEY_ID (referenced key) | | | | | | | §4.1 decision: ____ |
| — | CardCom/Tranzila per-business creds | | | | | | | per-business re-entry (§4.2) |
| — | Vercel-env ↔ code reconciliation done | | | | | | | any prod-only secret? |
| — | GitHub-secrets ↔ workflow reconciliation done | | | | | | | any store-only secret? |

## 7. Per-service functionality verification
Rotate → redeploy so the new value is picked up → run the matching check against **Production**:
- **Neon (16):** `GET /api/health` DB-healthy + a read query; migration dry-run via `DIRECT_URL`.
- **Auth (15):** fresh login issues + accepts a session cookie.
- **OpenAI (3):** one content/AI action → 200.
- **Google/Gmail (10):** Gmail connect status/scan → 200. **Vision (11):** one OCR path succeeds.
- **Meta/WhatsApp (7–9):** webhook re-verify handshake passes; inbound media fetch works.
- **R2 (5):** upload + signed-URL fetch of a document.
- **Upstash (4):** rate-limiter backend responds (no memory-fallback warning).
- **Creatomate/Pexels (1–2):** one render / one stock lookup → 200.
- **Payments/CardCom (§4.2):** re-entered connection completes a sandbox/low-value transaction per business.
- **ITA/SHAAM (12):** authority OAuth start/callback in sandbox.
- **NEON_API_KEY / CI_DATABASE_URL (13–14):** re-run release-infra-registry / release-ci-verify workflows green.

## 8. G-1 completion criteria → then the ordered close
G-1 → **Completed** only when: every §2 secret has **both** Evidence of Rotation **and** Evidence of Functionality recorded in the §6 checklist; §4.1 keys each have a recorded product decision (or explicit deferral); both reconciliations (Vercel-env, GitHub-secrets) done; old credentials revoked. Then reports/audit (Final Release Report §4, System Audit G-1) move to `Completed` **with evidence links**.

**Only then**, in order: **(1) G-1 → Completed → (2) update all reports/audits → (3) merge PR #54 → (4) main Required checks green → (5) Production Deploy succeeds → (6) full Production smoke test → (7) confirm no regression → (8) formally close Phase 1 → then open WP2 (Privacy).**

## 9. What I can / cannot do
- **Cannot:** access any provider console, Vercel env, or GitHub secret store → cannot rotate or read live values (the reason G-1 is `Blocked External`).
- **Can (on your signal):** refine this runbook; once you supply the filled §6 checklist + §7 evidence, update G-1 → Completed in the reports/audit and execute steps 3–8 in order. I will **not** make the §4.1 product decision for you.
