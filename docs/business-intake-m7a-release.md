# M7-A — Commerce + Telephony foundation: release package (D10)

Status: **built and LAB-PROVEN. NOT applied to Production.** D10 (applying the migration in Production) is
an owner decision. This document is the one package that decision needs.

Decision record: `docs/business-intake-m7-decision-v1.md`. Approved by the owner: D3–D9. Not approved: D10.

## 1. What ships, in what order

| Step | What | Production effect | Gate |
|---|---|---|---|
| PR-A | Migration `20261013090000_m7a_commerce_telephony_foundation` + preflight / post-apply evidence + lab + rollback | **none.** Merging a migration file applies nothing | owner merge |
| Preflight | `prod-readonly-evidence` → `ops/evidence/m7a-foundation-preflight.sql` | none (read-only) | expect **13/13** |
| Approval record | `ops/release-approvals/20261013090000_m7a_commerce_telephony_foundation.json` (sha256 + preflight run) | none | **owner (D10)** |
| Release | `release-migrate` (approved-prefix, pinned SHA) applies M7-A **alone** | schema (§3) | **owner (D10)** |
| Post-apply | `prod-readonly-evidence` → `ops/evidence/m7a-foundation-production-evidence.sql` | none (read-only) | expect **16/16** |
| PR-B | Prisma models + code (destinations, Secretary, sensors, Meta hardening, privacy copy) | code deploy; **every provider stays OFF** | owner merge, **only after the post-apply proof** |
| Post-deploy | `m6-operational-evidence.sql` + the M7-A proof again; smoke | none | 7/7, 16/16 |

PR-B must never deploy before the migration: the lead briefing and Home read `CallActivity`.

## 2. Migration

- Name: `20261013090000_m7a_commerce_telephony_foundation`. It sorts after every migration on `main`
  (`20261012090000_closed_loop_recommendation_evidence` is the newest); no open branch uses ≥ `20261013`.
- sha256: `3910bdaba780a82e01cec1caf2907ae868244cb29af7e7962a5a654c497a43e5` (pinned in the post-apply proof;
  the lab refuses a mismatch).
- Preconditions are enforced in the file itself: it refuses to run without M6, the M6 CHECKs, the M3/M4
  route vocabularies and the M6 resolver, and it refuses if any M7-A object already exists.
- Transactional: the lab proves a failure on the last statement leaves nothing behind (ledger row
  unfinished, no object).

## 3. Schema changes (exact)

**New tables**, each with FORCE row-level security, per-command policies on `app.current_business_id`,
composite `(businessId, …)` foreign keys, and no DELETE grant:

| Table | Purpose | Runtime grants | Notes |
|---|---|---|---|
| `CommerceOrder` (20 cols) | a store order as last reported | SELECT, INSERT, UPDATE | unique (business, source, externalOrderId); **no lead column**; Customer FK = SET NULL |
| `CommerceOrderLine` (13) | what was bought | SELECT, INSERT, UPDATE | no stock link (D7) |
| `CommerceOrderEvent` (9) | append-only order history, 1 row per receipt | **SELECT, INSERT only** | out-of-order deliveries kept as `applied = false` |
| `CallActivity` (22) | one business call | SELECT, INSERT, UPDATE | unknown caller = per-business sha256 only; lead FK = evidence pointer, SET NULL |

**Changed objects:**
- `AcquisitionConnection_source_key`: 3 → 7 sources (`commerce.woocommerce`, `commerce.wix`, `telephony.cloudtalk`, `telephony.voicenter`).
- `AcquisitionConnection_source_shape`: widened; a credential-bearing row may lose its credential only when REVOKED.
- `IntakeNormalizedEvent_routeTarget_vocab` and `…_routingDestination_vocab`: + `call`.
- `m6_acquisition_resolve_resource` body: answers `ACTIVE` **and `ERROR`** (Meta: a Page whose token failed keeps receiving leads; they are stored and deferred, never acknowledged and dropped). Same signature, owner and grants. PAUSED / REVOKED still resolve to nothing.

**New rows:** four platform features, all `defaultEnabled = false` and `globalEnabled = false`:
`commerce_woocommerce`, `commerce_wix`, `telephony_cloudtalk`, `telephony_voicenter`.

## 4. RLS and grants

| Proof check | What it asserts |
|---|---|
| 7 | RLS enabled and forced on all four tables |
| 8 | 11 policies: SELECT / INSERT / UPDATE per table (history: SELECT / INSERT), permissive, PUBLIC role, exactly the tenant predicate; none for DELETE or ALL |
| 9 | runtime group and logins: `arw` on order, line and call tables, `ar` on the history, `Ur` on sequences; never DELETE / TRUNCATE / REFERENCES / TRIGGER |
| 10 | no other `app_*` role and not PUBLIC holds anything |
| 13 | resolver still SECURITY DEFINER, STABLE, search_path pinned, migration-role owned; EXECUTE for the runtime only |

The explicit `REVOKE DELETE, TRUNCATE` matters: Production's default ACL would otherwise hand the runtime
DELETE on a new table (the lab reproduces that default and proves the REVOKE).

## 5. Lab results

The CI run ids are recorded in the PR. Local reruns on PG18 matched them.

