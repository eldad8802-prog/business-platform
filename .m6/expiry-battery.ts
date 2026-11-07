/**
 * Leads L1.5-b · PR-6 — held expiry (PREPARED, OFF) on PostgreSQL with Production's RLS and a NOBYPASSRLS runtime
 * (same lab as the M6 battery); synthetic data only. INTAKE_HELD_EXPIRY_ENABLED is set ONLY inside this process.
 *
 *   OFF: a paused receipt held 15 days keeps waiting (nothing changes)
 *   ON : held 15 days → FAILED expired:connection_paused, payload KEPT, no attempt beyond the look, no Lead; held 13
 *        days → waits; the Dubiz emergency hold at 20 days → waits; resumed afterwards → the expired one is NOT
 *        processed; two racing sweeps expire it once; the 30-day dead-letter retention purges an ordinary dead letter
 *        but never an expired payload
 */
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { runWithTenantContext } from "../lib/tenant/context";
import { runTenantJob } from "../lib/tenant/job";
import { createKeyedConnection, setPaused } from "../lib/intake/acquisition/connection.service";
import { drainIntake } from "../lib/intake/core/processor";
import { intakeRegistry } from "../lib/intake/sources";
import { purgeExpiredFailedPayloads } from "../lib/intake/intake-event.store";
import { POST as webPOST } from "../app/api/intake/acquisition/web/[publicId]/route";

const RUN = `ex-${Date.now()}`;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
const o = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const params = <T extends object>(p: T) => ({ params: Promise.resolve(p) });
const at = (ms = 0) => new Date(Date.now() + ms);
const drain = (businessId: number, now: Date) => runTenantJob({ businessId }, () => drainIntake(intakeRegistry, businessId, { now, limit: 50 }));

