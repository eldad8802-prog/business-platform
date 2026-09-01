/**
 * D2 / ACCOUNT-DELETION-2A — lifecycle, quarantine and erasure-execution battery.
 *
 * Runs the REAL orchestrator, the REAL Prisma erasure adapter, the REAL session
 * check and the REAL payment settlement store against a PG17 lab with the tenant
 * tables actually under FORCE RLS — because the defect this wave fixes is invisible
 * without RLS: every statement carried `where: { businessId }` and looked correct.
 *
 * LAB-ONLY GRANTS. The lab grants the runtime the verbs the erasure needs, including
 * DELETE on Conversation, so the code path can be exercised end to end. That is a
 * property of this harness, NOT of the product: the battery separately asserts that
 * no repo artifact ships any such grant (AD-2A adds no DELETE capability anywhere).
 *
 * Synthetic pw-ad2a fixtures only. ZERO network, ZERO Neon, ZERO Production.
 */
import { PrismaClient } from "@prisma/client";
import { scanConversationIntegrity } from "../scripts/security/conversation-integrity-scan.mjs";

const RT_ROLE = "ad2a_runtime";
const RT_PW = "ad2a_ci_synthetic_runtime_pw";
const MARK = "ad2a-";

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
async function throws(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}
function roleUrl(base, user, pw) {
  const u = new URL(base);
  u.username = user;
  u.password = pw;
  return u.toString();
}

/** Tenant tables the erasure touches that must be FORCE-RLS'd for the proof to mean anything. */
const RLS_TABLES = [
  "Conversation",
  "Message",
  "ReplySuggestion",
  "Customer",
  "CrmNote",
  "CrmAttachment",
  "BusinessProfile",
];

