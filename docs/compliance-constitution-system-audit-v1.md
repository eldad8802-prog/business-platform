# Dubiz Compliance Constitution — System Audit v1

**Status:** Draft v1 (evidence-based audit — foundation deliverable of the Compliance Constitution Initiative)
**Date:** 2026-07-02
**Scope:** Full-system compliance audit preceding the constitutional framework (WP1–WP9)
**Method:** Evidence First. Every finding below cites code, schema, or an existing document. Where no evidence exists, the finding is marked **Unknown (no evidence)**. Nothing here is invented.

---

## 0. How to read this document

Each area is classified with one of four states, per the Initiative mandate:

- **Implemented** — evidence shows the control exists and is applied.
- **Partial** — evidence shows the control exists but is incomplete or inconsistently applied.
- **Missing** — searched for, no evidence found, and its absence is compliance-relevant.
- **Unknown** — no evidence either way; requires investigation before any claim.

This audit is a **projection over the current codebase**, not a legal opinion. It is the input to the Gap Analysis (§3) and the Remediation Backlog (§4). It does **not** itself change behavior.

---

## 1. Executive summary

Dubiz already carries an unusually deep governance substrate for a platform its size: **107 markdown governance documents**, a full security-architecture planning body (`security-policy.md`, `security-architecture-review.md`, `security-gap-matrix.md`, decisions D1/D2, Wave-1), a frozen tax-authority/SHAAM compliance track (H1–H6), append-only audit trails for billing/payments/platform, and strong multi-tenant isolation enforced at query **and** cryptographic (AAD) levels.

The gap is not "no compliance thinking." The gap is that compliance is **scattered, security-and-tax-centric, and not yet a unifying architectural constraint**. Specifically:

- **No accessibility (WCAG) governance exists at all** — no doc, no tooling, no Definition of Done.
- **Privacy is mostly reactive** — public Privacy Policy + ToS pages exist, but there is **no consent record, no data-subject deletion (right to erasure), no full data export, no retention policy** in the system.
- **A live secret-exposure issue** exists in the working tree that needs immediate operational attention (§2 Security, finding S-1).
- The many strong controls that **do** exist have never been mapped to a single compliance framework, so their coverage cannot be asserted or audited as a whole.

The recommended posture (per Initiative): treat this audit as the load-bearing first step, then build the WP1–WP9 constitutions **risk-first**, starting with the areas that are both high-exposure and currently ungoverned (Privacy, Accessibility), while formalizing the strong-but-scattered Security/Tax work into the constitutional frame.

---

## 2. Area-by-area findings

### 2.1 Authentication — **Implemented**

- Custom HMAC-SHA256 bearer tokens (`v1.<payload>.<sig>`), 30-day TTL, timing-safe verification — `lib/auth-token.ts:73-149`.
- `AUTH_TOKEN_SECRET` fail-closed at runtime — `lib/auth-token.ts:26-35`.
- Login: bcrypt(rounds=10) compare, rate-limited 10/60s/IP — `app/api/auth/login/route.ts:34-85`.
- Register: bcrypt hash, rate-limited 3/hour/IP — `app/api/auth/register/route.ts:9-43`.
- **Partial:** sessions are **stateless** — no server-side revocation / logout invalidation. A 30-day token cannot be revoked before expiry. (Note: `security-d1-session-architecture-review.md` already proposes server-side Postgres sessions — approved, not yet implemented.)

### 2.2 Authorization / multi-tenant isolation — **Implemented**

- Per-request `businessId` scoping confirmed across 50+ (sampled) / 150+ (claimed) API routes — e.g. `app/api/billing/documents/[id]/route.ts:37-45`.
- Platform-admin RBAC with email allowlist + production fail-closed — `lib/auth/platform-admin.ts:14-66`.
- Crypto-level tenant binding: `businessId` bound as GCM AAD so ciphertext cannot be replayed across tenants — `lib/services/integrations/whatsapp/token-crypto.service.ts`, `lib/services/payments/payment-crypto.service.ts`.
- Isolation is **tested** — `lib/services/obligations/obligation-service.verify.test.ts`, billing authority tests.
- **Partial / Missing:** no **intra-business** role granularity. Every authenticated user in a business can perform every action (no viewer/editor/admin split). Lateral privilege within a tenant is unbounded.

### 2.3 Secret management — **Partial (with one urgent finding)**

