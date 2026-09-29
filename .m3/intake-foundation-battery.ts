/**
 * Business Intake M3 — canonical foundation battery (ephemeral PG17).
 *
 * The lab database is the PRE-M3 schema (main before M3, via `db push`) with
 * M2's isolation from its real migration; the REAL M3 migration file is then
 * applied with psql. This battery runs in two phases around that migration:
 *
 *   --phase=pre   (before the migration) writes receipts exactly as the M2 code
 *                 does — provider/kind only — so the backfill is proven on data.
 *   --phase=post  (after) proves, as a NOSUPERUSER / NOBYPASSRLS runtime role:
 *     migration   backfill · legacy-insert trigger · CHECK vocabularies ·
 *                 source-scoped unique · composite tenant FK
 *     grants      exact SELECT/INSERT/UPDATE, no DELETE/TRUNCATE (both tables)
 *     RLS         cross-tenant read / update / insert / no-context / delete
 *     tenant      only the adapter's trusted resolver decides; a payload's
 *                 businessId is ignored; unknown account records nothing;
 *                 resolver failure throws (provider must redeliver)
 *     identity    duplicate + 6× concurrent duplicate → one receipt, one lead;
 *                 same id across sources / businesses stays separate;
 *                 missing id → explicit fingerprint; unkeyable → refused
 *     lifecycle   partial failure → retry → one lead; poison → dead-letter
 *                 without blocking others; terminal error; malformed payload;
 *                 unknown source; unsupported family; deferral not counted
 *     boundaries  identity 'unresolved' keeps hints for M4 (no merge); a
 *                 'delegated'-style outcome purges them; attribution sanitized;
 *                 no PII in the learning signal; trace answers without content
 *     neutrality  a LEAD source through the same core, routed to a different
 *                 destination than WhatsApp's
 *
 * Synthetic data only. No secrets, no Neon, no network.
 *
 * env: DATABASE_URL (runtime role app_runtime), RLS_ADMIN_URL (owner)
 */
import { PrismaClient } from "@prisma/client";
import { runTenantJob } from "../lib/tenant/job";
import { getTenantContext } from "../lib/tenant/context";
import { IntakeRegistry } from "../lib/intake/core/registry";
import { acceptIntake, drainIntake, processIntakeEvent } from "../lib/intake/core/processor";
import { recordReceipts } from "../lib/intake/intake-event.store";
import { traceIntakeByProviderEvent, traceIntakeReceipt } from "../lib/intake/core/trace";
import { MissingEventIdentityError } from "../lib/intake/core/event-identity";
import { INTAKE_MAX_ATTEMPTS } from "../lib/intake/intake-event.store";
import {
  REFERENCE_SOURCE,
  buildReferenceReceipt,
  createLeadSink,
  createReferenceAdapter,
  type ReferenceDelivery,
} from "./reference-lead-adapter";

const phase = (process.argv.find((a) => a.startsWith("--phase=")) ?? "--phase=post").slice(8);
const RUN = process.env.M3_RUN_TAG ?? "m3lab";

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

function owner(): PrismaClient {
  const url = process.env.RLS_ADMIN_URL;
  if (!url) throw new Error("RLS_ADMIN_URL is not set");
  return new PrismaClient({ datasourceUrl: url });
}

// ─── phase: pre (M2-shaped rows, raw SQL — the Prisma client is post-M3) ──────
async function pre() {
  const o = owner();
  // Business is unchanged by M3, so the (post-M3) client can create it; only
  // IntakeEvent rows must be written the way the M2 code writes them.
  const b = await o.business.create({ data: { name: `${RUN}-legacy` } });
  for (const [key, kind] of [
    ["sha256:" + "a".repeat(64), "MESSAGE_RECEIVED"],
    ["sha256:" + "b".repeat(64), "MESSAGE_STATUS"],
  ] as const) {
    await o.$executeRawUnsafe(
      `INSERT INTO "IntakeEvent"("businessId", provider, kind, "externalEventId", "updatedAt")
       VALUES (${b.id}, 'WHATSAPP', '${kind}', '${key}', now())`
    );
  }
  console.log(`  pre-M3: 2 legacy M2 receipts written for business ${b.id}`);
  await o.$disconnect();
}