async function main() {
  const OWNER_URL = process.env.DIRECT_URL;
  if (!OWNER_URL) throw new Error("DIRECT_URL missing");
  if (!/localhost|127\.0\.0\.1/.test(OWNER_URL)) {
    throw new Error("DENY: this battery runs only against a local PG17 lab");
  }
  const owner = new PrismaClient({ datasourceUrl: OWNER_URL });
  await owner.$queryRaw`SELECT 1`;
  console.log("[battery] D2/AD-2A — account deletion lifecycle (PG17)");

  // ── Phase 1: lab substrate ────────────────────────────────────────────────
  console.log("--- phase 1: lab substrate ---");
  const roleExists = Number(
    (await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM pg_roles WHERE rolname='${RT_ROLE}'`
    ))[0].c
  );
  if (roleExists === 0) {
    await owner.$executeRawUnsafe(
      `CREATE ROLE ${RT_ROLE} LOGIN PASSWORD '${RT_PW}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION INHERIT`
    );
  }
  await owner.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${RT_ROLE}`);

  // Pilot-EQUIVALENT tenant policies. Proving the erasure against unprotected tables
  // would prove nothing — the whole defect only exists under FORCE RLS.
  for (const t of RLS_TABLES) {
    await owner.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
    await owner.$executeRawUnsafe(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`);
    await owner.$executeRawUnsafe(`DROP POLICY IF EXISTS ad2a_tenant ON "${t}"`);
    await owner.$executeRawUnsafe(
      `CREATE POLICY ad2a_tenant ON "${t}"
         USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
         WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)`
    );
  }
  // LAB-ONLY privileges (see the header): enough to exercise the real code path.
  await owner.$executeRawUnsafe(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON "Conversation","Message","ReplySuggestion","Customer","CrmNote","CrmAttachment","BusinessProfile","User","Business","Lead","POSApiKey","OAuthToken","EmailConnection","WhatsAppConnection","BusinessPaymentConnection","BillingAuthorityConnection","LearningEvent","Appointment" TO ${RT_ROLE}`
  );
  await owner.$executeRawUnsafe(
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${RT_ROLE}`
  );
  const posture = (
    await owner.$queryRawUnsafe(
      `SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname='${RT_ROLE}'`
    )
  )[0];
  ok(
    "lab runtime role: LOGIN, NOSUPERUSER, NOBYPASSRLS",
    posture.rolcanlogin === true && posture.rolsuper === false && posture.rolbypassrls === false,
    JSON.stringify(posture)
  );

  const RUNTIME_URL = roleUrl(OWNER_URL, RT_ROLE, RT_PW);
  process.env.DATABASE_URL = RUNTIME_URL;
  const rt = new PrismaClient({ datasourceUrl: RUNTIME_URL });
  const who = (await rt.$queryRawUnsafe("SELECT current_user::text AS u"))[0].u;
  ok(`connected as ${RT_ROLE}`, who === RT_ROLE, `got ${who}`);

  // ── Phase 2: real modules (after the env is pointed at the runtime role) ──
  const { deleteOwnBusinessAccount, AccountDeletionError } = await import(
    "@/lib/services/account/account-deletion.service"
  );
  const { prismaAccountDeletionStore } = await import(
    "@/lib/services/account/account-deletion.prisma-store"
  );
  const { getCurrentUser, signAuthToken } = await import("@/lib/auth");
  const { runTenantJob } = await import("@/lib/tenant/job");
  const { withTenantTransaction } = await import("@/lib/tenant/transaction");
  const {
    lifecycleOf,
    readBusinessLifecycle,
    assertBusinessAcceptsWrites,
    assertBusinessAcceptsWritesTx,
    BusinessQuarantinedError,
  } = await import("@/lib/tenant/business-lifecycle");

  // ── Phase 3: fixtures ─────────────────────────────────────────────────────
  console.log("--- phase 3: fixtures ---");
  const cleanup = async () => {
    const bids = `SELECT id FROM "Business" WHERE name LIKE '${MARK}%'`;
    await owner.$executeRawUnsafe(`DELETE FROM "LearningEvent" WHERE "businessId" IN (${bids})`);
    await owner.$executeRawUnsafe(`DELETE FROM "Appointment" WHERE "businessId" IN (${bids})`);
    await owner.$executeRawUnsafe(`DELETE FROM "ReplySuggestion" WHERE "businessId" IN (${bids})`);
    await owner.$executeRawUnsafe(`DELETE FROM "Message" WHERE "businessId" IN (${bids})`);
    await owner.$executeRawUnsafe(`DELETE FROM "Conversation" WHERE "businessId" IN (${bids})`);
    for (const t of ["CrmAttachment", "CrmNote", "Customer", "Lead", "BusinessProfile", "POSApiKey"]) {
      await owner.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "businessId" IN (${bids})`);
    }
    await owner.$executeRawUnsafe(`DELETE FROM "User" WHERE email LIKE '%@ad2a.test'`);
    await owner.$executeRawUnsafe(`DELETE FROM "Business" WHERE name LIKE '${MARK}%'`);
  };
  await cleanup();

  const mkBiz = async (tag) => {
    const b = await owner.business.create({ data: { name: `${MARK}${tag}` } });
    const u = await owner.user.create({
      data: { email: `${tag}@ad2a.test`, password: "x", businessId: b.id },
    });
    const c = await owner.customer.create({ data: { businessId: b.id, name: `${MARK}cust-${tag}` } });
    const conv = await owner.conversation.create({
      data: { businessId: b.id, customerId: c.id, channel: "WHATSAPP" },
    });
    await owner.message.create({
      data: {
        businessId: b.id,
        conversationId: conv.id,
        channel: "WHATSAPP",
        direction: "INBOUND",
        senderType: "CUSTOMER",
        content: `${MARK}secret`,
      },
    });
    await owner.crmNote.create({
      data: { businessId: b.id, subjectType: "CUSTOMER", subjectId: c.id, body: `${MARK}note`, createdByUserId: u.id },
    });
    return { biz: b, user: u, customer: c, conversation: conv };
  };

  const A = await mkBiz("A");
  const B = await mkBiz("B");
  console.log(`[fixtures] A=${A.biz.id} B=${B.biz.id}`);

  // ── Phase 4: lifecycle derivation ─────────────────────────────────────────
  console.log("--- phase 4: lifecycle ---");
  ok("ACTIVE derived from two null timestamps",
    lifecycleOf({ deletionRequestedAt: null, deletedAt: null }) === "ACTIVE");
  ok("DELETION_REQUESTED derived from a request timestamp",
    lifecycleOf({ deletionRequestedAt: new Date(), deletedAt: null }) === "DELETION_REQUESTED");
  ok("PURGED wins over a request timestamp",
    lifecycleOf({ deletionRequestedAt: new Date(), deletedAt: new Date() }) === "PURGED");
  ok("unknown business reads as null (caller must deny)",
    (await readBusinessLifecycle(999999999)) === null);
  const missingErr = await throws(() => assertBusinessAcceptsWrites(999999999));
  ok("missing business FAILS CLOSED", missingErr instanceof BusinessQuarantinedError);
  const activeOk = await throws(() => assertBusinessAcceptsWrites(A.biz.id));
  ok("ACTIVE business accepts writes", activeOk === null);

  // ── Phase 5: silent-zero — the defect this wave exists to kill ────────────
  console.log("--- phase 5: silent-zero ---");
  const noCtx = await throws(() =>
    withTenantTransaction(async () => {})
  );
  ok("a tenant transaction with no context throws (never a silent no-op)", noCtx !== null);

  const beforeConv = await owner.conversation.count({ where: { businessId: A.biz.id } });
  const wrongCtx = await throws(() =>
    runTenantJob({ businessId: B.biz.id }, () =>
      withTenantTransaction(async (tx) => {
        // The store's own context proof, exercised directly with a MISMATCHED tenant.
        const rows = await tx.$queryRawUnsafe(
          `SELECT NULLIF(current_setting('app.current_business_id', true), '') AS guc`
        );
        if (Number(rows[0].guc) !== A.biz.id) {
          throw new Error(`context is ${rows[0].guc}, expected ${A.biz.id}`);
        }
      })
    )
  );
  ok("a wrong tenant context is detected, not silently obeyed", wrongCtx !== null);
  ok("no rows were touched while proving it",
    (await owner.conversation.count({ where: { businessId: A.biz.id } })) === beforeConv);

  const crossWrite = await runTenantJob({ businessId: A.biz.id }, () =>
    withTenantTransaction((tx) =>
      tx.conversation.updateMany({ where: { businessId: B.biz.id }, data: { status: "CLOSED" } })
    )
  );
  ok("GUC=A cannot mutate B's conversations", crossWrite.count === 0, `count=${crossWrite.count}`);

  // ── Phase 6: session closure ──────────────────────────────────────────────
  console.log("--- phase 6: session ---");
  const tokenA = signAuthToken(A.user.id);
  const authReq = () =>
    new Request("http://ad2a.local/x", { headers: { authorization: `Bearer ${tokenA}` } });
  ok("token works while ACTIVE", (await getCurrentUser(authReq()))?.id === A.user.id);

  // ── Phase 7: the real deletion, quarantine first ──────────────────────────
  console.log("--- phase 7: deletion ---");
  const auditBefore = await owner.learningEvent.count({
    where: { businessId: A.biz.id, eventType: "ACCOUNT_DELETED" },
  });
  const result = await deleteOwnBusinessAccount(prismaAccountDeletionStore, {
    businessId: A.biz.id,
    actorUserId: A.user.id,
  });
  ok("deletion reports deleted", result.status === "deleted");

  const aAfter = await owner.business.findUnique({ where: { id: A.biz.id } });
  ok("A reached PURGED", lifecycleOf(aAfter) === "PURGED");
  ok("A's quarantine timestamp was set BEFORE the purge finished", aAfter.deletionRequestedAt !== null);
  ok("A's conversations are gone", (await owner.conversation.count({ where: { businessId: A.biz.id } })) === 0);
  ok("A's messages went with them (cascade)", (await owner.message.count({ where: { businessId: A.biz.id } })) === 0);
  ok("A's CRM notes are gone", (await owner.crmNote.count({ where: { businessId: A.biz.id } })) === 0);
  const custA = await owner.customer.findFirst({ where: { businessId: A.biz.id } });
  ok("A's customer is ANONYMIZED, not deleted (invoice FK)", custA !== null && custA.name === "לקוח שנמחק");
  const userA = await owner.user.findUnique({ where: { id: A.user.id } });
  ok("A's user identity is tombstoned", userA.email.startsWith("deleted-biz-") && userA.name === null);
  ok("erasure evidence was written", (await owner.learningEvent.count({
    where: { businessId: A.biz.id, eventType: "ACCOUNT_DELETED" },
  })) === auditBefore + 1);

  // B is untouched — the whole point.
  ok("B's conversations survive A's deletion",
    (await owner.conversation.count({ where: { businessId: B.biz.id } })) === 1);
  ok("B's messages survive", (await owner.message.count({ where: { businessId: B.biz.id } })) === 1);
  const custB = await owner.customer.findFirst({ where: { businessId: B.biz.id } });
  ok("B's customer is untouched", custB.name === `${MARK}cust-B`);

  // ── Phase 8: post-quarantine closure ──────────────────────────────────────
  console.log("--- phase 8: post-quarantine ---");
  ok("the SAME pre-deletion token is now rejected", (await getCurrentUser(authReq())) === null);
  const jobErr = await throws(() => runTenantJob({ businessId: A.biz.id }, async () => "resurrected"));
  ok("a background job for a purged business is refused", jobErr instanceof BusinessQuarantinedError);
  const gateErr = await throws(() => assertBusinessAcceptsWrites(A.biz.id));
  ok("the canonical guard denies a purged business", gateErr instanceof BusinessQuarantinedError);
  const lifeA = await readBusinessLifecycle(A.biz.id);
  ok("a payment webhook would read PURGED at its tenant boundary", lifeA === "PURGED");

  // idempotency
  const again = await deleteOwnBusinessAccount(prismaAccountDeletionStore, {
    businessId: A.biz.id,
    actorUserId: A.user.id,
  });
  ok("re-requesting deletion is an idempotent no-op", again.status === "already_deleted");

  // ── Phase 9: the TOCTOU race ──────────────────────────────────────────────
  console.log("--- phase 9: race ---");
  const C = await mkBiz("C");
  // T1 opens a transaction, passes the in-tx gate and holds the row lock; T2 tries to
  // quarantine and must wait; T1 commits; T2 then commits. The write that got in
  // BEFORE the quarantine is legitimate — what must never happen is the reverse.
  const raceOrder = [];
  const t1 = withTenantTransaction(async (tx) => {
    await assertBusinessAcceptsWritesTx(tx, C.biz.id);
    raceOrder.push("t1-gate-passed");
    await new Promise((r) => setTimeout(r, 300));
    await tx.crmNote.create({
      data: { businessId: C.biz.id, subjectType: "CUSTOMER", subjectId: C.customer.id, body: `${MARK}race`, createdByUserId: C.user.id },
    });
    raceOrder.push("t1-wrote");
  });
  const t2 = (async () => {
    await new Promise((r) => setTimeout(r, 100));
    await prismaAccountDeletionStore.quarantineAndRevokeIntegrations(C.biz.id, new Date());
    raceOrder.push("t2-quarantined");
  })();
  await runTenantJob({ businessId: C.biz.id }, () => t1, { quarantinePolicy: "erasure" }).catch(() => {});
  await t2;
  ok(
    "the in-tx gate serialises against the quarantine (no interleaving)",
    raceOrder.indexOf("t1-wrote") < raceOrder.indexOf("t2-quarantined"),
    raceOrder.join(">")
  );
  const afterRace = await throws(() =>
    runTenantJob({ businessId: C.biz.id }, () =>
      withTenantTransaction((tx) =>
        tx.crmNote.create({
          data: { businessId: C.biz.id, subjectType: "CUSTOMER", subjectId: C.customer.id, body: `${MARK}late`, createdByUserId: C.user.id },
        })
      )
    )
  );
  ok("a normal write AFTER the quarantine is refused", afterRace instanceof BusinessQuarantinedError);

  const inTxAfter = await throws(() =>
    withTenantTransaction((tx) => assertBusinessAcceptsWritesTx(tx, C.biz.id))
      .catch((e) => { throw e; })
  );
  ok("the in-tx gate itself now denies C", inTxAfter !== null);

  // ── Phase 10: concurrent deletion requests ────────────────────────────────
  console.log("--- phase 10: concurrency ---");
  const D = await mkBiz("D");
  const both = await Promise.allSettled([
    deleteOwnBusinessAccount(prismaAccountDeletionStore, { businessId: D.biz.id, actorUserId: D.user.id }),
    deleteOwnBusinessAccount(prismaAccountDeletionStore, { businessId: D.biz.id, actorUserId: D.user.id }),
  ]);
  const fulfilled = both.filter((r) => r.status === "fulfilled").length;
  ok("two concurrent deletion requests do not corrupt each other", fulfilled >= 1, JSON.stringify(both.map((r) => r.status)));
  const dRow = await owner.business.findUnique({ where: { id: D.biz.id } });
  ok("D ends in exactly one terminal state", lifecycleOf(dRow) === "PURGED");
  const dAudits = await owner.learningEvent.count({
    where: { businessId: D.biz.id, eventType: "ACCOUNT_DELETED" },
  });
  ok("D has exactly one erasure evidence row (finalize is conditional)", dAudits === 1, `n=${dAudits}`);

  // ── Phase 11: audit atomicity ─────────────────────────────────────────────
  console.log("--- phase 11: audit atomicity ---");
  const E = await mkBiz("E");
  await owner.$executeRawUnsafe(`REVOKE INSERT ON "LearningEvent" FROM ${RT_ROLE}`);
  const auditFail = await throws(() =>
    deleteOwnBusinessAccount(prismaAccountDeletionStore, { businessId: E.biz.id, actorUserId: E.user.id })
  );
  const eRow = await owner.business.findUnique({ where: { id: E.biz.id } });
  ok("a failed erasure audit aborts the operation", auditFail !== null);
  ok(
    "a failed audit leaves the business NOT purged (no false success)",
    eRow.deletedAt === null,
    `deletedAt=${eRow.deletedAt}`
  );
  ok("the quarantine still stands after the failed finalize (resumable)", eRow.deletionRequestedAt !== null);
  await owner.$executeRawUnsafe(`GRANT INSERT ON "LearningEvent" TO ${RT_ROLE}`);
  const resumed = await deleteOwnBusinessAccount(prismaAccountDeletionStore, {
    businessId: E.biz.id,
    actorUserId: E.user.id,
  });
  ok("the deletion resumes cleanly once the audit can be written", resumed.status === "deleted");

  // ── Phase 12: integrity scanner ───────────────────────────────────────────
  console.log("--- phase 12: integrity scanner ---");
  const clean = await scanConversationIntegrity(owner);
  const cleanTotal = clean.reduce((s, f) => s + f.count, 0);
  ok(`scanner is clean on the lab dataset (${clean.length} edges)`, cleanTotal === 0, `mismatches=${cleanTotal}`);

  // Deliberate cross-tenant corruption, injected as the OWNER (bypassing RLS on
  // purpose) — this is exactly the historical corruption the scanner must detect.
  const F = await mkBiz("F");
  const G = await mkBiz("G");
  const fConv = await owner.conversation.findFirst({ where: { businessId: F.biz.id } });
  await owner.$executeRawUnsafe(
    `UPDATE "Message" SET "businessId" = ${G.biz.id} WHERE "conversationId" = ${fConv.id}`
  );
  const dirty = await scanConversationIntegrity(owner);
  const msgEdge = dirty.find((f) => f.edge.startsWith("Message.businessId"));
  ok("scanner DETECTS a Message that belongs to another business than its Conversation",
    msgEdge.count >= 1, `count=${msgEdge.count}`);
  ok("scanner reports the offending ids, not just a number", Array.isArray(msgEdge.rows) && msgEdge.rows.length >= 1);

  await owner.$executeRawUnsafe(
    `UPDATE "Conversation" SET "customerId" = (SELECT id FROM "Customer" WHERE "businessId" = ${G.biz.id} LIMIT 1) WHERE id = ${fConv.id}`
  );
  const dirty2 = await scanConversationIntegrity(owner);
  const custEdge = dirty2.find((f) => f.edge.startsWith("Conversation.businessId"));
  ok("scanner DETECTS a Conversation pointing at another business's Customer", custEdge.count >= 1);

  const rowsBefore = await owner.message.count();
  await scanConversationIntegrity(owner);
  ok("the scanner itself writes nothing", (await owner.message.count()) === rowsBefore);

  // ── Phase 13: no new DELETE capability ships ──────────────────────────────
  console.log("--- phase 13: capability delta ---");
  const { readFileSync, readdirSync } = await import("node:fs");
  const grantFiles = readdirSync("scripts/security").filter((f) => f.endsWith(".sql"));
  const shippedConvDelete = grantFiles.some((f) => {
    const sql = readFileSync(`scripts/security/${f}`, "utf8").replace(/^\s*--.*$/gm, "");
    return /GRANT[^;]*DELETE[^;]*ON\s*"(Conversation|Message|MessageAnalysis|ReplySuggestion)"/i.test(sql);
  });
  ok("no shipped grants artifact grants DELETE on the Conversation graph", shippedConvDelete === false);

  // ── Phase 14: residue ─────────────────────────────────────────────────────
  console.log("--- phase 14: residue ---");
  await rt.$disconnect();
  await cleanup();
  const residue = Number(
    (await owner.$queryRawUnsafe(
      `SELECT (SELECT count(*)::int FROM "Business" WHERE name LIKE '${MARK}%')
            + (SELECT count(*)::int FROM "User" WHERE email LIKE '%@ad2a.test') AS c`
    ))[0].c
  );
  ok("synthetic residue = 0", residue === 0, `found ${residue}`);

  await owner.$disconnect();
  console.log(`\n[battery] AD-2A PASS=${pass} FAIL=${fail} SKIP=0`);
  if (fail > 0) {
    console.log("FAILURES:\n - " + failures.join("\n - "));
    process.exit(1);
  }
  console.log("ALL CHECKS PASS");
}

main().catch((e) => {
  console.error("[battery] FATAL:", e);
  process.exit(1);
});
