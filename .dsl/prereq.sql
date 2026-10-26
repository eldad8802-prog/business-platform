-- Document ↔ supplier link labs: what Production has and a `prisma db push` cannot create. Idempotent.
--   Daily Tasks 20261018090000   "Supplier_businessId_id_key" UNIQUE ("businessId", "id") — the composite key the
--                                migration's supplier foreign keys reference. Production has it; schema.prisma does
--                                not model it, so a `db push` lab may lack it.
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Supplier_businessId_id_key') THEN
    ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_businessId_id_key" UNIQUE ("businessId", "id");
  END IF;
END
$do$;
