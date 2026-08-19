# Secret Rotation Runbook v1 — G-1 (P0, Blocked External)

> **DECLARATION — read first.** This Runbook describes the rotation **process only**. It **does not contain, and must never contain, any secret values.** No keys, tokens, passwords, connection strings, or credential material may be pasted here. This lets the document live in the repository for years without creating a disclosure risk. Evidence that references values (console screenshots, connection strings) is stored **outside** the repo (see §2.7).

**Purpose:** A complete **operational + governance** procedure — usable a year from now by someone who was not involved in the project — to rotate every secret Dubiz consumes and to prove, with objective evidence, that rotation succeeded **and** the system still works. G-1 is the sole item gating **Phase 1 Operational Readiness**; it stays open until the Exit Criteria (§2.5) are met.
**This document does not rotate anything** (no console/Vercel/GitHub-secret access here). It defines *governance*, *what*, *where*, *how*, *how to verify*, *how to roll back*, and *what evidence closes G-1*.

---

## 1. Secret categories (three risk classes)
Every secret in this Runbook belongs to exactly one class. The class determines its risk profile, rotation process, and system impact — so the distinction is canonical, not cosmetic.

| Class | Members (this system) | Risk profile | Rotation process | System impact |
|---|---|---|---|---|
| **A. Infrastructure Secrets** | Vercel/Neon DB (`DATABASE_URL`, `DIRECT_URL`), `NEON_API_KEY`, `CI_DATABASE_URL`, GitHub Actions store, plus platform app secrets `AUTH_TOKEN_SECRET`, `POS_INGEST_SECRET` | **Broad blast radius** — a failure can take down the whole app, CI, or migrations; often stored in **multiple stores** (Vercel **and** GitHub) | Coordinated update across **all** stores; may require a maintenance window (DB, auth) | Platform-wide; can force logout (auth) or downtime (DB) |
| **B. Third-party Provider Secrets** | Google, Meta, OpenAI, CardCom/Tranzila, Cloudflare R2, Upstash, Creatomate, Pexels, ITA/SHAAM authority | **Isolated to one integration** — failure degrades that feature only | Provider console; usually **self-service with overlapping-key ZDT** (create new → deploy → revoke old); some **vendor-coordinated** (ITA) | The affected integration only (documents, WhatsApp, payments, content, etc.) |
| **C. Cryptographic Keys** | `PAYMENTS_ENCRYPTION_KEY`, `GMAIL_TOKEN_ENCRYPTION_KEY`, `WHATSAPP_TOKEN_ENCRYPTION_KEY`, `BILLING_AUTHORITY_ENCRYPTION_KEY`, key behind `EMAIL_TOKEN_ENCRYPTION_KEY_ID` | **Highest** — these protect **already-stored ciphertext**; a naive swap **destroys access to stored data** | **Product decision required** (§6.1): Re-encryption Migration **or** Re-connect — never an autonomous engineering swap | Stored tokens/connections become unreadable unless migrated; may force re-auth/re-connect |

## 2. Governance of the Secret Rotation process
This is the canonical process that governs **any** rotation, now and in future.

**2.1 When rotation is performed (triggers).** Any one of: a **security incident**; a **suspected or confirmed leak/exposure** (secret in logs, repo, screenshot, shared channel); **scheduled periodic rotation**; a **provider change**; a **personnel/role change** (offboarding anyone who held access, or a change of the responsible owner); a **post-pentest / audit finding**; or a **compliance directive** (G-1 itself is the initial hardening rotation).

**2.2 Authority — who approves / who executes.**
- **Approver:** the Compliance/Security owner named in the WP9 **Owner Registry** (`compliance-constitution-owner-registry-v1.md`, per GOV-8). **Class C** (cryptographic keys) additionally requires the **Product owner's** recorded decision (§6.1) before execution.
- **Executor:** a single **named, authorized operator** who holds admin access to the relevant store(s) (Vercel / Neon / GitHub / provider console). The executor is recorded per secret in the §8 checklist. Approver ≠ executor should be preferred where possible (separation of duties).

