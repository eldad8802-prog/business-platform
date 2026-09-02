/**
 * D2 / ACCOUNT-DELETION-2A.3 — structural tenant-coherence proof on canonical Preview.
 *
 * Preview already sits at the PRE-migration state (single-column Conversation FKs),
 * so unlike the PG17 battery this script does not have to roll back first — it
 * migrates forward for real and proves the invariant against the real Preview schema.
 *
 * The attacks run as the OWNER role. That is deliberate and is the STRONGER claim:
 * a foreign key is not a privilege check, so if the most privileged role in the
 * database cannot persist a cross-tenant child, no application role can either.
 * The restricted runtime role is separately proven to still be NOSUPERUSER /
 * NOBYPASSRLS / non-owner, read-only, so this wave demonstrably did not relax it.
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

async function runSqlFile(db, file) {
  const stmts = readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
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

const msg = (businessId, conversationId, extra = {}) => ({
  businessId,
  conversationId,
  channel: "WHATSAPP",
  direction: "INBOUND",
  senderType: "CUSTOMER",
  contentText: "ad2a3-prev",
  ...extra,
});
const sug = (businessId, conversationId, extra = {}) => ({
  businessId,
  conversationId,
  suggestionType: "AUTO",
  strategyType: "x",
  variantType: "default",
  text: "ad2a3-prev",
  status: "GENERATED",
  ...extra,
});

async function cleanup(db) {
  const ids = await db.business.findMany({
    where: { name: { startsWith: "ad2a3-prev-" } },
    select: { id: true },
  });
  const list = ids.map((b) => b.id);
  if (list.length) {
    await db.messageAnalysis.deleteMany({ where: { message: { businessId: { in: list } } } });
    await db.replySuggestion.deleteMany({ where: { businessId: { in: list } } });
    await db.message.deleteMany({ where: { businessId: { in: list } } });
    await db.conversation.deleteMany({ where: { businessId: { in: list } } });
    await db.business.deleteMany({ where: { id: { in: list } } });
  }
  return (await db.business.count({ where: { name: { startsWith: "ad2a3-prev-" } } }));
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
    `SELECT current_database() AS db, current_user::text AS role, inet_server_addr()::text AS addr`
  );
  console.log(`  database=${who[0].db} role=${who[0].role}`);
  ok("connected to the neondb database", who[0].db === "neondb");

  // ---- the restricted runtime role must be untouched by this wave ----------
  const role = await db.$queryRawUnsafe(
    `SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = $1`,
    RUNTIME_ROLE
  );
  if (role.length === 0) {
    ok(`runtime role ${RUNTIME_ROLE} present`, false, "role not found on this branch");
  } else {
    ok(`${RUNTIME_ROLE} is NOSUPERUSER`, role[0].rolsuper === false);
    ok(`${RUNTIME_ROLE} is NOBYPASSRLS`, role[0].rolbypassrls === false);
    ok(`${RUNTIME_ROLE} is not the table owner (owner is a separate role)`, role[0].rolname !== who[0].role);
  }

  // ---- preflight before any DDL -------------------------------------------
  console.log("\n== preflight (SELECT only) ==");
  await cleanup(db);
  const pre = await preflightConversationCoherence(db);
  reportPreflight(pre);
  ok("Preview preflight is clean, so the migration may be applied", pre.ok === true);
  ok("all four composite-key columns are NOT NULL on Preview", pre.nullable.length === 0);

  // ---- apply --------------------------------------------------------------
  console.log("\n== apply the real migration ==");
  const n = await runSqlFile(db, MIGRATION);
  ok(`migration applied to Preview (${n} statements)`, n > 0);

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

  // ---- attacks on the real Preview schema ---------------------------------
  console.log("\n== cross-tenant attacks (as OWNER — the strongest form of the claim) ==");
  const A = await db.business.create({ data: { name: "ad2a3-prev-A" } });
  const B = await db.business.create({ data: { name: "ad2a3-prev-B" } });
  const CA = await db.conversation.create({ data: { businessId: A.id, channel: "WHATSAPP" } });
  const CB = await db.conversation.create({ data: { businessId: B.id, channel: "WHATSAPP" } });

  const mA = await db.message.create({ data: msg(A.id, CA.id) });
  ok("valid same-tenant Message accepted", !!mA?.id);
  ok("cross-tenant Message DENIED", (await err(() => db.message.create({ data: msg(B.id, CA.id) }))) !== null);

  const rA = await db.replySuggestion.create({ data: sug(A.id, CA.id, { messageId: mA.id }) });
  ok("valid same-tenant ReplySuggestion accepted", !!rA?.id);
  ok(
    "cross-tenant ReplySuggestion DENIED",
    (await err(() => db.replySuggestion.create({ data: sug(B.id, CA.id) }))) !== null
  );
  ok(
    "raw-SQL cross-tenant Message INSERT DENIED",
    (await err(() =>
      db.$executeRawUnsafe(
        `INSERT INTO "Message" ("conversationId","businessId","channel","direction","senderType","sentAt","createdAt")
         VALUES (${CA.id}, ${B.id}, 'WHATSAPP','INBOUND','CUSTOMER', now(), now())`
      )
    )) !== null
  );
  ok(
    "UPDATE Message.businessId across tenants DENIED",
    (await err(() => db.message.update({ where: { id: mA.id }, data: { businessId: B.id } }))) !== null
  );
  ok(
    "UPDATE Message.conversationId onto another tenant DENIED",
    (await err(() => db.message.update({ where: { id: mA.id }, data: { conversationId: CB.id } }))) !== null
  );
  ok(
    "Prisma nested write with a mismatched tenant DENIED",
    (await err(() =>
      db.conversation.update({ where: { id: CA.id }, data: { messages: { create: [msg(B.id, CA.id)] } } })
    )) !== null
  );

  // ---- cascade stays tenant-bounded ---------------------------------------
  console.log("\n== cascade ==");
  const mB = await db.message.create({ data: msg(B.id, CB.id) });
  await db.conversation.delete({ where: { id: CA.id } });
  ok("A's messages removed by cascade", (await db.message.count({ where: { businessId: A.id } })) === 0);
  ok("A's suggestions removed by cascade", (await db.replySuggestion.count({ where: { businessId: A.id } })) === 0);
  ok("B's message untouched", (await db.message.count({ where: { id: mB.id } })) === 1);
  ok("B's conversation untouched", (await db.conversation.count({ where: { id: CB.id } })) === 1);

  // ---- rollback / reapply on the real branch ------------------------------
  console.log("\n== rollback / reapply ==");
  const before = await db.message.count();
  await runSqlFile(db, ROLLBACK);
  ok(
    "rollback restored the single-column Message FK",
    !!(await fkDef(db, "Message", "Message_conversationId_fkey"))
  );
  ok(
    "rollback removed the composite Message FK",
    (await fkDef(db, "Message", "Message_conversationId_businessId_fkey")) === null
  );
  ok("rollback preserved every data row", (await db.message.count()) === before);

  await runSqlFile(db, MIGRATION);
  ok(
    "reapply restored the composite Message FK",
    !!(await fkDef(db, "Message", "Message_conversationId_businessId_fkey"))
  );
  ok(
    "after reapply the cross-tenant write is denied again",
    (await err(() => db.message.create({ data: msg(A.id, CB.id) }))) !== null
  );

  // ---- no tenant-isolation regression -------------------------------------
  console.log("\n== RLS / privilege delta ==");
  const pol = await db.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM pg_policies
      WHERE schemaname='public' AND tablename IN ('Conversation','Message','ReplySuggestion','MessageAnalysis')`
  );
  console.log(`  policies on the Conversation subgraph = ${pol[0].n} (unchanged by this wave)`);
  const both = (readFileSync(MIGRATION, "utf8") + readFileSync(ROLLBACK, "utf8"))
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
  ok("applied artifacts contain zero GRANT", !/\bGRANT\b/i.test(both));
  ok("applied artifacts contain zero POLICY", !/\bPOLICY\b/i.test(both));
  ok("applied artifacts contain zero role change", !/\b(CREATE|ALTER|DROP)\s+ROLE\b/i.test(both));

  // ---- residue -------------------------------------------------------------
  const residue = await cleanup(db);
  ok("zero fixture residue on Preview", residue === 0);

  console.log(`\n[ad2a3-preview] PASS=${pass} FAIL=${fail}`);
  if (failures.length) console.log("FAILURES:\n  " + failures.join("\n  "));
  await db.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
