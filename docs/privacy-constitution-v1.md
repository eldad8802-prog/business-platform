# Dubiz Privacy Constitution v1.1 (WP2)

> **Constitution Status:** `Ratified` (ratified 2026-07-02 per WP9 GOV-1) · **Version:** v1.2 · **Effective Date:** upon ratification
> **Legacy Scope:** existing PII stores/flows are grandfathered per WP9 §10; gaps G-2…G-6/G-12 are the scheduled remediation, not a merge-blocker.
> **New Development Scope:** new/changed data collection binds to `Immediately Enforceable` rows in full (§14 matrix).
> Shared machinery (Status, Effective-Date, Classification/Enforcement/Evidence taxonomies, Exceptions) is in **WP9 §9–§14**.

**Date:** 2026-07-02 (v1.1)
**Depends on:** [compliance-constitution-system-audit-v1.md](compliance-constitution-system-audit-v1.md) (findings G-2…G-6, G-12), [governance-constitution-v1.md](governance-constitution-v1.md) (WP9 shared machinery), [compliance-constitution-review-ratification-report-v1.md](compliance-constitution-review-ratification-report-v1.md)
**Consistent with:** `app/(corporate)/privacy/page.tsx`, `security-policy.md`, `security-architecture-review.md`
**Normative language:** MUST / MUST NOT / SHOULD / MAY per RFC 2119.

> Privacy is designed in, not added later. Every feature that touches personal data MUST answer the seven questions in §2 **before** it is built. A feature is not complete until it satisfies the Definition of Done in §10.

---

## 0. Purpose (מטרה) & Scope

**Purpose:** to embed Privacy-by-Design across Dubiz and build the data-subject-rights machinery required by Israeli law (Amendment 13) and GDPR, closing audit findings G-2…G-6 and G-12.

**Scope:** all collection, storage, derivation, and sharing of personal data across the platform and its external processors (see §4 inventory, §5 data-flow map). Applies to human- and agent-authored changes. Enforced through the WP7 Privacy Review (DEV-2). Verification/Audit obligations are in §9 (access auditing) and §10 (DoD); Remediation is in §11.