**2.3 Preconditions (all must hold before starting).** Approved rotation request on record; scope confirmed against the **code-derived list (§3)** and reconciled with the live Vercel env **and** GitHub Actions store; a **rollback value/plan** ready for each secret; access to **every store** that holds the secret confirmed; a **maintenance window** scheduled for any downtime-class secret (Class A auth/DB); for **Class C**, the §6.1 product decision **recorded first**; the §8 checklist opened.

**2.4 Abort criteria (stop the process if any occur).** Functionality verification (§9) fails and cannot be resolved quickly → **roll back**; a store cannot be updated (permissions/outage); a provider is down mid-rotation; **unexpected user/data impact** appears (e.g., stored ciphertext unreadable — Class C mishandled); **no viable rollback path**; or an **unmapped secret is discovered mid-process** → **halt, map it into §3, then resume**. On abort: restore prior values, keep old credentials active, record the abort + reason in the checklist.

**2.5 Exit criteria (required to declare Completion).** **All** of: every in-scope secret has **both** Evidence of Rotation **and** Evidence of Functionality recorded (§7–§8); **old credentials revoked**; **both reconciliations** done (Vercel-env, GitHub-secrets); every **Class C** key has a recorded product decision **or** an explicit, recorded deferral; **no open abort condition**; the §8 checklist is complete and signed by approver + executor.

**2.6 Event documentation.** Each rotation produces a **Rotation Event record**: trigger (§2.1), approver, executor, start/end time, scope (which secrets, which stores), outcome (completed / partial / aborted), and links to evidence. The filled §8 checklist **is** the core of this record.

