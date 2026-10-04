-- All-Feature Learning Coverage — rule lineages for the income side (W2), the sales funnel and
-- running the business (W3), and their temporal extensions.
--
--   M4 measures (26): BILL-01..05, CUST-01..03, PAY-01..02, COLL-01..02, LEAD-01..04, CONV-01..02,
--                     APPT-01..04, SEC-01..02, OFF-01, REP-01
--   M6 temporal (7):  T-BILL-01, T-BILL-02, T-CUST-01, T-PAY-02, T-LEAD-01, T-CONV-01, T-APPT-03
--
-- GOVERNANCE ROWS ONLY. No table, no column, no index, no RLS policy, no grant changes. The resolver
-- is fail-closed: a rule whose lineage is missing refuses at the "policy" stage instead of writing an
-- unversioned artifact, so until these rows exist the new rules learn nothing — which is why this
-- migration must be applied BEFORE the code that registers the rules is merged (migration-first).
--
-- Learning still runs only for businesses enrolled in the knowledge_derivation feature (default off).
-- Brain stays SHADOW. No owner-visible output changes. Idempotent.

INSERT INTO "DerivationPolicy" ("key", "name") VALUES
  ('billing-invoicing-cadence',               'BILL-01 · How many days typically pass between two invoices this business issues?'),
  ('billing-payment-timing',                  'BILL-02 · How many days after (or before) the due day are this business''s invoices usually paid?'),
  ('billing-late-share',                      'BILL-03 · What share of this business''s paid invoices were paid after their due day?'),
  ('billing-credit-note-share',               'BILL-05 · What share of this business''s matured invoices were followed by a credit note?'),
  ('customers-payment-timing',                'CUST-01 · How many days after (or before) the due day does this customer usually pay?'),
  ('customers-invoicing-cadence',             'CUST-02 · How many days typically pass between two invoices to this customer?'),
  ('customers-ticket-size',                   'CUST-03 · What is the typical invoice amount for this customer, and how far does it range?'),
  ('collection-reminder-timing',              'COLL-01 · How many days after the due day does this owner usually send the first reminder?'),
  ('collection-overdue-reminded-share',       'COLL-02 · What share of this business''s overdue invoices received a reminder before being paid?'),
  ('billing-quote-conversion',                'BILL-04 · What share of this business''s matured quotes became invoices?'),
  ('payments-link-conversion',                'PAY-01 · What share of this business''s payment links were paid within 30 days of being created?'),
  ('payments-link-time-to-pay',               'PAY-02 · How many days typically pass between creating a payment link and it being paid?'),
  ('leads-first-handling-days',               'LEAD-01 · How long after a lead arrives does this owner usually first act on it?'),
  ('leads-win-share',                         'LEAD-02 · What share of this business''s closed leads were won?'),
  ('leads-follow-up-punctuality',             'LEAD-03 · How many days after (or before) its due day does this owner usually complete a lead''s next action?'),
  ('leads-days-to-win',                       'LEAD-04 · How long does a won lead usually take from arrival to win?'),
  ('conversations-first-reply-days',          'CONV-01 · How long after a customer''s first message does this business usually reply?'),
  ('conversations-unanswered-24h-share',      'CONV-02 · What share of customers'' opening messages got no reply from the business within 24 hours?'),
  ('appointments-no-show-share',              'APPT-01 · Of this business''s appointments that were due to happen, what share were no-shows?'),
  ('appointments-cancellation-share',         'APPT-02 · What share of this business''s booked appointments were cancelled?'),
  ('appointments-booking-lead-days',          'APPT-03 · How far ahead are this business''s appointments usually booked?'),
  ('appointments-reschedule-share',           'APPT-04 · What share of this business''s appointments were moved at least once?'),
  ('secretary-handled-to-paid-days',          'SEC-01 · How many days after marking a payment ''handled'' is the money actually recorded as paid?'),
  ('secretary-obligation-closure-timing',     'SEC-02 · How many days after (or before) the due day does this owner usually mark an obligation as met? (Owner-asserted.)'),
  ('offering-demand-cadence',                 'OFF-01 · How many days typically pass between two demand signals for this service?'),
  ('reports-accountant-export-cadence',       'REP-01 · How many days typically pass between two accountant exports by this owner?'),
  ('temporal-billing-invoicing-cadence',      'T-BILL-01 · billing.invoicing_cadence over time'),
  ('temporal-billing-payment-timing',         'T-BILL-02 · billing.payment_timing over time'),
  ('temporal-customers-payment-timing',       'T-CUST-01 · customers.payment_timing over time'),
  ('temporal-payments-link-time-to-pay',      'T-PAY-02 · payments.link_time_to_pay over time'),
  ('temporal-leads-first-handling-days',      'T-LEAD-01 · leads.first_handling_days over time'),
  ('temporal-conversations-first-reply-days', 'T-CONV-01 · conversations.first_reply_days over time'),
  ('temporal-appointments-booking-lead-days', 'T-APPT-03 · appointments.booking_lead_days over time')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "DerivationPolicyVersion" ("policyId", "version")
SELECT p."id", 'v1'
FROM "DerivationPolicy" p
WHERE p."key" IN (
  'billing-invoicing-cadence',
  'billing-payment-timing',
  'billing-late-share',
  'billing-credit-note-share',
  'customers-payment-timing',
  'customers-invoicing-cadence',
  'customers-ticket-size',
  'collection-reminder-timing',
  'collection-overdue-reminded-share',
  'billing-quote-conversion',
  'payments-link-conversion',
  'payments-link-time-to-pay',
  'leads-first-handling-days',
  'leads-win-share',
  'leads-follow-up-punctuality',
  'leads-days-to-win',
  'conversations-first-reply-days',
  'conversations-unanswered-24h-share',
  'appointments-no-show-share',
  'appointments-cancellation-share',
  'appointments-booking-lead-days',
  'appointments-reschedule-share',
  'secretary-handled-to-paid-days',
  'secretary-obligation-closure-timing',
  'offering-demand-cadence',
  'reports-accountant-export-cadence',
  'temporal-billing-invoicing-cadence',
  'temporal-billing-payment-timing',
  'temporal-customers-payment-timing',
  'temporal-payments-link-time-to-pay',
  'temporal-leads-first-handling-days',
  'temporal-conversations-first-reply-days',
  'temporal-appointments-booking-lead-days'
)
ON CONFLICT ("policyId", "version") DO NOTHING;
