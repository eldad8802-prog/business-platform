-- ============================================================================
-- closed-loop-gate-c-eligibility.sql
--
-- Read-only Production AUDIT before Gate C (Closed Loop Activation): would a manual
-- derive, right now, NATURALLY issue a new recommendation version (with its
-- evidence captured at issue) for an enrolled business, under the EXISTING
-- generator and memory rules? Nothing is changed, nothing is assumed.
--
-- It mirrors, in SQL, exactly what the generator sees and decides:
--   * payables: the overdue facts are the 10 oldest SCHEDULED installments past
--     due and not covered by live allocations (reversedAt null, payment RECORDED),
--     severity by Jerusalem calendar days late: <7 MEDIUM, 7-29 HIGH, >=30 CRITICAL;
--   * documents: a backlog of needs_review documents, at least 3;
--   * memory (planRecommendations): no prior version = NEW; ACTIVE + same
--     severity = deduped; ACTIVE + higher severity = MATERIAL_CHANGE (supersede);
--     ACTIVE past validUntil = EXPIRED then the no-decision 30-day cooldown;
--     documents material change = fresh targets >= max(3, ceil(50% of prior)).
--
-- Business ids never reach the public log: the legend names the businesses
-- (the enrolled set is checked as a flag), the rows carry flags and counts only.
-- OUTPUT: n | flag | observed_count. Guard-clean: no write keyword anywhere.
-- ============================================================================

\echo '== Closed loop Gate C eligibility: legend (n -> line) =='
\echo ' 1 knowledge_derivation ENABLED set is exactly businesses {3, 9} (flag)'
\echo ' 2 owner_recommendations: feature-access rows, any business (count)'
\echo ' 3 OutcomeRecommendationEvidence rows (count)'
\echo ' 4 OutcomeDecision rows (count)'
\echo ' 5 OutcomeRecommendation rows, all businesses (count)'
\echo '--- business 3 ---'
\echo '10 B3 is active (no deletion) (flag)'
\echo '11 B3 overdue unpaid installments, all (count)'
\echo '12 B3 overdue facts the generator sees (10 oldest) (count)'
\echo '13 B3 ...with NO recommendation ever for that installment = NEW candidate (count)'
\echo '14 B3 ...with an ACTIVE version, severity now HIGHER than issued = MATERIAL_CHANGE (count)'
\echo '15 B3 ...with an ACTIVE version, same severity, still valid = deduped (count)'
\echo '16 B3 ...with an ACTIVE version already past validUntil = will EXPIRE, then cooldown (count)'
\echo '17 B3 ...whose latest version is closed (cooldown / decision rules apply) (count)'
\echo '18 B3 documents needs_review (count)'
\echo '19 B3 a review-backlog recommendation was ever issued (flag)'
\echo '20 B3 review backlog: NEW candidate (>=3 waiting, never issued) (flag)'
\echo '21 B3 review backlog: ACTIVE version exists (flag)'
\echo '22 B3 review backlog: waiting documents NOT in the ACTIVE version targets (count)'
\echo '23 B3 review backlog: MATERIAL_CHANGE (fresh >= max(3, half of prior targets)) (flag)'
\echo '24 B3 hours since last SUCCEEDED derive run (count; null = never)'
\echo '25 B3 days until the earliest ACTIVE version reaches validUntil (count; negative = past)'
\echo '--- business 9 ---'
\echo '30 B9 is active (no deletion) (flag)'
\echo '31 B9 overdue unpaid installments, all (count)'
\echo '32 B9 overdue facts the generator sees (10 oldest) (count)'
\echo '33 B9 ...with NO recommendation ever for that installment = NEW candidate (count)'
\echo '34 B9 ...with an ACTIVE version, severity now HIGHER than issued = MATERIAL_CHANGE (count)'
\echo '35 B9 ...with an ACTIVE version, same severity, still valid = deduped (count)'
\echo '36 B9 ...with an ACTIVE version already past validUntil = will EXPIRE, then cooldown (count)'
\echo '37 B9 ...whose latest version is closed (cooldown / decision rules apply) (count)'
\echo '38 B9 documents needs_review (count)'
\echo '39 B9 a review-backlog recommendation was ever issued (flag)'
\echo '40 B9 review backlog: NEW candidate (>=3 waiting, never issued) (flag)'
\echo '41 B9 review backlog: ACTIVE version exists (flag)'
\echo '42 B9 review backlog: waiting documents NOT in the ACTIVE version targets (count)'
\echo '43 B9 review backlog: MATERIAL_CHANGE (fresh >= max(3, half of prior targets)) (flag)'
\echo '44 B9 hours since last SUCCEEDED derive run (count; null = never)'
\echo '45 B9 days until the earliest ACTIVE version reaches validUntil (count; negative = past)'

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';

