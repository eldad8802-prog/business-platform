# Finding — VAT default 17% in the document editor (reported, NOT changed)

**Status:** pre-existing on `main` (not introduced by this work). No code was changed for it. Needs an
owner/accountant decision.

## What happens
- `lib/billing/document-view-model.ts:116-123` — `newEmptyLocalLine()` pre-fills every new line with
  `vatRatePercent: "17"`.
- Its only caller is the billing document editor (`app/billing/[id]/page.tsx:1163`, "add line"); the field
  is editable (`:3004`).
- The server accepts any VAT rate 0–100 with 2 decimals (`lib/services/billing/validation/billing-line.validation.ts:78`)
  and has **no** default of its own, no business-kind awareness (an exempt dealer — `EXEMPT_DEALER` —
  must not charge VAT) and no date awareness.
- Issued documents freeze the per-line rate in their snapshot (correct — must stay unchanged).

## Why it matters
Israel's standard VAT rate is **18% since 2025-01-01** (was 17%). An owner who adds a line and does not
edit the field issues a tax invoice with 17% VAT: under-charged VAT and a document that does not match
the law at its date.

## Not affected
- Already-issued documents (immutable snapshots) — and they must not be altered.
- Uniform-file test fixtures use 17.00 as synthetic data (`lib/services/billing/uniform/__fixtures__`) —
  harmless, but would read better at 18.

## Options (decision required)
1. **Minimal:** default `"18"` for new lines. One line; no historical effect; drafts already holding 17
   keep it until edited.
2. **Correct by business kind:** default from the business profile — `EXEMPT_DEALER` → `0`,
   otherwise the rate in force on the document date (18 now).
3. **Plus a guard:** on issue, warn (not block) when a line's rate differs from the rate in force for a
   non-exempt business.

Recommendation: **2 + 3**, reviewed by the accountant. Each is a small, separate PR — kept out of the
i18n / multi-currency PR on purpose.
