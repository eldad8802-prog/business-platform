/**
 * Business Intake M2 — WhatsApp intake stabilization battery (ephemeral PG17).
 *
 * Proves, against a real PostgreSQL, as a NOSUPERUSER / NOBYPASSRLS runtime
 * role, calling the REAL route handlers with no ambient tenant context:
 *
 *   duplicate provider delivery        → one logical intake result
 *   concurrent first messages          → every message survives; 1 customer, 1 conversation
 *   processing failure after receipt   → receipt FAILED, recoverable; retry → no duplicates
 *   receipt write failure              → 500 (the provider redelivers), nothing half-written
 *   cross-tenant receipt access        → denied (read / update / insert / no-context / DELETE)
 *   forged authenticated "inbound"     → 400, nothing written
 *   legitimate business message        → 201, server-attributed, activity kept
 *   delivery / read receipts           → update the OUTBOUND message; never an inbound message
 *   flag OFF / ON                      → stage & temperature exactly as the flag says
 *   unanswered counter                 → derived; replay and retry never inflate it
 *   profile name / referral / purge    → kept where they belong, payload purged
 *   REVOKED_BY_META / DISCONNECTED     → inbound kept / refused
 *   unsupported type                   → recorded (IGNORED), no fake message
 *
 * IntakeEvent's isolation is installed from the REAL migration file (policies,
 * grants, REVOKE), with app_runtime renamed to this lab's runtime role — the
 * battery proves the SQL that ships, not a copy of it.
 *
 * Synthetic data only. No secrets, no Neon, no network.
 *
 * Run: npx tsx .m2/whatsapp-intake-battery.ts
 *   env: DATABASE_URL (runtime role), RLS_ADMIN_URL (owner), AUTH_DATABASE_URL,
 *        AUTH_TOKEN_SECRET, WHATSAPP_APP_SECRET
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";

import { signAuthToken } from "../lib/auth-token";
import { tenantTx } from "../lib/tenant/tenant-tx";
import { runTenantJob } from "../lib/tenant/job";
import { getTenantContext } from "../lib/tenant/context";
import { POST as webhookPOST } from "../app/api/integrations/whatsapp/webhook/route";
import { POST as messagePOST } from "../app/api/message/route";
import { drainWhatsAppIntake, receiptKey } from "../lib/intake/whatsapp/whatsapp-intake";

const prisma = new PrismaClient(); // runtime role (DATABASE_URL)
let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
}

const RUN = `m2-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const PRED = `"businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int`;

function admin(): PrismaClient {
  const url = process.env.RLS_ADMIN_URL;
  if (!url) {
    console.log("  [FAIL] RLS_ADMIN_URL is not set");
    process.exit(1);
  }
  return new PrismaClient({ datasourceUrl: url });
}

function splitSql(sql: string): string[] {
  return sql
    .split(/;\s*\r?\n/)
    .map((x) => x.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean);
}

async function currentRole(): Promise<string> {
  const [row] = (await prisma.$queryRawUnsafe(
    `SELECT current_user::text AS who, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
  )) as Array<{ who: string; rolsuper: boolean; rolbypassrls: boolean }>;
  console.log(`  connected as: ${row?.who} (superuser=${row?.rolsuper}, bypassrls=${row?.rolbypassrls})`);
  if (!row || row.rolsuper || row.rolbypassrls) {
    console.log("  [FAIL] this role bypasses RLS — nothing below would prove anything");
    process.exit(1);
  }
  return row.who;
}

/** Tenant policies on the operational tables the intake writes, plus IntakeEvent from its migration. */
async function installIsolation(owner: PrismaClient, role: string) {
  for (const t of ["Customer", "Conversation", "Message"]) {
    await owner.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
    await owner.$executeRawUnsafe(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`);
    for (const [name, cmd] of [["r", "SELECT"], ["i", "INSERT"], ["u", "UPDATE"]] as const) {
      await owner.$executeRawUnsafe(`DROP POLICY IF EXISTS m2lab_${name} ON "${t}"`);
      const clause =
        cmd === "SELECT"
          ? `USING (${PRED})`
          : cmd === "INSERT"
            ? `WITH CHECK (${PRED})`
            : `USING (${PRED}) WITH CHECK (${PRED})`;
      await owner.$executeRawUnsafe(`CREATE POLICY m2lab_${name} ON "${t}" FOR ${cmd} ${clause}`);
    }
  }
  const m2 = readFileSync("prisma/migrations/20260927180000_m2_intake_event/migration.sql", "utf8");
  const rlsStart = m2.indexOf('ALTER TABLE "IntakeEvent" ENABLE ROW LEVEL SECURITY;');
  const doStart = m2.indexOf("DO $do$");
  if (rlsStart < 0 || doStart < rlsStart) throw new Error("M2 migration layout changed — update the battery");
  for (const stmt of splitSql(m2.slice(rlsStart, doStart))) {
    await owner.$executeRawUnsafe(stmt.replace(/^CREATE POLICY/, "CREATE POLICY").trim());
  }
  await owner.$executeRawUnsafe(m2.slice(doStart).trim().replace(/;\s*$/, "").replaceAll("app_runtime", role));
}

// ── webhook plumbing ─────────────────────────────────────────────────────────

function sign(body: string): string {
  return "sha256=" + createHmac("sha256", process.env.WHATSAPP_APP_SECRET!).update(body, "utf8").digest("hex");
}

type Msg = Record<string, unknown>;
function envelope(pn: string, value: Record<string, unknown>): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ id: "w", changes: [{ field: "messages", value: { metadata: { phone_number_id: pn }, ...value } }] }],
  });
}
const text = (wamid: string, from: string, body: string, extra: Msg = {}): Msg => ({
  id: wamid,
  from,
  type: "text",
  timestamp: String(Math.floor(Date.now() / 1000)),
  text: { body },
  ...extra,
});
async function post(body: string): Promise<number> {
  const res = await webhookPOST(
    new NextRequest("http://m2.local/api/integrations/whatsapp/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) },
      body,
    })
  );
  return res.status;
}
const postMessages = (pn: string, messages: Msg[], contacts: Msg[] = []) =>
  post(envelope(pn, { messages, ...(contacts.length ? { contacts } : {}) }));

async function main() {
  const role = await currentRole();
  ok("no ambient tenant context, as in a real request", getTenantContext() === undefined);
  const owner = admin();
  await installIsolation(owner, role);

  // ── fixtures (owner) ───────────────────────────────────────────────────────
  const bizA = await owner.business.create({ data: { name: `${RUN}-A` } });
  const bizB = await owner.business.create({ data: { name: `${RUN}-B` } });
  const userA = await owner.user.create({
    data: { email: `${RUN}-a@m2.test`, password: "x", businessId: bizA.id, role: "USER" },
  });
  const PN_A = `${RUN}-pnA`;
  const PN_B = `${RUN}-pnB`;
  const conn = (businessId: number, phoneNumberId: string) => ({
    businessId,
    phoneNumberId,
    displayPhoneNumber: phoneNumberId,
    wabaId: `${RUN}-waba`,
    accessTokenEncrypted: "x",
    accessTokenIv: "x",
    accessTokenTag: "x",
    status: "CONNECTED" as const,
  });
  await owner.whatsAppConnection.create({ data: conn(bizA.id, PN_A) });
  await owner.whatsAppConnection.create({ data: conn(bizB.id, PN_B) });

  const countA = async () => ({
    customers: await owner.customer.count({ where: { businessId: bizA.id } }),
    conversations: await owner.conversation.count({ where: { businessId: bizA.id } }),
    messages: await owner.message.count({ where: { businessId: bizA.id } }),
    receipts: await owner.intakeEvent.count({ where: { businessId: bizA.id } }),
  });

  // ── 1. privilege posture from the migration ────────────────────────────────
  console.log("\n-- IntakeEvent privileges (from the real migration) --");
  const [priv] = (await owner.$queryRawUnsafe(
    `SELECT has_table_privilege('${role}', '"IntakeEvent"', 'INSERT') AS i,
            has_table_privilege('${role}', '"IntakeEvent"', 'UPDATE') AS u,
            has_table_privilege('${role}', '"IntakeEvent"', 'DELETE') AS d`
  )) as Array<{ i: boolean; u: boolean; d: boolean }>;
  ok("runtime may INSERT and UPDATE receipts", priv.i && priv.u, JSON.stringify(priv));
  ok("runtime may NOT DELETE receipts (REVOKE beats the default ACL)", priv.d === false);

  // ── 2. first message, profile name, referral, payload purge ────────────────
  console.log("\n-- first message --");
  const ROI = "972501111111";
  const w1 = `wamid.${RUN}.1`;
  let status = await postMessages(
    PN_A,
    [text(w1, ROI, "כמה עולה התקנה?", { referral: { source_type: "ad", source_id: "ad-777", ctwa_clid: "clid-9", body: "dropped" } })],
    [{ wa_id: ROI, profile: { name: "Roi" } }]
  );
  ok("webhook answered 200 after the receipt was durable", status === 200, `status=${status}`);
  const m1 = await owner.message.findFirst({ where: { businessId: bizA.id, providerMessageId: w1 } });
  ok("the message exists", !!m1 && m1.direction === "INBOUND" && m1.senderType === "CUSTOMER");
  const roi = await owner.customer.findFirst({ where: { businessId: bizA.id, phone: ROI } });
  ok("new sender named from the WhatsApp profile, not the number", roi?.name === "Roi", String(roi?.name));
  const r1 = await owner.intakeEvent.findFirst({ where: { businessId: bizA.id, externalEventId: receiptKey(w1) } });
  ok("receipt PROCESSED and linked", r1?.status === "PROCESSED" && r1.messageId === m1?.id, JSON.stringify(r1?.status));
  ok("receipt key is a hash, not the raw wamid", r1?.externalEventId.startsWith("sha256:") === true && !r1?.externalEventId.includes(w1));
  ok("payload purged on processing", r1?.payload === null && r1?.payloadPurgedAt !== null);
  const meta = r1?.metadata as { messageType?: string; referral?: { sourceId?: string; ctwaClid?: string } } | null;
  ok("click-to-WhatsApp referral kept as metadata", meta?.referral?.sourceId === "ad-777" && meta?.referral?.ctwaClid === "clid-9");
  ok("referral body not kept", !JSON.stringify(r1?.metadata ?? {}).includes("dropped"));
  const leadsA = await owner.lead.count({ where: { businessId: bizA.id } });
  ok("a message did NOT create a lead", leadsA === 0);

  // ── 3. duplicate delivery ──────────────────────────────────────────────────
  console.log("\n-- duplicate delivery --");
  const before = await countA();
  status = await postMessages(PN_A, [text(w1, ROI, "כמה עולה התקנה?")]);
  await Promise.all([postMessages(PN_A, [text(w1, ROI, "x")]), postMessages(PN_A, [text(w1, ROI, "x")])]);
  const after = await countA();
  ok("redelivered wamid → 200", status === 200);
  ok("duplicate + concurrent duplicate deliveries → one logical result", JSON.stringify(before) === JSON.stringify(after), `${JSON.stringify(before)} → ${JSON.stringify(after)}`);

  // ── 4. concurrent first messages from a NEW sender ─────────────────────────
  console.log("\n-- concurrent first messages (the lost-message race) --");
  const NEW = "972502222222";
  const burst = Array.from({ length: 6 }, (_, i) => `wamid.${RUN}.burst.${i}`);
  const statuses = await Promise.all(burst.map((w, i) => postMessages(PN_A, [text(w, NEW, `הודעה ${i}`)])));
  ok("every concurrent delivery answered 200", statuses.every((s) => s === 200), JSON.stringify(statuses));
  const burstMsgs = await owner.message.count({ where: { businessId: bizA.id, providerMessageId: { in: burst } } });
  ok("every concurrent first message survived", burstMsgs === burst.length, `${burstMsgs}/${burst.length}`);
  const newCustomers = await owner.customer.count({ where: { businessId: bizA.id, phone: NEW } });
  ok("exactly one customer for the new sender", newCustomers === 1, String(newCustomers));
  const newCust = await owner.customer.findFirst({ where: { businessId: bizA.id, phone: NEW } });
  const openConvs = await owner.conversation.count({
    where: { businessId: bizA.id, customerId: newCust?.id ?? -1, status: "OPEN", channel: "WHATSAPP" },
  });
  ok("exactly one OPEN conversation for the new sender", openConvs === 1, String(openConvs));
  const burstConv = await owner.conversation.findFirst({ where: { businessId: bizA.id, customerId: newCust?.id ?? -1 } });
  ok("unanswered count derived = messages since last reply", burstConv?.unansweredInboundCount === burst.length, String(burstConv?.unansweredInboundCount));

  // ── 5. processing failure after a durable receipt → recoverable ────────────
  console.log("\n-- processing failure after the receipt --");
  const wFail = `wamid.${RUN}.fail`;
  await owner.$executeRawUnsafe(`REVOKE INSERT ON "Message" FROM ${role}`);
  status = await postMessages(PN_A, [text(wFail, ROI, "האם אתם זמינים מחר?")]);
  await owner.$executeRawUnsafe(`GRANT INSERT ON "Message" TO ${role}`);
  const rFail = await owner.intakeEvent.findFirst({ where: { businessId: bizA.id, externalEventId: receiptKey(wFail) } });
  ok("provider still got 200 — the receipt was durable", status === 200, `status=${status}`);
  ok("the receipt is FAILED with a bounded code, not lost", rFail?.status === "FAILED" && !!rFail.lastErrorCode && rFail.nextAttemptAt !== null, `${rFail?.status} ${rFail?.lastErrorCode}`);
  ok("its payload is kept for the retry", rFail?.payload !== null);
  ok("no message yet", (await owner.message.count({ where: { businessId: bizA.id, providerMessageId: wFail } })) === 0);
  // Retry: the sweeper's path, as if the backoff has elapsed.
  const later = new Date(Date.now() + 60 * 60 * 1000);
  await runTenantJob({ businessId: bizA.id }, () => drainWhatsAppIntake(bizA.id, { now: later }));
  const rFixed = await owner.intakeEvent.findFirst({ where: { id: rFail?.id ?? -1 } });
  ok("retry processed the event", rFixed?.status === "PROCESSED", String(rFixed?.status));
  const beforeRetry = await countA();
  await runTenantJob({ businessId: bizA.id }, () => drainWhatsAppIntake(bizA.id, { now: new Date(later.getTime() + 3_600_000) }));
  await postMessages(PN_A, [text(wFail, ROI, "האם אתם זמינים מחר?")]);
  ok("further retries and redelivery → no duplicate customer / conversation / message",
    JSON.stringify(beforeRetry) === JSON.stringify(await countA()));
  ok("the recovered message exists exactly once",
    (await owner.message.count({ where: { businessId: bizA.id, providerMessageId: wFail } })) === 1);

  // ── 6. receipt write failure → 500 ─────────────────────────────────────────
  console.log("\n-- receipt write failure --");
  const wNoAck = `wamid.${RUN}.noack`;
  await owner.$executeRawUnsafe(`REVOKE INSERT ON "IntakeEvent" FROM ${role}`);
  status = await postMessages(PN_A, [text(wNoAck, ROI, "lost?")]);
  await owner.$executeRawUnsafe(`GRANT INSERT ON "IntakeEvent" TO ${role}`);
  ok("a receipt that cannot be written is NOT acknowledged (500 → Meta redelivers)", status === 500, `status=${status}`);
  ok("and nothing half-written", (await owner.message.count({ where: { providerMessageId: wNoAck } })) === 0);
  status = await postMessages(PN_A, [text(wNoAck, ROI, "lost?")]);
  ok("the redelivery is accepted and processed",
    status === 200 && (await owner.message.count({ where: { businessId: bizA.id, providerMessageId: wNoAck } })) === 1);

  // ── 7. cross-tenant ────────────────────────────────────────────────────────
  console.log("\n-- cross-tenant --");
  await postMessages(PN_B, [text(`wamid.${RUN}.b1`, "972503333333", "B")]);
  const bEvent = await owner.intakeEvent.findFirst({ where: { businessId: bizB.id } });
  ok("B's receipt exists", !!bEvent);
  const seenByA = await tenantTx(bizA.id, (tx) => tx.intakeEvent.findMany({ where: { businessId: bizB.id } }));
  ok("A cannot read B's receipts", seenByA.length === 0);
  const updByA = await tenantTx(bizA.id, (tx) =>
    tx.intakeEvent.updateMany({ where: { id: bEvent?.id ?? -1 }, data: { lastErrorCode: "evil" } })
  );
  ok("A cannot update B's receipt", updByA.count === 0);
  let insertRefused = false;
  try {
    await tenantTx(bizA.id, (tx) =>
      tx.intakeEvent.create({
        data: { businessId: bizB.id, provider: "WHATSAPP", kind: "MESSAGE_RECEIVED", externalEventId: `${RUN}-evil` },
      })
    );
  } catch {
    insertRefused = true;
  }
  ok("A cannot write a receipt into B (WITH CHECK)", insertRefused);
  const noContext = await prisma.intakeEvent.count();
  ok("no tenant context → zero receipts visible", noContext === 0, String(noContext));
  let deleteRefused = false;
  try {
    await tenantTx(bizA.id, (tx) => tx.intakeEvent.deleteMany({ where: { businessId: bizA.id } }));
  } catch {
    deleteRefused = true;
  }
  ok("the runtime cannot delete receipts", deleteRefused);
  ok("B's message stayed in B", (await owner.message.count({ where: { businessId: bizB.id } })) === 1 &&
    (await owner.message.count({ where: { businessId: bizA.id, contentText: "B" } })) === 0);

  // ── 8. /api/message trust boundary ─────────────────────────────────────────
  console.log("\n-- /api/message --");
  const tokA = signAuthToken(userA.id, userA.tokenVersion);
  const convRoi = await owner.conversation.findFirst({ where: { businessId: bizA.id, customerId: roi?.id ?? -1 } });
  const msgsBefore = await owner.message.count({ where: { businessId: bizA.id } });
  const forged = await messagePOST(
    new NextRequest("http://m2.local/api/message", {
      method: "POST",
      headers: { authorization: `Bearer ${tokA}`, "content-type": "application/json" },
      body: JSON.stringify({ conversationId: convRoi?.id, contentText: "fake", direction: "INBOUND", senderType: "CUSTOMER" }),
    })
  );
  ok("forged INBOUND/CUSTOMER → 400", forged.status === 400, `status=${forged.status}`);
  const forged2 = await messagePOST(
    new NextRequest("http://m2.local/api/message", {
      method: "POST",
      headers: { authorization: `Bearer ${tokA}`, "content-type": "application/json" },
      body: JSON.stringify({ conversationId: convRoi?.id, contentText: "fake", senderType: "CUSTOMER" }),
    })
  );
  ok("forged senderType alone → 400", forged2.status === 400);
  ok("nothing written by the forgeries", (await owner.message.count({ where: { businessId: bizA.id } })) === msgsBefore);
  // Legitimate business reply — on a non-WhatsApp conversation so no provider call leaves CI.
  const convOther = await owner.conversation.create({
    data: { businessId: bizA.id, customerId: roi?.id, channel: "OTHER", status: "OPEN" },
  });
  await owner.message.create({
    data: { conversationId: convOther.id, businessId: bizA.id, channel: "OTHER", direction: "INBOUND", senderType: "CUSTOMER", contentText: "q" },
  });
  const reply = await messagePOST(
    new NextRequest("http://m2.local/api/message", {
      method: "POST",
      headers: { authorization: `Bearer ${tokA}`, "content-type": "application/json" },
      body: JSON.stringify({ conversationId: convOther.id, contentText: "המחיר 200 ₪" }),
    })
  );
  const replyBody = (await reply.json()) as { message?: { direction: string; senderType: string; channel: string } };
  ok("legitimate business reply → 201", reply.status === 201, `status=${reply.status}`);
  ok("server-attributed OUTBOUND / BUSINESS_USER on the conversation's channel",
    replyBody.message?.direction === "OUTBOUND" && replyBody.message?.senderType === "BUSINESS_USER" && replyBody.message?.channel === "OTHER");
  const convOtherAfter = await owner.conversation.findFirst({ where: { id: convOther.id } });
  ok("activity kept without the state-writer flag: reply stamped, unanswered reset",
    convOtherAfter?.businessLastOutboundAt !== null && convOtherAfter?.unansweredInboundCount === 0,
    JSON.stringify({ out: convOtherAfter?.businessLastOutboundAt, un: convOtherAfter?.unansweredInboundCount }));

  // ── 9. delivery / read receipts ────────────────────────────────────────────
  console.log("\n-- delivery / read receipts --");
  const outWamid = `wamid.${RUN}.out`;
  const outMsg = await owner.message.create({
    data: {
      conversationId: convRoi!.id,
      businessId: bizA.id,
      channel: "WHATSAPP",
      direction: "OUTBOUND",
      senderType: "BUSINESS_USER",
      contentText: "reply",
      providerMessageId: outWamid,
      sendStatus: "SENT",
    },
  });
  const inboundBefore = await owner.message.count({ where: { businessId: bizA.id, direction: "INBOUND" } });
  const ts = String(Math.floor(Date.now() / 1000));
  status = await post(envelope(PN_A, {
    statuses: [
      { id: outWamid, status: "delivered", timestamp: ts, recipient_id: ROI },
      { id: outWamid, status: "read", timestamp: ts, recipient_id: ROI },
      { id: `wamid.${RUN}.unknown`, status: "delivered", timestamp: ts, recipient_id: ROI },
    ],
  }));
  const outAfter = await owner.message.findFirst({ where: { id: outMsg.id } });
  ok("status webhook → 200", status === 200);
  ok("delivered / read applied to the OUTBOUND message", !!outAfter?.deliveredAt && !!outAfter?.readAt);
  ok("receipts never become inbound messages",
    (await owner.message.count({ where: { businessId: bizA.id, direction: "INBOUND" } })) === inboundBefore);
  const statusReceipts = await owner.intakeEvent.findMany({ where: { businessId: bizA.id, kind: "MESSAGE_STATUS" } });
  ok("status receipts recorded", statusReceipts.length === 3, String(statusReceipts.length));
  ok("a status for an unknown message is IGNORED, not invented",
    statusReceipts.some((r) => r.status === "IGNORED" && r.lastErrorCode === "unknown_outbound_message"));
  ok("status receipts keep no recipient phone (payload purged, metadata non-personal)",
    statusReceipts.every((r) => !JSON.stringify(r).includes(ROI)));
  // Replay of the same statuses: nothing moves, nothing new is recorded.
  const deliveredAtBefore = outAfter?.deliveredAt?.getTime();
  const readAtBefore = outAfter?.readAt?.getTime();
  await post(envelope(PN_A, {
    statuses: [
      { id: outWamid, status: "delivered", timestamp: String(Number(ts) + 60), recipient_id: ROI },
      { id: outWamid, status: "read", timestamp: String(Number(ts) + 60), recipient_id: ROI },
    ],
  }));
  const outReplayed = await owner.message.findFirst({ where: { id: outMsg.id } });
  ok("replayed statuses change nothing (delivered/read keep their first time)",
    outReplayed?.deliveredAt?.getTime() === deliveredAtBefore && outReplayed?.readAt?.getTime() === readAtBefore);
  ok("replayed statuses record no new receipt",
    (await owner.intakeEvent.count({ where: { businessId: bizA.id, kind: "MESSAGE_STATUS" } })) === statusReceipts.length);
  ok("replayed statuses still never become inbound messages",
    (await owner.message.count({ where: { businessId: bizA.id, direction: "INBOUND" } })) === inboundBefore);
  // A late failed status after delivery is not believed.
  await post(envelope(PN_A, { statuses: [{ id: outWamid, status: "failed", timestamp: ts, errors: [{ code: 131026 }] }] }));
  ok("a failed status after delivery does not overwrite it",
    (await owner.message.findFirst({ where: { id: outMsg.id } }))?.sendStatus === "SENT");

  // ── 10. state-writer flag preserved (OFF / ON) ─────────────────────────────
  console.log("\n-- CONVERSATION_STATE_WRITER_ENABLED --");
  delete process.env.CONVERSATION_STATE_WRITER_ENABLED;
  const OFF = "972504444444";
  await postMessages(PN_A, [text(`wamid.${RUN}.off`, OFF, "כמה זה עולה?")]);
  const offConv = await owner.conversation.findFirst({
    where: { businessId: bizA.id, customer: { phone: OFF } },
  });
  ok("flag OFF: stage / temperature untouched", offConv?.currentStage === null && offConv?.temperatureScore === null,
    JSON.stringify({ s: offConv?.currentStage, t: offConv?.temperatureScore }));
  ok("flag OFF: activity still kept", offConv?.lastMessageAt !== null && offConv?.customerLastInboundAt !== null && offConv?.unansweredInboundCount === 1);
  process.env.CONVERSATION_STATE_WRITER_ENABLED = "true";
  const ON = "972505555555";
  await postMessages(PN_A, [text(`wamid.${RUN}.on`, ON, "כמה זה עולה?")]);
  const onConv = await owner.conversation.findFirst({ where: { businessId: bizA.id, customer: { phone: ON } } });
  ok("flag ON: stage and temperature written as before", onConv?.currentStage !== null && onConv?.temperatureScore !== null,
    JSON.stringify({ s: onConv?.currentStage, t: onConv?.temperatureScore }));
  ok("flag ON: the two writers agree on the counter", onConv?.unansweredInboundCount === 1);
  delete process.env.CONVERSATION_STATE_WRITER_ENABLED;

  // ── 11. counter is retry-safe ──────────────────────────────────────────────
  console.log("\n-- unanswered counter --");
  const convBeforeReplay = await owner.conversation.findFirst({ where: { id: offConv!.id } });
  const cntBefore = convBeforeReplay?.unansweredInboundCount;
  await postMessages(PN_A, [text(`wamid.${RUN}.off`, OFF, "כמה זה עולה?")]);
  await runTenantJob({ businessId: bizA.id }, () => drainWhatsAppIntake(bizA.id, { now: new Date(Date.now() + 86_400_000) }));
  const convAfterReplay = await owner.conversation.findFirst({ where: { id: offConv!.id } });
  ok("replay + retry do not inflate the counter", convAfterReplay?.unansweredInboundCount === cntBefore);
  ok("replay never moves timestamps backwards",
    (convAfterReplay?.lastMessageAt?.getTime() ?? 0) >= (convBeforeReplay?.lastMessageAt?.getTime() ?? 0) &&
      (convAfterReplay?.customerLastInboundAt?.getTime() ?? 0) >= (convBeforeReplay?.customerLastInboundAt?.getTime() ?? 0));
  // A second genuine message moves them forward and adds exactly one.
  await postMessages(PN_A, [text(`wamid.${RUN}.off2`, OFF, "ועוד שאלה")]);
  const convSecond = await owner.conversation.findFirst({ where: { id: offConv!.id } });
  ok("a new message moves lastMessageAt forward and adds exactly one",
    (convSecond?.lastMessageAt?.getTime() ?? 0) >= (convAfterReplay?.lastMessageAt?.getTime() ?? 0) &&
      convSecond?.unansweredInboundCount === (cntBefore ?? 0) + 1,
    String(convSecond?.unansweredInboundCount));

  // ── 12. profile name never overwrites an owner-set name ────────────────────
  console.log("\n-- profile name --");
  await owner.customer.update({ where: { id: roi!.id }, data: { name: "Roi Cohen (owner)" } });
  await postMessages(PN_A, [text(`wamid.${RUN}.p2`, ROI, "שוב")], [{ wa_id: ROI, profile: { name: "roi_wa" } }]);
  ok("owner-set name kept", (await owner.customer.findFirst({ where: { id: roi!.id } }))?.name === "Roi Cohen (owner)");
  const PH = "972506666666";
  await owner.customer.create({ data: { businessId: bizA.id, name: PH, phone: PH } });
  await postMessages(PN_A, [text(`wamid.${RUN}.p3`, PH, "hi")], [{ wa_id: PH, profile: { name: "Dana" } }]);
  ok("placeholder (number-as-name) upgraded to the profile name",
    (await owner.customer.findFirst({ where: { businessId: bizA.id, phone: PH } }))?.name === "Dana");

  // ── 13. connection state (W8) ──────────────────────────────────────────────
  console.log("\n-- connection state --");
  await owner.whatsAppConnection.update({ where: { phoneNumberId: PN_A }, data: { status: "REVOKED_BY_META" } });
  const wRev = `wamid.${RUN}.revoked`;
  status = await postMessages(PN_A, [text(wRev, ROI, "עדיין שם?")]);
  ok("REVOKED_BY_META (outbound token failure) still receives inbound",
    status === 200 && (await owner.message.count({ where: { businessId: bizA.id, providerMessageId: wRev } })) === 1);
  await owner.whatsAppConnection.update({ where: { phoneNumberId: PN_A }, data: { status: "ERROR" } });
  const wErr = `wamid.${RUN}.error-state`;
  status = await postMessages(PN_A, [text(wErr, ROI, "שלום?")]);
  ok("ERROR (recorded transient error) still receives inbound",
    status === 200 && (await owner.message.count({ where: { businessId: bizA.id, providerMessageId: wErr } })) === 1);
  await owner.whatsAppConnection.update({ where: { phoneNumberId: PN_A }, data: { status: "REVOKED" } });
  const wOwnerRev = `wamid.${RUN}.owner-revoked`;
  const receiptsBeforeRevoked = await owner.intakeEvent.count({ where: { businessId: bizA.id } });
  status = await postMessages(PN_A, [text(wOwnerRev, ROI, "ghost")]);
  ok("REVOKED (explicit revocation) → 200, nothing recorded",
    status === 200 &&
      (await owner.intakeEvent.count({ where: { businessId: bizA.id } })) === receiptsBeforeRevoked &&
      (await owner.message.count({ where: { providerMessageId: wOwnerRev } })) === 0);
  await owner.whatsAppConnection.update({ where: { phoneNumberId: PN_A }, data: { status: "DISCONNECTED" } });
  const wDis = `wamid.${RUN}.disconnected`;
  const receiptsBefore = await owner.intakeEvent.count({ where: { businessId: bizA.id } });
  status = await postMessages(PN_A, [text(wDis, ROI, "ghost")]);
  ok("DISCONNECTED (owner stop) → 200, nothing recorded",
    status === 200 && (await owner.intakeEvent.count({ where: { businessId: bizA.id } })) === receiptsBefore);
  await owner.whatsAppConnection.update({ where: { phoneNumberId: PN_A }, data: { status: "CONNECTED" } });

  // ── 14. unsupported type ───────────────────────────────────────────────────
  console.log("\n-- unsupported type --");
  const wAudio = `wamid.${RUN}.audio`;
  const msgsBeforeAudio = await owner.message.count({ where: { businessId: bizA.id } });
  await postMessages(PN_A, [{ id: wAudio, from: ROI, type: "audio", timestamp: ts, audio: { id: "media-1" } }]);
  const rAudio = await owner.intakeEvent.findFirst({ where: { businessId: bizA.id, externalEventId: receiptKey(wAudio) } });
  ok("audio is recorded (IGNORED), not dropped without trace",
    rAudio?.status === "IGNORED" && (rAudio?.lastErrorCode ?? "").startsWith("unsupported:"), `${rAudio?.status} ${rAudio?.lastErrorCode}`);
  ok("and no fake message is created", (await owner.message.count({ where: { businessId: bizA.id } })) === msgsBeforeAudio);

  // ── cleanup ────────────────────────────────────────────────────────────────
  for (const id of [bizA.id, bizB.id]) {
    await owner.$executeRawUnsafe(`DELETE FROM "Business" WHERE id = ${id}`);
  }
  await owner.$disconnect();

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  - ${f}`);
    console.log("M2 WHATSAPP INTAKE BATTERY: FAIL");
    process.exit(1);
  }
  console.log("M2 WHATSAPP INTAKE BATTERY: PASS");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
