-- Business Cost learning — per-business breakdown of what Wave 1 has written (read-only).
-- Assert-shaped only (the public Actions log redacts everything else): business_n is the business
-- id; every other cell is a boolean or a *_count integer. No titles, amounts or dates are printed.

\echo '== B1 per business: cost measures, COST-08 gate, eligibility, insights (businesses 3, 9, 38)'
WITH b(id) AS (VALUES (3), (9), (38)),
     m AS (SELECT * FROM "KnowledgeMeasure" WHERE "measureKey" IN ('payables.cost_data_completeness', 'payables.recurring_amount_change',
                                                                   'payables.new_material_commitment', 'payables.ended_commitment')),
     c AS (SELECT * FROM m WHERE "measureKey" = 'payables.cost_data_completeness'),
     i AS (SELECT * FROM "BusinessInsight" WHERE "insightKey" LIKE 'cost.%')
SELECT
  b.id AS business_n,
  (SELECT count(*) FROM m WHERE m."businessId" = b.id) AS measure_count,
  (SELECT count(*) FROM m WHERE m."businessId" = b.id AND m.status = 'ACTIVE') AS active_count,
  (SELECT count(*) FROM m WHERE m."businessId" = b.id AND m.status = 'INSUFFICIENT_EVIDENCE') AS insufficient_count,
  (SELECT count(*) FROM m WHERE m."businessId" = b.id AND m.status IN ('STALE', 'SUPERSEDED')) AS stale_or_superseded_count,
  (SELECT count(*) FROM c WHERE c."businessId" = b.id AND c.status = 'ACTIVE') AS completeness_active_count,
  (SELECT max(c."valueNumeric")::int FROM c WHERE c."businessId" = b.id AND c.status = 'ACTIVE') AS trustworthy_days_count,
  EXISTS (SELECT 1 FROM c WHERE c."businessId" = b.id AND c.detail -> 'gaps' ? 'UNALLOCATED_CASH') AS gap_unallocated_cash,
  EXISTS (SELECT 1 FROM c WHERE c."businessId" = b.id AND c.detail -> 'gaps' ? 'DUE_WITHOUT_RECORDED_PAYMENT') AS gap_due_without_payment,
  EXISTS (SELECT 1 FROM c WHERE c."businessId" = b.id AND c.detail -> 'gaps' ? 'ONE_OFF_COVERAGE_UNKNOWN') AS gap_one_off_unknown,
  EXISTS (SELECT 1 FROM c WHERE c."businessId" = b.id AND c.detail -> 'gaps' ? 'FOREIGN_CURRENCY_EXCLUDED') AS gap_foreign_currency,
  EXISTS (SELECT 1 FROM c WHERE c."businessId" = b.id AND c.detail -> 'gaps' ? 'BACKBONE_NOT_AFFIRMED') AS gap_backbone_not_affirmed,
  (SELECT bool_or((c.detail -> 'eligibility' -> 'COST-06' ->> 'eligible')::boolean) FROM c WHERE c."businessId" = b.id) AS pattern_cost06_eligible,
  (SELECT count(*) FROM m WHERE m."businessId" = b.id AND m."measureKey" = 'payables.recurring_amount_change' AND m.status = 'ACTIVE') AS amount_change_active_count,
  (SELECT count(*) FROM m WHERE m."businessId" = b.id AND m."measureKey" = 'payables.new_material_commitment' AND m.status = 'ACTIVE') AS new_material_active_count,
  (SELECT count(*) FROM m WHERE m."businessId" = b.id AND m."measureKey" = 'payables.new_material_commitment' AND m.detail ->> 'reason' = 'NO_PRIOR_BASELINE') AS new_material_no_prior_count,
  (SELECT count(*) FROM m WHERE m."businessId" = b.id AND m."measureKey" = 'payables.new_material_commitment' AND m.detail ->> 'reason' = 'PRIOR_BASELINE_NOT_RELIABLE') AS new_material_not_reliable_count,
  (SELECT count(*) FROM m WHERE m."businessId" = b.id AND m."measureKey" = 'payables.ended_commitment' AND m.status = 'ACTIVE') AS ended_active_count,
  (SELECT count(*) FROM i WHERE i."businessId" = b.id) AS insight_count,
  (SELECT count(*) FROM i WHERE i."businessId" = b.id AND i."insightKey" = 'cost.data_completeness') AS completeness_insight_count,
  (SELECT count(*) FROM i WHERE i."businessId" = b.id AND i."insightKey" = 'cost.recurring_amount_changed') AS amount_change_insight_count,
  (SELECT count(*) FROM i WHERE i."businessId" = b.id AND i."insightKey" = 'cost.new_material_commitment') AS new_commitment_insight_count,
  (SELECT count(*) FROM i WHERE i."businessId" = b.id AND i."insightKey" = 'cost.ended_commitment') AS ended_insight_count,
  (SELECT count(*) FROM i WHERE i."businessId" = b.id AND i.interpretation IS NOT NULL) AS interpretation_present_count,
  (SELECT count(*) FROM i WHERE i."businessId" = b.id AND jsonb_array_length(COALESCE(i."suggestedActions", '[]'::jsonb)) > 0) AS suggested_action_count,
  (SELECT count(*) FROM i WHERE i."businessId" = b.id AND i.status = 'OPEN') AS open_insight_count
FROM b ORDER BY b.id;

\echo '== B2 outside 3/9/38, and evidence ownership across every cost measure'
WITH m AS (SELECT * FROM "KnowledgeMeasure" WHERE "measureKey" IN ('payables.cost_data_completeness', 'payables.recurring_amount_change',
                                                                   'payables.new_material_commitment', 'payables.ended_commitment'))
SELECT
  (SELECT count(*) FROM m WHERE m."businessId" NOT IN (3, 9, 38)) AS other_business_measure_count,
  (SELECT count(*) FROM "BusinessInsight" WHERE "insightKey" LIKE 'cost.%' AND "businessId" NOT IN (3, 9, 38)) AS other_business_insight_count,
  (SELECT count(*) FROM "KnowledgeMeasureEvidenceLink" l JOIN m ON m.id = l."measureId") AS evidence_link_count,
  (SELECT count(*) FROM "KnowledgeMeasureEvidenceLink" l JOIN m ON m.id = l."measureId"
    WHERE l."businessId" <> m."businessId"
       OR (l."evidenceKind" = 'installment' AND NOT EXISTS (SELECT 1 FROM "Installment" x WHERE x.id = l."evidenceRecordId" AND x."businessId" = m."businessId"))
       OR (l."evidenceKind" = 'payment' AND NOT EXISTS (SELECT 1 FROM "Payment" x WHERE x.id = l."evidenceRecordId" AND x."businessId" = m."businessId"))
       OR (l."evidenceKind" = 'payables-audit-event' AND NOT EXISTS (SELECT 1 FROM "PayablesAuditEvent" x WHERE x.id = l."evidenceRecordId" AND x."businessId" = m."businessId"))
       OR (l."evidenceKind" = 'commitment' AND NOT EXISTS (SELECT 1 FROM "Commitment" x WHERE x.id = l."evidenceRecordId" AND x."businessId" = m."businessId"))
       OR l."evidenceKind" NOT IN ('installment', 'payment', 'payables-audit-event', 'commitment')) AS foreign_or_unknown_evidence_count,
  (SELECT count(*) FROM (SELECT "businessId", "dedupeKey" FROM "BusinessInsight" WHERE "insightKey" LIKE 'cost.%'
                          GROUP BY 1, 2 HAVING count(*) > 1) d) AS duplicate_insight_count;
