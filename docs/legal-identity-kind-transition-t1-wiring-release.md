# "מעבר לעוסק מורשה" ← 4a T1: wiring release package

**Owner:** the legal identity track (f3). **Contract:** `.billing-4a/T1-WIRING-CONTRACT.md` (4a, on main).
**Status:** lab only. Nothing here is approved for merge, apply, flag or environment change.

## 1. What changes

| PR | Content | Effect in Production when merged |
| --- | --- | --- |
| #1266 | migration `20261225090000_kind_transition_issuer_declaration_wiring`; read-only preflight + post-apply proof; lab tooling (`.bkt/`), the lab workflow; rollback script | none until the migration is applied by `release-migrate` |
| #1267 | `lib/legal-identity/kind-transition.ts` (eligibility, status mapping, Hebrew texts), the confirm route's log line, tests, app battery A18–A20, the e2e workflow on the wired lab. Stacked on #1266 | none while `BUSINESS_KIND_TRANSITION_ENABLED` is off (every route answers 404) |

The migration replaces one function, `business_kind_transition_to_authorized`. Its code equals
`.billing-4a/t1-wiring.proposed.sql` (comments aside; the lab workflow fails otherwise). It is byte-identical to
`20261221090000` except for three things:

1. The early `ISSUER_DECLARATION_ACTIVE` refusal is removed.
2. After the `STATEMENT_STALE` check, and before the history row and the profile update, a business whose latest
   declaration is live calls `issuer_declaration_status_change(...)`. The call passes the transition's own server-side
   digest (`v_sha`), the re-auth method and the re-auth instant.
   - `DECLARED`: the transition continues.
   - Anything else: the function returns `ISSUER_DECLARATION_<status>` and has written nothing.
3. It declares one new local, `v_decl`.

No table, column, trigger, policy or grant changes. `CREATE OR REPLACE` keeps the owner, `SECURITY DEFINER` and the
ACL. A guard block refuses to apply unless all of these hold:

- the predecessor is the `20261221090000` body;
- the writer exists and is `SECURITY DEFINER`;
- the transition, the writer and `BusinessIssuerDeclaration` share one owner;
- `IssuerReauthMethod` has `GOOGLE`.

A post-check refuses unless the privileges are as before. The classifier marks the migration **AUTHORITY
(SECURITY_DEFINER)**, so it needs an approval record.

**Who is affected.** A business without a live declaration (none, or anonymised) never reaches the writer. The lab
proves that the old and new functions give the same answer and the same effects for such businesses (I4).

The intended differences all concern an exempt business with a live declaration:

- It now transitions and gets declaration v2 (`STATUS_CHANGE`) in the same transaction.
- With a stale digest it now gets `STATEMENT_STALE`, where it used to get `ISSUER_DECLARATION_ACTIVE`.
- The writer's refusals are new answers, and each writes nothing.

## 2. Release order (each step its own owner approval)

`release-migrate` applies **every** pending migration, in Prisma order, and its `verify` step requires
`expected_migrations` to equal exactly the pending set.

