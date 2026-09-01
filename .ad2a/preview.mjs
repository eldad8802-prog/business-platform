/**
 * D2 / ACCOUNT-DELETION-2A.1 — Preview proof (Neon branch DB, PREVIEW ONLY).
 *
 * The PG17 battery proves the code against an ephemeral lab where the harness grants
 * itself whatever the erasure needs. This proves it against the REAL Preview schema,
 * the REAL Neon pooler, and — the part that matters — the REAL restricted runtime
 * role `app_runtime_preview_p4b` (NOSUPERUSER, NOBYPASSRLS, non-owner).
 *
 * EVERY app module runs as that restricted role. `lib/prisma.ts` binds its URL when
 * the module is first imported, so there is no honest way to switch identity halfway
 * through — and switching would defeat the point. The owner connection is used ONLY
 * to build and tear down synthetic fixtures and to read catalogs.
 *
 * WHAT THIS MEANS FOR THE ERASURE. Under the restricted role the erasure CANNOT
 * complete: it needs Business.UPDATE, User.UPDATE, POSApiKey.DELETE and
 * Conversation.DELETE, none of which that role holds — and it must not, because
 * Business and User carry no RLS, so write privilege there would be a cross-tenant
 * capability. That gap is the AD-2A.1 Gate-C residue. This battery MEASURES it
 * instead of papering over it, and proves the thing that actually matters about a
 * blocked erasure: it fails LOUDLY at the first denial and leaves the tenant
 * completely untouched and still ACTIVE, so the request is safely retryable once the
 * authority exists. Granting those privileges here would destroy the evidence.
 *
 * Synthetic `ad2a-prev-` fixtures only, cleaned at the end. ZERO real customer data,
 * ZERO Production. The endpoint deny-list aborts on the Production endpoints.
 */
import { PrismaClient } from "@prisma/client";
import { scanConversationIntegrity } from "../scripts/security/conversation-integrity-scan.mjs";

const MARK = "ad2a-prev-";
const RT_ROLE = "app_runtime_preview_p4b";
const EXPECT_ENDPOINT = "ep-wispy-dawn-amr74bwz";
const DENY_ENDPOINTS = ["ep-flat-brook-am4bhq1y", "ep-winter-bread-ami5o8p5"];

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
/** An expected, DESIGNED denial. Recorded as evidence for Gate C, not as a failure. */
function blocked(name, cond, detail = "") {
  ok(`[expected-blocked] ${name}`, cond, detail);
}
async function throws(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}
function assertEndpointSafety(url, label) {
  for (const bad of DENY_ENDPOINTS) {
    if (url.includes(bad)) throw new Error(`DENY: ${label} points at a forbidden endpoint (${bad})`);
  }
  if (!url.includes(EXPECT_ENDPOINT)) {
    throw new Error(`DENY: ${label} is not the approved Preview endpoint`);
  }
}

