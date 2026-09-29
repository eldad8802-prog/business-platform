/**
 * Business Intake M4 — identity resolution + routing battery (ephemeral PG17).
 *
 * The lab database is the PRE-M4 schema (the PR base, via `db push`) + sec-C's
 * composite FKs + M2/M3 isolation from their real migrations; the REAL M4
 * migration is applied with psql before this runs. Everything below runs as a
 * NOSUPERUSER / NOBYPASSRLS runtime ("app_runtime", so the migration's own
 * GRANT/REVOKE block applies to it), calling the real WhatsApp webhook handler,
 * the real canonical processor and the real owner-decision route.
 *
 * Synthetic data only. No secrets, no Neon, no network.
 *
 * env: DATABASE_URL (runtime), RLS_ADMIN_URL (owner), AUTH_TOKEN_SECRET,
 *      WHATSAPP_APP_SECRET, AUTH_DATABASE_URL (= runtime)
 */
import { createHmac } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { signAuthToken } from "../lib/auth-token";
import { runTenantJob } from "../lib/tenant/job";
import { getTenantContext } from "../lib/tenant/context";
import { IntakeRegistry } from "../lib/intake/core/registry";
import { acceptIntake, drainIntake } from "../lib/intake/core/processor";
import { traceIntakeReceipt } from "../lib/intake/core/trace";
import { decideProposal } from "../lib/intake/identity/proposals";
import { identifierHash } from "../lib/intake/identity/identifiers";
import { POST as webhookPOST } from "../app/api/integrations/whatsapp/webhook/route";
import { POST as decisionPOST } from "../app/api/intake/identity-proposals/[id]/route";
import { intakeRegistry } from "../lib/intake/sources";
import { whatsAppIntakeAdapter } from "../lib/intake/whatsapp/whatsapp-intake";
import {
  buildReferenceReceipt,
  createLeadSink,
  createReferenceAdapter,
  type ReferenceDelivery,
} from "../.m3/reference-lead-adapter";

const RUN = process.env.M4_RUN_TAG ?? `m4-${Date.now()}`;
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

function sign(body: string) {
  return "sha256=" + createHmac("sha256", process.env.WHATSAPP_APP_SECRET!).update(body, "utf8").digest("hex");
}
async function whatsapp(pn: string, wamid: string, from: string, text: string): Promise<number> {
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ id: "w", changes: [{ field: "messages", value: {
      metadata: { phone_number_id: pn },
      contacts: [{ wa_id: from, profile: { name: "Eldad" } }],
      messages: [{ id: wamid, from, type: "text", timestamp: String(Math.floor(Date.now() / 1000)), text: { body: text } }],
    } }] }],
  });
  const res = await webhookPOST(new NextRequest("http://m4.local/api/integrations/whatsapp/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) },
    body,
  }));
  return res.status;
}

