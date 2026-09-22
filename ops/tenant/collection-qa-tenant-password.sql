-- Repair the Collection QA tenant's password. ONE row, ONE column.
--
-- WHY THIS EXISTS
--
-- The QA tenant was provisioned with a credential that is unusable. The local
-- secret file held a UTF-8 byte-order mark and nothing else, and the hash was
-- generated from it, so the stored password is the single character U+FEFF.
-- The login API accepts it, but the login FORM cannot submit it — the submit
-- button is disabled while `password.trim()` is empty, and U+FEFF trims away —
-- and the product has no change-password and no reset route. The account is
-- therefore unreachable through the product it exists to test.
--
-- The normal fix would be a product feature. There is none, and adding one to
-- rescue a QA account would be the wrong order of work. So this file exists
-- instead: the narrowest possible write, behind the same gates as everything
-- else that touches Production.
--
-- WHAT IT IS ALLOWED TO DO
--
-- One UPDATE, setting one column, on one row identified four ways at once: the
-- user id, the address, the business id, and the business name. Three of those
-- are redundant on purpose. A predicate that can only be satisfied by the row
-- we mean cannot be pointed at another row by a typo, and the redundancy is
-- what a reviewer checks rather than having to trust the id.
--
-- `updatedAt` is deliberately NOT written. The approval was for the password
-- credential and nothing else, and a hand-written UPDATE that quietly touches a
-- second column is exactly what the guard exists to refuse. The consequence is
-- honest and small: the row's updatedAt keeps the value provisioning gave it,
-- and the change is recorded by this file, its run, and its verification.
--
-- WHAT IT CANNOT DO: reach another user, another business, another column, or
-- another table. scripts/ci/collection-qa-tenant-guard.mjs proves that
-- statically before the workflow opens a connection, and the workflow refuses
-- to run at all unless a read-only pre-flight finds exactly one target row.
--
-- VARIABLES (bound by the workflow; never literals in this file)
--   :qa_user_id        the approved user id
--   :qa_business_id    the approved business id
--   :qa_email          the dedicated login address
--   :qa_business_name  the approved business name
--   :qa_password_hash  bcrypt cost 10, from the production-db secret

SET statement_timeout = '30s';

BEGIN;

UPDATE "User" u
SET "password" = :'qa_password_hash'
FROM "Business" b
WHERE u."id" = :qa_user_id
  AND u."email" = :'qa_email'
  AND u."businessId" = :qa_business_id
  AND b."id" = u."businessId"
  AND b."name" = :'qa_business_name'
RETURNING 'REPAIR' AS step, u."id" AS user_id, u."businessId" AS business_id;

COMMIT;
