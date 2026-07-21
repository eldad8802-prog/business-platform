-- S4-P3A.2 PurchaseOrder Backfill Audit — READ-ONLY evidence.
-- SELECT-only. Deterministic. Redacted (businessId / supplierName / PO id are
-- md5-hashed; no full names, tax ids, phones, addresses, amounts or commercial
-- content are ever selected). Runs inside a READ ONLY transaction.
--
-- Canonicalization used for classification (meaning-preserving ONLY):
--   btrim  ->  collapse internal whitespace  ->  lower
-- Unicode NFC is intentionally OMITTED: normalize(text, NFC) could not be
-- verified as available on the target DB, so per policy no new function is used.
-- The repo aggressive normalizeForMatch (strips suffixes/punctuation) is NOT used
-- for backfill-eligible classification.

BEGIN TRANSACTION READ ONLY;

SET LOCAL statement_timeout = '120s';

-- ===================================================================
-- Section 0 — context
-- ===================================================================
SELECT 'S4-P3A.2 PurchaseOrder Backfill Audit' AS audit, now() AS run_at, current_database() AS db;

-- ===================================================================
-- Section 1 — Summary
-- ===================================================================
SELECT
  (SELECT count(*) FROM "PurchaseOrder")                                                                          AS total_purchase_orders,
  (SELECT count(*) FROM "PurchaseOrder" WHERE "supplierId" IS NOT NULL)                                           AS linked,
  (SELECT count(*) FROM "PurchaseOrder" WHERE "supplierId" IS NULL)                                               AS null_supplier_id,
  (SELECT count(*) FROM "PurchaseOrder" WHERE "supplierId" IS NULL AND btrim(coalesce("supplierName", '')) <> '') AS candidates_with_name,
  (SELECT count(*) FROM "PurchaseOrder" WHERE "supplierId" IS NULL AND btrim(coalesce("supplierName", '')) = '')  AS null_or_empty_name,
  (SELECT count(*) FROM "Supplier")                                                                               AS total_suppliers,
  (SELECT count(DISTINCT "businessId") FROM "PurchaseOrder")                                                      AS businesses_with_pos;

-- ===================================================================
-- Section 2 — Classification counts (mutually exclusive; sum == total POs)
-- Precedence: linked (conflict > drift > already) ; then invalid ; exact ;
-- canonical ; ambiguous ; unmatched.
-- ===================================================================
WITH sup AS (
  SELECT id, "businessId", name, lower(regexp_replace(btrim(name), '\s+', ' ', 'g')) AS canon
  FROM "Supplier"
),
po AS (
  SELECT id, "businessId", "supplierId", "supplierName",
         btrim(coalesce("supplierName", '')) AS trimmed,
         lower(regexp_replace(btrim(coalesce("supplierName", '')), '\s+', ' ', 'g')) AS pcanon
  FROM "PurchaseOrder"
),
cand AS (
  SELECT p.id, p."businessId", p.trimmed,
         (SELECT count(*) FROM sup s WHERE s."businessId" = p."businessId" AND s.name = p."supplierName") AS exact_n,
         (SELECT count(*) FROM sup s WHERE s."businessId" = p."businessId" AND s.canon = p.pcanon)         AS canon_n
  FROM po p WHERE p."supplierId" IS NULL
),
lnk AS (
  SELECT p.id, p."businessId", p."supplierName", s."businessId" AS sup_biz, s.name AS sup_name
  FROM po p JOIN sup s ON s.id = p."supplierId"
  WHERE p."supplierId" IS NOT NULL
),
classified AS (
  SELECT id, "businessId",
    CASE
      WHEN trimmed = ''                          THEN 'INVALID_OR_EMPTY_NAME'
      WHEN exact_n = 1                           THEN 'MATCH_EXACT_UNIQUE'
      WHEN exact_n = 0 AND canon_n = 1           THEN 'MATCH_CANONICAL_UNIQUE'
      WHEN exact_n > 1 OR canon_n > 1            THEN 'AMBIGUOUS_MULTIPLE_SUPPLIERS'
      ELSE 'UNMATCHED_NO_SUPPLIER'
    END AS classification
  FROM cand
  UNION ALL
  SELECT id, "businessId",
    CASE
      WHEN sup_biz <> "businessId"                       THEN 'CONFLICTING_TENANT'
      WHEN sup_name IS DISTINCT FROM "supplierName"      THEN 'HISTORICAL_NAME_DRIFT'
      ELSE 'ALREADY_LINKED'
    END AS classification
  FROM lnk
)
SELECT classification, count(*) AS n FROM classified GROUP BY classification
UNION ALL
SELECT '_TOTAL_ (must equal total_purchase_orders)', count(*) FROM classified
ORDER BY 1;

