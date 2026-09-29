-- Business Intake M4 · Identity Resolution + Routing.
--
-- WHY
-- M3 answers "what happened, from which trusted source, for which business".
-- M4 answers "who is this about, how certain are we, and where does it go" —
-- without ever silently merging people. Three homes, three meanings:
--
--   IdentityLink          CURRENT INTERPRETATION: an identifier (email, an
--                         alternate phone, a provider-scoped id) belongs to a
--                         Customer. Stored as a domain-separated SHA-256 (kind + scope) of the
--                         normalized value — never the value — because the value
--                         already lives on the domain record that needs it.
--                         Reversible: a link is revoked, never deleted.
--   IdentityProposal      OWNER AUTHORITY: evidence was not enough to decide, so
--                         Dubiz asks. Confirm / reject / undo, with a staleness
--                         check and a record of every domain effect it applied
--                         (so undo restores exactly that and nothing more).
--   IntakeNormalizedEvent HISTORICAL EVIDENCE (existing M3 table, new columns):
--                         what M4 concluded for that event at that time —
--                         identity state, evidence categories, candidate count,
--                         the routing rule and destination. Never rewritten by a
--                         later reversal: history and current interpretation are
--                         kept apart on purpose.
--
-- Customer stays THE contact record (no Contact model). Customer.phone stays
-- the authoritative phone identity (its (businessId, phone) unique is unchanged).
--
-- TENANCY. Every row carries businessId. Links and proposals reach Customer /
-- Lead / IntakeEvent through COMPOSITE (businessId, id) keys — the Customer and
-- Lead keys exist since sec-C (#530); IntakeEvent's since M3 — so a row of
-- business A cannot reference B's records even with a forged id, whatever RLS
-- does. FORCE RLS with per-command SELECT / INSERT / UPDATE policies; no DELETE.
--
-- EXPAND-ONLY. Two tables, eight nullable/defaulted columns on
-- IntakeNormalizedEvent, indexes, keys, CHECKs, RLS, policies, grants. No
-- backfill, no existing row, column, constraint or policy changes. No Customer
-- is linked, merged or reassigned by this migration.

-- ── Preconditions (fail loudly, never half-apply) ──────────────────────────

DO $pre$
BEGIN
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION 'M4 requires PostgreSQL 15+ (ON DELETE SET NULL (column))';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Customer_businessId_id_key')
     AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'Customer_businessId_id_key' AND relkind = 'i') THEN
    RAISE EXCEPTION 'M4 requires sec-C 20260926110000 (Customer_businessId_id_key)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Lead_businessId_id_key')
     AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'Lead_businessId_id_key' AND relkind = 'i') THEN
    RAISE EXCEPTION 'M4 requires sec-C 20260926110000 (Lead_businessId_id_key)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'IntakeEvent_businessId_id_key') THEN
    RAISE EXCEPTION 'M4 requires M3 20260929090000 (IntakeEvent_businessId_id_key)';
  END IF;
END
$pre$;

-- ── IdentityLink ─────────────────────────────────────────────────────────────

CREATE TABLE "IdentityLink" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "customerId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT '',
    "valueHash" TEXT,
    "method" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "sourceIntakeEventId" INTEGER,
    "proposalId" INTEGER,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" INTEGER,
    "revokeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdentityLink_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "IdentityLink_kind_vocab" CHECK ("kind" IN ('phone', 'email', 'provider')),
    -- Provider ids are only meaningful inside their scope ("<sourceKey>:<account>").
    CONSTRAINT "IdentityLink_scope_rule" CHECK (
      ("kind" = 'provider' AND "scope" ~ '^[a-z][a-z0-9_.]*:[^\s]{1,128}$')
      OR ("kind" <> 'provider' AND "scope" = '')
    ),
    -- valueHash is NULL only after account erasure: an erased link can never
    -- match (NULL = x is never true) and NULLs never collide in the unique index.
    CONSTRAINT "IdentityLink_valueHash_format" CHECK ("valueHash" IS NULL OR "valueHash" ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT "IdentityLink_method_vocab" CHECK ("method" IN ('deterministic', 'owner_confirmed')),
    CONSTRAINT "IdentityLink_status_vocab" CHECK ("status" IN ('active', 'revoked')),
    CONSTRAINT "IdentityLink_revocation_shape" CHECK (
      ("status" = 'active' AND "revokedAt" IS NULL AND "revokeReason" IS NULL)
      OR ("status" = 'revoked' AND "revokedAt" IS NOT NULL
          AND "revokeReason" IN ('owner_undo', 'erasure', 'superseded'))
    )
);

