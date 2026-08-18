-- Business Memory POLICY-2 · Policy identity revision + canonical bootstrap. Additive + governance.
-- Two parts:
--   (1) SCHEMA REVISION: add a stable, unique, GOVERNED LINEAGE IDENTITY `key` to DerivationPolicy, so a
--       future resolver can findUnique(key) deterministically. `name` stays a human descriptor (unchanged,
--       still non-unique). `key` is NOT the DB id and carries no precedence/currentness.
--   (2) CANONICAL BOOTSTRAP: seed EXACTLY one lineage (vendor-category) + one version (v1), where v1
--       identifies the already-merged IMPL-3 candidate-set semantics. No other policy, no future version.
--
-- Safety: `ADD COLUMN "key" ... NOT NULL` (no default) succeeds on the EMPTY registry and FAILS-CLOSED if
-- any unexpected row exists (whole migration rolls back — no partial state). The Version insert resolves
-- its policyId via a subquery on `key` — the autoincrement id is NEVER written as a governed identity.
-- No ALTER/DROP of other tables, no VendorLearning/Claim/ReviewEvent/RIA mutation, no runtime activation.

-- AlterTable  (schema revision — reproduced exactly by `prisma migrate diff`)
ALTER TABLE "DerivationPolicy" ADD COLUMN     "key" TEXT NOT NULL;

-- CreateIndex  (governed lineage identity is unique)
CREATE UNIQUE INDEX "DerivationPolicy_key_key" ON "DerivationPolicy"("key");

-- Bootstrap: canonical lineage (data — NOT emitted by migrate diff; audited manually).
INSERT INTO "DerivationPolicy" ("key", "name", "createdAt")
VALUES ('vendor-category', 'vendor-category', CURRENT_TIMESTAMP);

-- Bootstrap: canonical version v1, linked by resolving the lineage id via its governed key (no hardcoded id).
INSERT INTO "DerivationPolicyVersion" ("policyId", "version", "createdAt")
SELECT "id", 'v1', CURRENT_TIMESTAMP
FROM "DerivationPolicy"
WHERE "key" = 'vendor-category';
