# Legal identity track — FROZEN handover (2026-11-17)

**Status: FROZEN by the owner on 2026-11-17. Resume ONLY on the owner's explicit approval.**
This file lets a new session (with no chat history) resume at exactly this point. Owner session: business-platform-dd.

Nothing below is approved by this document. Every merge, migration apply, Production change and feature flag still needs
its own explicit owner approval.

---

## 1. What is DONE and live in Production (owner-approved)

| Item | State | Proof |
|---|---|---|
| Migration `20261128090000_signup_legal_identity` (#1140) | APPLIED 11-17, ledger 218 | approval record PR #1176 (merged e300af38); preflight run 43956903554 11/11; evidence 12/12 |
| #1142 signup legal identity + server lock | MERGED squash 7a17e70e, deployed | /register 200, protected routes 401, new CSS live, 0 5xx in 30 min |
| #1117 (4a's PR) invoice-profile route | merged by 4a 4e712cfa | dd code review APPROVE; 4a ran rls-contract 35/35 in the owner lab (not in CI) |

Production does NOT have the correction tables. No `LEGAL_IDENTITY_*` env var is set in Production. No business was confirmed or locked
retroactively. The 32 pre-existing businesses are untouched.

## 2. Frozen work — exact locations (all pushed to GitHub, nothing deleted)

| What | Branch | Head | PR | CI at freeze |
|---|---|---|---|---|
| Correction migration `20261128100000_legal_identity_correction` | `db/legal-identity-correction` | 1ad1bf88 | #1148 Draft, label "frozen" | 33 pass; only `release/verify` fails (expected: migration not applied) |
| Business correction screens | `feat/legal-identity-correction` | f85db6be | #1152 Draft, frozen | `release/verify` + `verify` fail (expected: migration-first); 24 checks were still pending at freeze, so the rest wasn't fully verified |
| Approver console | `feat/legal-identity-correction-admin` | see §2a | #1154 Draft, frozen | was still running at freeze; NOT verified on the final head |
| Evidence-only (preflight + evidence SQL into the evidence workflow list) | `ops/legal-identity-correction-evidence` | 111ba150 | #1179 Draft, frozen | 18 pass, 1 pending at freeze |
| Completion prompt for existing businesses (flag-gated, off) | `feat/legal-identity-completion-prompt` | 6063a689 | NO PR (never opened) | never ran in CI; local tsc clean, unit test 14/14 |
| This handover | `handover/legal-identity-freeze` | (this commit) | NO PR | docs only |

§2a: `feat/legal-identity-correction-admin` = 5ad467f7 on GitHub before the freeze, plus local commit e0e6a207 (runbook status
update) pushed at freeze for preservation.

Migration checksum (unchanged throughout): `94477bbeef1cc14c719c2ea7937904e163075ad897f28734b1dcf990a16e2f68`.

Local worktrees (Windows, `C:\Users\מחשב\OneDrive\Documents\GitHub\`): `wt-corr-db`, `wt-corr-code`, `wt-corr-admin`, `wt-lic-evid`,
`wt-lic-complete`, `wt-lic-handover`. Their content is all on GitHub; the worktrees can be recreated from the branches.

Local lab (synthetic data only): PG18 cluster `pgui` on port 55441 (superuser `lab_super`, DBs `lic_ui`, `lic_ooo`, `lic_sd`) in the
session scratchpad. It's throwaway and not needed to resume, because every proof reruns in CI or from `.sli/`.

## 3. Tests: what ran and what did not

Ran (real):
- #1148 lab CI (PG17, real `migrate deploy`, Production role topology): PASS at 1ad1bf88. Preflight 9/9 before; evidence 14/14 after; #1140 evidence still 12/12.
- Out-of-order proof (local lab, `notes/ooo-test2.sh`): #1148 applied after later-named migrations → preflight 9/9, evidence 14/14.
- UI e2e `.sli/correction-ui.e2e.mts`: 26/26 locally (run 9). This was Playwright with the WebKit/iPhone 13 and Chromium/Pixel 7 profiles: **browser emulation, NOT real devices**.
- Erasure contract baseline: OK. Unit tests in `lib/legal-identity/*.test.ts`: ok.
- Static compatibility: f8's 4 notification migrations (heads 1bfeccdb/d77ebe48/740c9227/204ad3c8) and Service Desk's 7 remaining migrations: **no dependency on #1148 in either direction**.

NOT done / not verified:
- No Production preflight for #1148 has run (needs the owner's production-db gate).
- No real-phone test of the correction screens. Earlier phone tests covered signup only.
- #1152/#1154 full CI on the final heads (still running at freeze).
- The completion prompt never ran in CI or in a browser.
- The UI e2e is not wired into CI (held back because of CI congestion).

## 4. Order to resume (each step = separate owner approval)

Full plan: `notes/1148-apply-plan.md`. Approval record template: `notes/1148-approval-record.TEMPLATE.json`.

0. Re-sync the three branches with main, and re-check the newest heads of the f8/Service Desk/4a migrations against #1148 (method: §6).
1. Merge #1179 (evidence-only) so the preflight can be selected from main.
2. Owner-gated read-only preflight `ops/evidence/legal-identity-correction-preflight.sql` → must be 9/9.
3. Merge #1148 and release it in the same sitting; announce to the other sessions first, with only one release in flight at a time.
4. Approval record PR → `release-migrate` → evidence 14/14, and #1140's evidence still 12/12.
5. Merge #1152, then #1154. `LEGAL_IDENTITY_CORRECTION_ENABLED` stays unset, so every correction route returns 404.
6. Activation per `docs/legal-identity-activation-runbook.md` (on #1154's branch): approvers, MFA, then the flag.

The original owner plan: #1148 waits for the end of the Service Desk chain (remaining: 20261126090000 #1104, 20261127, 20261128090000_service_parts, 20261129, 20261130090000, 20261130100000, 20261201), unless the owner decides otherwise.

## 5. Decisions already taken and open questions

Owner decisions (direct):
- New businesses: the legal identity is required at signup and locked after confirmation. Existing businesses are never blocked, overwritten or locked by surprise.
- #1148 waits for the Service Desk chain, then a real Production preflight (9/9) with separate approval.
- Don't change the 32 existing businesses, and no automatic locking for them.
- f8's notification migrations may go before #1148, provided there are no real dependencies (verified: none).

Owner decisions **as relayed by 4a** (11-17), not received directly by dd, so confirm with the owner on resume:
1. `requestedVatNumber` joins the correction request (no separate path).
2. For a declared business, only the authorized user may request a correction.
3. For a declared business, PASSWORD re-verification is required (RECENT_SIGN_IN is not accepted).
4. Forward correction after issuance: approved in principle only. First separate the technical class from the legal class (= request `kind` TYPO_CORRECTION vs BUSINESS_KIND_CHANGE), check the legal implications, and present the permission bounds and migrations.
5. A follow-up migration in the dd track (decide writes a CORRECTION declaration version atomically with the profile update) is approved as a direction; the migration itself still needs approval. Contract: `notes/followup-correction-after-declaration.md`.

Open owner decisions:
- Production approvers (who; the LegalIdentityApprover row is an owner-run INSERT) and the activation policy.
- The completion prompt for the 32 existing businesses: open the PR? Enable `LEGAL_IDENTITY_COMPLETION_ENABLED`?
- A link from the lock note to the correction page. That's a protected billing file (`components/billing/BusinessIdentitySetupForm.tsx`) and needs the owner.
- Should a TYPO_CORRECTION tax-id change get a mechanical bound (e.g. 1–2 digits differ)? Today the only safeguards are the requester's declaration and the four-eyes approver.
- Who owns `/api/intake/sweep` (pre-existing errors; handover note in `notes/intake-sweep-handover.md`).
- Isolated Preview cleanup: 12 Vercel branch vars and the Neon branch `br-proud-poetry-amj5wmys`.
- Whether to add the UI e2e as a CI workflow.

## 6. Dependencies on other tracks

- **Service Desk (bf, not running as a live session):** 7 migrations remain. Static check at freeze: they only read Business/User and never touch #1148 objects.
- **Notifications (f8, active):** 20261210 merged on main (#1143), not applied. 20261211–13 are Drafts. No dependency on #1148.
- **Issuer declaration (4a, active):** the declaration-after-correction follow-up is shared work. 4a owns its chain-guard migration and the billing UI. dd owns `lib/legal-identity/**`, the signup files, #1148/#1152/#1154 and the follow-up. 4a will link the declared-status screen to `/business/legal-identity/correction`, shown only when `LEGAL_IDENTITY_CORRECTION_ENABLED` is "true" (server-side check).
- **Coordination rules:** announce every Production dispatch first. `prod-readonly-evidence` has a single concurrency group, so a newer waiting run cancels an older waiting run. No migration merge while another session's release is pending, and a merged migration is released in the same sitting.
- How to re-check compatibility: grep the other migrations for `LegalIdentity|legal_identity|lic_`, and for ALTER/GRANT/REVOKE/TRIGGER on User/Business/BusinessProfile; check for function-name collisions and for `DEFAULT PRIVILEGES` / `ON ALL TABLES`.

## 7. Standing constraints (unchanged)

No merges, no Production migration, no Production data or env changes, no feature flags, no permission changes, no real customer
messages, synthetic data only, don't touch 4a/f7/Service Desk files, never present emulation as real-device testing, and never bypass CI
or the security guards.
