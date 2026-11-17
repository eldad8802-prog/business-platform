# #1148 apply plan (20261128100000_legal_identity_correction) — PREPARED, NOTHING RUN
Precondition: Service Desk chain finished (or owner decides otherwise); no other release/evidence run waiting; owner reset lifted.
Each step = separate owner approval unless noted.
1. Merge #1179 (evidence-only; no migration) -> preflight file selectable from main.        [owner: merge]
2. Dispatch prod-readonly-evidence legal-identity-correction-preflight.sql from main. Target 9/9. [owner: production-db gate]
   Stop if not 9/9. Check 3 (ledger clean) fails if any other migration is mid-flight -> wait, don't retry blindly.
3. Merge #1148 (squash) and release in the same sitting (cross-session rule). Announce to bf/f8/4a first.  [owner: merge]
4. Lab run legal-identity-correction-lab.yml on main (PG17, no secrets).                    [no Prod]
5. Approval record PR ops/release-approvals/20261128100000_legal_identity_correction.json (template in scratchpad), merge. [owner]
6. release-migrate (stages only this migration).                                             [owner: apply + production-db gate]
7. Evidence legal-identity-correction-production-evidence.sql -> 14/14; signup-legal-identity-production-evidence.sql -> 12/12 still; preflight -> fails exactly 2 4 5. [owner gate]
8. Then #1152 merge (flag LEGAL_IDENTITY_CORRECTION_ENABLED stays unset -> routes 404), then #1154. Smoke: correction routes 404, 0 5xx 30 min. [owner: merge each]
Rollback: code via Vercel; DB only with separate approval via .sli/correction-rollback.sql (lab-proven).
Expected effect in Prod: 3 empty tables + 8 functions + triggers/policies. No approver row -> nobody can decide. No customer-visible change.
