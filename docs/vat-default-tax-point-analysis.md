# VAT default of a new draft line vs. the tax point — analysis (#1111)

Status: analysis only. #1111 changes nothing on the server. Every behaviour change below is a **proposal**.
Line numbers are for branch `fix/billing-vat-default-rate` after the merge of `main` at `192efb77`.
The legal statements are described at the level of "which date decides the rate". The exact rule for each case
(the VAT Law's tax-point sections and the transitional provisions of the 2025 rate order) must be confirmed by the
accountant before any of the proposals is implemented.

## 1. What #1111 does and what it leaves alone

- Client only. `newEmptyLocalLine()` (`lib/billing/document-view-model.ts:142-150`) fills the VAT box of a line the
  user adds with "+ הוסף פריט". It uses `"0"` for `EXEMPT_DEALER` and otherwise `standardVatRatePercent(today)`
  (`:127-136`: 17 before 1.1.2025, 18 from then, by the Israel-time calendar day).
- The kind comes from `GET /api/billing/invoice-profile` (`app/billing/[id]/page.tsx:207-225`). That route loads the
  profile of `user.businessId` from the authenticated session (`app/api/billing/invoice-profile/route.ts:96-109`,
  `lib/auth.ts:96,110-113`). If the read fails, the kind is `null` and the line gets the standard rate. An exempt
  default is never guessed.
- The user can edit the box (`page.tsx:3074-3075`). Nothing is stored until the user saves the lines.

Proven by `.tax-classification-lab/vat-default-regression.test.ts` (R1–R6), `lib/billing/document-view-model.vat-default.test.ts`
and browser lab U6.

## 2. What the server does with a VAT rate today

| Step | Code | Behaviour |
|---|---|---|
| Save draft lines | `lib/services/billing/billing-draft.service.ts:132-163` (`replaceBillingDraftLines`, `:399`) | Accepts whatever rate the caller sends. Validation is only `0 ≤ rate ≤ 100`, at most 2 decimals (`lib/services/billing/validation/billing-line.validation.ts:78-87`). Lines are deleted and re-created on every save (`:147-152`), so line `createdAt`/`updatedAt` (`prisma/schema.prisma:3063-3064`) reset on each save. |
| Totals | `lib/services/billing/totals/billing-totals.service.ts:13-35` | VAT = round(subtotal × the line's own rate ÷ 100), half-up. |
| Issue | `lib/services/billing/billing-issue.service.ts:471` (`issuedAt = new Date()`), `:647-654` (recompute from the **stored** line rates), `:314` (snapshot keeps each stored rate), `:349` (`defaultVatRate: null`) | No date-based rate check. No "exempt ⇒ 0" check on lines. The rate stored on the line is the rate that gets issued. |
| Exempt dealer | `billing-issue.service.ts:716-746`, `lib/billing/business-identity.ts:87-96` | An exempt dealer is refused TAX_INVOICE / TAX_INVOICE_RECEIPT before numbering (`:806`). This uses the kind **at issue time**. There is no history of the kind. |
| Credit note | `lib/services/billing/billing-credit-reversal.service.ts:59-64, 204-208, 245-252` | The first credit copies the source invoice's lines **with their rates**. A later partial credit takes `initialLines` from the caller, and no rate is checked against the source. Draft edits re-check only the amount and currency (`billing-draft.service.ts:440-452`). |
| Quote → invoice | `lib/services/billing/convert-quote-to-invoice.service.ts:106-114, 132-142` | Copies the quote's line rates unchanged, whatever the conversion date. |
| Tax invoice/receipt | `lib/services/billing/receipt/billing-receipt-draft.service.ts:163-176` | Goods lines go through the same 0..100 validation. A pure RECEIPT has no goods lines (`:177-178`), so it has no VAT. |
| Kind change | `app/api/billing/invoice-profile/route.ts:146-150, 241-254` | Records `BILLING_IDENTITY_CHANGED` with from/to kind. Existing drafts are not touched. |

**Conclusion:** the server has **no tax-point rule**. It trusts the stored line rate, bounded to 0..100. The client
default is only the first value an input box shows. The user may change it, and the server will issue whatever was
saved. #1111 does not weaken anything on the server, but it also does not add a rule there.

## 3. When "the day the line was added" gives the wrong rate

The default date is the day the user clicks "+ הוסף פריט". The rate that is legally due is fixed by the **tax point**
(מועד החיוב) of the transaction, which is not stored anywhere today.

| # | Case | Default gives | Should be (to confirm) | What the server does today |
|---|---|---|---|---|
| 1 | Draft line added 31.12.2024, invoice issued 2.1.2025 | 17 | Depends on the tax point. If the supply or payment happened in 2024, 17 is right. If the tax point is the 2025 issue, 18. | Issues 17 as stored (`issue.service.ts:647-654`). No warning. |
| 2 | Service spanning the change (Dec 2024 – Jan 2025) | One rate for the whole line | May need to be split by the transitional provisions (part 17, part 18) | No concept of a period. One rate per line. The user must split it manually into two lines. |
| 3 | Advance payment / receipt before the charge event | Not applicable to a pure RECEIPT (no VAT lines). For a TAX_INVOICE_RECEIPT, today's rate | The tax point of an advance is usually the payment date. The later final invoice should not re-charge VAT on the advance at a different rate. | No link between an advance and the final invoice's VAT. The rate is whatever the lines carry. |
| 4 | Credit note for an old (17%) invoice | First credit: copied 17 ✔. A line **added** on the credit screen gets 18 ✘ | The rate of the original invoice | No check that credit-line rates match the source (`credit-reversal.service.ts:204-208`, `draft.service.ts:440-452`). |
| 5 | Quote drafted at 17, converted after 1.1.2025 | Copied 17 | The rate at the invoice's tax point (normally 18) | Copies the quote rate unchanged (`convert-quote-to-invoice.service.ts:110,139`). |
| 6 | Exempt dealer who became an authorized dealer | Lines added while exempt are 0 and stay 0 after the change. Lines added after the change get the standard rate. | Supplies made after the registration date are taxable at the standard rate. Supplies made before it are not. | Issuance checks only the **current** kind (`issue.service.ts:746`). An old 0% quote converted after registration becomes a 0% tax invoice with no warning. |
| 7 | Authorized dealer → exempt (the reverse) | New lines get 0. Saved lines keep 18. | No VAT on supplies made after the change | TAX_INVOICE is refused for the now-exempt business, which blocks the draft as a whole. No line-level check. |
| 8 | Draft left open across midnight / reopened days later | The default is taken when the line is added, not when it is saved or issued | Tax point | The stored rate is issued. |
| 9 | A future rate change | Needs a new row in `STANDARD_VAT_RATES` (client code) | The rate order | Nothing on the server knows rates. |

## 4. Recommended solution without a schema change (proposals, not implemented)

The tax point itself is not stored, so a no-schema solution can only use the dates we have: the issue date
(`issuedAt`), the source document's dates (quote, invoice), and the line as typed.

1. **Server-side rate table, single source.** Move `STANDARD_VAT_RATES` to a server/pure module, e.g.
   `lib/billing/vat-rates.ts`, and have the client import it. One table, used by both sides. Pure, no schema.
2. **Warn at issue, do not silently change.** At issue (and in the pre-issue checklist), compare each line's rate with
   the standard rate on the issue date (Israel time). Flag a line when the rate is neither that rate nor 0 for an
   intentional exempt supply. The warning is returned to the screen with an explicit "issue anyway" confirmation, and
   an audit event is recorded. This is a behaviour change at issue, and therefore an A0 change.
3. **Re-apply the default for untouched new lines, client side.** The client knows which lines it created and the user
   never edited. On save, and again just before submit/issue, it can refresh those lines to the rate on the current
   date. The server cannot tell "never edited" today, because lines are re-created on every save
   (`draft.service.ts:147-152`). So this belongs on the client, or needs the schema field in §5.
4. **Credit note line default = source rate.** On a CREDIT_NOTE draft, the "+ add line" default should be the source
   invoice's rate (or a choice from the rates on that invoice), not today's rate. At save/issue, the server warns when a
   credit line's rate is not one of the source invoice's rates.
5. **Quote → invoice conversion.** At conversion, compare the quote's rates with the rate on the conversion date. When
   they differ, show both and let the user choose. Default to the current rate if the quote line used the old standard
   rate. Never change a 0% line silently.
6. **Exempt-dealer guard on lines.** At issue of a TAX_INVOICE / TAX_INVOICE_RECEIPT by an authorized dealer or company,
   warn on 0% lines when the business was exempt within the last N months (from `BILLING_IDENTITY_CHANGED` events). For
   an exempt dealer's QUOTE, warn on lines with a non-zero rate.
7. **Spanning services.** Do not try to split automatically. Detect descriptions/drafts created before a rate change and
   issued after it (draft `createdAt` < change date ≤ issue date) and show a one-line notice: "שיעור המע״מ השתנה בין
   יצירת הטיוטה להפקה — בדקו את מועד החיוב".

Proposals 2, 4, 5 and 6 change what issuance or conversion does, so each needs its own owner-approved A0 exception.
Proposals 1, 3 and 7 are client- or reporting-only.

## 5. What a later schema field adds

A `taxPointDate` (מועד החיוב / charge-event date) on `BillingDocument`, optionally overridable per line, plus line
provenance (`rateSource: DEFAULT | USER | COPIED_FROM_SOURCE`) would:

- make the rate **derivable and verifiable**: rate = table(taxPointDate). The server can then enforce it instead of only
  warning, with an explicit, audited override;
- handle spanning services (one line per period, each with its own tax point);
- link advances to final invoices (the advance's tax point and rate travel with the allocation);
- let the server re-apply the default only to lines that are still `DEFAULT`, which fixes case 1 cleanly;
- give the accountant export (uniform files) a tax-point field instead of inferring it from `issuedAt`;
- together with a dated history of the business kind, decide exempt vs. authorized per tax point (case 6) instead of by
  the current kind.

That is a schema change on a protected `Billing*` model (A0 G3) and a migration, and both are out of scope here.

## 6. Bottom line

- The #1111 default is an improvement for the common case: a line added and issued on the same side of a rate change.
  It is never worse than the old hard-coded 17.
- It is **only a default**. The server today enforces no tax-point rule, so a wrong rate in cases 1–7 is issued exactly
  as saved, both before and after #1111.
- The safest next step without a schema change is proposal 1 (one rate table) plus proposal 2 (a warning at issue when
  the rate differs from the rate on the issue date), followed by proposal 4 (credit-note default = source rate).