| Lab | Result |
|---|---|
| Production-topology lab, before M7-A | preflight **12/13** (13 = a Production premise the lab cannot build: FORCE RLS on pushed tables); proof fails exactly `1 3 4 5 6 7 8 9 11 12 13 14 15` |
| `prisma migrate deploy` | applied **M7-A alone**; proof **16/16**; preflight fails exactly `3 4 5 7 8 10` (+13) |
| Atomicity | failure on the last statement → 0 objects, ledger row unfinished |
| Faults | DELETE grant → 9 · history UPDATE → 9 · foreign SELECT → 10 · foreign EXECUTE → 13; whole again after |
| Rollback | refused while a feature override exists; then applied → preflight whole (12/13 + premise); proof back to the pre-apply set |
| Battery (real migrations, replayed Production RLS, NOBYPASSRLS runtime) | **82/82** |
| M6 battery on the M7-A schema (regression) | **115/115** |
| Drift (`migrate diff`) | only the five documented DB-only objects |
| Unit (no database) | M7-A core 27/27 · acquisition 17 · intake 19 · identity 18 · lead-core 62 · lifecycle 19 · intelligence 39 · sensors ✔ · coverage ✔ · erasure baseline 0 new |

## 6. Evidence matrix (M7-A)

Levels: CODE (unit / static) · LAB (PG + Production RLS + NOBYPASSRLS runtime + real code) · PROD (applied +
read-only evidence) · REAL (a real provider event for a real business) · EXT (blocked externally).
The commerce and telephony providers in the lab are **simulators**, so no row below is REAL.

| # | Proof | Level now | Where |
|---|---|---|---|
| E1 | migration / schema exactly as reviewed | LAB → PROD at D10 | lab steps 1–5; post-apply proof 16 checks |
| E2 | FORCE RLS, per-command policies, no DELETE, no foreign grants | LAB → PROD at D10 | battery E2; proof 7–10 |
| E3 | duplicate / retry / parallel → one receipt, one order / call, one Customer | LAB | battery E3, calls ×4 |
| E4 | out-of-order never regresses status | LAB + CODE | battery E4 |
| E5 | wrong business (body names B, other secret) | LAB | battery E5 |
| E6 | unknown endpoint | LAB | battery |
| E7 | disabled feature / paused / revoked (incl. accepted-then-revoked) | LAB | battery |
| E8 | signature failure: HMAC, Svix (tamper, stale), keyed URL | LAB + CODE | battery, unit vectors |
| E9 | one live mapping per store host; freed on revoke | LAB | battery |
| E10 | known buyer → that Customer; new phone → Customer; email-only → none | LAB | battery |
| E11 | ambiguous buyer / conflicting caller → proposals; confirm attaches; undo reverts; no link from a call | LAB | battery |
| E12 | Order ≠ Lead, Call ≠ Lead (R0 at runtime), no Deal / money / stock | LAB + CODE | battery, unit |
| E13 | Secretary: CUSTOMER_CALLED; unknown callers grouped; returned by an outbound call | LAB + CODE | battery, unit |
| E14 | learning without PII | LAB + CODE | battery, sensor contract |
| E15 | attribution kept, sanitized | LAB + CODE | battery, unit |
| E16 | provider failure → retry → recovery | LAB | battery (simulated outage) |
| E17 | a real provider event for a real business | **EXT / not started** | M7-B / M7-C: provider adapters, a real store / phone account, Voicenter confirmation |
| Meta | ERROR Page keeps receiving (stored and deferred); paused Page unsubscribable; long-lived token or refusal; permission range; code 100 grace | LAB + CODE | battery, unit; REAL needs Meta review |

## 7. Production blast radius (when D10 is approved)

- **New:** four empty tables, four sequences, 11 policies, 4 OFF features. Nothing reads or writes them until PR-B
  deploys, and nothing is written until a provider adapter (M7-B / M7-C) is registered **and** the owner enables its
  feature for a business.
- **Replaced constraints:** `AcquisitionConnection` (0 rows in Production at the last evidence run); the two
  `IntakeNormalizedEvent` vocabularies. Re-adding a CHECK validates the whole table under an ACCESS EXCLUSIVE lock.
  Every existing value stays valid (strict superset), and preflight check 6 proves no connection violates the new
  shape. Expected lock time is well under a second at current volume; intake writes simply wait.
- **Replaced function body:** the Meta resource resolver. In Production today it serves **zero** Meta connections, so
  the change has no runtime effect until Meta Lead Ads is enabled.
- **Untouched:** every existing row, every other table, policy and grant, every lead / customer / conversation path,
  WhatsApp.

## 8. Rollback and recovery

- **Before PR-B deploys:** `.m7a/rollback.sql` (owner-run). It refuses while any order, line, history row, call,
  commerce / telephony connection, routed-to-call event or feature override exists. It drops the four tables,
  restores the exact M6 / M3 / M4 constraint definitions and the ACTIVE-only resolver, removes the four features and
  the ledger row. Lab-proven: the preflight is whole again afterwards.
- **After PR-B deploys:** revert PR-B first (or promote the previous Vercel deployment), then roll back as above.
- **Partial failure during the release:** the migration is one transaction (lab step 3); `release-migrate` leaves an
  unfinished ledger row and no object. Recover by fixing forward or resolving the failed row (an owner decision,
  never automatic).

## 9. Provider state

Every commerce and telephony source is OFF, and none has an adapter registered in the Production intake registry:
WooCommerce and Wix arrive in M7-B, CloudTalk and Voicenter in M7-C. No connection, order, call or lead was created
in Production. Meta: no change in Meta. Business Verification and App Review are in review; Access Verification has
not started.

## 10. Remaining external blockers (not D10's)

- **M7-B commerce:** a Wix app (Dubiz developer account, owner), a real WooCommerce store for E17.
- **M7-C telephony:** a CloudTalk account; Voicenter commercial and technical confirmation (signature or IP list,
  pricing, partner terms).
- **Meta Lead Ads:** Business Verification, App Review (Advanced Access) and Access Verification. WhatsApp ES v4
  (#690) is a separate track.