- Source code contains **no hardcoded secrets** — all via `process.env`, with fail-closed guards for critical keys.
- Sensitive material encrypted at rest (see §2.5).
- **S-1 (URGENT, operational): live production-grade secrets sit in plaintext in the working-tree `.env`** — OpenAI API key, Google OAuth client secret, `AUTH_TOKEN_SECRET`, WhatsApp app secret + token-encryption key, Gmail token-encryption key, WhatsApp webhook verify token, and full DB credentials. `.env` is in `.gitignore` and `git ls-files` shows it is **not** in git history, so this is **not** a repo-history leak. However these values were read during this audit and should be treated as **exposed**. **Recommendation: rotate all of them and move to a managed secret store.** This is an ops action, not a code change.
- **Missing:** no documented key-rotation policy (though `encryptionKeyId` fields exist to support versioned rotation).

### 2.4 Audit logging — **Implemented (domain-scoped, not universal)**

- Append-only event tables: `PlatformAuditEvent` (with `ip`/`userAgent`), `BillingAuditEvent` (with tamper-evident `eventHash`), `PaymentAuditEvent`, `LearningEvent`, `ProductUsageEvent`, `ContentEvent` — `prisma/schema.prisma` (multiple ranges).
- **Partial:** there is **no cross-cutting "personal-data access" audit**. Reads of customer PII, messages, and documents are not audited. Business-scoped audit endpoint does not log IP. No SAR (subject-access-request) surface.

### 2.5 Encryption — **Implemented for credentials; Missing for PII at rest**

- AES-256-GCM for: WhatsApp tokens, payment/merchant credentials, billing-authority tokens, and Gmail OAuth tokens.
- **Gmail token note (conflict resolved):** the file is named `token-crypto.placeholder.ts` but the **current** path writes `gcm_v1:` AES-256-GCM; it retains **read-only** backward-compat for a legacy `enc_v0:` base64 format — `lib/services/integrations/gmail/token-crypto.placeholder.ts:14-63`. So new Gmail tokens are properly encrypted; any legacy `enc_v0:` rows remain weakly protected until re-issued. Rename + legacy sweep recommended.
- DB transport encrypted (`sslmode=require`).
- **Missing:** **PII is stored plaintext at rest** — `Customer` name/phone/email/taxId, `Message.contentText`, `Document.ocrText`, email `From`/`Subject`. No application-layer encryption for personal data.

### 2.6 API endpoint protection — **Implemented**

- Uniform `getCurrentUser(req)` → 401 gate; strict numeric-ID parsing; centralized `ValidationError` → HTTP mapping (`lib/handle-error.ts`).
- Intentionally-unauthenticated routes are each defended: `login`/`register` (rate-limited), WhatsApp webhook (HMAC `X-Hub-Signature-256`, timing-safe), Gmail callback (state + PKCE), payment webhooks (secret header), debug routes return 404.
- **Partial:** no CSRF tokens on state-changing endpoints (bearer-header auth mitigates for API clients, but cookie-based browser flows would need review). **Security headers → W0 added application-layer headers** in `next.config.ts`: HSTS, X-Frame-Options (SAMEORIGIN), X-Content-Type-Options (nosniff), Referrer-Policy **enforced**; **CSP in Report-Only** (conservative — enforce deferred until report data proves no breakage) (WP3 SEC-18).

### 2.7 Privacy & personal data — **Partial → Missing on data-subject rights**

- **Data model (Implemented, well-mapped):** PII spans `User`, `Customer`, `Lead`, `BusinessProfile`, `Message`/`Conversation`, `Appointment`, `BillingDocument`, `FinancialDocument`/`ExtractedData`, `Email/WhatsAppAttachmentImport`, `OAuthToken`, `Email/WhatsAppConnection`, `PartyResolutionClaim`, `Payment*`. Highly sensitive: `taxId`, phone, financial docs, message content, OAuth tokens. No full card data stored (only `cardLast4`) — `prisma/schema.prisma:2565-2571`.
- **Public policy pages (Implemented):** `app/(corporate)/privacy/page.tsx` (updated 2026-06-04, operator PRO MAX GROUP) and `app/(corporate)/terms/page.tsx`.
- **Consent (Missing):** no `Consent`/`TermsAcceptance` table, no in-app consent capture, no withdrawal. Consent is implied-by-use only.
- **Retention (Missing):** only tokens/payment-links/coupons have expiry. Messages, conversations, customers, documents persist **indefinitely**. No TTL, no purge job.
- **Deletion / right to erasure (Missing):** no user, customer, or business hard-delete endpoint. `Business.archivedAt` is soft-delete only; `onDelete: Cascade` exists structurally but no erasure workflow.
- **Export / portability (Partial):** financial export exists (`app/api/reports/export-zip/route.ts`, `/export`), but **no** export of customer/CRM, messages, or account data.

