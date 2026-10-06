-- Lab battery (run as a NOBYPASSRLS app_runtime member, on a DB holding OutcomeRecommendation 1,2 for business 1 and 4 for business 2).
-- Every 'must fail' statement must raise the error named in its label; the counts in step 6 must be 1 / 0 / 0.
\set QUIET on
\echo 1 insert own tenant (B1 rec 1)
BEGIN; SELECT set_config('app.current_business_id','1',true);
INSERT INTO "OutcomeRecommendationEvidence"("businessId","recommendationId","evidenceVersion","kind","facts","evidenceRefs","factFingerprint","capturedAt")
 VALUES (1,1,'rec-evidence.v1','REVIEW_BACKLOG','{"pendingCount":3}','[{"store":"Document","id":11}]','fp1',now()) RETURNING 'OK1';
COMMIT;
\echo 2 cross-tenant insert (GUC=1, row businessId=2) must fail RLS
BEGIN; SELECT set_config('app.current_business_id','1',true);
INSERT INTO "OutcomeRecommendationEvidence"("businessId","recommendationId","evidenceVersion","kind","facts","evidenceRefs","factFingerprint","capturedAt")
 VALUES (2,4,'rec-evidence.v1','REVIEW_BACKLOG','{}','[]','x',now());
ROLLBACK;
\echo 3 composite FK: B1 row pointing at business 2 recommendation must fail
BEGIN; SELECT set_config('app.current_business_id','1',true);
INSERT INTO "OutcomeRecommendationEvidence"("businessId","recommendationId","evidenceVersion","kind","facts","evidenceRefs","factFingerprint","capturedAt")
 VALUES (1,4,'rec-evidence.v1','REVIEW_BACKLOG','{}','[]','x',now());
ROLLBACK;
\echo 4 second row same recommendation must fail unique
BEGIN; SELECT set_config('app.current_business_id','1',true);
INSERT INTO "OutcomeRecommendationEvidence"("businessId","recommendationId","evidenceVersion","kind","facts","evidenceRefs","factFingerprint","capturedAt")
 VALUES (1,1,'rec-evidence.v1','REVIEW_BACKLOG','{}','[]','x',now());
ROLLBACK;
\echo 5 bad kind / non-object facts must fail check
BEGIN; SELECT set_config('app.current_business_id','1',true);
INSERT INTO "OutcomeRecommendationEvidence"("businessId","recommendationId","evidenceVersion","kind","facts","evidenceRefs","factFingerprint","capturedAt")
 VALUES (1,2,'v','FREE_TEXT','{}','[]','x',now());
ROLLBACK;
BEGIN; SELECT set_config('app.current_business_id','1',true);
INSERT INTO "OutcomeRecommendationEvidence"("businessId","recommendationId","evidenceVersion","kind","facts","evidenceRefs","factFingerprint","capturedAt")
 VALUES (1,2,'v','OVERDUE_INSTALLMENT','"raw"','[]','x',now());
ROLLBACK;
\echo 6 read: own=1, other tenant=0, no GUC=0
BEGIN; SELECT set_config('app.current_business_id','1',true); SELECT 'own', count(*) FROM "OutcomeRecommendationEvidence"; COMMIT;
BEGIN; SELECT set_config('app.current_business_id','2',true); SELECT 'other', count(*) FROM "OutcomeRecommendationEvidence"; COMMIT;
SELECT 'noguc', count(*) FROM "OutcomeRecommendationEvidence";
\echo 7 update / delete / truncate by runtime must fail
BEGIN; SELECT set_config('app.current_business_id','1',true); UPDATE "OutcomeRecommendationEvidence" SET "factFingerprint"='z'; ROLLBACK;
BEGIN; SELECT set_config('app.current_business_id','1',true); DELETE FROM "OutcomeRecommendationEvidence"; ROLLBACK;
TRUNCATE "OutcomeRecommendationEvidence";
