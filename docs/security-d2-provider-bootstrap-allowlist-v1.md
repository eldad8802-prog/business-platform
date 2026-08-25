# D2 — Provider-Bootstrap Table Allowlist (v1)

**Status:** Canonical (P7-W4A). Mechanically referenced by `scripts/ci/w4-context-guard.sh`.

A *provider-bootstrap table* is a table that must be readable **before** any
tenant context exists, because reading it **is** the tenant resolution. These
tables deliberately carry **no tenant RLS**; their protection is: tight
least-privilege grants, unique provider-identifier lookups, and a single
sanctioned reader module.

Forcing tenant RLS onto one of these would deadlock resolution (you cannot
know the tenant before the lookup that discovers the tenant).

## Allowlisted tables

| Table | Lookup key | Resolves | Sanctioned reader |
|---|---|---|---|
| `User` / `Business` | Bearer token `sub` | session tenant | `lib/auth.ts` (Option A bootstrap, ratified in P4-C) |
| `POSApiKey` | `keyHash` (sha256, unique) | POS ingest tenant | `app/api/inventory/pos/sale/route.ts` (Wave 3) |
| `WhatsAppConnection` | `phoneNumberId` (unique, 1:1 with `businessId`) | WhatsApp webhook tenant | `lib/services/integrations/whatsapp/connection.service.ts` |
| `PaymentWebhookEvent` | `(provider, providerEventId)` unique | none (global raw-event landing log; tenant is resolved afterwards via `PaymentRequest`) | `lib/services/payments/payment-webhook.service.ts` |

## Rules

1. **No tenant RLS** on an allowlisted table; each future Wave migration must
   leave them out explicitly (Wave-3 precedent: `POSApiKey`).
2. Resolution failures **fail closed**: a missing/ambiguous/non-active mapping
   yields no tenant, never a fallback tenant. A DB *error* during resolution
   must propagate — it is never interpreted as "not found".
3. Payload/body/query/header tenant hints are **never** authority; only the
   unique provider identifier drives the lookup.
4. Additions to this list require an architecture-gate decision (like the
   W4 Architecture Gate that ratified `WhatsAppConnection`), not a code PR
   alone.
