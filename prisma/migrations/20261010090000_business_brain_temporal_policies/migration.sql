-- Business Brain W2 — temporal memory for the domains that had none.
--
--   T-CUST-02  per-customer invoicing cadence (customer gone quiet / new customer behaviour, customerId FK only)
--   T-COLL-01  reminder timing vs due day        T-SEC-02  obligation closure timing (owner-asserted)
--   T-OFF-01   per-service demand cadence         T-REP-01  accountant-export cadence (DATA_EXPORTED sensor)
--   T-APPT-01  no-show share                      T-LEAD-02 win share
--
-- GOVERNANCE ROWS ONLY. No table, no column, no index, no RLS policy, no grant changes. The temporal
-- resolver is fail-closed: until these rows exist the seven rules refuse at the "policy" stage, so this
-- migration is applied BEFORE the code that registers them (migration-first). Learning still runs only
-- for businesses enrolled in knowledge_derivation. Brain stays SHADOW. Idempotent.

INSERT INTO "DerivationPolicy" ("key", "name") VALUES
  ('temporal-customers-invoicing-cadence',         'T-CUST-02 · customers.invoicing_cadence over time'),
  ('temporal-collection-reminder-timing',          'T-COLL-01 · collection.reminder_timing over time'),
  ('temporal-secretary-obligation-closure-timing', 'T-SEC-02 · secretary.obligation_closure_timing over time'),
  ('temporal-offering-demand-cadence',             'T-OFF-01 · offering.demand_cadence over time'),
  ('temporal-reports-accountant-export-cadence',   'T-REP-01 · reports.accountant_export_cadence over time'),
  ('temporal-appointments-no-show-share',          'T-APPT-01 · appointments.no_show_share over time'),
  ('temporal-leads-win-share',                     'T-LEAD-02 · leads.win_share over time')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "DerivationPolicyVersion" ("policyId", "version")
SELECT p."id", 'v1'
FROM "DerivationPolicy" p
WHERE p."key" IN (
  'temporal-customers-invoicing-cadence',
  'temporal-collection-reminder-timing',
  'temporal-secretary-obligation-closure-timing',
  'temporal-offering-demand-cadence',
  'temporal-reports-accountant-export-cadence',
  'temporal-appointments-no-show-share',
  'temporal-leads-win-share'
)
ON CONFLICT ("policyId", "version") DO NOTHING;
