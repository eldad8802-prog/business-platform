-- .sdqad/chain.sh R1: one business with one QA list and one track default (synthetic), so the rollback must refuse.
BEGIN;
INSERT INTO "Business" (name, "updatedAt") VALUES ('sdqad-rollback-refusal', now());
SELECT set_config('app.current_business_id', currval(pg_get_serial_sequence('"Business"', 'id'))::text, true);
INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ('sdqad-rb-' || currval(pg_get_serial_sequence('"Business"', 'id')) || '@lab.invalid', currval(pg_get_serial_sequence('"Business"', 'id')), now());
INSERT INTO "ServiceQaList" ("businessId", "currentVersion", revision) VALUES (currval(pg_get_serial_sequence('"Business"', 'id')), 1, 1);
INSERT INTO "ServiceQaListVersion" ("businessId", "listId", version, name, "itemCount", "requiredCount", "createdByUserId")
  VALUES (currval(pg_get_serial_sequence('"Business"', 'id')), currval(pg_get_serial_sequence('"ServiceQaList"', 'id')), 1, 'בדיקה', 1, 1, currval(pg_get_serial_sequence('"User"', 'id')));
INSERT INTO "ServiceQaListItem" ("businessId", "listId", "listVersion", position, "itemKey", label, required)
  VALUES (currval(pg_get_serial_sequence('"Business"', 'id')), currval(pg_get_serial_sequence('"ServiceQaList"', 'id')), 1, 1, 'works', 'עובד', true);
INSERT INTO "ServiceQaListEvent" ("businessId", "listId", revision, action, "listVersion", "itemCount", "requiredCount", actor, "actorUserId", "idempotencyKey")
  VALUES (currval(pg_get_serial_sequence('"Business"', 'id')), currval(pg_get_serial_sequence('"ServiceQaList"', 'id')), 1, 'CREATE', 1, 1, 1, 'OWNER_USER', currval(pg_get_serial_sequence('"User"', 'id')), 'sdqad-rb-list-1');
INSERT INTO "ServiceQaTrackDefault" ("businessId", track, revision, "listId", actor, "actorUserId", "idempotencyKey")
  VALUES (currval(pg_get_serial_sequence('"Business"', 'id')), 'T1', 1, currval(pg_get_serial_sequence('"ServiceQaList"', 'id')), 'OWNER_USER', currval(pg_get_serial_sequence('"User"', 'id')), 'sdqad-rb-default-1');
COMMIT;
