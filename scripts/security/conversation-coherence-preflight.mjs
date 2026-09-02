/**
 * D2 / ACCOUNT-DELETION-2A.3 — compatibility preflight for the structural
 * tenant-coherence migration.
 *
 * SELECT ONLY. This script exists to answer one question before any DDL runs:
 * "would the composite FKs fail, and if so on exactly which rows?" It never
 * repairs anything — a detected violation is an owner decision, not an automatic
 * UPDATE, because silently rewriting businessId on a real row would either move
 * another tenant's message into your business or destroy the evidence of a breach.
 *
 * Every statement is a SELECT. There is no INSERT/UPDATE/DELETE/DDL anywhere in
 * this file, and scripts/ci/conversation-coherence-guard.sh pins that.
 *
 * Exit 0 = the migration can be applied. Exit 1 = STOP. Exit 2 = refused/misused.
 */

/** Each check returns the rows that would VIOLATE the future constraint. */
export const PREFLIGHT_CHECKS = [
  {
    key: "message_business_mismatch",
    why: "Message hanging off another tenant's Conversation — precisely the row a cascade would wrongly destroy",
    sql: `SELECT m."id" AS child_id, m."businessId" AS child_business, c."id" AS parent_id, c."businessId" AS parent_business
            FROM "Message" m JOIN "Conversation" c ON c."id" = m."conversationId"
           WHERE m."businessId" <> c."businessId"`,
  },
  {
    key: "replysuggestion_business_mismatch",
    why: "ReplySuggestion hanging off another tenant's Conversation",
    sql: `SELECT r."id" AS child_id, r."businessId" AS child_business, c."id" AS parent_id, c."businessId" AS parent_business
            FROM "ReplySuggestion" r JOIN "Conversation" c ON c."id" = r."conversationId"
           WHERE r."businessId" <> c."businessId"`,
  },
  {
    key: "message_dangling_conversation",
    why: "Message referencing a Conversation that does not exist — the composite FK could not be satisfied",
    sql: `SELECT m."id" AS child_id, m."conversationId" AS parent_id
            FROM "Message" m LEFT JOIN "Conversation" c ON c."id" = m."conversationId"
           WHERE c."id" IS NULL`,
  },
  {
    key: "replysuggestion_dangling_conversation",
    why: "ReplySuggestion referencing a Conversation that does not exist",
    sql: `SELECT r."id" AS child_id, r."conversationId" AS parent_id
            FROM "ReplySuggestion" r LEFT JOIN "Conversation" c ON c."id" = r."conversationId"
           WHERE c."id" IS NULL`,
  },
  {
    key: "null_key_components",
    why: "A NULL in any key column makes a composite FK vacuously satisfied under MATCH SIMPLE — a real bypass. Must be zero, and the NOT NULL constraints must stay.",
    sql: `SELECT 'Message' AS tbl, m."id" AS child_id FROM "Message" m
           WHERE m."businessId" IS NULL OR m."conversationId" IS NULL
           UNION ALL
          SELECT 'ReplySuggestion', r."id" FROM "ReplySuggestion" r
           WHERE r."businessId" IS NULL OR r."conversationId" IS NULL`,
  },
  {
    key: "duplicate_parent_composite_key",
    why: "CREATE UNIQUE INDEX on Conversation(id, businessId) fails on duplicates. id is the PK so this should be impossible; checked anyway because that index is what makes the FK legal.",
    sql: `SELECT "id" AS parent_id, count(*)::int AS n FROM "Conversation"
           GROUP BY "id", "businessId" HAVING count(*) > 1`,
  },
];

/** Structural preconditions the whole safety argument depends on. */
const NOT_NULL_SQL = `
  SELECT table_name, column_name, is_nullable
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND (   (table_name = 'Message'         AND column_name IN ('businessId','conversationId'))
          OR (table_name = 'ReplySuggestion' AND column_name IN ('businessId','conversationId')))
   ORDER BY table_name, column_name`;

/**
 * @param client anything exposing Prisma's $queryRawUnsafe
 * @returns {Promise<{ok: boolean, checks: Array, notNull: Array, nullable: Array}>}
 */
export async function preflightConversationCoherence(client) {
  const checks = [];
  for (const c of PREFLIGHT_CHECKS) {
    const rows = await client.$queryRawUnsafe(c.sql);
    checks.push({ key: c.key, why: c.why, violations: rows.length, sample: rows.slice(0, 20) });
  }
  const notNull = await client.$queryRawUnsafe(NOT_NULL_SQL);
  const nullable = notNull.filter((r) => r.is_nullable !== "NO");
  const ok = checks.every((c) => c.violations === 0) && nullable.length === 0;
  return { ok, checks, notNull, nullable };
}

export function reportPreflight(result) {
  console.log("\n[preflight] D2/AD-2A.3 conversation tenant coherence — SELECT ONLY\n");
  for (const c of result.checks) {
    const tag = c.violations === 0 ? "OK  " : "STOP";
    console.log(`  [${tag}] ${c.key} = ${c.violations}`);
    if (c.violations > 0) {
      console.log(`         ${c.why}`);
      for (const s of c.sample) console.log(`         ${JSON.stringify(s)}`);
    }
  }
  console.log("\n  NOT NULL preconditions (MATCH SIMPLE bypass guard):");
  for (const r of result.notNull) {
    const tag = r.is_nullable === "NO" ? "[OK  ]" : "[STOP]";
    console.log(`    ${tag} ${r.table_name}.${r.column_name} is_nullable=${r.is_nullable}`);
  }
  const verdict = result.ok
    ? "PASS — migration may be applied"
    : "FAIL — STOP, do not migrate, do not repair automatically";
  console.log(`\n[preflight] ${verdict}\n`);
}

/** This script must never be pointed at Production. */
export const PRODUCTION_DENY_LIST = ["ep-flat-brook-am4bhq1y", "ep-winter-bread-ami5o8p5"];

const entry = (process.argv[1] || "").replace(/\\/g, "/");

if (entry.endsWith("conversation-coherence-preflight.mjs")) {
  const url = process.env.PREFLIGHT_URL ?? process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error("set PREFLIGHT_URL (or DIRECT_URL/DATABASE_URL)");
    process.exit(2);
  }
  for (const d of PRODUCTION_DENY_LIST) {
    if (url.includes(d)) {
      console.error(`REFUSING: target matches the Production deny-list (${d})`);
      process.exit(2);
    }
  }
  const { PrismaClient } = await import("@prisma/client");
  const client = new PrismaClient({ datasourceUrl: url });
  const result = await preflightConversationCoherence(client);
  reportPreflight(result);
  await client.$disconnect();
  process.exit(result.ok ? 0 : 1);
}
