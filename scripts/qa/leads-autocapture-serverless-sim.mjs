/**
 * Auto-capture under the REAL Production connection topology.
 *
 * Production runs Prisma against the Neon pooler with `connection_limit=1` —
 * the standard serverless recipe: every function invocation holds exactly ONE
 * connection and PgBouncer multiplexes them. My earlier capacity harness got
 * this wrong in a way that mattered: it ran many captures concurrently inside a
 * SINGLE process, so they fought over one shared Prisma pool. Production never
 * does that. Two colliding inbound messages are two separate invocations, each
 * with its own connection.
 *
 * So this simulates the topology instead of contradicting it:
 *
 *   parent  — seeds the fixtures, then forks N child PROCESSES
 *   child   — its own Prisma client, connection_limit=1, one capture, exits
 *   parent  — asserts the database afterwards
 *
 * Two modes:
 *   --mode=collision   N children race on the SAME phone (the expensive path)
 *   --mode=normal      N children capture N distinct conversations
 *
 *   CAP_DB='postgresql://...' node scripts/qa/leads-autocapture-serverless-sim.mjs --mode=collision --n=2
 */
import { spawn as spawnProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const RAW = (process.env.CAP_DB || "").trim();
if (!RAW || !/^postgres/.test(RAW)) {
  console.error("REFUSING TO RUN — set CAP_DB to an isolated database URL.");
  process.exit(2);
}
if (/ep-flat-brook|promaxgroup/i.test(RAW)) {
  console.error("REFUSING TO RUN — that looks like Production.");
  process.exit(2);
}

/** One connection, exactly as a serverless invocation gets. */
const withLimit = (url, limit) =>
  url.includes("connection_limit=") ? url : `${url}${url.includes("?") ? "&" : "?"}connection_limit=${limit}`;

/* ─────────────────────────────── CHILD ──────────────────────────────────── */

if (process.env.SIM_CHILD === "1") {
  const conversationId = Number(process.env.SIM_CONVERSATION_ID);
  const messageId = Number(process.env.SIM_MESSAGE_ID);
  const businessId = Number(process.env.SIM_BUSINESS_ID);

  process.env.DATABASE_URL = withLimit(RAW, process.env.SIM_LIMIT ?? "1");
  process.env.DIRECT_URL = process.env.DATABASE_URL;
  process.env.LEADS_AUTO_CAPTURE_ENABLED = "true";

  const { prisma } = await import("@/lib/prisma");
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const { maybeCaptureLeadFromMessage } = await import("@/lib/services/crm/lead-auto-capture.service");

  const t0 = Date.now();
  let out;
  try {
    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    const message = await prisma.message.findUniqueOrThrow({ where: { id: messageId } });
    const r = await runWithTenantContext({ businessId }, () =>
      maybeCaptureLeadFromMessage({ businessId, conversation, message })
    );
    out = { ok: true, result: r, ms: Date.now() - t0 };
  } catch (error) {
    out = { ok: false, error: String(error?.message ?? error).slice(0, 200), ms: Date.now() - t0 };
  }
  // stdout is the channel: fork's IPC does not survive the tsx loader, and a
  // single JSON line is all the parent needs.
  console.log(`__SIM__${JSON.stringify(out)}`);
  await prisma.$disconnect();
  process.exit(0);
}

/* ─────────────────────────────── PARENT ─────────────────────────────────── */

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : fallback;
};
const MODE = arg("mode", "collision");
const N = Number(arg("n", "2"));
const LIMIT = arg("limit", "1");

process.env.DATABASE_URL = withLimit(RAW, "10");
process.env.DIRECT_URL = process.env.DATABASE_URL;
const { prisma } = await import("@/lib/prisma");

const runId = `${Date.now()}`.slice(-9);
let seq = 0;

async function seed(businessId, phone) {
  const p = phone ?? `9751${runId}${(seq += 1).toString().padStart(3, "0")}`;
  const customer = await prisma.customer.upsert({
    where: { businessId_phone: { businessId, phone: p } },
    update: {},
    create: { businessId, name: `לקוח ${seq}`, phone: p },
  });
  const conversation = await prisma.conversation.create({
    data: { businessId, customerId: customer.id, channel: "WHATSAPP", status: "OPEN", currentStage: "NEW", startedAt: new Date() },
  });
  const message = await prisma.message.create({
    data: {
      businessId, conversationId: conversation.id, customerId: customer.id,
      channel: "WHATSAPP", messageType: "TEXT", direction: "INBOUND",
      senderType: "CUSTOMER", contentText: "שלום, אשמח להצעה",
    },
  });
  return { conversation, message };
}