WITH
today AS (SELECT (now() AT TIME ZONE 'Asia/Jerusalem')::date AS d),
enrolled AS (SELECT a."businessId" FROM "BusinessFeatureAccess" a
             WHERE a."featureKey" = 'knowledge_derivation' AND a.state::text = 'ENABLED'),
overdue AS (
  SELECT i."businessId", i.id, i."dueAt",
         row_number() OVER (PARTITION BY i."businessId" ORDER BY i."dueAt", i.id) AS rk,
         ((SELECT d FROM today) - ((i."dueAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Jerusalem')::date) AS late
    FROM "Installment" i
   WHERE i.status::text = 'SCHEDULED' AND i."dueAt" < now()
     AND i."scheduledAmount" > 0.009 + coalesce((
           SELECT sum(al."allocatedAmount") FROM "PaymentAllocation" al JOIN "Payment" p ON p.id = al."paymentId"
            WHERE al."installmentId" = i.id AND al."reversedAt" IS NULL AND p.status::text = 'RECORDED'), 0)),
facts AS (SELECT o.*, CASE WHEN o.late >= 30 THEN 4 WHEN o.late >= 7 THEN 3 ELSE 2 END AS sev_now
            FROM overdue o WHERE o.rk <= 10),
sev(name, rk) AS (VALUES ('INFO', 0), ('LOW', 1), ('MEDIUM', 2), ('HIGH', 3), ('CRITICAL', 4)),
latest AS (
  SELECT DISTINCT ON (r."businessId", r."recommendationKey")
         r."businessId", r."recommendationKey", r.type, r.status::text AS status, r."validUntil", r.targets,
         coalesce((SELECT s.rk FROM sev s WHERE s.name = r.severity), -1) AS sev_then
    FROM "OutcomeRecommendation" r
   ORDER BY r."businessId", r."recommendationKey", r.version DESC),
inst AS (
  SELECT f."businessId", f.id, f.sev_now, l.status, l."validUntil", l.sev_then
    FROM facts f LEFT JOIN latest l
      ON l."businessId" = f."businessId" AND l."recommendationKey" = 'SETTLE_OVERDUE_INSTALLMENT:installment:' || f.id),
docs AS (SELECT d."businessId", d.id FROM "Document" d WHERE d.status = 'needs_review'),
docrec AS (SELECT l.* FROM latest l WHERE l.type = 'REVIEW_PENDING_DOCUMENTS'),
fresh AS (
  SELECT r."businessId",
         (SELECT count(*) FROM docs d WHERE d."businessId" = r."businessId"
             AND NOT (r.targets @> to_jsonb(d.id))) AS n_fresh,
         jsonb_array_length(r.targets) AS n_prior
    FROM docrec r WHERE r.status = 'ACTIVE'),
lastrun AS (SELECT r."businessId", max(r."finishedAt") AS t FROM "KnowledgeDerivationRun" r
            WHERE r.status::text = 'SUCCEEDED' GROUP BY r."businessId"),
per(b, base) AS (VALUES (3, 10), (9, 30)),
lines(n, flag, observed_count) AS (
            SELECT 1, (SELECT coalesce(array_agg("businessId" ORDER BY "businessId"), '{}') = ARRAY[3, 9] FROM enrolled), NULL::bigint
  UNION ALL SELECT 2, NULL, (SELECT count(*) FROM "BusinessFeatureAccess" WHERE "featureKey" = 'owner_recommendations')
  UNION ALL SELECT 3, NULL, (SELECT count(*) FROM "OutcomeRecommendationEvidence")
  UNION ALL SELECT 4, NULL, (SELECT count(*) FROM "OutcomeDecision")
  UNION ALL SELECT 5, NULL, (SELECT count(*) FROM "OutcomeRecommendation")
  UNION ALL SELECT p.base + 0, (SELECT bz."deletionRequestedAt" IS NULL AND bz."deletedAt" IS NULL FROM "Business" bz WHERE bz.id = p.b), NULL FROM per p
  UNION ALL SELECT p.base + 1, NULL, (SELECT count(*) FROM overdue o WHERE o."businessId" = p.b) FROM per p
  UNION ALL SELECT p.base + 2, NULL, (SELECT count(*) FROM facts f WHERE f."businessId" = p.b) FROM per p
  UNION ALL SELECT p.base + 3, NULL, (SELECT count(*) FROM inst x WHERE x."businessId" = p.b AND x.status IS NULL) FROM per p
  UNION ALL SELECT p.base + 4, NULL, (SELECT count(*) FROM inst x WHERE x."businessId" = p.b AND x.status = 'ACTIVE'
                                        AND x."validUntil" >= now() AND x.sev_now > x.sev_then) FROM per p
  UNION ALL SELECT p.base + 5, NULL, (SELECT count(*) FROM inst x WHERE x."businessId" = p.b AND x.status = 'ACTIVE'
                                        AND x."validUntil" >= now() AND x.sev_now <= x.sev_then) FROM per p
  UNION ALL SELECT p.base + 6, NULL, (SELECT count(*) FROM inst x WHERE x."businessId" = p.b AND x.status = 'ACTIVE' AND x."validUntil" < now()) FROM per p
  UNION ALL SELECT p.base + 7, NULL, (SELECT count(*) FROM inst x WHERE x."businessId" = p.b AND x.status IS NOT NULL AND x.status <> 'ACTIVE') FROM per p
  UNION ALL SELECT p.base + 8, NULL, (SELECT count(*) FROM docs d WHERE d."businessId" = p.b) FROM per p
  UNION ALL SELECT p.base + 9, EXISTS (SELECT 1 FROM docrec r WHERE r."businessId" = p.b), NULL FROM per p
  UNION ALL SELECT p.base + 10, (SELECT count(*) FROM docs d WHERE d."businessId" = p.b) >= 3
                                 AND NOT EXISTS (SELECT 1 FROM docrec r WHERE r."businessId" = p.b), NULL FROM per p
  UNION ALL SELECT p.base + 11, EXISTS (SELECT 1 FROM docrec r WHERE r."businessId" = p.b AND r.status = 'ACTIVE'), NULL FROM per p
  UNION ALL SELECT p.base + 12, NULL, (SELECT n_fresh FROM fresh f WHERE f."businessId" = p.b) FROM per p
  UNION ALL SELECT p.base + 13, (SELECT f.n_fresh >= greatest(3, ceil(f.n_prior * 0.5)) FROM fresh f WHERE f."businessId" = p.b), NULL FROM per p
  UNION ALL SELECT p.base + 14, NULL, (SELECT floor(extract(epoch FROM (now() - t)) / 3600)::bigint FROM lastrun l WHERE l."businessId" = p.b) FROM per p
  UNION ALL SELECT p.base + 15, NULL, (SELECT floor(extract(epoch FROM (min(r."validUntil") - now())) / 86400)::bigint
                                         FROM "OutcomeRecommendation" r WHERE r."businessId" = p.b AND r.status::text = 'ACTIVE') FROM per p
)
SELECT n, flag, observed_count FROM lines ORDER BY n;

ROLLBACK;
