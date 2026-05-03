const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function run() {
  const result = await prisma.$queryRawUnsafe(`
    SELECT column_name, data_type, udt_name, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'SupplierPurchaseDraftLine'
    ORDER BY ordinal_position;
  `);

  console.table(result);
}

run().finally(() => prisma.$disconnect());