async function main() {
  const [who] = (await prisma.$queryRawUnsafe(
    `SELECT current_user::text AS who, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
  )) as Array<{ who: string; rolsuper: boolean; rolbypassrls: boolean }>;
  console.log(`  runtime: ${who.who} (superuser=${who.rolsuper}, bypassrls=${who.rolbypassrls})`);
  if (who.rolsuper || who.rolbypassrls) throw new Error("runtime bypasses RLS — nothing would be proven");
  ok("no ambient tenant context", getTenantContext() === undefined);

  // ── 1. migration mechanics ──────────────────────────────────────────────────
  console.log("\n-- migration mechanics / grants / RLS --");
  for (const t of ["IdentityLink", "IdentityProposal"]) {
    const [p] = (await o.$queryRawUnsafe(
      `SELECT has_table_privilege('${who.who}','"${t}"','SELECT') s, has_table_privilege('${who.who}','"${t}"','INSERT') i,
              has_table_privilege('${who.who}','"${t}"','UPDATE') u, has_table_privilege('${who.who}','"${t}"','DELETE') d,
              has_table_privilege('${who.who}','"${t}"','TRUNCATE') tr`
    )) as Array<Record<string, boolean>>;
    ok(`${t}: exact grants SELECT/INSERT/UPDATE, no DELETE/TRUNCATE`, p.s && p.i && p.u && !p.d && !p.tr, JSON.stringify(p));
    const [r] = (await o.$queryRawUnsafe(`SELECT relrowsecurity r, relforcerowsecurity f FROM pg_class WHERE relname='${t}'`)) as Array<{ r: boolean; f: boolean }>;
    ok(`${t}: ENABLE + FORCE RLS`, r.r && r.f);
    const pols = (await o.$queryRawUnsafe(`SELECT cmd FROM pg_policies WHERE tablename='${t}' ORDER BY cmd`)) as Array<{ cmd: string }>;
    ok(`${t}: per-command SELECT/INSERT/UPDATE policies only`, JSON.stringify(pols.map((x) => x.cmd)) === '["INSERT","SELECT","UPDATE"]', JSON.stringify(pols));
  }
  const fks = (await o.$queryRawUnsafe(
    `SELECT conname FROM pg_constraint WHERE conname IN ('IdentityLink_customerId_tenant_fkey','IdentityProposal_candidateCustomerId_tenant_fkey','IdentityProposal_leadId_tenant_fkey','IdentityProposal_businessId_intakeEventId_fkey') AND convalidated ORDER BY 1`
  )) as Array<{ conname: string }>;
  ok("composite tenant FKs present and VALID (link→Customer, proposal→Customer/Lead/IntakeEvent)", fks.length === 4, JSON.stringify(fks));
  const [pidx] = (await o.$queryRawUnsafe(
    `SELECT indexdef FROM pg_indexes WHERE indexname='IdentityLink_active_identifier_key'`
  )) as Array<{ indexdef: string }>;
  ok("one ACTIVE owner per identifier (partial unique index)", /UNIQUE/.test(pidx?.indexdef ?? "") && /status.*active/.test(pidx?.indexdef ?? ""));

  // ── fixtures ────────────────────────────────────────────────────────────────
  const bizA = await o.business.create({ data: { name: `${RUN}-A` } });
  const bizB = await o.business.create({ data: { name: `${RUN}-B` } });
  const userA = await o.user.create({ data: { email: `${RUN}-a@m4.test`, password: "x", businessId: bizA.id, role: "USER" } });
  const PN_A = `${RUN}-pnA`;
  const PN_B = `${RUN}-pnB`;
  const conn = (businessId: number, phoneNumberId: string) => ({
    businessId, phoneNumberId, displayPhoneNumber: phoneNumberId, wabaId: `${RUN}-waba`,
    accessTokenEncrypted: "x", accessTokenIv: "x", accessTokenTag: "x", status: "CONNECTED" as const,
  });
  await o.whatsAppConnection.create({ data: conn(bizA.id, PN_A) });
  await o.whatsAppConnection.create({ data: conn(bizB.id, PN_B) });
  const FORM_A = `${RUN}-formA`;
  const FORM_B = `${RUN}-formB`;
  const connections = new Map([[FORM_A, bizA.id], [FORM_B, bizB.id]]);
  const adapter = createReferenceAdapter({ connections, sink: createLeadSink(), coreDestinations: ["lead"] });
  const buggyShop = createReferenceAdapter({ sourceKey: "reference.shop_buggy", connections, sink: createLeadSink(), orderTarget: "lead" });
  const shop = createReferenceAdapter({ sourceKey: "reference.shop", connections, sink: createLeadSink(), orderTarget: "commerce" });
  const registry = new IntakeRegistry().register(adapter).register(buggyShop).register(shop).register(whatsAppIntakeAdapter);
  let seq = 0;
  const lead = (over: Partial<ReferenceDelivery> = {}): ReferenceDelivery => ({
    kind: "lead", formId: FORM_A, submissionId: `${RUN}-s${++seq}`, submittedAt: new Date().toISOString(),
    fields: { fullName: "Eldad", phone: "050-123-4567", email: "eldad@example.test" }, tracking: { campaignId: "c1" }, ...over,
  });
  const accept = (d: ReferenceDelivery, sourceKey = "reference.lead_form") =>
    acceptIntake({ registry, sourceKey, accountRef: d.formId, receipts: [buildReferenceReceipt(d)] });
  const drain = (businessId: number) => runTenantJob({ businessId }, () => drainIntake(registry, businessId, { limit: 200 }));
  const normOf = async (receiptId: number) => o.intakeNormalizedEvent.findUnique({ where: { intakeEventId: receiptId } });
  const evOf = async (receiptId: number) => o.intakeEvent.findUnique({ where: { id: receiptId } });
  const idOf = (r: Awaited<ReturnType<typeof accept>>) => (r.status === "accepted" ? r.recorded[0].id : -1);
  const customersWithPhone = (b: number, phone: string) => o.customer.count({ where: { businessId: b, phone } });
  const P1 = "972501234567";

  // ── 2. cross-channel identity ───────────────────────────────────────────────
  console.log("\n-- cross-channel: WhatsApp + lead form + second form --");
  ok("WhatsApp message +972501234567 → 200", (await whatsapp(PN_A, `wamid.${RUN}.1`, P1, "שלום")) === 200);
  await runTenantJob({ businessId: bizA.id }, () => drainIntake(intakeRegistry, bizA.id, { limit: 50 }));
  const X = await o.customer.findFirst({ where: { businessId: bizA.id, phone: P1 } });
  ok("WhatsApp created exactly one Customer for the phone (M2 path preserved)", X !== null && (await customersWithPhone(bizA.id, P1)) === 1);
  const waEv = await o.intakeEvent.findFirst({ where: { businessId: bizA.id, sourceKey: "whatsapp" }, orderBy: { id: "desc" } });
  const waNorm = waEv ? await normOf(waEv.id) : null;
  ok("WhatsApp event: identity resolved (created by the M2 destination), rule R1_MESSAGE → conversation",
    waNorm?.identityState === "resolved" && waNorm.identityCustomerId === X?.id && waNorm.routingRule === "R1_MESSAGE" &&
      waNorm.routingDestination === "conversation", JSON.stringify({ s: waNorm?.identityState, r: waNorm?.routingRule }));
  ok("a WhatsApp message did NOT create a Lead", (await o.lead.count({ where: { businessId: bizA.id } })) === 0);

  const f1 = await accept(lead());
  await drain(bizA.id);
  const f1n = await normOf(idOf(f1));
  const l1 = await o.lead.findFirst({ where: { businessId: bizA.id }, orderBy: { id: "desc" } });
  ok("lead form 050-123-4567 + email → RESOLVED to the WhatsApp Customer by phone (no new Customer)",
    f1n?.identityState === "resolved" && f1n.identityCustomerId === X?.id && (await o.customer.count({ where: { businessId: bizA.id } })) === 1,
    JSON.stringify({ s: f1n?.identityState, c: f1n?.identityCustomerId }));
  ok("…routed by R4_EXPLICIT_LEAD to a Lead attached to that Customer", f1n?.routingRule === "R4_EXPLICIT_LEAD" && l1?.customerId === X?.id);
  const emailHash = identifierHash({ kind: "email", scope: "", value: "eldad@example.test" });
  const link1 = await o.identityLink.findFirst({ where: { businessId: bizA.id, valueHash: emailHash } });
  ok("…and the email became a deterministic link to that Customer (hashed, provenance = the event)",
    link1 !== null && link1.customerId === X?.id && link1.method === "deterministic" && link1.sourceIntakeEventId === idOf(f1) && !JSON.stringify(link1).includes("eldad@"));
  const f2 = await accept(lead({ fields: { fullName: "Eldad", email: "ELDAD@example.test " } }));
  await drain(bizA.id);
  const f2n = await normOf(idOf(f2));
  ok("second form, email only → RESOLVED to the same Customer via the email link",
    f2n?.identityState === "resolved" && f2n.identityCustomerId === X?.id && (f2n.identityEvidence as { strongBases?: string[] })?.strongBases?.includes("email_link") === true);
  ok("no duplicate Customer across three channels/events", (await o.customer.count({ where: { businessId: bizA.id } })) === 1);

  // ── 3. unresolved → deterministic creation ─────────────────────────────────
  console.log("\n-- unresolved / creation / replay --");
  const newP = "972507777777";
  const u = await accept(lead({ fields: { fullName: "New Person", phone: "0507777777", email: "new.person@example.test" } }));
  await drain(bizA.id);
  const un = await normOf(idOf(u));
  const C = await o.customer.findFirst({ where: { businessId: bizA.id, phone: newP } });
  ok("UNRESOLVED explicit lead → one new Customer (phone + email) and a Lead for it",
    un?.identityState === "unresolved" && C !== null && (un?.resultRefs as { customerId?: number })?.customerId === C?.id,
    JSON.stringify({ s: un?.identityState }));
  // replay 8x + drains
  const replay = lead({ fields: { fullName: "Replay", phone: "0508888888" } });
  for (let i = 0; i < 8; i++) await accept({ ...replay });
  for (let i = 0; i < 3; i++) await drain(bizA.id);
  ok("same explicit lead event delivered 8 times → ONE Lead, ONE Customer",
    (await o.lead.count({ where: { businessId: bizA.id, phone: "972508888888" } })) === 1 && (await customersWithPhone(bizA.id, "972508888888")) === 1);

  // ── 4. retry after partial failure (the Customer create rolls back with the lead) ──
  const pf = lead({ fields: { fullName: "Partial", phone: "0509999999" } });
  await o.$executeRawUnsafe(`REVOKE INSERT ON "Lead" FROM ${who.who}`);
  const pfr = await accept(pf);
  await drain(bizA.id);
  const pfe1 = await evOf(idOf(pfr));
  await o.$executeRawUnsafe(`GRANT INSERT ON "Lead" TO ${who.who}`);
  ok("routing failure (Lead insert refused) → FAILED, and the Customer created in that transaction rolled back",
    pfe1?.status === "FAILED" && (await customersWithPhone(bizA.id, "972509999999")) === 0, JSON.stringify({ s: pfe1?.status }));
  await runTenantJob({ businessId: bizA.id }, () => drainIntake(registry, bizA.id, { limit: 200, now: new Date(Date.now() + 3_600_000) }));
  ok("retry → PROCESSED with exactly one Customer and one Lead",
    (await evOf(idOf(pfr)))?.status === "PROCESSED" && (await customersWithPhone(bizA.id, "972509999999")) === 1 &&
      (await o.lead.count({ where: { businessId: bizA.id, phone: "972509999999" } })) === 1);

  // ── 5. candidate → proposal → confirm → undo ──────────────────────────────
  console.log("\n-- candidate / confirm / undo --");
  const Y = await o.customer.create({ data: { businessId: bizA.id, name: "Yael", email: "Yael@Shop.test " } });
  const cand = await accept(lead({ fields: { fullName: "Y?", email: "yael@shop.test" } }));
  await drain(bizA.id);
  const cn = await normOf(idOf(cand));
  const candLead = await o.lead.findFirst({ where: { businessId: bizA.id }, orderBy: { id: "desc" } });
  const props = await o.identityProposal.findMany({ where: { businessId: bizA.id, intakeEventId: idOf(cand) } });
  ok("weak email (Customer.email, never verified) → CANDIDATE, not a merge",
    cn?.identityState === "candidate" && cn.ownerReviewRequired === true && cn.identityCustomerId === null);
  ok("…Lead created WITHOUT a contact and ONE proposal naming Yael", candLead?.customerId === null && props.length === 1 && props[0].candidateCustomerId === Y.id);
  ok("…proposal holds hashes and categories only (no identifier value)", !JSON.stringify(props[0]).includes("yael@"));
  await drain(bizA.id);
  ok("regenerating (re-drain) never duplicates a proposal", (await o.identityProposal.count({ where: { intakeEventId: idOf(cand) } })) === 1);
  // owner confirms through the REAL route
  const token = signAuthToken(userA.id);
  const res = await decisionPOST(new Request(`http://m4.local/api/intake/identity-proposals/${props[0].id}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ action: "confirm", expectedFingerprint: props[0].evidenceFingerprint }),
  }), { params: Promise.resolve({ id: String(props[0].id) }) });
  const pAfter = await o.identityProposal.findUnique({ where: { id: props[0].id } });
  const leadAfter = await o.lead.findUnique({ where: { id: candLead!.id } });
  const yLink = await o.identityLink.findFirst({ where: { businessId: bizA.id, proposalId: props[0].id, status: "active" } });
  ok("owner CONFIRM (real route) → 200; owner_confirmed link to Yael; the Lead attached to Yael",
    res.status === 200 && pAfter?.state === "confirmed" && yLink?.customerId === Y.id && yLink.method === "owner_confirmed" && leadAfter?.customerId === Y.id,
    JSON.stringify({ http: res.status, st: pAfter?.state }));
  const msgBefore = await o.message.count({ where: { businessId: bizA.id } });
  const undo = await runTenantJob({ businessId: bizA.id }, () => decideProposal({ businessId: bizA.id, proposalId: props[0].id, action: "undo", userId: userA.id }));
  const leadUndone = await o.lead.findUnique({ where: { id: candLead!.id } });
  const linkUndone = await o.identityLink.findFirst({ where: { id: yLink!.id } });
  ok("owner UNDO → link REVOKED (kept as history), Lead back to contact-less",
    undo.status === "undone" && linkUndone?.status === "revoked" && linkUndone.revokeReason === "owner_undo" && leadUndone?.customerId === null);
  ok("…undo touched no message and no per-event evidence",
    (await o.message.count({ where: { businessId: bizA.id } })) === msgBefore && (await normOf(idOf(cand)))?.identityState === "candidate");
  ok("a decision on an undone proposal is refused (invalid_state)",
    (await runTenantJob({ businessId: bizA.id }, () => decideProposal({ businessId: bizA.id, proposalId: props[0].id, action: "confirm", userId: userA.id }))).status === "invalid_state");

  // ── 6. ambiguous / reject / supersede ──────────────────────────────────────
  console.log("\n-- ambiguous / conflict / stale / reject --");
  const A1 = await o.customer.create({ data: { businessId: bizA.id, name: "Twin 1", email: "twin@family.test" } });
  const A2 = await o.customer.create({ data: { businessId: bizA.id, name: "Twin 2", email: "twin@family.test" } });
  const amb = await accept(lead({ fields: { fullName: "?", email: "twin@family.test" } }));
  await drain(bizA.id);
  const ambP = await o.identityProposal.findMany({ where: { intakeEventId: idOf(amb) }, orderBy: { candidateCustomerId: "asc" } });
  ok("two Customers share the weak email → AMBIGUOUS, one proposal each, nothing linked",
    (await normOf(idOf(amb)))?.identityState === "ambiguous" && ambP.length === 2 &&
      ambP.map((p) => p.candidateCustomerId).join() === [A1.id, A2.id].join() &&
      (await o.identityLink.count({ where: { businessId: bizA.id, customerId: { in: [A1.id, A2.id] } } })) === 0);
  await runTenantJob({ businessId: bizA.id }, () => decideProposal({ businessId: bizA.id, proposalId: ambP[1].id, action: "reject", userId: userA.id }));
  const conf = await runTenantJob({ businessId: bizA.id }, () => decideProposal({ businessId: bizA.id, proposalId: ambP[0].id, action: "confirm", userId: userA.id }));
  const ambAfter = await o.identityProposal.findMany({ where: { intakeEventId: idOf(amb) }, orderBy: { candidateCustomerId: "asc" } });
  ok("reject one, confirm the other → rejected stays rejected, confirmed applied",
    conf.status === "confirmed" && ambAfter[0].state === "confirmed" && ambAfter[1].state === "rejected");

  // conflict: strong phone says X, email link says someone else
  const Z = await o.customer.create({ data: { businessId: bizA.id, name: "Zohar", phone: "972502222222" } });
  await accept(lead({ fields: { fullName: "Zohar", phone: "0502222222", email: "zohar@z.test" } }));
  await drain(bizA.id); // zohar@z.test → deterministic link to Z
  const confl = await accept(lead({ fields: { fullName: "??", phone: "050-123-4567", email: "zohar@z.test" } }));
  await drain(bizA.id);
  const cfn = await normOf(idOf(confl));
  const cfP = await o.identityProposal.findMany({ where: { intakeEventId: idOf(confl) } });
  ok("same phone (Customer X) + an email proven for Zohar → CONFLICT, never a guess",
    cfn?.identityState === "conflict" && cfP.length === 2 && cfn.identityCustomerId === null &&
      (cfn.identityEvidence as { conflict?: boolean })?.conflict === true, JSON.stringify({ s: cfn?.identityState, n: cfP.length }));
  const cfLead = await o.lead.findFirst({ where: { businessId: bizA.id, phone: P1 }, orderBy: { id: "desc" } });
  ok("…the conflicting event attached to X's already-open lead (one open lead per phone) — no new contact", cfLead?.customerId === X?.id);

  // provider identity scoped: a provider link for W; same phone as X + that provider id → conflict
  const W = await o.customer.create({ data: { businessId: bizA.id, name: "Wendy", phone: "972503333333" } });
  await accept(lead({ fields: { fullName: "Wendy", phone: "0503333333", providerUserId: "prov-42" } }));
  await drain(bizA.id);
  const pv = await accept(lead({ fields: { fullName: "?", phone: "050-123-4567", providerUserId: "prov-42" } }));
  await drain(bizA.id);
  ok("same phone + a CONFLICTING provider identity → CONFLICT", (await normOf(idOf(pv)))?.identityState === "conflict");
  const pvLink = await o.identityLink.findFirst({ where: { businessId: bizA.id, kind: "provider", customerId: W.id } });
  ok("provider identity is stored SCOPED to its source + account", pvLink?.scope === `reference.lead_form:${FORM_A}`);

  // confirming one side of a conflict never MOVES the other side's identifier
  const zProp = cfP.find((p) => p.candidateCustomerId === Z.id)!;
  ok("a conflict proposal offers no already-held identifier (X's phone, Zohar's email are evidence)",
    Array.isArray(zProp.proposedLinks) && (zProp.proposedLinks as unknown[]).length === 0, JSON.stringify(zProp.proposedLinks));
  await runTenantJob({ businessId: bizA.id }, () => decideProposal({ businessId: bizA.id, proposalId: zProp.id, action: "confirm", userId: userA.id }));
  ok("…confirming Zohar for that event leaves X's phone with X (no phone link to Zohar)",
    (await o.identityLink.count({ where: { businessId: bizA.id, customerId: Z.id, kind: "phone" } })) === 0 &&
      (await o.customer.findUnique({ where: { id: X!.id } }))?.phone === P1);

  // STALE: a candidate proposal for Yoni; before the owner answers it, another
  // event's conflict is confirmed for Vered — proving the email is Vered's.
  const Y2 = await o.customer.create({ data: { businessId: bizA.id, name: "Yoni", email: "yoni@x.test" } });
  const st = await accept(lead({ fields: { fullName: "?", email: "yoni@x.test" } }));
  await drain(bizA.id);
  const stP = await o.identityProposal.findFirst({ where: { intakeEventId: idOf(st) } });
  const V = await o.customer.create({ data: { businessId: bizA.id, name: "Vered", phone: "972504444444" } });
  const ve = await accept(lead({ fields: { fullName: "Vered", phone: "0504444444", email: "yoni@x.test" } }));
  await drain(bizA.id);
  const veP = await o.identityProposal.findFirst({ where: { intakeEventId: idOf(ve), candidateCustomerId: V.id } });
  ok("strong phone (Vered) + a weak email naming Yoni → CONFLICT, the email is offered to Vered",
    (await normOf(idOf(ve)))?.identityState === "conflict" && (veP?.proposedLinks as unknown[] | null)?.length === 1);
  await runTenantJob({ businessId: bizA.id }, () => decideProposal({ businessId: bizA.id, proposalId: veP!.id, action: "confirm", userId: userA.id }));
  const stale = await runTenantJob({ businessId: bizA.id }, () => decideProposal({ businessId: bizA.id, proposalId: stP!.id, action: "confirm", userId: userA.id }));
  ok("STALE: the email was proven for another Customer before the owner decided → not applied",
    stale.status === "stale" && (await o.identityProposal.findUnique({ where: { id: stP!.id } }))?.state === "stale" &&
      (await o.identityLink.count({ where: { businessId: bizA.id, customerId: Y2.id } })) === 0, JSON.stringify(stale));
  const fpP = await o.identityProposal.findFirst({ where: { intakeEventId: idOf(ve), candidateCustomerId: Y2.id } });
  const fp = await runTenantJob({ businessId: bizA.id }, () =>
    decideProposal({ businessId: bizA.id, proposalId: fpP!.id, action: "reject", userId: userA.id }));
  ok("a sibling of a confirmed proposal is SUPERSEDED, and no longer decidable", fp.status === "invalid_state");
  const fresh = await accept(lead({ fields: { fullName: "?", email: "fresh@x.test" } }));
  await o.customer.create({ data: { businessId: bizA.id, name: "Fresh", email: "fresh@x.test" } });
  await drain(bizA.id);
  const frP = await o.identityProposal.findFirst({ where: { intakeEventId: idOf(fresh) } });
  const wrongFp = await runTenantJob({ businessId: bizA.id }, () =>
    decideProposal({ businessId: bizA.id, proposalId: frP!.id, action: "confirm", userId: userA.id, expectedFingerprint: "sha256:" + "0".repeat(64) }));
  ok("STALE: the owner confirmed evidence different from what is stored (fingerprint mismatch) → not applied", wrongFp.status === "stale");

  // ── 7. frozen rules: order ≠ lead ─────────────────────────────────────────
  console.log("\n-- frozen routing rules --");
  const leadsBefore = await o.lead.count({ where: { businessId: bizA.id } });
  const bug = await accept(lead({ kind: "order", submissionId: `${RUN}-order-bug` }), "reference.shop_buggy");
  const okOrder = await accept(lead({ kind: "order", submissionId: `${RUN}-order-ok` }), "reference.shop");
  await drain(bizA.id);
  const bugEv = await evOf(idOf(bug));
  const okEv = await evOf(idOf(okOrder));
  ok("an order an adapter mis-targets to 'lead' → dead-letter R0 (Order ≠ Lead), no Lead",
    bugEv?.status === "FAILED" && bugEv.nextAttemptAt === null && bugEv.lastErrorCode === "routing:forbidden:R0_FORBIDDEN_LEAD");
  ok("a correct order → commerce, no handler yet → dead-letter, payload KEPT for replay",
    okEv?.status === "FAILED" && okEv.lastErrorCode === "routing:destination_unavailable:commerce" && okEv.payload !== null);
  ok("…neither order created a Lead", (await o.lead.count({ where: { businessId: bizA.id } })) === leadsBefore);

  // ── 8. malformed / missing hints ───────────────────────────────────────────
  const mal = await accept(lead({ fields: { fullName: "Bad", phone: "12", email: "not-an-email" } }));
  const none = await accept(lead({ fields: { fullName: "Nameless" } }));
  const custBefore = await o.customer.count({ where: { businessId: bizA.id } });
  await drain(bizA.id);
  ok("malformed phone + email → no identifiers → NOT_APPLICABLE, contact-less Lead, no Customer created",
    (await normOf(idOf(mal)))?.identityState === "not_applicable" && (await normOf(idOf(none)))?.identityState === "not_applicable" &&
      (await o.customer.count({ where: { businessId: bizA.id } })) === custBefore);

  // ── 9. concurrency ─────────────────────────────────────────────────────────
  console.log("\n-- concurrency --");
  const PC = "972505555555";
  const concLead = lead({ fields: { fullName: "Conc", phone: "0505555555", email: "conc@x.test" } });
  await Promise.all([
    whatsapp(PN_A, `wamid.${RUN}.conc`, PC, "hi").then(() =>
      runTenantJob({ businessId: bizA.id }, () => drainIntake(intakeRegistry, bizA.id, { limit: 50 }))),
    accept(concLead).then(() => drain(bizA.id)),
  ]);
  await drain(bizA.id);
  ok("WhatsApp + explicit lead with the same NEW phone, concurrently → exactly ONE Customer",
    (await customersWithPhone(bizA.id, PC)) === 1);
  const PB = "972506666666";
  await Promise.all(Array.from({ length: 5 }, (_, i) =>
    accept(lead({ fields: { fullName: `Burst ${i}`, phone: "0506666666", email: "burst@x.test" } })).then(() => drain(bizA.id))));
  await drain(bizA.id);
  ok("5 concurrent lead events, same new phone + email → one Customer, one open Lead, one email link",
    (await customersWithPhone(bizA.id, PB)) === 1 && (await o.lead.count({ where: { businessId: bizA.id, phone: PB } })) === 1 &&
      (await o.identityLink.count({ where: { businessId: bizA.id, valueHash: identifierHash({ kind: "email", scope: "", value: "burst@x.test" }), status: "active" } })) === 1);
  await Promise.all([
    accept(lead({ fields: { fullName: "C1", phone: "0501010101", email: "shared.race@x.test" } })).then(() => drain(bizA.id)),
    accept(lead({ fields: { fullName: "C2", phone: "0502020202", email: "shared.race@x.test" } })).then(() => drain(bizA.id)),
  ]);
  await drain(bizA.id);
  const raceLinks = await o.identityLink.findMany({ where: { businessId: bizA.id, valueHash: identifierHash({ kind: "email", scope: "", value: "shared.race@x.test" }), status: "active" } });
  const racePhone2Links = await o.identityLink.count({ where: { businessId: bizA.id, kind: "phone", method: "deterministic" } });
  ok("concurrent events sharing an email, different new phones → the email has ONE active owner; no phone chained onto it",
    raceLinks.length === 1 && racePhone2Links === 0, JSON.stringify({ links: raceLinks.length, phoneLinks: racePhone2Links }));

  // ── 10. cross-tenant ───────────────────────────────────────────────────────
  console.log("\n-- tenant isolation --");
  const bx = await accept(lead({ formId: FORM_B, fields: { fullName: "B person", phone: "050-123-4567", email: "eldad@example.test", providerUserId: "prov-42" } }));
  await drain(bizB.id);
  const bxn = await normOf(idOf(bx));
  const bCust = await o.customer.findFirst({ where: { businessId: bizB.id, phone: P1 } });
  ok("same phone + email + provider id in Business B → B's OWN new Customer (unresolved), unrelated to A",
    bxn?.identityState === "unresolved" && bCust !== null && bCust.id !== X?.id && (await o.identityLink.count({ where: { businessId: bizB.id, customerId: X!.id } })) === 0);
  const asA = <T>(fn: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<T>) =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '${bizA.id}', true)`);
      return fn(tx);
    });
  const readB = await asA(async (tx) => ({
    l: await tx.identityLink.count({ where: { businessId: bizB.id } }),
    p: await tx.identityProposal.count({ where: { businessId: bizB.id } }),
  }));
  ok("A cannot READ B's links or proposals", readB.l === 0 && readB.p === 0);
  const updB = await asA(async (tx) => (await tx.identityLink.updateMany({ where: { businessId: bizB.id }, data: { status: "revoked", revokedAt: new Date(), revokeReason: "superseded" } })).count);
  ok("A cannot UPDATE B's links", updB === 0);
  const insB = await rejects(() => asA((tx) => tx.identityLink.create({ data: { businessId: bizB.id, customerId: bCust!.id, kind: "email", valueHash: emailHash, method: "deterministic" } })));
  ok("A cannot INSERT a link for B", insB !== null);
  ok("no tenant context → no identity data visible", (await prisma.identityLink.count()) === 0 && (await prisma.identityProposal.count()) === 0);
  const del = await rejects(() => asA((tx) => tx.$executeRawUnsafe(`DELETE FROM "IdentityLink" WHERE "businessId" = ${bizA.id}`)));
  ok("DELETE on identity links refused (no privilege — reversal is revocation)", del !== null && /permission/i.test(del ?? ""), String(del));
  const crossFk = await rejects(() => o.identityLink.create({ data: { businessId: bizA.id, customerId: bCust!.id, kind: "email", valueHash: identifierHash({ kind: "email", scope: "", value: "x@y.test" }), method: "deterministic" } }));
  ok("composite FK: even the OWNER cannot link business A's identifier to B's Customer", crossFk !== null);

  // ── 11. deleted Customer / erased evidence ─────────────────────────────────
  console.log("\n-- deletion / erasure --");
  const D = await o.customer.create({ data: { businessId: bizA.id, name: "Doomed", phone: "972507070707" } });
  await accept(lead({ fields: { fullName: "Doomed", phone: "0507070707", email: "doomed@x.test" } }));
  await drain(bizA.id);
  await o.lead.updateMany({ where: { customerId: D.id }, data: { customerId: null } });
  await o.customer.delete({ where: { id: D.id } });
  ok("a deleted Customer takes its identity links with it (cascade)", (await o.identityLink.count({ where: { customerId: D.id } })) === 0);
  const afterDel = await accept(lead({ fields: { fullName: "?", email: "doomed@x.test" } }));
  await drain(bizA.id);
  ok("…so its old email no longer resolves to anyone (unresolved, fresh Customer)", (await normOf(idOf(afterDel)))?.identityState === "unresolved");
  await o.identityLink.updateMany({ where: { businessId: bizA.id, valueHash: emailHash }, data: { valueHash: null } });
  const afterErase = await accept(lead({ fields: { fullName: "?", email: "eldad@example.test" } }));
  await drain(bizA.id);
  ok("erased identity evidence (hash nulled) can never match again", (await normOf(idOf(afterErase)))?.identityState !== "resolved" ||
    (await normOf(idOf(afterErase)))?.identityCustomerId !== X?.id);

  // ── 12. trace + learning signals ───────────────────────────────────────────
  console.log("\n-- observability / learning --");
  const tr = await runTenantJob({ businessId: bizA.id }, () => traceIntakeReceipt(bizA.id, idOf(confl)));
  ok("trace: identity state, evidence categories, candidate count, rule, destination, proposals — for one receipt",
    tr?.normalized?.identity.state === "conflict" && tr.normalized.routing.rule === "R4_EXPLICIT_LEAD" &&
      tr.normalized.routing.ownerReviewRequired === true && tr.proposals.length === 2);
  ok("contact hints purged once the core decided identity and materialised the lead",
    (await normOf(idOf(f1)))?.contactHints === null && (await normOf(idOf(cand)))?.contactHints === null);
  ok("trace carries no identifier value or content", !/972501234567|zohar@|eldad@/.test(JSON.stringify(tr)));
  const sig = await o.learningEvent.findMany({ where: { businessId: bizA.id, eventType: { in: ["INTAKE_IDENTITY_RESOLVED", "IDENTITY_PROPOSAL_DECIDED"] } } });
  ok("learning signals written (identity resolved + proposal decisions), with no PII",
    sig.some((s) => s.eventType === "INTAKE_IDENTITY_RESOLVED") && sig.some((s) => s.eventType === "IDENTITY_PROPOSAL_DECIDED") &&
      !/972|@example|@x\.test|Eldad|Yael/.test(JSON.stringify(sig.map((s) => s.payload))));

  console.log(`\n[m4] PASS=${pass} FAIL=${failures.length}`);
  if (failures.length) {
    console.log("FAILURES:\n - " + failures.join("\n - "));
    process.exit(1);
  }
  console.log("ALL CHECKS PASS");
  await prisma.$disconnect();
  await o.$disconnect();
}

main().catch((e) => {
  console.error("battery crashed:", e instanceof Error ? `${e.name}: ${e.message}` : e);
  process.exit(1);
});
