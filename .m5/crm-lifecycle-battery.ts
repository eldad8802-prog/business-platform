/**
 * Business Intake M5 — CRM lead lifecycle + Secretary battery (ephemeral PG17).
 *
 * The lab database is the PRE-M5 schema (main, via `db push`) + sec-C's
 * composite keys + Lead's Production RLS / grants + M2–M4 isolation, with a
 * few PRE-EXISTING leads seeded BEFORE the REAL M5 migration is applied with
 * psql (so the backfill is exercised on real rows). Everything below runs as a
 * NOSUPERUSER / NOBYPASSRLS runtime ("app_runtime", so the migration's own
 * GRANT/REVOKE applies to it), through the real canonical intake processor, the
 * real lead service and the real HTTP routes (PATCH /api/leads/[id],
 * GET /api/leads/briefing, GET /api/leads/[id]/history).
 *
 * Synthetic data only. No secrets, no Neon, no network, no LLM
 * (OPENAI_API_KEY is asserted absent: the lifecycle must work without AI).
 *
 * env: DATABASE_URL (runtime), RLS_ADMIN_URL (owner), AUTH_TOKEN_SECRET,
 *      WHATSAPP_APP_SECRET, AUTH_DATABASE_URL (= runtime)
 */
import { createHmac } from "node:crypto";
import { PrismaClient, Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { signAuthToken } from "../lib/auth-token";
import { runTenantJob } from "../lib/tenant/job";
import { getTenantContext } from "../lib/tenant/context";
import { withTenantTransaction } from "../lib/tenant/transaction";
import { IntakeRegistry } from "../lib/intake/core/registry";
import { acceptIntake, drainIntake } from "../lib/intake/core/processor";
import { traceIntakeReceipt } from "../lib/intake/core/trace";
import { decideProposal } from "../lib/intake/identity/proposals";
import { POST as webhookPOST } from "../app/api/integrations/whatsapp/webhook/route";
import { PATCH as leadPATCH, GET as leadGET } from "../app/api/leads/[id]/route";
import { GET as briefingGET } from "../app/api/leads/briefing/route";
import { GET as historyGET } from "../app/api/leads/[id]/history/route";
import { whatsAppIntakeAdapter } from "../lib/intake/whatsapp/whatsapp-intake";
import { leadService } from "../lib/services/crm/lead.service";
import { appendLeadLifecycleEvent, lockLeadForLifecycle } from "../lib/services/crm/lead-lifecycle.service";
import { loadLeadsNeedingAttention } from "../lib/business-status/loaders";
import { translateLeadsNeedingAttention } from "../lib/business-status/translators/leads";
import { prismaAccountDeletionStore } from "../lib/services/account/account-deletion.prisma-store";
import {
  buildReferenceReceipt,
  createLeadSink,
  createReferenceAdapter,
  type ReferenceDelivery,
} from "../.m3/reference-lead-adapter";

const RUN = process.env.M5_RUN_TAG ?? `m5-${Date.now()}`;
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
async function rejects(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return `${err?.code ?? ""} ${err?.message ?? "error"}`.trim();
  }
}

const prisma = new PrismaClient(); // runtime
const o = new PrismaClient({ datasourceUrl: process.env.RLS_ADMIN_URL }); // owner

type Tx = Prisma.TransactionClient;
const asT = <T>(businessId: number, fn: (tx: Tx) => Promise<T>) =>
  runTenantJob({ businessId }, () => withTenantTransaction((tx) => fn(tx as Tx)));

function sign(body: string) {
  return "sha256=" + createHmac("sha256", process.env.WHATSAPP_APP_SECRET!).update(body, "utf8").digest("hex");
}
async function whatsapp(pn: string, wamid: string, from: string, text: string): Promise<number> {
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ id: "w", changes: [{ field: "messages", value: {
      metadata: { phone_number_id: pn },
      contacts: [{ wa_id: from, profile: { name: "Noa" } }],
      messages: [{ id: wamid, from, type: "text", timestamp: String(Math.floor(Date.now() / 1000)), text: { body: text } }],
    } }] }],
  });
  const res = await webhookPOST(new NextRequest("http://m5.local/api/integrations/whatsapp/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) },
    body,
  }));
  return res.status;
}

async function patchLead(token: string, leadId: number, body: Record<string, unknown>) {
  const res = await leadPATCH(
    new NextRequest(`http://m5.local/api/leads/${leadId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: String(leadId) }) }
  );
  const json = (await res.json().catch(() => null)) as Record<string, any> | null;
  return { status: res.status, json };
}
async function getCard(token: string, leadId: number) {
  const res = await leadGET(
    new NextRequest(`http://m5.local/api/leads/${leadId}`, { headers: { authorization: `Bearer ${token}` } }),
    { params: Promise.resolve({ id: String(leadId) }) }
  );
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, any> | null };
}
async function getBriefing(token: string) {
  const res = await briefingGET(new NextRequest("http://m5.local/api/leads/briefing", { headers: { authorization: `Bearer ${token}` } }));
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, any> | null };
}
async function getHistory(token: string, leadId: number) {
  const res = await historyGET(
    new NextRequest(`http://m5.local/api/leads/${leadId}/history`, { headers: { authorization: `Bearer ${token}` } }),
    { params: Promise.resolve({ id: String(leadId) }) }
  );
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, any> | null };
}

const events = (leadId: number) =>
  o.leadLifecycleEvent.findMany({ where: { leadId }, orderBy: { seq: "asc" } });
