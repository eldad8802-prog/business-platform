-- Persistent login — the two tables a refresh session needs, and nothing else.
--
-- WHAT THIS IS FOR
--
-- Today a signed-in owner is signed out again within 24 hours, because the
-- bearer token is the only credential and CASA 2.2.3 caps its absolute lifetime
-- at that. Raising the cap is not on the table. The way to keep somebody signed
-- in without a long-lived credential is a refresh session: a rotating secret
-- delivered in an HttpOnly cookie, exchanged for a short access token, and
-- replaced on every exchange.
--
-- INERT. Nothing reads or writes either table. There is no Prisma model, no
-- route, no import, and no behaviour change of any kind. The runtime knows
-- exactly as much about persistent login after this migration as before it.
--
-- THE CREDENTIAL, and why the table is shaped this way
--
-- The cookie carries "<sessionId>.<secret>": a selector and a verifier.
--
--   sessionId  the row's own id. It authenticates NOTHING. Its whole job is to
--              identify the row even after the secret has rotated away.
--   secret     256 bits of CSPRNG, stored only as its SHA-256 digest.
--
-- The selector is the load-bearing part of the design, and it exists because of
-- a defect a two-hash schema could not avoid. With only "current" and
-- "previous" hashes, a third concurrent refresh carrying the original secret
-- matches neither, and — worse — a secret two rotations old is no longer stored
-- anywhere, so "a credential we issued" and "a random string" become
-- indistinguishable. A selector makes the row findable regardless, which is
-- what makes both concurrency and classification possible at all.
--
-- WHY THE SELECTOR IS A UUID AND NOT A SEQUENCE
--
-- A sequential id would be enumerable. It still would not authenticate anyone,
-- but it would let somebody aim guesses at rows known to exist and count the
-- product's sessions. The database default means a row cannot be inserted
-- without one.
--
-- WHY THERE IS A SECOND TABLE
--
-- `AuthSessionSecret` holds the secrets this session has rotated away, with the
-- instant each stopped being current and the instant its grace ends. It does
-- three jobs, and the first two each justify it on their own:
--
--   1. GRACE. Concurrent refreshes, a lost response and out-of-order Set-Cookie
--      all leave a client holding a secret the server has already replaced.
--      Accepting it briefly is what lets every one of those converge instead of
--      cascading into a forced re-login.
--   2. CLASSIFICATION. It separates "a secret this session issued" from "a
--      string we have never seen". Without that separation, an unknown secret
--      would have to be treated as reuse — which would hand a session-revocation
--      primitive to anyone who learned a selector, a value that authenticates
--      nothing.
--   3. Divergence evidence, and forensics after the fact.
--
-- An unknown secret is an authentication failure and NOTHING MORE. Revoking a
-- session needs positive evidence: a hash still present in this table, whose
-- grace has passed, on a session that has been refreshed since. That last
-- condition is the one that keeps a lost response from looking like a theft.
--
-- WHY THE TIMESTAMPS HAVE NO DEFAULT
--
-- `TIMESTAMP(3)` here means WITHOUT TIME ZONE, as it does everywhere in this
-- schema. `CURRENT_TIMESTAMP` is a timestamptz, so a default would be cast into
-- the column using the session's TimeZone — which nothing in this project sets.
-- Under a non-UTC session that stores a wall clock hours away from the instant
-- it meant, and every expiry and grace boundary moves with it, in the lenient
-- direction.
--
-- So all six are NOT NULL with no default. The consumer supplies them from one
-- instant captured per rotation, which is also the only way the ordering
-- between `lastUsedAt` and `graceUntil` can be trusted. NOT NULL without a
-- default is the enforcement: an insert that forgets one fails loudly rather
-- than quietly taking a database clock. This matches the 67 columns already
-- shaped this way — `expiresAt`, `validUntil`, `dueAt` among them.
--
-- WHAT IS DELIBERATELY ABSENT
--
--   * no GRANT and no REVOKE. There is no consumer, so nothing needs a
--     privilege, and the role that will need one is the auth plane's — which
--     was provisioned directly in Preview and Production, never by a migration.
--     Granting to `app_runtime` here would not be documentation of intent: the
--     production login role is a member of it, so it would hand the tenant
--     runtime full DML over auth sessions at the moment D2 Stage E3 is
--     narrowing that plane's privileges. The exact grant belongs with the
--     consumer, against the live catalog, through the mechanism that created
--     the role.
--   * no RLS and no businessId. A refresh resolves a session by selector BEFORE
--     anyone knows which tenant it belongs to, so a tenant predicate would match
--     zero rows and break authentication outright — the same reason `User` and
--     `Business` sit outside RLS. A denormalised businessId added only to
--     satisfy a generic policy would be a second copy of `User.businessId` that
--     can disagree with it.
--   * no unique index on either `secretHash`. Lookup is by selector, so the
--     hash is neither a key nor a lookup path.
--   * no index on `absoluteExpiresAt`, and none on (`sessionId`, `rotatedAt`).
--     Neither has a reader: cleanup is user-scoped, there is no scheduler
--     anywhere in this product, and the unique constraint below already serves
--     every query the child table has.
--
-- EXPAND-ONLY. Two new tables. No existing table is altered, no column is added
-- or dropped, no row is written, and no backfill runs. Both children are created
-- empty, so the foreign keys have nothing to validate.