-- One ACTIVE owner per identifier per business: two concurrent resolutions can
-- never both claim the same email / phone / provider id for different people.
CREATE UNIQUE INDEX "IdentityLink_active_identifier_key"
  ON "IdentityLink"("businessId", "kind", "scope", "valueHash")
  WHERE "status" = 'active';
CREATE INDEX "IdentityLink_businessId_customerId_idx" ON "IdentityLink"("businessId", "customerId");

ALTER TABLE "IdentityLink" ADD CONSTRAINT "IdentityLink_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IdentityLink" ADD CONSTRAINT "IdentityLink_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Composite tenant key (DB-only, like sec-C's): same-business Customer only.
ALTER TABLE "IdentityLink" ADD CONSTRAINT "IdentityLink_customerId_tenant_fkey"
  FOREIGN KEY ("businessId", "customerId") REFERENCES "Customer"("businessId", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

-- ── IdentityProposal ─────────────────────────────────────────────────────────

CREATE TABLE "IdentityProposal" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "intakeEventId" INTEGER NOT NULL,
    "candidateCustomerId" INTEGER NOT NULL,
    "leadId" INTEGER,
    "reason" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'proposed',
    "proposedLinks" JSONB DEFAULT '[]',
    "evidence" JSONB DEFAULT '{}',
    "evidenceFingerprint" TEXT NOT NULL,
    "appliedEffects" JSONB,
    "policyVersion" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "decidedByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdentityProposal_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "IdentityProposal_reason_vocab" CHECK ("reason" IN ('candidate', 'ambiguous', 'conflict')),
    CONSTRAINT "IdentityProposal_state_vocab" CHECK (
      "state" IN ('proposed', 'confirmed', 'rejected', 'undone', 'stale', 'superseded')
    ),
    CONSTRAINT "IdentityProposal_fingerprint_format" CHECK ("evidenceFingerprint" ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT "IdentityProposal_policyVersion_format" CHECK ("policyVersion" ~ '^[a-z][a-z0-9_.]*@[0-9]+$'),
    CONSTRAINT "IdentityProposal_decision_shape" CHECK (
      ("state" IN ('proposed') AND "decidedAt" IS NULL)
      OR ("state" IN ('confirmed', 'rejected', 'undone', 'stale', 'superseded') AND "decidedAt" IS NOT NULL)
    )
);

-- One proposal per (event, candidate): regenerating a proposal is a no-op.
CREATE UNIQUE INDEX "IdentityProposal_event_candidate_key"
  ON "IdentityProposal"("businessId", "intakeEventId", "candidateCustomerId");
CREATE INDEX "IdentityProposal_businessId_state_idx" ON "IdentityProposal"("businessId", "state");
CREATE INDEX "IdentityProposal_businessId_candidateCustomerId_idx" ON "IdentityProposal"("businessId", "candidateCustomerId");

ALTER TABLE "IdentityProposal" ADD CONSTRAINT "IdentityProposal_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IdentityProposal" ADD CONSTRAINT "IdentityProposal_businessId_intakeEventId_fkey"
  FOREIGN KEY ("businessId", "intakeEventId") REFERENCES "IntakeEvent"("businessId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IdentityProposal" ADD CONSTRAINT "IdentityProposal_candidateCustomerId_fkey"
  FOREIGN KEY ("candidateCustomerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Composite tenant keys (DB-only, like sec-C's).
ALTER TABLE "IdentityProposal" ADD CONSTRAINT "IdentityProposal_candidateCustomerId_tenant_fkey"
  FOREIGN KEY ("businessId", "candidateCustomerId") REFERENCES "Customer"("businessId", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "IdentityProposal" ADD CONSTRAINT "IdentityProposal_leadId_tenant_fkey"
  FOREIGN KEY ("businessId", "leadId") REFERENCES "Lead"("businessId", "id")
  ON DELETE SET NULL ("leadId") ON UPDATE NO ACTION;

-- ── IntakeNormalizedEvent: M4's per-event conclusion (historical evidence) ────

ALTER TABLE "IntakeNormalizedEvent"
  ADD COLUMN "identityState" TEXT,
  ADD COLUMN "identityPolicyVersion" TEXT,
  ADD COLUMN "identityCustomerId" INTEGER,
  ADD COLUMN "identityEvidence" JSONB,
  ADD COLUMN "identityCandidateCount" INTEGER,
  ADD COLUMN "routingRule" TEXT,
  ADD COLUMN "routingDestination" TEXT,
  ADD COLUMN "ownerReviewRequired" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "IntakeNormalizedEvent"
  ADD CONSTRAINT "IntakeNormalizedEvent_identityState_vocab" CHECK (
    "identityState" IS NULL OR "identityState" IN
      ('resolved', 'candidate', 'ambiguous', 'unresolved', 'conflict', 'not_applicable')
  ),
  ADD CONSTRAINT "IntakeNormalizedEvent_routingDestination_vocab" CHECK (
    "routingDestination" IS NULL OR "routingDestination" IN
      ('conversation', 'message_status', 'lead', 'customer', 'commerce', 'document', 'attention', 'none')
  ),
  ADD CONSTRAINT "IntakeNormalizedEvent_routingRule_format" CHECK (
    "routingRule" IS NULL OR "routingRule" ~ '^[A-Z][0-9A-Za-z_]{1,63}$'
  ),
  ADD CONSTRAINT "IntakeNormalizedEvent_identityCandidateCount_range" CHECK (
    "identityCandidateCount" IS NULL OR "identityCandidateCount" >= 0
  );

-- ── Tenant isolation ────────────────────────────────────────────────────────
--
-- Both new tables are written only inside a tenant transaction. Fail-closed:
-- with no GUC, NULLIF yields NULL and no row matches. PER-COMMAND policies,
-- SELECT / INSERT / UPDATE only — reversal and erasure are UPDATEs; Customer /
-- Business deletion cascades (FK actions run as the table owner).

ALTER TABLE "IdentityLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "IdentityLink" FORCE ROW LEVEL SECURITY;

CREATE POLICY identity_link_tenant_read ON "IdentityLink" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

CREATE POLICY identity_link_tenant_insert ON "IdentityLink" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

CREATE POLICY identity_link_tenant_update ON "IdentityLink" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "IdentityProposal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "IdentityProposal" FORCE ROW LEVEL SECURITY;

CREATE POLICY identity_proposal_tenant_read ON "IdentityProposal" FOR SELECT
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

CREATE POLICY identity_proposal_tenant_insert ON "IdentityProposal" FOR INSERT
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

CREATE POLICY identity_proposal_tenant_update ON "IdentityProposal" FOR UPDATE
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ── Privileges ───────────────────────────────────────────────────────────────
--
-- Explicit: Production's default ACL would otherwise hand app_runtime DELETE on
-- a new table. Guarded on the role existing (no-op in CI / fresh databases).

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON "IdentityLink" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "IdentityLink_id_seq" TO app_runtime;
    REVOKE DELETE, TRUNCATE ON "IdentityLink" FROM app_runtime;
    GRANT SELECT, INSERT, UPDATE ON "IdentityProposal" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "IdentityProposal_id_seq" TO app_runtime;
    REVOKE DELETE, TRUNCATE ON "IdentityProposal" FROM app_runtime;
  END IF;
END
$do$;
