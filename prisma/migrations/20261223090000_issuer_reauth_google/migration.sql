-- 4a T1a — Google re-authentication for the issuer declaration (DRAFT — NOT APPROVED FOR MERGE OR APPLY).
--
-- "מעבר לעוסק מורשה" re-authenticates the owner on the server: a password, or — for an account without a password —
-- Google (prompt=login, max_age=0, ID token verified in full, auth_time fresh, the Google account linked to THIS
-- user; lib/auth/google-reauth.ts, #1204). The transition records the method in "BusinessKindTransition".
-- When the business holds a live issuer declaration, the transition also files declaration version+1
-- (STATUS_CHANGE, migration 20261223100000), and that record must name the same re-authentication. The declaration's
-- enum has no GOOGLE, so a Google-only owner of a declared business could not transition. This adds the value.
--
-- Expand-only: one enum value. No row, no column, no default changes; nothing writes GOOGLE until the STATUS_CHANGE
-- writer exists and the transition calls it (legal identity follow-up, separate approval).
-- ADD VALUE inside a transaction is allowed (PostgreSQL >= 12); the value is not USED in this migration, so the
-- "unsafe use of new value" rule does not apply. IF NOT EXISTS keeps a re-run harmless.
-- Rollback: not needed while no row holds GOOGLE (an unused enum value is inert); PostgreSQL has no DROP VALUE.

SET lock_timeout = '3s';

ALTER TYPE "IssuerReauthMethod" ADD VALUE IF NOT EXISTS 'GOOGLE';