**2.7 Where evidence is stored.** Evidence that references or reveals secret material (console screenshots, connection strings, provider records) is stored in a **controlled location outside the repository** (e.g., the org's secure compliance evidence store / password-manager vault / restricted drive). The **repository holds only pointers** — this Runbook, the checklist structure, and **links/IDs** to the external evidence, never the values themselves (see Declaration).

**2.8 Linkage to Compliance reports.** On successful Exit (§2.5): the completed checklist + Rotation Event record are linked from **System Audit G-1** and **Final Release Report §4**, G-1 moves `Blocked External → Completed` **with those evidence links**, and the initiative memory is updated. No report may mark G-1 Completed without both evidence links present.

---

## 3. Canonical scope — code-derived, not manual (Evidence First)
The secret list is **derived from evidence**, never hand-maintained. Any secret the code/config consumes is in scope even if older docs never named it. Three evidence stores were swept:

| Source | What it covers | Evidence method |
|---|---|---|
| **Vercel Production env** (app runtime) | secrets read via `process.env.*` in `lib/**`, `app/**` | code scan (excl. tests, `.tmp/`, `tmp_qa/`) |
| **GitHub Actions secret store** | secrets read via `${{ secrets.* }}` in `.github/workflows/**` | workflow scan |
| **Local `.env`** (dev copy) | variable **names** only (values never read) | name extraction |

**Indirect-consumption sweep (don't stop at `process.env`):**
- **GitHub Actions** — found: `DATABASE_URL`, `DIRECT_URL`, `NEON_API_KEY`, `CI_DATABASE_URL`, `GITHUB_TOKEN`. A **second, independent secret store**.
- **Vercel Build** — `vercel.json` uses only `npm install` / `npm run build`; **no build-time secret injection** (no evidence of extra build secrets).
- **Libraries** — R2/AWS-SDK reads **explicit `R2_*`** vars (no implicit `AWS_*` credential chain in evidence). Prisma reads `DATABASE_URL`/`DIRECT_URL` (mapped).
- **Anything without evidence is marked "no evidence"** — never invented into the list.

**Critical cross-store finding:** `DATABASE_URL` and `DIRECT_URL` exist in **both** Vercel env **and** the GitHub Actions store. A Neon password rotation must update **both stores**, or CI/migrations break while runtime works (or vice-versa).

**Stated limits:** I cannot read the actual Vercel env or GitHub secret values. The owner must **reconcile this code-derived list against the live Vercel env and the live GitHub Actions secret list**, and rotate any store-only secret not visible in code.

## 4. Master rotation table (all 9 attributes per secret)
Legend — **Cls** = category (§1) · **Self-service** = rotate without vendor contact · **ZDT** = Zero-Downtime achievable · **Re-enc** = re-encryption of stored ciphertext required · **Re-conn** = end-users must re-connect/re-auth · **Risk** = blast radius.

| # (order) | Secret | Cls | Source / store | Self-service? | ZDT? | Re-enc? | Re-conn? | Risk |
|---|---|---|---|---|---|---|---|---|
| 1 | `PEXELS_API_KEY` | B | Pexels + Vercel | Yes | Yes | No | No | LOW |
| 2 | `CREATOMATE_API_KEY` | B | Creatomate + Vercel | Yes | Yes | No | No | LOW |
| 3 | `OPENAI_API_KEY` | B | OpenAI + Vercel | Yes | Yes (overlap keys) | No | No | MED |
| 4 | `UPSTASH_REDIS_REST_TOKEN` (+URL) | B | Upstash + Vercel | Yes | Yes (memory fallback) | No | No | MED |
| 5 | `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | B | Cloudflare R2 + Vercel | Yes | Yes (new token first) | No | No | HIGH |
| 6 | `POS_INGEST_SECRET` | A | App + Vercel + POS callers | Yes (coordinate callers) | No | No | No | MED |
| 7 | `WHATSAPP_APP_SECRET` | B | Meta + Vercel | Yes | No (paired verify) | No | No | HIGH |
| 8 | `WHATSAPP_ACCESS_TOKEN` | B | Meta + Vercel | Yes | Yes (regen token) | No | No | HIGH |
| 9 | `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | B | Meta ↔ Vercel (paired) | Yes (both sides together) | No | No | No | HIGH |
| 10 | `GOOGLE_OAUTH_CLIENT_SECRET` | B | Google Cloud + Vercel | Yes | Yes (add before removing old) | No | No | HIGH |
| 11 | `GOOGLE_APPLICATION_CREDENTIALS` (SA key) | B | Google Cloud + Vercel | Yes | Yes (new key, then delete old) | No | No | HIGH |
| 12 | `BILLING_AUTHORITY_CLIENT_SECRET` (+ ITA client id) | B | Israel Tax Authority + Vercel | **Vendor-coordination** | No | No | Possibly | HIGH |
| 13 | `NEON_API_KEY` | A | Neon + **GitHub Actions** | Yes | Yes | No | No | HIGH |
| 14 | `CI_DATABASE_URL` | A | Neon + **GitHub Actions** | Yes | Yes (CI only) | No | No | MED |
| 15 | `AUTH_TOKEN_SECRET` | A | App + Vercel | Yes | **No — logs out all sessions** (§6.3) | No | **Re-login** | HIGH |
| 16 | `DATABASE_URL` / `DIRECT_URL` | A | Neon + Vercel **and** GitHub Actions | Yes (both stores) | Near-ZDT w/ sequencing; brief window | No | No | **CRITICAL** |
| 17 | `PAYMENTS_ENCRYPTION_KEY` | C | App + Vercel; encrypts **stored** payment connections | Yes | **Depends on path (§6.1)** | **Yes** | Maybe (CardCom §6.2) | **CRITICAL** |
| 18 | `GMAIL_TOKEN_ENCRYPTION_KEY` | C | App + Vercel; encrypts **stored** Gmail tokens | Yes | **Depends on path (§6.1)** | **Yes** | Maybe (re-connect) | **CRITICAL** |
| 19 | `WHATSAPP_TOKEN_ENCRYPTION_KEY` | C | App + Vercel; encrypts **stored** WhatsApp tokens | Yes | **Depends on path (§6.1)** | **Yes** | Maybe (re-connect) | **CRITICAL** |
| 20 | `EMAIL_TOKEN_ENCRYPTION_KEY_ID` | C | App/key-store reference | Reconcile w/ key store | Depends | **Yes (referenced key)** | Maybe | **CRITICAL** |
| 21 | `BILLING_AUTHORITY_ENCRYPTION_KEY` | C | App + Vercel; encrypts **stored** ITA/SHAAM tokens + app client secret (`BillingAuthorityConnection`, `BillingAuthorityApp`) | Yes | **Depends on path (§6.1)** | **Yes** | Maybe (ITA re-auth) | **CRITICAL** |
| — | `GITHUB_TOKEN` | A | GitHub Actions (auto per-run) | **N/A — auto-provisioned, not manually rotatable** | — | — | — | N/A |
| — | CardCom / Tranzila provider creds | B | **DB, per-business** (encrypted via `PAYMENTS_ENCRYPTION_KEY`), **not env** | Vendor + in-app re-entry (§6.2) | No | tied to #17 | **Yes, per business** | HIGH |

**Not secrets — no rotation** (evidence: flags / URLs / model names / public ids): `NODE_ENV`, `NEXT_PUBLIC_*`, `*_BASE_URL`, `*_MODEL`/`*_VARIANT`/`*_ENABLED`, `STORAGE_PROVIDER`, `RATE_LIMIT_BACKEND`, `META_APP_ID`, `GOOGLE_OAUTH_CLIENT_ID`, `R2_ACCOUNT_ID`/`R2_BUCKET_NAME`, `CARDCOM_BASE_URL`, `PAYMENTS_PUBLIC_BASE_URL`. `PLATFORM_ADMIN_EMAILS` = sensitive config, not a rotatable credential.

## 5. Per-secret operational detail (source · coordination · verify · rollback)
Rotation = **create/obtain new → update every store that holds it → redeploy → verify → revoke old**. Rollback (unless noted) = **re-instate the previous value in the store(s) and redeploy**; keep the old credential active until verification passes, then revoke.

- **Provider API keys (1–5, OpenAI/Pexels/Creatomate/Upstash/R2) — Class B:** self-service in the provider console. ZDT: create the **new** key, set it in Vercel, redeploy, verify, then revoke the old. Rollback = revert Vercel value (old key valid until revoked — revoke only after verification).
- **`POS_INGEST_SECRET` (6) — Class A:** regenerate, update Vercel **and every POS caller**. Not ZDT — callers with the old secret are rejected until updated. Rollback = restore old value everywhere.
- **Meta set (7–9) — Class B:** rotate `WHATSAPP_APP_SECRET` + regenerate `WHATSAPP_ACCESS_TOKEN`; choose a new `WHATSAPP_WEBHOOK_VERIFY_TOKEN` and set it **in Vercel and the Meta webhook config together** (mismatch fails re-subscription). Verify: webhook re-verify handshake + inbound media fetch. Rollback = restore prior values both sides.
- **Google set (10–11) — Class B:** add a **new** OAuth client secret before deleting old; create a **new** SA key then delete old. Verify: Gmail connect status/scan 200; one Vision OCR path. Rollback = keep old until verified.
- **ITA/SHAAM (12) — Class B:** **vendor-coordination** with the Israel Tax Authority app registration; may force re-auth. Verify: authority OAuth start/callback in sandbox. `requires vendor coordination`.
- **`NEON_API_KEY` (13) / `CI_DATABASE_URL` (14) — Class A:** GitHub Actions store; rotate in Neon, update the GitHub secret. Verify: re-run release-infra-registry / release-ci-verify green. Not prod-runtime.
- **`AUTH_TOKEN_SECRET` (15) — Class A:** see §6.3.
- **`DATABASE_URL`/`DIRECT_URL` (16) — Class A:** reset the Neon role password once; update **both vars in Vercel and in GitHub Actions**, atomically. Verify: `GET /api/health` DB-healthy + read query; migration dry-run uses `DIRECT_URL`. Rollback = a Neon password reset is one-way → **rollback = reset again to a known value and re-propagate**; hold a maintenance window.
- **Encryption keys (17–20) — Class C:** **do not swap naively — §6.1.**

## 6. Three findings that must NOT be "smoothed over"
### 6.1 Cryptographic keys — a PRODUCT decision, not an engineering one
`PAYMENTS_ENCRYPTION_KEY`, `GMAIL_TOKEN_ENCRYPTION_KEY`, `WHATSAPP_TOKEN_ENCRYPTION_KEY`, `BILLING_AUTHORITY_ENCRYPTION_KEY`, and the key behind `EMAIL_TOKEN_ENCRYPTION_KEY_ID` protect **already-stored ciphertext**. Replacing the env value **breaks decryption of every stored record**. **No autonomous decision** — the two alternatives, for the product owner to choose:

| | **A. Re-encryption Migration** | **B. Re-connect (invalidate stored)** |
|---|---|---|
| **How** | Support dual keys; decrypt-with-old → re-encrypt-with-new for every record; retire old key | Set new key; treat stored ciphertext as invalid; users re-authenticate / re-enter connections |
| **Pros** | Zero user impact; no re-auth; transparent | Simple; no migration code; guarantees old key gone |
| **Cons** | Migration code + dual-key window + careful ordering; more engineering | User-visible disruption; every integration re-connected; possible payment/intake gap |
| **Impact** | Eng effort, low user impact | Low eng effort, high user/ops impact |
| **Best when** | Live stored tokens/connections must survive | Few/no live stored records, or clean-slate acceptable |

**Status:** `Unknown — requires product decision`. **Remains open** until an explicit, documented product decision is made. No Re-encryption Migration and no Re-connect may be executed before then. If G-1 is scoped only to *exposed-credential* rotation, these Class C keys may be deferred with an **explicit recorded decision** — never silently skipped.

### 6.2 CardCom / payment-provider credentials — rotation is NOT a Vercel value swap
Evidence: app code reads only `CARDCOM_BASE_URL` from env. The actual provider API credentials are stored **per business in the database**, encrypted via `PAYMENTS_ENCRYPTION_KEY`. Rotating CardCom requires, **for each business**: (1) rotate at the **CardCom/Tranzila console**; (2) **re-enter** via the **in-app connection flow** (re-encrypts into the DB); (3) verify a **sandbox/low-value transaction**. A Vercel env change alone does **nothing**. *(Owner to confirm exact DB storage/flow.)* If §6.1 path **B** is chosen, **all** businesses' stored CardCom credentials are invalidated and must be re-entered.

### 6.3 `AUTH_TOKEN_SECRET` — all active sessions WILL drop (expected)
Rotating invalidates every issued session token: **all logged-in users are signed out and must log in again.** This is **expected behavior, not a fault.** Rotate in a low-traffic window, communicate if needed, expect a re-login spike. There is no ZDT path — session invalidation is the point.

## 7. Two required evidence types (both mandatory to close G-1)
- **Evidence of Rotation** — proof the value was replaced (provider console new key + old revoked; store showing updated value/timestamp; old credential confirmed rejected).
- **Evidence of Functionality** — proof the system still works on the new secret (the §9 per-service check passing **against Production** after redeploy, with captured output).

Both are required. Per the Declaration, evidence lives **outside the repo** (§2.7); the checklist holds **links/IDs**, not values.

## 8. Real-time operational checklist (fill during rotation → this becomes the closure artifact)
Tick each row live. The completed table + sign-off is the Rotation Event record (§2.6).

| # | Secret | Cls | Rotated at (store) | By (executor) | Date/time | Evidence of Rotation (link) | Evidence of Functionality (§9 check + result) | Old revoked? | Notes |
|---|---|---|---|---|---|---|---|---|---|
| 1 | PEXELS_API_KEY | B | | | | | | | |
| 2 | CREATOMATE_API_KEY | B | | | | | | | |
| 3 | OPENAI_API_KEY | B | | | | | | | |
| 4 | UPSTASH_REDIS_REST_TOKEN | B | | | | | | | |
| 5 | R2_ACCESS_KEY_ID / SECRET | B | | | | | | | |
| 6 | POS_INGEST_SECRET | A | | | | | | | |
| 7 | WHATSAPP_APP_SECRET | B | | | | | | | |
| 8 | WHATSAPP_ACCESS_TOKEN | B | | | | | | | |
| 9 | WHATSAPP_WEBHOOK_VERIFY_TOKEN | B | | | | | | | |
| 10 | GOOGLE_OAUTH_CLIENT_SECRET | B | | | | | | | |
| 11 | GOOGLE_APPLICATION_CREDENTIALS | B | | | | | | | |
| 12 | BILLING_AUTHORITY_CLIENT_SECRET | B | | | | | | | vendor-coordinated |
| 13 | NEON_API_KEY (GH Actions) | A | | | | | | | |
| 14 | CI_DATABASE_URL (GH Actions) | A | | | | | | | |
| 15 | AUTH_TOKEN_SECRET | A | | | | | | | sessions dropped (expected) |
| 16 | DATABASE_URL / DIRECT_URL (Vercel **+** GH Actions) | A | | | | | | | both stores |
| 17 | PAYMENTS_ENCRYPTION_KEY | C | | | | | | | §6.1 decision: ____ |
| 18 | GMAIL_TOKEN_ENCRYPTION_KEY | C | | | | | | | §6.1 decision: ____ |
| 19 | WHATSAPP_TOKEN_ENCRYPTION_KEY | C | | | | | | | §6.1 decision: ____ |
| 20 | EMAIL_TOKEN_ENCRYPTION_KEY_ID (referenced key) | C | | | | | | | §6.1 decision: ____ |
| 21 | BILLING_AUTHORITY_ENCRYPTION_KEY | C | | | | | | | §6.1 decision: ____ |
| — | CardCom/Tranzila per-business creds | B | | | | | | | per-business re-entry (§6.2) |
| — | Vercel-env ↔ code reconciliation done | — | | | | | | | any prod-only secret? |
| — | GitHub-secrets ↔ workflow reconciliation done | — | | | | | | | any store-only secret? |

**Sign-off:** Approver ______  Executor ______  Date ______  Outcome: completed / partial / aborted.

## 9. Per-service functionality verification
Rotate → redeploy so the new value is picked up → run the matching check against **Production**:
- **Neon (16):** `GET /api/health` DB-healthy + read query; migration dry-run via `DIRECT_URL`.
- **Auth (15):** fresh login issues + accepts a session cookie.
- **OpenAI (3):** one content/AI action → 200.
- **Google/Gmail (10):** Gmail connect status/scan → 200. **Vision (11):** one OCR path succeeds.
- **Meta/WhatsApp (7–9):** webhook re-verify handshake passes; inbound media fetch works.
- **R2 (5):** upload + signed-URL fetch of a document.
- **Upstash (4):** rate-limiter backend responds (no memory-fallback warning).
- **Creatomate/Pexels (1–2):** one render / one stock lookup → 200.
- **Payments/CardCom (§6.2):** re-entered connection completes a sandbox/low-value transaction per business.
- **ITA/SHAAM (12):** authority OAuth start/callback in sandbox.
- **NEON_API_KEY / CI_DATABASE_URL (13–14):** re-run release-infra-registry / release-ci-verify green.

## 10. G-1 completion criteria → then the ordered close
G-1 → **Completed** only when the Exit Criteria (§2.5) are met: every §4 secret has **both** evidence types recorded in §8; §6.1 keys each have a recorded product decision (or explicit deferral); both reconciliations done; old credentials revoked; checklist signed. Then reports/audit (Final Release Report §4, System Audit G-1) move to `Completed` **with evidence links** (§2.8).

**Only then**, in order: **(1) G-1 → Completed → (2) update all reports/audits → (3) merge PR #54 → (4) main Required checks green → (5) Production Deploy succeeds → (6) full Production smoke test → (7) confirm no regression → (8) formally close Phase 1 → then open WP2 (Privacy).**

## 11. What I can / cannot do
- **Cannot:** access any provider console, Vercel env, or GitHub secret store → cannot rotate or read live values (the reason G-1 is `Blocked External`).
- **Can (on your signal):** refine this runbook; once you supply the filled §8 checklist + §9 evidence and Exit Criteria (§2.5) are met, update G-1 → Completed in the reports/audit and execute steps 3–8 in order. I will **not** make the §6.1 product decision for you.