### 2.8 Third-party integrations & data sharing — **Implemented (per-integration), governance Partial**

Data leaves Dubiz to: **Google** (Gmail readonly + Vision OCR — full document bytes sent), **Meta/WhatsApp** (messages, phone numbers), **OpenAI** (`gpt-4.1-mini` — business name/offer/strategy/audience in prompts; no customer PII intended, no response persistence, subject to OpenAI's default retention), **Cardcom/Tranzila** (hosted checkout — no card data touches Dubiz; Cardcom verifies via `GetLpResult`, **Tranzila is signal-only and needs hardening before production**), **Cloudflare R2** (files, businessId-scoped, signed URLs), **Creatomate** (video: script/caption/asset URLs), **Pexels** (search terms), **Neon** (DB), **Upstash** (rate-limit counters only, no PII).
- **Gaps:** no data-processing inventory/DPA mapping for these processors; OpenAI prompts carry business-confidential (non-customer) content in the clear; Tranzila webhook authority unverified.

### 2.9 Accessibility — **Partial UI, Missing governance**

- **RTL (Implemented):** `dir="rtl" lang="he"` at root `app/layout.tsx:34` + component-level directives. **Gap:** physical CSS props instead of logical properties; manual per-component `dir`.
- **Semantic/ARIA (Partial):** ~84 `aria-label` instances, good nav/dialog coverage; **missing on form fields** (`aria-describedby`/`aria-required`/`aria-invalid` largely absent), some `role="button"` on non-buttons.
- **Keyboard/focus (Partial):** Escape handling + focus-visible on some pages; **no focus trap, no focus restoration, no skip links**.
- **Contrast tokens (Implemented, unverified):** `lib/design/tokens.ts` has semantic colors with apparent AA intent, but **no formal contrast verification**; low-alpha focus ring is a risk.
- **Reduced motion (Minimal):** one `prefers-reduced-motion` rule total; animations otherwise unguarded.
- **Tooling (Missing):** no `eslint-plugin-jsx-a11y`, no `axe`/`jest-axe`, no WCAG level declared, no a11y tests, no a11y Definition of Done.

### 2.10 Existing governance & documentation — **Implemented (rich but unconsolidated)**

- 107 governance docs. Compliance-relevant clusters: **Tax/SHAAM** (12+ billing-compliance docs, `docs/compliance/tax-authority/*` with a real simulator certification), **Security** (6+ planning docs, D1/D2 locked), **Payments authority** (`payments-authority-principle-v1.md`), **Audit foundation** (`billing-dedicated-audit-foundation-plan.md`), **Product constitutions** (5 "constitution"-named docs).
- **Gap:** **no accessibility doc, no privacy constitution, no AI-governance constitution, no unified compliance map, no per-PR compliance Definition of Done.** Governance is siloed by feature, not unified by compliance domain.

---

## 3. Gap analysis (consolidated)

| # | Domain | Gap | Status | Risk |
|---|--------|-----|--------|------|
| G-1 | Security/Ops | Live secrets in working-tree `.env` (not in git history) — need rotation | Partial | **Critical (ops)** |
| G-2 | Privacy | No consent record / capture / withdrawal | Missing | High |
| G-3 | Privacy | No right-to-erasure (user/customer/business hard delete) | Missing | High |
| G-4 | Privacy | No retention policy / TTL / purge for PII | Missing | High |
| G-5 | Privacy | Export limited to financial data; no CRM/message/account export | Partial | Medium |
| G-6 | Privacy | PII plaintext at rest (customer, messages, OCR text) | Missing | Medium-High |
| G-7 | Accessibility | WCAG governance + DoD defined (WP1). Tooling: `eslint-plugin-jsx-a11y` full recommended set as `warn` (W0). **W9: ENFORCED on changed files** (blocking CI `a11y-changed-files` + `scripts/ci/check-jsx-a11y.mjs`; legacy grandfathered). Full legacy retrofit + promotion to `error` in base config still pending | Partial→Enforced (new code) | High (legal, IL Equal Rights / WCAG 2.0 AA obligation) |
| G-8 | Accessibility | Forms lack a11y (labels-to-error linkage, required/invalid) | Partial | Medium |
| G-9 | Accessibility | No focus trap / skip links / reduced-motion / contrast verification | Partial | Medium |
| G-10 | Security | Stateless tokens — no revocation/logout invalidation | Partial | Medium |
| G-11 | Security | No intra-business role granularity | Partial | Medium |
| G-12 | Privacy/Audit | No personal-data access audit / SAR surface | Missing | Medium |
| G-13 | Integrations | No processor/DPA inventory + data-flow map; Tranzila webhook unverified | Partial | Medium |
| G-14 | AI | No AI-governance policy (allowed/prohibited data, transparency, logging) | Missing | Medium |
| G-15 | Governance | No unified compliance framework / per-PR compliance DoD | Missing | High (root cause of drift) |
| G-16 | Security | Legacy `enc_v0:` base64 Gmail tokens until re-issued; file mis-named | Partial | Low-Medium |
| G-17 | Compliance | Google OAuth `gmail.readonly` (restricted scope, server-stored) requires app verification + annual CASA security assessment — current status unverified | Unknown | High (integration-suspension risk) |
| G-18 | Legal | Missing legal instruments: AI Usage Policy, Payment/Subscription Terms, Refund Policy, DPA, public Security Statement (Cookie Policy downgraded — see note) | Missing/Unknown | Medium-High |
| G-19 | Accessibility | No published accessibility statement (הצהרת נגישות) or accessibility coordinator (רכז נגישות) — required by IS 5568/ERPD beyond technical WCAG (WP1 A-21/A-22) | Missing | High (current legal duty) |
| G-20 | Security/Privacy | No incident-response / breach-notification **process** (severity, notify-SLA, workflow) — Amendment 13 current duty (WP3 SEC-20/21) | Missing | High (current legal duty) |
| G-21 | Compliance | No cross-border transfer basis / data-residency rule; processor regions unverified (WP5 CMP-12) | Missing/Unknown | Medium |
| G-22 | Security/Privacy | Backups / disaster-recovery ungoverned — undermines erasure & retention (Review M-3) — **owned WP3 SEC-22** | Missing | Medium |
| G-23 | Security | **W0 added `public/.well-known/security.txt`** with a **temporary** contact (promaxgroup.co.il/contact); dedicated security channel + triage SLA still pending (Review M-4) — **owned WP3 SEC-23** | Partial (was Missing) | Low-Medium |
| G-24 | Security/Documents | SEC-24 pipeline durability — **Covered across all central paths (W7+W8)**. W7: WhatsApp OCR-failure no longer discards. **W8: root-cause fix** — shared `createDocumentFromOcrText` extraction is now best-effort, so extraction failure no longer discards in Gmail+WhatsApp; cross-path `verify:documents-sec24` gate + `verify:whatsapp-webhook-pr4`. Remaining edge (out of enrichment scope): genuine DB-record-creation failure deletes orphan (consistent, documented) — **owned WP3 SEC-24** | Covered (enrichment) | High |
| G-25 | Compliance/Tax | SHAAM export has no production guard against emitting simulator/placeholder identity (Validation latent incident) — **owned WP5 CMP-13 (v1.2)** | Missing | Medium |
| G-26 | Security | Gmail OAuth tokens use AES-256-GCM but bind no `businessId` AAD (unlike WhatsApp) — cross-tenant paste-protection weaker (Validation) — **owned WP3 SEC-10 (v1.2)** | Partial | Low-Medium |

**v1.1 evidence resolutions (Review §4):** security headers → **Missing at app layer** (was Unknown; `next.config.ts`/`vercel.json` have none — see §2.6); cookies → **essential-only, no third-party trackers** (consent banner not required, disclosure suffices; G-18 cookie line downgraded); mobile app → **confirmed none** (no RN/Expo/Capacitor), so Apple/Play remain N/A by evidence.

---

## 4. Prioritized remediation backlog (risk-first)

**P0 — do now (operational, no design debate):**
- R-1 (G-1): Rotate all secrets currently in `.env`; adopt a managed secret store; document rotation policy.

**P1 — highest compliance exposure, currently ungoverned:**
- R-2 (G-7,G-8,G-9): **WP1 Accessibility Constitution** + add `eslint-plugin-jsx-a11y` + a11y Definition of Done. (Israeli law makes WCAG 2.0 AA a legal obligation for a commercial service — highest legal exposure among the gaps.)
- R-3 (G-2,G-3,G-4,G-5,G-6,G-12): **WP2 Privacy Constitution** with a concrete data-subject-rights plan (consent record, erasure workflow, retention/TTL, full export, access audit).

**P2 — formalize strong-but-scattered work into the constitution:**
- R-4 (G-15): **WP7 Development Constitution** — the per-PR compliance Definition of Done (this is the mechanism that stops future drift).
- R-5: **WP3 Security Constitution** — consolidate existing `security-*` docs; fold in G-10 (revocation), G-11 (roles), CSRF/headers confirmation.
- R-6 (G-14): **WP6 AI Constitution**.
- R-7 (G-13): **WP5 Compliance Constitution** — processor/DPA inventory, framework mapping (IL Privacy Law, GDPR, Google/Meta/Apple/Play, tax authority), Tranzila hardening.

**P3 — complete the frame:**
- R-8: **WP4 Legal Constitution** (align existing privacy/terms pages, add cookie/AI-usage/refund/DPA).
- R-9: **WP8 Documentation Constitution** + **WP9 Governance Constitution** (versioning, exceptions, audit cadence, ownership).

---

## 5. Mapping to the Work Packages (WP1–WP9) — constitutional coverage

All nine constitutions are at **v1.1, Status: Candidate for Ratification** (per WP9 §9), after the independent Review & the v1.1 remediation pass ([compliance-constitution-review-ratification-report-v1.md](compliance-constitution-review-ratification-report-v1.md)). Drafting a constitution closes the **governance** gap for its domain; the **code/ops** remediation it defines remains open and is tracked in §4 and each doc's remediation section. Per WP9 §10, requirements bind on **New Development Scope** at ratification; **Legacy Scope** is grandfathered with scheduled remediation.

| WP | Constitution | Document | Governance status | Code/ops remediation |
|----|--------------|----------|-------------------|----------------------|
| WP1 | Accessibility | [accessibility-constitution-v1.md](accessibility-constitution-v1.md) | ✅ Drafted | Open (G-7/8/9) |
| WP2 | Privacy | [privacy-constitution-v1.md](privacy-constitution-v1.md) | ✅ Drafted | Open (G-2…G-6, G-12) |
| WP3 | Security | [security-constitution-v1.md](security-constitution-v1.md) | ✅ Drafted (consolidates `security-*`) | Open (G-1, G-10, G-11, G-16) |
| WP4 | Legal | [legal-constitution-v1.md](legal-constitution-v1.md) | ✅ Drafted | Open (G-18 missing instruments) |
| WP5 | Compliance | [compliance-frameworks-constitution-v1.md](compliance-frameworks-constitution-v1.md) | ✅ Drafted | Open (G-13 DPA inventory, G-17 Google CASA) |
| WP6 | AI | [ai-constitution-v1.md](ai-constitution-v1.md) | ✅ Drafted | Open (G-14) |
| WP7 | Development | [development-constitution-v1.md](development-constitution-v1.md) | ✅ Drafted | Open (G-15 — PR gate) |
| WP8 | Documentation | [documentation-constitution-v1.md](documentation-constitution-v1.md) | ✅ Drafted | Process adoption |
| WP9 | Governance | [governance-constitution-v1.md](governance-constitution-v1.md) | ✅ Drafted | Ratification + owners |

---

## 6. Definition of Done for this audit

- [x] Evidence-based, no invented requirements.
- [x] Every area classified Implemented / Partial / Missing / Unknown.
- [x] Gap analysis + risk-ranked remediation backlog.
- [x] Mapped to WP1–WP9.
- [x] **Sequencing approved by owner** (risk-order; WCAG target set by evidence — 2.0 AA floor / 2.2 AA target).
- [x] **All nine constitutions drafted** (§5) — governance layer complete, awaiting ratification (WP9).
- [ ] Secret rotation (R-1) actioned by owner (ops) — **P0, open**.
- [ ] Code/ops remediation backlog executed (per each constitution's remediation section).

---

*This audit is the foundation deliverable. It changes no behavior. Constitutional documents (WP1–WP9) are drafted only after sequencing is approved, and each must preserve consistency between code, documentation, and actual system behavior.*
