# Business Intake M2 — WhatsApp intake stabilization (v1)

Parents:
- `docs/business-intake-architecture-audit-v1.md` (audit)
- `docs/business-intake-m1-evidence-closure-v1.md` (M1 freeze)

This document is the design record for M2. It does not change the frozen architecture; it applies it to the first source.

## What M2 changes

| Before | After |
|---|---|
| The webhook answered 200 whatever happened; any failure lost the message for good (M1 W2). | The webhook answers 200 only after a durable `IntakeEvent` receipt exists. If the receipt cannot be written, it answers 500 so Meta redelivers. |
| Two first messages from a new number raced on `Customer_businessId_phone_key`; one was lost (W1). Concurrent messages could create two OPEN conversations (W6). | `ingestInboundCustomerMessage` serialises per sender with `pg_advisory_xact_lock` (namespace `'IS'`, key = business + canonical phone). Every message survives; there is one customer and one OPEN conversation. |
| Processing ran inside the request; a partial failure was permanent (W7). | Processing runs after the response. A failure is recorded on the receipt (`FAILED`, bounded `lastErrorCode`, backoff) and retried by the next webhook for the business or by the sweeper. A receipt whose domain records already exist (`PERSISTED`) resumes enrichment only. |
| `/api/message` defaulted `direction`/`senderType` to INBOUND/CUSTOMER from the body, and carried a second, drifted copy of the inbound pipeline (W3, W5). | `/api/message` writes business messages only. The server decides OUTBOUND/BUSINESS_USER, and a body that asserts otherwise gets 400. The inline pipeline is deleted. There is one inbound path: intake → `ingestInboundCustomerMessage` → `runInboundMessagePipeline`. |
| Profile name, `statuses[]` and `referral` were dropped (W4). | The profile name names a new customer and upgrades a number-as-name placeholder; an owner-set name is never overwritten. Statuses become `MESSAGE_STATUS` receipts that update only the OUTBOUND message they describe (monotonic, and never an inbound message). The referral's ad identifiers are kept as receipt metadata. |
| An outbound 401/403/190 set `REVOKED_BY_META`, and inbound then required `CONNECTED`, so every later customer message was dropped (W8). | Inbound is accepted for CONNECTED, REVOKED_BY_META and ERROR, and refused only for DISCONNECTED and REVOKED (owner stops). |
| Timestamps and the unanswered count were written only when `CONVERSATION_STATE_WRITER_ENABLED` was on; intake did `+1` per message (retries inflated it); `/api/message` wrote none. | `conversation-activity.ts` writes them for every message, derived and monotonic (replay-safe), independent of the flag. The flag still decides stage, temperature, close probability and the HOT/STAGE events — unchanged, not inferred, not toggled. |
| Unsupported types (audio, sticker, location, …) left no trace (W9). | They are recorded as `IGNORED` receipts with the reason. No fake message is created. |
| Throttled documents were dropped (W11). | They are deferred on the receipt and retried. |

## IntakeEvent — the receipt ledger

- **Contract:** one row per provider event per business. The unique key is `(businessId, provider, externalEventId)`, tenant-scoped.
- **Provider-neutral:** WhatsApp is the first `IntakeProvider` value. Later sources add enum values, not tables.
- **Replay key:** `sha256(<provider identity>)`. It is never the raw wamid. The raw id lives on `Message.providerMessageId`, which account erasure nulls.
- **Payload:** the minimal normalized envelope needed to process the event. It is personal data until processed, and it is purged on PROCESSED / IGNORED. For terminal FAILED receipts it is purged after 30 days.
- **Metadata:** non-personal facts that outlive the payload (message type, referral ad ids).
- **Lifecycle:** RECEIVED → (PERSISTED) → PROCESSED | IGNORED | FAILED.
  - A claim is a conditional UPDATE, so exactly one worker holds a lease.
  - An expired lease is re-claimable.
  - Retries stop after 8 attempts; the receipt is kept.
- **Isolation:**
  - ENABLE + FORCE RLS.
  - Per-command SELECT/INSERT/UPDATE policies on `app.current_business_id`.
  - No DELETE policy.
  - Explicit role-guarded grants, plus `REVOKE DELETE, TRUNCATE` against the Production default ACL.
  - Not a bootstrap table: it is written after tenant resolution, inside a tenant transaction.
- **Erasure:** ERASURE_MANAGED. Account deletion nulls payload, metadata, the routing ref and the three pointers.
- **Not operational truth:** Message / Conversation / Customer remain the domain records.
- **Not learning:** LearningEvent is untouched and never receives the payload.

## Frozen rules M2 obeys

- **Customer stays the contact record.** No Contact model.
- **A message is not a lead.** Intake creates no Lead. `LEADS_AUTO_CAPTURE_ENABLED` is unchanged (absent in Production).
- **Identity:** the Party engine is not used for intake. Matching is the feature-local canonical phone, under the per-sender lock.
- **AI:** no customer content goes to an LLM. The pipeline's existing flag-gated LLM draft is untouched and is skipped on resume.
- **Tenant:** the tenant comes only from the routing gate (signed `phone_number_id` → `WhatsAppConnection`). A payload `businessId` is never read.

## Release safety (RELEASE-INFRA)

`release/verify`, the one required check, now blocks on `scripts/ci/tenant-table-rls-guard.mjs` and on the existing `tenant-scoped-access-guard`:
- Every `businessId` table must be ENABLE + FORCE RLS with a tenant policy, or on a named exemption list that can only shrink.
- Tables created from 2026-09-27 onward must also have per-command policies and explicit grants.

## Sweeper

`POST /api/intake/sweep` is protected by CRON_SECRET with the same constant-time check as settlement recovery. It returns counts only. `.github/workflows/intake-sweep.yml` runs it on manual dispatch. Scheduling it is an owner decision after release.

## Release sequence

1. **RELEASE-INFRA PR:** the guard. Merge first.
2. **PR-1:** migration `20260927090000_m2_intake_event` (migration only). Then `release-migrate`, which is the owner's production-db approval.
3. **PR-2:** schema + code. Merge only after the migration is verified in Production.
4. **Production proof:** a real inbound WhatsApp message produces a PROCESSED receipt and one Message. Then decide on scheduling the sweeper.

## Known limits (deliberate)

- On resume, the learning-evidence event and the optional LLM draft are skipped. A missing learning signal is preferred to a doubled one.
- A document whose processing failed is recorded as `IGNORED` (`documents_failed:<reason>`). The documents subsystem owns that failure (M1 W12).
- Media is not yet linked to the conversation (M1 W10), and archived-customer and idle-conversation policies are not implemented (W14, W15 → M4/M5).