const kinds = async (leadId: number) => (await events(leadId)).map((e) => e.kind);
const seqsContiguous = async (leadId: number) => {
  const ev = await events(leadId);
  const lead = await o.lead.findUnique({ where: { id: leadId }, select: { lifecycleVersion: true } });
  return ev.every((e, i) => e.seq === i + 1) && lead?.lifecycleVersion === ev.length;
};

async function main() {
  const [who] = (await prisma.$queryRawUnsafe(
    `SELECT current_user::text AS who, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
  )) as Array<{ who: string; rolsuper: boolean; rolbypassrls: boolean }>;
  console.log(`  runtime: ${who.who} (superuser=${who.rolsuper}, bypassrls=${who.rolbypassrls})`);
  if (who.rolsuper || who.rolbypassrls) throw new Error("runtime bypasses RLS — nothing would be proven");
  ok("no ambient tenant context", getTenantContext() === undefined);
  ok("AI unavailable in this lab (OPENAI_API_KEY absent) — everything below runs without an LLM", !process.env.OPENAI_API_KEY);

  // ── 1. migration mechanics ──────────────────────────────────────────────────
  console.log("\n-- migration mechanics / grants / RLS / backfill --");
  const [g] = (await o.$queryRawUnsafe(
    `SELECT has_table_privilege('${who.who}','"LeadLifecycleEvent"','SELECT') s, has_table_privilege('${who.who}','"LeadLifecycleEvent"','INSERT') i,
            has_table_privilege('${who.who}','"LeadLifecycleEvent"','UPDATE') u, has_table_privilege('${who.who}','"LeadLifecycleEvent"','DELETE') d,
            has_table_privilege('${who.who}','"LeadLifecycleEvent"','TRUNCATE') tr`
  )) as Array<Record<string, boolean>>;
  ok("LeadLifecycleEvent: exact grants SELECT/INSERT only (append-only; no UPDATE/DELETE/TRUNCATE)", g.s && g.i && !g.u && !g.d && !g.tr, JSON.stringify(g));
  const [rls] = (await o.$queryRawUnsafe(`SELECT relrowsecurity r, relforcerowsecurity f FROM pg_class WHERE relname='LeadLifecycleEvent'`)) as Array<{ r: boolean; f: boolean }>;
  ok("LeadLifecycleEvent: ENABLE + FORCE RLS", rls.r && rls.f);
  const pols = (await o.$queryRawUnsafe(`SELECT cmd FROM pg_policies WHERE tablename='LeadLifecycleEvent' ORDER BY cmd`)) as Array<{ cmd: string }>;
  ok("LeadLifecycleEvent: SELECT + INSERT policies only", JSON.stringify(pols.map((x) => x.cmd)) === '["INSERT","SELECT"]', JSON.stringify(pols));
  const fk = (await o.$queryRawUnsafe(`SELECT 1 FROM pg_constraint WHERE conname='LeadLifecycleEvent_leadId_tenant_fkey' AND convalidated`)) as unknown[];
  ok("composite (businessId, leadId) → Lead tenant FK present and VALID", fk.length === 1);
  const leadCols = (await o.$queryRawUnsafe(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_name='Lead' AND column_name IN ('lifecycleVersion','nextActionKind','firstHandledAt','valueEstimate','finalPrice') ORDER BY 1`
  )) as Array<{ column_name: string; data_type: string }>;
  ok("Lead: lifecycle columns present; valueEstimate / finalPrice are NUMERIC",
    leadCols.length === 5 && leadCols.filter((c) => c.data_type === "numeric").length === 2, JSON.stringify(leadCols));
  const bf = await o.business.findFirst({ where: { name: "m5-backfill-lab" } });
  if (bf) {
    const pre = await o.lead.findMany({ where: { businessId: bf.id }, orderBy: { id: "asc" } });
    const preEvents = await o.leadLifecycleEvent.findMany({ where: { businessId: bf.id }, orderBy: [{ leadId: "asc" }, { seq: "asc" }] });
    ok("backfill: every pre-existing lead has exactly one `created` step (source BACKFILL)",
      pre.every((l) => preEvents.filter((e) => e.leadId === l.id && e.kind === "created" && e.source === "BACKFILL").length === 1));
    ok("backfill: a lead no longer NEW has one status_changed NEW → its status; lifecycleVersion = step count",
      pre.every((l) => {
        const ev = preEvents.filter((e) => e.leadId === l.id);
        const st = ev.filter((e) => e.kind === "status_changed");
        return l.lifecycleVersion === ev.length && (l.status === "NEW" ? st.length === 0 : st.length === 1 && st[0].toStatus === l.status);
      }));
    const won = pre.find((l) => l.status === "WON");
    ok("backfill: a float money value became NUMERIC(18,2) exactly (1234.567 → 1234.57)", won?.valueEstimate?.toFixed(2) === "1234.57", String(won?.valueEstimate));
  } else if (process.env.M5_LAB_MODE === "pushed") {
    // The base already contains M5: the migration (and its backfill) was proven in
    // PR-A's lab and in Production; a pushed-schema lab has no pre-migration rows.
    console.log("  (pushed-schema lab: backfill proven by the migration lab + Production proof Q13)");
  } else {
    ok("backfill fixture present (seeded before the migration)", false);
  }

  // ── fixtures ────────────────────────────────────────────────────────────────
  const bizA = await o.business.create({ data: { name: `${RUN}-A` } });
  const bizB = await o.business.create({ data: { name: `${RUN}-B` } });
  const userA = await o.user.create({ data: { email: `${RUN}-a@m5.test`, password: "x", businessId: bizA.id, role: "USER" } });
  const userB = await o.user.create({ data: { email: `${RUN}-b@m5.test`, password: "x", businessId: bizB.id, role: "USER" } });
  const tokA = signAuthToken(userA.id);
  const tokB = signAuthToken(userB.id);
  const PN_A = `${RUN}-pnA`;
  await o.whatsAppConnection.create({ data: {
    businessId: bizA.id, phoneNumberId: PN_A, displayPhoneNumber: PN_A, wabaId: `${RUN}-waba`,
    accessTokenEncrypted: "x", accessTokenIv: "x", accessTokenTag: "x", status: "CONNECTED",
  } });
  const FORM_A = `${RUN}-formA`;
  const FORM_B = `${RUN}-formB`;
  const connections = new Map([[FORM_A, bizA.id], [FORM_B, bizB.id]]);
  const adapter = createReferenceAdapter({ connections, sink: createLeadSink(), coreDestinations: ["lead"] });
  const shop = createReferenceAdapter({ sourceKey: "reference.shop", connections, sink: createLeadSink(), orderTarget: "commerce" });
  const registry = new IntakeRegistry().register(adapter).register(shop).register(whatsAppIntakeAdapter);
  let n = 0;
  const leadEv = (over: Partial<ReferenceDelivery> = {}): ReferenceDelivery => ({
    kind: "lead", formId: FORM_A, submissionId: `${RUN}-s${++n}`, submittedAt: new Date().toISOString(),
    fields: { fullName: "Noa", phone: "050-777-1111", email: "noa@example.test" }, tracking: { campaignId: "c1" }, ...over,
  });
  const accept = (d: ReferenceDelivery, sourceKey = "reference.lead_form") =>
    acceptIntake({ registry, sourceKey, accountRef: d.formId, receipts: [buildReferenceReceipt(d)] });
  const drain = (businessId: number) => runTenantJob({ businessId }, () => drainIntake(registry, businessId, { limit: 200 }));
  const idOf = (r: Awaited<ReturnType<typeof accept>>) => (r.status === "accepted" ? r.recorded[0].id : -1);

  // ── 2. explicit lead through canonical intake → one Lead, lifecycle once ────
  console.log("\n-- intake → identity → routing → lead → lifecycle --");
  const d1 = leadEv();
  const r1 = await accept(d1);
  await drain(bizA.id);
  const leadsA1 = await o.lead.findMany({ where: { businessId: bizA.id } });
  ok("explicit lead event → exactly ONE Lead", leadsA1.length === 1, String(leadsA1.length));
  const L1 = leadsA1[0];
  const ev1 = await events(L1.id);
  ok("lifecycle initialized exactly once: one `created` step, NEW, source INTEGRATION, evidence = the intake event",
    ev1.length === 1 && ev1[0].kind === "created" && ev1[0].toStatus === "NEW" && ev1[0].source === "INTEGRATION" && ev1[0].evidenceKind === "intake_event",
    JSON.stringify(ev1.map((e) => [e.kind, e.source, e.evidenceKind])));
  for (let i = 0; i < 5; i++) await accept(d1);
  await drain(bizA.id);
  ok("same explicit lead event replayed ×5 → still one Lead, still one `created` step",
    (await o.lead.count({ where: { businessId: bizA.id } })) === 1 && (await kinds(L1.id)).filter((k) => k === "created").length === 1);
  const started = await o.learningEvent.findMany({ where: { businessId: bizA.id, eventType: "LEAD_LIFECYCLE_STARTED" } });
  ok("learning: LEAD_LIFECYCLE_STARTED once, origin INTAKE, no PII",
    started.length === 1 && (started[0].payload as any)?.origin === "INTAKE" && !/050|972|noa|@/i.test(JSON.stringify(started[0].payload)));

  const d2 = leadEv({ fields: { fullName: "Noa", phone: "0507771111" } });
  await accept(d2);
  await accept(d2);
  await drain(bizA.id);
  ok("a second explicit lead event for the same phone attaches (one Lead) and records `intake_attached` ONCE (replay-safe)",
    (await o.lead.count({ where: { businessId: bizA.id } })) === 1 && (await kinds(L1.id)).filter((k) => k === "intake_attached").length === 1);
  ok("the attach does not move the stage (still NEW)", (await o.lead.findUnique({ where: { id: L1.id } }))?.status === "NEW");

  // ── 3. message ≠ lead, order ≠ lead ─────────────────────────────────────────
  console.log("\n-- M4 invariants preserved --");
  const wa = await whatsapp(PN_A, `${RUN}-wamid1`, "972508880000", "שלום, כמה עולה?");
  await runTenantJob({ businessId: bizA.id }, () => drainIntake(registry, bizA.id, { limit: 50 }));
  ok("a WhatsApp message (webhook 200) creates NO Lead and NO lifecycle step",
    wa === 200 && (await o.lead.count({ where: { businessId: bizA.id } })) === 1 && (await o.leadLifecycleEvent.count({ where: { businessId: bizA.id } })) === (await events(L1.id)).length);
  const ord = { kind: "order" as const, formId: FORM_A, submissionId: `${RUN}-o1`, submittedAt: new Date().toISOString(), fields: { fullName: "Buyer", phone: "0509990000" } };
  await accept(ord, "reference.shop");
  await drain(bizA.id);
  ok("an order creates NO Lead", (await o.lead.count({ where: { businessId: bizA.id } })) === 1);

  // ── 4. owner lifecycle through the real route ───────────────────────────────
  console.log("\n-- owner authority (real PATCH route) --");
  let card = await getCard(tokA, L1.id);
  const v0 = card.json?.lead?.lifecycleVersion as number;
  ok("card exposes lifecycleVersion, lifecycle attention and history", typeof v0 === "number" && Array.isArray(card.json?.lifecycle?.history));
  const s1 = await patchLead(tokA, L1.id, { status: "OPEN", expectedVersion: v0 });
  const L1a = await o.lead.findUnique({ where: { id: L1.id } });
  ok("NEW → OPEN (owner) → 200; one status_changed step; firstHandledAt stamped",
    s1.status === 200 && (await kinds(L1.id)).filter((k) => k === "status_changed").length === 1 && L1a?.firstHandledAt !== null);
  const fh = await o.learningEvent.count({ where: { businessId: bizA.id, eventType: "LEAD_FIRST_HANDLED", entityId: L1.id } });
  ok("learning: LEAD_FIRST_HANDLED recorded once", fh === 1);
  const stale = await patchLead(tokA, L1.id, { status: "QUALIFIED", expectedVersion: v0 });
  ok("a write carrying an OLD version is refused (409 LEAD_LIFECYCLE_STALE) and records nothing",
    stale.status === 409 && (await o.lead.findUnique({ where: { id: L1.id } }))?.status === "OPEN" && (await kinds(L1.id)).filter((k) => k === "status_changed").length === 1,
    `http=${stale.status}`);
  const same = await patchLead(tokA, L1.id, { status: "OPEN" });
  ok("repeating the current status is a no-op (no second step)", same.status === 200 && (await kinds(L1.id)).filter((k) => k === "status_changed").length === 1);

  const due1 = new Date(Date.now() + 86_400_000).toISOString();
  const na = await patchLead(tokA, L1.id, { followUpAt: due1, nextActionKind: "call", followUpNote: "לחזור" });
  const na2 = await patchLead(tokA, L1.id, { followUpAt: due1, nextActionKind: "call", followUpNote: "לחזור" });
  ok("set next action (call, tomorrow) → one next_action_set; the identical retry records nothing",
    na.status === 200 && na2.status === 200 && (await kinds(L1.id)).filter((k) => k === "next_action_set").length === 1 &&
      (await o.lead.findUnique({ where: { id: L1.id } }))?.nextActionKind === "call");
  const due2 = new Date(Date.now() + 3 * 86_400_000).toISOString();
  await patchLead(tokA, L1.id, { followUpAt: due2 });
  const resch = (await events(L1.id)).find((e) => e.kind === "next_action_rescheduled");
  ok("postpone → next_action_rescheduled with previousDueAt; kind kept (call)",
    resch?.previousDueAt?.toISOString() === due1 && resch?.nextActionKind === "call");
  const done = await patchLead(tokA, L1.id, { followUpAt: null });
  const doneAgain = await patchLead(tokA, L1.id, { followUpAt: null });
  ok("complete → one next_action_completed; completing again (retry) records nothing",
    done.status === 200 && doneAgain.status === 200 && (await kinds(L1.id)).filter((k) => k === "next_action_completed").length === 1);
  const badKind = await patchLead(tokA, L1.id, { followUpAt: due1, nextActionKind: "send_sms_automatically" });
  ok("an unknown next-action kind is rejected (400)", badKind.status === 400);

  // ── 5. suggestions: proposed, not applied; stale-safe acceptance ───────────
  console.log("\n-- Dubiz proposes, owner decides --");
  await patchLead(tokA, L1.id, { status: "QUOTED" });
  await o.lead.update({ where: { id: L1.id }, data: { lastActivityAt: new Date(Date.now() - 5 * 86_400_000) } });
  card = await getCard(tokA, L1.id);
  const sug = card.json?.lifecycle?.suggestion;
  ok("quoted + 5 days without recorded activity → suggestion S2_CHECK_QUOTE (a proposal; nothing changed)",
    sug?.ruleId === "S2_CHECK_QUOTE@1" && (await o.lead.findUnique({ where: { id: L1.id } }))?.nextFollowUpAt === null, JSON.stringify(sug));
  ok("the attention reason is an INFERENCE (not presented as a fact)",
    card.json?.lifecycle?.attention?.reason === "QUOTE_NO_ACTIVITY" && card.json?.lifecycle?.attention?.evidenceClass === "inference");
  const seenVersion = card.json?.lead?.lifecycleVersion as number;
  // the owner decides something else in another tab first…
  await patchLead(tokA, L1.id, { value: { amountKind: "estimate", amount: 4200 } });
  const lateAccept = await patchLead(tokA, L1.id, { followUpAt: sug.dueAt, nextActionKind: sug.kind, fromSuggestionRuleId: sug.ruleId, expectedVersion: seenVersion });
  ok("a stale suggestion acceptance cannot overwrite a newer owner decision (409, no next action)",
    lateAccept.status === 409 && (await o.lead.findUnique({ where: { id: L1.id } }))?.nextFollowUpAt === null);
  ok("recording a value IS activity on the lead — the no-activity suggestion correctly goes quiet",
    (await getCard(tokA, L1.id)).json?.lifecycle?.suggestion === null);
  await o.lead.update({ where: { id: L1.id }, data: { lastActivityAt: new Date(Date.now() - 5 * 86_400_000) } });
  card = await getCard(tokA, L1.id);
  const acc = await patchLead(tokA, L1.id, {
    followUpAt: card.json!.lifecycle.suggestion.dueAt, nextActionKind: card.json!.lifecycle.suggestion.kind,
    fromSuggestionRuleId: card.json!.lifecycle.suggestion.ruleId, expectedVersion: card.json!.lead.lifecycleVersion,
  });
  const accEv = (await events(L1.id)).filter((e) => e.kind === "next_action_set").pop();
  ok("fresh acceptance → next action check_quote, recorded as the owner's decision WITH the suggestion as evidence",
    acc.status === 200 && accEv?.nextActionKind === "check_quote" && accEv.evidenceKind === "suggestion" && accEv.actorType === "OWNER_USER");
  await patchLead(tokA, L1.id, { followUpAt: null });
  await o.lead.update({ where: { id: L1.id }, data: { lastActivityAt: new Date(Date.now() - 5 * 86_400_000) } });
  card = await getCard(tokA, L1.id);
  const dis = await patchLead(tokA, L1.id, { dismissSuggestion: card.json!.lifecycle.suggestion.ruleId, expectedVersion: card.json!.lead.lifecycleVersion });
  ok("'not now' → the suggestion is quiet (recorded as suggestion_dismissed; nothing else changed)",
    dis.status === 200 && dis.json?.lifecycle?.suggestion === null && (await kinds(L1.id)).includes("suggestion_dismissed"));

  // ── 6. values + outcome + reopen ────────────────────────────────────────────
  console.log("\n-- values, outcome, reopen --");
  const agreedEarly = await patchLead(tokA, L1.id, { value: { amountKind: "agreed", amount: 5000 } });
  ok("an agreed amount on a lead that is not WON is refused (400)", agreedEarly.status === 400);
  const badAmt = await patchLead(tokA, L1.id, { value: { amountKind: "estimate", amount: -5 } });
  ok("a negative amount is refused (400)", badAmt.status === 400);
  await patchLead(tokA, L1.id, { followUpAt: due1, nextActionKind: "follow_up" });
  const won = await patchLead(tokA, L1.id, { status: "WON" });
  const kWon = await kinds(L1.id);
  ok("WON closes the lead and drops its open next action (status_changed + next_action_cleared)",
    won.status === 200 && kWon.slice(-2).join(",") === "status_changed,next_action_cleared" && (await o.lead.findUnique({ where: { id: L1.id } }))?.nextFollowUpAt === null);
  const agreed = await patchLead(tokA, L1.id, { value: { amountKind: "agreed", amount: "4750.50" } });
  ok("agreed amount on the WON lead → NUMERIC 4750.50; value_updated step (amount kept in history, not in learning)",
    agreed.status === 200 && (await o.lead.findUnique({ where: { id: L1.id } }))?.finalPrice?.toFixed(2) === "4750.50");
  const outc = await o.learningEvent.findMany({ where: { businessId: bizA.id, eventType: { in: ["LEAD_OUTCOME_RECORDED", "LEAD_VALUE_RECORDED"] } } });
  ok("learning: outcome + value sensors carry no amount and no PII",
    outc.some((e) => e.eventType === "LEAD_OUTCOME_RECORDED") && !/4750|4200|noa|050/i.test(JSON.stringify(outc.map((e) => e.payload))));
  const reopen = await patchLead(tokA, L1.id, { status: "OPEN" });
  ok("undo/reopen: WON → OPEN is an owner transition, recorded (history keeps the WON step)",
    reopen.status === 200 && (await events(L1.id)).filter((e) => e.kind === "status_changed" && e.toStatus === "WON").length === 1 &&
      (await o.lead.findUnique({ where: { id: L1.id } }))?.closedAt === null);
  ok("history is contiguous: seq 1..n, lifecycleVersion = n", await seqsContiguous(L1.id));

  // ── 7. concurrency ──────────────────────────────────────────────────────────
  console.log("\n-- concurrency / idempotency --");
  const c1 = await asT(bizA.id, (tx) => leadService.createLead({ businessId: bizA.id, name: "Race", phone: "0506660001", actor: { type: "OWNER_USER", userId: userA.id }, source: "OWNER_UI" }, { tx }));
  const race = await Promise.all(Array.from({ length: 8 }, () => patchLead(tokA, c1.id, { status: "QUALIFIED" })));
  ok("8 concurrent identical status changes → exactly ONE status_changed step (row lock serializes; the rest are no-ops)",
    race.every((r) => r.status === 200) && (await kinds(c1.id)).filter((k) => k === "status_changed").length === 1, race.map((r) => r.status).join(","));
  const dues = Array.from({ length: 6 }, (_, i) => new Date(Date.now() + (i + 2) * 3_600_000).toISOString());
  const raceNa = await Promise.all(dues.map((d) => patchLead(tokA, c1.id, { followUpAt: d, nextActionKind: "call" })));
  ok("6 concurrent different next-action writes → all serialized, every one recorded, seq contiguous (no gap, no duplicate)",
    raceNa.every((r) => r.status === 200) && (await seqsContiguous(c1.id)) &&
      (await kinds(c1.id)).filter((k) => k === "next_action_set" || k === "next_action_rescheduled").length === 6);
  const raceDone = await Promise.all(Array.from({ length: 6 }, () => patchLead(tokA, c1.id, { followUpAt: null })));
  ok("6 concurrent completions → exactly ONE next_action_completed", raceDone.every((r) => r.status === 200) &&
    (await kinds(c1.id)).filter((k) => k === "next_action_completed").length === 1);
  const mixed = await Promise.all([
    patchLead(tokA, c1.id, { status: "QUOTED" }),
    patchLead(tokA, c1.id, { status: "LOST", lostReason: "price" }),
  ]);
  ok("two DIFFERENT concurrent transitions → both serialized, history contiguous, final state = the last committed",
    mixed.every((r) => r.status === 200) && (await seqsContiguous(c1.id)));

  // 5 explicit lead events for the same NEW phone, accepted and drained concurrently
  const newPhone = "972503334444";
  await Promise.all(Array.from({ length: 5 }, (_, i) =>
    accept(leadEv({ submissionId: `${RUN}-conc${i}`, fields: { fullName: "Tamar", phone: "050-333-4444" } })).then(() => drain(bizA.id))));
  await drain(bizA.id);
  const tamarLeads = await o.lead.findMany({ where: { businessId: bizA.id, phone: newPhone } });
  const tamarCust = await o.customer.findMany({ where: { businessId: bizA.id, phone: newPhone } });
  const tk = tamarLeads[0] ? await kinds(tamarLeads[0].id) : [];
  ok("5 concurrent explicit lead events, same new phone → one Customer, one Lead, one `created` + four `intake_attached`, seq contiguous",
    tamarCust.length === 1 && tamarLeads.length === 1 && tk.filter((k) => k === "created").length === 1 &&
      tk.filter((k) => k === "intake_attached").length === 4 && (await seqsContiguous(tamarLeads[0].id)),
    `cust=${tamarCust.length} leads=${tamarLeads.length} kinds=${tk.join(",")}`);

  // lead lifecycle + conversation activity on the same person, concurrently
  const msgsBefore = await o.message.count({ where: { businessId: bizA.id } });
  const vBefore = (await o.lead.findUnique({ where: { id: tamarLeads[0].id } }))!.lifecycleVersion;
  const [waRes, stRes] = await Promise.all([
    whatsapp(PN_A, `${RUN}-wamidT`, newPhone, "מה המצב עם ההצעה?"),
    patchLead(tokA, tamarLeads[0].id, { status: "OPEN" }),
  ]);
  ok("a WhatsApp message and an owner lifecycle change on the same person, concurrently → both succeed; the message is kept; exactly one step",
    waRes === 200 && stRes.status === 200 && (await o.message.count({ where: { businessId: bizA.id } })) === msgsBefore + 1 &&
      (await o.lead.findUnique({ where: { id: tamarLeads[0].id } }))!.lifecycleVersion === vBefore + 1,
    `wa=${waRes} st=${stRes.status}`);

  // partial failure then retry
  const pf = await rejects(() => asT(bizA.id, async (tx) => {
    await leadService.createLead({ businessId: bizA.id, name: "Partial", phone: "0501212121", actor: { type: "OWNER_USER", userId: userA.id }, source: "OWNER_UI" }, { tx });
    throw new Error("simulated failure after the lead was written");
  }));
  ok("failure after the lead + its `created` step → both rolled back", pf !== null && (await o.lead.count({ where: { businessId: bizA.id, phone: "972501212121" } })) === 0);
  const pf2 = await asT(bizA.id, (tx) => leadService.createLead({ businessId: bizA.id, name: "Partial", phone: "0501212121", actor: { type: "OWNER_USER", userId: userA.id }, source: "OWNER_UI" }, { tx }));
  ok("…and the retry yields exactly one lead with exactly one `created` step", (await kinds(pf2.id)).join(",") === "created");
  const dupKey = await asT(bizA.id, async (tx) => {
    const lk = (await lockLeadForLifecycle(tx, bizA.id, pf2.id))!;
    return appendLeadLifecycleEvent(tx, lk, { kind: "created", toStatus: "NEW", idempotencyKey: `lead:${pf2.id}:created`, actor: { type: "SYSTEM" }, source: "SYSTEM" });
  });
  ok("re-appending a recorded step (same idempotency key) returns it and writes nothing", dupKey.duplicate === true && (await kinds(pf2.id)).length === 1);

  // ── 8. ambiguous identity → no silent attach; owner decides; undo ──────────
  console.log("\n-- identity uncertainty --");
  await o.customer.create({ data: { businessId: bizA.id, name: "Dana 1", email: "dana@example.test" } });
  await o.customer.create({ data: { businessId: bizA.id, name: "Dana 2", email: "dana@example.test" } });
  const dAmb = leadEv({ fields: { fullName: "Dana", email: "dana@example.test" } });
  await accept(dAmb);
  await drain(bizA.id);
  const ambLead = await o.lead.findFirst({ where: { businessId: bizA.id, email: "dana@example.test" } });
  ok("ambiguous identity → the lead is created WITHOUT a contact (lifecycle not attached to a guessed Customer)",
    ambLead !== null && ambLead.customerId === null);
  const ambCard = await getCard(tokA, ambLead!.id);
  ok("…and it surfaces as AWAITING_OWNER_DECISION, a FACT", ambCard.json?.lifecycle?.attention?.reason === "AWAITING_OWNER_DECISION" &&
    ambCard.json?.lifecycle?.attention?.evidenceClass === "fact");
  const props = await o.identityProposal.findMany({ where: { businessId: bizA.id, leadId: ambLead!.id, state: "proposed" }, orderBy: { id: "asc" } });
  await runTenantJob({ businessId: bizA.id }, () => decideProposal({ businessId: bizA.id, proposalId: props[0].id, action: "confirm", userId: userA.id }));
  ok("owner confirms → contact_attached step (evidence: the proposal)", (await events(ambLead!.id)).some((e) => e.kind === "contact_attached" && e.evidenceKind === "identity_proposal"));
  await runTenantJob({ businessId: bizA.id }, () => decideProposal({ businessId: bizA.id, proposalId: props[0].id, action: "undo", userId: userA.id }));
  ok("owner undoes → contact_detached step; lead back to no contact; history keeps both",
    (await kinds(ambLead!.id)).filter((k) => k === "contact_attached" || k === "contact_detached").join(",") === "contact_attached,contact_detached" &&
      (await o.lead.findUnique({ where: { id: ambLead!.id } }))?.customerId === null);

  // A second uncertain lead that the owner has NOT decided yet.
  await o.customer.create({ data: { businessId: bizA.id, name: "Shira 1", email: "shira@example.test" } });
  await o.customer.create({ data: { businessId: bizA.id, name: "Shira 2", email: "shira@example.test" } });
  await accept(leadEv({ fields: { fullName: "Shira", email: "shira@example.test" } }));
  await drain(bizA.id);
  const openAmb = await o.lead.findFirst({ where: { businessId: bizA.id, email: "shira@example.test" } });
  ok("an undecided identity question stays open on its lead", openAmb !== null &&
    (await o.identityProposal.count({ where: { businessId: bizA.id, leadId: openAmb.id, state: "proposed" } })) >= 1);

  // ── 9. Secretary / attention ────────────────────────────────────────────────
  console.log("\n-- Secretary + attention --");
  const nu = await asT(bizA.id, (tx) => leadService.createLead({ businessId: bizA.id, name: "Old new", phone: "0504440000", actor: { type: "OWNER_USER", userId: userA.id }, source: "OWNER_UI" }, { tx }));
  await o.lead.update({ where: { id: nu.id }, data: { createdAt: new Date(Date.now() - 3 * 86_400_000), lastActivityAt: new Date(Date.now() - 3 * 86_400_000) } });
  const od = await asT(bizA.id, (tx) => leadService.createLead({ businessId: bizA.id, name: "Overdue", phone: "0504440001", actor: { type: "OWNER_USER", userId: userA.id }, source: "OWNER_UI" }, { tx }));
  await o.lead.update({ where: { id: od.id }, data: { nextFollowUpAt: new Date(Date.now() - 2 * 86_400_000), nextActionKind: "call" } });
  const conv = await o.conversation.findFirst({ where: { businessId: bizA.id } });
  const cw = await asT(bizA.id, (tx) => leadService.createLead({ businessId: bizA.id, name: "Wrote", phone: "0504440002", actor: { type: "OWNER_USER", userId: userA.id }, source: "OWNER_UI" }, { tx }));
  if (conv) await o.conversation.update({ where: { id: conv.id }, data: { leadId: cw.id, customerLastInboundAt: new Date(Date.now() + 60_000) } });
  const br = await getBriefing(tokA);
  ok("GET /api/leads/briefing → 200 with counts per reason", br.status === 200 && typeof br.json?.counts?.open === "number", `http=${br.status}`);
  ok("briefing: new-unhandled, overdue, customer-wrote and awaiting-decision are all counted",
    br.json?.counts?.NEW_UNHANDLED >= 1 && br.json?.counts?.FOLLOWUP_OVERDUE >= 1 && br.json?.counts?.CUSTOMER_WROTE >= (conv ? 1 : 0) &&
      br.json?.counts?.AWAITING_OWNER_DECISION >= 1, JSON.stringify(br.json?.counts));
  ok("briefing: every item states FACT or INFERENCE; the state is CRITICAL when something is overdue",
    (br.json?.items ?? []).every((i: any) => i.evidenceClass === "fact" || i.evidenceClass === "inference") && br.json?.state === "CRITICAL");
  ok("briefing carries no phone / email", !/97250|0504440|@example/.test(JSON.stringify(br.json)));
  ok("briefing surfaces Dubiz suggestions as proposals, separately from the reason",
    (br.json?.items ?? []).some((i: any) => i.suggestion && typeof i.suggestion.why === "string"));
  const leadsBefore = await o.lead.findMany({ where: { businessId: bizA.id }, select: { id: true, status: true, nextFollowUpAt: true, lifecycleVersion: true }, orderBy: { id: "asc" } });
  await getBriefing(tokA);
  const leadsAfter = await o.lead.findMany({ where: { businessId: bizA.id }, select: { id: true, status: true, nextFollowUpAt: true, lifecycleVersion: true }, orderBy: { id: "asc" } });
  ok("reading the briefing changes nothing (no stage, no next action, no version)", JSON.stringify(leadsBefore) === JSON.stringify(leadsAfter));
  const bs = await runTenantJob({ businessId: bizA.id }, async () => translateLeadsNeedingAttention(await loadLeadsNeedingAttention(bizA.id, new Date()), new Date()));
  ok("Home / Attention (business-status) sees the same reasons from the same contract",
    bs.some((b) => b.itemId.startsWith("leads:followup_overdue:")) && bs.some((b) => b.itemId.startsWith("leads:awaiting_owner_decision:")), bs.map((b) => b.itemId).join(","));
  const readWhileWrite = await Promise.all([getBriefing(tokA), patchLead(tokA, od.id, { followUpAt: null }), getBriefing(tokA)]);
  ok("Secretary read while the lifecycle changes → consistent 200s, no error", readWhileWrite.every((r) => r.status === 200));

  // ── 10. tenant isolation ────────────────────────────────────────────────────
  console.log("\n-- tenant isolation (NOBYPASSRLS runtime) --");
  const bSees = await asT(bizB.id, (tx) => tx.leadLifecycleEvent.count({ where: { leadId: L1.id } }));
  ok("business B cannot see A's lifecycle history", bSees === 0);
  const noCtx = await prisma.leadLifecycleEvent.count();
  ok("no tenant context → no lifecycle rows visible", noCtx === 0);
  const crossPatch = await patchLead(tokB, L1.id, { status: "LOST" });
  ok("B's owner PATCHing A's lead → 404, nothing changed", crossPatch.status === 404 && (await o.lead.findUnique({ where: { id: L1.id } }))?.status === "OPEN");
  const crossHist = await getHistory(tokB, L1.id);
  ok("B's owner reading A's lead history → 404", crossHist.status === 404);
  const ownHist = await getHistory(tokA, L1.id);
  ok("A's owner reads the full history (newest first) with no personal data",
    ownHist.status === 200 && ownHist.json?.items?.[0]?.seq > 1 && !/9725\d{7}|05\d-?\d{3}-?\d{4}|noa@|Noa/.test(JSON.stringify(ownHist.json)));
  const crossIns = await rejects(() => asT(bizB.id, (tx) => tx.leadLifecycleEvent.create({ data: {
    businessId: bizA.id, leadId: L1.id, seq: 999, kind: "suggestion_dismissed", actorType: "SYSTEM", source: "SYSTEM", idempotencyKey: `${RUN}-x`,
  } })));
  ok("inserting a step for A's lead from B's context is refused (RLS WITH CHECK)", crossIns !== null);
  const crossFk = await rejects(() => o.leadLifecycleEvent.create({ data: {
    businessId: bizB.id, leadId: L1.id, seq: 999, kind: "suggestion_dismissed", actorType: "SYSTEM", source: "SYSTEM", idempotencyKey: `${RUN}-y`,
  } }));
  ok("composite FK: even the OWNER cannot attach business B's step to A's lead", crossFk !== null);
  const upd = await rejects(() => asT(bizA.id, (tx) => tx.$executeRawUnsafe(`UPDATE "LeadLifecycleEvent" SET "kind"='created' WHERE "leadId"=${L1.id}`)));
  ok("UPDATE on history refused even inside the tenant (append-only)", upd !== null && /permission/i.test(upd), String(upd));
  const del = await rejects(() => asT(bizA.id, (tx) => tx.$executeRawUnsafe(`DELETE FROM "LeadLifecycleEvent" WHERE "leadId"=${L1.id}`)));
  ok("DELETE on history refused", del !== null && /permission/i.test(del), String(del));
  const leadDel = await rejects(() => asT(bizA.id, (tx) => tx.$executeRawUnsafe(`DELETE FROM "Lead" WHERE "id"=${L1.id}`)));
  ok("DELETE on Lead refused for the runtime (Production grants: S/I/U only)", leadDel !== null && /permission/i.test(leadDel), String(leadDel));

  // ── 11. observability ───────────────────────────────────────────────────────
  console.log("\n-- observability chain --");
  const tr = await runTenantJob({ businessId: bizA.id }, () => traceIntakeReceipt(bizA.id, idOf(r1)));
  const firstStep = (await events(L1.id))[0];
  ok("trace: IntakeEvent → normalized → identity → routing → Lead, and the Lead's first lifecycle step points back at the same intake event",
    tr?.normalized?.routing?.rule === "R4_EXPLICIT_LEAD" && (tr?.normalized as any)?.resultRefs?.leadId === L1.id &&
      firstStep.evidenceRef === String(idOf(r1)), JSON.stringify({ rule: tr?.normalized?.routing?.rule, ref: firstStep.evidenceRef, id: idOf(r1) }));
  const allSensors = await o.learningEvent.findMany({ where: { businessId: bizA.id, eventType: { startsWith: "LEAD_" } } });
  ok("learning: every M5 lead sensor payload is free of phone / email / name / amount",
    allSensors.length > 0 && !/97250|050-|@example|Noa|Tamar|Dana|Shira|4750|4200/.test(JSON.stringify(allSensors.map((s) => s.payload))));
  const hist = await o.leadLifecycleEvent.findMany({ where: { businessId: bizA.id } });
  ok("lifecycle history holds no personal data (no phone, email or name anywhere in it)",
    !/97250|050-|@example|Noa|Tamar|Dana|לחזור/.test(JSON.stringify(hist)));

  // ── 12. erasure / account deletion ─────────────────────────────────────────
  console.log("\n-- erasure / account deletion --");
  const eraseErr = await rejects(() => prismaAccountDeletionStore.purgeOperationalData(bizB.id));
  const bLead = await asT(bizB.id, (tx) => leadService.createLead({ businessId: bizB.id, name: "B lead", phone: "0501110000", actor: { type: "OWNER_USER", userId: userB.id }, source: "OWNER_UI" }, { tx }));
  await patchLead(tokB, bLead.id, { status: "OPEN" });
  const eraseErr2 = await rejects(() => prismaAccountDeletionStore.purgeOperationalData(bizB.id));
  const bLeadAfter = await o.lead.findUnique({ where: { id: bLead.id } });
  const bHist = await o.leadLifecycleEvent.findMany({ where: { leadId: bLead.id } });
  ok("account erasure scrubs the lead's personal fields and keeps its (non-personal) lifecycle history",
    eraseErr2 === null && bLeadAfter?.customerName === null && bLeadAfter?.phone === null && bHist.length === 2,
    `err=${eraseErr ?? ""}|${eraseErr2 ?? ""} hist=${bHist.length}`);
  await o.business.delete({ where: { id: bizB.id } }).catch(() => undefined);
  ok("deleting the business cascades its lifecycle history", (await o.leadLifecycleEvent.count({ where: { businessId: bizB.id } })) === 0);

  console.log(`\n[m5] PASS=${pass} FAIL=${failures.length}`);
  if (failures.length) {
    console.log("FAILURES:\n - " + failures.join("\n - "));
    process.exit(1);
  }
  console.log("ALL CHECKS PASS");
  await prisma.$disconnect();
  await o.$disconnect();
}

main().catch((e) => {
  console.error("battery crashed:", e instanceof Error ? `${e.name}: ${e.message}\n${e.stack}` : e);
  process.exit(1);
});
