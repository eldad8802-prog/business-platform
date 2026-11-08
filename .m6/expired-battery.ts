/**
 * Leads L1.5-b · A1 — expired receipts are archived, never dead letters, on PostgreSQL with Production's RLS and a
 * NOBYPASSRLS runtime (same lab as the M6 battery); synthetic data only. Nothing expires on its own yet: the expiry is
 * driven here by an adapter that settles the receipt with "expired:<reason>", exactly as the later expiry PR will.
 *
 *   - health: an expired receipt is never reported as a new dead letter, never counted as an open one
 *   - backlog: the owner's / capacity read never counts or scans it (no "could not be taken in")
 *   - retention: the 30-day dead-letter purge deletes dead-letter payloads, never an expired one
 *   - processor: a real expiry is tallied "expired", not "failed"; the sweep stays healthy
 *   - RLS: another business's tenant reads none of it
 */
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { runWithTenantContext } from "../lib/tenant/context";
import { runTenantJob } from "../lib/tenant/job";
import { createKeyedConnection, listConnections, setPaused } from "../lib/intake/acquisition/connection.service";
import { intakeBacklog, intakeHealthCounts, purgeExpiredFailedPayloads } from "../lib/intake/intake-event.store";
import { drainIntake } from "../lib/intake/core/processor";
import { IntakeTerminalError } from "../lib/intake/core/contract";
import { IntakeRegistry } from "../lib/intake/core/registry";
import { intakeRegistry } from "../lib/intake/sources";
import { runIntakeSweep, sweepHealth } from "../lib/intake/intake-sweeper";
import { translateIntakeAttention } from "../lib/business-status/intake-attention";
import { POST as webPOST } from "../app/api/intake/acquisition/web/[publicId]/route";

const RUN = `ex-${Date.now()}`;
const DAY = 24 * 60 * 60 * 1000;
let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
const o = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const at = (ms = 0) => new Date(Date.now() + ms);

async function clone(templateId: number, n: number, status: "FAILED", code: string, lastAttemptAt: Date, tag: string) {
  await o.$executeRawUnsafe(
    `INSERT INTO "IntakeEvent" ("businessId", "sourceKey", "family", "eventType", "dedupeBasis", "externalEventId", "providerAccountRef",
        "receivedAt", "status", "attempts", "nextAttemptAt", "lastAttemptAt", "lastErrorCode", "payload", "metadata", "createdAt", "updatedAt")
     SELECT t."businessId", t."sourceKey", t."family", t."eventType", t."dedupeBasis", 'sha256:' || encode(sha256(convert_to($1 || ':' || g, 'UTF8')), 'hex'),
            t."providerAccountRef", t."receivedAt", $2::"IntakeEventStatus", 1, NULL, ($3::timestamptz AT TIME ZONE 'UTC'), $4, t."payload", '{}'::jsonb, now(), now()
       FROM "IntakeEvent" t, generate_series(1, $5::int) g WHERE t."id" = $6`,
    `${RUN}:${tag}`, status, lastAttemptAt.toISOString(), code, n, templateId
  );
}

