/**
 * Customer phone audit — read-only.
 *
 * Run BEFORE the migration:
 *   20260528120000_whatsapp_connection_and_customer_phone_unique
 *
 * Usage:
 *   node scripts/audit-customer-phones.mjs
 *
 * If Section A or Section B returns any rows: STOP. Do NOT run the migration.
 * Wait for a manual merge decision per business policy.
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function header(title) {
  console.log("");
  console.log("─".repeat(72));
  console.log(title);
  console.log("─".repeat(72));
}

function fmtCount(n) {
  return n.toLocaleString("en-US");
}

async function main() {
  console.log("\n=== Customer phone audit ===");
  console.log("Target DB:", process.env.DATABASE_URL?.split("@")[1]?.split("?")[0] ?? "(unknown)");
  console.log("Run at:   ", new Date().toISOString());

  // ─── Section D first — context for everything that follows ───
  header("Section D — Total Customer row count (context)");
  const total = await prisma.$queryRaw`
    SELECT
      COUNT(*)::int                                          AS total_customers,
      COUNT(*) FILTER (WHERE "phone" IS NOT NULL)::int       AS with_phone,
      COUNT(*) FILTER (WHERE "phone" IS NULL)::int           AS without_phone,
      COUNT(DISTINCT "businessId")::int                      AS distinct_businesses
    FROM "Customer";
  `;
  console.table(total);

  // ─── Section A — Literal duplicates today ───
  header("Section A — Literal (businessId, phone) duplicates TODAY");
  const sectionA = await prisma.$queryRaw`
    SELECT
      "businessId",
      "phone",
      COUNT(*)::int                                    AS duplicate_count,
      array_agg(id ORDER BY "createdAt")               AS customer_ids,
      MIN("createdAt")                                 AS first_created_at,
      MAX("createdAt")                                 AS last_created_at
    FROM "Customer"
    WHERE "phone" IS NOT NULL
    GROUP BY "businessId", "phone"
    HAVING COUNT(*) > 1
    ORDER BY duplicate_count DESC, "businessId" ASC;
  `;
  if (sectionA.length === 0) {
    console.log("✓ No literal duplicates. Section A is clean.");
  } else {
    console.log(`✗ FOUND ${fmtCount(sectionA.length)} duplicate group(s):`);
    console.table(sectionA);
  }

  // ─── Section B — Duplicates the normalization would introduce ───
  header("Section B — Duplicates the migration WOULD introduce after normalization");
  const sectionB = await prisma.$queryRaw`
    WITH normalized AS (
      SELECT
        id,
        "businessId",
        "phone"            AS raw_phone,
        "createdAt",
        CASE
          WHEN regexp_replace("phone", '\\D', '', 'g') ~ '^972'
            THEN regexp_replace("phone", '\\D', '', 'g')
          WHEN regexp_replace("phone", '\\D', '', 'g') ~ '^0'
            THEN '972' || substring(regexp_replace("phone", '\\D', '', 'g') from 2)
          ELSE regexp_replace("phone", '\\D', '', 'g')
        END                                            AS normalized_phone
      FROM "Customer"
      WHERE "phone" IS NOT NULL
        AND length(regexp_replace("phone", '\\D', '', 'g')) >= 8
    )
    SELECT
      "businessId",
      normalized_phone,
      COUNT(*)::int                                    AS group_size,
      array_agg(id ORDER BY "createdAt")               AS customer_ids,
      array_agg(raw_phone ORDER BY "createdAt")        AS raw_phones,
      MIN("createdAt")                                 AS first_created_at,
      MAX("createdAt")                                 AS last_created_at
    FROM normalized
    GROUP BY "businessId", normalized_phone
    HAVING COUNT(*) > 1
    ORDER BY group_size DESC, "businessId" ASC;
  `;
  if (sectionB.length === 0) {
    console.log("✓ No collision groups produced by normalization. Section B is clean.");
  } else {
    console.log(`✗ FOUND ${fmtCount(sectionB.length)} collision group(s) that would be created by normalization:`);
    console.table(sectionB);
  }

  // ─── Section C — Format distribution ───
  header("Section C — Phone format distribution per business (sanity)");
  const sectionC = await prisma.$queryRaw`
    SELECT
      "businessId",
      COUNT(*) FILTER (WHERE "phone" IS NULL)::int                                              AS null_phones,
      COUNT(*) FILTER (WHERE "phone" IS NOT NULL AND "phone" LIKE '+%')::int                    AS plus_prefixed,
      COUNT(*) FILTER (WHERE "phone" IS NOT NULL AND "phone" LIKE '0%')::int                    AS local_prefix_zero,
      COUNT(*) FILTER (WHERE "phone" IS NOT NULL AND "phone" LIKE '972%')::int                  AS intl_prefix_972,
      COUNT(*) FILTER (WHERE "phone" IS NOT NULL AND length(regexp_replace("phone", '\\D', '', 'g')) < 8)::int AS too_short_after_strip,
      COUNT(*)::int                                                                              AS total_customers
    FROM "Customer"
    GROUP BY "businessId"
    ORDER BY "businessId" ASC;
  `;
  if (sectionC.length === 0) {
    console.log("(no customer rows at all)");
  } else {
    console.table(sectionC);
  }

  // ─── Decision summary ───
  header("Decision summary");
  if (sectionA.length === 0 && sectionB.length === 0) {
    console.log("✓ A=0 and B=0 — migration can proceed safely from a data perspective.");
    console.log("  Confirm the target environment (DEV / PROD) before running the migration.");
  } else {
    console.log("✗ Audit found rows. DO NOT RUN THE MIGRATION.");
    console.log(`  Section A duplicate groups: ${sectionA.length}`);
    console.log(`  Section B collision groups: ${sectionB.length}`);
    console.log("  Surface these groups to the team for a manual merge decision.");
  }

  console.log("\n=== End of audit ===\n");
}

main()
  .catch((err) => {
    console.error("\n!!! Audit FAILED with an error:");
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
