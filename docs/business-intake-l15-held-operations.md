# Business Intake · L1.5 — held receipts, release, visibility, notifications: operations

How held intake receipts behave, how they are released, what the owner and the operator see, which switches exist (all
OFF), how to turn things on in order, and how to roll back. It covers the L1.5-b PRs: PR-1 #978 (merged), PR-5 #986,
PR-2 #987, PR-3 #988, PR-4 #989, PR-6 #990, and PR-8. Plan: https://claude.ai/artifact/Wu9SowDMz3ZS53GudgZiqe.

## 1. Receipt states

| State | How it is stored | Leaves it by |
|---|---|---|
| Ready | `RECEIVED` or `PERSISTED`, or `FAILED` with a next attempt. `lastErrorCode` is not `held:*` | processing → `PROCESSED` / `IGNORED`, or a retry |
| Held | `RECEIVED`, `lastErrorCode = held:<reason>`, payload kept, no attempt spent. Reasons: `connection_paused`, `emergency_disabled`, `source_disabled`, `business_inactive` | the hold lifting (see §2); `REVOKED` → `IGNORED`; expiry (PR-6, if switched on) |
| Dead letter | `FAILED`, no next attempt, payload kept for 30 days for replay, then purged | manual replay while the payload exists |
| Expired (PR-6, OFF) | `FAILED`, no next attempt, `lastErrorCode = expired:<reason>`, **payload kept and never purged by the 30-day retention** | a future controlled restore (not built) |

A held receipt is **never** processed before its hold lifts. The processor checks, in order: revoked → paused →
source gate (the emergency switch, entitlement, business) → provider.

## 2. Release

- **Resume** (`setPaused` → ACTIVE):
  - the transaction flips the status only;
  - the paused receipts are then re-armed in batches of 1,000 (8 s budget, SKIP LOCKED);
  - a receipt a worker holds under its lease is never re-armed (PR-5);
  - anything not re-armed comes due at its next recheck, at most 10 minutes later.
- **Emergency switch off, or entitlement restored:** the next 10-minute recheck releases the receipts.
- **Sweep:** `/api/intake/sweep`, run by QStash every 10 minutes plus backstops, 60 s `maxDuration`.
  - **Lanes (PR-1):** ready work comes first. Held receipts get their own share (at least 10 of 50 per business). One look settles a whole connection, up to 1,000 per look.
  - **Budget (PR-5):** a 40 s budget. The starting business rotates every run, then release rounds follow: up to 9 extra drains of 50 per business that still has due work, fair across businesses.
  - **Throughput:** about 500 per business per run, bounded by `maxDuration`. 20,000 released take about 40 runs (about 7 h). Raising `maxDuration` is an owner cost decision.

## 3. What the operator sees (sweep response, counts only)

- **`backlog`** (existing): `deadLettersNew` (reported once), `pendingStale`, `pendingStaleNew` (reported once), `held`.
- **`budget`** (PR-5): `businessesNotReached` (informational), `releaseRounds`, `releaseBusinesses`.
- **`capacity`** (PR-2):
  - open backlog by class;
  - businesses at 500, 1,000 and 2,000 held;
  - the largest per-business held count;
  - the oldest held receipt, in hours;
  - received, processed and recovered in the last hour;
  - capped and unread businesses.
- **Red reasons (HTTP 500 → scheduler alert):**
  - existing: `business_errors`, `failed_receipts`, `dead_letters_new`, `pending_stale_new`, `commerce_reconcile_failures`;
  - only with `INTAKE_CAPACITY_ALERTS_ENABLED=true`: `held_capacity_tier` (a tier crossed, once) and `held_capacity_global` (20,000 or more held platform-wide, once per UTC day).
- **Server log:** `[intake-sweep] held capacity` with `businessId`, `held`, `tier`, `oldestHeldHours`. No content.

## 4. What the owner sees (PR-3 / PR-4, only with `intake_status_visibility`)

