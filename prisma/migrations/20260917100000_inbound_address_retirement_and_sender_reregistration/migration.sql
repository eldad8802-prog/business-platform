-- Inbound email — address retirement, and re-registering a revoked sender.
--
-- STILL INERT. No route, no service, no worker, no UI reads or writes any of
-- this. INBOUND_EMAIL_ENABLED remains off and fails closed. This migration makes
-- two lifecycles REPRESENTABLE; nothing performs them yet.
--
-- WHAT WAS WRONG WITH THE OLD SHAPE
--
-- Two things the approved lifecycle needs could not be said truthfully.
--
--   1. Rotation retires the previous address for thirty days, during which it
--      still routes. With only ACTIVE and REVOKED, the choice was to leave it
--      ACTIVE — giving one business two unrestricted live addresses — or to mark
--      it REVOKED, which means "not routable" and is simply false while it is
--      still expected to deliver.
--
--   2. A revoked sender held its `(businessId, normalizedEmail)` unique key for
--      ever, so that address could never be registered again unless somebody
--      revived the revoked row. Reviving it would hand back an authorisation the
--      business had deliberately withdrawn.
--
-- EXPAND-ONLY, and no existing row changes meaning. No ACTIVE address becomes
-- RETIRING, no grace date is invented for history, and no sender row is deleted,
-- reactivated or re-stated. The only write is filling a new column on rows that
-- already exist.

-- AlterEnum
--
-- Added, not used. Nothing in this migration writes RETIRING; the value simply
-- becomes available to the runtime that will perform rotations later.
ALTER TYPE "InboundEmailAddressStatus" ADD VALUE 'RETIRING';

-- AlterTable
--
-- When a RETIRING address stops being routable.
--
-- THE TIMESTAMP IS AUTHORITATIVE. Routing compares the clock to this column, so
-- an address whose grace has elapsed is already ineligible even if nothing has
-- yet moved it to REVOKED. Making correctness depend on a sweep running on time
-- would turn a late sweep into a security hole.
--
-- It is NOT a revocation date. `revokedAt` records that, REVOKED is terminal,
-- and a REVOKED row is unroutable whatever this column says.
ALTER TABLE "InboundEmailAddress" ADD COLUMN     "graceUntil" TIMESTAMP(3);

-- AlterTable
--
-- The current-identity key: equal to `normalizedEmail` while the row is current,
-- NULL once it is REVOKED. PostgreSQL treats NULLs as distinct in a unique
-- index, which is what lets many revoked rows coexist while only one current row
-- is allowed.
ALTER TABLE "InboundEmailAuthorizedSender" ADD COLUMN     "activeEmailKey" TEXT;

-- Backfill, before the new unique index is built over the column.
--
-- Every existing non-revoked row becomes its own current identity. This cannot
-- collide: the unique index being dropped below already guaranteed at most one
-- row per (businessId, normalizedEmail), so at most one of them is non-revoked.
-- Revoked rows are left NULL, which is exactly what frees their address for a
-- fresh registration.
UPDATE "InboundEmailAuthorizedSender"
SET "activeEmailKey" = "normalizedEmail"
WHERE "status" <> 'REVOKED' AND "activeEmailKey" IS NULL;

-- DropIndex
--
-- Permanent uniqueness gives way to current-identity uniqueness. Dropped only
-- after the replacement column is populated, so the rule is never unenforced for
-- longer than this transaction.
DROP INDEX "InboundEmailAuthorizedSender_businessId_normalizedEmail_key";

-- CreateIndex
--
-- Lookup by address is still needed and is no longer served by a unique index.
CREATE INDEX "InboundEmailAuthorizedSender_businessId_normalizedEmail_idx" ON "InboundEmailAuthorizedSender"("businessId", "normalizedEmail");

-- CreateIndex
--
-- At most one CURRENT sender per business and address; any number of revoked
-- ones. Per tenant, because the same address may legitimately be listed by
-- several businesses a bookkeeper works for.
CREATE UNIQUE INDEX "InboundEmailAuthorizedSender_businessId_activeEmailKey_key" ON "InboundEmailAuthorizedSender"("businessId", "activeEmailKey");

-- ── Coherence, enforced by the database ──────────────────────────────────────
--
-- Both constraints exist because the alternative is trusting every future writer
-- to remember a rule. They are the first CHECK constraints in this schema, added
-- deliberately: each one couples a status to a timestamp or key whose meaning
-- depends on it, and a row that breaks the coupling is not "slightly wrong", it
-- is a routing or authorisation decision made on a false premise.
--
-- NOT VALID is deliberately NOT used: both tables are empty in Production, so
-- validation is free and a constraint that has actually been checked is worth
-- more than one that promises to be.
--
-- Honest limit: a database built with `prisma db push` from the datamodel does
-- NOT get these, because Prisma has no syntax for a CHECK. In those labs the
-- coupling rests on the writing code. The UNIQUE index above is in the datamodel
-- and therefore does exist everywhere.

-- ACTIVE carries no grace date; RETIRING must carry one; REVOKED is terminal and
-- says nothing either way, because a revoked row is unroutable regardless.
--
-- WRITTEN WITHOUT NAMING 'RETIRING', on purpose. PostgreSQL refuses to USE an
-- enum value in the same transaction that added it, and Prisma runs a migration
-- file as one transaction — so a CHECK comparing against the literal added six
-- statements earlier fails outright. Phrasing the third branch as "neither of
-- the pre-existing values" says exactly the same thing about exactly the same
-- rows, and keeps this to one migration.
ALTER TABLE "InboundEmailAddress"
  ADD CONSTRAINT "InboundEmailAddress_grace_state_coherent"
  CHECK (
    ("status" = 'ACTIVE' AND "graceUntil" IS NULL)
    OR ("status" = 'REVOKED')
    OR ("status" <> 'ACTIVE' AND "status" <> 'REVOKED' AND "graceUntil" IS NOT NULL)
  );

-- A current row carries its own address as the key; a revoked row carries none.
ALTER TABLE "InboundEmailAuthorizedSender"
  ADD CONSTRAINT "InboundEmailAuthorizedSender_active_key_coherent"
  CHECK (
    ("status" = 'REVOKED' AND "activeEmailKey" IS NULL)
    OR ("status" <> 'REVOKED' AND "activeEmailKey" = "normalizedEmail")
  );

-- ── Row-level security and privileges ────────────────────────────────────────
--
-- Unchanged, and deliberately not restated. Both tables already have ENABLE and
-- FORCE row-level security, a tenant policy keyed on app.current_business_id,
-- and named grants to app_runtime. Adding a column, swapping an index and adding
-- a CHECK affect none of those: policies are per table rather than per column,
-- and no new table or role appears here.
