-- LAB FIXTURE (synthetic) — the state the migration must refuse to be applied over: a cancelled FIELD case whose part
-- line is still RESERVED (written BEFORE the guard exists, as a writer that forgot the release could have left it).
-- Run as the lab owner on a database where 20261128090000 is pending.
BEGIN;
INSERT INTO "Business" (name, "updatedAt") VALUES ('sdresv-stranded', now());
SELECT set_config('app.current_business_id', currval(pg_get_serial_sequence('"Business"', 'id'))::text, true);
INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ('sdresv-stranded-' || currval(pg_get_serial_sequence('"Business"', 'id')) || '@lab.invalid', currval(pg_get_serial_sequence('"Business"', 'id')), now());
INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES (currval(pg_get_serial_sequence('"Business"', 'id')), 'לקוח סינתטי', now());
INSERT INTO "InventoryItem" ("businessId", name, "unitType", "currentQuantity", "updatedAt") VALUES (currval(pg_get_serial_sequence('"Business"', 'id')), 'מסך', 'UNIT', 3, now());
INSERT INTO "ServiceCase" ("businessId", "caseNumber", kind, "customerId", "problemDescription", "updatedAt")
  VALUES (currval(pg_get_serial_sequence('"Business"', 'id')), 1, 'FIELD', currval(pg_get_serial_sequence('"Customer"', 'id')), 'לא נדלק', now());
INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "toStatus", "cancellationRequestedBefore", "cancellationRequestedAfter", actor, "actorUserId", "idempotencyKey")
  VALUES (currval(pg_get_serial_sequence('"Business"', 'id')), currval(pg_get_serial_sequence('"ServiceCase"', 'id')), 1, 'case.opened', 'OPEN', 'OPEN', false, false,
          'OWNER_USER', currval(pg_get_serial_sequence('"User"', 'id')), 'sdresv-stranded-open');
INSERT INTO "ServicePart" ("businessId", "caseId", source, "inventoryItemId", "nameSnapshot", "unitType", quantity, "updatedAt")
  VALUES (currval(pg_get_serial_sequence('"Business"', 'id')), currval(pg_get_serial_sequence('"ServiceCase"', 'id')), 'STOCK',
          currval(pg_get_serial_sequence('"InventoryItem"', 'id')), 'מסך', 'UNIT', 1, now());
INSERT INTO "ServicePartEvent" ("businessId", "partId", "caseId", seq, kind, "stateAfter", quantity, actor, "idempotencyKey")
  VALUES (currval(pg_get_serial_sequence('"Business"', 'id')), currval(pg_get_serial_sequence('"ServicePart"', 'id')), currval(pg_get_serial_sequence('"ServiceCase"', 'id')),
          1, 'ADDED', 'NEEDED', 1, 'SYSTEM', 'sdresv-stranded-add');
UPDATE "ServicePart" SET state = 'RESERVED', "lastEventKind" = 'RESERVED', version = 2 WHERE id = currval(pg_get_serial_sequence('"ServicePart"', 'id'));
INSERT INTO "ServicePartEvent" ("businessId", "partId", "caseId", seq, kind, "stateBefore", "stateAfter", quantity, actor, "idempotencyKey")
  VALUES (currval(pg_get_serial_sequence('"Business"', 'id')), currval(pg_get_serial_sequence('"ServicePart"', 'id')), currval(pg_get_serial_sequence('"ServiceCase"', 'id')),
          2, 'RESERVED', 'NEEDED', 'RESERVED', 1, 'SYSTEM', 'sdresv-stranded-rsv');
UPDATE "ServiceCase" SET status = 'CANCELLED', outcome = 'CANCELLED', "cancelledAt" = now(), version = 2 WHERE id = currval(pg_get_serial_sequence('"ServiceCase"', 'id'));
INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "fromStatus", "toStatus", "cancellationRequestedBefore", "cancellationRequestedAfter", outcome, actor, "idempotencyKey")
  VALUES (currval(pg_get_serial_sequence('"Business"', 'id')), currval(pg_get_serial_sequence('"ServiceCase"', 'id')), 2, 'case.cancelled', 'CANCEL', 'OPEN', 'CANCELLED',
          false, false, 'CANCELLED', 'SYSTEM', 'sdresv-stranded-cancel');
COMMIT;
