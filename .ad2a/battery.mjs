/**
 * D2 / ACCOUNT-DELETION-2A — lifecycle, quarantine and erasure-execution battery.
 *
 * Runs the REAL orchestrator, the REAL Prisma erasure adapter, the REAL session
 * check and the REAL payment settlement store against a PG17 lab with the tenant
 * tables actually under FORCE RLS — because the defect this wave fixes is invisible
 * without RLS: every statement carried `where: { businessId }` and looked correct.
 *
 * J-0 CORRECTION — why this battery was falsely green, and what changed.
 *
 * It used to build its own laboratory policies inline, and they were not the policies
 * Production runs:
 *
 *   CREATE POLICY ad2a_tenant ON "<t>" USING (...) WITH CHECK (...)
 *
 * No FOR clause. PostgreSQL reads that as FOR ALL, and FOR ALL includes DELETE. The
 * five pilot tables in Production carry three SEPARATE policies — SELECT, INSERT and
 * UPDATE — and deliberately NO DELETE policy. So the fixture handed the erasure a
 * capability the product does not have, and `conversation.deleteMany` passed here while
 * matching zero rows in Production.
 *
 * It also left five tables out of the fixture entirely: the four that hold the
 * integration credentials stage 1 claims to destroy, and the one stage 3 writes the
 * erasure evidence to. All five are FORCE-RLS'd in Production. Unprotected in the lab,
 * the two stages that carry NO tenant context could not fail; protected, they cannot
 * succeed.
 *
 * The contract now lives as DATA in ./production-contract.mjs, copied from the
 * migrations with each entry naming its source file, and is applied verbatim.
 *
 * LAB-ONLY GRANTS, and what is deliberately NOT lab-only any more. The lab still grants
 * the runtime the verbs the erasure needs, including DELETE on Conversation — and that
 * is now FAITHFUL rather than generous: Production's `app_runtime` holds exactly that
 * DELETE grant through historical broad grants (see the cutover-2B migration header).
 * Keeping it is what makes the proof sharp. What stops the delete in Production is the
 * missing POLICY, not a missing privilege, and a fixture that removed the grant would
 * prove the wrong thing for the right-looking reason.
 *
 * Synthetic pw-ad2a fixtures only. ZERO network, ZERO Neon, ZERO Production.
 */
import { PrismaClient } from "@prisma/client";
import { scanConversationIntegrity } from "../scripts/security/conversation-integrity-scan.mjs";
import {
  applyProductionContract,
  readLiveContract,
  renderFidelityTable,
  contractTables,
  PRODUCTION_RLS_CONTRACT,
  POLCMD,
} from "./production-contract.mjs";
import { KNOWN_DEFECTS, defectOf } from "./known-defects.mjs";
import {
  freshLabIdentity,
  measureCleanPrecondition,
  readLiveState,
  expectedState,
  diffExactSet,
} from "./lab-state.mjs";
import { crossCheckContract } from "./contract-crosscheck.mjs";
import { PRODUCTION_NO_RLS } from "./production-contract.mjs";

/** The fresh lab this proof was given — null when run outside the harness (refused in main). */
const LAB = freshLabIdentity();
const RT_ROLE = LAB?.role ?? "ad2a_runtime_unset";
const RT_PW = LAB?.pw ?? "";
/** Stop after the substrate is built and verified: contract, exact-set, cross-check. */
const CONTRACT_ONLY = process.argv.includes("--contract-only");
const MARK = "ad2a-";
/** E2 Wave 1 uses its OWN sentinel, distinct from MARK. The Defect B sweep
 *  already greps the whole conversation graph for MARK, and reusing it would
 *  let a Wave-1 assertion pass because some OTHER model happened to be clean.
 *  A separate marker makes "this specific value is unrecoverable" the claim. */
const W1 = "ERASURE_W1_7c41af-";

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
  // J-0: returned so a caller can compose several checks into one phase verdict
  // without evaluating the same condition twice.
  return Boolean(cond);
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

