-- M4 || M5 · Multi-domain learning, evidence-gap closure, and the identity proposal ledger.
--
-- ADDITIVE ONLY. Two new tables, five new enums, six new nullable columns, and fourteen governance
-- rows. Nothing is renamed, nothing is dropped, no existing column changes type or nullability, and
-- no existing row is rewritten. Every new column is NULL on every historical row and stays that way:
-- an actor, a machine suggestion or a payment term that was never recorded is a gap, and filling it
-- retroactively with a guess would replace an honest gap with a confident fiction.

-- ============================================================
-- 1 · NEW ENUMS
-- ============================================================

-- Where a MATCH lives until somebody with authority agrees with it. PROPOSED has no effect on
-- anything the system believes; only the owner moves it.
CREATE TYPE "EntityLinkState" AS ENUM ('PROPOSED', 'CONFIRMED', 'REJECTED');

-- STRONG = an identifier issued by somebody other than this business (a tax id). WEAK = a
-- resemblance. A column rather than a comment, so "a weak match never binds by itself" is queryable.
CREATE TYPE "EntityLinkStrength" AS ENUM ('STRONG', 'WEAK');

-- Who caused a LearningEvent.
CREATE TYPE "LearningEventActor" AS ENUM ('OWNER_USER', 'SYSTEM', 'INTEGRATION', 'UNKNOWN');

-- What the owner did about a collection reminder. Every value describes the OWNER'S action; none of
-- them claims anything about delivery, receipt or reading, because none of that is observed.
CREATE TYPE "CollectionActionType" AS ENUM ('SHARE_INITIATED', 'LINK_COPIED', 'MESSAGE_COPIED', 'WHATSAPP_OPENED');
CREATE TYPE "CollectionActionChannel" AS ENUM ('WHATSAPP', 'SYSTEM_SHARE', 'CLIPBOARD', 'UNKNOWN');

-- ============================================================
-- 2 · EntityLinkProposal — the identity substrate's missing half
--
-- Party and PartyResolutionClaim hold bindings that have been ESTABLISHED, and enforce one party
-- per subject. They have no room for "these two are probably the same", and should not: a probable
-- binding stored beside a certain one becomes a certain one the first time somebody writes a query
-- that forgets to check the confidence column.
-- ============================================================

CREATE TABLE "EntityLinkProposal" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "subjectType" "PartyRoleType" NOT NULL,
    "subjectId" INTEGER NOT NULL,
    "candidatePartyId" INTEGER NOT NULL,
    "signalType" "PartySignalType" NOT NULL,
    "signalValue" TEXT NOT NULL,
    "strength" "EntityLinkStrength" NOT NULL,
    "state" "EntityLinkState" NOT NULL DEFAULT 'PROPOSED',
    "decidedAt" TIMESTAMP(3),
    "decidedByUserId" INTEGER,
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EntityLinkProposal_pkey" PRIMARY KEY ("id")
);

-- One live proposal per (tenant, subject, candidate). Re-running the resolver refreshes a proposal
-- rather than breeding a new one beside it — and a pair the owner has already rejected cannot come
-- back tomorrow wearing a new id, which is what makes a rejection durable rather than cosmetic.
CREATE UNIQUE INDEX "EntityLinkProposal_businessId_subjectType_subjectId_candid_key"
  ON "EntityLinkProposal"("businessId", "subjectType", "subjectId", "candidatePartyId");
CREATE INDEX "EntityLinkProposal_businessId_state_idx" ON "EntityLinkProposal"("businessId", "state");
CREATE INDEX "EntityLinkProposal_businessId_candidatePartyId_idx" ON "EntityLinkProposal"("businessId", "candidatePartyId");

ALTER TABLE "EntityLinkProposal" ADD CONSTRAINT "EntityLinkProposal_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EntityLinkProposal" ADD CONSTRAINT "EntityLinkProposal_candidatePartyId_fkey"
  FOREIGN KEY ("candidatePartyId") REFERENCES "Party"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- 3 · CollectionAction — the first server-side trace that a reminder ever happened
