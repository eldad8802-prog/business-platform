/**
 * Leads L1.5-b · PR-4 — owner intake notifications on PostgreSQL with Production's RLS and a NOBYPASSRLS runtime (same
 * lab as the M6 battery); synthetic data only. Drives the REAL sweep → owner translator → policy → notification writer.
 *
 *   - feature ON: paused enquiries / not taken in / a connection to check become in-app notifications; a Dubiz hold
 *     does not; no push delivery is ever written
 *   - no duplicates: a second sweep and two racing sweeps leave one row per fact, within its cooldown
 *   - resume + release: the paused notification is resolved and a recovery notification appears
 *   - feature OFF: nothing is written; another business never sees these rows (RLS)
 */
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { runWithTenantContext } from "../lib/tenant/context";
import { withTenantTransaction } from "../lib/tenant/transaction";
import { bindMetaPage, createKeyedConnection, setPaused } from "../lib/intake/acquisition/connection.service";
import { runIntakeSweep } from "../lib/intake/intake-sweeper";
import { POST as webPOST } from "../app/api/intake/acquisition/web/[publicId]/route";

const RUN = `in-${Date.now()}`;
const MIN = 60_000;
let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
const o = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const params = <T extends object>(p: T) => ({ params: Promise.resolve(p) });
const at = (ms = 0) => new Date(Date.now() + ms);
const sweep = (now: Date) => runIntakeSweep({ now, reconcileCommerce: false, syncRevenueSources: false });

