-- ============================================================================
-- sec-p1-business-offering-production-evidence.sql
--
-- Read-only catalog proof that migration
--   20260928120000_p1_business_offering   (main revision a99e277)
-- is in force on this database with exactly its intended security properties.
--
-- Output: one row per assertion: check, PASS/FAIL, and (on FAIL only) a detail
-- made of catalog identifiers (table, column, constraint, index, policy, type
-- or role names, privilege letters).
--
-- NO DATA ROWS ARE READ. Every query reads the system catalog (pg_class,
-- pg_attribute, pg_attrdef, pg_constraint, pg_index, pg_policy, pg_type,
-- pg_enum, pg_trigger, pg_roles, relacl) or the migration ledger
-- (_prisma_migrations). No business row, name, amount or key is selected.
--
-- Scope: the three new tables BusinessServiceAsset, InventoryItemAsset and
-- OfferingDemandSignal (columns, FKs with their ON DEL / ON UPD actions,
-- indexes, RLS, the exact policy set, effective privileges on the tables and
-- their id sequences), plus every other object the migration adds: the five
-- enum types, the new columns / CHECK constraints / unique indexes / FK on the
-- existing tables BusinessService, InventoryItem, BusinessAsset, Appointment.
-- The migration defines no function and no trigger; Q12 proves no trigger was
-- attached to the new tables.
--
-- Privilege letters (aclitem): r=read a=append w=upd d=del D=trunc x=refs
-- t=trigger m=maintain U=usage. Grantee names are resolved through aclexplode()
-- (OIDs), never by splitting the aclitem text, so a quoted role name cannot
-- shift the parse. Privilege checks are EFFECTIVE: a privilege reached through
-- role membership (INHERIT) or PUBLIC counts, and every role whose name starts
-- with app_ is inspected, group AND login roles, plus every non-superuser LOGIN
-- role that inherits app_runtime.
--
-- Guard-clean: a CI guard rejects this file if it contains any write keyword,
-- prose included, so the wording deliberately avoids those words.
-- ============================================================================

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