--
-- Sharing and copying a payment reminder were pure browser actions: navigator.share, the clipboard,
-- a wa.me link. A reminder could go out thirty times and this database was byte-identical afterwards.
--
-- Append-only by construction: no updatedAt, no status, nothing to revise. An action either happened
-- or it did not, and a row that could be edited later would stop being evidence of it.
-- ============================================================

CREATE TABLE "CollectionAction" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "customerId" INTEGER,
    "paymentRequestId" INTEGER,
    "billingDocumentId" INTEGER,
    "actionType" "CollectionActionType" NOT NULL,
    "channel" "CollectionActionChannel" NOT NULL,
    "actorUserId" INTEGER,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectionAction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CollectionAction_businessId_occurredAt_idx" ON "CollectionAction"("businessId", "occurredAt");
CREATE INDEX "CollectionAction_businessId_customerId_occurredAt_idx" ON "CollectionAction"("businessId", "customerId", "occurredAt");
CREATE INDEX "CollectionAction_businessId_paymentRequestId_idx" ON "CollectionAction"("businessId", "paymentRequestId");

ALTER TABLE "CollectionAction" ADD CONSTRAINT "CollectionAction_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- customerId / paymentRequestId / billingDocumentId are deliberately NOT foreign keys.
-- An action is a record of something a person did at a moment in time; if the customer is later
-- deleted, the fact that a reminder went out that Tuesday did not stop being true, and a cascade
-- would quietly erase the evidence along with the subject. The ids are written by a session-scoped
-- route that has already verified each one belongs to this tenant.

-- ============================================================
-- 4 · NEW COLUMNS ON EXISTING TABLES — all nullable, all NULL on every historical row
-- ============================================================

-- WHO. The only generic tenant-scoped event bus in the system recorded no actor at all, and three of
-- its five writers had the user in hand and discarded it.
ALTER TABLE "LearningEvent" ADD COLUMN "actorUserId" INTEGER;
ALTER TABLE "LearningEvent" ADD COLUMN "actorType" "LearningEventActor";
CREATE INDEX "LearningEvent_businessId_actorType_idx" ON "LearningEvent"("businessId", "actorType");

-- WHY a match was refused. The rejection already recorded who and when.
ALTER TABLE "InventoryPendingMatch" ADD COLUMN "rejectionReason" TEXT;

-- WHAT THE MACHINE ORIGINALLY SAID. Intake wrote its best match into matchedItemId / matchScore /
-- decision; approval then overwrote those same three columns with the owner's answer, leaving
-- agreement and correction byte-identical afterwards. These three are written once, at intake, and
-- never touched again — which is the whole point.
ALTER TABLE "SupplierPurchaseDraftLine" ADD COLUMN "suggestedItemId" INTEGER;
ALTER TABLE "SupplierPurchaseDraftLine" ADD COLUMN "suggestedMatchScore" DOUBLE PRECISION;
ALTER TABLE "SupplierPurchaseDraftLine" ADD COLUMN "suggestedDecision" "SupplierLineDecision";

-- Per-customer payment terms. NOT a second source of truth: one precedence rule, owned by
-- payment-terms.ts — this customer, else the business default, else 30. NULL everywhere today, so
-- no invoice's due date changes when this ships.
ALTER TABLE "Customer" ADD COLUMN "paymentTermsDays" INTEGER;

-- ============================================================
-- 5 · TENANT ROW-LEVEL SECURITY for the two new tables
--
-- Same form as every tenant policy since wave 2. Both tables hold statements about one business —
-- who it might be dealing with, and whom it chased for money. There is no reading of either that is
-- safe to share.
-- ============================================================

ALTER TABLE "EntityLinkProposal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EntityLinkProposal" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w2_tenant ON "EntityLinkProposal";
CREATE POLICY p7w2_tenant ON "EntityLinkProposal"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

