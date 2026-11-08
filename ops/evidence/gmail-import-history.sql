-- ============================================================================
-- gmail-import-history.sql
--
-- Read-only Production measurement for the Gmail import regression check (2026-11-08).
-- Question: did Gmail import work in the past, when, and were the imported files ones the
-- CURRENT screen would still let the owner import?
--
-- The screen's scoring (lib/services/email-import/scoring.ts, unchanged since 2026-05-09) is
-- mirrored below in SQL over the stored discovery fields (mime type, filename, size, subject,
-- sender). Buckets: recommended >= 45, possible 20..44, hidden < 20. Since 2026-06-22 (d5e87e28,
-- deployed ~13:11Z) the screen offers import ONLY for "recommended"; before that, every visible
-- row ("recommended" and "possible") could be ticked and imported.
--
-- OUTPUT (scripts/ci/evidence-redact.mjs): check number, counts and flags only. No id, name,
-- filename, subject, address, text or amount. Monthly rows use n = YYYYMM.
-- Guard-clean: no write keyword anywhere, prose included.
-- ============================================================================

\echo '== gmail import history: legend =='
\echo ' 1 the evidence role is a superuser or has BYPASSRLS (flag; row level security is off for this read)'
\echo '10 gmail connections, all (count)'
\echo '11 gmail connections, status connected (count)'
\echo '12 gmail connections, status revoked (count)'
\echo '13 gmail connections, status error (count)'
\echo '14 businesses with a gmail connection (count)'
\echo '15 gmail connections first made in the last 3 days (count)'
\echo '16 gmail connections changed in the last 3 days (count; a reconnect lands here)'
\echo '17 connected rows with NO stored token (count; expected 0)'
\echo '18 connected rows whose token has no long-lived renewal part (count)'
\echo '20 email attachment import rows, all (count)'
\echo '21 rows status imported (count)'
\echo '22 rows status skipped_duplicate (count)'
\echo '23 rows status failed (count)'
\echo '24 businesses with at least one imported row (count)'
\echo '25 days since the most recent imported row (days_n; empty if none)'
\echo '26 days since the first imported row (days_n; empty if none)'
\echo '30 imported BEFORE 2026-06-22 13:00Z — old screen, checkboxes (count)'
\echo '31 imported 2026-06-22 13:00Z .. 2026-09-07 — new screen (count)'
\echo '32 imported 2026-09-07 onward — new screen + PDF/JPEG/PNG-only discovery (count)'
\echo '33 imported in the last 30 days (count)'
\echo '34 imported in the last 3 days (count)'
\echo '40 imported rows scoring "recommended" (count)'
\echo '41 imported rows scoring "possible" (count; the current screen cannot import these)'
\echo '42 imported rows scoring "hidden" (count)'
\echo '43 of 30 (old screen): scoring "possible" (count)'
\echo '44 of 30 (old screen): scoring "recommended" (count)'
\echo '45 of 31+32 (new screen): scoring "possible" (count; expected 0 if the regression is real)'
\echo '46 of 31+32 (new screen): scoring "recommended" (count)'
\echo '47 imported rows with no stored size (count; scoring then ignores size)'
\echo '50 imported rows linked to a Document (count)'
\echo '51 linked Documents now approved (count)'
\echo '52 linked Documents now needs_review (count)'
\echo '53 linked Documents in any other status (count)'
\echo '54 linked Documents whose source is email (count)'
\echo '55 imported rows, PDF (count)'
\echo '56 imported rows, image (count)'
\echo '60 Documents with source email, all (count; includes any path that tags email)'
\echo 'YYYYMM imported rows per month (n = year*100 + month, count)'

SET statement_timeout = '30s';
SET default_transaction_read_only = on;

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '25s';
-- Hard stop: a query that row level security would filter raises an ERROR instead of undercounting.
SET LOCAL row_security = off;

\echo '== visibility =='
SELECT 1 AS n, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS flag;