-- ===================================================================
-- Section 3 — Tenant isolation check (expect zero)
-- Any linked PO whose supplier belongs to a DIFFERENT businessId.
-- ===================================================================
SELECT count(*) AS cross_tenant_linked_purchase_orders
FROM "PurchaseOrder" p JOIN "Supplier" s ON s.id = p."supplierId"
WHERE p."supplierId" IS NOT NULL AND s."businessId" <> p."businessId";

-- ===================================================================
-- Section 4 — Duplicate / colliding Suppliers (per tenant)
-- ===================================================================
WITH sup AS (
  SELECT "businessId", name, lower(regexp_replace(btrim(name), '\s+', ' ', 'g')) AS canon
  FROM "Supplier"
),
exact_dups AS (
  SELECT "businessId", name, count(*) AS c FROM sup GROUP BY "businessId", name HAVING count(*) > 1
),
canon_dups AS (
  SELECT "businessId", canon, count(*) AS c FROM sup GROUP BY "businessId", canon HAVING count(*) > 1
)
SELECT
  (SELECT count(*) FROM exact_dups)                    AS exact_duplicate_name_groups,
  (SELECT coalesce(sum(c), 0) FROM exact_dups)         AS suppliers_in_exact_dup_groups,
  (SELECT count(*) FROM canon_dups)                    AS canonical_collision_groups,
  (SELECT coalesce(sum(c), 0) FROM canon_dups)         AS suppliers_in_canonical_collision_groups;

-- ===================================================================
-- Section 5 — Backfill projection (candidates only)
-- ===================================================================
WITH sup AS (
  SELECT id, "businessId", name, lower(regexp_replace(btrim(name), '\s+', ' ', 'g')) AS canon FROM "Supplier"
),
po AS (
  SELECT id, "businessId", "supplierName",
         btrim(coalesce("supplierName", '')) AS trimmed,
         lower(regexp_replace(btrim(coalesce("supplierName", '')), '\s+', ' ', 'g')) AS pcanon
  FROM "PurchaseOrder" WHERE "supplierId" IS NULL
),
cand AS (
  SELECT p.trimmed,
         (SELECT count(*) FROM sup s WHERE s."businessId" = p."businessId" AND s.name = (SELECT "supplierName" FROM "PurchaseOrder" WHERE id = p.id)) AS exact_n,
         (SELECT count(*) FROM sup s WHERE s."businessId" = p."businessId" AND s.canon = p.pcanon) AS canon_n
  FROM po p
),
c AS (
  SELECT CASE
    WHEN trimmed = ''                THEN 'INVALID_OR_EMPTY_NAME'
    WHEN exact_n = 1                 THEN 'MATCH_EXACT_UNIQUE'
    WHEN exact_n = 0 AND canon_n = 1 THEN 'MATCH_CANONICAL_UNIQUE'
    WHEN exact_n > 1 OR canon_n > 1  THEN 'AMBIGUOUS_MULTIPLE_SUPPLIERS'
    ELSE 'UNMATCHED_NO_SUPPLIER'
  END AS classification
  FROM cand
)
SELECT
  count(*) FILTER (WHERE classification = 'MATCH_EXACT_UNIQUE')                                          AS eligible_exact_only,
  count(*) FILTER (WHERE classification IN ('MATCH_EXACT_UNIQUE', 'MATCH_CANONICAL_UNIQUE'))             AS eligible_exact_plus_canonical,
  count(*) FILTER (WHERE classification <> 'MATCH_EXACT_UNIQUE')                                         AS unresolved_after_exact_only,
  count(*) FILTER (WHERE classification NOT IN ('MATCH_EXACT_UNIQUE', 'MATCH_CANONICAL_UNIQUE'))         AS unresolved_after_exact_plus_canonical,
  count(*) FILTER (WHERE classification = 'AMBIGUOUS_MULTIPLE_SUPPLIERS')                                AS ambiguous_never_link,
  count(*) FILTER (WHERE classification = 'INVALID_OR_EMPTY_NAME')                                       AS invalid_never_link
FROM c;