const spawn = (businessId, conversationId, messageId) =>
  new Promise((resolve) => {
    // A real child PROCESS running through tsx — one Prisma client, one
    // connection, exactly like a serverless invocation.
    const child = spawnProcess(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["tsx", SELF],
      {
        env: {
          ...process.env,
          SIM_CHILD: "1",
          SIM_LIMIT: LIMIT,
          SIM_BUSINESS_ID: String(businessId),
          SIM_CONVERSATION_ID: String(conversationId),
          SIM_MESSAGE_ID: String(messageId),
          CAP_DB: RAW,
        },
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32",
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => { stdout += String(d); });
    child.stderr?.on("data", (d) => { stderr += String(d); });
    child.on("exit", (code) => {
      const line = stdout.split(String.fromCharCode(10)).find((l) => l.startsWith("__SIM__"));
      if (line) return resolve(JSON.parse(line.slice(7)));
      resolve({ ok: false, error: `child exited ${code}: ${(stderr || stdout).slice(-200)}`, ms: 0 });
    });
  });

async function main() {
  console.log(`\nServerless topology simulation — mode=${MODE} n=${N} connection_limit=${LIMIT} per child\n`);

  const business = await prisma.business.create({
    data: {
      name: `SIM ${runId}`,
      users: { create: { email: `sim-${runId}@example.test`, password: "x", name: "Sim" } },
    },
  });
  const businessId = business.id;

  const fixtures = [];
  if (MODE === "collision") {
    const phone = `9752${runId}00`;
    for (let i = 0; i < N; i += 1) fixtures.push(await seed(businessId, phone));
  } else {
    for (let i = 0; i < N; i += 1) fixtures.push(await seed(businessId));
  }

  const t0 = Date.now();
  const results = await Promise.all(
    fixtures.map((f) => spawn(businessId, f.conversation.id, f.message.id))
  );
  const wall = Date.now() - t0;

  const leads = await prisma.lead.count({ where: { businessId } });
  const creations = await prisma.learningEvent.count({
    where: { businessId, eventType: "LEAD_CREATED_FROM_CONVERSATION" },
  });
  const unlinked = await prisma.conversation.count({ where: { businessId, leadId: null } });
  const linkedTo = await prisma.conversation.findMany({
    where: { businessId }, select: { id: true, leadId: true },
  });
  const distinctLeadIds = new Set(linkedTo.map((c) => c.leadId).filter((x) => x != null));

  const expectedLeads = MODE === "collision" ? 1 : N;
  const outcomes = results.map((r) =>
    r.ok ? (r.result.captured ? r.result.outcome : `refused:${r.result.reason}`) : `threw:${r.error.slice(0, 60)}`
  );
  const startTimeouts = results.filter((r) => !r.ok && /Unable to start a transaction/i.test(r.error)).length;

  console.log(`  wall=${wall}ms  child latencies=${results.map((r) => r.ms).join("/")}ms`);
  console.log(`  outcomes: ${outcomes.join(" | ")}`);
  console.log(`  leads=${leads}/${expectedLeads}  creations=${creations}  unlinked=${unlinked}  distinctLeadsLinked=${distinctLeadIds.size}  txStartTimeouts=${startTimeouts}`);

  const failures = [];
  if (leads !== expectedLeads) failures.push(`lead count ${leads} != ${expectedLeads}`);
  if (creations !== expectedLeads) failures.push(`creation events ${creations} != ${expectedLeads}`);
  if (unlinked !== 0) failures.push(`${unlinked} conversation(s) left unlinked`);
  if (MODE === "collision" && distinctLeadIds.size !== 1) failures.push(`conversations point at ${distinctLeadIds.size} leads`);
  if (startTimeouts > 0) failures.push(`${startTimeouts} transaction-start timeout(s)`);

  await prisma.learningEvent.deleteMany({ where: { businessId } });
  await prisma.conversation.updateMany({ where: { businessId }, data: { leadId: null } });
  await prisma.message.deleteMany({ where: { businessId } });
  await prisma.conversation.deleteMany({ where: { businessId } });
  await prisma.lead.deleteMany({ where: { businessId } });
  await prisma.customer.deleteMany({ where: { businessId } });
  await prisma.user.deleteMany({ where: { businessId } });
  await prisma.business.delete({ where: { id: businessId } });

  console.log(failures.length === 0 ? `  RESULT: PASS\n` : `  RESULT: FAIL — ${failures.join("; ")}\n`);
  await prisma.$disconnect();
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("SIM ERROR:", e?.message ?? e);
  try { await prisma.$disconnect(); } catch { /* noop */ }
  process.exit(2);
});
