/**
 * D2 / ACCOUNT-DELETION-2A.3 — structural tenant-coherence proof on canonical Preview.
 *
 * TWO THINGS TO KNOW ABOUT THIS SCRIPT:
 *
 * 1. It uses RAW SQL for every fixture, never the Prisma model client. The Preview
 *    branch is schema-drifted behind main (it was seeded from a parent schema and its
 *    _prisma_migrations table is empty — `Message.clientRequestId` from the W2.5
 *    migration does not exist there). A generated Prisma client built from main's
 *    schema therefore cannot INSERT into Message on Preview at all. Raw SQL is also
 *    the stronger test: it bypasses every application-layer safeguard, so what is
 *    demonstrated is the database refusing the write, not an ORM declining to emit it.
 *    The Prisma-level paths (nested writes, model updates) are proven separately on
 *    PG17, which carries the full current schema.
 *
 * 2. The attacks run as the OWNER role. That is deliberate and is the STRONGER claim:
 *    a foreign key is not a privilege check, so if the most privileged role in the
 *    database cannot persist a cross-tenant child, no application role can either.
 *    The restricted runtime role is separately verified to still be NOSUPERUSER /
 *    NOBYPASSRLS / non-owner, read-only, so this wave demonstrably did not relax it.
 *
 * Idempotent: if the migration is already applied it rolls back to the baseline first,
 * so the script can be re-run on the same branch.
 *
 * Synthetic ad2a3-prev- fixtures only, removed at the end with an always-on backstop.
 * NO PRODUCTION — the deny-list aborts on the Production endpoints.
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  preflightConversationCoherence,
  reportPreflight,
  PRODUCTION_DENY_LIST,
} from "../scripts/security/conversation-coherence-preflight.mjs";

const MIGRATION =
  "prisma/migrations/20260902090000_d2_ad2a3_conversation_tenant_coherence/migration.sql";
const ROLLBACK = "scripts/security/d2-ad2a3-rollback.sql";
const RUNTIME_ROLE = "app_runtime_preview_p4b";
const MARK = "ad2a3-prev-";

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
}
async function err(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}

function statementsOf(file) {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}
async function runSqlFile(db, file) {
  const stmts = statementsOf(file);
  for (const s of stmts) await db.$executeRawUnsafe(s);
  return stmts.length;
}

async function fkDef(db, table, name) {
  const r = await db.$queryRawUnsafe(
    `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
      WHERE c.conrelid = $1::regclass AND c.conname = $2`,
    `"${table}"`,
    name
  );
  return r[0]?.def ?? null;
}
async function indexDef(db, name) {
  const r = await db.$queryRawUnsafe(
    `SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname=$1`,
    name
  );
  return r[0]?.indexdef ?? null;
}

// ---- raw-SQL fixture helpers ----------------------------------------------
const newBusiness = async (db, suffix) =>
  (
    await db.$queryRawUnsafe(
      `INSERT INTO "Business" ("name","updatedAt") VALUES ($1, now()) RETURNING id`,
      MARK + suffix
    )
  )[0].id;

const newConversation = async (db, businessId) =>
  (
    await db.$queryRawUnsafe(
      `INSERT INTO "Conversation" ("businessId","channel","updatedAt")
       VALUES ($1, 'WHATSAPP', now()) RETURNING id`,
      businessId
    )
  )[0].id;

const insertMessage = (db, businessId, conversationId) =>
  db.$executeRawUnsafe(
    `INSERT INTO "Message" ("conversationId","businessId","channel","direction","senderType","contentText","sentAt","createdAt")
     VALUES ($1, $2, 'WHATSAPP','INBOUND','CUSTOMER', $3, now(), now())`,
    conversationId,
    businessId,
    MARK
  );

const insertSuggestion = (db, businessId, conversationId) =>
  db.$executeRawUnsafe(
    `INSERT INTO "ReplySuggestion" ("businessId","conversationId","suggestionType","strategyType","variantType","text","status","createdAt")
     VALUES ($1, $2, 'AUTO','x','default', $3, 'GENERATED', now())`,
    businessId,
    conversationId,
    MARK
  );

const countRaw = async (db, sql, ...args) =>
  Number((await db.$queryRawUnsafe(sql, ...args))[0].n);

async function cleanup(db) {
  const bids = `SELECT id FROM "Business" WHERE name LIKE '${MARK}%'`;
  await db.$executeRawUnsafe(
    `DELETE FROM "MessageAnalysis" WHERE "messageId" IN (SELECT id FROM "Message" WHERE "businessId" IN (${bids}))`
  );
  await db.$executeRawUnsafe(`DELETE FROM "ReplySuggestion" WHERE "businessId" IN (${bids})`);
  await db.$executeRawUnsafe(`DELETE FROM "Message" WHERE "businessId" IN (${bids})`);
  await db.$executeRawUnsafe(`DELETE FROM "Conversation" WHERE "businessId" IN (${bids})`);
  await db.$executeRawUnsafe(`DELETE FROM "Business" WHERE name LIKE '${MARK}%'`);
  return countRaw(db, `SELECT count(*)::int AS n FROM "Business" WHERE name LIKE '${MARK}%'`);
}

async function main() {
  const url = process.env.DIRECT_URL;
  if (!url) {
    console.error("DIRECT_URL required");
    process.exit(2);
  }
  for (const d of PRODUCTION_DENY_LIST) {
    if (url.includes(d)) {
      console.error("REFUSING: target matches the Production deny-list");
      process.exit(2);
    }
  }
  const db = new PrismaClient({ datasourceUrl: url });

  // ---- identity ------------------------------------------------------------
  console.log("\n== identity ==");
  const who = await db.$queryRawUnsafe(
    `SELECT current_database() AS db, current_user::text AS role`
  );
  console.log(`  database=${who[0].db} role=${who[0].role}`);
  ok("connected to the neondb database", who[0].db === "neondb");

  const mig = await db.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`
  );
  console.log(`  _prisma_migrations rows = ${mig[0].n} (Preview is schema-seeded, not migration-driven)`);

  // ---- the restricted runtime role must be untouched by this wave ----------
  const role = await db.$queryRawUnsafe(
    `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1`,
    RUNTIME_ROLE
  );
  if (role.length === 0) {
    ok(`runtime role ${RUNTIME_ROLE} present`, false, "role not found on this branch");
  } else {
    ok(`${RUNTIME_ROLE} is still NOSUPERUSER`, role[0].rolsuper === false);
    ok(`${RUNTIME_ROLE} is still NOBYPASSRLS`, role[0].rolbypassrls === false);
    ok(`${RUNTIME_ROLE} is not the connecting owner role`, role[0].rolname !== who[0].role);
  }

  // ---- idempotency: return to the pre-migration baseline if needed ---------
  await cleanup(db);
  if (await fkDef(db, "Message", "Message_conversationId_businessId_fkey")) {
    console.log("\n== migration already present — rolling back to the baseline first ==");
    await runSqlFile(db, ROLLBACK);
  }
  ok(
    "starting from the pre-migration baseline (single-column Conversation FK)",
    !!(await fkDef(db, "Message", "Message_conversationId_fkey")) &&
      (await fkDef(db, "Message", "Message_conversationId_businessId_fkey")) === null
  );

  // ---- preflight before any DDL -------------------------------------------
  console.log("\n== preflight (SELECT only) ==");
  const pre = await preflightConversationCoherence(db);
  reportPreflight(pre);
  ok("Preview preflight is clean, so the migration may be applied", pre.ok === true);
  ok("all four composite-key columns are NOT NULL on Preview", pre.nullable.length === 0);

  // ---- apply, and MEASURE the locks it actually takes ----------------------
  //
  // "No locks" is never a true statement about DDL. Rather than assert a lock profile
  // from documentation, apply the migration inside one explicit transaction and read
  // pg_locks from inside that same transaction, so the reported modes are the ones
  // PostgreSQL actually acquired.
  console.log("\n== apply the real migration (with measured lock profile) ==");
  const stmts = statementsOf(MIGRATION);
  const locks = await db.$transaction(async (tx) => {
    for (const s of stmts) await tx.$executeRawUnsafe(s);
    return tx.$queryRawUnsafe(
      `SELECT c.relname::text AS rel, l.mode::text AS mode
         FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
        WHERE l.pid = pg_backend_pid()
          AND l.locktype = 'relation'
          AND c.relname IN ('Conversation','Message','ReplySuggestion',
                            'Conversation_id_businessId_key',
                            'ReplySuggestion_conversationId_businessId_idx')
        ORDER BY c.relname, l.mode`
    );
  });
  ok(`migration applied to Preview (${stmts.length} statements, one transaction)`, stmts.length > 0);

  console.log("  MEASURED LOCK PROFILE (held by the migrating transaction):");
  for (const l of locks) console.log(`    ${l.rel.padEnd(46)} ${l.mode}`);
  ok("the migration does take locks (a zero-lock claim would be false)", locks.length > 0);

  // The measured truth: DROP CONSTRAINT on a foreign key takes AccessExclusiveLock on
  // BOTH the referencing child AND the referenced parent. So all three tables are
  // exclusively locked for the duration of the transaction — reads included. That is
  // acceptable here only because the transaction is trivially short at current volume;
  // it is NOT acceptable to describe this migration as read-safe.
  const strongest = (rel) =>
    locks.filter((l) => l.rel === rel).some((l) => l.mode === "AccessExclusiveLock");
  ok("Conversation is AccessExclusiveLock'd (measured, and correctly predicted)", strongest("Conversation"));
  ok("Message is AccessExclusiveLock'd (measured)", strongest("Message"));
  ok("ReplySuggestion is AccessExclusiveLock'd (measured)", strongest("ReplySuggestion"));

  // ---- catalog verification -----------------------------------------------
  const mFk = await fkDef(db, "Message", "Message_conversationId_businessId_fkey");
  const rFk = await fkDef(db, "ReplySuggestion", "ReplySuggestion_conversationId_businessId_fkey");
  ok("Message composite FK present on Preview", !!mFk && /"conversationId", "businessId"/.test(mFk), String(mFk));
  ok("ReplySuggestion composite FK present on Preview", !!rFk && /"conversationId", "businessId"/.test(rFk), String(rFk));
  ok("Message composite FK keeps ON DELETE CASCADE", !!mFk && /ON DELETE CASCADE/.test(mFk));
  ok("ReplySuggestion composite FK keeps ON DELETE CASCADE", !!rFk && /ON DELETE CASCADE/.test(rFk));
  ok("old single-column Message FK gone", (await fkDef(db, "Message", "Message_conversationId_fkey")) === null);
  ok(
    "old single-column ReplySuggestion FK gone",
    (await fkDef(db, "ReplySuggestion", "ReplySuggestion_conversationId_fkey")) === null
  );
  ok("composite parent unique index present", !!(await indexDef(db, "Conversation_id_businessId_key")));
  ok("cascade-support index present", !!(await indexDef(db, "ReplySuggestion_conversationId_businessId_idx")));

  // ---- attacks against the real Preview schema, in raw SQL ----------------
  console.log("\n== cross-tenant attacks (raw SQL, as OWNER — the strongest form) ==");
  const A = await newBusiness(db, "A");
  const B = await newBusiness(db, "B");
  const CA = await newConversation(db, A);
  const CB = await newConversation(db, B);

  ok("valid same-tenant Message accepted", (await err(() => insertMessage(db, A, CA))) === null);
  ok("cross-tenant Message INSERT DENIED", (await err(() => insertMessage(db, B, CA))) !== null);
  ok("valid same-tenant ReplySuggestion accepted", (await err(() => insertSuggestion(db, A, CA))) === null);
  ok("cross-tenant ReplySuggestion INSERT DENIED", (await err(() => insertSuggestion(db, B, CA))) !== null);

  ok(
    "UPDATE Message.businessId across tenants DENIED",
    (await err(() =>
      db.$executeRawUnsafe(`UPDATE "Message" SET "businessId" = $1 WHERE "businessId" = $2`, B, A)
    )) !== null
  );
  ok(
    "UPDATE Message.conversationId onto another tenant's conversation DENIED",
    (await err(() =>
      db.$executeRawUnsafe(`UPDATE "Message" SET "conversationId" = $1 WHERE "businessId" = $2`, CB, A)
    )) !== null
  );
  ok(
    "UPDATE ReplySuggestion.businessId across tenants DENIED",
    (await err(() =>
      db.$executeRawUnsafe(`UPDATE "ReplySuggestion" SET "businessId" = $1 WHERE "businessId" = $2`, B, A)
    )) !== null
  );
  ok(
    "a NULL businessId partial key is rejected by NOT NULL (MATCH SIMPLE bypass unreachable)",
    (await err(() =>
      db.$executeRawUnsafe(
        `INSERT INTO "Message" ("conversationId","businessId","channel","direction","senderType","sentAt","createdAt")
         VALUES ($1, NULL, 'WHATSAPP','INBOUND','CUSTOMER', now(), now())`,
        CA
      )
    )) !== null
  );

  // ---- cascade stays tenant-bounded ---------------------------------------
  console.log("\n== cascade ==");
  await insertMessage(db, B, CB);
  await insertSuggestion(db, B, CB);
  const bBefore = await countRaw(db, `SELECT count(*)::int AS n FROM "Message" WHERE "businessId" = $1`, B);

  await db.$executeRawUnsafe(`DELETE FROM "Conversation" WHERE id = $1`, CA);

  ok(
    "A's messages removed by cascade",
    (await countRaw(db, `SELECT count(*)::int AS n FROM "Message" WHERE "businessId" = $1`, A)) === 0
  );
  ok(
    "A's reply suggestions removed by cascade",
    (await countRaw(db, `SELECT count(*)::int AS n FROM "ReplySuggestion" WHERE "businessId" = $1`, A)) === 0
  );
  ok(
    "B's messages untouched",
    (await countRaw(db, `SELECT count(*)::int AS n FROM "Message" WHERE "businessId" = $1`, B)) === bBefore &&
      bBefore === 1
  );
  ok(
    "B's conversation untouched",
    (await countRaw(db, `SELECT count(*)::int AS n FROM "Conversation" WHERE id = $1`, CB)) === 1
  );

  // ---- rollback / reapply on the real branch ------------------------------
  console.log("\n== rollback / reapply ==");
  const before = await countRaw(db, `SELECT count(*)::int AS n FROM "Message"`);
  await runSqlFile(db, ROLLBACK);
  ok("rollback restored the single-column Message FK", !!(await fkDef(db, "Message", "Message_conversationId_fkey")));
  ok(
    "rollback removed the composite Message FK",
    (await fkDef(db, "Message", "Message_conversationId_businessId_fkey")) === null
  );
  ok("rollback preserved every data row", (await countRaw(db, `SELECT count(*)::int AS n FROM "Message"`)) === before);

  await runSqlFile(db, MIGRATION);
  ok(
    "reapply restored the composite Message FK",
    !!(await fkDef(db, "Message", "Message_conversationId_businessId_fkey"))
  );
  ok(
    "after reapply the cross-tenant write is denied again",
    (await err(() => insertMessage(db, A, CB))) !== null
  );

  // ---- no tenant-isolation regression -------------------------------------
  console.log("\n== RLS / privilege delta ==");
  const pol = await db.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM pg_policies
      WHERE schemaname='public' AND tablename IN ('Conversation','Message','ReplySuggestion','MessageAnalysis')`
  );
  console.log(`  policies on the Conversation subgraph = ${pol[0].n} (this wave changes none of them)`);
  const both = (readFileSync(MIGRATION, "utf8") + readFileSync(ROLLBACK, "utf8"))
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
  ok("applied artifacts contain zero GRANT", !/\bGRANT\b/i.test(both));
  ok("applied artifacts contain zero POLICY", !/\bPOLICY\b/i.test(both));
  ok("applied artifacts contain zero role change", !/\b(CREATE|ALTER|DROP)\s+ROLE\b/i.test(both));

  // ---- residue -------------------------------------------------------------
  ok("zero fixture residue on Preview", (await cleanup(db)) === 0);

  console.log(`\n[ad2a3-preview] PASS=${pass} FAIL=${fail}`);
  if (failures.length) console.log("FAILURES:\n  " + failures.join("\n  "));
  await db.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
