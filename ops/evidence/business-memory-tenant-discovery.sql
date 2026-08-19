-- Business Memory · SHADOW-VERIFY-DISCOVERY-1 · Production tenant discovery (read-only).
--
-- Purpose: let the owner identify their QA-safe tenant's businessId by listing businesses alongside
-- their ReviewEvent counts (tenants that already have owner-decision evidence sort first). OPERATIONAL
-- EVIDENCE ONLY — not a product read path.
--
-- Minimal + non-sensitive output: Business.id, Business.name (the business's own display name — a
-- non-sensitive business datum), Business.createdAt, and a ReviewEvent COUNT per business. It returns
-- NO vendor/normalized-vendor/category, NO ReviewEvent.verdicts/rawFinal/rawBelief, NO user/email/phone,
-- NO document contents. SELECT-only; READ ONLY transaction (session read-only + statement timeout +
-- ROLLBACK). A CI static guard rejects any write keyword before this reaches the database. No inputs
-- (fixed query) — there is no injection surface.

SET statement_timeout = '30s';
SET default_transaction_read_only = on;
BEGIN TRANSACTION READ ONLY;

\echo '== Businesses + ReviewEvent counts (tenants with owner-decision evidence first) =='
SELECT b.id AS business_id,
       b.name AS business_name,
       b."createdAt" AS business_created_at,
       COUNT(r.id) AS review_event_count
FROM "Business" b
LEFT JOIN "ReviewEvent" r ON r."businessId" = b.id
GROUP BY b.id, b.name, b."createdAt"
ORDER BY COUNT(r.id) DESC, b.id ASC;

ROLLBACK;