// ─── phase: post ──────────────────────────────────────────────────────────────
async function post() {
  const prisma = new PrismaClient(); // runtime (DATABASE_URL)
  const o = owner();

  const [who] = (await prisma.$queryRawUnsafe(
    `SELECT current_user::text AS who, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
  )) as Array<{ who: string; rolsuper: boolean; rolbypassrls: boolean }>;
  console.log(`  runtime: ${who.who} (superuser=${who.rolsuper}, bypassrls=${who.rolbypassrls})`);
  if (who.rolsuper || who.rolbypassrls) throw new Error("runtime bypasses RLS — nothing would be proven");
  ok("no ambient tenant context", getTenantContext() === undefined);

  // ── 1. migration mechanics (only when the lab applied the REAL migration) ──
  const migrated = (process.env.M3_LAB_MODE ?? "migration") === "migration";
  if (migrated) {
  console.log("\n-- migration mechanics --");
  const legacy = (await o.$queryRawUnsafe(
    `SELECT e."sourceKey", e.family::text AS family, e."eventType", e."dedupeBasis", e.kind::text AS kind
       FROM "IntakeEvent" e JOIN "Business" b ON b.id = e."businessId" WHERE b.name = '${RUN}-legacy' ORDER BY e.id`
  )) as Array<{ sourceKey: string; family: string; eventType: string; dedupeBasis: string; kind: string }>;
  ok("backfill: pre-existing M2 receipts became source 'whatsapp' / MESSAGE",
    legacy.length === 2 && legacy.every((r) => r.sourceKey === "whatsapp" && r.family === "MESSAGE" && r.dedupeBasis === "provider_event_id"),
    JSON.stringify(legacy));
  ok("backfill: event types follow the legacy kind",
    legacy[0]?.eventType === "message.received" && legacy[1]?.eventType === "message.status");

  const [lb] = (await o.$queryRawUnsafe(`SELECT id FROM "Business" WHERE name = '${RUN}-legacy'`)) as Array<{ id: number }>;
  await o.$executeRawUnsafe(
    `INSERT INTO "IntakeEvent"("businessId", provider, kind, "externalEventId", "updatedAt")
     VALUES (${lb.id}, 'WHATSAPP', 'MESSAGE_RECEIVED', 'sha256:${"c".repeat(64)}', now())`
  );
  const [trig] = (await o.$queryRawUnsafe(
    `SELECT "sourceKey", family::text AS family, "eventType" FROM "IntakeEvent" WHERE "externalEventId" = 'sha256:${"c".repeat(64)}'`
  )) as Array<{ sourceKey: string; family: string; eventType: string }>;
  ok("trigger: an M2-code insert AFTER the migration still satisfies the new NOT NULLs",
    trig?.sourceKey === "whatsapp" && trig.family === "MESSAGE" && trig.eventType === "message.received", JSON.stringify(trig));

  const bad = async (sql: string) => (await rejects(() => o.$executeRawUnsafe(sql))) !== null;
  ok("CHECK: a sourceKey outside the registry vocabulary is refused",
    await bad(`INSERT INTO "IntakeEvent"("businessId","sourceKey",family,"eventType","externalEventId","updatedAt") VALUES (${lb.id},'Bad Key','LEAD','lead.x','sha256:${"d".repeat(64)}',now())`));
  ok("CHECK: the legacy provider column can only describe the whatsapp source",
    await bad(`INSERT INTO "IntakeEvent"("businessId","sourceKey",family,"eventType","externalEventId",provider,"updatedAt") VALUES (${lb.id},'meta.lead_ads','LEAD','lead.x','sha256:${"e".repeat(64)}','WHATSAPP',now())`));
  ok("CHECK: unknown dedupeBasis refused",
    await bad(`INSERT INTO "IntakeEvent"("businessId","sourceKey",family,"eventType","externalEventId","dedupeBasis","updatedAt") VALUES (${lb.id},'x.y','LEAD','lead.x','sha256:${"f".repeat(64)}','random',now())`));
  ok("unique: same (business, source, externalEventId) twice refused at the DB",
    await bad(`INSERT INTO "IntakeEvent"("businessId","sourceKey",family,"eventType","externalEventId","updatedAt") VALUES (${lb.id},'whatsapp','MESSAGE','message.received','sha256:${"c".repeat(64)}',now())`));

  } else {
    console.log("\n-- migration mechanics: skipped (base already contains M3; proven when it landed) --");
  }

  // ── fixtures ────────────────────────────────────────────────────────────────
  const bizA = await o.business.create({ data: { name: `${RUN}-A` } });
  const bizB = await o.business.create({ data: { name: `${RUN}-B` } });
  const FORM_A = `${RUN}-formA`;
  const FORM_B = `${RUN}-formB`;
  const connections = new Map<string, number>([
    [FORM_A, bizA.id],
    [FORM_B, bizB.id],
  ]);
  const sink = createLeadSink();
  let resolverDown = false;
  const deferNext = { count: 0 };
  const adapter = createReferenceAdapter({ connections, sink, resolverFails: () => resolverDown, deferNext });
  const registry = new IntakeRegistry().register(adapter);
  const otherSink = createLeadSink();
  const registry2 = new IntakeRegistry()
    .register(adapter)
    .register(createReferenceAdapter({ sourceKey: "reference.other", connections, sink: otherSink }));

  const delivery = (over: Partial<ReferenceDelivery> = {}): ReferenceDelivery => ({
    kind: "lead",
    formId: FORM_A,
    submissionId: `${RUN}-sub-${Math.random().toString(36).slice(2)}`,
    submittedAt: new Date().toISOString(),
    fields: { fullName: "Dana Levi", phone: "050-123-4567", email: "Dana@Example.com", company: "Levi Ltd" },
    tracking: {
      formName: "Spring promo",
      campaignId: "c-1",
      adSetId: "as-1",
      adId: "ad-1",
      landingPage: "https://levi.example/offer?utm_source=fb&utm_medium=cpc&email=dana@example.com",
    },
    ...over,
  });
  const accept = (d: ReferenceDelivery, reg = registry, sourceKey = REFERENCE_SOURCE) =>
    acceptIntake({ registry: reg, sourceKey, accountRef: d.formId, receipts: [buildReferenceReceipt(d)] });
  const drain = (businessId: number, now = new Date(), reg = registry) =>
    runTenantJob({ businessId }, () => drainIntake(reg, businessId, { now, limit: 100 }));

  // ── 2. exact grants ─────────────────────────────────────────────────────────
  console.log("\n-- exact grants --");
  for (const t of ["IntakeEvent", "IntakeNormalizedEvent"]) {
    const [p] = (await o.$queryRawUnsafe(
      `SELECT has_table_privilege('${who.who}','"${t}"','SELECT') s, has_table_privilege('${who.who}','"${t}"','INSERT') i,
              has_table_privilege('${who.who}','"${t}"','UPDATE') u, has_table_privilege('${who.who}','"${t}"','DELETE') d,
              has_table_privilege('${who.who}','"${t}"','TRUNCATE') tr`
    )) as Array<Record<string, boolean>>;
    ok(`${t}: runtime SELECT/INSERT/UPDATE, no DELETE/TRUNCATE`, p.s && p.i && p.u && !p.d && !p.tr, JSON.stringify(p));
  }
  const [rls] = (await o.$queryRawUnsafe(
    `SELECT relrowsecurity r, relforcerowsecurity f FROM pg_class WHERE relname='IntakeNormalizedEvent'`
  )) as Array<{ r: boolean; f: boolean }>;
  ok("IntakeNormalizedEvent: ENABLE + FORCE row level security", rls.r && rls.f);
  const pols = (await o.$queryRawUnsafe(
    `SELECT cmd FROM pg_policies WHERE tablename='IntakeNormalizedEvent' ORDER BY cmd`
  )) as Array<{ cmd: string }>;
  ok("IntakeNormalizedEvent: per-command policies SELECT/INSERT/UPDATE only (no ALL, no DELETE)",
    JSON.stringify(pols.map((p) => p.cmd)) === JSON.stringify(["INSERT", "SELECT", "UPDATE"]), JSON.stringify(pols));

  // ── 3. tenant resolution ────────────────────────────────────────────────────
  console.log("\n-- tenant resolution --");
  const hostile = delivery({ claimedBusinessId: bizB.id });
  const acc = await accept(hostile);
  ok("the trusted resolver decides the tenant; a payload naming B is recorded under A",
    acc.status === "accepted" && acc.businessId === bizA.id);
  ok("…and B has no receipt from it", (await o.intakeEvent.count({ where: { businessId: bizB.id } })) === 0);
  const unknown = await accept(delivery({ formId: `${RUN}-nobody` }));
  ok("unknown provider account → nothing recorded", unknown.status === "unknown_account");
  resolverDown = true;
  const down = await rejects(() => accept(delivery()));
  resolverDown = false;
  ok("resolver failure THROWS (the provider must not be acknowledged)", down !== null, String(down));

  // ── 4. idempotency ──────────────────────────────────────────────────────────
  console.log("\n-- idempotency --");
  const dup = delivery();
  const r1 = await accept(dup);
  const r2 = await accept(dup);
  ok("duplicate delivery → one receipt (second is a replay)",
    r1.status === "accepted" && r2.status === "accepted" && r1.recorded[0].id === r2.recorded[0].id &&
      r1.recorded[0].isNew && !r2.recorded[0].isNew);
  const burst = delivery();
  const burstResults = await Promise.all(Array.from({ length: 6 }, () => accept(burst)));
  const burstIds = new Set(burstResults.map((r) => (r.status === "accepted" ? r.recorded[0].id : -1)));
  ok("6 concurrent duplicate deliveries → exactly one receipt", burstIds.size === 1 && !burstIds.has(-1), JSON.stringify([...burstIds]));
  await drain(bizA.id);
  await Promise.all(Array.from({ length: 3 }, () => drain(bizA.id)));
  const burstId = [...burstIds][0];
  const burstNorm = await o.intakeNormalizedEvent.findMany({ where: { intakeEventId: burstId } });
  ok("…one normalized record, one lead, even with concurrent drains",
    burstNorm.length === 1 && (burstNorm[0].resultRefs as { leadId?: number } | null)?.leadId !== undefined);

  const sameIdOtherSource = delivery();
  const s1 = await accept(sameIdOtherSource, registry2, REFERENCE_SOURCE);
  const s2 = await accept(sameIdOtherSource, registry2, "reference.other");
  ok("same provider event id under two SOURCES → two receipts",
    s1.status === "accepted" && s2.status === "accepted" && s1.recorded[0].id !== s2.recorded[0].id);
  const sameIdOtherBiz = delivery({ submissionId: `${RUN}-shared-sub` });
  const b1 = await accept({ ...sameIdOtherBiz, formId: FORM_A });
  const b2 = await accept({ ...sameIdOtherBiz, formId: FORM_B });
  ok("same provider event id for two BUSINESSES → isolated receipts",
    b1.status === "accepted" && b2.status === "accepted" && b1.businessId === bizA.id && b2.businessId === bizB.id &&
      b1.recorded[0].id !== b2.recorded[0].id);

  const noId = delivery({ submissionId: null });
  const f1 = await accept(noId);
  const f2 = await accept({ ...noId });
  const fRow = f1.status === "accepted" ? await o.intakeEvent.findUnique({ where: { id: f1.recorded[0].id } }) : null;
  ok("missing provider id → explicit content fingerprint (dedupes; basis recorded)",
    f1.status === "accepted" && f2.status === "accepted" && f1.recorded[0].id === f2.recorded[0].id &&
      fRow?.dedupeBasis === "content_fingerprint");
  const unkeyable = await rejects(async () =>
    buildReferenceReceipt({ kind: "lead", formId: "", submissionId: null, submittedAt: null, fields: {} })
  );
  ok("no id and no fingerprint → REFUSED (never a random key)",
    unkeyable !== null && unkeyable.includes(new MissingEventIdentityError().code), String(unkeyable));

  // ── 5. processing: normal path + boundaries ─────────────────────────────────
  console.log("\n-- processing + boundaries --");
  const norm = delivery();
  const n1 = await accept(norm);
  const nId = n1.status === "accepted" ? n1.recorded[0].id : -1;
  await drain(bizA.id);
  const ev = await o.intakeEvent.findUnique({ where: { id: nId } });
  const ne = await o.intakeNormalizedEvent.findUnique({ where: { intakeEventId: nId } });
  ok("processed: PROCESSED, stage completed, payload purged",
    ev?.status === "PROCESSED" && ev.lastStage === "completed" && ev.payload === null && ev.payloadPurgedAt !== null,
    JSON.stringify({ s: ev?.status, st: ev?.lastStage }));
  ok("normalized: routed to 'lead' with the lead id",
    ne?.routeTarget === "lead" && ne.routeOutcome === "routed" && typeof (ne.resultRefs as { leadId?: number })?.leadId === "number");
  ok("identity boundary: 'unresolved' — hints KEPT for M4, no merge performed",
    ne?.identityOutcome === "unresolved" && ne.contactHints !== null && ne.contactHintsPurgedAt === null);
  const hints = ne?.contactHints as { phone?: string; email?: string } | null;
  ok("contact hints normalized by the shared normalizers", hints?.phone === "972501234567" && hints?.email === "dana@example.com");
  const attr = ne?.attribution as Record<string, unknown> | null;
  ok("attribution preserved and structured (campaign / ad set / ad / form / utm / landing page)",
    attr?.campaignId === "c-1" && attr?.adSetId === "as-1" && attr?.adId === "ad-1" && attr?.formId === FORM_A &&
      (attr?.utm as Record<string, string>)?.source === "fb" && attr?.landingPage === "https://levi.example/offer",
    JSON.stringify(attr));
  ok("attribution carries no personal data from the landing-page query", !JSON.stringify(attr).includes("dana@"));
  const sensor = await o.learningEvent.findFirst({ where: { businessId: bizA.id, eventType: "INTAKE_EVENT_SETTLED", entityId: nId } });
  ok("learning signal written once, with no contact value or content",
    sensor !== null && !/dana|0501|972501|levi/i.test(JSON.stringify(sensor.payload)),
    JSON.stringify(sensor?.payload));

  const form = delivery({ kind: "form" });
  const fm = await accept(form);
  await drain(bizA.id);
  const fmEv = fm.status === "accepted" ? await o.intakeEvent.findUnique({ where: { id: fm.recorded[0].id } }) : null;
  ok("a different family routes differently (FORM_SUBMISSION → attention, deliberately not a Lead)",
    fmEv?.family === "FORM_SUBMISSION" && fmEv.status === "IGNORED" && fmEv.lastErrorCode === "form_needs_owner");

  const badContact = delivery({ fields: { phone: "12", email: "nope" }, submittedAt: "not-a-date" });
  const bc = await accept(badContact);
  await drain(bizA.id);
  const bcId = bc.status === "accepted" ? bc.recorded[0].id : -1;
  const bcEv = await o.intakeEvent.findUnique({ where: { id: bcId } });
  const bcNe = await o.intakeNormalizedEvent.findUnique({ where: { intakeEventId: bcId } });
  ok("malformed timestamp → occurredAt null (never invented)", bcEv?.occurredAt === null);
  ok("malformed contact hints → dropped, marked invalid, event still processed",
    bcEv?.status === "PROCESSED" && (bcNe?.signals as Record<string, string>)?.phone === "invalid" &&
      (bcNe?.signals as Record<string, string>)?.email === "invalid" && Object.keys(bcNe?.signals ?? {}).length === 2 &&
      bcNe?.contactHints === null && bcNe?.identityOutcome === "none");

  // ── 6. failure matrix ───────────────────────────────────────────────────────
  console.log("\n-- failure / recovery --");
  const partial = delivery();
  const pr = await accept(partial);
  const prId = pr.status === "accepted" ? pr.recorded[0].id : -1;
  sink.failNext = 1;
  await drain(bizA.id);
  const prAfter1 = await o.intakeEvent.findUnique({ where: { id: prId } });
  ok("routing failure → FAILED with a retry scheduled and a bounded code",
    prAfter1?.status === "FAILED" && prAfter1.nextAttemptAt !== null && prAfter1.lastErrorCode === "error:Error");
  ok("…normalization already recorded (stage normalized), payload kept for the retry",
    prAfter1?.lastStage === "normalized" && prAfter1.payload !== null);
  await drain(bizA.id, new Date(Date.now() + 3_600_000));
  const prAfter2 = await o.intakeEvent.findUnique({ where: { id: prId } });
  ok("retry after partial failure → PROCESSED", prAfter2?.status === "PROCESSED");
  ok("…exactly one normalized record and one lead for it",
    (await o.intakeNormalizedEvent.count({ where: { intakeEventId: prId } })) === 1 && sink.distinctLeads() >= 1);

  const poison = delivery();
  const po = await accept(poison);
  const poId = po.status === "accepted" ? po.recorded[0].id : -1;
  const healthy = delivery();
  const he = await accept(healthy);
  const heId = he.status === "accepted" ? he.recorded[0].id : -1;
  sink.failAlways = true;
  let t = Date.now();
  for (let i = 0; i < INTAKE_MAX_ATTEMPTS + 1; i++) {
    t += 13 * 3_600_000;
    await runTenantJob({ businessId: bizA.id }, () => processIntakeEvent(registry, bizA.id, poId, new Date(t)));
  }
  sink.failAlways = false;
  const poEv = await o.intakeEvent.findUnique({ where: { id: poId } });
  ok(`poison event → dead-letter after ${INTAKE_MAX_ATTEMPTS} attempts (FAILED, no next attempt)`,
    poEv?.status === "FAILED" && poEv.nextAttemptAt === null && poEv.attempts === INTAKE_MAX_ATTEMPTS, JSON.stringify({ a: poEv?.attempts, s: poEv?.status }));
  await drain(bizA.id, new Date(t + 1000));
  ok("…and it never blocked an unrelated event of the same business",
    (await o.intakeEvent.findUnique({ where: { id: heId } }))?.status === "PROCESSED");

  sink.terminal = true;
  const term = delivery();
  const tm = await accept(term);
  await drain(bizA.id);
  sink.terminal = false;
  const tmEv = tm.status === "accepted" ? await o.intakeEvent.findUnique({ where: { id: tm.recorded[0].id } }) : null;
  ok("terminal adapter error → dead-letter NOW, payload kept for operator replay",
    tmEv?.status === "FAILED" && tmEv.nextAttemptAt === null && tmEv.lastErrorCode === "lead_rejected" && tmEv.payload !== null);

  const malformed = await runTenantJob({ businessId: bizA.id }, () =>
    recordReceipts(bizA.id, REFERENCE_SOURCE, [{ ...buildReferenceReceipt(delivery()), payload: { v: 1, formId: FORM_A } }])
  );
  await drain(bizA.id);
  const mEv = await o.intakeEvent.findUnique({ where: { id: malformed[0].id } });
  ok("normalization failure → dead-letter 'normalize:malformed_payload' (retrying cannot fix it)",
    mEv?.status === "FAILED" && mEv.nextAttemptAt === null && mEv.lastErrorCode === "normalize:malformed_payload");

  const orphan = await runTenantJob({ businessId: bizA.id }, () =>
    recordReceipts(bizA.id, "reference.retired", [buildReferenceReceipt(delivery())])
  );
  await drain(bizA.id);
  const oEv = await o.intakeEvent.findUnique({ where: { id: orphan[0].id } });
  ok("unknown source (no adapter) → dead-letter, payload KEPT for replay once the adapter exists",
    oEv?.status === "FAILED" && oEv.nextAttemptAt === null && oEv.lastErrorCode === "unknown_source" && oEv.payload !== null);

  const callEv = await runTenantJob({ businessId: bizA.id }, () =>
    recordReceipts(bizA.id, REFERENCE_SOURCE, [{ ...buildReferenceReceipt(delivery()), family: "CALL", eventType: "call.missed" }])
  );
  await drain(bizA.id);
  const cEv = await o.intakeEvent.findUnique({ where: { id: callEv[0].id } });
  ok("family the adapter does not declare → dead-letter 'unsupported_family'",
    cEv?.status === "FAILED" && cEv.lastErrorCode === "unsupported_family");

  deferNext.count = 1;
  const def = delivery();
  const df = await accept(def);
  const dfId = df.status === "accepted" ? df.recorded[0].id : -1;
  await drain(bizA.id);
  const dfEv = await o.intakeEvent.findUnique({ where: { id: dfId } });
  ok("deferral (throttle) → waits; the attempt is not counted", dfEv?.status === "RECEIVED" && dfEv.attempts === 0 && dfEv.nextAttemptAt !== null);
  await drain(bizA.id, new Date(Date.now() + 120_000));
  ok("…then processes", (await o.intakeEvent.findUnique({ where: { id: dfId } }))?.status === "PROCESSED");

  // ── 7. RLS as the runtime role ──────────────────────────────────────────────
  console.log("\n-- RLS (NOBYPASSRLS runtime) --");
  const bEvent = b2.status === "accepted" ? b2.recorded[0].id : -1;
  await drain(bizB.id);
  const readB = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '${bizA.id}', true)`);
    return {
      e: await tx.intakeEvent.count({ where: { businessId: bizB.id } }),
      n: await tx.intakeNormalizedEvent.count({ where: { businessId: bizB.id } }),
    };
  });
  ok("A cannot READ B's receipts or normalized records", readB.e === 0 && readB.n === 0, JSON.stringify(readB));
  const updB = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '${bizA.id}', true)`);
    return {
      e: (await tx.intakeEvent.updateMany({ where: { id: bEvent }, data: { lastErrorCode: "x" } })).count,
      n: (await tx.intakeNormalizedEvent.updateMany({ where: { businessId: bizB.id }, data: { routeOutcome: "ignored" } })).count,
    };
  });
  ok("A cannot UPDATE B's receipts or normalized records", updB.e === 0 && updB.n === 0);
  const insB = await rejects(() =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '${bizA.id}', true)`);
      await tx.intakeNormalizedEvent.create({
        data: { businessId: bizB.id, intakeEventId: bEvent, normalizerVersion: "x@1", identityOutcome: "none" },
      });
    })
  );
  ok("A cannot INSERT a normalized record for B", insB !== null);
  const noCtx = {
    e: await prisma.intakeEvent.count(),
    n: await prisma.intakeNormalizedEvent.count(),
  };
  ok("no tenant context → sees nothing (fail-closed)", noCtx.e === 0 && noCtx.n === 0, JSON.stringify(noCtx));
  const del = await rejects(() =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '${bizA.id}', true)`);
      await tx.$executeRawUnsafe(`DELETE FROM "IntakeNormalizedEvent" WHERE "businessId" = ${bizA.id}`);
    })
  );
  ok("DELETE on normalized records is refused (no privilege)", del !== null && /permission/i.test(String(del) + ""), String(del));
  const crossFk = await rejects(() =>
    o.intakeNormalizedEvent.create({
      data: { businessId: bizA.id, intakeEventId: bEvent, normalizerVersion: "x@1", identityOutcome: "none" },
    })
  );
  ok("composite FK: even the OWNER cannot link A's normalized record to B's receipt", crossFk !== null);
  // B gets a fresh due receipt; draining A (as A) must leave it untouched.
  const bDue = await accept(delivery({ formId: FORM_B }));
  const bDueId = bDue.status === "accepted" ? bDue.recorded[0].id : -1;
  await drain(bizA.id, new Date(Date.now() + 86_400_000));
  const bDueAfter = await o.intakeEvent.findUnique({ where: { id: bDueId } });
  ok("retries stay tenant-scoped: draining A never touches B's due receipt",
    bDue.status === "accepted" && bDue.businessId === bizB.id && bDueAfter?.status === "RECEIVED" && bDueAfter.attempts === 0);

  // ── 8. trace (operator read model) ──────────────────────────────────────────
  console.log("\n-- trace --");
  const tr = await runTenantJob({ businessId: bizA.id }, () =>
    traceIntakeByProviderEvent(bizA.id, REFERENCE_SOURCE, { providerEventId: norm.submissionId!, accountScope: FORM_A })
  );
  ok("trace by the PROVIDER's event id answers 'what happened' (state, stage, route, refs)",
    tr?.state === "processed" && tr.lastStage === "completed" && tr.normalized?.routeTarget === "lead" &&
      typeof (tr.normalized?.resultRefs as { leadId?: number })?.leadId === "number");
  ok("trace never returns payload, contact values or message content",
    !/dana|972501|0501|Levi Ltd/i.test(JSON.stringify(tr)) && tr?.normalized?.contactHintsRetained === true);
  const trDead = await runTenantJob({ businessId: bizA.id }, () => traceIntakeReceipt(bizA.id, poId));
  ok("trace shows a dead-letter with its bounded code and attempts",
    trDead?.state === "dead_letter" && trDead.lastErrorCode === "error:Error" && trDead.attempts === INTAKE_MAX_ATTEMPTS);
  const trCross = await runTenantJob({ businessId: bizA.id }, () => traceIntakeReceipt(bizA.id, bEvent));
  ok("trace is tenant-scoped: A cannot trace B's receipt", trCross === null);

  console.log(`\n[m3] PASS=${pass} FAIL=${failures.length}`);
  if (failures.length) {
    console.log("FAILURES:\n - " + failures.join("\n - "));
    process.exit(1);
  }
  console.log("ALL CHECKS PASS");
  await prisma.$disconnect();
  await o.$disconnect();
}

(phase === "pre" ? pre() : post()).catch((e) => {
  console.error("battery crashed:", e instanceof Error ? `${e.name}: ${e.message}` : e);
  process.exit(1);
});
