-- Rows that exist BEFORE migration 20261108090000 (run on a lab built by `.lcp/lab.sh <db>`, then `--deploy-only`):
-- two businesses with leads (open with a phone, closed, phone-less), so the battery can show existing rows keep every
-- value and get no claimed phone. Synthetic only.
INSERT INTO "Business" (name, "updatedAt") VALUES ('lcp-pre-A', now()), ('lcp-pre-B', now());
INSERT INTO "Lead" ("businessId", "customerName", phone, email, status, "updatedAt")
SELECT b.id, v.n, v.p, v.e, v.s::"LeadStatus", now()
  FROM "Business" b,
       (VALUES ('lcp-pre-A', 'פתוח עם טלפון', '972500000001', NULL, 'OPEN'),
               ('lcp-pre-A', 'סגור', '972500000002', NULL, 'WON'),
               ('lcp-pre-A', 'בלי טלפון', NULL, 'a@lab.test', 'NEW'),
               ('lcp-pre-B', 'עסק אחר', '972500000001', NULL, 'NEW')) AS v(b, n, p, e, s)
 WHERE b.name = v.b;