ALTER TABLE "CollectionAction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CollectionAction" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p7w2_tenant ON "CollectionAction";
CREATE POLICY p7w2_tenant ON "CollectionAction"
  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
  WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);

-- ============================================================
-- 6 · RUNTIME GRANTS, shipped with the definitions
--
-- A table whose privileges arrive separately from its definition is a table whose privileges can be
-- forgotten, and under a NOBYPASSRLS runtime the failure mode on reads is silence rather than an
-- error. Guarded on role existence so the migration is portable to a lab with no app roles.
--
-- CollectionAction gets no DELETE and no UPDATE: it is append-only, and the grant says so rather
-- than a comment saying so.
-- ============================================================

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "EntityLinkProposal" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "EntityLinkProposal_id_seq" TO app_runtime;
    GRANT SELECT, INSERT ON "CollectionAction" TO app_runtime;
    GRANT USAGE, SELECT ON SEQUENCE "CollectionAction_id_seq" TO app_runtime;
  END IF;
END
$do$;

-- ============================================================
-- 7 · RULE VERSIONS — governance rows, not application data
--
-- Every measure is pinned to a DerivationPolicyVersion, and the resolver is fail-closed: a rule whose
-- lineage is not registered refuses to write rather than producing an unversioned artifact. So the
-- lineages are created HERE, in a migration, where governed identities belong — not lazily at runtime
-- by a create-if-missing, which is precisely the fallback the resolver was built to refuse.
--
-- DOC-04 gets its own lineage for the first time. It shipped in M2 borrowing vendor-category, which
-- was expedient when it was the only measure in the system and wrong now that fourteen rules would
-- all be claiming to be versions of one policy. Its next derivation therefore writes to a new slot
-- and reconciles the old row to SUPERSEDED — which is exactly what that status is for.
--
-- Idempotent: re-applying inserts nothing.
-- ============================================================

INSERT INTO "DerivationPolicy" ("key", "name") VALUES
  ('documents-paperwork-lag',            'DOC-04 · paperwork filing lag'),
  ('documents-vendor-billing-cadence',   'DOC-02 · vendor billing cadence'),
  ('documents-vendor-amount-stability',  'DOC-05 · vendor amount stability'),
  ('documents-correction-rate',          'DOC-06 · extraction correction rate'),
  ('payables-payment-timing',            'AP-01 · payment timing'),
  ('payables-late-share',                'AP-03 · lateness tendency'),
  ('payables-payee-payment-timing',      'AP-04 · per-payee payment timing'),
  ('payables-payment-evidence-backing',  'AP-06 · payment evidence backing'),
  ('inventory-restock-interval',         'INV-02 · restock interval'),
  ('inventory-count-correction-share',   'INV-04 · stock count correction share'),
  ('inventory-stock-pressure',           'INV-05 · recurring stock pressure'),
  ('suppliers-purchase-cadence',         'SUPP-01 · purchase cadence'),
  ('suppliers-delivery-lag',             'SUPP-02 · delivery lead time'),
  ('suppliers-short-delivery-share',     'SUPP-03 · short delivery share')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "DerivationPolicyVersion" ("policyId", "version")
SELECT p."id", 'v1'
FROM "DerivationPolicy" p
WHERE p."key" IN (
  'documents-paperwork-lag', 'documents-vendor-billing-cadence', 'documents-vendor-amount-stability',
  'documents-correction-rate', 'payables-payment-timing', 'payables-late-share',
  'payables-payee-payment-timing', 'payables-payment-evidence-backing', 'inventory-restock-interval',
  'inventory-count-correction-share', 'inventory-stock-pressure', 'suppliers-purchase-cadence',
  'suppliers-delivery-lag', 'suppliers-short-delivery-share'
)
ON CONFLICT ("policyId", "version") DO NOTHING;