async function enable(businessId: number, featureKey: string) {
  await o.businessFeatureAccess.upsert({ where: { businessId_featureKey: { businessId, featureKey } }, create: { businessId, featureKey, state: "ENABLED" }, update: { state: "ENABLED" } });
}
function web(publicId: string, key: string, body: Record<string, unknown>) {
  return webPOST(new NextRequest(`http://ex.local/api/intake/acquisition/web/${publicId}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "x-forwarded-for": "203.0.113.51" }, body: JSON.stringify(body),
  }), params({ publicId }));
}
async function clone(templateId: number, tag: string, ref: string, code: string, receivedAt: Date, status: "RECEIVED" | "FAILED" = "RECEIVED", lastAttemptAt: Date | null = null, next: Date | null = new Date(Date.now() - MIN)) {
  await o.$executeRawUnsafe(
    `INSERT INTO "IntakeEvent" ("businessId", "sourceKey", "family", "eventType", "dedupeBasis", "externalEventId", "providerAccountRef",
        "receivedAt", "status", "attempts", "lastAttemptAt", "nextAttemptAt", "lastErrorCode", "payload", "metadata", "createdAt", "updatedAt")
     SELECT t."businessId", t."sourceKey", t."family", t."eventType", t."dedupeBasis", 'sha256:' || encode(sha256(convert_to($1, 'UTF8')), 'hex'), $2,
            ($3::timestamptz AT TIME ZONE 'UTC'), $4::"IntakeEventStatus", 0, ($5::timestamptz AT TIME ZONE 'UTC'), ($8::timestamptz AT TIME ZONE 'UTC'), $6, t."payload",
            COALESCE(t."metadata", '{}'::jsonb) || jsonb_build_object('exTag', $1::text), now(), now()
       FROM "IntakeEvent" t WHERE t."id" = $7`,
    `${RUN}:${tag}`, ref, receivedAt.toISOString(), status, lastAttemptAt ? lastAttemptAt.toISOString() : null, code, templateId, next ? next.toISOString() : null
  );
  return o.intakeEvent.findFirstOrThrow({ where: { metadata: { path: ["exTag"], equals: `${RUN}:${tag}` } } });
}
const row = (id: number) => o.intakeEvent.findUniqueOrThrow({ where: { id } });

async function main() {
  const B = await o.business.create({ data: { name: `${RUN}-B` } });
  await enable(B.id, "acquisition_web_forms");
  const w = await runWithTenantContext({ businessId: B.id }, () => createKeyedConnection({ businessId: B.id, userId: null, sourceKey: "web.form", allowedOrigins: [] }));
  await runWithTenantContext({ businessId: B.id }, () => setPaused(w.connection.id, true));
  await web(w.connection.publicId, w.key, { submission_id: `${RUN}-t`, name: "Expiry", phone: "054-600-8001" });
  const t = await o.intakeEvent.findFirstOrThrow({ where: { businessId: B.id } });
  await o.intakeEvent.update({ where: { id: t.id }, data: { status: "IGNORED", nextAttemptAt: null } });
  const ref = w.connection.publicId;

  console.log("\n-- OFF (the default) --");
  delete process.env.INTAKE_HELD_EXPIRY_ENABLED;
  const offOld = await clone(t.id, "off-15d", ref, "held:connection_paused", at(-15 * DAY));
  await drain(B.id, at());
  const r0 = await row(offOld.id);
  ok("OFF: a receipt held 15 days keeps waiting (RECEIVED, held:connection_paused, payload kept)",
    r0.status === "RECEIVED" && r0.lastErrorCode === "held:connection_paused" && r0.payload !== null, JSON.stringify([r0.status, r0.lastErrorCode]));
  await o.intakeEvent.update({ where: { id: offOld.id }, data: { status: "IGNORED", nextAttemptAt: null } });

  console.log("\n-- ON (this process only) --");
  process.env.INTAKE_HELD_EXPIRY_ENABLED = "true";
  const old = await clone(t.id, "on-15d", ref, "held:connection_paused", at(-15 * DAY));
  const young = await clone(t.id, "on-13d", ref, "held:connection_paused", at(-13 * DAY));
  // Two racing looks.
  await Promise.all([drain(B.id, at()), drain(B.id, at())]);
  const ro = await row(old.id);
  ok("ON: held 15 days → FAILED expired:connection_paused, no further attempt, PAYLOAD KEPT",
    ro.status === "FAILED" && ro.lastErrorCode === "expired:connection_paused" && ro.nextAttemptAt === null && ro.payload !== null && ro.payloadPurgedAt === null,
    JSON.stringify([ro.status, ro.lastErrorCode, ro.nextAttemptAt, ro.payload === null]));
  ok("ON: …claimed once under two racing looks (attempts = 1)", ro.attempts === 1, String(ro.attempts));
  const ry = await row(young.id);
  ok("ON: held 13 days → still waits (held, payload kept)", ry.status === "RECEIVED" && ry.lastErrorCode === "held:connection_paused" && ry.payload !== null);
  ok("ON: no Lead was created for any of them", (await o.lead.count({ where: { businessId: B.id } })) === 0);

  console.log("\n-- resumed after expiry --");
  await runWithTenantContext({ businessId: B.id }, () => setPaused(w.connection.id, false));
  await drain(B.id, at(11 * MIN));
  await drain(B.id, at(12 * MIN));
  const ro2 = await row(old.id);
  const ry2 = await row(young.id);
  ok("resumed: the expired receipt is NOT processed (still FAILED expired:…), the 13-day one IS (one Lead)",
    ro2.status === "FAILED" && ro2.lastErrorCode === "expired:connection_paused" && ry2.status === "PROCESSED"
      && (await o.lead.count({ where: { businessId: B.id } })) === 1, JSON.stringify([ro2.status, ry2.status]));

  console.log("\n-- the Dubiz emergency hold never expires --");
  const E = await o.business.create({ data: { name: `${RUN}-E` } });
  await enable(E.id, "acquisition_web_forms");
  const we = await runWithTenantContext({ businessId: E.id }, () => createKeyedConnection({ businessId: E.id, userId: null, sourceKey: "web.form", allowedOrigins: [] }));
  await runWithTenantContext({ businessId: E.id }, () => setPaused(we.connection.id, true));
  await web(we.connection.publicId, we.key, { submission_id: `${RUN}-te`, name: "Emergency", phone: "054-600-8002" });
  const te = await o.intakeEvent.findFirstOrThrow({ where: { businessId: E.id } });
  await o.intakeEvent.update({ where: { id: te.id }, data: { status: "IGNORED", nextAttemptAt: null } });
  await runWithTenantContext({ businessId: E.id }, () => setPaused(we.connection.id, false));
  await o.platformFeaturePolicy.upsert({ where: { featureKey: "acquisition_web_forms" }, create: { featureKey: "acquisition_web_forms", globalEnabled: false, emergencyDisabled: true }, update: { emergencyDisabled: true } });
  const e20 = await clone(te.id, "emergency-20d", we.connection.publicId, "held:emergency_disabled", at(-20 * DAY));
  await drain(E.id, at());
  const re = await row(e20.id);
  ok("ON: a receipt held 20 days by the Dubiz emergency switch keeps waiting (its own policy)",
    re.status === "RECEIVED" && re.lastErrorCode === "held:emergency_disabled" && re.payload !== null, JSON.stringify([re.status, re.lastErrorCode]));
  await o.platformFeaturePolicy.update({ where: { featureKey: "acquisition_web_forms" }, data: { emergencyDisabled: false } });

  console.log("\n-- the dead-letter retention never purges an expired payload --");
  const ordinary = await clone(t.id, "ordinary-dead-40d", ref, "error:Error", at(-41 * DAY), "FAILED", at(-40 * DAY), null);
  await o.intakeEvent.update({ where: { id: old.id }, data: { lastAttemptAt: at(-40 * DAY) } });
  const purged = await runTenantJob({ businessId: B.id }, () => purgeExpiredFailedPayloads(B.id, at()));
  const rd = await row(ordinary.id);
  const rx = await row(old.id);
  ok(`retention: the ordinary 40-day dead letter is purged (${purged}); the expired one keeps its payload`,
    rd.payload === null && rd.payloadPurgedAt !== null && rx.payload !== null && rx.payloadPurgedAt === null, JSON.stringify({ purged, ordinary: rd.payload === null, expired: rx.payload === null }));
  delete process.env.INTAKE_HELD_EXPIRY_ENABLED;

  console.log(`\nL1.5-b expiry battery: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log("FAILED:\n - " + failures.join("\n - ")); process.exitCode = 1; }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await o.$disconnect(); });
