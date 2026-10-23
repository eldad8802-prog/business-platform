-- Rollback of 20261028090000_revenue_truth_foundation — removes every object the migration created and
-- nothing else (it changed no existing object, so there is nothing to restore).
--
-- REFUSES while any revenue row exists: the tables are append-only evidence, and a rollback is not a way to
-- delete it. Run as the migration role, in one transaction (psql -1). Never run without an owner decision.

DO $do$
DECLARE
  n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "RevenueSale") + (SELECT count(*) FROM "RevenueReceipt")
       + (SELECT count(*) FROM "RevenueDailyClose") + (SELECT count(*) FROM "RevenueDailyCloseTender")
       + (SELECT count(*) FROM "RevenueDailyCloseVat") + (SELECT count(*) FROM "RevenueSettlement")
       + (SELECT count(*) FROM "RevenueLink") + (SELECT count(*) FROM "RevenueDecision")
    INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION 'REVENUE_ROLLBACK_REFUSED: % revenue row(s) exist; nothing was changed', n;
  END IF;
END
$do$;

DROP TABLE "RevenueDecision", "RevenueLink", "RevenueDailyCloseVat", "RevenueDailyCloseTender",
           "RevenueSettlement", "RevenueReceipt", "RevenueDailyClose", "RevenueSale";
DROP FUNCTION public.revenue_link_guard();
DROP FUNCTION public.revenue_append_only_guard();
DROP FUNCTION public.revenue_truncate_guard();
DROP TYPE "RevenueSourceKind", "RevenueCapture", "RevenueSaleKind", "RevenueTenderMethod", "RevenueReceiptDirection",
          "RevenueVatCategory", "RevenueValidation", "RevenueLinkKind", "RevenueLinkBasis", "RevenueActor",
          "RevenueDecisionKind";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261028090000_revenue_truth_foundation';