async function main() {
  const OWNER_URL = process.env.DIRECT_URL;
  const RUNTIME_URL = process.env.RUNTIME_URL;
  if (!OWNER_URL) throw new Error("DIRECT_URL missing");
  if (!RUNTIME_URL) throw new Error("RUNTIME_URL missing");
  assertEndpointSafety(OWNER_URL, "DIRECT_URL");
  assertEndpointSafety(RUNTIME_URL, "RUNTIME_URL");

  // Bind the app's singleton to the RESTRICTED role before any app module loads.
  process.env.DATABASE_URL = RUNTIME_URL;

  const owner = new PrismaClient({ datasourceUrl: OWNER_URL });
  const rt = new PrismaClient({ datasourceUrl: RUNTIME_URL });

  // ── Phase 1: identity ─────────────────────────────────────────────────────
  console.log("--- phase 1: identity ---");
  const db = (await owner.$queryRawUnsafe("SELECT current_database() AS db"))[0].db;
  ok(`database is neondb (got ${db})`, db === "neondb");
  const who = (await rt.$queryRawUnsafe("SELECT current_user::text AS u"))[0].u;
  ok(`app connection is ${RT_ROLE}`, who === RT_ROLE, `got ${who}`);
  const posture = (
    await owner.$queryRawUnsafe(
      `SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname='${RT_ROLE}'`
    )
  )[0];
  ok(
    "runtime role: NOSUPERUSER, NOBYPASSRLS, LOGIN",
    posture && posture.rolsuper === false && posture.rolbypassrls === false && posture.rolcanlogin === true,
    JSON.stringify(posture)
  );
  const owns = Number(
    (
      await owner.$queryRawUnsafe(
        `SELECT count(*)::int AS c FROM pg_class c JOIN pg_roles r ON c.relowner=r.oid WHERE r.rolname='${RT_ROLE}'`
      )
    )[0].c
  );
  ok("runtime role owns no relation", owns === 0, `owns ${owns}`);

  // ── Phase 2: Gate-C residue, measured ─────────────────────────────────────
  console.log("--- phase 2: residue privileges (Gate C evidence) ---");
  const res = (
    await owner.$queryRawUnsafe(
      `SELECT has_table_privilege('${RT_ROLE}', '"Business"', 'UPDATE') AS biz_upd,
              has_table_privilege('${RT_ROLE}', '"User"', 'UPDATE') AS usr_upd,
              has_table_privilege('${RT_ROLE}', '"POSApiKey"', 'UPDATE') AS pos_upd,
              has_table_privilege('${RT_ROLE}', '"POSApiKey"', 'DELETE') AS pos_del,
              has_table_privilege('${RT_ROLE}', '"Conversation"', 'DELETE') AS conv_del,
              has_table_privilege('${RT_ROLE}', '"PlatformAuditEvent"', 'INSERT') AS audit_ins`
    )
  )[0];
  blocked("runtime cannot UPDATE Business", res.biz_upd === false);
  blocked("runtime cannot UPDATE User", res.usr_upd === false);
  blocked("runtime cannot DELETE POSApiKey", res.pos_del === false);
  blocked("runtime cannot DELETE Conversation (AD-2B is not authorized)", res.conv_del === false);
  blocked("runtime cannot INSERT PlatformAuditEvent", res.audit_ins === false);
  console.log(`[residue] POSApiKey.UPDATE available to the runtime = ${res.pos_upd}`);

  // ── Phase 3: real modules (now bound to the restricted role) ──────────────
  const { deleteOwnBusinessAccount } = await import("@/lib/services/account/account-deletion.service");
  const { prismaAccountDeletionStore } = await import("@/lib/services/account/account-deletion.prisma-store");
  const { getCurrentUser, signAuthToken } = await import("@/lib/auth");
  const { runTenantJob } = await import("@/lib/tenant/job");
  const { withTenantTransaction } = await import("@/lib/tenant/transaction");
  const { lifecycleOf, readBusinessLifecycle, assertBusinessAcceptsWrites, BusinessQuarantinedError } =
    await import("@/lib/tenant/business-lifecycle");

  // ── Phase 4: synthetic fixtures (owner) ───────────────────────────────────
  console.log("--- phase 4: fixtures ---");
  const cleanup = async () => {
    const bids = `SELECT id FROM "Business" WHERE name LIKE '${MARK}%'`;
    await owner.$executeRawUnsafe(`DELETE FROM "LearningEvent" WHERE "businessId" IN (${bids})`);
    await owner.$executeRawUnsafe(`DELETE FROM "Message" WHERE "businessId" IN (${bids})`);
    await owner.$executeRawUnsafe(`DELETE FROM "Conversation" WHERE "businessId" IN (${bids})`);
    for (const t of ["CrmAttachment", "CrmNote", "Customer", "POSApiKey"]) {
      await owner.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "businessId" IN (${bids})`);
    }
    await owner.$executeRawUnsafe(`DELETE FROM "User" WHERE email LIKE '%@ad2a-prev.test'`);
    await owner.$executeRawUnsafe(`DELETE FROM "Business" WHERE name LIKE '${MARK}%'`);
  };
  await cleanup();

  const mkBiz = async (tag) => {
    const b = await owner.business.create({ data: { name: `${MARK}${tag}` } });
    const u = await owner.user.create({
      data: { email: `${tag}@ad2a-prev.test`, password: "x", businessId: b.id },
    });
    const c = await owner.customer.create({ data: { businessId: b.id, name: `${MARK}cust-${tag}` } });
    const conv = await owner.conversation.create({
      data: { businessId: b.id, customerId: c.id, channel: "WHATSAPP" },
    });
    // Raw INSERT, deliberately: Preview lags main by the W2.5 Message columns, and the
    // generated Prisma client would name a column this database does not have yet. None
    // of the security assertions depend on those columns, so the fixture names only what
    // exists rather than mutating Preview to satisfy a test.
    await owner.$executeRawUnsafe(
      `INSERT INTO "Message" ("businessId","conversationId","channel","direction","senderType","contentText","createdAt")
       VALUES (${b.id}, ${conv.id}, 'WHATSAPP', 'INBOUND', 'CUSTOMER', '${MARK}secret', now())`
    );
    return { biz: b, user: u, customer: c, conversation: conv };
  };
  const A = await mkBiz("A");
  const B = await mkBiz("B");
  console.log(`[fixtures] A=${A.biz.id} B=${B.biz.id}`);

  // ── Phase 5: lifecycle + auth, as the real runtime role ───────────────────
  console.log("--- phase 5: lifecycle + auth ---");
  ok("A reads ACTIVE", (await readBusinessLifecycle(A.biz.id)) === "ACTIVE");
  ok("unknown business reads null", (await readBusinessLifecycle(999999999)) === null);
  ok(
    "missing business fails closed",
    (await throws(() => assertBusinessAcceptsWrites(999999999))) instanceof BusinessQuarantinedError
  );
  ok("ACTIVE business accepts writes", (await throws(() => assertBusinessAcceptsWrites(A.biz.id))) === null);

  const tokenA = signAuthToken(A.user.id);
  const req = () => new Request("http://ad2a.local/x", { headers: { authorization: `Bearer ${tokenA}` } });
  ok("token works while ACTIVE", (await getCurrentUser(req()))?.id === A.user.id);

  // ── Phase 6: silent-zero + tenant isolation, under real FORCE RLS ─────────
  console.log("--- phase 6: silent-zero + isolation ---");
  ok(
    "a tenant transaction with no context throws",
    (await throws(() => withTenantTransaction(async () => {}))) !== null
  );
  const readA = await runTenantJob({ businessId: A.biz.id }, () =>
    withTenantTransaction((tx) =>
      tx.conversation.findMany({ where: { businessId: { in: [A.biz.id, B.biz.id] } } })
    )
  );
  ok(
    "GUC=A sees only A's conversations under FORCE RLS",
    readA.length === 1 && readA[0].businessId === A.biz.id,
    `n=${readA.length}`
  );
  const writeB = await runTenantJob({ businessId: A.biz.id }, () =>
    withTenantTransaction((tx) =>
      tx.conversation.updateMany({ where: { businessId: B.biz.id }, data: { status: "CLOSED" } })
    )
  );
  ok("GUC=A cannot mutate B", writeB.count === 0, `count=${writeB.count}`);

  // ── Phase 7: the erasure under the restricted role — fails LOUD and CLEAN ─
  console.log("--- phase 7: erasure under the restricted runtime ---");
  const beforeConv = await owner.conversation.count({ where: { businessId: A.biz.id } });
  const beforeUser = await owner.user.findUnique({ where: { id: A.user.id } });
  const erasureErr = await throws(() =>
    deleteOwnBusinessAccount(prismaAccountDeletionStore, {
      businessId: A.biz.id,
      actorUserId: A.user.id,
    })
  );
  blocked(
    "the erasure is refused under the restricted runtime (Gate C residue)",
    erasureErr !== null,
    erasureErr ? String(erasureErr.message).slice(0, 120) : "IT SUCCEEDED — the residue analysis is wrong"
  );
  const aAfter = await owner.business.findUnique({ where: { id: A.biz.id } });
  ok(
    "a refused erasure leaves the business ACTIVE (fail-closed ordering, safely retryable)",
    lifecycleOf(aAfter) === "ACTIVE",
    `state=${lifecycleOf(aAfter)}`
  );
  ok(
    "a refused erasure destroys nothing",
    (await owner.conversation.count({ where: { businessId: A.biz.id } })) === beforeConv
  );
  const userAfter = await owner.user.findUnique({ where: { id: A.user.id } });
  ok("a refused erasure does not tombstone the user", userAfter.email === beforeUser.email);
  ok("the session still works after a refused erasure", (await getCurrentUser(req()))?.id === A.user.id);

  // ── Phase 8: quarantine closure, driven by the owner-set state ────────────
  // The transition itself needs the authority the runtime lacks, so the fixture is
  // quarantined directly; what is being proven here is that every RUNTIME path
  // honours the quarantine — which is exactly the AD-2A guarantee.
  console.log("--- phase 8: quarantine closure ---");
  await owner.$executeRawUnsafe(
    `UPDATE "Business" SET "deletionRequestedAt" = now() WHERE id = ${A.biz.id}`
  );
  ok("A now reads DELETION_REQUESTED", (await readBusinessLifecycle(A.biz.id)) === "DELETION_REQUESTED");
  ok("the same pre-quarantine token is now rejected", (await getCurrentUser(req())) === null);
  ok(
    "a background job for a quarantined business is refused",
    (await throws(() => runTenantJob({ businessId: A.biz.id }, async () => "resurrected"))) instanceof
      BusinessQuarantinedError
  );
  ok(
    "the canonical guard denies a quarantined business",
    (await throws(() => assertBusinessAcceptsWrites(A.biz.id))) instanceof BusinessQuarantinedError
  );
  ok("a payment webhook would read the quarantine at its tenant boundary",
    (await readBusinessLifecycle(A.biz.id)) !== "ACTIVE");

  await owner.$executeRawUnsafe(`UPDATE "Business" SET "deletedAt" = now() WHERE id = ${A.biz.id}`);
  ok("A now reads PURGED", (await readBusinessLifecycle(A.biz.id)) === "PURGED");
  ok("a purged business still rejects the token", (await getCurrentUser(req())) === null);
  ok(
    "a purged business still refuses background work",
    (await throws(() => runTenantJob({ businessId: A.biz.id }, async () => 1))) instanceof
      BusinessQuarantinedError
  );
  ok("B is unaffected throughout", (await readBusinessLifecycle(B.biz.id)) === "ACTIVE");

  // ── Phase 9: integrity scan over the WHOLE Preview dataset ────────────────
  console.log("--- phase 9: integrity scan ---");
  const vol = (
    await owner.$queryRawUnsafe(
      `SELECT (SELECT count(*)::int FROM "Business") AS biz,
              (SELECT count(*)::int FROM "Conversation") AS conv,
              (SELECT count(*)::int FROM "Message") AS msg`
    )
  )[0];
  console.log(
    `[dataset] businesses=${vol.biz} conversations=${vol.conv} messages=${vol.msg} ` +
      `— a clean scan over a dataset this size is WEAK evidence; the meaningful run is Production, read-only, separately authorized`
  );
  const findings = await scanConversationIntegrity(owner);
  const total = findings.reduce((s, f) => s + f.count, 0);
  for (const f of findings) {
    if (f.count > 0) console.log(`  [MISMATCH x${f.count}] ${f.edge} ${JSON.stringify(f.rows)}`);
  }
  ok(`integrity scan clean: ${findings.length} edges, ${total} mismatches`, total === 0);

  // Detection proof: inject a mismatch as the owner, detect it, remove it.
  const bConv = await owner.conversation.findFirst({ where: { businessId: B.biz.id } });
  await owner.$executeRawUnsafe(
    `UPDATE "Message" SET "businessId" = ${A.biz.id} WHERE "conversationId" = ${bConv.id}`
  );
  const dirty = await scanConversationIntegrity(owner);
  const edge = dirty.find((f) => f.edge.startsWith("Message.businessId"));
  ok("scanner DETECTS an injected cross-tenant Message", edge.count >= 1, `count=${edge.count}`);
  await owner.$executeRawUnsafe(
    `UPDATE "Message" SET "businessId" = ${B.biz.id} WHERE "conversationId" = ${bConv.id}`
  );
  const reclean = await scanConversationIntegrity(owner);
  ok("injected corruption removed; scan clean again", reclean.reduce((s, f) => s + f.count, 0) === 0);

  const before = await owner.message.count();
  await scanConversationIntegrity(owner);
  ok("the scanner itself writes nothing", (await owner.message.count()) === before);

  // ── Phase 10: residue ─────────────────────────────────────────────────────
  console.log("--- phase 10: residue ---");
  await rt.$disconnect();
  await cleanup();
  const left = Number(
    (
      await owner.$queryRawUnsafe(
        `SELECT (SELECT count(*)::int FROM "Business" WHERE name LIKE '${MARK}%')
              + (SELECT count(*)::int FROM "User" WHERE email LIKE '%@ad2a-prev.test') AS c`
      )
    )[0].c
  );
  ok("synthetic residue = 0", left === 0, `found ${left}`);

  await owner.$disconnect();
  console.log(`\n[preview] AD-2A.1 PASS=${pass} FAIL=${fail}`);
  if (fail > 0) {
    console.log("FAILURES:\n - " + failures.join("\n - "));
    process.exit(1);
  }
  console.log("ALL CHECKS PASS");
}

main().catch((e) => {
  console.error("[preview] FATAL:", e);
  process.exit(1);
});