- **Home, "מה ממתין לך":** kind `intake` (chip "פניות"). These items are never counted as leads and never appear in the Secretary. They cover:
  - paused with enquiries waiting (at risk after 7 days);
  - not in the plan;
  - held by Dubiz (nothing to do);
  - a connection to check;
  - could not be taken in;
  - still processing (after 30 minutes).
- **Connections screen:** a per-connection note with the waiting and failed counts.
- **Notifications (in-app only, no push):**
  - paused, not in plan, connection to check, 1,000 or more waiting: `ACTION_REQUIRED`, 24 h cooldown;
  - not taken in: `FAILURE_EVENT` HIGH, 24 h;
  - recovered: `WARNING` INFO, 24 h;
  - a Dubiz hold and "still processing" are silent.

## 5. Switches (ALL OFF)

| Switch | Kind | Effect when on | Turning it on needs |
|---|---|---|---|
| `INTAKE_CAPACITY_ALERTS_ENABLED=true` | Vercel env | capacity red reasons (once per crossing / once a day) | env change + redeploy |
| `intake_status_visibility` | platform feature (catalog default OFF) | owner home and connections status + in-app notifications | **a migration that inserts the feature definition row** (FK from `BusinessFeatureAccess`), then a business override (business 9 first) |
| `INTAKE_HELD_EXPIRY_ENABLED=true` | Vercel env | expiry of paused / not-included / inactive holds after 14 days | the policy decisions, then env change + redeploy |

## 6. Activation order (each step needs an explicit owner go)

1. Merge PR-5 (#986), then PR-2 (#987). Run a read-only Production check.
2. Merge PR-3 (#988) and PR-4 (#989), with the feature still off.
3. Release migration: the `intake_status_visibility` definition and policy rows, both off. Then override business 9 only, and check the screens signed in.
4. `INTAKE_CAPACITY_ALERTS_ENABLED=true` once the operator wants the alerts.
5. Merge PR-6 (#990), off. Turn expiry on only after the policy decisions; a day-12 warning should exist first.
6. Purge of expired payloads (PR-7): only after a privacy policy. Not built.

## 7. Rollback

| What | How |
|---|---|
| PR-1 / PR-5 / PR-2 behaviour | revert the PR (no data migration) |
| capacity alerts | unset the env, redeploy |
| owner visibility and notifications | remove the business override (immediate). Open notifications stay as rows and resolve on the next complete read once the facts are gone |
| expiry | unset the env, redeploy. Already-expired receipts keep their payload, so a controlled restore stays possible |

## 8. Pilot readiness per source (code review, 2026-11-07)

| Source | Provider retry (per code) | Recovery from provider | DB down | Not entitled | Pilot |
|---|---|---|---|---|---|
| Website forms | none (browser / site) | none | 503; the visitor sees an error | 404, nothing recorded | **GO-able**: repeat of the proven business-9 pilot |
| Google Ads | retries 5xx (documented, unverified) | none (Ads CSV is manual) | 503 | 200, nothing recorded (lost) | **GO-able** |
| Meta Lead Ads | ~36 h | fetch by leadgen id (~90 days), no backfill | 503 | 200, nothing recorded | **NO-GO**: verify token / app secret not set in Prod, App Review, Business verification |
| WooCommerce | "never retries" | **reconciler** polls modified orders, re-activates webhooks | 503 | 200 | GO-able with a real HTTPS store |
| Wix | 12× over ~47 h | **reconciler** order search | 503 | 200 | **NO-GO**: no Dubiz Wix app yet |
| CloudTalk | 50× over ~11.5 h | call history per call id | 503 | 200 | GO-able with a real account |
| Voicenter | unknown | none | 503 | 200 `{Err:0}` | **NO-GO**: awaits written confirmation from Voicenter (auth / IPs, retry, id stability). The key in the URL may reach access logs |

GO conditions for any pilot:
- business 9 only;
- the source feature enabled for business 9 alone;
- one connection;
- a genuine delivery;
- the source's live-proof evidence SQL passes;
- no other business enabled.

NO-GO if any of these holds:
- a provider prerequisite above is missing;
- the evidence fails;
- an unexplained dead letter or business error appears in the sweep.