-- ===================================================================
-- Section 6 — Per-business sanitized breakdown (businessId hashed)
-- ===================================================================
WITH sup AS (
  SELECT id, "businessId", name, lower(regexp_replace(btrim(name), '\s+', ' ', 'g')) AS canon FROM "Supplier"
),
po AS (
  SELECT id, "businessId", "supplierId", "supplierName",
         btrim(coalesce("supplierName", '')) AS trimmed,
         lower(regexp_replace(btrim(coalesce("supplierName", '')), '\s+', ' ', 'g')) AS pcanon
  FROM "PurchaseOrder"
),
classified AS (
  SELECT p."businessId",
    CASE
      WHEN p."supplierId" IS NOT NULL THEN 'LINKED'
      WHEN p.trimmed = '' THEN 'INVALID_OR_EMPTY_NAME'
      WHEN (SELECT count(*) FROM sup s WHERE s."businessId" = p."businessId" AND s.name = p."supplierName") = 1 THEN 'MATCH_EXACT_UNIQUE'
      WHEN (SELECT count(*) FROM sup s WHERE s."businessId" = p."businessId" AND s.name = p."supplierName") = 0
           AND (SELECT count(*) FROM sup s WHERE s."businessId" = p."businessId" AND s.canon = p.pcanon) = 1 THEN 'MATCH_CANONICAL_UNIQUE'
      WHEN (SELECT count(*) FROM sup s WHERE s."businessId" = p."businessId" AND s.name = p."supplierName") > 1
           OR (SELECT count(*) FROM sup s WHERE s."businessId" = p."businessId" AND s.canon = p.pcanon) > 1 THEN 'AMBIGUOUS_MULTIPLE_SUPPLIERS'
      ELSE 'UNMATCHED_NO_SUPPLIER'
    END AS classification
  FROM po p
)
SELECT left(md5("businessId"::text), 12) AS biz_hash,
  count(*)                                                              AS total,
  count(*) FILTER (WHERE classification = 'LINKED')                     AS linked,
  count(*) FILTER (WHERE classification = 'MATCH_EXACT_UNIQUE')         AS exact_unique,
  count(*) FILTER (WHERE classification = 'MATCH_CANONICAL_UNIQUE')     AS canonical_unique,
  count(*) FILTER (WHERE classification = 'AMBIGUOUS_MULTIPLE_SUPPLIERS') AS ambiguous,
  count(*) FILTER (WHERE classification = 'UNMATCHED_NO_SUPPLIER')      AS unmatched,
  count(*) FILTER (WHERE classification = 'INVALID_OR_EMPTY_NAME')      AS invalid
FROM classified GROUP BY "businessId" ORDER BY biz_hash;

-- ===================================================================
-- Section 7 — Sanitized samples (<=5 per classification; names hashed)
-- ===================================================================
WITH sup AS (
  SELECT id, "businessId", name, lower(regexp_replace(btrim(name), '\s+', ' ', 'g')) AS canon FROM "Supplier"
),
po AS (
  SELECT id, "businessId", "supplierId", "supplierName",
         btrim(coalesce("supplierName", '')) AS trimmed,
         lower(regexp_replace(btrim(coalesce("supplierName", '')), '\s+', ' ', 'g')) AS pcanon
  FROM "PurchaseOrder" WHERE "supplierId" IS NULL
),
cand AS (
  SELECT p.id, p."businessId", p."supplierName", p.trimmed,
         (SELECT count(*) FROM sup s WHERE s."businessId" = p."businessId" AND s.name = p."supplierName") AS exact_n,
         (SELECT count(*) FROM sup s WHERE s."businessId" = p."businessId" AND s.canon = p.pcanon)        AS canon_n
  FROM po p
),
c AS (
  SELECT id, "businessId", "supplierName",
    CASE
      WHEN trimmed = ''                THEN 'INVALID_OR_EMPTY_NAME'
      WHEN exact_n = 1                 THEN 'MATCH_EXACT_UNIQUE'
      WHEN exact_n = 0 AND canon_n = 1 THEN 'MATCH_CANONICAL_UNIQUE'
      WHEN exact_n > 1 OR canon_n > 1  THEN 'AMBIGUOUS_MULTIPLE_SUPPLIERS'
      ELSE 'UNMATCHED_NO_SUPPLIER'
    END AS classification,
    greatest(exact_n, canon_n) AS candidate_suppliers
  FROM cand
),
ranked AS (
  SELECT c.*, row_number() OVER (PARTITION BY classification ORDER BY id) AS rn FROM c
)
SELECT classification,
  left(md5("businessId"::text), 12)              AS biz_hash,
  left(md5(id::text), 12)                        AS po_hash,
  left(md5(coalesce("supplierName", '')), 12)    AS name_hash,
  candidate_suppliers
FROM ranked WHERE rn <= 5 ORDER BY classification, rn;

-- No COMMIT: the READ ONLY transaction is rolled back on session end.
