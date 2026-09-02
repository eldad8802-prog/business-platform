/**
 * D2 / ACCOUNT-DELETION-2A.3 — structural tenant-coherence battery (ephemeral PG17).
 *
 * Proves the invariant is RELATIONAL, not behavioural: with the composite FKs in
 * place it is impossible to persist a Message or a ReplySuggestion that hangs off
 * another tenant's Conversation — via Prisma, via nested writes, via raw SQL, on
 * INSERT and on UPDATE alike.
 *
 * The cycle exercises the REAL artifacts:
 *   db push (new schema)
 *     -> apply scripts/security/d2-ad2a3-rollback.sql   [reach the PRE-migration state]
 *     -> catalog verify OLD
 *     -> preflight (SELECT only) + prove it detects real corruption
 *     -> apply prisma/migrations/.../migration.sql       [the REAL migration]
 *     -> catalog verify NEW
 *     -> adversarial matrix + cascade proof
 *     -> rollback -> catalog verify OLD + data preserved
 *     -> reapply  -> catalog verify NEW + attacks still denied
 *
 * Synthetic ad2a3- fixtures only. ZERO network, ZERO Neon, ZERO Production.
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  preflightConversationCoherence,
  reportPreflight,
} from "../scripts/security/conversation-coherence-preflight.mjs";

const MIGRATION =
  "prisma/migrations/20260902090000_d2_ad2a3_conversation_tenant_coherence/migration.sql";
const ROLLBACK = "scripts/security/d2-ad2a3-rollback.sql";

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
  const sql = readFileSync(file, "utf8");
  const stmts = sql
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

async function verifyCatalogNew(db, label) {
  const m = await fkDef(db, "Message", "Message_conversationId_businessId_fkey");
  const r = await fkDef(db, "ReplySuggestion", "ReplySuggestion_conversationId_businessId_fkey");
  const oldM = await fkDef(db, "Message", "Message_conversationId_fkey");
  const oldR = await fkDef(db, "ReplySuggestion", "ReplySuggestion_conversationId_fkey");
  const uq = await indexDef(db, "Conversation_id_businessId_key");
  const ix = await indexDef(db, "ReplySuggestion_conversationId_businessId_idx");

  ok(
    `${label}: Message composite FK is on (conversationId, businessId)`,
    !!m && /"conversationId", "businessId"/.test(m) && /REFERENCES "Conversation"/.test(m),
    String(m)
  );
  ok(`${label}: Message composite FK keeps ON DELETE CASCADE`, !!m && /ON DELETE CASCADE/.test(m), String(m));
  ok(
    `${label}: ReplySuggestion composite FK is on (conversationId, businessId)`,
    !!r && /"conversationId", "businessId"/.test(r) && /REFERENCES "Conversation"/.test(r),
    String(r)
  );
  ok(`${label}: ReplySuggestion composite FK keeps ON DELETE CASCADE`, !!r && /ON DELETE CASCADE/.test(r), String(r));
  ok(`${label}: the old single-column Message FK is GONE`, oldM === null, String(oldM));
  ok(`${label}: the old single-column ReplySuggestion FK is GONE`, oldR === null, String(oldR));
  ok(`${label}: Conversation(id, businessId) unique index exists (the FK target)`, !!uq && /UNIQUE/.test(uq), String(uq));
  ok(`${label}: ReplySuggestion cascade-support index exists`, !!ix, String(ix));
}

async function verifyCatalogOld(db, label) {
  const m = await fkDef(db, "Message", "Message_conversationId_fkey");
  const r = await fkDef(db, "ReplySuggestion", "ReplySuggestion_conversationId_fkey");
  const newM = await fkDef(db, "Message", "Message_conversationId_businessId_fkey");
  const newR = await fkDef(db, "ReplySuggestion", "ReplySuggestion_conversationId_businessId_fkey");
  const uq = await indexDef(db, "Conversation_id_businessId_key");
  ok(`${label}: single-column Message FK present`, !!m && /"conversationId"/.test(m), String(m));
  ok(`${label}: single-column ReplySuggestion FK present`, !!r && /"conversationId"/.test(r), String(r));
  ok(`${label}: composite Message FK absent`, newM === null, String(newM));
  ok(`${label}: composite ReplySuggestion FK absent`, newR === null, String(newR));
  ok(`${label}: composite parent unique index absent`, uq === null, String(uq));
}

async function seed(db, tag) {
  const A = await db.business.create({ data: { name: `ad2a3-${tag}-A` } });
  const B = await db.business.create({ data: { name: `ad2a3-${tag}-B` } });
  const CA = await db.conversation.create({ data: { businessId: A.id, channel: "WHATSAPP" } });
  const CB = await db.conversation.create({ data: { businessId: B.id, channel: "WHATSAPP" } });
  return { A, B, CA, CB };
}

const msg = (businessId, conversationId, extra = {}) => ({
  businessId,
  conversationId,
  channel: "WHATSAPP",
  direction: "INBOUND",
  senderType: "CUSTOMER",
  contentText: "ad2a3",
  ...extra,
});
const sug = (businessId, conversationId, extra = {}) => ({
  businessId,
  conversationId,
  suggestionType: "AUTO",
  strategyType: "x",
  variantType: "default",
  text: "ad2a3",
  status: "GENERATED",
  ...extra,
});

async function main() {
  const url = process.env.OWNER_URL;
  if (!url) {
    console.error("OWNER_URL required");
    process.exit(2);
  }
  for (const d of ["ep-flat-brook-am4bhq1y", "ep-winter-bread-ami5o8p5"]) {
    if (url.includes(d)) {
      console.error("REFUSING: target matches the Production deny-list");
      process.exit(2);
    }
  }
  const db = new PrismaClient({ datasourceUrl: url });

  // ---- 0. reach the PRE-migration state by running the real rollback -------
  console.log("\n== 0. rollback to the pre-migration baseline ==");
  const rbN = await runSqlFile(db, ROLLBACK);
  ok(`rollback artifact executed (${rbN} statements)`, rbN > 0);
  await verifyCatalogOld(db, "baseline");

  // ---- 1. preflight on the pre-migration schema ----------------------------
  console.log("\n== 1. preflight (SELECT only) ==");
  const pre = await preflightConversationCoherence(db);
  reportPreflight(pre);
  ok("preflight passes on a coherent database", pre.ok === true);
  ok(
    "preflight confirms all four key columns are NOT NULL",
    pre.nullable.length === 0,
    JSON.stringify(pre.nullable)
  );

  // ---- 2. the exposure is real before the migration ------------------------
  console.log("\n== 2. the hole this migration closes is real ==");
  {
    const { A, B, CA } = await seed(db, "pre");
    const bad = await err(() => db.message.create({ data: msg(B.id, CA.id) }));
    ok(
      "BEFORE the migration a cross-tenant Message IS accepted (this is the exposure)",
      bad === null,
      String(bad?.message).slice(0, 140)
    );
    const scan = await preflightConversationCoherence(db);
    const mm = scan.checks.find((c) => c.key === "message_business_mismatch");
    ok("preflight DETECTS the cross-tenant Message", mm.violations === 1, JSON.stringify(mm.sample));
    ok("preflight therefore reports NOT-OK, blocking the migration", scan.ok === false);

    await db.message.deleteMany({ where: { businessId: B.id } });
    await db.conversation.deleteMany({ where: { businessId: { in: [A.id, B.id] } } });
    await db.business.deleteMany({ where: { id: { in: [A.id, B.id] } } });
    const after = await preflightConversationCoherence(db);
    ok("preflight is clean again once the violating row is gone", after.ok === true);
  }

  // ---- 3. apply the REAL migration -----------------------------------------
  console.log("\n== 3. apply the real migration ==");
  const mgN = await runSqlFile(db, MIGRATION);
  ok(`migration executed (${mgN} statements)`, mgN > 0);
  await verifyCatalogNew(db, "applied");

  // ---- 4. adversarial matrix ----------------------------------------------
  console.log("\n== 4. adversarial matrix ==");
  const { A, B, CA, CB } = await seed(db, "atk");

  const mA = await db.message.create({ data: msg(A.id, CA.id) });
  ok("1. valid Message(A, CA) accepted", !!mA?.id);

  const e2 = await err(() => db.message.create({ data: msg(B.id, CA.id) }));
  ok("2. cross-tenant Message(B, CA) DENIED by the database", e2 !== null);

  const rA = await db.replySuggestion.create({ data: sug(A.id, CA.id, { messageId: mA.id }) });
  ok("3. valid ReplySuggestion(A, CA) accepted", !!rA?.id);

  const e4 = await err(() => db.replySuggestion.create({ data: sug(B.id, CA.id) }));
  ok("4. cross-tenant ReplySuggestion(B, CA) DENIED", e4 !== null);

  const an = await db.messageAnalysis.create({ data: { messageId: mA.id, intent: "x", stage: "y" } });
  ok("5. MessageAnalysis under a coherent Message accepted", !!an?.id);

  const e6 = await err(() =>
    db.$executeRawUnsafe(
      `INSERT INTO "Message" ("conversationId","businessId","channel","direction","senderType","contentText","sentAt","createdAt")
       VALUES (${CA.id}, ${B.id}, 'WHATSAPP','INBOUND','CUSTOMER','raw', now(), now())`
    )
  );
  ok("6. RAW SQL cross-tenant Message INSERT DENIED (Prisma bypassed entirely)", e6 !== null);

  const e7 = await err(() =>
    db.$executeRawUnsafe(
      `INSERT INTO "ReplySuggestion" ("businessId","conversationId","suggestionType","strategyType","variantType","text","status","createdAt")
       VALUES (${B.id}, ${CA.id}, 'AUTO','x','default','raw','GENERATED', now())`
    )
  );
  ok("7. RAW SQL cross-tenant ReplySuggestion INSERT DENIED", e7 !== null);

  const e8 = await err(() => db.message.update({ where: { id: mA.id }, data: { businessId: B.id } }));
  ok("8. UPDATE Message.businessId A->B DENIED", e8 !== null);

  const e9 = await err(() => db.message.update({ where: { id: mA.id }, data: { conversationId: CB.id } }));
  ok("9. UPDATE Message.conversationId onto B's conversation while keeping businessId A DENIED", e9 !== null);

  const e10 = await err(() => db.replySuggestion.update({ where: { id: rA.id }, data: { businessId: B.id } }));
  ok("10. UPDATE ReplySuggestion.businessId mismatch DENIED", e10 !== null);

  const e11 = await err(() => db.replySuggestion.update({ where: { id: rA.id }, data: { conversationId: CB.id } }));
  ok("11. UPDATE ReplySuggestion.conversationId mismatch DENIED", e11 !== null);

  const e12 = await err(() =>
    db.conversation.update({ where: { id: CA.id }, data: { messages: { create: [msg(B.id, CA.id)] } } })
  );
  ok("12. Prisma NESTED write carrying a mismatched tenant DENIED", e12 !== null);

  // 13/14 — the nullable question. Both children have conversationId AND businessId
  // NOT NULL, so the MATCH SIMPLE partial-null bypass is unreachable by construction.
  // Prove it from the catalog rather than asserting it.
  const nn = await db.$queryRawUnsafe(
    `SELECT table_name, column_name, is_nullable FROM information_schema.columns
      WHERE table_schema='public'
        AND ((table_name='Message' AND column_name IN ('businessId','conversationId'))
          OR (table_name='ReplySuggestion' AND column_name IN ('businessId','conversationId')))`
  );
  ok(
    "13/14. all four composite-key columns are NOT NULL, so MATCH SIMPLE cannot be bypassed with a partial key",
    nn.length === 4 && nn.every((r) => r.is_nullable === "NO"),
    JSON.stringify(nn)
  );
  const e14 = await err(() =>
    db.$executeRawUnsafe(
      `INSERT INTO "Message" ("conversationId","businessId","channel","direction","senderType","sentAt","createdAt")
       VALUES (${CA.id}, NULL, 'WHATSAPP','INBOUND','CUSTOMER', now(), now())`
    )
  );
  ok("14b. a NULL businessId partial key is rejected by NOT NULL, so the bypass is unreachable", e14 !== null);

  const mA2 = await db.message.create({ data: msg(A.id, CA.id, { contentText: "second" }) });
  ok("15. a second valid same-tenant Message is still accepted (no false positives)", !!mA2?.id);

  // ---- 5. cascade proof ----------------------------------------------------
  console.log("\n== 5. cascade proof ==");
  const mB = await db.message.create({ data: msg(B.id, CB.id) });
  const rB = await db.replySuggestion.create({ data: sug(B.id, CB.id) });
  const anB = await db.messageAnalysis.create({ data: { messageId: mB.id, intent: "x", stage: "y" } });
  const beforeB = await db.message.count({ where: { businessId: B.id } });

  await db.conversation.delete({ where: { id: CA.id } });

  ok("cascade removed A's messages", (await db.message.count({ where: { businessId: A.id } })) === 0);
  ok("cascade removed A's reply suggestions", (await db.replySuggestion.count({ where: { businessId: A.id } })) === 0);
  ok(
    "cascade removed A's MessageAnalysis (ownership derived through Message)",
    (await db.messageAnalysis.count({ where: { id: an.id } })) === 0
  );
  ok("B's messages untouched", (await db.message.count({ where: { businessId: B.id } })) === beforeB && beforeB === 1);
  ok("B's reply suggestion untouched", (await db.replySuggestion.count({ where: { id: rB.id } })) === 1);
  ok("B's message analysis untouched", (await db.messageAnalysis.count({ where: { id: anB.id } })) === 1);
  ok("B's conversation untouched", (await db.conversation.count({ where: { id: CB.id } })) === 1);
  ok(
    "no cross-tenant descendant could exist for the cascade to reach in the first place",
    e2 !== null && e4 !== null && e6 !== null && e7 !== null
  );

  // ---- 6. rollback preserves data, reapply restores the invariant ----------
  console.log("\n== 6. rollback / reapply ==");
  const survivors = await db.message.count();
  await runSqlFile(db, ROLLBACK);
  await verifyCatalogOld(db, "rolled back");
  ok("rollback preserved every data row", (await db.message.count()) === survivors);

  await runSqlFile(db, MIGRATION);
  await verifyCatalogNew(db, "reapplied");
  const e2b = await err(() => db.message.create({ data: msg(A.id, CB.id) }));
  ok("after reapply the cross-tenant write is denied again", e2b !== null);

  // ---- 7. privilege / RLS delta must be zero -------------------------------
  console.log("\n== 7. privilege + RLS delta ==");
  const both = readFileSync(MIGRATION, "utf8") + readFileSync(ROLLBACK, "utf8");
  const code = both
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
  ok("migration + rollback contain ZERO GRANT", !/\bGRANT\b/i.test(code));
  ok("migration + rollback contain ZERO POLICY", !/\bPOLICY\b/i.test(code));
  ok("migration + rollback contain ZERO ROW LEVEL SECURITY change", !/ROW LEVEL SECURITY/i.test(code));
  ok("migration + rollback contain ZERO role change", !/\b(CREATE|ALTER|DROP)\s+ROLE\b/i.test(code));
  ok("migration + rollback contain ZERO BYPASSRLS", !/BYPASSRLS/i.test(code));
  ok("migration + rollback contain ZERO SECURITY DEFINER", !/SECURITY\s+DEFINER/i.test(code));
  ok("migration + rollback contain ZERO DELETE grant", !/GRANT[^;]*DELETE/i.test(code));

  // ---- cleanup -------------------------------------------------------------
  await db.messageAnalysis.deleteMany({});
  await db.replySuggestion.deleteMany({ where: { businessId: { in: [A.id, B.id] } } });
  await db.message.deleteMany({ where: { businessId: { in: [A.id, B.id] } } });
  await db.conversation.deleteMany({ where: { businessId: { in: [A.id, B.id] } } });
  await db.business.deleteMany({ where: { name: { startsWith: "ad2a3-" } } });
  ok("zero fixture residue", (await db.business.count({ where: { name: { startsWith: "ad2a3-" } } })) === 0);

  console.log(`\n[ad2a3] PASS=${pass} FAIL=${fail}`);
  if (failures.length) console.log("FAILURES:\n  " + failures.join("\n  "));
  await db.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
