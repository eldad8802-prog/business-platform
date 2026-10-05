# Business Brain — depth review of the 15 active learning domains

What each domain can now know, from the layers the Business Brain milestone added on top of the M4 measures:

- **temporal states**, with declared polarity;
- **memory**;
- **record links** from the product's foreign keys;
- **cross-domain families**.

Nothing here is cross-business: every baseline, link and finding belongs to one business.

Legend for the polarity column (in Temporal):

- **↓** means lower is favourable for the business, so IMPROVING / DETERIORATING apply.
- **↑** means higher is favourable.
- **neutral** means SHIFTED / TRENDING only, because there is no single "better" direction.

| Domain | Measures (M4) | Temporal (M6) and polarity | Record links | Cross-domain | Outcome loop (M9) |
|---|---|---|---|---|---|
| documents | DOC-02, DOC-04, DOC-05, DOC-06 | T-DOC-04 ↓, T-DOC-05, T-DOC-02, T-DOC-06 neutral | vendor → Party (owner / tax id) | X-PARTY-01 | live (documents family) |
| payables | AP-01, AP-03, AP-04, AP-06 | T-AP-01, T-AP-04 neutral (paying earlier is not "better") | payee → Party | X-PARTY-01, X-CASH-01 | live (payables family) |
| business-cost | COST-* (cost workstream) | — (T-AP-03 blocked by that workstream) | — | — | owned by the cost workstream |
| suppliers | SUPP-01, SUPP-02, SUPP-03 | T-SUPP-01 neutral, T-SUPP-02 ↓ | supplier ↔ item (PO lines) | X-PARTY-01, X-REPL-01 | ready: purchase orders are observable actions |
| inventory | INV-02, INV-04, INV-05 | T-INV-02 neutral, T-INV-04 ↓ | item ↔ supplier | X-REPL-01 (stock quantities excluded: POS defect) | ready |
| billing | BILL-01 … BILL-05 | T-BILL-01 neutral, T-BILL-02 ↓ | customer ↔ invoices | X-CASH-01, X-CUST-01 | ready: issued invoices and receipts are ledger actions |
| payments-in | PAY-01, PAY-02 | T-PAY-02 ↓ | customer ↔ payment links | X-CUST-01 | ready |
| collection | COLL-01, COLL-02 | **T-COLL-01** neutral (W2) | customer ↔ reminders | X-COLL-01, X-CUST-01, X-CASH-01 | ready (sequence only, never effect) |
| customers | CUST-01, CUST-02, CUST-03 | T-CUST-01 ↓, **T-CUST-02** neutral (W2) | hub of all customer links | X-CUST-01 | ready |
| leads | LEAD-01 … LEAD-04 | T-LEAD-01 ↓, **T-LEAD-02** ↑ (W2) | customer ↔ leads | X-RESP-01, X-CUST-01 | ready |
| conversations | CONV-01, CONV-02 | T-CONV-01 ↓ | — | X-RESP-01 | ready |
| appointments | APPT-01 … APPT-04 | T-APPT-03 neutral, **T-APPT-01** ↓ (W2) | customer ↔ appointments; service ↔ appointments | X-CUST-01 | ready |
| secretary | SEC-01, SEC-02 | **T-SEC-02** ↓, OWNER_ASSERTED (W2) | — | — | ready |
| offering | OFF-01 | **T-OFF-01** neutral, per service (W2) | service ↔ appointments | — | ready |
| reports | REP-01 | **T-REP-01** neutral (W2, DATA_EXPORTED sensor) | — | — | not decision-relevant |

Every temporal series is read into one state:

- NORMAL
- STABLE_PATTERN
- IMPROVING / DETERIORATING
- SHIFTED / TRENDING
- ONE_OFF_ANOMALY
- NEW_BEHAVIOR (only when the business has established history for that rule)
- GONE_QUIET
- INSUFFICIENT_HISTORY

Memory keeps what used to be known, as non-authoritative items with the caveat NOT_CURRENT_KNOWLEDGE:

- STALE measures keep their value and the date they were valid until.
- SUPERSEDED versions keep no value, because a different rule version's number is not comparable.
- Previous baselines record what normal used to be.

## Deliberately not built

- **Owner traits** ("prefers", "is risk-averse"): there is no deterministic definition, so the default is no.
- **Causal links of any kind**: findings state co-occurrence; the validator rejects causal wording.
- **Lead → revenue (family E)**: no lead → invoice link exists, so it stays BLOCKED.
- **Stock-quantity knowledge in any cross-domain premise**: excluded because of the POS held-sale defect.
- **Serializing the relationship graph itself into the Brain context**: a privacy decision, not taken here. Relationships reach the Brain only inside deterministic findings, with aliased subjects.
- **Customer identity by phone / email / tax id**: an owner decision. All customer links use `customerId` only.
- **Cross-business baselines or memory**: forbidden by design.
