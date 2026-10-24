-- Reversal of 20261026090000_payment_settlement_facts. OWNER-RUN ONLY (as the migration role), never automatic.
--
-- Safe only while no code reads or writes the table: the application PR not deployed, or reverted and its
-- deployment replaced FIRST (docs/payments/SETTLEMENT-FACTS-DESIGN.md §10). It REFUSES while the table holds a
-- row: discarding recorded settlement facts (financial evidence) is a separate, explicit owner decision — never
-- a side effect of a rollback. (With a row present the DROP would not even reach it: the append-only trigger
-- refuses TRUNCATE, and nothing here disables it.)
--
-- What it removes: the table (with its policies, triggers, indexes, sequence and grants), its three functions,
-- and its own ledger row in the same transaction, so a later release re-applies the migration whole. Nothing
-- that existed before the migration is touched: it changed no existing object. task_user_same_business (from
-- 20261018090000) stays: the migration only attached a trigger to it.

BEGIN;
DO $rb$
BEGIN
  IF EXISTS (SELECT 1 FROM "PaymentSettlementFact") THEN
    RAISE EXCEPTION 'payment settlement facts rollback refused: rows exist';
  END IF;
END
$rb$;

DROP TABLE "PaymentSettlementFact";
DROP FUNCTION public.payment_settlement_fact_guard();
DROP FUNCTION public.payment_settlement_fact_net_check();
DROP FUNCTION public.payment_settlement_fact_append_only();

DELETE FROM "_prisma_migrations" WHERE migration_name = '20261026090000_payment_settlement_facts';
COMMIT;
