-- T5-DB — what a challenge is FOR, and which one is authoritative.
--
-- Additive throughout. `InboundEmailSenderChallenge` has never had a writer —
-- nothing in the application creates one, the feature flag has never been on —
-- so the table is empty everywhere and a NOT NULL column needs no default and
-- no backfill. That fact is what makes this migration boring, and it is
-- asserted below rather than assumed.

-- ── The vocabulary ───────────────────────────────────────────────────────────
CREATE TYPE "InboundEmailChallengePurpose" AS ENUM ('SENDER_OWNERSHIP_VERIFICATION');

-- ── Refuse to run against rows this migration was not designed for ───────────
-- A NOT NULL column with no default cannot be added to a populated table, so
-- PostgreSQL would stop us anyway — but it would stop us with a generic error.
-- This says what is actually wrong.
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "InboundEmailSenderChallenge";
  IF n > 0 THEN
    RAISE EXCEPTION
      'InboundEmailSenderChallenge holds % row(s). This migration assumes none: purpose is NOT NULL with no default, and choosing a purpose on somebody else''s behalf is exactly what the column exists to prevent.', n;
  END IF;
END
$$;

-- ── Columns ──────────────────────────────────────────────────────────────────
ALTER TABLE "InboundEmailSenderChallenge"
  ADD COLUMN "purpose" "InboundEmailChallengePurpose" NOT NULL,
  ADD COLUMN "activeChallengeKey" "InboundEmailChallengePurpose",
  ADD COLUMN "supersededAt" TIMESTAMP(3);

-- ── At most one live challenge per business, sender and purpose ──────────────
-- A PLAIN unique index on a nullable column, not a partial one. PostgreSQL
-- treats NULLs as distinct, so terminal rows never collide, while at most one
-- row can hold a non-NULL key. Prisma can express this, which is the point:
-- a partial index would state the same rule and be invisible to the `db push`
-- security labs, and that blind spot is why T4-DB rejected the partial form.
CREATE UNIQUE INDEX "InboundEmailSenderChallenge_businessId_authorizedSenderId__key"
  ON "InboundEmailSenderChallenge"("businessId", "authorizedSenderId", "activeChallengeKey");

-- Serves the rolling 24-hour regeneration ceiling, which is counted from rows
-- because the rate limiter has no per-sender scope.
CREATE INDEX "InboundEmailSenderChallenge_businessId_authorizedSenderId_c_idx"
  ON "InboundEmailSenderChallenge"("businessId", "authorizedSenderId", "createdAt");

-- ── CHECK 1 — the key and the lifecycle are one fact, stated once ────────────
-- Terminal means consumed or superseded, and nothing else: an expired or burned
-- challenge keeps its key and stays authoritative until something replaces it.
--
-- Three-valued logic is the trap here, and it is why the first branch tests the
-- key for NULL before comparing it. A CHECK passes on UNKNOWN and fails only on
-- FALSE, so `activeChallengeKey = purpose` alone is not enough: when the key is
-- NULL that comparison is UNKNOWN, the second branch is FALSE, and UNKNOWN OR
-- FALSE is UNKNOWN -- which PASSES. A live row with no key would be accepted,
-- and since the unique index only constrains non-NULL keys, a sender could hold
-- unlimited live challenges that the invariant never sees.
--
-- This was not reasoned out. The first version of this constraint shipped without
-- the IS NOT NULL test, and the rehearsal inserted exactly that row and watched
-- PostgreSQL accept it.
--
-- `purpose` being NOT NULL closes the mirror-image hole on the other operand.
ALTER TABLE "InboundEmailSenderChallenge"
  ADD CONSTRAINT "InboundEmailSenderChallenge_live_key_coherent"
  CHECK (
    (
      "consumedAt" IS NULL AND "supersededAt" IS NULL
      AND "activeChallengeKey" IS NOT NULL
      AND "activeChallengeKey" = "purpose"
    )
    OR (
      ("consumedAt" IS NOT NULL OR "supersededAt" IS NOT NULL)
      AND "activeChallengeKey" IS NULL
    )
  );

-- ── CHECK 2 — a challenge cannot be both used and rotated away ───────────────
-- The two terminal states answer different questions, and a row asserting both
-- answers neither. Consumed means somebody proved control; superseded means the
-- secret died unused. Collapsing them would destroy the only durable record of
-- which happened.
ALTER TABLE "InboundEmailSenderChallenge"
  ADD CONSTRAINT "InboundEmailSenderChallenge_terminal_exclusive"
  CHECK (NOT ("consumedAt" IS NOT NULL AND "supersededAt" IS NOT NULL));

-- ── Privileges and tenancy ───────────────────────────────────────────────────
-- Nothing to do. RLS is enabled and FORCED on this table, and its tenant policy
-- keys on `businessId`, which these columns do not touch. Table-level grants to
-- app_runtime already cover new columns. Restated here so a reader does not have
-- to go and check that the omission was deliberate.