**Public-marketing exemption (v1.2 — resolves Validation §5 / Should-Fix #8):** static public marketing pages (`app/(corporate)/*`) that collect and store **no personal data** are **out of scope** for tenant-scoping and PII rules — there is nothing to protect, resolve a controller/processor role for, or audit. A reviewer need not prove N/A each time. **The moment such a page collects personal data** (e.g. a contact form persisting a name/email), it re-enters scope in full (the seven questions §2 apply). Accessibility obligations are unaffected (WP1 still applies to these pages).

---

## 1. Legal basis (evidence-based)

**Primary (binding):** Israeli **Protection of Privacy Law**, as substantially reformed by **Amendment 13** — adopted August 2024, **in effect since mid-August 2025**. Amendment 13 aligns Israeli law more closely with the GDPR: it expands definitions of personal/sensitive data, strengthens data-subject rights (access, correction, deletion), broadens enforcement (administrative orders, monetary penalties reaching millions of shekels, cease-and-desist), expands breach-notification duties, and enables **statutory/exemplary damages without proof of harm** plus expanded class-action grounds.

**Secondary (applicable where EU data subjects are involved, and as best-practice baseline):** **GDPR**.

**Open items requiring legal review (do NOT invent answers):**
- Whether Dubiz must appoint a **Privacy Protection Officer / Data Security Officer** under Amendment 13 (triggered for public bodies, data brokers, systematic monitoring, or databases *primarily* handling sensitive data). Dubiz stores tax IDs, financial documents, and message content — **this determination MUST be made by counsel**, not assumed here.
- Whether Dubiz's database qualifies as a **"large sensitive database"** requiring risk assessment + penetration testing every 18 months.
- The lawful-basis classification per processing purpose (see §3).

These are flagged as **Unknown — requires legal review**, per the Initiative's Evidence-First rule.

Sources cited at end.

---

## 2. The seven questions (mandatory gate for every feature)

Before any feature that collects, stores, derives, or shares personal data is built, its design MUST answer, in writing:

1. **What** personal data is collected?
2. **Why** — what is the specific, legitimate purpose?
3. **Who** can access it (which roles, which tenant scope)?
4. **Where** is it stored (which table, which processor)?
5. **How long** is it retained, and what triggers deletion?
6. **How** is it deleted?
7. **How** can the data subject export/correct it?

A feature that cannot answer all seven is **not designed**, and MUST NOT be merged.

---

## 3. Core principles — MUST

- **P-1 Data minimization:** collect only data necessary for the stated purpose. New PII fields MUST be justified against a purpose (§2.2). Free-text fields that may attract incidental PII (`notes`, `Message.contentText`, `Document.ocrText`) MUST be treated as personal data.
- **P-2 Purpose limitation:** data collected for one purpose MUST NOT be silently repurposed. Using personal data to train/tune models, or sending it to a new processor, is a **new purpose** requiring review (see §7 AI cross-reference).
- **P-3 Lawful processing:** every processing activity MUST have a documented lawful basis. The mapping of purpose → lawful basis is maintained in the Data Inventory (§4) and confirmed by legal review.
- **P-4 Storage limitation:** personal data MUST NOT be kept longer than needed for its purpose. Indefinite retention is prohibited unless a documented legal-retention obligation applies (e.g., tax records). *(Audit G-4: today most PII is retained indefinitely.)*
- **P-5 Accuracy & correction:** data subjects MUST be able to correct inaccurate personal data (Amendment 13 right).
- **P-6 Integrity & confidentiality:** personal data MUST be protected. **Ownership:** the at-rest protection mechanism is **owned by WP3 (SEC-10/SEC-11)**; WP2 states the *what* (which data is sensitive), WP3 states the *how* (resolves Review m-1 single-owner). **Searchable-identifier carve-out (resolves Review C-1):** identifiers the system must match/dedupe on — currently `phone` and `taxId`, used for equality by Party Resolution (`lib/services/party/party-resolution.service.ts`; `party-backfill.deps.ts:137`) and billing identity (`billing-issue.service.ts:253`), Code Verified — MUST NOT be protected with a scheme that destroys equality (standard random-IV AES-GCM). They MUST instead use a **searchable-encryption approach** (deterministic encryption or a keyed **blind index** for lookup, with the plaintext-equivalent never exposed by read APIs). Free-text and non-searched sensitive fields (message content, OCR text, notes) use standard encryption at rest. This is a `Phase-in Required` requirement: the principle binds now; the blind-index mechanism is a scheduled build (not a waiver). **Statutory-record carve-out (v1.2 cross-ref):** this rule governs **operational** stores only; identifiers that the law requires in cleartext inside an immutable statutory record (issued invoice snapshot, SHAAM BKMVDATA) are excluded — see WP3 **SEC-11** for the authoritative carve-out.
- **P-7 Accountability:** every decision above MUST be documented (Documentation Constitution, WP8) so compliance is demonstrable, not merely asserted.

---

## 4. Personal-data inventory (evidence-based, from audit §2.7)

This constitution **requires** a maintained Data Inventory. The audit produced the first version; it MUST be kept current as schema evolves.

| Category | Tables (evidence) | Sensitivity | Notes |
|----------|-------------------|-------------|-------|
| Account | `User` (email, name, password hash, login telemetry) | Medium | password hashed (bcrypt) |
| Contacts/CRM | `Customer`, `Lead`, `PartyResolutionClaim` (name, phone, email, city, **taxId**, notes) | **High** (taxId) | plaintext at rest — G-6 |
| Business profile | `BusinessProfile` (billing legal name, tax/VAT id, phone, email, address) | High | |
| Communications | `Conversation`, `Message` (`contentText`, sentiment/intent/objection labels) | **High** | inferred personal attributes + content |
| Scheduling | `Appointment` (title, notes, links to customer/lead) | Medium | |
| Financial docs | `BillingDocument`, `FinancialDocument`, `ExtractedData` (`ocrText`, vendor, amounts, `cardLast4`) | **High** | **no full card data** stored |
| Ingestion | `EmailAttachmentImport`, `WhatsAppAttachmentImport` (fromEmail/fromPhone, subject, filename) | High | email/phone identifiers |
| Integration creds | `OAuthToken`, `EmailConnection`, `WhatsAppConnection`, `BusinessPaymentConnection` | **High** | encrypted (AES-256-GCM) |
| Payments | `PaymentRequest`, `PaymentTransaction` | Medium | no card data |
| Audit/telemetry | `PlatformAuditEvent`, `ProductUsageEvent`, `LearningEvent`, `ContentEvent` | Medium | may reference user/customer ids |

**Rule P-8:** any new PII-bearing table or field MUST be added to this inventory in the same PR that introduces it.

## 4a. Controller vs Processor determination — MUST *(added v1.1; resolves Review C-3)*

Dubiz is a B2B platform, so its privacy role **differs by data category**, and that role decides who owns consent, erasure, and DPA duties. The working model below is `Legal Review Required` for final confirmation, but is strongly supported by the architecture (businesses own and control their customers' records; every customer row is `businessId`-scoped — Code Verified, audit §2.6/§2.2):

- **Dubiz is the CONTROLLER** for **account-holder data** it collects for its own purposes: `User` (the business's staff accounts), `BusinessProfile`, product-usage/telemetry, and Dubiz↔user billing. Dubiz owns consent/erasure/access for these directly.
- **Dubiz is a PROCESSOR** (the business-customer is the controller) for the **business's own end-customer data**: `Customer`, `Lead`, `Conversation`/`Message`, `Appointment`, customer-linked `FinancialDocument`/`BillingDocument`, `PartyResolutionClaim`. For these, the **controlling business** is the party that must answer a data-subject's request; Dubiz's duty is to **enable** the business to fulfil it (export/erasure tooling) and to act only on documented instructions.
- **Rule P-8a:** the §4 inventory MUST carry a **role column** (Controller / Processor / Joint / TBD-legal) for each category; new categories MUST assign it. Where the role is genuinely unclear, mark `Unknown — requires legal review` — never leave it implicit.
- **Rule P-8b:** the data-subject-rights machinery (§6) MUST route each right to the correct responsible party per this determination. The DPA (WP4 LEG-10) formalizes the processor relationship with business-customers and with Dubiz's own sub-processors (WP5 CMP-11).

---

## 5. Data-flow mapping — MUST

Personal data leaves Dubiz to external processors (audit §2.8). Each is a **data processor** and MUST be inventoried with purpose, data categories, and (where required) a Data Processing Agreement:

- **Google** — Gmail (readonly import of email metadata + attachments), Vision OCR (**full document bytes** sent). 
- **Meta/WhatsApp** — inbound messages, phone numbers.
- **OpenAI** — prompts contain business/offer/strategy text; **customer PII MUST NOT be sent** (P-2). Subject to OpenAI default retention.
- **Cardcom / Tranzila** — hosted checkout; **no card data touches Dubiz**.
- **Cloudflare R2** — file storage (businessId-scoped, signed URLs).
- **Creatomate / Pexels** — content generation inputs.
- **Neon** — primary database. **Upstash** — rate-limit counters only (no PII).

**Rule P-9:** no personal data may be sent to a **new** processor without (a) adding it to this map, (b) confirming a lawful basis and DPA where required, and (c) Privacy Review sign-off. *(Audit G-13: no processor/DPA inventory exists today.)*

---

## 6. Data-subject rights machinery — the build target *(closes G-2, G-3, G-5, G-12)*

Amendment 13 makes these rights enforceable. Dubiz MUST implement, per the remediation plan (§11):

- **R-Access / SAR:** a data subject (business user; and, for customer records, the controlling business) MUST be able to obtain the personal data held about them, in a portable format. *(Today: only financial export exists.)*
- **R-Correction:** ability to correct inaccurate personal data (P-5).
- **R-Erasure:** a documented deletion workflow for user, customer, and business records — distinct from the current soft-delete (`Business.archivedAt`). Erasure MUST honor legal-retention exceptions (tax) and MUST be recorded in the audit trail (what was erased, when, by whom — not the erased content).
- **R-Export/portability:** full export MUST cover CRM/contacts, conversations/messages, and account data — not only financial records.
- **R-Consent & withdrawal:** **Precondition (resolves Review m-6):** the lawful basis per purpose (P-3) MUST be determined **before** building consent machinery — for much B2B customer data the basis is likely contract/legitimate-interest, in which case a consent table is the *wrong* mechanism. **Where consent is the confirmed lawful basis**, a **consent record** (who, what, when, version, withdrawal) MUST exist. This item is `Legal Review Required` (basis) → then `Phase-in Required` (build). *(Today consent is implied-by-use only — G-2.)*

**Rule P-10:** every data-subject right MUST be backed by (a) an authenticated, tenant-scoped API, (b) an audit entry, and (c) a documented SLA for fulfilment.

**Rule P-10c (current-legal-duty timing):** R-Access, R-Correction, and R-Erasure are **current** Amendment-13 rights. Their `Phase-in Required` build is therefore **NOT grandfathered** (WP9 GOV-10c) and MUST carry a **mandatory expiration date** in the Exception Register (gaps G-3/G-5), not an open-ended deferral. (Resolves second-review MINOR-1.)

---

## 7. Cross-references (this constitution does not stand alone)

- **Security (WP3):** encryption at rest for PII (G-6), token protection, access control, breach handling. Breach **notification** duties under Amendment 13 are a joint Privacy+Security obligation.
- **AI (WP6):** what personal data may/may not enter a prompt (P-2), transparency, and prohibition on silent model training with customer PII. **Customer PII MUST NOT be sent to LLM providers** unless a specific lawful basis + review exists.
- **Legal (WP4):** the public Privacy Policy (`app/(corporate)/privacy/page.tsx`) MUST accurately describe actual behavior — no gap between policy and system (Initiative "Legal by Design"). This constitution and that page MUST be kept in sync.
- **Development (WP7):** the Privacy Review is a mandatory PR gate.

---

## 8. Retention policy framework — MUST

Each PII category in §4 MUST be assigned a retention rule of the form *purpose → retention period → deletion trigger → legal exception*. Until per-category periods are ratified (with legal input), the default is:

- **P-11:** no PII category may be "indefinite" without a documented legal-retention basis. Categories lacking a ratified period are flagged as **open retention gaps** and tracked, not silently kept forever.

Tokens/links already expire (OAuth, payment links, coupons); these are the model to extend to content, messages, and stale imports.

---

## 9. Personal-data access auditing *(P-12 split in v1.1 — resolves Review M-8)*

- **P-12a (MUST):** access surfaces that fulfil data-subject rights (§6 — export, erasure, access) **MUST** be audited (who accessed/exported/erased what, when). `Immediately Enforceable` for those surfaces when built.
- **P-12b (SHOULD):** general reads of other **sensitive** personal data (tax IDs, message content, financial documents) SHOULD be auditable. `Phase-in Required` (broad read-auditing is a larger build). *(Audit G-12: no personal-data access audit today.)*

---

## 10. Definition of Done (privacy) — a feature is NOT complete without

1. The seven questions (§2) answered in the PR/description.
2. Any new PII field/table added to the Data Inventory (P-8) and, if it leaves Dubiz, to the Data-Flow Map (P-9).
3. Lawful basis identified (or flagged for legal review).
4. Retention rule assigned or an open-retention-gap tracked (P-11).
5. Data-subject-rights impact considered (does this data need to appear in export/erasure? — §6).
6. No customer PII sent to an LLM or new processor without review (P-2, P-9).
7. Sensitive new fields encrypted at rest per WP3 (P-6).
8. Privacy Policy page updated if user-facing data handling changed (§7 Legal).

---

## 11. Remediation backlog seeded by the audit (risk order)

0. **Determine lawful basis + controller/processor roles** (§3, §4a) — **precedes** consent work (Review m-6); `Legal Review Required`.
1. **Consent record** table + capture + withdrawal — **only if** consent is the confirmed basis (G-2).
2. **Right-to-erasure** workflow (routed per §4a role) with legal-retention exceptions + audit entry (G-3).
3. **Retention framework**: assign per-category periods (with legal), implement TTL/purge for messages, conversations, stale imports (G-4).
4. **Full export/SAR**: extend beyond financial to CRM/messages/account (G-5).
5. **PII-at-rest encryption** for sensitive columns; complete legacy Gmail-token re-issue (G-6).
6. **Processor/DPA inventory** + confirm Tranzila/OpenAI data handling (G-13).
7. **Sensitive-read auditing** (G-12).
8. **Legal determinations**: DPO requirement, large-sensitive-database classification, lawful-basis map.

---

## 12. Enforcement & Classification Matrix (per WP9 §11–§13)

| Req | Classification | Enforcement | Evidence |
|-----|----------------|-------------|----------|
| §2 seven-questions gate | Immediately Enforceable | Code Review (PR block) | Architecture Decision |
| P-1 minimization / P-2 purpose limitation | Immediately Enforceable | Code Review | Architecture Decision |
| P-3 lawful basis map | Legal Review Required | Legal Review | Unknown |
| P-6 encrypt sensitive at rest (owned by WP3) | Immediately Enforceable (new) | Security Review + Code Review | Code Verified |
| P-6 searchable-identifier carve-out (blind index) | Phase-in Required | Security Review + CI (test) | Code Verified (C-1) |
| P-8 inventory upkeep / P-8a role column | Immediately Enforceable | Code Review + schema-diff check | Code Verified |
| §4a controller/processor determination | Legal Review Required | Legal Review | Architecture Decision + Unknown |
| P-9 processor gate (new processor → map+DPA) | Immediately Enforceable | Code Review + Legal Review | Architecture Decision |
| §6 R-Access/Correction/Erasure/Export | Phase-in Required | CI (tests) + Manual Audit | Code Verified (gaps G-3/G-5) |
| §6 R-Consent | Legal Review Required → Phase-in | Legal Review then CI | Unknown (basis) |
| P-11 retention (no indefinite) | Product Decision Required (periods) + Phase-in | Product Review + Manual Audit | Code Verified (G-4) |
| P-12a rights-surface audit | Immediately Enforceable (when built) | CI + Manual Audit | Code Verified |
| P-12b sensitive-read audit | Phase-in Required | Manual Audit | Code Verified (G-12) |

## 13. Exception Process

Exceptions to any P-requirement follow **WP9 §14** (justification, owner, risk, mandatory expiration, approval, tracking), in the shared Exception Register. Privacy waivers touching a data-subject right additionally require Legal Review sign-off.

## 14. Future Compatibility

- **Mobile:** privacy rules are platform-agnostic; **Push Notifications** add a consent/opt-out + PII-in-payload requirement not yet covered → **Future Requirement**.
- **Marketplace:** multi-party data introduces new controller/processor chains and cross-business data sharing → **Future Requirement** (extends §4a).
- **Enterprise:** SSO/SCIM bring provisioned-identity data and admin-access auditing → extends §9; **Future Requirement**.
- **AI Agents:** autonomous agents acting on personal data must still route through §6 rights and P-2 purpose limits; enabling them is gated by WP6 → **Future Requirement**.
- **Public API:** third-party data access needs scoped consent + processor terms → **Future Requirement**.
- **Multi-region / Data residency:** cross-border transfer basis is currently uncovered (Review M-2) → **Future Requirement**, register as a gap.
- **Multi-currency:** no privacy-specific impact.

## 15. Changelog (v1.1)

- **Amended P-6** — *why:* mandate to encrypt `taxId`/`phone` at rest was un-satisfiable given equality-lookup/dedupe on those fields; added a searchable-encryption (blind-index) carve-out + assigned single ownership to WP3; *resolves:* **Review C-1** and **m-1**. No principle weakened — protection still required, method made feasible.
- **Added §4a Controller/Processor determination + P-8a/P-8b** — *why:* the B2B role that decides who owns consent/erasure/DPA was undefined; *resolves:* **Review C-3**.
- **Split P-12 into P-12a (MUST) / P-12b (SHOULD)** — *resolves:* **Review M-8**.
- **Added consent precondition (lawful basis first) + reordered §11** — *resolves:* **Review m-6**.
- **Added §12 matrix, §13 exception ref, §14 Future Compatibility, Status header + phase-in scope** (WP9 §10/§14) — *resolves:* **Review C-2** for privacy scope.
- **(v1.1a) Added Rule P-10c** — current data-subject rights (access/correction/erasure) phase-in must be timed per GOV-10c; *resolves:* second-review **MINOR-1**.
- **(v1.2) Added public-marketing exemption** — static no-PII marketing pages out of tenant/PII scope (re-enter on data collection) — *resolves:* Validation Should-Fix #8.
- **Status → Candidate for Ratification (v1.2).**

---

## Sources

- [IAPP — Israel marks a new era in privacy law: Amendment 13 ushers in sweeping reform](https://iapp.org/news/a/israel-marks-a-new-era-in-privacy-law-amendment-13-ushers-in-sweeping-reform)
- [BigID — What Israel's Amendment 13 Means for Businesses in 2025](https://bigid.com/blog/what-israel-amendment-13-means-for-businesses-in-2025/)
- [Safetica — Israel's Amendment 13: what the new data protection law means for your business](https://safetica.com/resources/guides/israel-s-amendment-13-what-the-new-data-protection-law-means-for-your-business)

*Amendment 13: adopted Aug 2024, effective mid-Aug 2025; GDPR-aligned; strengthens access/correction/deletion rights; statutory damages without proof of harm; may require DPO/DSO and periodic pen-testing for large sensitive databases — all subject to legal confirmation for Dubiz specifically.*
