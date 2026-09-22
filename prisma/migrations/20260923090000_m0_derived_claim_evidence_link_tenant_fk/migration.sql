-- M0 · Tenant-Safe Knowledge Foundation — give the Claim evidence link a real tenant.
--
-- WHAT THIS FIXES
-- `DerivedClaimEvidenceLink.businessId` is the column this table's row-level security policy
-- (`p7w2_tenant`, added by 20260825150000_d2_p7_wave2_tenant_rls) evaluates:
--
--     "businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int
--
-- Until now that column carried no foreign key. The policy therefore trusted an integer that nothing
-- constrained: a writer defect could stamp a non-existent tenant (an invisible orphan) or, worse, a
-- DIFFERENT real tenant — and the row would then satisfy the policy for THAT tenant. The application
-- already enforces same-tenant consistency in `claim-writer.validate.ts`, but an application invariant
-- and a database invariant are not the same guarantee, and this table's security depends on the latter.
--
-- EXPAND-ONLY / SAFE
-- Adding a FOREIGN KEY constraint is additive: no column is added, dropped or rewritten, and no data is
-- transformed. Postgres validates existing rows once at ADD CONSTRAINT time; any row pointing at a
-- missing Business would abort this migration rather than be silently dropped — which is the correct
-- failure, because such a row is exactly the corruption this constraint exists to prevent.
--
-- ON DELETE CASCADE mirrors `DerivedClaimProjection_businessId_fkey` and gives the link a direct erasure
-- path, instead of depending solely on the candidate → projection chain.
--
-- The lookup this constraint needs is already served by the existing
-- `DerivedClaimEvidenceLink_businessId_evidenceKind_evidenceRecordId_idx` (businessId leftmost), so no
-- new index is created.

-- AddForeignKey
ALTER TABLE "DerivedClaimEvidenceLink"
  ADD CONSTRAINT "DerivedClaimEvidenceLink_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
