-- Business Memory · SHADOW-VERIFY-1 · Production Derived Claim read-only evidence.
--
-- Purpose: after a controlled Shadow execution, prove that a real Derived Claim was materialized in
-- Production for a KNOWN (businessId, vendor subjectNormalizedKey) under vendor-category/v1 — as
-- OPERATIONAL EVIDENCE, not a product Claim read path.
--
-- SELECT-only. Wrapped in a READ ONLY transaction that ROLLBACKs; session read-only; statement
-- timeout. A CI static guard rejects any write keyword before this ever reaches the database.
--
-- Parameters (psql --set, BOUND — never string-concatenated, so no SQL injection):
--   :businessId            (integer; validated numeric in the workflow before binding)
--   :subjectNormalizedKey  (text; the normalized vendor key — used ONLY as a WHERE predicate, and is
--                           deliberately NOT selected back into the output to avoid re-emitting it)
-- Every query is scoped to the exact businessId + subjectDomain='vendor' + subjectNormalizedKey; a
-- wrong/absent tenant+subject returns zero rows. No cross-tenant fallback.

SET statement_timeout = '30s';
SET default_transaction_read_only = on;
BEGIN TRANSACTION READ ONLY;

\echo '== Q0: policy identity vendor-category/v1 present =='
SELECT p.id AS policy_id, p.key AS policy_key, v.id AS policy_version_id, v.version AS version_label
FROM "DerivationPolicy" p
JOIN "DerivationPolicyVersion" v ON v."policyId" = p.id
WHERE p.key = 'vendor-category' AND v.version = 'v1';

\echo '== Q1: DerivedClaimProjection for (businessId, vendor, subjectNormalizedKey) — subject key NOT echoed =='
SELECT id AS projection_id, "businessId", "subjectDomain", "claimType",
       "policyVersionId", "evidenceSetFingerprint", "materializedAt"
FROM "DerivedClaimProjection"
WHERE "businessId" = (:'businessId')::int
  AND "subjectDomain" = 'vendor'
  AND "subjectNormalizedKey" = :'subjectNormalizedKey'
  AND "claimType" = 'vendor-category';

\echo '== Q2: candidate propositions + supporting evidence-link counts (references only) =='
SELECT c.id AS candidate_id, c."propositionValue" AS proposition_value, COUNT(l.id) AS evidence_link_count
FROM "DerivedClaimCandidate" c
JOIN "DerivedClaimProjection" pr ON pr.id = c."projectionId"
LEFT JOIN "DerivedClaimEvidenceLink" l ON l."candidateId" = c.id
WHERE pr."businessId" = (:'businessId')::int
  AND pr."subjectDomain" = 'vendor'
  AND pr."subjectNormalizedKey" = :'subjectNormalizedKey'
  AND pr."claimType" = 'vendor-category'
GROUP BY c.id, c."propositionValue"
ORDER BY c."propositionValue";

\echo '== Q3: evidence links (kind + record id + tenant) — references only, no payload =='
SELECT l."evidenceKind" AS evidence_kind, l."evidenceRecordId" AS evidence_record_id, l."businessId"
FROM "DerivedClaimEvidenceLink" l
JOIN "DerivedClaimCandidate" c ON c.id = l."candidateId"
JOIN "DerivedClaimProjection" pr ON pr.id = c."projectionId"
WHERE pr."businessId" = (:'businessId')::int
  AND pr."subjectDomain" = 'vendor'
  AND pr."subjectNormalizedKey" = :'subjectNormalizedKey'
  AND pr."claimType" = 'vendor-category'
ORDER BY l."evidenceKind", l."evidenceRecordId";

ROLLBACK;
