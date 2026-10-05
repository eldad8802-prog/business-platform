-- ============================================================================
-- One account per email address, whatever its case (M0 follow-up)
--
-- User.email carries a case-sensitive unique index (User_email_key). Signup and
-- login fold addresses to lower case, but the database did not enforce it: a
-- legacy mixed-case row would let a second account register the folded
-- spelling, and that account would then win every login lookup.
--
-- Production evidence (prod-readonly-evidence run 37379235512, 2026-10-05):
-- 0 stored addresses differ from their lower-case form, 0 folded addresses are
-- held by more than one account. The guard below re-checks that at apply time
-- and refuses rather than guess which account is the real one.
--
-- The existing User_email_key stays: Prisma's findUnique({ where: { email } })
-- relies on it. Not authority-changing: no grant, no policy, no role.
--
-- Rollback: DROP INDEX "User_email_casefold_key".
-- ============================================================================

DO $pre$
BEGIN
  IF EXISTS (SELECT 1 FROM "User" GROUP BY lower("email") HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'user_email_casefold_unique: two accounts share an address up to case — inspect before migrating';
  END IF;
END
$pre$;

CREATE UNIQUE INDEX "User_email_casefold_key" ON "User" (lower("email"));