WITH
new_tables(tbl) AS (
  VALUES ('BusinessServiceAsset'), ('InventoryItemAsset'), ('OfferingDemandSignal')
),
tenant_expr(e) AS (
  -- The tenant predicate exactly as PostgreSQL deparses the migration text.
  VALUES ('("businessId" = (NULLIF(current_setting(''app.current_business_id''::text, true), ''''::text))::integer)')
),
expected_enums(typ, labels) AS (
  VALUES
    ('ServicePriceMode',         'FIXED,FROM,RANGE,QUOTE_REQUIRED,NO_PUBLIC_PRICE'),
    ('ServiceFulfillment',       'AT_BUSINESS,AT_CUSTOMER,ONLINE,UNSPECIFIED'),
    ('OfferingKind',             'PRODUCT,SERVICE'),
    ('OfferingDemandSignalType', 'PRICE,AVAILABILITY,BOOKING,PURCHASE'),
    ('OfferingDemandSource',     'APPOINTMENT,SALE')
),
actual_enums AS (
  SELECT t.typname AS typ, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS labels
  FROM pg_type t
  JOIN pg_namespace n ON n.oid = t.typnamespace AND n.nspname = 'public'
  JOIN pg_enum e ON e.enumtypid = t.oid
  WHERE t.typtype = 'e' AND t.typname IN (SELECT typ FROM expected_enums)
  GROUP BY t.typname
),
expected_cols(tbl, col, typ, nn, def) AS (
  -- def: NULL = no default; 'serial' = default draws from the owned
  -- <table>_id_seq sequence; otherwise the exact deparsed default.
  VALUES
    ('BusinessServiceAsset', 'id',                'integer',                     true,  'serial'),
    ('BusinessServiceAsset', 'businessId',        'integer',                     true,  NULL),
    ('BusinessServiceAsset', 'businessServiceId', 'integer',                     true,  NULL),
    ('BusinessServiceAsset', 'businessAssetId',   'integer',                     true,  NULL),
    ('BusinessServiceAsset', 'createdAt',         'timestamp(3) without time zone', true, 'CURRENT_TIMESTAMP'),
    ('InventoryItemAsset',   'id',                'integer',                     true,  'serial'),
    ('InventoryItemAsset',   'businessId',        'integer',                     true,  NULL),
    ('InventoryItemAsset',   'inventoryItemId',   'integer',                     true,  NULL),
    ('InventoryItemAsset',   'businessAssetId',   'integer',                     true,  NULL),
    ('InventoryItemAsset',   'createdAt',         'timestamp(3) without time zone', true, 'CURRENT_TIMESTAMP'),
    ('OfferingDemandSignal', 'id',                'integer',                     true,  'serial'),
    ('OfferingDemandSignal', 'businessId',        'integer',                     true,  NULL),
    ('OfferingDemandSignal', 'offeringKind',      '"OfferingKind"',              true,  NULL),
    ('OfferingDemandSignal', 'businessServiceId', 'integer',                     false, NULL),
    ('OfferingDemandSignal', 'inventoryItemId',   'integer',                     false, NULL),
    ('OfferingDemandSignal', 'appointmentId',     'integer',                     false, NULL),
    ('OfferingDemandSignal', 'saleLineId',        'integer',                     false, NULL),
    ('OfferingDemandSignal', 'signalType',        '"OfferingDemandSignalType"',  true,  NULL),
    ('OfferingDemandSignal', 'source',            '"OfferingDemandSource"',      true,  NULL),
    ('OfferingDemandSignal', 'idempotencyKey',    'text',                        true,  NULL),
    ('OfferingDemandSignal', 'createdAt',         'timestamp(3) without time zone', true, 'CURRENT_TIMESTAMP'),
    -- columns the migration adds to existing tables
    ('BusinessService',      'priceMode',         '"ServicePriceMode"',          false, NULL),
    ('BusinessService',      'priceAmount',       'numeric(18,2)',               false, NULL),
    ('BusinessService',      'priceMax',          'numeric(18,2)',               false, NULL),
    ('BusinessService',      'durationMinutes',   'integer',                     false, NULL),
    ('BusinessService',      'categoryLabel',     'text',                        false, NULL),
    ('BusinessService',      'featuredByOwner',   'boolean',                     true,  'false'),
    ('BusinessService',      'fulfillment',       '"ServiceFulfillment"',        true,  '''UNSPECIFIED''::"ServiceFulfillment"'),
    ('InventoryItem',        'description',       'text',                        false, NULL),
    ('InventoryItem',        'featuredByOwner',   'boolean',                     true,  'false'),
    ('Appointment',          'businessServiceId', 'integer',                     false, NULL)
),
actual_cols AS (
  SELECT c.relname AS tbl, a.attname AS col, format_type(a.atttypid, a.atttypmod) AS typ,
         a.attnotnull AS nn, pg_get_expr(d.adbin, d.adrelid) AS def,
         pg_get_serial_sequence(format('%I', c.relname), a.attname) AS serial_seq
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attnum > 0 AND NOT a.attisdropped
    AND c.relname IN ('BusinessServiceAsset','InventoryItemAsset','OfferingDemandSignal',
                      'BusinessService','InventoryItem','Appointment')
),
col_match AS (
  SELECT e.tbl, e.col,
         EXISTS (SELECT 1 FROM actual_cols a
                  WHERE a.tbl = e.tbl AND a.col = e.col AND a.typ = e.typ AND a.nn = e.nn
                    AND CASE
                          WHEN e.def IS NULL THEN a.def IS NULL
                          WHEN e.def = 'serial' THEN a.serial_seq = format('public.%I', e.tbl || '_id_seq')
                                                    AND position(format('%I', e.tbl || '_id_seq') IN coalesce(a.def, '')) > 0
                          ELSE a.def = e.def
                        END) AS ok
  FROM expected_cols e
),
expected_fks(tbl, conname, cols, reftbl, refcols, del, upd) AS (
  -- confdeltype / confupdtype: a=no action r=restrict c=cascade n=set null d=set default
  VALUES
    ('BusinessServiceAsset', 'BusinessServiceAsset_businessId_fkey',                 'businessId',                   'Business',          'id',            'c', 'c'),
    ('BusinessServiceAsset', 'BusinessServiceAsset_businessServiceId_businessId_fkey', 'businessServiceId,businessId', 'BusinessService',   'id,businessId', 'c', 'c'),
    ('BusinessServiceAsset', 'BusinessServiceAsset_businessAssetId_businessId_fkey', 'businessAssetId,businessId',   'BusinessAsset',     'id,businessId', 'c', 'c'),
    ('InventoryItemAsset',   'InventoryItemAsset_businessId_fkey',                   'businessId',                   'Business',          'id',            'c', 'c'),
    ('InventoryItemAsset',   'InventoryItemAsset_inventoryItemId_businessId_fkey',   'inventoryItemId,businessId',   'InventoryItem',     'id,businessId', 'c', 'c'),
    ('InventoryItemAsset',   'InventoryItemAsset_businessAssetId_businessId_fkey',   'businessAssetId,businessId',   'BusinessAsset',     'id,businessId', 'c', 'c'),
    ('OfferingDemandSignal', 'OfferingDemandSignal_businessId_fkey',                 'businessId',                   'Business',          'id',            'c', 'c'),
    ('OfferingDemandSignal', 'OfferingDemandSignal_businessServiceId_businessId_fkey', 'businessServiceId,businessId', 'BusinessService', 'id,businessId', 'r', 'c'),
    ('OfferingDemandSignal', 'OfferingDemandSignal_inventoryItemId_businessId_fkey', 'inventoryItemId,businessId',   'InventoryItem',     'id,businessId', 'r', 'c'),
    ('OfferingDemandSignal', 'OfferingDemandSignal_appointmentId_businessId_fkey',   'appointmentId,businessId',     'Appointment',       'id,businessId', 'r', 'c'),
    ('OfferingDemandSignal', 'OfferingDemandSignal_saleLineId_businessId_fkey',      'saleLineId,businessId',        'InventorySaleLine', 'id,businessId', 'r', 'c'),
    ('Appointment',          'Appointment_businessServiceId_businessId_fkey',        'businessServiceId,businessId', 'BusinessService',   'id,businessId', 'r', 'c')
),
actual_fks AS (
  SELECT c.relname AS tbl, k.conname,
         (SELECT string_agg(a.attname, ',' ORDER BY x.ord) FROM unnest(k.conkey) WITH ORDINALITY x(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = x.attnum) AS cols,
         p.relname AS reftbl,
         (SELECT string_agg(a.attname, ',' ORDER BY x.ord) FROM unnest(k.confkey) WITH ORDINALITY x(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = x.attnum) AS refcols,
         k.confdeltype::text AS del, k.confupdtype::text AS upd, k.convalidated
  FROM pg_constraint k
  JOIN pg_class c ON c.oid = k.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  JOIN pg_class p ON p.oid = k.confrelid
  WHERE k.contype = 'f'
    AND (c.relname IN (SELECT tbl FROM new_tables)
         OR k.conname = 'Appointment_businessServiceId_businessId_fkey')
),
expected_checks(tbl, conname, cols) AS (
  -- cols: the columns the CHECK reads, sorted (C collation).
  VALUES
    ('BusinessService',      'BusinessService_price_semantics',   'priceAmount,priceMax,priceMode'),
    ('BusinessService',      'BusinessService_duration_positive', 'durationMinutes'),
    ('BusinessService',      'BusinessService_category_label',    'categoryLabel'),
    ('OfferingDemandSignal', 'OfferingDemandSignal_one_offering', 'businessServiceId,inventoryItemId,offeringKind'),
    ('OfferingDemandSignal', 'OfferingDemandSignal_identity',     'appointmentId,offeringKind,saleLineId,signalType,source')
),
actual_checks AS (
  SELECT c.relname AS tbl, k.conname, k.convalidated,
         (SELECT string_agg(a.attname COLLATE "C", ',' ORDER BY a.attname COLLATE "C") FROM unnest(k.conkey) x(attnum)
            JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = x.attnum) AS cols
  FROM pg_constraint k
  JOIN pg_class c ON c.oid = k.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  WHERE k.contype = 'c'
    AND (c.relname IN (SELECT tbl FROM new_tables)
         OR k.conname IN (SELECT conname FROM expected_checks))
),
expected_idx(tbl, idx, uniq, prim, cols) AS (
  VALUES
    ('BusinessServiceAsset', 'BusinessServiceAsset_pkey',                                  true,  true,  'id'),
    ('BusinessServiceAsset', 'BusinessServiceAsset_businessServiceId_businessAssetId_key', true,  false, 'businessServiceId,businessAssetId'),
    ('BusinessServiceAsset', 'BusinessServiceAsset_businessId_idx',                        false, false, 'businessId'),
    ('InventoryItemAsset',   'InventoryItemAsset_pkey',                                    true,  true,  'id'),
    ('InventoryItemAsset',   'InventoryItemAsset_inventoryItemId_businessAssetId_key',     true,  false, 'inventoryItemId,businessAssetId'),
    ('InventoryItemAsset',   'InventoryItemAsset_businessId_idx',                          false, false, 'businessId'),
    ('OfferingDemandSignal', 'OfferingDemandSignal_pkey',                                  true,  true,  'id'),
    ('OfferingDemandSignal', 'OfferingDemandSignal_businessId_idempotencyKey_key',         true,  false, 'businessId,idempotencyKey'),
    ('OfferingDemandSignal', 'OfferingDemandSignal_businessId_offeringKind_createdAt_idx', false, false, 'businessId,offeringKind,createdAt'),
    ('OfferingDemandSignal', 'OfferingDemandSignal_businessId_businessServiceId_idx',      false, false, 'businessId,businessServiceId'),
    ('OfferingDemandSignal', 'OfferingDemandSignal_businessId_inventoryItemId_idx',        false, false, 'businessId,inventoryItemId'),
    -- indexes the migration adds to existing tables
    ('BusinessService',      'BusinessService_id_businessId_key',                          true,  false, 'id,businessId'),
    ('BusinessService',      'BusinessService_businessId_active_idx',                      false, false, 'businessId,active'),
    ('BusinessAsset',        'BusinessAsset_id_businessId_key',                            true,  false, 'id,businessId'),
    ('Appointment',          'Appointment_id_businessId_key',                              true,  false, 'id,businessId')
),
actual_idx AS (
  -- Only plain, valid, ready btree indexes on columns (no predicate, no
  -- expression) can match an expected row.
  SELECT c.relname AS tbl, ic.relname AS idx, i.indisunique AS uniq, i.indisprimary AS prim,
         (SELECT string_agg(a.attname, ',' ORDER BY x.ord) FROM unnest(i.indkey::int2[]) WITH ORDINALITY x(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = x.attnum) AS cols,
         (i.indisvalid AND i.indisready AND i.indpred IS NULL AND i.indexprs IS NULL AND am.amname = 'btree') AS sound
  FROM pg_index i
  JOIN pg_class ic ON ic.oid = i.indexrelid
  JOIN pg_class c ON c.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  JOIN pg_am am ON am.oid = ic.relam
  WHERE c.relname IN (SELECT tbl FROM new_tables)
     OR ic.relname IN (SELECT idx FROM expected_idx)
),
expected_policies(tbl, pol, cmd, has_qual, has_check) AS (
  -- polcmd: r=SELECT a=INS w=UPD d=DEL *=ALL. All PERMISSIVE, role PUBLIC,
  -- every present expression is exactly the tenant predicate. No DEL, no ALL.
  VALUES
    ('BusinessServiceAsset', 'p1_service_asset_select',   'r', true,  false),
    ('BusinessServiceAsset', 'p1_service_asset_insert',   'a', false, true),
    ('BusinessServiceAsset', 'p1_service_asset_update',   'w', true,  true),
    ('InventoryItemAsset',   'p1_item_asset_select',      'r', true,  false),
    ('InventoryItemAsset',   'p1_item_asset_insert',      'a', false, true),
    ('InventoryItemAsset',   'p1_item_asset_update',      'w', true,  true),
    ('OfferingDemandSignal', 'p1_offering_demand_select', 'r', true,  false),
    ('OfferingDemandSignal', 'p1_offering_demand_insert', 'a', false, true),
    ('OfferingDemandSignal', 'p1_offering_demand_update', 'w', true,  true)
),
actual_policies AS (
  SELECT c.relname AS tbl, pol.polname AS pol, pol.polcmd::text AS cmd, pol.polpermissive AS permissive,
         (SELECT string_agg(CASE WHEN x = 0 THEN 'public' ELSE pg_get_userbyid(x)::text END, ',' ORDER BY 1)
            FROM unnest(pol.polroles) x) AS roles,
         pg_get_expr(pol.polqual, pol.polrelid) AS qual,
         pg_get_expr(pol.polwithcheck, pol.polrelid) AS wcheck
  FROM pg_policy pol
  JOIN pg_class c ON c.oid = pol.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  WHERE c.relname IN (SELECT tbl FROM new_tables)
),
policy_match AS (
  SELECT e.tbl, e.pol,
         EXISTS (SELECT 1 FROM actual_policies a, tenant_expr t
                  WHERE a.tbl = e.tbl AND a.pol = e.pol AND a.cmd = e.cmd AND a.permissive
                    AND a.roles = 'public'
                    AND CASE WHEN e.has_qual  THEN a.qual   = t.e ELSE a.qual   IS NULL END
                    AND CASE WHEN e.has_check THEN a.wcheck = t.e ELSE a.wcheck IS NULL END) AS ok
  FROM expected_policies e
),
rels AS (
  -- The three tables and their id sequences.
  SELECT c.oid, c.relname, c.relkind, c.relacl, c.relowner
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  WHERE (c.relname IN (SELECT tbl FROM new_tables) AND c.relkind IN ('r','p'))
     OR (c.relname IN (SELECT tbl || '_id_seq' FROM new_tables) AND c.relkind = 'S')
),
acl AS (
  -- One row per aclitem. grantee_oid 0 = PUBLIC. privs = the privilege letters
  -- of that item with pass-on marks (*) stripped. A NULL relacl means the
  -- built-in default (owner only), made explicit with acldefault().
  SELECT r.relname AS rel, r.relkind,
         g.grantee_oid,
         translate(substring(item::text FROM '^(?:"(?:[^"]|"")*"|[^=]*)=([^/]*)/'), '*', '') AS privs
  FROM rels r
  CROSS JOIN LATERAL unnest(coalesce(r.relacl, acldefault(CASE WHEN r.relkind = 'S' THEN 's' ELSE 'r' END::"char", r.relowner))) AS item
  CROSS JOIN LATERAL (SELECT DISTINCT x.grantee AS grantee_oid FROM aclexplode(ARRAY[item]) x) g
),
runtime_logins AS (
  -- The runtime identity: every LOGIN role named app_runtime*, plus every
  -- non-superuser LOGIN role that inherits the app_runtime group.
  SELECT r.oid, r.rolname, r.rolsuper, r.rolbypassrls
  FROM pg_roles r
  WHERE r.rolcanlogin
    AND (r.rolname LIKE 'app\_runtime%'
         OR (NOT r.rolsuper AND EXISTS (SELECT 1 FROM pg_roles g WHERE g.rolname = 'app_runtime')
             AND pg_has_role(r.oid, 'app_runtime', 'USAGE')))
),
inspected AS (
  -- Every app_* role (group or login) and every runtime login. is_runtime:
  -- the role is app_runtime or holds its privileges by inheritance.
  SELECT r.oid, r.rolname, r.rolsuper, r.rolbypassrls,
         (r.rolname = 'app_runtime'
          OR (NOT r.rolsuper AND EXISTS (SELECT 1 FROM pg_roles g WHERE g.rolname = 'app_runtime')
              AND pg_has_role(r.oid, 'app_runtime', 'USAGE'))) AS is_runtime
  FROM pg_roles r
  WHERE r.rolname LIKE 'app\_%' OR r.oid IN (SELECT oid FROM runtime_logins)
),
effective AS (
  -- (role, relation, sorted letters) the role holds on the relation through
  -- any aclitem whose grantee it is, inherits, or that is PUBLIC.
  SELECT i.rolname, i.is_runtime, r.relname AS rel, r.relkind,
         coalesce((SELECT string_agg(DISTINCT l COLLATE "C", '' ORDER BY l COLLATE "C")
                     FROM acl a CROSS JOIN LATERAL regexp_split_to_table(a.privs, '') l
                    WHERE a.rel = r.relname AND l <> ''
                      AND (a.grantee_oid = 0 OR pg_has_role(i.oid, a.grantee_oid, 'USAGE'))), '') AS letters
  FROM inspected i CROSS JOIN rels r
),
checks(ord, check_name, ok, detail) AS (
  -- Q0. Migration recorded as applied, finished, not rolled back, and the
  -- recorded checksum is the sha256 of the reviewed migration.sql at a99e277.
  SELECT 0, 'Q0 migration 20260928120000_p1_business_offering recorded applied (finished, not rolled back, checksum = a99e277 file)',
    (SELECT count(*) FROM _prisma_migrations WHERE migration_name = '20260928120000_p1_business_offering') = 1
    AND EXISTS (SELECT 1 FROM _prisma_migrations
                WHERE migration_name = '20260928120000_p1_business_offering'
                  AND finished_at IS NOT NULL AND rolled_back_at IS NULL
                  AND checksum = 'ce64c4cf7db6b8462a5c5c58c697e946892e93812d5bdbae771ff85d392e0703'),
    NULL::text
  UNION ALL
  -- Q1. The five enum types exist with exactly the migration's labels, in order.
  SELECT 1, 'Q1 five enum types exist with exact labels in order',
    (SELECT count(*) FROM expected_enums e JOIN actual_enums a USING (typ, labels)) = 5,
    (SELECT string_agg(e.typ, ',' ORDER BY e.typ) FROM expected_enums e
      WHERE NOT EXISTS (SELECT 1 FROM actual_enums a WHERE a.typ = e.typ AND a.labels = e.labels))
  UNION ALL
  -- Q2. Columns: exact column set on the three new tables; the added columns on
  -- BusinessService / InventoryItem / Appointment present with type, nullability, default.
  SELECT 2, 'Q2 columns exact on new tables + added columns on existing tables (type, not-null, default)',
    (SELECT bool_and(ok) FROM col_match)
    AND (SELECT count(*) FROM actual_cols WHERE tbl IN (SELECT tbl FROM new_tables)) = 21,
    (SELECT string_agg(x, ',' ORDER BY x) FROM (
       SELECT tbl || '.' || col AS x FROM col_match WHERE NOT ok
       UNION ALL
       SELECT 'unexpected:' || a.tbl || '.' || a.col FROM actual_cols a
        WHERE a.tbl IN (SELECT tbl FROM new_tables)
          AND NOT EXISTS (SELECT 1 FROM expected_cols e WHERE e.tbl = a.tbl AND e.col = a.col)) s)
  UNION ALL
  -- Q3. Foreign keys exact (columns, target, ON DEL / ON UPD action, validated),
  -- no other FK on the new tables.
  SELECT 3, 'Q3 foreign keys exact (columns, target, ON DEL/ON UPD actions, validated); no extra FK on new tables',
    (SELECT count(*) FROM expected_fks e JOIN actual_fks a USING (tbl, conname, cols, reftbl, refcols, del, upd)
      WHERE a.convalidated) = 12
    AND (SELECT count(*) FROM actual_fks) = 12,
    (SELECT string_agg(x, ',' ORDER BY x) FROM (
       SELECT e.conname AS x FROM expected_fks e
        WHERE NOT EXISTS (SELECT 1 FROM actual_fks a WHERE a.convalidated AND (a.tbl, a.conname, a.cols, a.reftbl, a.refcols, a.del, a.upd)
                                                        = (e.tbl, e.conname, e.cols, e.reftbl, e.refcols, e.del, e.upd))
       UNION ALL
       SELECT 'unexpected:' || a.conname FROM actual_fks a
        WHERE NOT EXISTS (SELECT 1 FROM expected_fks e WHERE e.conname = a.conname)) s)
  UNION ALL
  -- Q4. CHECK constraints present, validated, on the expected columns; no other
  -- CHECK on the new tables.
  SELECT 4, 'Q4 CHECK constraints present + validated on expected columns; no extra CHECK on new tables',
    (SELECT count(*) FROM expected_checks e JOIN actual_checks a USING (tbl, conname, cols) WHERE a.convalidated) = 5
    AND (SELECT count(*) FROM actual_checks) = 5,
    (SELECT string_agg(x, ',' ORDER BY x) FROM (
       SELECT e.conname AS x FROM expected_checks e
        WHERE NOT EXISTS (SELECT 1 FROM actual_checks a WHERE a.convalidated AND a.tbl = e.tbl AND a.conname = e.conname AND a.cols = e.cols)
       UNION ALL
       SELECT 'unexpected:' || a.conname FROM actual_checks a
        WHERE NOT EXISTS (SELECT 1 FROM expected_checks e WHERE e.conname = a.conname)) s)
  UNION ALL
  -- Q5. Indexes and unique keys exact (unique/primary, column order, valid,
  -- plain btree); no other index on the new tables.
  SELECT 5, 'Q5 indexes + unique keys exact (unique/primary, column order, valid btree); no extra index on new tables',
    (SELECT count(*) FROM expected_idx e JOIN actual_idx a USING (tbl, idx, uniq, prim, cols) WHERE a.sound) = 15
    AND (SELECT count(*) FROM actual_idx) = 15,
    (SELECT string_agg(x, ',' ORDER BY x) FROM (
       SELECT e.idx AS x FROM expected_idx e
        WHERE NOT EXISTS (SELECT 1 FROM actual_idx a WHERE a.sound AND (a.tbl, a.idx, a.uniq, a.prim, a.cols)
                                                        = (e.tbl, e.idx, e.uniq, e.prim, e.cols))
       UNION ALL
       SELECT 'unexpected:' || a.idx FROM actual_idx a
        WHERE NOT EXISTS (SELECT 1 FROM expected_idx e WHERE e.idx = a.idx)) s)
  UNION ALL
  -- Q6. RLS enabled and forced on the three new tables.
  SELECT 6, 'Q6 RLS enabled+forced on BusinessServiceAsset, InventoryItemAsset, OfferingDemandSignal',
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
       WHERE c.relname IN (SELECT tbl FROM new_tables) AND c.relkind = 'r'
         AND c.relrowsecurity AND c.relforcerowsecurity) = 3,
    (SELECT string_agg(t.tbl, ',') FROM new_tables t
      WHERE NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
                         WHERE c.relname = t.tbl AND c.relrowsecurity AND c.relforcerowsecurity))
  UNION ALL
  -- Q7. Policy set exact: per table one SELECT (USING tenant), one INS (WITH
  -- CHECK tenant), one UPD (USING + WITH CHECK tenant); all permissive, role
  -- PUBLIC; no DEL policy, no FOR ALL policy, nothing else.
  SELECT 7, 'Q7 policies exact (9: select/ins/upd per table, permissive, PUBLIC, tenant predicate; no DEL, no ALL, no extra)',
    (SELECT bool_and(ok) FROM policy_match)
    AND (SELECT count(*) FROM actual_policies) = 9,
    (SELECT string_agg(x, ',' ORDER BY x) FROM (
       SELECT tbl || '.' || pol AS x FROM policy_match WHERE NOT ok
       UNION ALL
       SELECT 'unexpected:' || a.tbl || '.' || a.pol FROM actual_policies a
        WHERE NOT EXISTS (SELECT 1 FROM expected_policies e WHERE e.tbl = a.tbl AND e.pol = a.pol)) s)
  UNION ALL
  -- Q8. Effective table privileges: app_runtime and every role / login that
  -- inherits it hold exactly r,a,w (no d, no D, no x/t/m); every other app_*
  -- role holds nothing; at least one runtime login exists.
  SELECT 8, 'Q8 table privileges: runtime (app_runtime + inheriting roles/logins) exactly arw, no d/D; other app_* none',
    EXISTS (SELECT 1 FROM runtime_logins)
    AND NOT EXISTS (SELECT 1 FROM effective WHERE relkind <> 'S'
                     AND letters <> CASE WHEN is_runtime THEN 'arw' ELSE '' END),
    (SELECT string_agg(rolname || ':' || rel || '=' || letters, ',' ORDER BY rolname, rel) FROM effective
      WHERE relkind <> 'S' AND letters <> CASE WHEN is_runtime THEN 'arw' ELSE '' END)
  UNION ALL
  -- Q9. Effective sequence privileges: runtime exactly U + r (USAGE, SELECT;
  -- no w); every other app_* role nothing; the sequences are owned by <table>.id.
  SELECT 9, 'Q9 id sequence privileges: runtime exactly USAGE+SELECT; other app_* none; sequences owned by table.id',
    (SELECT count(*) FROM rels WHERE relkind = 'S') = 3
    AND NOT EXISTS (SELECT 1 FROM effective WHERE relkind = 'S'
                     AND letters <> CASE WHEN is_runtime THEN 'Ur' ELSE '' END)
    AND (SELECT count(*) FROM new_tables t
          WHERE pg_get_serial_sequence(format('%I', t.tbl), 'id') = format('public.%I', t.tbl || '_id_seq')) = 3,
    (SELECT string_agg(rolname || ':' || rel || '=' || letters, ',' ORDER BY rolname, rel) FROM effective
      WHERE relkind = 'S' AND letters <> CASE WHEN is_runtime THEN 'Ur' ELSE '' END)
  UNION ALL
  -- Q10. PUBLIC holds nothing on the three tables or their sequences.
  SELECT 10, 'Q10 PUBLIC holds no privilege on the three tables or their id sequences',
    NOT EXISTS (SELECT 1 FROM acl WHERE grantee_oid = 0 AND privs <> ''),
    (SELECT string_agg(rel, ',') FROM acl WHERE grantee_oid = 0 AND privs <> '')
  UNION ALL
  -- Q11. No app_* role or runtime login can step around RLS by attribute.
  SELECT 11, 'Q11 app_* roles and runtime logins are NOSUPERUSER NOBYPASSRLS (runtime login exists)',
    NOT EXISTS (SELECT 1 FROM inspected WHERE rolsuper OR rolbypassrls)
    AND EXISTS (SELECT 1 FROM runtime_logins),
    (SELECT string_agg(rolname, ',' ORDER BY rolname) FROM inspected WHERE rolsuper OR rolbypassrls)
  UNION ALL
  -- Q12. The migration attaches no trigger: no user trigger on the new tables.
  SELECT 12, 'Q12 no user trigger on the three new tables (the migration defines none)',
    NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                 JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
                 WHERE NOT t.tgisinternal AND c.relname IN (SELECT tbl FROM new_tables)),
    (SELECT string_agg(c.relname || '.' || t.tgname, ',') FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND c.relname IN (SELECT tbl FROM new_tables))
)
SELECT ord,
       check_name,
       CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result,
       CASE WHEN ok THEN NULL ELSE detail END AS detail
FROM checks
ORDER BY ord;

ROLLBACK;
