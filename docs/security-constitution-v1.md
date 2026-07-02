# Dubiz Security Constitution v1.1 (WP3)

> **Constitution Status:** `Ratified` (ratified 2026-07-02 per WP9 GOV-1) · **Version:** v1.2 · **Effective Date:** upon ratification
> **Legacy Scope:** existing endpoints/tokens/creds grandfathered per WP9 §10; gaps G-1/G-6/G-10/G-11/G-16/G-24/G-26 are scheduled remediation. **Exception:** G-1 secret rotation is P0 and not subject to grandfathering.
> **New Development Scope:** new/changed security-relevant code binds to `Immediately Enforceable` rows in full (§9 matrix).
> Shared machinery in **WP9 §9–§14**.

**Date:** 2026-07-02 (v1.1)
**Depends on:** [compliance-constitution-system-audit-v1.md](compliance-constitution-system-audit-v1.md) (findings G-1, G-6, G-10, G-11, G-16), [governance-constitution-v1.md](governance-constitution-v1.md) (WP9 shared machinery), [compliance-constitution-review-ratification-report-v1.md](compliance-constitution-review-ratification-report-v1.md)
**Consolidates (does not replace):** `security-policy.md`, `security-architecture-review.md`, `security-gap-matrix.md`, `security-d1-session-architecture-review.md`, `security-d2-business-isolation-impact-review.md`, `security-d2-h1-h5-final-decision-package.md`, `security-wave-1-*`, `rate-limiting-and-abuse-protection-review.md`, `upload-and-file-handling-patterns-review.md`.
**Normative language:** MUST / MUST NOT / SHOULD / MAY per RFC 2119.

---

## 1. Purpose (מטרה)

To establish the **binding security constitution** for Dubiz and to make the existing, rich-but-scattered security body (the `security-*` planning documents) the **enforced source of truth** rather than optional planning. This constitution does not re-derive security architecture; it **elevates** the already-locked decisions (D1 sessions, D2 isolation, Wave-1) to constitutional status and binds every future change to them.

## 2. Scope

All authentication, authorization, secret management, encryption, audit logging, integration security, file handling, rate-limiting, and infrastructure configuration across the platform. Applies to all tenants, all integrations (Gmail, WhatsApp, Payments, AI, storage), and all agent- or human-authored changes.

## 3. Principles

- **SEC-P1 Multi-tenant isolation is sacred.** Every read and write MUST be scoped by `businessId`; isolation is enforced at query **and** cryptographic (GCM AAD) layers. (Audit §2.2 — Implemented; MUST NOT regress.)
- **SEC-P2 Fail closed.** Missing secrets, failed verification, and unknown state MUST deny, not allow (existing pattern: `requireAuthTokenSecret`, token-crypto returning `null`).
- **SEC-P3 Least privilege.** Access defaults to the minimum; platform-admin is allowlist-gated and production-fail-closed.
- **SEC-P4 Secrets never live in code or history.** `process.env` only; `.env*` git-ignored; managed store for production.
- **SEC-P5 Signal is not authority.** Webhooks are signals; authority requires verification (already ratified in `payments-authority-principle-v1.md`).
- **SEC-P6 Defense in depth.** Encryption at rest, encryption in transit, signature verification, rate-limiting, and audit are layered, not alternatives.
- **SEC-P7 Locked decisions are binding.** D1/D2 and Wave-1 decisions MUST NOT be reopened except through the Governance Constitution (WP9) change process.

## 4. Mandatory Requirements

### 4.1 Authentication & sessions
- **SEC-1** Authentication MUST use the signed-token mechanism (`lib/auth-token.ts`) with timing-safe verification; `AUTH_TOKEN_SECRET` MUST be present (fail-closed).
- **SEC-2** Passwords MUST be hashed with bcrypt (current: rounds=10). Login/register MUST remain rate-limited.
- **SEC-3** **Server-side session revocation MUST be implemented** per the approved **D1** decision (`security-d1-session-architecture-review.md`). The 30-day stateless-token revocation gap (audit **G-10**) is a **tracked gap with a mandatory expiration date** and MUST be recorded in the Exception Register per WP9 §14 — an open-ended "until then" is prohibited (resolves Review **M-9**). `Phase-in Required`.