\echo '== connections =='
SELECT 10 AS n, count(*) AS count FROM "EmailConnection" WHERE "provider"::text = 'gmail';
SELECT 11 AS n, count(*) AS count FROM "EmailConnection" WHERE "provider"::text = 'gmail' AND "status"::text = 'connected';
SELECT 12 AS n, count(*) AS count FROM "EmailConnection" WHERE "provider"::text = 'gmail' AND "status"::text = 'revoked';
SELECT 13 AS n, count(*) AS count FROM "EmailConnection" WHERE "provider"::text = 'gmail' AND "status"::text = 'error';
SELECT 14 AS n, count(DISTINCT "businessId") AS count FROM "EmailConnection" WHERE "provider"::text = 'gmail';
SELECT 15 AS n, count(*) AS count FROM "EmailConnection"
 WHERE "provider"::text = 'gmail' AND "createdAt" > now() - interval '3 days';
SELECT 16 AS n, count(*) AS count FROM "EmailConnection"
 WHERE "provider"::text = 'gmail' AND "updatedAt" > now() - interval '3 days';
SELECT 17 AS n, count(*) AS count FROM "EmailConnection" c
 WHERE c."provider"::text = 'gmail' AND c."status"::text = 'connected'
   AND NOT EXISTS (SELECT 1 FROM "OAuthToken" t WHERE t."connectionId" = c."id");
SELECT 18 AS n, count(*) AS count FROM "EmailConnection" c JOIN "OAuthToken" t ON t."connectionId" = c."id"
 WHERE c."provider"::text = 'gmail' AND c."status"::text = 'connected' AND t."refreshTokenEncrypted" IS NULL;

\echo '== import rows =='
SELECT 20 AS n, count(*) AS count FROM "EmailAttachmentImport";
SELECT 21 AS n, count(*) AS count FROM "EmailAttachmentImport" WHERE "status"::text = 'imported';
SELECT 22 AS n, count(*) AS count FROM "EmailAttachmentImport" WHERE "status"::text = 'skipped_duplicate';
SELECT 23 AS n, count(*) AS count FROM "EmailAttachmentImport" WHERE "status"::text = 'failed';
SELECT 24 AS n, count(DISTINCT "businessId") AS count FROM "EmailAttachmentImport" WHERE "status"::text = 'imported';
SELECT 25 AS n, (SELECT floor(extract(epoch FROM now() - max("createdAt")) / 86400)::int
                   FROM "EmailAttachmentImport" WHERE "status"::text = 'imported') AS days_n;
SELECT 26 AS n, (SELECT floor(extract(epoch FROM now() - min("createdAt")) / 86400)::int
                   FROM "EmailAttachmentImport" WHERE "status"::text = 'imported') AS days_n;

\echo '== imported rows by period =='
SELECT 30 AS n, count(*) AS count FROM "EmailAttachmentImport"
 WHERE "status"::text = 'imported' AND "createdAt" < TIMESTAMPTZ '2026-06-22 13:00:00+00';
SELECT 31 AS n, count(*) AS count FROM "EmailAttachmentImport"
 WHERE "status"::text = 'imported' AND "createdAt" >= TIMESTAMPTZ '2026-06-22 13:00:00+00'
   AND "createdAt" < TIMESTAMPTZ '2026-09-07 00:00:00+00';
SELECT 32 AS n, count(*) AS count FROM "EmailAttachmentImport"
 WHERE "status"::text = 'imported' AND "createdAt" >= TIMESTAMPTZ '2026-09-07 00:00:00+00';
SELECT 33 AS n, count(*) AS count FROM "EmailAttachmentImport"
 WHERE "status"::text = 'imported' AND "createdAt" > now() - interval '30 days';
SELECT 34 AS n, count(*) AS count FROM "EmailAttachmentImport"
 WHERE "status"::text = 'imported' AND "createdAt" > now() - interval '3 days';

