/**
 * Apply the Notification row-level security to a DISPOSABLE CI database.
 *
 * WHY THIS EXISTS
 *
 * `prisma db push` materialises schema.prisma, and row-level security is not in
 * schema.prisma — it is hand-written SQL at the bottom of the notification
 * migration. A CI database built by `db push` therefore has the tables and none
 * of the policies, which is not the shape the notification suites run against
 * anywhere else.
 *
 * The obvious fix is to paste the policy SQL into the workflow. That would
 * create a second source of truth for a security boundary, and the copy would
 * be the one nobody updates. So this reads the canonical migration and executes
 * the section it already contains.
 *
 * WHAT PROTECTS AGAINST DRIFT
 *
 * Extracting a section of a file is only safe if the extraction can tell when
 * the file has moved underneath it. Three things do that here:
 *
 *   1. the section header must be present — if the migration is restructured,
 *      this fails loudly instead of silently applying nothing;
 *   2. the extracted text must contain every object it is supposed to create,
 *      by name — a policy renamed or dropped in the migration fails here;
 *   3. the database is queried afterwards, so "the SQL ran" is never mistaken
 *      for "the policies exist".
 *
 * None of those are copies of the SQL. They are assertions about the canonical
 * file, which is the difference between a lock and a duplicate.
 *
 * SAFETY
 *
 * Refuses to run against anything that does not look like a disposable local
 * database. This applies FORCE ROW LEVEL SECURITY; pointing it at a real
 * environment is not a mistake worth leaving available.
 *
 * Usage: DATABASE_URL=... node scripts/ci/notification-rls-bootstrap.mjs
 */
import { readFileSync } from "node:fs";

import { PrismaClient } from "@prisma/client";

const MIGRATION =
  "prisma/migrations/20260903200000_notification_persistence/migration.sql";

/** The boundary between Prisma's generated DDL and the hand-written block. */
const RLS_HEADER = "-- ── Row-level security";

/** Every object the section must still create, checked before and after. */
const EXPECTED = [
  { table: "Notification", policy: "notif_tenant" },
  { table: "NotificationDelivery", policy: "notif_delivery_tenant" },
];

function assertDisposable(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error("DATABASE_URL is not a URL");
  }
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (!local) {
    throw new Error(
      `refusing to apply row-level security to a non-local host (${host}) — this script is for disposable CI databases only`,
    );
  }
}

/** Statement split on semicolons that are not inside a quoted string. */
function splitSql(sql) {
  const out = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === ";") {
      if (current.trim()) out.push(current.trim());
      current = "";
      continue;
    }
    current += c;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  assertDisposable(url);

  const sql = readFileSync(MIGRATION, "utf8");
  const at = sql.indexOf(RLS_HEADER);
  if (at < 0) {
    throw new Error(
      `DRIFT: "${RLS_HEADER}" is no longer in ${MIGRATION}. The section this bootstrap applies has moved or been renamed — fix this script against the migration rather than guessing.`,
    );
  }

  const block = sql.slice(at);
  for (const { table, policy } of EXPECTED) {
    for (const needle of [
      `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`,
      `ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`,
      `CREATE POLICY ${policy} ON "${table}"`,
    ]) {
      if (!block.includes(needle)) {
        throw new Error(`DRIFT: the migration's RLS section no longer contains: ${needle}`);
      }
    }
  }

  const db = new PrismaClient({ datasourceUrl: url });
  try {
    const statements = splitSql(block);
    for (const statement of statements) await db.$executeRawUnsafe(statement);

    // The SQL ran; that is not the same as the policies existing.
    const rows = await db.$queryRawUnsafe(
      `SELECT tablename, policyname FROM pg_policies
        WHERE tablename IN ('Notification', 'NotificationDelivery')
        ORDER BY tablename, policyname`,
    );
    const found = new Set(rows.map((r) => `${r.tablename}.${r.policyname}`));
    for (const { table, policy } of EXPECTED) {
      if (!found.has(`${table}.${policy}`)) {
        throw new Error(`policy ${table}.${policy} is missing after applying the section`);
      }
    }

    const forced = await db.$queryRawUnsafe(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relname IN ('Notification', 'NotificationDelivery') ORDER BY relname`,
    );
    for (const r of forced) {
      if (!r.relrowsecurity || !r.relforcerowsecurity) {
        throw new Error(`${r.relname}: row-level security is not both enabled and forced`);
      }
    }

    console.log(
      `notification RLS applied from ${MIGRATION}: ${statements.length} statements, ` +
        `${[...found].sort().join(", ")}, both tables ENABLE+FORCE`,
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