### 4.2 Authorization & isolation
- **SEC-4** Every authenticated endpoint MUST scope by `user.businessId` (audit §2.2 pattern). New endpoints MUST NOT query PII-bearing tables without a tenant filter. **Three access classes (v1.2 — resolves Validation §5.2 / Must-Fix #4; supersedes the v1.1 "exactly two"):**
  1. **Tenant-scoped (default):** authenticated, bound to `user.businessId`.
  2. **Platform-admin (audited cross-tenant):** legitimately cross-tenant by design (`lib/auth/platform-admin.ts`, Code Verified); exempt from single-`businessId` scoping; bound by SEC-7 (role + allowlist + production fail-closed) and MUST audit every cross-tenant action (SEC-19).
  3. **Public / unauthenticated:** endpoints with no session and no `businessId` (e.g. a public contact-form POST, health check, marketing pages). These MUST NOT read or write PII-bearing tenant tables; MUST be rate-limited (SEC-17) and abuse-protected (spam/bot); and, if they accept input, MUST validate and treat all input as untrusted. There is no tenant to scope to — isolation is achieved by **not touching tenant data at all**.
  SEC-P1's "every read/write scoped by `businessId`" applies to classes 1–2 (any code path that touches tenant data); class 3 is defined by touching **no** tenant data.
- **SEC-5** Business-data isolation MUST follow the **D2** hybrid model (Prisma Extension + ALS + phased RLS, H1–H5) per `security-d2-h1-h5-final-decision-package.md`.
- **SEC-6** **Intra-business role granularity** (viewer/editor/admin) is a required capability (audit **G-11**); until delivered, the "all users can do all actions within a business" state is a **tracked gap**.
- **SEC-7** Platform-admin access MUST remain role- and allowlist-gated with production fail-closed (`lib/auth/platform-admin.ts`).

### 4.3 Secrets & encryption
- **SEC-8** No secret in source or committed config (SEC-P4). CI SHOULD run secret scanning (see WP7 DEV-7).
- **SEC-9 (P0):** the live secrets currently in the working-tree `.env` (audit **G-1**) MUST be **rotated** and moved to a managed store. This is an operational P0.
- **SEC-10** Sensitive material at rest MUST use AES-256-GCM with per-record IV/tag and `businessId`(+provider) bound as AAD. The reference implementations that **do** bind AAD are the WhatsApp, payment, and billing-authority token crypto services (Code Verified). **Correction (v1.2 — resolves Validation §6.3 / Must-Fix #2):** the Gmail token crypto (`token-crypto.placeholder.ts`, `gcm_v1`) uses AES-256-GCM **but binds NO AAD** — it is therefore **not** yet a conformant reference and MUST be brought to the AAD pattern (tracked as audit **G-26**). Prior text that listed Gmail among the AAD exemplars was factually wrong and is removed. New token-at-rest code MUST follow the WhatsApp pattern, not the Gmail one.
- **SEC-11** **PII at rest** (customer taxId, message content, OCR text) MUST be protected. **WP3 owns this mechanism** (WP2 P-6 states *what* is sensitive; WP3 states *how*) — resolves Review m-1. **Searchable-identifier exception (resolves Review C-1):** `phone` and `taxId` are matched for equality by Party Resolution and billing (Code Verified: `party-resolution.service.ts`, `party-backfill.deps.ts:137`, `billing-issue.service.ts:253`); standard random-IV AES-GCM (SEC-10) destroys that equality. These identifiers MUST use **searchable encryption** — deterministic encryption or a keyed **blind index** — so lookup/dedupe survives while the plaintext-equivalent is never returned by read APIs. Non-searched sensitive fields (message content, OCR text, notes) use SEC-10 standard encryption. `Phase-in Required` (blind-index build); the protection principle binds now.
  - **Statutory-legal-record carve-out (v1.2 — resolves Validation §5.1 / Must-Fix #6):** where the law **requires** an identifier to appear in cleartext inside an immutable legal record — the issued **invoice legal snapshot** (`billing-issue.service.ts`, frozen per DEV-9) and the **SHAAM BKMVDATA** export records, both of which must legally reproduce `taxId` in plaintext — the searchable-encryption rule **does not apply**. The rule governs *operational* stores (customer directory, party resolution) where equality lookup happens; it MUST NOT be read to require encrypting a statutory record whose legal purpose is to display the identifier. This removes the SEC-11-vs-DEV-9/SHAAM conflict without weakening operational protection.
- **SEC-12** Encryption keys MUST support versioned rotation via the existing `encryptionKeyId` fields; a rotation policy MUST be documented.
- **SEC-13** The legacy Gmail `enc_v0:` base64 token format (audit **G-16**) MUST be swept and re-issued to `gcm_v1:`; the `token-crypto.placeholder.ts` file SHOULD be renamed to reflect that it is the real implementation.

### 4.4 Integration & endpoint security
- **SEC-14** All webhooks MUST verify authenticity before processing (WhatsApp HMAC `X-Hub-Signature-256`; payment provider secret headers). **Tranzila webhook verification MUST be hardened before production payment acceptance** (audit §2.8).
- **SEC-15** OAuth flows MUST use state + PKCE (Gmail pattern) and store tokens encrypted only.
- **SEC-16** File uploads MUST follow `upload-and-file-handling-patterns-review.md`; stored objects MUST be `businessId`-scoped with signed URLs for private content (R2 adapter pattern).
- **SEC-17** Rate-limiting MUST follow the Wave-1 D3 model (`rate-limiting-and-abuse-protection-review.md`, Upstash); **missing** config MUST fail closed. **Ingestion carve-out (v1.2 — resolves Validation §5.2 / Must-Fix #7):** the fail-**closed** default protects *authorization* paths. For **inbound webhook ingestion of user artifacts** (WhatsApp/Gmail document intake, `webhook/route.ts:123`), a transient rate-limiter error MUST NOT silently drop a legitimate inbound document — these paths MAY fail **open** on a transient backend blip, PROVIDED they remain idempotent and audited. The class distinction is explicit: authorization → fail-closed; artifact-ingestion durability → fail-open-on-transient-error (never on missing config). **Timeout tolerance (the Upstash lesson):** a fail-closed limiter's timeout MUST tolerate real provider latency (cross-region REST) so the limiter's own strictness does not become an availability incident; timeouts MUST be tuned with headroom and health-checked. This resolves the SEC-17-vs-WhatsApp-fail-open contradiction and the fail-closed-caused-outage tension without weakening authorization fail-closed.
- **SEC-18** Security headers (CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy) MUST be set at the application layer. **Status resolved v1.1: Missing** — `next.config.ts` defines only `rewrites()` (no `headers()`), `vercel.json` has no headers, and there is no root middleware (Code Verified). Only Vercel hosting defaults apply. Add via `next.config` `headers()` or middleware. `Phase-in Required`.

### 4.5 Audit
- **SEC-19** Security-relevant actions MUST be recorded in the append-only audit trails (`PlatformAuditEvent`, `BillingAuditEvent` with `eventHash`, `PaymentAuditEvent`). Breach-relevant events MUST be captured to support Amendment-13 breach-notification duties (WP2 cross-reference). **Enumeration (v1.2 — resolves Validation §4.1 / Should-Fix #9):** "security-relevant" MUST at minimum include: integration **connect / disconnect / token-refresh / token-revocation** (Gmail, WhatsApp, payment providers, billing authority), **auth events** (login success/failure already via `ProductUsageEvent`, logout/revocation), **permission/role changes**, and **cross-tenant platform-admin actions** (SEC-4 class 2). This list is the floor, not the ceiling; when in doubt, audit.

### 4.6 Incident Response & Breach Notification *(added v1.1; resolves Review M-1 — current Amendment-13 duty)*

Amendment 13 imposes **current** breach-notification duties; capturing events (SEC-19) is not the same as having a process. Evidence: Legal Source (Amendment 13, WP2 §1).

- **SEC-20** A written **Incident-Response process** MUST exist, defining: severity classification, roles/on-call owner, containment steps, a **notification timeline/SLA** to the Privacy Protection Authority and affected data subjects as required, and a post-incident review. Owner: Security (with Legal for notification). `Phase-in Required` (process authoring) — but this is a **current legal duty**, so per **WP9 GOV-10c** it is **NOT grandfathered** and MUST carry a **mandatory expiration date** in the Exception Register (WP9 §14), not an open-ended phase-in. Registered as audit **G-20**.
- **SEC-21** Breach determination and notification decisions MUST be logged in the audit trail (SEC-19) and coordinated with WP2 (Privacy) and WP4 (Legal). The notification-timing determination is `Legal Review Required`.

### 4.7 Backups, DR & vulnerability disclosure *(added v1.1; resolves Review MAJOR-1 — G-22/G-23 were ownerless)*

- **SEC-22 Backups & disaster recovery:** backups and DR MUST be governed — backup scope, encryption, retention, and restore/DR procedure. **Erasure coupling (WP2 R-Erasure):** a data-subject erasure MUST have a defined treatment for backups (e.g. documented backup-retention window after which erased data ages out), so erasure is not silently incomplete. Owner: Security (with WP2). `Phase-in Required`; builds on `stability-and-production-readiness.md` / `production-recovery-2026-06.md`. Owns audit **G-22**.
- **SEC-23 Vulnerability disclosure:** a responsible-disclosure channel MUST exist — a published `security.txt`/contact and a triage SLA — so externally-reported vulnerabilities have an intake path (distinct from the public Security Statement, WP4 LEG-9). Owner: Security. `Phase-in Required` (low cost). Owns audit **G-23**.

### 4.8 Pipeline durability *(added v1.2; Must-Fix #5 — derives directly from the verified OCR data-loss incident, ad1b75b)*

- **SEC-24 Persist-before-enrichment (no data loss on downstream failure):** any **user-accepted artifact** (uploaded/imported/ingested document, file, or message) MUST be **durably persisted before** any best-effort enrichment step (OCR, extraction, AI). A failure of the enrichment step MUST NOT discard, reject, or lose the artifact — the artifact MUST survive as a `needs_review`/unprocessed record. This is the constitutionalization of the durability guarantee currently living only as a code convention across the three ingestion paths (`app/api/documents/upload/route.ts:204-291`, `gmail/import`, `whatsapp/documents-intake.service.ts`). `Immediately Enforceable` for new ingestion paths; enforcement via a `*.verify.test.ts` gate ("enrichment failure ⇒ artifact still persisted"). Owner: Security + Documents. Owns audit **G-24**. *(This would have prevented the OCR data-loss incident and stops its regression on any future 4th ingestion path.)*

## 5. Definition of Done (security) — a change is NOT complete without

1. New/changed endpoints are tenant-scoped (SEC-4) and fail-closed (SEC-P2).
2. No secret introduced to source/config (SEC-8); new secrets provisioned via managed store.
3. New sensitive-at-rest data encrypted per SEC-10/SEC-11.
4. New webhooks/integrations verify authenticity (SEC-14/SEC-15).
5. Security-relevant actions audited (SEC-19).
6. Any decision touching D1/D2/Wave-1 references the locked doc and does not contradict it (SEC-P7).
7. Any residual risk is a tracked gap (WP7 DEV-P4).

## 6. Verification / Audit

- **SEC-V1** The Security Review (WP7 DEV-3) is mandatory for in-scope PRs.
- **SEC-V2** For **large sensitive databases**, Amendment 13 may require risk assessment + penetration testing every 18 months — applicability is **Unknown — requires legal review** (WP2 §1) and MUST be resolved with counsel.
- **SEC-V3** Isolation tests (existing `*.verify.test.ts`) MUST be maintained and extended for new tenant-scoped surfaces.

## 7. Remediation Guidance (risk order)

1. **P0:** rotate `.env` secrets + managed store (SEC-9 / G-1).
2. Implement D1 server-side session revocation (SEC-3 / G-10).
3. PII-at-rest encryption strategy with WP2 (SEC-11 / G-6).
4. Intra-business roles (SEC-6 / G-11).
5. Harden Tranzila webhook verification (SEC-14).
6. Confirm/implement security headers (SEC-18).
7. Legacy Gmail token sweep + rename (SEC-13 / G-16).
8. Document key-rotation policy (SEC-12).

## 8. Enforcement & Classification Matrix (per WP9 §11–§13)

| Req | Classification | Enforcement | Evidence |
|-----|----------------|-------------|----------|
| SEC-1/2 auth & bcrypt | Immediately Enforceable | Code Review + CI (tests) | Code Verified |
| SEC-3 session revocation (D1) | Phase-in Required | Security Review | Architecture Decision (G-10) |
| SEC-4 tenant scoping (+ admin carve-out) | Immediately Enforceable | Code Review + Security Review | Code Verified |
| SEC-5 D2 isolation (RLS phased) | Phase-in Required | Security Review | Architecture Decision |
| SEC-6 intra-business roles | Product Decision Required (model) + Phase-in | Product Review | Code Verified (G-11) |
| SEC-7 platform-admin gating | Immediately Enforceable | Code Review | Code Verified |
| SEC-8 no secrets in source | Immediately Enforceable | CI (secret-scan) + Code Review | Code Verified |
| SEC-9 rotate .env secrets (P0) | Immediately Enforceable (ops) | Manual Audit | Code Verified (G-1) |
| SEC-10 AES-256-GCM at rest | Immediately Enforceable | Security Review | Code Verified |
| SEC-11 PII at rest + blind index | Phase-in Required | Security Review + CI (test) | Code Verified (C-1/G-6) |
| SEC-12 key rotation policy | Phase-in Required | Manual Audit | Code Verified |
| SEC-13 legacy Gmail token sweep | Phase-in Required | Code Review | Code Verified (G-16) |
| SEC-14 webhook verification (+Tranzila) | Immediately Enforceable (new) / Phase-in (Tranzila) | Code Review + Security Review | Code Verified |
| SEC-15 OAuth state+PKCE | Immediately Enforceable | Code Review | Code Verified |
| SEC-16 file handling | Immediately Enforceable | Code Review | Architecture Decision |
| SEC-17 rate-limiting (Wave-1 D3) | Immediately Enforceable | Code Review | Code Verified |
| SEC-18 security headers | Phase-in Required | CI (header check) | Code Verified (Missing) |
| SEC-19 audit trails | Immediately Enforceable | Code Review | Code Verified |
| SEC-20 incident-response process (current legal duty, GOV-10c: mandatory expiry) | Phase-in Required (timed) | Manual Audit + Legal Review | Legal Source (G-20) |
| SEC-21 breach notification | Legal Review Required | Legal Review | Legal Source |
| SEC-22 backups & DR (+ erasure coupling) | Phase-in Required | Manual Audit | Architecture Decision (G-22) |
| SEC-23 vulnerability disclosure | Phase-in Required | Manual Audit | Architecture Decision (G-23) |
| SEC-24 persist-before-enrichment durability | Immediately Enforceable (new ingestion) | CI (verify-test) + Code Review | Code Verified (G-24) |

## 9. Exception Process

Exceptions to any SEC-requirement follow **WP9 §14** (justification, owner, risk, mandatory expiration, approval, tracking). Security waivers additionally require Security Review sign-off. SEC-9 (secret rotation) is **not** waivable.

## 10. Future Compatibility

- **Public API / Integrations Marketplace:** WP3 governs *inbound* webhook verification and first-party auth only. Dubiz-as-API/identity-provider (third-party OAuth, per-client rate-limits) and **outbound** signed webhooks are **not covered** → **Future Requirement** (register when scoped).
- **SSO / SCIM:** custom bearer-token auth (SEC-1) does not cover federated identity/provisioning → **Future Requirement**.
- **Multi-region / Data residency:** cross-border/at-rest-location controls uncovered (Review M-2) → **Future Requirement**.
- **SOC 2 / ISO 27001:** WP3 + WP9 provide foundations but no formal ISMS/control-mapping → **Future Requirement**.
- **Marketplace / Multi-currency:** raise PCI-scope questions (WP5) but no new SEC principle; **Enterprise:** ties to SEC-6 roles + SSO.
- **Mobile:** token storage/secure-enclave patterns to be added → **Future Requirement**.

## 11. Changelog (v1.1)

- **SEC-4 platform-admin carve-out** — *resolves:* **Review M-7** (every-endpoint-scoped vs cross-tenant admin contradiction).
- **SEC-11 blind-index / searchable-encryption + WP3 ownership** — *resolves:* **Review C-1** and **m-1**.
- **SEC-3 mandatory expiry via WP9 §14** — *resolves:* **Review M-9**.
- **SEC-18 status → Missing (Code Verified)** — *resolves:* Review §4 Unknown (headers).
- **Added §4.6 SEC-20/SEC-21 Incident Response & Breach Notification** — *resolves:* **Review M-1** (current Amendment-13 duty); registers audit **G-20**.
- **Added §8 matrix, §9 exception ref, §10 Future Compatibility, Status/phase-in header** (WP9 §10/§14).
- **(v1.1a) Added §4.7 SEC-22 (backups/DR + erasure coupling) & SEC-23 (vulnerability disclosure)** — *resolves:* second-review **MAJOR-1** (G-22/G-23 were ownerless).
- **(v1.1a) SEC-20 tagged current-legal-duty with mandatory expiry (WP9 GOV-10c)** — *resolves:* second-review **MAJOR-2**.
- **(v1.2) SEC-4 → three access classes** (added public/unauthenticated) — *resolves:* Validation Must-Fix #4.
- **(v1.2) SEC-10 removed false Gmail-AAD claim** (Gmail binds no AAD → G-26) — *resolves:* Validation Must-Fix #2.
- **(v1.2) SEC-11 statutory-legal-record cleartext carve-out** (invoice snapshot / SHAAM BKMVDATA) — *resolves:* Validation Must-Fix #6 (SEC-11-vs-DEV-9/SHAAM conflict).
- **(v1.2) SEC-17 ingestion fail-open carve-out + timeout tolerance** — *resolves:* Validation Must-Fix #7 (fail-closed-vs-WhatsApp + Upstash lesson).
- **(v1.2) SEC-19 enumerated security-relevant actions** — *resolves:* Validation Should-Fix #9.
- **(v1.2) Added §4.8 SEC-24 persist-before-enrichment durability** — *resolves:* Validation Must-Fix #5 (OCR data-loss class); owns G-24.
- **Status → Candidate for Ratification (v1.2).**

## 12. References (sources of truth — not duplicated here)

- `security-policy.md`, `security-architecture-review.md`, `security-gap-matrix.md` — the standing security body.
- `security-d1-session-architecture-review.md`, `security-d2-*` — locked decisions D1/D2.
- `security-wave-1-*`, `rate-limiting-and-abuse-protection-review.md`, `upload-and-file-handling-patterns-review.md` — Wave-1 execution.
- `payments-authority-principle-v1.md` — signal-vs-authority.
- [privacy-constitution-v1.md](privacy-constitution-v1.md) (WP2), [development-constitution-v1.md](development-constitution-v1.md) (WP7).
- [compliance-constitution-system-audit-v1.md](compliance-constitution-system-audit-v1.md) — findings.
