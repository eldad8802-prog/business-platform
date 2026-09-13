-- Device & Session Management — the one column a device label needs.
--
-- WHAT THIS IS FOR
--
-- Settings will show the owner which devices are signed in. Everything that
-- screen needs already exists on "AuthSession" — created, last used, the two
-- expiries, the revoked pair — except any way to say WHICH device a row is. A
-- session today is an anonymous uuid, and "Chrome on Windows" cannot be derived
-- from a uuid.
--
-- WHY THE RAW HEADER AND NOT A PARSED LABEL
--
-- The column holds the User-Agent as sent, and the human label is derived when
-- the list is read. Parsing rules improve; a stored label freezes whatever the
-- parser believed on the day the row was written, and re-deriving costs nothing.
-- It also keeps parsing off the login path.
--
-- WHY 512 AND NULLABLE
--
-- Real User-Agent strings sit far below 512 characters. The value is
-- attacker-controlled, so the runtime truncates before inserting and this cap is
-- the second line rather than the first: a column that merely rejected an
-- oversized header would turn a hostile string into a failed session issuance,
-- and issuance failing means persistent login silently switching off for that
-- user. Truncated first, capped here, so the worst a hostile header achieves is
-- an ugly label.
--
-- Nullable with no default and no backfill. Every existing row keeps NULL, which
-- the list renders as an unnamed device rather than a wrong one. A request that
-- sends no User-Agent at all must still be able to sign in.
--
-- No index. Nothing filters or sorts by this column; the list is already served
-- by AuthSession_userId_idx and every single-session lookup by the primary key.
--
-- WHY THE GRANT IS HERE AND WHY IT IS INSERT ONLY
--
-- `app_auth` holds column-level INSERT on "AuthSession", not table-level, so a
-- new column is NOT covered by the existing grant and the write would fail with
-- 42501. It holds table-level SELECT, so reading the column needs nothing added.
--
-- INSERT and nothing else. A session belongs to one browser for its whole life,
-- so the label is written once at login and never changes. Withholding UPDATE
-- makes that immutability a property the database enforces rather than a comment
-- the code is trusted to honour.
--
-- The tenant plane is untouched: it holds nothing at all on this table, and
-- ALTER TABLE ADD COLUMN grants nobody anything.
--
-- Guarded on role existence, for the same reason as
-- 20260908200000_auth_session_privilege_contract: REVOKE and GRANT raise 42704
-- where the role is absent, and a migration that cannot run on a fresh database
-- quietly decides which environments are allowed to exist. Only the NOLOGIN
-- group is named; every environment attaches its own LOGIN identity, and
-- membership is how the privilege resolves at connection time.
--
-- IF NOT EXISTS so the statement is safely re-runnable in a lab that applies the
-- file more than once. Prisma applies it exactly once in Production.

ALTER TABLE public."AuthSession"
  ADD COLUMN IF NOT EXISTS "userAgent" VARCHAR(512);

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_auth') THEN
    GRANT INSERT ("userAgent") ON public."AuthSession" TO app_auth;
  END IF;
END
$do$;
