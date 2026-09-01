-- Session revocation: give every user a token generation.
--
-- Expand-only and additive. The column is NOT NULL with a default, so the
-- existing rows are all written as generation 0 — which is exactly the value
-- that tokens minted before this feature decode to. No session is invalidated
-- by applying this migration, and the previous application version ignores the
-- column entirely, so it is safe to apply ahead of the deploy.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER NOT NULL DEFAULT 0;