0. **Prerequisite (not this track):** `20261224090000_platform_subscriptions` (#1252) is pending in Production ahead of
   this migration.
   - Merge #1266 only after it is applied. Otherwise the subscriptions release would find two pending migrations and
     would need this migration's approval record too.
   - This track does not touch it.
1. **Merge #1266** (squash, `--match-head-commit`). Nothing runs.
2. **Read-only preflight.** Dispatch `prod-readonly-evidence.yml` from main with
   `ops/evidence/kind-transition-wiring-preflight.sql`. This needs the `production-db` gate.
   - Required checks 1–12 must all PASS.
   - INFO 13 counts the businesses that would take the new path (live exempt declaration, exempt profile).
   - INFO 14 and 15 are counts (history rows, STATUS_CHANGE rows).
3. **Approval record PR:** `ops/release-approvals/20261225090000_kind_transition_issuer_declaration_wiring.json`.
   - `sha256` `0acb8c80438132e24f54b121ae25b6cb1da63a02bea0d126434701ec57b1edaa`
   - the owner's decision link
   - `preflightRun` and `preflightFile`
   - no `releaseSet` (it is released alone)
4. **Apply:** `release-migrate` with `expected_migrations=20261225090000_kind_transition_issuer_declaration_wiring`. This
   needs the `production-db` gate and the authority gate.
5. **Post-apply proof:** `ops/evidence/kind-transition-wiring-production-evidence.sql`.
   - Required checks 1–9 must PASS: the ledger checksum above, and the deployed body md5
     `e691e58efaec46a2f4ba05dbb0c35da8`.
   - INFO 10 (STATUS_CHANGE rows) is expected to be 0 while the flag is off.
   - Expected: `issuer-status-change-production-evidence.sql` check 11 ("still inert") now FAILs. That is by design,
     because this migration is what makes the transition use the writer.
6. **Merge #1267** after rebasing it onto main. Production deploys with the flag off.
   - Check: every kind-transition route answers 404.
   - Check: 0 new errors.
7. **Before the flag** (not part of this release):
   - 4a gates T2–T6;
   - the real tests R1–R14 (owner actions O1–O6);
   - a Preview with a real Google account and a physical phone;
   - the owner's flag approval.

The steps are safe in either order:

- #1267 deployed before the migration: a declared business sees the flow. The database still answers
  `ISSUER_DECLARATION_ACTIVE`, mapped to 409 "לא נשמר שום שינוי" (app battery A20).
- The migration applied before #1267: the old application still blocks declared businesses before calling the
  database.

## 3. Rollback

- **Application:** revert #1267. It is safe at any time, because the old application blocks declared businesses itself.
- **Database:** `.bkt/rollback-wiring.sql`, run as the table owner.
  - It restores the `20261221090000` body byte for byte; the lab compares the md5.
  - It deletes the ledger row.
  - It keeps every row: declarations v2 and transition history rows are append-only records of what happened.
  - After it, declared businesses are refused again with `ISSUER_DECLARATION_ACTIVE`.
  - Production has no rollback runner, so running it needs a separate owner decision and mechanism.

## 4. Hebrew texts for owner approval (`KIND_TRANSITION_DECLARATION_MESSAGES`)

| Database answer | HTTP | Text |
| --- | --- | --- |
| `ISSUER_DECLARATION_NOT_AUTHORIZED_USER` | 409 | את המעבר יכול לאשר רק המשתמש שמוגדר בהצהרת המנפיק של העסק כמורשה לפעול בשמו. לא נשמר שום שינוי. |
| `ISSUER_DECLARATION_IDENTITY_MISMATCH` | 409 | השם המשפטי או מספר הזהות בפרטי העסק אינם זהים לאלה שבהצהרת המנפיק, ולכן אי אפשר לבצע את המעבר. לא נשמר שום שינוי. כדי לבדוק את הפרטים יש לפנות לתמיכה של דוביז. |
| `ISSUER_DECLARATION_DECLARATION_NOT_EXEMPT` | 409 | לפי הצהרת המנפיק העסק אינו רשום כעוסק פטור, ולכן אי אפשר לבצע את המעבר. לא נשמר שום שינוי. כדי לבדוק את הפרטים יש לפנות לתמיכה של דוביז. |
| `ISSUER_DECLARATION_DECLARATION_NOT_YET_EFFECTIVE` | 409 | הצהרת המנפיק של העסק עדיין לא נכנסה לתוקף. אפשר לנסות שוב בעוד כמה דקות. לא נשמר שום שינוי. |
| `ISSUER_DECLARATION_ACTIVE` (unwired database only) | 409 | לעסק יש הצהרת מנפיק פעילה, והמעבר לעסק עם הצהרה עדיין לא זמין. לא נשמר שום שינוי. |
| any other `ISSUER_DECLARATION_*` | 500 | the existing generic text "המעבר לא בוצע. לא נשמר שום שינוי."; the code is logged on the server |

The contract (§3, legal-name whitespace) says the mismatch answer sends the owner to support. The comparison is not
relaxed. T6 removes the old "correction request" wording, which is a different thing: this text offers no correction
path. If the owner prefers no mention of support here, it is a one-line change.

## 5. Evidence index (lab)

- `.github/workflows/kind-transition-wiring-lab.yml` on #1266, running on PG17 with Production's role topology and the
  real `migrate deploy`. It runs:
  - the guards;
  - the preflight and proof before and after the apply;
  - `.bkt/wiring-battery.mts` I1–I5, `.bkt/battery.ts` K1–K11 (wired) and the 4a T1 battery (sections P/C/W/X), all on
    the real migration;
  - atomicity;
  - the rollback.
- `.github/workflows/business-kind-transition-e2e.yml` on #1267:
  - the app battery on the unwired lab (A20) and on the wired lab (A1–A19);
  - browsers with the flag on and off.
- `.github/workflows/business-kind-transition-lab.yml`: the `20261221090000` lab, unchanged; K3 runs its unwired
  branch.
