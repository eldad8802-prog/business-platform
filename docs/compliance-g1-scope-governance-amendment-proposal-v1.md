# G-1 Scope — Governance Amendment PROPOSAL v1

**Status:** `Proposed — awaiting owner approval`. **Nothing is enacted by this document.** No audit, constitution, report, or Phase-1 criterion is changed until the owner approves. This is a formal proposal, not a silent redefinition.
**Governance basis:** WP9 amendment / Exception Process (GOV-14); changes to a ratified gap definition and to Phase-1 exit criteria require approver sign-off (GOV-1 / GOV-8).

---

## 1. Verified original definition of G-1 (evidence)
- **System Audit** (`compliance-constitution-system-audit-v1.md`), gap table: *"Live secrets in working-tree `.env` (not in git history) — need rotation"* · Status Partial · Risk **Critical (ops)**.
- **System Audit**, R-1 (P0): *"**Rotate all secrets currently in `.env`**; adopt a managed secret store; document rotation policy."*
- **Initiative Final Report** (`compliance-constitution-initiative-final-report-v1.md`), §2.2: *"**G-1 (P0) Rotate all secrets currently in working-tree `.env`**; adopt managed secret store. (Not in git history, but treat as exposed.)"*
- Separately (not G-1): a **key-rotation *policy*** is listed as **P3 / WP3** (Audit §2.3 "no documented key-rotation policy"; Final Report P3 item G-16 line).

**Reading:** G-1 = rotate the *values* of **all** secrets in `.env` + adopt a managed store. The ongoing *policy* is a separate P3/WP3 item.

## 2. Finding — cryptographic keys are inside G-1's literal scope
Evidence from the `.env` name extraction: three cryptographic keys are **present in the working-tree `.env`** and therefore fall under "all secrets currently in `.env`":
- `GMAIL_TOKEN_ENCRYPTION_KEY`, `WHATSAPP_TOKEN_ENCRYPTION_KEY`, `EMAIL_TOKEN_ENCRYPTION_KEY_ID`.
- (`PAYMENTS_ENCRYPTION_KEY`, `BILLING_AUTHORITY_ENCRYPTION_KEY` are **not** in the local `.env`; consumed by code, presumably set only in Vercel prod — covered by G-1's "adopt a managed store" + the reconciliation step, not by the literal `.env` clause.)

**Therefore:** excluding cryptographic keys from G-1 **cannot** be done as an engineering convenience — it is a **scope reduction of a ratified P0 gap** and must go through Governance. The earlier "split and defer" recommendation, if applied silently, would retroactively narrow G-1's meaning. This proposal makes the split explicit and owner-approved instead.

## 3. Proposed amendment — split G-1 into G-1A and G-1B
| | **G-1A — Operational Secret Rotation** | **G-1B — Cryptographic Key Rotation** |
|---|---|---|
| **Scope** | Class A (Infrastructure) + Class B (Third-party Provider) secrets — Runbook §4 rows 1–16 (excl. crypto keys) | Class C (Cryptographic Keys) — Runbook §4 rows 17–21: `PAYMENTS_`, `GMAIL_TOKEN_`, `WHATSAPP_TOKEN_`, `BILLING_AUTHORITY_ENCRYPTION_KEY`, `EMAIL_TOKEN_ENCRYPTION_KEY_ID` |
| **Exit** | Both evidence types (Rotation + Functionality) for every in-scope secret; reconciliations done; old creds revoked (Runbook §2.5) | Requires a product decision (Re-encryption Migration vs Re-connect) **on Production counts**; then execution + both evidence types |
| **Status on approval** | `Open → closeable on evidence` | **`Open — Deferred by Product Decision`** |
| **Rationale for G-1B deferral** | — | (a) No evidence of key exposure — keys are in Vercel/`.env` only, **not in git history** → hardening, not incident; (b) no re-encryption tooling exists → safe Migration needs new development; (c) DEV counts near-zero, **Production counts not yet measured**; (d) decision is product-owned, not engineering |
| **Blockers (must clear before G-1B execution)** | — | Production counts obtained (Impact Report §8); product decision recorded (Runbook §6.1); if Migration chosen — tooling built (dual-key path + per-store script + WhatsApp keyId) |

## 4. Proposed amendment to Phase-1 exit criteria (the load-bearing part)
Today, "Phase 1 Operational Readiness" is gated on **G-1 (whole)**. This proposal amends that gate to:
- **Phase 1 closes on G-1A** (plus all engineering already complete).
- **G-1B is explicitly reclassified as future work** — it is **NOT** a Phase-1 exit criterion. It is recorded as a tracked follow-up (Constitution Backlog v2 / WP3 key-rotation family) with its status, rationale, and blockers.
- This is **not** a retroactive change of what G-1 meant — G-1's original scope is preserved in the record; it is **split and partially deferred by an explicit, dated, owner-approved Governance decision.**

## 5. What gets updated ON APPROVAL (not before)
1. **System Audit** — replace the G-1 row with G-1A (Partial→closeable) + G-1B (Open, Deferred by Product Decision), citing this amendment.
2. **Initiative Final Report §2.2** — annotate G-1 as split per this amendment.
3. **Final Release Report §4** — reflect G-1A vs G-1B; Phase-1 gate = G-1A.
4. **Phase-1 / Epic definition** — record the exit-criteria amendment (G-1B is future work).
5. **Constitution Backlog v2** — add G-1B as a tracked future item (rationale + blockers).
6. **Secret Rotation Runbook** — cross-reference G-1A/G-1B against Classes A/B/C.
7. **Amendment log** — this document flips to `Approved`, dated, with approver name (GOV-1/GOV-8).

## 6. Decision required from the owner
1. **Approve the split** (G-1A / G-1B) — yes/no.
2. **Approve the Phase-1 exit-criteria amendment** (Phase 1 closes on G-1A; G-1B = future work) — yes/no.
3. If both approved, I will enact §5 edits and record this amendment as `Approved`.

**Independently of this proposal**, and required before any G-1B product decision:
4. **Obtain real Production counts** (Impact Report §8) — owner runs the read-only script against the Production `DATABASE_URL`, or grants read-only access.

**Until approved:** G-1 remains whole and Open; Phase 1 stays open; no secret is rotated; §6.1 stays `Unknown — requires product decision`.