\echo '== imported rows by screen bucket (scoring mirrored in SQL) =='
WITH f AS (
  SELECT i."createdAt",
         lower(btrim(coalesce(i."mimeType", ''))) AS mime,
         lower(btrim(coalesce(i."filename", ''))) AS fname,
         lower(btrim(coalesce(i."subject", ''))) AS subj,
         lower(btrim(coalesce(i."fromEmail", ''))) AS sender,
         i."sizeBytes" AS size
    FROM "EmailAttachmentImport" i
   WHERE i."status"::text = 'imported'
), s AS (
  SELECT f."createdAt", f.size,
         (CASE WHEN f.mime = 'application/pdf' OR f.fname LIKE '%.pdf' THEN 40
               WHEN f.mime LIKE 'image/%' OR f.fname ~ '\.(png|jpg|jpeg|webp|gif)$' THEN 25
               ELSE -50 END)
       + (CASE WHEN f.size IS NULL THEN 0
               WHEN f.size < 20000 THEN -25
               WHEN f.size < 150000 THEN -5
               WHEN f.size <= 8000000 THEN 10
               WHEN f.size <= 15000000 THEN 2
               ELSE -30 END)
       + (CASE WHEN f.fname ~ '(receipt|invoice|חשבונית|קבלה|tax)'
                 OR f.subj ~ '(receipt|invoice|חשבונית|קבלה|tax)' THEN 15 ELSE 0 END)
       + (CASE WHEN f.fname ~ '(logo|signature|unsubscribe|facebook|twitter|instagram)'
                 OR f.subj ~ '(logo|signature|unsubscribe|facebook|twitter|instagram)' THEN -25 ELSE 0 END)
       + (CASE WHEN f.sender LIKE '%@gmail.com' THEN 2 ELSE 0 END) AS score
    FROM f
), b AS (
  SELECT s."createdAt", s.size,
         CASE WHEN s.score >= 45 THEN 'recommended' WHEN s.score >= 20 THEN 'possible' ELSE 'hidden' END AS bucket,
         s."createdAt" < TIMESTAMPTZ '2026-06-22 13:00:00+00' AS old_screen
    FROM s
)
SELECT 40 AS n, count(*) FILTER (WHERE bucket = 'recommended') AS count FROM b
UNION ALL SELECT 41, count(*) FILTER (WHERE bucket = 'possible') FROM b
UNION ALL SELECT 42, count(*) FILTER (WHERE bucket = 'hidden') FROM b
UNION ALL SELECT 43, count(*) FILTER (WHERE old_screen AND bucket = 'possible') FROM b
UNION ALL SELECT 44, count(*) FILTER (WHERE old_screen AND bucket = 'recommended') FROM b
UNION ALL SELECT 45, count(*) FILTER (WHERE NOT old_screen AND bucket = 'possible') FROM b
UNION ALL SELECT 46, count(*) FILTER (WHERE NOT old_screen AND bucket = 'recommended') FROM b
UNION ALL SELECT 47, count(*) FILTER (WHERE size IS NULL) FROM b
ORDER BY 1;

\echo '== where the imported files went =='
SELECT 50 AS n, count(*) AS count FROM "EmailAttachmentImport"
 WHERE "status"::text = 'imported' AND "documentId" IS NOT NULL;
SELECT 51 AS n, count(*) AS count FROM "EmailAttachmentImport" i JOIN "Document" d ON d."id" = i."documentId"
 WHERE i."status"::text = 'imported' AND d."status" = 'approved';
SELECT 52 AS n, count(*) AS count FROM "EmailAttachmentImport" i JOIN "Document" d ON d."id" = i."documentId"
 WHERE i."status"::text = 'imported' AND d."status" = 'needs_review';
SELECT 53 AS n, count(*) AS count FROM "EmailAttachmentImport" i JOIN "Document" d ON d."id" = i."documentId"
 WHERE i."status"::text = 'imported' AND d."status" NOT IN ('approved', 'needs_review');
SELECT 54 AS n, count(*) AS count FROM "EmailAttachmentImport" i JOIN "Document" d ON d."id" = i."documentId"
 WHERE i."status"::text = 'imported' AND d."source" = 'email';
SELECT 55 AS n, count(*) AS count FROM "EmailAttachmentImport"
 WHERE "status"::text = 'imported' AND lower("mimeType") = 'application/pdf';
SELECT 56 AS n, count(*) AS count FROM "EmailAttachmentImport"
 WHERE "status"::text = 'imported' AND lower("mimeType") LIKE 'image/%';
SELECT 60 AS n, count(*) AS count FROM "Document" WHERE "source" = 'email';

\echo '== imported rows per month (n = YYYYMM) =='
SELECT (extract(year FROM "createdAt")::int * 100 + extract(month FROM "createdAt")::int) AS n, count(*) AS count
  FROM "EmailAttachmentImport"
 WHERE "status"::text = 'imported'
 GROUP BY 1
 ORDER BY 1;

ROLLBACK;
