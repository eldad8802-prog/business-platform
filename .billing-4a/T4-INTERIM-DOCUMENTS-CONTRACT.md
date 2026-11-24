# 4a T4: interim documents, the connection contract for the legal identity track (f3)

**For:** the legal identity session (f3). It owns the "מעבר לעוסק מורשה" screens and the confirm handler.
**From:** 4a, 2026-11-24.
**Status:** this file approves nothing. The 4a side is in the T4 PR. The screen and confirm changes below are f3's, and
each needs its own approval.

## 1. What 4a provides

### Route (read only)

`GET /api/billing/kind-transition/interim-documents`

| Parameter | Meaning |
|---|---|
| `from=YYYY-MM-DD` | The official status date the owner picked. Required while the business has no transition. Ignored once a `BusinessKindTransition` row exists: the range then comes from that row only. |
| `list=1` | Also return one page of documents (at most 50). |
| `cursor=…` | The previous page's `nextCursor`. |

- **Flag OFF** (`BUSINESS_KIND_TRANSITION_ENABLED` ≠ `"true"`): **404**, before the session is read.
- **Auth:** a Bearer session (the same `getAuthContext` as the transition routes). The business is the session's. A
  `businessId` in the query is ignored.
- **Read:** inside the business's tenant transaction (FORCE RLS). Nothing is written.
- **`from` validation:** the transition's own rule. It must be a real date, not before 2000-01-01, and not after
  today in Israel. Otherwise the route answers `400 {error:"INVALID_FROM_DATE", code:"REQUIRED"|"INVALID"|"IN_FUTURE"}`.
- **Other errors:**
  - `400 {error:"FROM_DATE_REQUIRED"}`: no transition and no `from`;
  - `400 {error:"INVALID_CURSOR"}`;
  - `401`;
  - `500 {error:"INTERIM_DOCUMENTS_FAILED"}` (no detail).
- **`200`:**

```json
{
  "range": { "fromDate": "2026-01-15", "to": "2026-02-01T10:00:00.000Z", "timezone": "Asia/Jerusalem",
             "toExclusive": true, "source": "REQUEST" | "TRANSITION_RECORD" },
  "count": 3,
  "credit": { "full": 1, "partial": 1, "linked": 0 },
  "items": [ { "id": 31, "documentType": "TAX_INVOICE" | "TAX_INVOICE_RECEIPT" | "RECEIPT" | "CREDIT_NOTE",
               "documentNumber": 7, "documentNumberFormatted": "000007",
               "issuedAt": "2026-01-20T08:00:00.000Z", "documentDate": "2026-01-20",
               "totalAmount": "118.00", "currency": "ILS",
               "creditState": "NONE" | "PARTIAL" | "FULL" | "LINKED", "creditedAmount": "118.00" } ],
  "nextCursor": "2026-01-20T08:00:00.000Z_31" | null
}
```

`items` and `nextCursor` are present only with `list=1`. Cache-Control is `no-store`.

### What is counted (owner decisions D9–D11, plus one technical refinement)

- **Documents:** `TAX_INVOICE`, `TAX_INVOICE_RECEIPT`, `RECEIPT` and `CREDIT_NOTE`, status `ISSUED`. Never `QUOTE`,
  `DRAFT` or `PENDING_REVIEW`. Documents imported from outside Dubiz (`HistoricalFiscalDocument`) are not counted.
- **Start:** `issuedAt` ≥ 00:00 of `fromDate` in Asia/Jerusalem (DST-correct).
- **End:** `confirmedAt`, exclusive (before a transition exists, now). It is enforced by what each document froze
  (`issuedSnapshot.extensions.billingBusinessKind`):
  - **EXEMPT_DEALER:** counted.
  - **AUTHORIZED_DEALER:** never counted, even when its `issuedAt` is a moment earlier than `confirmedAt`. Issuance
    stamps `issuedAt` before it waits for the transition. The lab reproduced this (L2: 3 documents issued after the
    transition carried an earlier `issuedAt`).
  - **No recorded kind** (only documents older than the billing MVP snapshot): the plain `issuedAt` < end rule.
- **`documentDate`:** the Israeli calendar day of `issuedAt`. Dubiz has no separate document date: the printed date
  is `issuedAt`.
- **`creditState`:**
  - A `TAX_INVOICE` uses the credit flow's own rule (`getBillingCreditState`): the sum of ISSUED credit notes against
    the invoice total gives `FULL` or `PARTIAL`. A draft credit note never counts, and a credit note issued after the
    window still counts toward the state.
  - Any other document that a credit note names is reported only as `LINKED`, with no full or partial claim.

### Server function for the confirm transaction

`countInterimDocumentsTx(tx, { businessId, fromDate, to })` (from
`lib/services/billing/kind-transition/interim-documents.ts`) applies the same rule and returns the count.

## 2. Coordination with issuance (the stale-count problem)

- **Issuance:** every issuance (`issueBillingDocumentTx`, the owner's route and payment settlement alike) now takes
  `pg_advisory_xact_lock_shared(hashtextextended('legal_identity:' || businessId, 0))` first.
- **The transition:** `business_kind_transition_to_authorized` already takes the same key **exclusively**.
- **The effect:**
  - Issuances never wait for each other.
  - An issuance and a transition of the same business serialize: a document is issued wholly before the transition
    (exempt profile) or wholly after it.
- **Lab proof (T4 battery):**
  - L1: while the key is held exclusively, an issuance waits with no number and completes after release.
  - L2: the real transition raced 6 parallel issuances. Every counted document froze EXEMPT_DEALER, and every
    EXEMPT_DEALER document is counted.

## 3. What f3 must do (each part needs its own approval)

1. **Steps 1 and 3 and the success screen:**
   - Call the route with the date the owner picked, and again automatically when the date changes (D12).
   - Show the owner-approved text: "מאז [תאריך] הופקו [N] מסמכים כעוסק פטור. המסמכים יישארו ללא שינוי. מומלץ לבדוק
     אותם עם רואה החשבון שלך."
   - Offer a view of the list (`list=1`, paging by `nextCursor`).
   - **On the success screen** (after the transition) call it **without** `from`. The range then comes from the record.
2. **Confirm** (`POST .../kind-transition`):
   - The request carries `interimDocumentCount`: the N the owner saw.
   - Inside the transition's own transaction, **after** `business_kind_transition_to_authorized` returned
     `TRANSITIONED` (so the exclusive key is held until commit), call
     `countInterimDocumentsTx(tx, { businessId, fromDate: statusEffectiveDate, to: confirmedAt })`.
   - If the count differs, throw so the whole transaction rolls back, and answer
     **`409 { error: "INTERIM_DOCUMENTS_CHANGED", count: <new N> }`**. The screen shows the new N, and the owner
     confirms again.
   - Approved by the owner (2026-11-24).
3. **Do not** count before the transition and compare later outside the transaction. That check could go stale
   (§2).

## 4. Not in this contract

- No write path, credit or re-issue. No change to issued documents.
- T7 and T8 are out of scope.