async function main() {
  const B = await o.business.create({ data: { name: `${RUN}-a` } });
  const Y = await o.business.create({ data: { name: `${RUN}-y` } });
  await o.businessFeatureAccess.create({ data: { businessId: B.id, featureKey: "acquisition_web_forms", state: "ENABLED" } });
  const w = await runWithTenantContext({ businessId: B.id }, () => createKeyedConnection({ businessId: B.id, userId: null, sourceKey: "web.form", allowedOrigins: [] }));
  await runWithTenantContext({ businessId: B.id }, () => setPaused(w.connection.id, true));
  const res = await webPOST(new NextRequest(`http://ex.local/api/intake/acquisition/web/${w.connection.publicId}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${w.key}`, "x-forwarded-for": "203.0.113.88" },
    body: JSON.stringify({ submission_id: `${RUN}-t`, name: "Expired Lab", phone: "054-600-8001" }),
  }), { params: Promise.resolve({ publicId: w.connection.publicId }) });
  const t = await o.intakeEvent.findFirstOrThrow({ where: { businessId: B.id } });
  ok(`setup: a paused endpoint's delivery is held (${res.status}, ${t.lastErrorCode})`, res.status < 300 && t.lastErrorCode === "held:connection_paused");

  // 3 genuine dead letters + 4 expired receipts, all last touched 40 days ago (past the 30-day retention).
  await clone(t.id, 3, "FAILED", "error:Error", at(-40 * DAY), "dead");
  await clone(t.id, 4, "FAILED", "expired:connection_paused", at(-40 * DAY), "expired");

  console.log("\n-- health --");
  const h1 = await runTenantJob({ businessId: B.id }, () => intakeHealthCounts(B.id, at()));
  ok("health: only the 3 dead letters are reported (never the 4 expired)", h1.deadLettersNew === 3, JSON.stringify(h1));
  ok("health: only the 3 dead letters count as open", h1.deadLettersOpen === 3, JSON.stringify(h1));
  const expiredStamped = Number((await o.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "IntakeEvent" WHERE "businessId" = $1 AND "lastErrorCode" LIKE 'expired:%' AND ("metadata" -> 'deadLetterReportedAt') IS NOT NULL`, B.id))[0].n);
  ok("health: an expired receipt is never stamped as reported", expiredStamped === 0, String(expiredStamped));

  console.log("\n-- backlog (owner + capacity read) --");
  const b1 = await runWithTenantContext({ businessId: B.id }, () => intakeBacklog(B.id, at()));
  ok("backlog: 3 dead letters, 1 held — the expired 4 are not counted", b1.totals.deadLetters === 3 && b1.totals.held === 1, JSON.stringify(b1.totals));
  const conns = await runWithTenantContext({ businessId: B.id }, () => listConnections());
  const items = translateIntakeAttention({ connections: conns, backlog: b1 }, at());
  const failed = items.find((i) => i.entityRef.type === "intake_failed");
  const said = `${failed?.title ?? ""} ${failed?.summary ?? ""}`;
  ok("owner: \"could not be taken in\" counts 3, never 7", !!failed && said.includes("3 פניות") && !said.includes("7"), said);

  console.log("\n-- retention --");
  const purged = await runTenantJob({ businessId: B.id }, () => purgeExpiredFailedPayloads(B.id, at()));
  const expiredKept = Number((await o.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "IntakeEvent" WHERE "businessId" = $1 AND "lastErrorCode" LIKE 'expired:%' AND "payloadPurgedAt" IS NULL AND "payload" IS NOT NULL`, B.id))[0].n);
  ok(`retention: the 3 dead-letter payloads are purged (${purged}), the 4 expired payloads are kept`, purged === 3 && expiredKept === 4, JSON.stringify({ purged, expiredKept }));

  console.log("\n-- a real expiry through the processor and the sweep --");
  const web = intakeRegistry.list().find((a) => a.sourceKey === "web.form")!;
  const expiring = new IntakeRegistry();
  expiring.register({
    ...web,
    listTenants: async () => [B.id],
    hydrate: async () => { throw new IntakeTerminalError("expired:connection_paused"); },
  });
  await o.intakeEvent.update({ where: { id: t.id }, data: { nextAttemptAt: at(-1000) } });
  const tally = await runTenantJob({ businessId: B.id }, () => drainIntake(expiring, B.id, { now: at() }));
  const row = await o.intakeEvent.findUniqueOrThrow({ where: { id: t.id } });
  ok("processor: the expiry is tallied \"expired\", not \"failed\"", tally.expired === 1 && tally.failed === 0, JSON.stringify(tally));
  ok("…settled terminally, payload kept", row.status === "FAILED" && row.nextAttemptAt === null && row.lastErrorCode === "expired:connection_paused" && row.payload !== null);
  const report = await runIntakeSweep({ now: at(1000), reconcileCommerce: false, syncRevenueSources: false, registry: expiring });
  ok("sweep: healthy — no failed receipt, no new dead letter, nothing open", sweepHealth(report).ok && report.events.failed === 0 && report.backlog.deadLettersNew === 0, JSON.stringify({ health: sweepHealth(report), events: report.events, backlog: report.backlog }));

  console.log("\n-- RLS --");
  const peek = await runWithTenantContext({ businessId: Y.id }, () => intakeBacklog(B.id, at()));
  ok("RLS: business Y's tenant reads nothing of B", peek.totals.held + peek.totals.deadLetters + peek.totals.due + peek.totals.retrying === 0, JSON.stringify(peek.totals));

  console.log(`\nL1.5-b expired battery: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log("FAILED:\n - " + failures.join("\n - ")); process.exitCode = 1; }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await o.$disconnect(); });