/**
 * The list of protected tables is no longer written here. It comes from
 * ./production-contract.mjs, which carries the policy SHAPE as well as the table
 * name — because the shape is what the old fixture got wrong.
 */

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

  // LAB ISOLATION HARDENING. The database and the runtime role are made for THIS
  // proof by `.ad2a/fresh-lab.mjs`, and this battery refuses to run anywhere else.
  // It used to create the role if it was missing and otherwise reuse whatever it
  // found, together with every grant, policy and RLS flag an earlier run had left —
  // which is how two negative proofs passed on leftovers.
  //
  // The precondition is MEASURED and never repaired. A battery that tidied a dirty
  // database and carried on could no longer say whether what it proved came from the
  // contract or from what was already there.
  if (!LAB) {
    console.log("[battery] FAIL: not a fresh lab. Run through `node .ad2a/fresh-lab.mjs <label> -- …`,");
    console.log("          which creates a new database and runtime role for this proof alone.");
    process.exit(1);
  }
  console.log("--- phase 1a: clean precondition (measured, not repaired) ---");
  const pre = await measureCleanPrecondition(owner, LAB);
  for (const c of pre) ok(`PRE · ${c.name}`, c.ok, c.detail);
  if (pre.some((c) => !c.ok)) {
    console.log("[battery] PRECONDITION DIRTY — refusing to apply the contract to a database it did not come from.");
    process.exit(1);
  }
  await owner.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${RT_ROLE}`);

  // The Production contract, applied verbatim from data. Proving the erasure against
  // unprotected tables would prove nothing, and proving it against a MORE PERMISSIVE
  // fixture than Production is worse than proving nothing — that is what happened here
  // before J-0.
  //
  // C12-E1. The lab database outlives a run, and the contract only ever TURNS RLS ON.
  // So a table dropped from the contract kept the protection an earlier run gave it,
  // and a proof that the lab stops reproducing Production (E4) passed on leftovers.
  // For the three tables this increment relies on, start from nothing — no RLS, no
  // policy — so whatever protection they end up with is the contract's, this run.
  for (const t of ["ReceivingSession", "PurchaseOrderLine", "PurchaseOrder"]) {
    await owner.$executeRawUnsafe(`ALTER TABLE "${t}" NO FORCE ROW LEVEL SECURITY`);
    await owner.$executeRawUnsafe(`ALTER TABLE "${t}" DISABLE ROW LEVEL SECURITY`);
    await owner.$executeRawUnsafe(`DROP POLICY IF EXISTS p7w3_tenant ON "${t}"`);
  }
  await applyProductionContract(owner);

  // Fidelity is MEASURED, not declared. Read the policies back out of the catalog and
  // assert each table matches the contract it was built from.
  const live = await readLiveContract(owner, contractTables());
  console.log("\n[fidelity] Production contract -> corrected rehearsal contract\n");
  console.log(renderFidelityTable(live));
  console.log("");

  const liveByTable = new Map(live.map((r) => [r.table, r]));
  for (const spec of PRODUCTION_RLS_CONTRACT) {
    const r = liveByTable.get(spec.table);
    const cmds = (r?.policies ?? []).map((s) => POLCMD[s.split(":")[1]]).sort();
    const wanted = spec.policies.map((p) => p.command).sort();
    ok(
      `contract applied: ${spec.table} = FORCE RLS + [${wanted.join(",")}]`,
      r?.rls === true && r?.force === true && JSON.stringify(cmds) === JSON.stringify(wanted),
      `live rls=${r?.rls} force=${r?.force} cmds=[${cmds.join(",")}]`
    );
  }
  // The single most important negative property of the whole fixture.
  const pilotDeleteReachable = PRODUCTION_RLS_CONTRACT.filter((s) =>
    ["Conversation", "Customer", "Appointment", "BillingDocument", "PaymentRequest"].includes(s.table)
  ).filter((s) => {
    const cmds = (liveByTable.get(s.table)?.policies ?? []).map((x) => POLCMD[x.split(":")[1]]);
    return cmds.includes("ALL") || cmds.includes("DELETE");
  });
  ok(
    "NO pilot table has a DELETE-reachable policy (this is what the old FOR ALL fixture destroyed)",
    pilotDeleteReachable.length === 0,
    pilotDeleteReachable.map((s) => s.table).join(",")
  );
  // LAB-ONLY privileges (see the header): enough to exercise the real code path.
  await owner.$executeRawUnsafe(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON "Conversation","Message","MessageAnalysis","ReplySuggestion","Customer","CrmNote","CrmAttachment","BusinessProfile","User","Business","Lead","POSApiKey","OAuthToken","EmailConnection","WhatsAppConnection","BusinessPaymentConnection","BillingAuthorityConnection","LearningEvent","Appointment" TO ${RT_ROLE}`
  );
  // T1-ERASURE: the inbound sender authorisation list, granted separately for the
  // same reason the list above is enumerated rather than schema-wide — the lab
  // must hold exactly what Production holds. The T1-DB migration grants both
  // tables to app_runtime, so the runtime genuinely has SELECT/INSERT/UPDATE and
  // DELETE on them, and account erasure relies on the DELETE.
  //
  // This is where their absence showed up. The first run of the erasure against a
  // seeded fixture failed with 42501, permission denied, because the lab role had
  // never been granted anything on tables that did not exist when the list above
  // was written. A missing grant is indistinguishable from a missing delete from
  // the outside, so it has to be stated here rather than inherited.
  await owner.$executeRawUnsafe(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON "InboundEmailAuthorizedSender","InboundEmailSenderChallenge" TO ${RT_ROLE}`
  );
  // I-8A: Production hands the runtime SELECT and INSERT here and revokes the
  // rest, so the lab does the same. Giving this table the blanket grant above
  // would make "erasure did not delete these rows" a statement about privileges
  // the product does not actually have.
  await owner.$executeRawUnsafe(
    `GRANT SELECT, INSERT ON "HistoricalFiscalDocument" TO ${RT_ROLE}`
  );
  await owner.$executeRawUnsafe(
    `REVOKE UPDATE, DELETE ON "HistoricalFiscalDocument" FROM ${RT_ROLE}`
  );
  // E2-W1. `scripts/security/notification-grants.sql` hands the runtime
  // SELECT, INSERT and UPDATE here — and NOT DELETE. The lab matches that
  // exactly rather than joining the blanket grant above, because the whole
  // question for Notification is whether the erasure can reach it with the
  // privileges it actually has. A lab DELETE the product does not hold would
  // let a `deleteMany` fix pass here and fail in Production — which is the
  // same falsely-green fixture shape that hid Defect B.
  await owner.$executeRawUnsafe(
    `GRANT SELECT, INSERT, UPDATE ON "Notification","NotificationDelivery" TO ${RT_ROLE}`
  );
  await owner.$executeRawUnsafe(
    `REVOKE DELETE ON "Notification","NotificationDelivery" FROM ${RT_ROLE}`
  );
  // C12-E1. `scripts/security/d2-p7-wave3-grants.sql` hands the runtime SELECT,
  // INSERT and UPDATE on these three — and NOT DELETE. Mirrored exactly, for the
  // same reason as Notification above: the question is whether a CLEAR can reach
  // these rows with the privileges the product actually holds, and a lab DELETE
  // would answer a question nobody asked.
  //
  // PurchaseOrder carries nothing that is erased. It is here because
  // PurchaseOrderLine's tenant predicate reads it, and a row the runtime cannot
  // SELECT is a row the EXISTS cannot confirm.
  await owner.$executeRawUnsafe(
    `GRANT SELECT, INSERT, UPDATE ON "ReceivingSession","PurchaseOrderLine","PurchaseOrder" TO ${RT_ROLE}`
  );
  await owner.$executeRawUnsafe(
    `REVOKE DELETE ON "ReceivingSession","PurchaseOrderLine","PurchaseOrder" FROM ${RT_ROLE}`
  );
  await owner.$executeRawUnsafe(
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${RT_ROLE}`
  );

  // ── Phase 1c: LIVE = EXPECTED, and the contract against the migrations ─────
  //
  // "contract applied" above reads back only the tables the contract names, and only
  // their policy COMMANDS. That cannot see a table left out, an extra grant, a policy
  // no entry declares, or a predicate that changed. So the whole schema is read back
  // and compared, dimension by dimension, for equality — missing AND extra both fail.
  console.log("--- phase 1c: exact-set (live = declared) ---");
  const liveState = await readLiveState(owner, RT_ROLE);
  const wantState = await expectedState(owner, liveState.sequences);
  const exact = diffExactSet(liveState, wantState);
  for (const d of exact) {
    ok(
      `EXACT · ${d.dimension}`,
      d.missing.length === 0 && d.extra.length === 0,
      [d.missing.length ? `missing=[${d.missing.join(" | ")}]` : "", d.extra.length ? `extra=[${d.extra.join(" | ")}]` : ""]
        .filter(Boolean)
        .join(" ")
    );
  }

  // The contract is a hand-written claim about Production; this checks it against
  // the migrations, replayed independently. The tables compared come from the erasure
  // adapter's AST and the migrations' own predicates — not from the contract — so a
  // table the contract forgot is still compared.
  console.log("--- phase 1d: contract ↔ migrations (independent replay) ---");
  const { parseAdapter, parsePrismaSchema } = await import("@/lib/services/account/erasure-contract");
  const schemaModels = parsePrismaSchema("prisma/schema.prisma");
  const byDelegate = new Map([...schemaModels.values()].map((m) => [m.delegate, m]));
  const adapterFacts = parseAdapter("lib/services/account/account-deletion.prisma-store.ts");
  const flowTables = [
    ...new Set(
      [...adapterFacts.writes.map((w) => w.delegate), ...adapterFacts.deletes.map((d) => d.delegate)].map((d) => {
        const m = byDelegate.get(d);
        return m ? (m.dbName ?? m.name) : `?${d}`;
      })
    ),
  ].sort();
  ok(
    "XC · every delegate the adapter touches resolves to a table",
    flowTables.every((t) => !t.startsWith("?")),
    flowTables.filter((t) => t.startsWith("?")).join(",")
  );
  const xc = await crossCheckContract(
    owner,
    { rls: PRODUCTION_RLS_CONTRACT, noRls: PRODUCTION_NO_RLS },
    flowTables,
    process.cwd()
  );
  console.log(`  [xc] ${xc.migrations} migrations replayed; ${xc.compared.length} tables compared`);
  const XC_DIMS = [
    "TABLE MEMBERSHIP",
    "RLS ENABLED",
    "RLS FORCE",
    "POLICY MEMBERSHIP",
    "POLICY COMMAND",
    "POLICY ROLES",
    "POLICY PERMISSIVE",
    "POLICY USING",
    "POLICY WITH CHECK",
    "UNINTERPRETABLE MIGRATION",
  ];
  for (const dim of XC_DIMS) {
    const hits = xc.findings.filter((f) => f.dimension === dim);
    ok(`XC · ${dim}`, hits.length === 0, hits.map((f) => `${f.table}: ${f.detail}`).join(" | "));
  }
  for (const u of xc.unproven) console.log(`  [UNPROVEN] XC · ${u.dimension} — ${u.detail}`);

  if (CONTRACT_ONLY) {
    console.log(`\n[battery] CONTRACT PHASE PASS=${pass} FAIL=${fail}`);
    console.log(fail === 0 ? "CONTRACT PHASE = PASS" : `CONTRACT PHASE = FAIL (${failures.join(" ; ")})`);
    await owner.$disconnect();
    process.exit(fail === 0 ? 0 : 1);
  }
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
  // SEC-E. The erasure now revokes the account's authority (token generation, sessions)
  // on the AUTH plane, as Production does through app_auth. The lab's second fresh role
  // gets exactly app_auth's migration grants — never a tenant-runtime grant on
  // AuthSession, which the product deliberately does not hold.
  {
    const AUTH_ROLE = process.env.AD2A_AUTH_ROLE;
    if (!AUTH_ROLE) throw new Error("fresh-lab did not provide an auth-plane role (AD2A_AUTH_ROLE)");
    const { applyAuthPlane } = await import("../.sec-e/auth-plane.mjs");
    await owner.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${AUTH_ROLE}`);
    const n = await applyAuthPlane(owner, AUTH_ROLE);
    process.env.AUTH_PLANE_ENABLED = "true";
    process.env.AUTH_DATABASE_URL = roleUrl(OWNER_URL, AUTH_ROLE, process.env.AD2A_AUTH_PW);
    ok(`auth plane: ${n} app_auth migration grants replayed onto ${AUTH_ROLE}`, n >= 10);
  }
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
  // S8: the product's own attachment storage path, and the store itself for read-back.
  const { buildAttachmentStorageKey, putAttachmentObject } = await import(
    "@/lib/services/crm/crm-attachment-storage"
  );
  const { getStorageService } = await import("@/lib/storage");
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
    await owner.$executeRawUnsafe(
      `DELETE FROM "HistoricalFiscalDocument"
         WHERE "businessId" IN (${bids}) AND "reversesHistoricalDocumentId" IS NOT NULL`
    );
    await owner.$executeRawUnsafe(
      `DELETE FROM "HistoricalFiscalDocument" WHERE "businessId" IN (${bids})`
    );
    await owner.$executeRawUnsafe(`DELETE FROM "ImportRun" WHERE "businessId" IN (${bids})`);
    await owner.$executeRawUnsafe(`DELETE FROM "Document" WHERE "businessId" IN (${bids})`);
    // J-0: the credential surfaces. OAuthToken owns through its parent, so it goes first.
    await owner.$executeRawUnsafe(
      `DELETE FROM "OAuthToken" WHERE "connectionId" IN
         (SELECT id FROM "EmailConnection" WHERE "businessId" IN (${bids}))`
    );
    for (const t of [
      "CrmAttachment", "CrmNote", "Customer", "Lead", "BusinessProfile", "POSApiKey",
      "EmailConnection", "WhatsAppConnection", "BillingAuthorityConnection",
      "BusinessPaymentConnection",
    ]) {
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
    // A message carrying EVERY class the erasure contract names, not just a
    // body: the words, the provider's own id for them, the client idempotency
    // key, the provider error text (which routinely quotes the number or the
    // message), and the derived labels. Anything left readable here is a hole.
    const msg = await owner.message.create({
      data: {
        businessId: b.id,
        conversationId: conv.id,
        customerId: c.id,
        channel: "WHATSAPP",
        direction: "INBOUND",
        senderType: "CUSTOMER",
        contentText: `${MARK}secret`,
        languageCode: "he",
        intentLabel: `${MARK}intent`,
        sentimentLabel: `${MARK}sentiment`,
        objectionLabel: `${MARK}objection`,
        stageLabel: `${MARK}stage`,
        providerMessageId: `${MARK}wamid-${tag}`,
        clientRequestId: `${MARK}creq-${tag}`,
        sendErrorCode: `${MARK}errcode`,
        sendErrorMessage: `${MARK}errmsg`,
      },
    });
    // Derived analysis. Owns through Message, no businessId of its own.
    await owner.messageAnalysis.create({
      data: { messageId: msg.id, intent: `${MARK}derived-intent`, stage: `${MARK}derived-stage` },
    });
    // A generated reply — content the product wrote ABOUT the exchange.
    await owner.replySuggestion.create({
      data: {
        businessId: b.id,
        conversationId: conv.id,
        messageId: msg.id,
        suggestionType: "reply",
        text: `${MARK}suggestion`,
        toneLabel: `${MARK}tone`,
        strategyLabel: `${MARK}strategy`,
      },
    });
    // Conversation-level snapshots that summarise what was said, plus the two
    // Json blobs and the participant pointers.
    await owner.conversation.update({
      where: { id: conv.id },
      data: {
        intentType: `${MARK}conv-intent`,
        sentimentSnapshot: `${MARK}conv-sentiment`,
        outcomeReason: `${MARK}conv-outcome`,
        lostReason: `${MARK}conv-lost`,
        pendingFollowUp: { note: `${MARK}pending-followup` },
        pendingAppointmentRequest: { note: `${MARK}pending-appt` },
        leadId: null,
      },
    });
    await owner.crmNote.create({
      data: { businessId: b.id, subjectType: "CUSTOMER", subjectId: c.id, body: `${MARK}note`, createdByUserId: u.id },
    });

    // ── S8 — a CRM attachment with REAL BYTES behind it ─────────────────────
    //
    // The row alone proves nothing about objects. The erasure deleted rows like this
    // one for months while the bytes stayed in storage and the only `storageKey`
    // went with the row — invisible to any fixture that never wrote an object. So
    // this one is written through the product's own storage path, and the assertions
    // read the store back rather than the table.
    const attachmentKey = buildAttachmentStorageKey({
      businessId: b.id,
      subjectType: "CUSTOMER",
      subjectId: c.id,
      storageExt: "txt",
    });
    await putAttachmentObject({
      businessId: b.id,
      key: attachmentKey,
      body: Buffer.from(`${W1}attachment-bytes-${tag}`, "utf8"),
      contentType: "text/plain",
    });
    const attachment = await owner.crmAttachment.create({
      data: {
        businessId: b.id,
        subjectType: "CUSTOMER",
        subjectId: c.id,
        storageKey: attachmentKey,
        originalFileName: `${MARK}attachment-${tag}.txt`,
        mimeType: "text/plain",
        sizeBytes: 32,
        uploadedByUserId: u.id,
      },
    });

    // ── E2-W1 — the two deterministic residual surfaces ─────────────────────
    //
    // A LEAD with the four fields the manifest and the dispositions already
    // promise are erased, and the customer pointer they promise is unlinked.
    // `email` is the one the whole residual sweep started from: the manifest
    // declared it nulled and the adapter never wrote it.
    const lead = await owner.lead.create({
      data: {
        businessId: b.id,
        customerId: c.id,
        customerName: `${MARK}lead-name-${tag}`,
        phone: `${MARK}lead-phone`,
        email: `${W1}lead-email-${tag}@example.test`,
        intentSnapshot: `${W1}lead-intent`,
        followUpNote: `${W1}lead-followup`,
        lostReason: `${W1}lead-lost`,
        sourceChannel: "whatsapp",
        currentStage: "DISCOVERY",
      },
    });

    // NOTIFICATIONS, which are a denormalised COPY of three surfaces the
    // ratified design already requires to be anonymised: the counterparty name
    // (title), the last message body (summary) and the generated reply text
    // (summary). `reason` and `href` are NOT seeded with a marker because they
    // are a fixed policy string and an internal route — they are not personal,
    // and an erasure that cleared them would be over-deleting.
    await owner.notification.create({
      data: {
        businessId: b.id,
        dedupeKey: `b${b.id}:inbox:ACTION_REQUIRED:conversation:${conv.id}`,
        domain: "inbox",
        semanticCategory: "ACTION_REQUIRED",
        severity: "HIGH",
        entityType: "conversation",
        entityId: conv.id,
        title: `${W1}notif-title-${tag} ממתין למענה`,
        summary: `הודעה אחרונה: ${W1}notif-snippet`,
        href: "/inbox",
        reason: "inbox waiting — standing state",
        cooldownHours: 24,
      },
    });
    await owner.notification.create({
      data: {
        businessId: b.id,
        dedupeKey: `b${b.id}:leads:ACTION_REQUIRED:lead:${lead.id}`,
        domain: "leads",
        semanticCategory: "ACTION_REQUIRED",
        severity: "MEDIUM",
        entityType: "lead",
        entityId: lead.id,
        title: `${W1}notif-lead-${tag} — follow-up due`,
        summary: `${W1}notif-followup-copy`,
        href: `/leads/${lead.id}`,
        reason: "lead follow-up due — owner-scheduled",
        cooldownHours: 48,
      },
    });

    // T1-ERASURE: the inbound-email sender authorisation list. Seeded for BOTH
    // businesses so the control tenant proves the delete is scoped rather than
    // merely effective. The hash is a marker, so a survivor is readable in the
    // output instead of showing up only as a count.
    const inboundSender = await owner.inboundEmailAuthorizedSender.create({
      data: {
        businessId: b.id,
        normalizedEmail: `${tag}-forwarder@ad2a.test`,
        status: "VERIFIED",
        verifiedAt: new Date(),
        createdByUserId: u.id,
      },
    });
    await owner.inboundEmailSenderChallenge.create({
      data: {
        businessId: b.id,
        authorizedSenderId: inboundSender.id,
        challengeHash: `${MARK}challenge-hash`,
          // T5-DB: purpose is NOT NULL, and a LIVE row must carry the key that
          // says so. Seeded live on purpose — a terminal row would not exercise
          // the unique constraint the erasure delete has to step around.
          purpose: "SENDER_OWNERSHIP_VERIFICATION",
          activeChallengeKey: "SENDER_OWNERSHIP_VERIFICATION",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    // C12-E1: a purchase order, one line and a receiving session. Seeded for BOTH
    // businesses, because the interesting half of this proof is the control tenant:
    // PurchaseOrderLine has no businessId of its own, so the erasure must reach it
    // through the PurchaseOrder relation, and an over-broad filter would clear B's
    // note as readily as A's.
    //
    // The free text carries the sentinel. The product columns deliberately do NOT —
    // `rawName`, `sku` and `barcode` are ratified product identity, and an erasure
    // that touched them would be over-deleting, which the assertions check for as
    // carefully as they check for under-deleting.
    const po = await owner.purchaseOrder.create({
      data: {
        businessId: b.id,
        supplierName: `${tag}-supplier`,
        status: "AWAITING_DELIVERY",
        createdByUserId: u.id,
      },
    });
    const poLine = await owner.purchaseOrderLine.create({
      data: {
        purchaseOrderId: po.id,
        rawName: `${tag}-coffee-beans-1kg`,
        sku: `SKU-${tag}-001`,
        barcode: `BC-${tag}-001`,
        orderedQty: 10,
        remainingDecision: "CLOSED_SHORT",
        remainingDecisionQty: 3,
        remainingDecisionNote: `${W1}line-remainder-note-${tag}`,
        remainingDecidedAt: new Date(),
        remainingDecidedByUserId: u.id,
      },
    });
    const recv = await owner.receivingSession.create({
      data: {
        businessId: b.id,
        purchaseOrderId: po.id,
        status: "POSTED",
        receivedAt: new Date(),
        postedAt: new Date(),
        note: `${W1}receiving-note-${tag}`,
        createdByUserId: u.id,
        postedByUserId: u.id,
      },
    });

    // J-0: the integration credentials stage 1 claims to destroy. The old fixture
    // created NONE of these, so "credentials were revoked" was never asserted at all —
    // there was nothing there to survive. Every secret below is a recognisable marker,
    // so a surviving one is visible rather than merely countable.
    const emailConn = await owner.emailConnection.create({
      data: {
        businessId: b.id,
        provider: "gmail",
        emailAddress: `${tag}@ad2a.test`,
        providerAccountId: `${MARK}${tag}-acct`,
        scopes: "https://www.googleapis.com/auth/gmail.readonly",
        lastSyncCursor: `${MARK}${tag}-cursor`,
      },
    });
    await owner.oAuthToken.create({
      data: {
        connectionId: emailConn.id,
        accessTokenEncrypted: `${MARK}${tag}-gmail-access`,
        refreshTokenEncrypted: `${MARK}${tag}-gmail-refresh`,
        expiresAt: new Date(Date.now() + 3600_000),
        encryptionKeyId: "lab-key-1",
      },
    });
    const authorityConn = await owner.billingAuthorityConnection.create({
      data: {
        businessId: b.id,
        environment: "SANDBOX",
        accessTokenEncrypted: `${MARK}${tag}-shaam-access`,
        accessTokenIv: `${MARK}iv`,
        accessTokenTag: `${MARK}tag`,
        refreshTokenEncrypted: `${MARK}${tag}-shaam-refresh`,
        refreshTokenIv: `${MARK}iv`,
        refreshTokenTag: `${MARK}tag`,
        encryptionKeyId: "lab-key-1",
      },
    });
    const payConn = await owner.businessPaymentConnection.create({
      data: {
        businessId: b.id,
        provider: "CARDCOM",
        merchantId: `${MARK}${tag}-merchant`,
        credentialEncrypted: `${MARK}${tag}-pay-credential`,
        credentialIv: `${MARK}iv`,
        credentialTag: `${MARK}tag`,
        encryptionKeyId: "lab-key-1",
        isActive: true,
      },
    });
    const waConn = await owner.whatsAppConnection.create({
      data: {
        businessId: b.id,
        phoneNumberId: `${MARK}${tag}-phone`,
        displayPhoneNumber: "+972500000000",
        wabaId: `${MARK}${tag}-waba`,
        accessTokenEncrypted: `${MARK}${tag}-wa-access`,
        accessTokenIv: `${MARK}iv`,
        accessTokenTag: `${MARK}tag`,
      },
    });
    const posKey = await owner.pOSApiKey.create({
      data: { businessId: b.id, keyHash: `${MARK}${tag}-poskey`, label: `${MARK}${tag}` },
    });
    // I-8A fiscal history: the artifact, the import that brought it in, the
    // record itself, and a reversal citing that record — so the deletion meets
    // every relation the model has, not just the simple case.
    const doc = await owner.document.create({
      data: {
        businessId: b.id,
        fileUrl: `lab://${tag}/legacy-invoice.pdf`,
        source: "upload",
        mimeType: "application/pdf",
        status: "processed",
      },
    });
    const run = await owner.importRun.create({
      data: {
        businessId: b.id,
        userId: u.id,
        domain: "documents",
        contentHash: `${MARK}${tag}-content`,
        mappingHash: `${MARK}${tag}-mapping`,
        decisionsHash: `${MARK}${tag}-decisions`,
        totalRows: 1,
      },
    });
    const historical = await owner.historicalFiscalDocument.create({
      data: {
        businessId: b.id,
        documentTypeCode: "INVOICE",
        sourceSystemCode: "legacy-erp",
        originalDocumentNumber: `${tag}-1001`,
        documentId: doc.id,
        importRunId: run.id,
      },
    });
    const reversal = await owner.historicalFiscalDocument.create({
      data: {
        businessId: b.id,
        documentTypeCode: "CREDIT_NOTE",
        sourceSystemCode: "legacy-erp",
        originalDocumentNumber: `${tag}-1002`,
        reversesHistoricalDocumentId: historical.id,
      },
    });

    return {
      biz: b, user: u, customer: c, conversation: conv, doc, run, historical, reversal,
      emailConn, authorityConn, payConn, waConn, posKey, po, poLine, recv,
      attachment, attachmentKey,
    };
  };

  const A = await mkBiz("A");
  const B = await mkBiz("B");
  console.log(`[fixtures] A=${A.biz.id} B=${B.biz.id}`);

  // ── Phase 3b: FISCAL CLAIM B — the foreign key itself, isolated ────────────
  //
  // The CI proof "erasure deleting the artifact fiscal history cites" used to be read
  // as evidence that a RESTRICT foreign key protects the Document a historical record
  // cites. It never reached the key: the runtime holds no privilege on Document, so the
  // mutated erasure stopped at 42501. That proves the PRIVILEGE boundary (Claim A) and
  // says nothing about the key.
  //
  // This proves the key alone. The delete is issued as the lab OWNER — a superuser, so
  // neither a privilege nor a row-level policy can refuse it — against the Document
  // A's historical record cites. The only thing left that can stop it is a constraint,
  // and the assertion requires the refusal to be a foreign-key violation naming exactly
  // that constraint. A control delete of an uncited Document, same owner, same transaction
  // shape, must succeed — so the refusal is about the citation, not about deleting
  // Documents. Both run in transactions that are rolled back. The runtime role's
  // privileges are not touched.
  console.log("--- phase 3b: fiscal Claim B (RESTRICT foreign key, isolated) ---");
  const FISCAL_FK = "HistoricalFiscalDocument_businessId_documentId_fkey";
  const ROLLBACK_FK = Symbol("rollback");
  const fkDef = await owner.$queryRawUnsafe(
    `SELECT confdeltype::text AS del, conrelid::regclass::text AS child, confrelid::regclass::text AS parent
       FROM pg_constraint WHERE conname = $1`,
    FISCAL_FK
  );
  ok(
    `FISCAL-B · ${FISCAL_FK} exists and is ON DELETE RESTRICT`,
    fkDef.length === 1 && fkDef[0].del === "r" && fkDef[0].parent === '"Document"',
    JSON.stringify(fkDef)
  );
  // The lab's schema comes from `db push`, i.e. from schema.prisma. Production's comes
  // from the migrations. The key must be RESTRICT in the one Production actually ran.
  const { readdirSync: rdMig, readFileSync: rfMig } = await import("node:fs");
  const migDefines = rdMig("prisma/migrations").filter((d) => {
    try {
      const sql = rfMig(`prisma/migrations/${d}/migration.sql`, "utf8").replace(/\s+/g, " ");
      return sql.includes(
        `ADD CONSTRAINT "${FISCAL_FK}" FOREIGN KEY ("businessId", "documentId") REFERENCES "Document"("businessId", "id") ON DELETE RESTRICT`
      );
    } catch {
      return false;
    }
  });
  ok(
    "FISCAL-B · a migration creates exactly this key as ON DELETE RESTRICT (Production has it, not just the lab)",
    migDefines.length === 1,
    `migrations=${migDefines.join(",") || "none"}`
  );
  ok(
    "FISCAL-B · A's historical record cites A's Document (the fixture exercises the key)",
    A.historical.documentId === A.doc.id,
    `documentId=${A.historical.documentId} doc=${A.doc.id}`
  );
  // The SQLSTATE and constraint name are read from PostgreSQL itself (GET STACKED
  // DIAGNOSTICS), not parsed out of a client library's error text.
  let fkOutcome = null;
  try {
    await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`
        CREATE FUNCTION pg_temp.ad2a_try_delete_document(target int) RETURNS text LANGUAGE plpgsql AS $f$
        DECLARE st text; cn text;
        BEGIN
          DELETE FROM "Document" WHERE "id" = target;
          RETURN 'DELETED';
        EXCEPTION WHEN others THEN
          GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, cn = CONSTRAINT_NAME;
          RETURN st || ':' || COALESCE(cn, '');
        END $f$`);
      fkOutcome = (await tx.$queryRawUnsafe(`SELECT pg_temp.ad2a_try_delete_document(${A.doc.id}) AS r`))[0].r;
      throw ROLLBACK_FK;
    });
  } catch (e) {
    if (e !== ROLLBACK_FK) fkOutcome = `harness error: ${String(e.message).split("\n").slice(-1)[0]}`;
  }
  // The SQLSTATE depends on the server version: PostgreSQL 17 reports a RESTRICT
  // violation as 23503 (the same code as NO ACTION), PostgreSQL 18 as 23001
  // restrict_violation. So the SQLSTATE proves "a foreign-key violation", the
  // constraint name proves WHICH key, and that the key is RESTRICT rather than NO
  // ACTION is proved separately — from the catalog (confdeltype) and the migration.
  ok(
    "FISCAL-B · deleting the cited Document fails with a foreign-key violation on exactly that key",
    fkOutcome === `23503:${FISCAL_FK}` || fkOutcome === `23001:${FISCAL_FK}`,
    `outcome=${fkOutcome}`
  );
  let controlDeleted = -1;
  try {
    await owner.$transaction(async (tx) => {
      const spare = await tx.document.create({
        data: { ...Object.fromEntries(Object.entries(A.doc).filter(([k]) => !["id", "createdAt", "updatedAt"].includes(k))) },
      });
      controlDeleted = await tx.$executeRawUnsafe(`DELETE FROM "Document" WHERE "id" = ${spare.id}`);
      throw ROLLBACK_FK;
    });
  } catch (e) {
    if (e !== ROLLBACK_FK) controlDeleted = `error: ${String(e.message).split("\n").slice(-1)[0]}`;
  }
  ok(
    "FISCAL-B · control: an UNCITED Document is deleted by the same owner (the refusal is the citation)",
    controlDeleted === 1,
    `deleted=${controlDeleted}`
  );
  ok(
    "FISCAL-B · the cited Document is still there after both attempts",
    (await owner.document.count({ where: { id: A.doc.id } })) === 1
  );

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

  // ── C12-E1 — the lab's RLS and privileges, measured by behaviour ──────────
  //
  // "contract applied" above reads the catalog for the tables the contract NAMES. It
  // cannot notice a table that is missing from the contract: that table is simply left
  // without row-level security, and the erasure still clears A's note and still leaves
  // B's alone — because the adapter's own filter scopes it. A green that survives the
  // loss of the very protection it claims to be proved under is Defect B's shape.
  //
  // So the property is asked of the database directly, with the adapter's filter taken
  // out of the question: under A's context, name B's rows EXPLICITLY. Only row-level
  // security can make that return nothing.
  console.log("--- phase 5b: C12-E1 tenant RLS + privilege fidelity ---");
  const e1Probe = await runTenantJob({ businessId: A.biz.id }, () =>
    withTenantTransaction(async (tx) => ({
      ownLines: await tx.purchaseOrderLine.count({ where: { purchaseOrderId: A.po.id } }),
      ownRecv: await tx.receivingSession.count({ where: { id: A.recv.id } }),
      bLines: await tx.purchaseOrderLine.count({ where: { purchaseOrderId: B.po.id } }),
      bRecv: await tx.receivingSession.count({ where: { id: B.recv.id } }),
      bPo: await tx.purchaseOrder.count({ where: { id: B.po.id } }),
      bLineWrite: (
        await tx.purchaseOrderLine.updateMany({
          where: { id: B.poLine.id },
          data: { remainingDecisionNote: null },
        })
      ).count,
      bRecvWrite: (
        await tx.receivingSession.updateMany({ where: { id: B.recv.id }, data: { note: null } })
      ).count,
    }))
  );
  // The positive control: without it, every zero below could be a broken query.
  ok(
    "E1-R0 · GUC=A sees its OWN purchase line and receiving session (control)",
    e1Probe.ownLines === 1 && e1Probe.ownRecv === 1,
    JSON.stringify(e1Probe)
  );
  ok(
    "E1-R1 · GUC=A cannot see B's purchase line even by naming it — RLS through the PurchaseOrder relation",
    e1Probe.bLines === 0 && e1Probe.bPo === 0,
    JSON.stringify(e1Probe)
  );
  ok(
    "E1-R2 · GUC=A cannot see B's receiving session even by naming it",
    e1Probe.bRecv === 0,
    JSON.stringify(e1Probe)
  );
  ok(
    "E1-R3 · GUC=A cannot clear B's notes even by naming the rows",
    e1Probe.bLineWrite === 0 && e1Probe.bRecvWrite === 0,
    JSON.stringify(e1Probe)
  );
  // A MISSING context must not be a way through either. Outside any tenant
  // transaction the GUC is unset, the predicate is NULL, and nothing is visible.
  const e1NoCtx = {
    lines: await rt.purchaseOrderLine.count(),
    recv: await rt.receivingSession.count(),
    po: await rt.purchaseOrder.count(),
  };
  ok(
    "E1-R4 · with NO tenant context the runtime sees no purchase line, receiving session or order",
    e1NoCtx.lines === 0 && e1NoCtx.recv === 0 && e1NoCtx.po === 0,
    JSON.stringify(e1NoCtx)
  );
  const e1BIntact = await owner.purchaseOrderLine.findUnique({ where: { id: B.poLine.id } });
  ok(
    "E1-R5 · and B's line note is still there after being targeted",
    e1BIntact?.remainingDecisionNote === B.poLine.remainingDecisionNote,
    JSON.stringify(e1BIntact?.remainingDecisionNote ?? null)
  );

  // Privileges, a separate gate from policy. A `FOR ALL` policy GOVERNS DELETE; it
  // does not GRANT it. What the runtime may do is the table privilege, and the lab's
  // must be Production's — not written twice by hand, but read from the artifact
  // Production is granted from, so the two cannot drift apart quietly.
  const { readFileSync: readGrants } = await import("node:fs");
  const grantsSql = readGrants(
    new URL("../scripts/security/d2-p7-wave3-grants.sql", import.meta.url),
    "utf8"
  );
  for (const table of ["ReceivingSession", "PurchaseOrderLine", "PurchaseOrder"]) {
    const lines = grantsSql
      .split("\n")
      .filter((l) => !l.trim().startsWith("--") && l.includes(`ON "${table}" `));
    const granted = new Set();
    let parsed = lines.length > 0;
    for (const l of lines) {
      const m = /^\s*GRANT\s+([A-Z ,]+?)\s+ON\s+"(\w+)"\s+TO\s+:ROLE;\s*$/.exec(l);
      if (!m) parsed = false;
      else for (const v of m[1].split(",")) granted.add(v.trim());
    }
    const live = (
      await owner.$queryRawUnsafe(
        `SELECT has_table_privilege('${RT_ROLE}', '"${table}"', 'SELECT')   AS "SELECT",
                has_table_privilege('${RT_ROLE}', '"${table}"', 'INSERT')   AS "INSERT",
                has_table_privilege('${RT_ROLE}', '"${table}"', 'UPDATE')   AS "UPDATE",
                has_table_privilege('${RT_ROLE}', '"${table}"', 'DELETE')   AS "DELETE",
                has_table_privilege('${RT_ROLE}', '"${table}"', 'TRUNCATE') AS "TRUNCATE"`
      )
    )[0];
    const mismatch = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"].filter(
      (v) => live[v] !== granted.has(v)
    );
    ok(
      `E1-P · ${table}: lab runtime privileges = d2-p7-wave3-grants.sql exactly (DELETE ${
        granted.has("DELETE") ? "granted" : "absent"
      })`,
      parsed && mismatch.length === 0 && !granted.has("DELETE") && live.DELETE === false,
      `artifact=[${[...granted].sort().join(",")}] live=${JSON.stringify(live)} mismatch=[${mismatch.join(",")}]`
    );
  }

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
  // J-0. The call is allowed to THROW. Under the Production contract it is expected to,
  // and a battery that let the throw escape would report an infrastructure crash instead
  // of a finding. Capture it, then judge the DATABASE, not the return value.
  let result = null;
  const deletionError = await throws(async () => {
    result = await deleteOwnBusinessAccount(prismaAccountDeletionStore, {
      businessId: A.biz.id,
      actorUserId: A.user.id,
    });
  });
  console.log(
    `[deletion] returned=${result ? result.status : "—"} threw=${
      deletionError ? `${deletionError.constructor.name}: ${String(deletionError.message).split("\n")[0]}` : "no"
    }`
  );

  // ── POSTCONDITIONS. A statement that returned without raising proves nothing. ──
  // Every assertion below reads the row back. This is the J-0 rule: a zero-row
  // DELETE or UPDATE that does not throw is NOT evidence of destruction.

  // ── FAILURE A — stage 1 credential/access destruction ─────────────────────
  console.log("--- phase 7a: stage-1 credential destruction (postconditions) ---");
  const emailAfter = await owner.emailConnection.findUnique({ where: { id: A.emailConn.id } });
  const oauthAfter = await owner.oAuthToken.count({ where: { connectionId: A.emailConn.id } });
  const authorityAfter = await owner.billingAuthorityConnection.findUnique({ where: { id: A.authorityConn.id } });
  const payAfter = await owner.businessPaymentConnection.findUnique({ where: { id: A.payConn.id } });
  const waAfter = await owner.whatsAppConnection.findUnique({ where: { id: A.waConn.id } });
  const posAfter = await owner.pOSApiKey.count({ where: { id: A.posKey.id } });

  const credFindings = [];
  const cred = (name, destroyed, detail) => {
    ok(name, destroyed, detail);
    if (!destroyed) credFindings.push(detail);
    return destroyed;
  };
  const p1a = cred(
    "Gmail refresh token is DESTROYED",
    oauthAfter === 0,
    `OAuthToken rows surviving: ${oauthAfter}` +
      (oauthAfter ? ` (refresh secret still at rest)` : "")
  );
  const p1b = cred(
    "Gmail connection is REVOKED",
    emailAfter?.status === "revoked" && emailAfter?.lastSyncCursor === null,
    `status=${emailAfter?.status} cursor=${emailAfter?.lastSyncCursor}`
  );
  const p1c = cred(
    "SHAAM authority tokens are CLEARED and the connection revoked",
    authorityAfter?.accessTokenEncrypted === null &&
      authorityAfter?.refreshTokenEncrypted === null &&
      authorityAfter?.revokedAt !== null,
    `access=${authorityAfter?.accessTokenEncrypted} refresh=${authorityAfter?.refreshTokenEncrypted} revokedAt=${authorityAfter?.revokedAt}`
  );
  const p1d = cred(
    "payment-provider credential is CLEARED and deactivated",
    payAfter?.credentialEncrypted === null && payAfter?.isActive === false,
    `credential=${payAfter?.credentialEncrypted} isActive=${payAfter?.isActive}`
  );
  // These two carry no RLS in Production, so they are expected to SUCCEED. Their job
  // here is to prove the failure above is caused by RLS and not by a broken fixture.
  const p1e = cred(
    "WhatsApp token is destroyed (control: table has no RLS)",
    waAfter?.accessTokenEncrypted === "" && waAfter?.status === "REVOKED_BY_META",
    `token=${JSON.stringify(waAfter?.accessTokenEncrypted)} status=${waAfter?.status}`
  );
  const p1f = cred(
    "POS API key rows are deleted (control: table has no RLS)",
    posAfter === 0,
    `POSApiKey rows surviving: ${posAfter}`
  );
  const PHASE1 = p1a && p1b && p1c && p1d && p1e && p1f;

  // ── FAILURE B — stage 2 conversation cleanup ──────────────────────────────
  console.log("--- phase 7b: stage-2 conversation cleanup (postconditions) ---");
  const convAfter = await owner.conversation.count({ where: { businessId: A.biz.id } });
  const msgAfter = await owner.message.count({ where: { businessId: A.biz.id } });
  const secretsAfter = await owner.message.count({
    where: { businessId: A.biz.id, contentText: { contains: `${MARK}secret` } },
  });
  // ── the ERASURE CONTRACT for the conversation graph ──────────────────────
  //
  // The product decision is anonymise-in-place, so "the rows are gone" is no
  // longer the property being asserted — and these checks are deliberately
  // STRONGER than the delete-count they replace. A delete-count could pass while
  // derived analysis, a generated reply or a provider message id survived
  // somewhere else in the graph. These read every surviving row back and require
  // that nothing readable, derived or identifying is left in any of them.
  //
  // The skeleton is allowed to remain. Nothing in it may reconstruct the
  // exchange or reconnect it to a person.
  const msgRows = await owner.message.findMany({
    where: { businessId: A.biz.id },
    select: {
      contentText: true, languageCode: true, intentLabel: true, sentimentLabel: true,
      objectionLabel: true, stageLabel: true, providerMessageId: true,
      clientRequestId: true, sendErrorCode: true, sendErrorMessage: true, customerId: true,
    },
  });
  const convRows = await owner.conversation.findMany({
    where: { businessId: A.biz.id },
    select: {
      intentType: true, sentimentSnapshot: true, outcomeReason: true, lostReason: true,
      pendingFollowUp: true, pendingAppointmentRequest: true, customerId: true, leadId: true,
    },
  });
  const suggRows = await owner.replySuggestion.findMany({
    where: { businessId: A.biz.id },
    select: { text: true, toneLabel: true, strategyLabel: true },
  });
  const analysisRows = await owner.messageAnalysis.findMany({
    where: { message: { businessId: A.biz.id } },
    select: { intent: true, stage: true },
  });

  // The fixtures write the marker ONLY into fields the erasure contract says must
  // be cleared, and this sweep reads back EVERY scalar column of all four models
  // — no `select`, so a column added next year is swept the day it exists. That
  // is the difference between "the fields I remembered to check are clean" and
  // "the skeleton contains no prohibited data", which is the property actually
  // being claimed.
  const fullRows = {
    msg: await owner.message.findMany({ where: { businessId: A.biz.id } }),
    conv: await owner.conversation.findMany({ where: { businessId: A.biz.id } }),
    sugg: await owner.replySuggestion.findMany({ where: { businessId: A.biz.id } }),
    analysis: await owner.messageAnalysis.findMany({ where: { message: { businessId: A.biz.id } } }),
  };
  const leaked = JSON.stringify(fullRows).includes(MARK);

  const p2a = ok(
    "the conversation skeleton survives — anonymise-in-place, not purge",
    convAfter > 0 && msgAfter > 0,
    `conversations=${convAfter} messages=${msgAfter}`
  );
  const p2b = ok(
    "NO raw message content remains",
    secretsAfter === 0 && msgRows.every((m) => m.contentText === null),
    `bodies still readable: ${secretsAfter}`
  );
  const p2c = ok(
    "NO derived conversation content remains",
    analysisRows.every((a) => a.intent === "" && a.stage === "") &&
      suggRows.every((s) => s.text === "" && s.toneLabel === null && s.strategyLabel === null) &&
      msgRows.every((m) =>
        m.intentLabel === null && m.sentimentLabel === null &&
        m.objectionLabel === null && m.stageLabel === null && m.languageCode === null
      ) &&
      convRows.every((c) =>
        c.intentType === null && c.sentimentSnapshot === null &&
        c.outcomeReason === null && c.lostReason === null &&
        c.pendingFollowUp === null && c.pendingAppointmentRequest === null
      ),
    `analysis=${JSON.stringify(analysisRows)} suggestions=${JSON.stringify(suggRows)}`
  );
  const p2d = ok(
    "NO provider linkage remains that reconnects the skeleton to the live thread",
    msgRows.every(
      (m) =>
        m.providerMessageId === null && m.clientRequestId === null &&
        m.sendErrorCode === null && m.sendErrorMessage === null
    ),
    JSON.stringify(msgRows.map((m) => m.providerMessageId))
  );
  const p2e = ok(
    "NO participant linkage remains on the skeleton",
    msgRows.every((m) => m.customerId === null) &&
      convRows.every((c) => c.customerId === null && c.leadId === null),
    JSON.stringify(convRows.map((c) => [c.customerId, c.leadId]))
  );
  const p2f = ok(
    "NO fixture marker survives in ANY column of the conversation graph",
    !leaked,
    "a marked value is still readable in one of the four models"
  );
  const PHASE2 = p2a && p2b && p2c && p2d && p2e && p2f;

  // What else stage 2 does, so a failure above is attributable to the graph
  // anonymisation specifically rather than to stage 2 never running at all.
  ok("A's CRM notes are gone (FOR ALL policy covers DELETE)",
    (await owner.crmNote.count({ where: { businessId: A.biz.id } })) === 0);
  // ── S8 — the bytes, not the row ──────────────────────────────────────────
  //
  // This is the assertion whose absence let a live defect run: the row went, the
  // object stayed, and the `storageKey` was destroyed with the row, so nothing could
  // find the bytes afterwards. The store is read back directly, not inferred.
  const storage = getStorageService();
  const aAttRows = await owner.crmAttachment.count({ where: { businessId: A.biz.id } });
  const aObject = await storage.headObject(A.attachmentKey);
  const s8a = ok("S8-A · A's CRM attachment ROW is gone", aAttRows === 0, `rows=${aAttRows}`);
  const s8b = ok(
    "S8-B · A's CRM attachment OBJECT is gone from storage, not merely its row",
    aObject.exists === false,
    `key=${A.attachmentKey} exists=${aObject.exists}`
  );
  const bObject = await storage.headObject(B.attachmentKey);
  const bAttRow = await owner.crmAttachment.findFirst({ where: { businessId: B.biz.id } });
  const s8c = ok(
    "S8-C · B's attachment row AND object are both untouched",
    bAttRow !== null && bAttRow.storageKey === B.attachmentKey && bObject.exists === true,
    `row=${bAttRow !== null} object=${bObject.exists}`
  );
  console.log(`  S8 CRM ATTACHMENT OBJECTS     = ${s8a && s8b && s8c ? "PASS" : "FAIL"}`);

  ok("A's inbound sender challenges are gone (child deleted before parent)",
    (await owner.inboundEmailSenderChallenge.count({ where: { businessId: A.biz.id } })) === 0);
  ok("A's inbound authorised senders are gone",
    (await owner.inboundEmailAuthorizedSender.count({ where: { businessId: A.biz.id } })) === 0);
  const custA = await owner.customer.findFirst({ where: { businessId: A.biz.id } });
  ok("A's customer is ANONYMIZED, not deleted (invoice FK)", custA !== null && custA.name === "לקוח שנמחק");
  const userA = await owner.user.findUnique({ where: { id: A.user.id } });
  ok("A's user identity is tombstoned", userA.email.startsWith("deleted-biz-") && userA.name === null);

  // ── E2 WAVE 1 — deterministic residual personal data ──────────────────────
  //
  // Both surfaces below are named, or are a copy of something named, in the
  // ratified erasure design: `Customer`/`Lead`/`Deal` PII is anonymised, and so
  // is the conversation graph. The Lead fields were additionally DECLARED erased
  // by the manifest while the adapter never wrote them — the contract lie that
  // E1 was built to make impossible, here proven at runtime instead.
  //
  // Read back through the OWNER client on purpose: the question is whether the
  // value is still in the table at all, not whether some role can see it.
  const leadRows = await owner.lead.findMany({ where: { businessId: A.biz.id } });
  const w1a = ok(
    "W1-A · NO lead contact identifier or free text survives",
    leadRows.length > 0 &&
      leadRows.every(
        (l) =>
          l.email === null &&
          l.intentSnapshot === null &&
          l.followUpNote === null &&
          l.lostReason === null
      ),
    JSON.stringify(leadRows.map((l) => [l.email, l.intentSnapshot, l.followUpNote, l.lostReason]))
  );
  const w1b = ok(
    "W1-B · NO participant linkage survives on the lead skeleton",
    leadRows.every((l) => l.customerId === null),
    JSON.stringify(leadRows.map((l) => l.customerId))
  );
  // The non-personal business state the contract does NOT ask to destroy. An
  // erasure that cleared these too would be over-deleting, and this assertion
  // is what stops a later "clear every string on Lead" shortcut.
  const w1c = ok(
    "W1-C · non-personal lead analytics are PRESERVED, not destroyed",
    leadRows.every((l) => l.sourceChannel !== null && l.currentStage !== null && l.status !== null),
    JSON.stringify(leadRows.map((l) => [l.sourceChannel, l.currentStage, l.status]))
  );

  const notifRows = await owner.notification.findMany({ where: { businessId: A.biz.id } });
  const w1d = ok(
    "W1-D · the notification skeleton survives (the runtime holds no DELETE here)",
    notifRows.length > 0,
    `notifications=${notifRows.length}`
  );
  const w1e = ok(
    "W1-E · NO copied counterparty name or conversation content survives in a notification",
    notifRows.every((n) => n.title === "" && n.summary === null),
    JSON.stringify(notifRows.map((n) => [n.title, n.summary]))
  );
  const w1f = ok(
    "W1-F · the notification's non-personal routing and policy fields are PRESERVED",
    notifRows.every((n) => n.href !== "" && n.reason !== "" && n.entityId > 0),
    JSON.stringify(notifRows.map((n) => [n.href, n.reason, n.entityId]))
  );
  // The sweep that catches a field nobody remembered. Every scalar column of
  // both models, no `select`, so a column added later is covered the day it
  // exists — and the marker is Wave 1's own, not the graph's.
  const w1Rows = {
    lead: await owner.lead.findMany({ where: { businessId: A.biz.id } }),
    notification: await owner.notification.findMany({ where: { businessId: A.biz.id } }),
    delivery: await owner.notificationDelivery.findMany({ where: { businessId: A.biz.id } }),
  };
  const w1g = ok(
    "W1-G · the W1 sentinel is unrecoverable in ANY column of Lead, Notification or NotificationDelivery",
    !JSON.stringify(w1Rows).includes(W1),
    "a W1-marked value is still readable"
  );
  const PHASE_W1 = w1a && w1b && w1c && w1d && w1e && w1f && w1g;

  // ── C12-E1 — the two notes, and everything beside them that must survive ──
  //
  // Read back through the OWNER client, because the question is whether the value
  // is still in the table, not whether some role can see it.
  console.log("--- phase 7b.2: C12-E1 receiving / purchase-line notes ---");
  const aRecv = await owner.receivingSession.findMany({ where: { businessId: A.biz.id } });
  const aLines = await owner.purchaseOrderLine.findMany({
    where: { purchaseOrder: { businessId: A.biz.id } },
  });

  const e1a = ok(
    "E1-A · ReceivingSession.note is cleared",
    aRecv.length > 0 && aRecv.every((r) => r.note === null),
    JSON.stringify(aRecv.map((r) => r.note))
  );
  const e1b = ok(
    "E1-B · PurchaseOrderLine.remainingDecisionNote is cleared, reached through the PurchaseOrder relation",
    aLines.length > 0 && aLines.every((l) => l.remainingDecisionNote === null),
    JSON.stringify(aLines.map((l) => l.remainingDecisionNote))
  );
  // Anti-over-deletion. Product identity is ratified NON_PERSONAL under S-7C, and an
  // erasure that took it would be destroying the business's own catalogue.
  // Compared with the seeded row value for value — "not null" would accept a
  // placeholder, and a placeholder is an erasure of the product identity.
  const e1c = ok(
    "E1-C · product identity is PRESERVED — rawName, sku and barcode equal their seeded values",
    aLines.length === 1 &&
      aLines[0].rawName === A.poLine.rawName &&
      aLines[0].sku === A.poLine.sku &&
      aLines[0].barcode === A.poLine.barcode,
    JSON.stringify(aLines.map((l) => [l.rawName, l.sku, l.barcode]))
  );
  // The other half of G0-2: the provenance pointers are retained ON PURPOSE, and
  // this is what proves the increment did not quietly null them instead.
  const e1d = ok(
    "E1-D · the three provenance pointers are PRESERVED",
    aRecv.length === 1 &&
      aRecv[0].createdByUserId === A.recv.createdByUserId &&
      aRecv[0].postedByUserId === A.recv.postedByUserId &&
      aLines.length === 1 &&
      aLines[0].remainingDecidedByUserId === A.poLine.remainingDecidedByUserId &&
      A.recv.createdByUserId === A.user.id,
    JSON.stringify([
      aRecv.map((r) => [r.createdByUserId, r.postedByUserId]),
      aLines.map((l) => l.remainingDecidedByUserId),
    ])
  );
  // And the retention only holds because the row they point at was anonymised.
  // Asserting the pointer survives without asserting that would be asserting the
  // comfortable half.
  const aUsers = await owner.user.findMany({ where: { businessId: A.biz.id } });
  const e1e = ok(
    "E1-E · the User rows those pointers name ARE anonymised — the retention's own premise",
    aUsers.length > 0 && aUsers.every((x) => x.name === null && !x.email.includes("@ad2a.test")),
    JSON.stringify(aUsers.map((x) => [x.email, x.name]))
  );
  // The sweep: no `select`, so a column added later is covered the day it exists.
  const e1Rows = { receiving: aRecv, lines: aLines };
  const e1f = ok(
    "E1-F · the sentinel is unrecoverable in ANY column of ReceivingSession or PurchaseOrderLine",
    !JSON.stringify(e1Rows).includes(W1),
    "a W1-marked value is still readable"
  );
  const PHASE_E1 = e1a && e1b && e1c && e1d && e1e && e1f;

  // ── FAILURE C — stage 3 deletion evidence and terminal state ──────────────
  console.log("--- phase 7c: stage-3 evidence + terminal state (postconditions) ---");
  const aAfter = await owner.business.findUnique({ where: { id: A.biz.id } });
  const evidenceAfter = await owner.learningEvent.count({
    where: { businessId: A.biz.id, eventType: "ACCOUNT_DELETED" },
  });
  ok("A's quarantine timestamp was set BEFORE the purge ran", aAfter.deletionRequestedAt !== null);
  const p3a = ok("erasure evidence was written", evidenceAfter === auditBefore + 1,
    `ACCOUNT_DELETED rows: ${evidenceAfter}`);
  const p3b = ok("A reached the terminal PURGED state", lifecycleOf(aAfter) === "PURGED",
    `lifecycle=${lifecycleOf(aAfter)}`);
  const p3c = ok("the deletion call reported success", result?.status === "deleted",
    `returned=${result ? result.status : "threw"}`);
  const PHASE3 = p3a && p3b && p3c;

  // ── The J-0 verdict lines the closure report quotes verbatim. ─────────────
  console.log("");
  console.log(`PHASE 1 CREDENTIAL DESTRUCTION = ${PHASE1 ? "PASS" : "FAIL"}`);
  console.log(`PHASE 2 CONVERSATION CLEANUP   = ${PHASE2 ? "PASS" : "FAIL"}`);
  console.log(`PHASE 3 DELETION EVIDENCE      = ${PHASE3 ? "PASS" : "FAIL"}`);
  console.log(`E2 WAVE 1 RESIDUAL PII        = ${PHASE_W1 ? "PASS" : "FAIL"}`);
  console.log(`C12-E1 RECEIVING/LINE NOTES   = ${PHASE_E1 ? "PASS" : "FAIL"}`);
  console.log("");

  // ── FALSE-SUCCESS LEDGER ──────────────────────────────────────────────────
  // The specific regression class J-0 exists to make hard to reintroduce: an
  // operation that returns without raising and destroys nothing. Recorded
  // explicitly so a future reader cannot mistake "no exception" for "done".
  console.log("--- phase 7d: false-success ledger ---");
  // This section existed to RECORD the defects, because their signature was
  // silence: a destructive statement returned normally, changed nothing, and the
  // deletion reported success on top of it. Both were hardcoded passes that
  // narrated the breakage rather than measuring anything.
  //
  // With A and B closed that narration is no longer true, and a hardcoded pass
  // asserting it would be a false statement printed in green. So the section now
  // measures the property the defects violated: no destructive statement may
  // report success while changing nothing.
  ok(
    "no destructive statement reported success while changing nothing",
    credFindings.length === 0,
    `${credFindings.length} statement(s) returned normally and proved nothing`
  );
  if (credFindings.length > 0) {
    console.log("  [false-success] destructive statements that proved nothing:");
    for (const f of credFindings) console.log(`      - ${f}`);
  }
  // The conversation graph is no longer deleted at all, so the old silent-zero
  // DELETE cannot recur on this path: there is no DELETE on it to be silent.
  // What replaced it is measured above, in phase 7b.
  console.log(`  [ledger] conversation graph anonymised in place — ${convAfter} skeleton row(s) retained`);

  // I-8A — fiscal history is RETAINED, and the deletion did not trip over it.
  //
  // Retention is the contract, not a gap in it: the obligation to keep an
  // invoice does not ask which software issued it, so these records are in the
  // must-retain bucket beside Document and BillingDocument. What the deletion
  // has to prove is that it neither removed them nor failed because of them.
  const histA = await owner.historicalFiscalDocument.findMany({
    where: { businessId: A.biz.id },
    orderBy: { id: "asc" },
  });
  ok("A's historical fiscal records SURVIVE the erasure", histA.length === 2, `found ${histA.length}`);
  ok(
    "the reversal still cites the record it reverses",
    histA[1] && histA[1].reversesHistoricalDocumentId === A.historical.id
  );
  ok(
    "the record still cites its original artifact, which also survives",
    histA[0] && histA[0].documentId === A.doc.id &&
      (await owner.document.count({ where: { id: A.doc.id } })) === 1
  );
  ok(
    "the import run that brought it in survives too",
    (await owner.importRun.count({ where: { id: A.run.id } })) === 1
  );
  ok(
    "the customer snapshot on fiscal history is untouched by customer anonymization",
    histA[0] && histA[0].customerNameSnapshot === null
  );

  // The privilege posture that makes the above structural rather than lucky.
  const histPriv = (
    await owner.$queryRawUnsafe(
      `SELECT has_table_privilege('${RT_ROLE}', '"HistoricalFiscalDocument"', 'SELECT') AS s,
              has_table_privilege('${RT_ROLE}', '"HistoricalFiscalDocument"', 'INSERT') AS i,
              has_table_privilege('${RT_ROLE}', '"HistoricalFiscalDocument"', 'UPDATE') AS u,
              has_table_privilege('${RT_ROLE}', '"HistoricalFiscalDocument"', 'DELETE') AS d`
    )
  )[0];
  ok(
    "the erasure runtime holds no UPDATE and no DELETE on fiscal history",
    histPriv.s === true && histPriv.i === true && histPriv.u === false && histPriv.d === false,
    JSON.stringify(histPriv)
  );

  // B is untouched — the whole point.
  ok("B's conversations survive A's deletion",
    (await owner.conversation.count({ where: { businessId: B.biz.id } })) === 1);
  ok("B's messages survive", (await owner.message.count({ where: { businessId: B.biz.id } })) === 1);
  ok("B's inbound authorised sender survives (the delete is tenant-scoped)",
    (await owner.inboundEmailAuthorizedSender.count({ where: { businessId: B.biz.id } })) === 1);
  ok("B's inbound sender challenge survives",
    (await owner.inboundEmailSenderChallenge.count({ where: { businessId: B.biz.id } })) === 1);

  // C12-E1 cross-tenant. The line is the one that can actually go wrong: it has no
  // businessId, so it is reached through the PurchaseOrder relation, and a filter
  // that lost the relation would clear B's note while leaving B's row count exactly
  // as it was. Counting proves nothing here; the content is read back.
  const bRecvNote = await owner.receivingSession.findFirst({ where: { businessId: B.biz.id } });
  const bLineNote = await owner.purchaseOrderLine.findFirst({
    where: { purchaseOrder: { businessId: B.biz.id } },
  });
  const e1x1 = ok(
    "E1-X1 · B's ReceivingSession.note is untouched",
    typeof bRecvNote?.note === "string" && bRecvNote.note.includes(W1),
    JSON.stringify(bRecvNote?.note ?? null)
  );
  const e1x2 = ok(
    "E1-X2 · B's PurchaseOrderLine.remainingDecisionNote is untouched — the tenant scope held",
    typeof bLineNote?.remainingDecisionNote === "string" &&
      bLineNote.remainingDecisionNote.includes(W1),
    JSON.stringify(bLineNote?.remainingDecisionNote ?? null)
  );
  // The whole row, not just the note: an over-broad statement that blanked any other
  // column, or merely touched B's rows, would show here as a changed value or updatedAt.
  const bRecvRow = await owner.receivingSession.findUnique({ where: { id: B.recv.id } });
  const bLineRow = await owner.purchaseOrderLine.findUnique({ where: { id: B.poLine.id } });
  const e1x3 = ok(
    "E1-X3 · B's ReceivingSession and PurchaseOrderLine rows are identical to their seeded state",
    JSON.stringify(bRecvRow) === JSON.stringify(B.recv) &&
      JSON.stringify(bLineRow) === JSON.stringify(B.poLine),
    JSON.stringify({ bRecvRow, bLineRow })
  );
  console.log(`  C12-E1 CROSS-TENANT           = ${e1x1 && e1x2 && e1x3 ? "PASS" : "FAIL"}`);

  // Counting B's rows is not enough now that A's are anonymised IN PLACE rather
  // than deleted: an over-broad UPDATE would leave B's row count untouched while
  // blanking everything in it. So B's content, derived analysis, generated reply
  // and provider linkage are all read back and required to be exactly as seeded.
  const bMsg = await owner.message.findFirst({
    where: { businessId: B.biz.id },
    select: {
      contentText: true, providerMessageId: true, intentLabel: true,
      languageCode: true, customerId: true,
    },
  });
  const bConv = await owner.conversation.findFirst({
    where: { businessId: B.biz.id },
    select: { intentType: true, sentimentSnapshot: true, customerId: true },
  });
  const bSugg = await owner.replySuggestion.findFirst({
    where: { businessId: B.biz.id },
    select: { text: true, toneLabel: true },
  });
  const bAnalysis = await owner.messageAnalysis.findFirst({
    where: { message: { businessId: B.biz.id } },
    select: { intent: true, stage: true },
  });
  ok(
    "B's message CONTENT, labels and provider id are untouched",
    bMsg?.contentText === `${MARK}secret` &&
      bMsg?.providerMessageId === `${MARK}wamid-B` &&
      bMsg?.intentLabel === `${MARK}intent` &&
      bMsg?.languageCode === "he" &&
      bMsg?.customerId !== null,
    JSON.stringify(bMsg)
  );
  ok(
    "B's derived analysis and generated reply are untouched",
    bAnalysis?.intent === `${MARK}derived-intent` &&
      bSugg?.text === `${MARK}suggestion` &&
      bSugg?.toneLabel === `${MARK}tone`,
    JSON.stringify({ bAnalysis, bSugg })
  );
  // E2-W1 cross-tenant. Counting B's rows proves nothing once A is anonymised
  // in place: an over-broad UPDATE with a missing `where` would leave B's counts
  // intact while blanking its contents. So B's values are read back.
  const bLead = await owner.lead.findFirst({ where: { businessId: B.biz.id } });
  ok(
    "B's lead contact fields and free text are untouched",
    bLead?.email?.startsWith(W1) === true &&
      bLead?.intentSnapshot?.startsWith(W1) === true &&
      bLead?.followUpNote?.startsWith(W1) === true &&
      bLead?.lostReason?.startsWith(W1) === true &&
      bLead?.customerId !== null,
    JSON.stringify(bLead)
  );
  const bNotifs = await owner.notification.findMany({ where: { businessId: B.biz.id } });
  ok(
    "B's notification titles and summaries are untouched",
    bNotifs.length === 2 &&
      bNotifs.every((n) => n.title.includes(W1)) &&
      bNotifs.some((n) => n.summary?.includes(W1)),
    JSON.stringify(bNotifs.map((n) => [n.title, n.summary]))
  );
  ok(
    "B's conversation snapshots and participant linkage are untouched",
    bConv?.intentType === `${MARK}conv-intent` &&
      bConv?.sentimentSnapshot === `${MARK}conv-sentiment` &&
      bConv?.customerId !== null,
    JSON.stringify(bConv)
  );
  const custB = await owner.customer.findFirst({ where: { businessId: B.biz.id } });
  ok("B's customer is untouched", custB.name === `${MARK}cust-B`);
  ok(
    "B's historical fiscal records are untouched",
    (await owner.historicalFiscalDocument.count({ where: { businessId: B.biz.id } })) === 2
  );
  ok(
    "B's original artifact is untouched",
    (await owner.document.count({ where: { businessId: B.biz.id } })) === 1
  );

  // ── Phase 8: post-quarantine closure ──────────────────────────────────────
  console.log("--- phase 8: post-quarantine ---");
  ok("the SAME pre-deletion token is now rejected", (await getCurrentUser(authReq())) === null);
  const jobErr = await throws(() => runTenantJob({ businessId: A.biz.id }, async () => "resurrected"));
  ok("a background job for a purged business is refused", jobErr instanceof BusinessQuarantinedError);
  const gateErr = await throws(() => assertBusinessAcceptsWrites(A.biz.id));
  ok("the canonical guard denies a purged business", gateErr instanceof BusinessQuarantinedError);
  const lifeA = await readBusinessLifecycle(A.biz.id);
  // J-0: the quarantine holds in EITHER terminal or non-terminal state, and that part
  // of AD-2A is genuinely correct. What the state actually is gets reported rather than
  // assumed, because the audit expects DELETION_REQUESTED here and the old battery
  // asserted PURGED.
  ok("a payment webhook would read a QUARANTINED business at its tenant boundary",
    lifeA === "PURGED" || lifeA === "DELETION_REQUESTED", `lifecycle=${lifeA}`);
  console.log(`[lifecycle] A is ${lifeA} after the deletion attempt`);

  // idempotency — also allowed to throw, for the same reason the first call was.
  let again = null;
  const againErr = await throws(async () => {
    again = await deleteOwnBusinessAccount(prismaAccountDeletionStore, {
      businessId: A.biz.id,
      actorUserId: A.user.id,
    });
  });
  ok("re-requesting deletion is an idempotent no-op", again?.status === "already_deleted",
    `returned=${again ? again.status : "threw"} ${againErr ? String(againErr.message).split("\n")[0] : ""}`);
  console.log(
    `[retry] a resumed deletion ${againErr ? "FAILS THE SAME WAY — the account cannot be finished" : "converged"}`
  );

  // Anonymise-in-place is only safe if it is CONVERGENT: every value it writes is
  // a constant, so a second execution must be a no-op rather than a second pass
  // that eats further into the skeleton or lets any content back. A delete got
  // this property for free; an in-place rewrite has to prove it.
  const convRerun = await owner.conversation.count({ where: { businessId: A.biz.id } });
  const msgRerun = await owner.message.count({ where: { businessId: A.biz.id } });
  ok(
    "a second deletion does not damage the skeleton further",
    convRerun === convAfter && msgRerun === msgAfter,
    `conversations ${convAfter}->${convRerun} messages ${msgAfter}->${msgRerun}`
  );
  const rerunRows = {
    msg: await owner.message.findMany({
      where: { businessId: A.biz.id },
      select: { contentText: true, providerMessageId: true, intentLabel: true, customerId: true },
    }),
    conv: await owner.conversation.findMany({
      where: { businessId: A.biz.id },
      select: { intentType: true, sentimentSnapshot: true, customerId: true, leadId: true },
    }),
    sugg: await owner.replySuggestion.findMany({
      where: { businessId: A.biz.id },
      select: { text: true, toneLabel: true },
    }),
    analysis: await owner.messageAnalysis.findMany({
      where: { message: { businessId: A.biz.id } },
      select: { intent: true, stage: true },
    }),
  };
  ok(
    "a second deletion leaves the graph anonymised — nothing is resurrected",
    !JSON.stringify(rerunRows).includes(MARK) &&
      rerunRows.msg.every((m) => m.contentText === null && m.providerMessageId === null) &&
      rerunRows.conv.every((c) => c.customerId === null && c.leadId === null) &&
      rerunRows.sugg.every((s) => s.text === "") &&
      rerunRows.analysis.every((a) => a.intent === "" && a.stage === "")
  );

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
  // SEC-E. The erasure now CLAIMS each attempt with a LearningEvent row (the durable
  // erasure ledger), so revoking INSERT on the whole table would stop the attempt at
  // its claim — before anything is anonymised — and this phase would no longer test a
  // LATE failure. The failure is therefore made exactly as late as it always was: only
  // the ACCOUNT_DELETED evidence insert is refused, by a lab trigger, with 42501.
  await owner.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION ad2a_refuse_evidence() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN IF NEW."eventType" = 'ACCOUNT_DELETED' THEN RAISE EXCEPTION 'lab: evidence refused' USING ERRCODE = '42501'; END IF; RETURN NEW; END $f$`);
  await owner.$executeRawUnsafe(`CREATE TRIGGER ad2a_refuse_evidence BEFORE INSERT ON "LearningEvent" FOR EACH ROW EXECUTE FUNCTION ad2a_refuse_evidence()`);
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
  // Stage 2 commits in its own tenant transaction, so a stage-3 failure does not
  // roll the erasure back. That is the direction that must hold: a deletion that
  // fails LATE has still destroyed the content, and the retry has nothing left to
  // undo. The opposite — content reappearing because the run aborted — would make
  // every failed deletion a silent retention.
  const eMsgs = await owner.message.findMany({
    where: { businessId: E.biz.id },
    select: { contentText: true, providerMessageId: true, customerId: true },
  });
  const eSugg = await owner.replySuggestion.findMany({
    where: { businessId: E.biz.id },
    select: { text: true },
  });
  ok(
    "a failure AFTER anonymisation does not bring the content back",
    eMsgs.length > 0 &&
      eMsgs.every((m) => m.contentText === null && m.providerMessageId === null && m.customerId === null) &&
      eSugg.every((s) => s.text === ""),
    `messages=${eMsgs.length}`
  );
  await owner.$executeRawUnsafe(`DROP TRIGGER ad2a_refuse_evidence ON "LearningEvent"`);
  await owner.$executeRawUnsafe(`DROP FUNCTION ad2a_refuse_evidence()`);
  // J-0. This phase used to prove that restoring the missing PRIVILEGE lets the
  // deletion resume. Under the Production contract it does not, and the reason is
  // the finding: the privilege was never what stopped it. `LearningEvent` carries a
  // FOR ALL tenant policy, stage 3 runs with no tenant GUC, and a restored GRANT
  // leaves the POLICY refusing the insert exactly as before. So the phase now proves
  // something narrower and true — a privilege failure is recoverable — and records
  // that the policy failure is not.
  let resumed = null;
  const resumeErr = await throws(async () => {
    resumed = await deleteOwnBusinessAccount(prismaAccountDeletionStore, {
      businessId: E.biz.id,
      actorUserId: E.user.id,
    });
  });
  ok("the deletion resumes cleanly once the audit can be written", resumed?.status === "deleted",
    `returned=${resumed ? resumed.status : "threw"} ${resumeErr ? String(resumeErr.message).split("\n")[0] : ""}`);
  if (resumeErr) {
    const eStuck = await owner.business.findUnique({ where: { id: E.biz.id } });
    console.log(
      `[resume] restoring the INSERT grant did NOT unblock the deletion — E is still ${lifecycleOf(eStuck)}.` +
        ` The blocker is the RLS policy, not the privilege.`
    );
  }

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
  // AD-2A.3 shipped a composite FK — Message(conversationId, businessId) references
  // Conversation(id, businessId) — which makes this exact corruption IMPOSSIBLE to
  // create. That constraint is the whole point of AD-2A.3, and its existence is a
  // stronger guarantee than the scanner: the scanner finds historical damage, the FK
  // prevents new damage. To keep exercising the scanner against the shape of damage
  // that predates the constraint, drop it for the injection and put it straight back.
  await owner.$executeRawUnsafe(
    `ALTER TABLE "Message" DROP CONSTRAINT IF EXISTS "Message_conversationId_businessId_fkey"`
  );
  // LAB ISOLATION HARDENING — a deliberate crash, for the proof that a killed run
  // cannot poison the next one. The FK is gone at this instant and nothing below will
  // put it back; SIGKILL bypasses every finally block. The next proof must still start
  // from a fresh database with the constraint present (its precondition checks).
  if (process.env.AD2A_CRASH_AFTER_FK_DROP === "1") {
    console.log("[battery] AD2A_CRASH_AFTER_FK_DROP: killing the process with the composite FK dropped");
    process.kill(process.pid, "SIGKILL");
  }
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

  // Undo the planted corruption, then restore the constraint so the rest of the
  // battery runs against the real, protected schema.
  await owner.$executeRawUnsafe(
    `UPDATE "Message" SET "businessId" = ${F.biz.id} WHERE "conversationId" = ${fConv.id}`
  );
  await owner.$executeRawUnsafe(
    `ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_businessId_fkey"
       FOREIGN KEY ("conversationId", "businessId") REFERENCES "Conversation"("id", "businessId")
       ON DELETE CASCADE ON UPDATE CASCADE`
  );
  const fkBack = await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM pg_constraint WHERE conname='Message_conversationId_businessId_fkey'`
  );
  ok("the AD-2A.3 composite FK is restored after the scanner fixture", fkBack[0].n === 1);

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

  // ── Phase 13b: S8 failure matrix — object deletion is NOT transactional ───
  //
  // Deleting an object is a network call; PostgreSQL knows nothing about it. So the
  // question is not "is it atomic" (it is not) but "which orders are safe, and does a
  // second run converge". Each case below is produced for real, not simulated with a
  // stub: the object is made undeletable by putting a DIRECTORY where the file was,
  // and the row is made undeletable by REVOKING the privilege.
  console.log("--- phase 13b: S8 failure matrix ---");
  const fsp = await import("node:fs/promises");
  const nodePath = await import("node:path");
  const storageRoot = process.env.LOCAL_STORAGE_ROOT;
  const objectPath = (key) => nodePath.join(storageRoot, key);

  // CASE B — object delete FAILS → the row and its key must survive, the erasure must
  // fail, and the account must not be reported deleted.
  const S1 = await mkBiz("S1");
  await fsp.rm(objectPath(S1.attachmentKey));
  await fsp.mkdir(objectPath(S1.attachmentKey)); // a directory cannot be unlinked as a file
  const caseBErr = await throws(() =>
    deleteOwnBusinessAccount(prismaAccountDeletionStore, { businessId: S1.biz.id, actorUserId: S1.user.id })
  );
  const s1Row = await owner.crmAttachment.findFirst({ where: { businessId: S1.biz.id } });
  const s1Biz = await owner.business.findUnique({ where: { id: S1.biz.id } });
  const fmB = ok(
    "S8-FM-B · object delete fails → erasure fails, row and storageKey survive, account NOT purged",
    caseBErr !== null &&
      s1Row !== null &&
      s1Row.storageKey === S1.attachmentKey &&
      lifecycleOf(s1Biz) !== "PURGED",
    `threw=${caseBErr !== null} row=${s1Row !== null} lifecycle=${lifecycleOf(s1Biz)}`
  );
  // CASE E — the obstacle is gone and the object is now simply absent. A retry must
  // converge rather than fail on "already deleted".
  await fsp.rmdir(objectPath(S1.attachmentKey));
  const retryB = await throws(() =>
    deleteOwnBusinessAccount(prismaAccountDeletionStore, { businessId: S1.biz.id, actorUserId: S1.user.id })
  );
  const fmE = ok(
    "S8-FM-E · retry with the object ALREADY ABSENT converges (row gone, object gone)",
    retryB === null &&
      (await owner.crmAttachment.count({ where: { businessId: S1.biz.id } })) === 0 &&
      (await getStorageService().headObject(S1.attachmentKey)).exists === false,
    `threw=${retryB !== null}`
  );

  // CASE C — object delete SUCCEEDS and the row delete FAILS. The object is gone, the
  // row survives with its key, and the erasure must not claim success.
  const S2 = await mkBiz("S2");
  await owner.$executeRawUnsafe(`REVOKE DELETE ON "CrmAttachment" FROM ${RT_ROLE}`);
  const caseCErr = await throws(() =>
    deleteOwnBusinessAccount(prismaAccountDeletionStore, { businessId: S2.biz.id, actorUserId: S2.user.id })
  );
  const s2Row = await owner.crmAttachment.findFirst({ where: { businessId: S2.biz.id } });
  const s2Object = await getStorageService().headObject(S2.attachmentKey);
  const s2Biz = await owner.business.findUnique({ where: { id: S2.biz.id } });
  const fmC = ok(
    "S8-FM-C · row delete fails after the object is gone → row+key survive, account NOT purged",
    caseCErr !== null && s2Row !== null && s2Object.exists === false && lifecycleOf(s2Biz) !== "PURGED",
    `threw=${caseCErr !== null} row=${s2Row !== null} object=${s2Object.exists} lifecycle=${lifecycleOf(s2Biz)}`
  );
  // CASE D — retry after C. The object is already absent; the delete is idempotent, so
  // the second run reaches the row and both end up gone.
  await owner.$executeRawUnsafe(`GRANT DELETE ON "CrmAttachment" TO ${RT_ROLE}`);
  const retryC = await throws(() =>
    deleteOwnBusinessAccount(prismaAccountDeletionStore, { businessId: S2.biz.id, actorUserId: S2.user.id })
  );
  const fmD = ok(
    "S8-FM-D · retry after C converges: row gone, object still gone",
    retryC === null &&
      (await owner.crmAttachment.count({ where: { businessId: S2.biz.id } })) === 0 &&
      (await getStorageService().headObject(S2.attachmentKey)).exists === false,
    `threw=${retryC !== null}`
  );
  // CASE A is the main flow above (S8-A/S8-B): object gone, row gone, success.
  console.log(`  S8 FAILURE MATRIX A/B/C/D/E   = ${s8b && fmB && fmC && fmD && fmE ? "PASS" : "FAIL"}`);

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

  // ── classify every failure, always ───────────────────────────────────────
  const expected = failures.filter((f) => defectOf(f) !== null);
  const unexpected = failures.filter((f) => defectOf(f) === null);
  const nowPassing = KNOWN_DEFECTS.filter((k) => !failures.includes(k));

  if (failures.length > 0) {
    console.log("\nFAILURES, classified:");
    for (const f of failures) console.log(`  [${defectOf(f) ?? "UNEXPECTED"}] ${f}`);
  }
  console.log(
    `\nEXPECTED SECURITY FAILURES = ${expected.length}` +
      `\nUNRELATED FAILURES         = ${unexpected.length}` +
      `\nKNOWN DEFECTS NOW PASSING  = ${nowPassing.length}`
  );

  // ── two exit modes, ONE harness ──────────────────────────────────────────
  //
  // DEFAULT is the truth: every assertion here is a property Account Deletion is
  // supposed to have, so any failure is a failure. This is the mode a human
  // runs, and the mode a product fix has to turn green.
  //
  // --baseline-check is the RATCHET CI runs while the product is known broken.
  // It passes only when the failure set is EXACTLY the recorded defects. A new
  // failure fails the build; so does a recorded defect that has started passing,
  // because that is a repair which must be recorded rather than absorbed.
  if (process.argv.includes("--baseline-check")) {
    let bad = false;
    if (unexpected.length > 0) {
      console.log("\nBASELINE FAIL — failures outside the recorded defects:");
      unexpected.forEach((f) => console.log(`  - ${f}`));
      bad = true;
    }
    if (nowPassing.length > 0) {
      console.log(
        "\nBASELINE FAIL — recorded defects are now PASSING. That is good news and it" +
          "\nmust be recorded: remove them from .ad2a/known-defects.mjs in the same" +
          "\nchange that fixed them."
      );
      nowPassing.forEach((f) => console.log(`  - ${f}`));
      bad = true;
    }
    if (bad) process.exit(1);
    console.log(
      `\nBASELINE OK — the failure set is exactly the ${KNOWN_DEFECTS.length} recorded defect(s).` +
        (KNOWN_DEFECTS.length === 0
          ? " The list is empty, so the product is repaired and this mode now means the same as the default."
          : " Account Deletion is still broken, and this harness can prove it.")
    );
    process.exit(0);
  }

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