async function access(businessId: number, featureKey: string, state: "ENABLED" | "DISABLED") {
  await o.businessFeatureAccess.upsert({ where: { businessId_featureKey: { businessId, featureKey } }, create: { businessId, featureKey, state }, update: { state } });
}
function web(publicId: string, key: string, body: Record<string, unknown>) {
  return webPOST(new NextRequest(`http://in.local/api/intake/acquisition/web/${publicId}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "x-forwarded-for": "203.0.113.41" }, body: JSON.stringify(body),
  }), params({ publicId }));
}
async function clone(templateId: number, n: number, ref: string, sourceKey: string, status: "RECEIVED" | "FAILED", next: Date | null, code: string, receivedAt: Date) {
  await o.$executeRawUnsafe(
    `INSERT INTO "IntakeEvent" ("businessId", "sourceKey", "family", "eventType", "dedupeBasis", "externalEventId", "providerAccountRef",
        "receivedAt", "status", "attempts", "nextAttemptAt", "lastErrorCode", "payload", "metadata", "createdAt", "updatedAt")
     SELECT t."businessId", $1, t."family", t."eventType", t."dedupeBasis", 'sha256:' || encode(sha256(convert_to($2 || ':' || g, 'UTF8')), 'hex'), $3,
            ($4::timestamptz AT TIME ZONE 'UTC') + (g * interval '1 millisecond'), $5::"IntakeEventStatus", 0, ($6::timestamptz AT TIME ZONE 'UTC'), $7, t."payload", t."metadata", now(), now()
       FROM "IntakeEvent" t, generate_series(1, $8::int) g WHERE t."id" = $9`,
    sourceKey, `${RUN}:${ref}:${code}`, ref, receivedAt.toISOString(), status, next ? next.toISOString() : null, code, n, templateId
  );
}
const notes = (businessId: number) => o.notification.findMany({ where: { businessId, domain: "leads" }, orderBy: { id: "asc" } });

async function setupBusiness(label: string, featureOn: boolean) {
  const B = await o.business.create({ data: { name: `${RUN}-${label}` } });
  for (const f of ["acquisition_web_forms", "acquisition_google_lead_forms", "acquisition_meta_lead_ads"]) await access(B.id, f, "ENABLED");
  if (featureOn) await access(B.id, "intake_status_visibility", "ENABLED");
  const mk = (sourceKey: "web.form" | "google.lead_form") => runWithTenantContext({ businessId: B.id }, () => createKeyedConnection({ businessId: B.id, userId: null, sourceKey, allowedOrigins: [] }));
  const w = await mk("web.form");
  const g = await mk("google.lead_form");
  const page = `88${String(Date.now()).slice(-9)}${label.length}`;
  const meta = await runWithTenantContext({ businessId: B.id }, () => bindMetaPage({ businessId: B.id, userId: null, pageId: page, pageName: "N Page", pageAccessToken: "PAGE-TOKEN-N" }));
  await runWithTenantContext({ businessId: B.id }, () => setPaused(w.connection.id, true));
  await web(w.connection.publicId, w.key, { submission_id: `${RUN}-${label}-t`, name: "Notify", phone: "054-600-7001" });
  const t = await o.intakeEvent.findFirstOrThrow({ where: { businessId: B.id } });
  await o.intakeEvent.update({ where: { id: t.id }, data: { receivedAt: at(-8 * 24 * 60 * MIN), nextAttemptAt: at(9 * MIN) } });
  await clone(t.id, 19, w.connection.publicId, "web.form", "RECEIVED", at(9 * MIN), "held:connection_paused", at(-2 * 24 * 60 * MIN));
  await clone(t.id, 2, g.connection.publicId, "google.lead_form", "FAILED", null, "error:Error", at(-24 * 60 * MIN));
  await clone(t.id, 4, page, "meta.lead_ads", "RECEIVED", at(9 * MIN), "held:emergency_disabled", at(-60 * MIN));
  await o.acquisitionConnection.update({ where: { id: g.connection.id }, data: { status: "ERROR" } });
  return { B, w, g, meta };
}

async function main() {
  // Lab only: the definition row a release migration would add (see owner-status-battery.ts).
  await o.$executeRawUnsafe(`INSERT INTO "PlatformFeatureDefinition" ("key", "displayName", "category", "description", "defaultEnabled", "mutable", "createdAt")
    VALUES ('intake_status_visibility', 'מצב קליטת פניות', 'integrations', 'lab', false, true, CURRENT_TIMESTAMP) ON CONFLICT ("key") DO NOTHING`);
  const on = await setupBusiness("on", true);
  const off = await setupBusiness("off", false);

  console.log("\n-- the first sweep --");
  await sweep(at());
  const n1 = await notes(on.B.id);
  const kinds = n1.map((r) => r.entityType).sort();
  ok("feature ON: paused enquiries, enquiries not taken in, a connection to check → three notifications",
    JSON.stringify(kinds) === JSON.stringify(["intake_check_connection", "intake_failed", "intake_paused"]), JSON.stringify(kinds));
  ok("a Dubiz hold notifies nothing (home only)", !n1.some((r) => r.entityType === "intake_platform_hold"));
  ok("in-app only: every row intends IN_APP alone, and no push delivery exists",
    n1.every((r) => r.intendedChannels.length === 1 && r.intendedChannels[0] === "IN_APP")
      && (await o.notificationDelivery.count({ where: { businessId: on.B.id, channel: "PUSH" } })) === 0);
  ok("no enquiry content in any notification", !JSON.stringify(n1).includes("Notify") && !JSON.stringify(n1).includes("600-7001"));
  ok("feature OFF: nothing is written", (await notes(off.B.id)).length === 0);

  console.log("\n-- no duplicates --");
  const before = n1.map((r) => [r.id, r.lastNotifiedAt?.toISOString()]);
  await sweep(at(MIN));
  await Promise.all([sweep(at(2 * MIN)), sweep(at(2 * MIN))]);
  const n2 = await notes(on.B.id);
  ok("a second sweep and two racing sweeps → still one row per fact, not re-notified inside the cooldown",
    n2.length === 3 && JSON.stringify(n2.map((r) => [r.id, r.lastNotifiedAt?.toISOString()])) === JSON.stringify(before), JSON.stringify(n2.map((r) => [r.entityType, r.lastNotifiedAt])));

  console.log("\n-- resume, release, recovery --");
  await runWithTenantContext({ businessId: on.B.id }, () => setPaused(on.w.connection.id, false));
  await o.intakeEvent.updateMany({ where: { businessId: on.B.id, sourceKey: "meta.lead_ads" }, data: { status: "IGNORED", nextAttemptAt: null } }); // the Page's hold is not this test
  for (let i = 0; i < 4; i++) await sweep(at(3 * MIN + i * 1000));
  const held = await o.intakeEvent.count({ where: { businessId: on.B.id, sourceKey: "web.form", status: { in: ["RECEIVED", "PERSISTED"] } } });
  const n3 = await notes(on.B.id);
  const paused = n3.find((r) => r.entityType === "intake_paused");
  const recovered = n3.find((r) => r.entityType === "intake_recovered");
  ok(`released (still waiting: ${held}) → the paused notification is resolved`, held === 0 && !!paused?.resolvedAt, JSON.stringify({ held, resolvedAt: paused?.resolvedAt }));
  ok("…and a recovery writes no notification (silent until a rule for it is approved; the policy is unchanged)", !recovered, JSON.stringify(recovered));
  ok("the failure and the connection to check stay open (still true)",
    !n3.find((r) => r.entityType === "intake_failed")?.resolvedAt && !n3.find((r) => r.entityType === "intake_check_connection")?.resolvedAt);

  console.log("\n-- isolation --");
  ok("notifications belong to their business only", (await o.notification.count({ where: { businessId: off.B.id } })) === 0 && n3.every((r) => r.businessId === on.B.id));
  // Through the NOBYPASSRLS runtime: from the other business's tenant, these rows do not exist; from their own, they do.
  const peek = (tenant: number) => runWithTenantContext({ businessId: tenant }, () =>
    withTenantTransaction((tx) => tx.notification.count({ where: { businessId: on.B.id, domain: "leads" } })));
  const [foreign, own] = [await peek(off.B.id), await peek(on.B.id)];
  ok("RLS: another business's tenant reads none of these notifications (runtime role)", foreign === 0 && own === n3.length, JSON.stringify({ foreign, own }));

  console.log(`\nL1.5-b intake notifications battery: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log("FAILED:\n - " + failures.join("\n - ")); process.exitCode = 1; }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await o.$disconnect(); });