-- ============================================================
-- AuthSession — one row per signed-in device
-- ============================================================
CREATE TABLE "AuthSession" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" INTEGER NOT NULL,
    "secretHash" TEXT NOT NULL,
    "tokenVersionAtIssue" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3) NOT NULL,
    "idleExpiresAt" TIMESTAMP(3) NOT NULL,
    "absoluteExpiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,

    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

-- `tokenVersionAtIssue` has no default on purpose. It records the session
-- generation this row was created under, and signing out increments that
-- generation for the whole user — so a refresh whose recorded generation no
-- longer matches must be refused. A DEFAULT 0 would let a row claim generation
-- zero that nobody wrote, and zero is a real generation: every account that has
-- never signed out is on it.

-- PostgreSQL does not index a foreign key column by itself, and the cascade
-- from `User` looks children up by exactly this column. The opportunistic
-- cleanup is user-scoped too, and its three expiry conditions are ORed, so no
-- composite could serve them — a bitmap over three indexes to filter a handful
-- of rows per user is not worth maintaining on every rotation.
CREATE INDEX "AuthSession_userId_idx" ON "AuthSession"("userId");

ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The one invariant the whole design rests on is that no raw credential is ever
-- stored, and this is the database refusing to hold one if the code is wrong.
--
-- Both halves are needed. The pattern alone would be an argument about how
-- PostgreSQL anchors `$` against a trailing newline; the length makes that
-- argument unnecessary, because "<64 hex chars>\n" is 65 characters and fails
-- before the pattern is consulted. The pattern is case-sensitive (`~`, not
-- `~*`), so uppercase hex is refused as well — the digest has exactly one
-- written form here.
--
-- A 256-bit secret is 43 base64url characters, so the length also rejects the
-- specific accident this exists for: assigning the secret instead of its digest.
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_secretHash_sha256_hex"
  CHECK (char_length("secretHash") = 64 AND "secretHash" ~ '^[0-9a-f]{64}$');

-- ============================================================
-- AuthSessionSecret — the secrets this session has rotated away
-- ============================================================
CREATE TABLE "AuthSessionSecret" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sessionId" UUID NOT NULL,
    "secretHash" TEXT NOT NULL,
    "rotatedAt" TIMESTAMP(3) NOT NULL,
    "graceUntil" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthSessionSecret_pkey" PRIMARY KEY ("id")
);

-- This is the only index the table needs, and it is doing three jobs at once.
--
-- The hot lookup is `WHERE "sessionId" = $1 AND "secretHash" = $2` — equality on
-- both columns, in this order, so it is a single index probe. Its leading column
-- also serves the cascade when a parent session is deleted. And the uniqueness
-- is a correctness guard, not housekeeping: recording one secret twice for one
-- session would leave the divergence check with two different `graceUntil`
-- values to choose between.
CREATE UNIQUE INDEX "AuthSessionSecret_sessionId_secretHash_key"
  ON "AuthSessionSecret"("sessionId", "secretHash");

-- CASCADE rather than RESTRICT: the evidence describes the session, and it must
-- not outlive it or block its removal.
ALTER TABLE "AuthSessionSecret" ADD CONSTRAINT "AuthSessionSecret_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "AuthSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AuthSessionSecret" ADD CONSTRAINT "AuthSessionSecret_secretHash_sha256_hex"
  CHECK (char_length("secretHash") = 64 AND "secretHash" ~ '^[0-9a-f]{64}$');
