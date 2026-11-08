/**
 * Leads L1.5-b · PR-3 — the owner's intake status on PostgreSQL with Production's RLS and a NOBYPASSRLS runtime (same
 * lab as the M6 battery); synthetic data only. Drives the REAL business-status snapshot and the REAL connections API.
 *
 *   - feature OFF (the default): no intake item in the snapshot, no `waiting` in the connections API
 *   - feature ON for business A only: paused / Dubiz hold / not included / failed items with the right counts, the
 *     connections API carries per-connection `waiting`; business B (feature on, nothing waiting) sees nothing; B never
 *     sees A's numbers; a held enquiry never appears as a Lead
 *   - payload privacy: no name / phone / message of a held enquiry anywhere in the snapshot or the API answer
 */
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { signAuthToken } from "../lib/auth-token";
import { runWithTenantContext } from "../lib/tenant/context";
import { bindMetaPage, createKeyedConnection, setPaused } from "../lib/intake/acquisition/connection.service";
import { getBusinessStatusSnapshot } from "../lib/business-status/business-status.service";
import { clearIntakeAttentionCache } from "../lib/business-status/intake-attention";
import { GET as ownerGET } from "../app/api/integrations/acquisition/route";
import { POST as webPOST } from "../app/api/intake/acquisition/web/[publicId]/route";

const RUN = `os-${Date.now()}`;
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
const SECRET_NAME = "Shira Secretname";
const SECRET_PHONE = "054-911-2233";

async function access(businessId: number, featureKey: string, state: "ENABLED" | "DISABLED") {
  await o.businessFeatureAccess.upsert({ where: { businessId_featureKey: { businessId, featureKey } }, create: { businessId, featureKey, state }, update: { state } });
}
function web(publicId: string, key: string, body: Record<string, unknown>) {
  return webPOST(new NextRequest(`http://os.local/api/intake/acquisition/web/${publicId}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "x-forwarded-for": "203.0.113.31" }, body: JSON.stringify(body),
  }), params({ publicId }));
}
async function clone(templateId: number, n: number, ref: string, sourceKey: string, status: "RECEIVED" | "FAILED", next: Date | null, code: string, receivedAt: Date) {
  await o.$executeRawUnsafe(
    `INSERT INTO "IntakeEvent" ("businessId", "sourceKey", "family", "eventType", "dedupeBasis", "externalEventId", "providerAccountRef",
        "receivedAt", "status", "attempts", "nextAttemptAt", "lastErrorCode", "payload", "metadata", "createdAt", "updatedAt")
     SELECT t."businessId", $1, t."family", t."eventType", t."dedupeBasis", 'sha256:' || encode(sha256(convert_to($2 || ':' || g, 'UTF8')), 'hex'), $3,
            ($4::timestamptz AT TIME ZONE 'UTC'), $5::"IntakeEventStatus", 0, ($6::timestamptz AT TIME ZONE 'UTC'), $7, t."payload", t."metadata", now(), now()
       FROM "IntakeEvent" t, generate_series(1, $8::int) g WHERE t."id" = $9`,
    sourceKey, `${RUN}:${ref}:${code}`, ref, receivedAt.toISOString(), status, next ? next.toISOString() : null, code, n, templateId
  );
}
const snapshot = async (businessId: number) => {
  clearIntakeAttentionCache();
  return runWithTenantContext({ businessId }, () => getBusinessStatusSnapshot(businessId));
};
const list = async (userId: number) =>
  (await (await ownerGET(new NextRequest("http://os.local/api/integrations/acquisition", { headers: { authorization: `Bearer ${signAuthToken(userId)}` } }))).json()) as {
    connections: { id: number; waiting?: { held: number; paused: number; platform: number; notIncluded: number; failed: number } | null }[];
  };

async function main() {
  const A = await o.business.create({ data: { name: `${RUN}-A` } });
  const B = await o.business.create({ data: { name: `${RUN}-B` } });
  const userA = await o.user.create({ data: { email: `${RUN}-a@lab.test`, password: "x", businessId: A.id, role: "USER" } });
  const userB = await o.user.create({ data: { email: `${RUN}-b@lab.test`, password: "x", businessId: B.id, role: "USER" } });
  for (const b of [A.id, B.id]) for (const f of ["acquisition_web_forms", "acquisition_google_lead_forms", "acquisition_meta_lead_ads"]) await access(b, f, "ENABLED");
  const mk = (businessId: number, sourceKey: "web.form" | "google.lead_form") =>
    runWithTenantContext({ businessId }, () => createKeyedConnection({ businessId, userId: null, sourceKey, allowedOrigins: [] }));
  const webA = await mk(A.id, "web.form");
  const gA = await mk(A.id, "google.lead_form");
  const pageA = `77${String(Date.now()).slice(-9)}`;
  const metaA = await runWithTenantContext({ businessId: A.id }, () => bindMetaPage({ businessId: A.id, userId: null, pageId: pageA, pageName: "A Page", pageAccessToken: "PAGE-TOKEN-A" }));
  const webB = await mk(B.id, "web.form");
  await runWithTenantContext({ businessId: A.id }, () => setPaused(webA.connection.id, true));
  await web(webA.connection.publicId, webA.key, { submission_id: `${RUN}-t`, name: SECRET_NAME, phone: SECRET_PHONE, message: "private message text" });
  const t = await o.intakeEvent.findFirstOrThrow({ where: { businessId: A.id } });
  // A: 12 held (paused, 8 days), 5 held by the Dubiz switch on the Page, 3 held "not included" on Google, 2 failed on Google.
  await o.intakeEvent.update({ where: { id: t.id }, data: { receivedAt: at(-8 * 24 * 60 * MIN), nextAttemptAt: at(9 * MIN) } });
  await clone(t.id, 11, webA.connection.publicId, "web.form", "RECEIVED", at(9 * MIN), "held:connection_paused", at(-60 * MIN));
  await clone(t.id, 5, pageA, "meta.lead_ads", "RECEIVED", at(9 * MIN), "held:emergency_disabled", at(-60 * MIN));
  await clone(t.id, 3, gA.connection.publicId, "google.lead_form", "RECEIVED", at(9 * MIN), "held:source_disabled", at(-60 * MIN));
  await clone(t.id, 2, gA.connection.publicId, "google.lead_form", "FAILED", null, "error:Error", at(-2 * 24 * 60 * MIN));

  console.log("\n-- feature OFF (the default) --");
  const offA = await snapshot(A.id);
  ok("OFF: no intake item in A's business status", !offA.items.some((i) => i.itemId.startsWith("leads:intake_")));
  const offList = await list(userA.id);
  ok("OFF: the connections API carries no `waiting`", offList.connections.every((c) => !("waiting" in c)));

  console.log("\n-- feature ON for A and B --");
  // Lab only: the feature definition row a release migration would add (definitions only come from migrations; with
  // no row the resolver falls back to the catalog default — OFF). Production gets it only through an approved migration.
  await o.$executeRawUnsafe(`INSERT INTO "PlatformFeatureDefinition" ("key", "displayName", "category", "description", "defaultEnabled", "mutable", "createdAt")
    VALUES ('intake_status_visibility', 'מצב קליטת פניות', 'integrations', 'lab', false, true, CURRENT_TIMESTAMP) ON CONFLICT ("key") DO NOTHING`);
  await access(A.id, "intake_status_visibility", "ENABLED");
  await access(B.id, "intake_status_visibility", "ENABLED");
  const onA = await snapshot(A.id);
  const it = (id: string) => onA.items.find((i) => i.itemId === id);
  const paused = it(`leads:intake_paused:${webA.connection.id}`);
  ok("ON: paused → 'יש 12 פניות שממתינות לחידוש החיבור', at risk (HIGH, 8 days), opens the connections screen",
    paused?.title === "יש 12 פניות שממתינות לחידוש החיבור" && paused.severity === "HIGH" && paused.primaryAction.href === "/settings/connections", JSON.stringify(paused));
  ok("ON: the Dubiz switch on the Page → 5 waiting, nothing to do (WARNING)",
    it(`leads:intake_platform_hold:${metaA.id}`)?.title === "5 פניות מ־Meta (פייסבוק ואינסטגרם) · A Page נשמרות וממתינות" && it(`leads:intake_platform_hold:${metaA.id}`)?.semanticCategory === "WARNING",
    JSON.stringify(it(`leads:intake_platform_hold:${metaA.id}`)));
  ok("ON: Google not in the plan → 3 waiting; and 2 that could not be taken in (FAILURE_EVENT)",
    /^יש 3 פניות שממתינות מ־Google Ads/.test(it(`leads:intake_not_included:${gA.connection.id}`)?.title ?? "")
      && it(`leads:intake_failed:${gA.connection.id}`)?.semanticCategory === "FAILURE_EVENT"
      && /^2 פניות מ־Google Ads לא נקלטו/.test(it(`leads:intake_failed:${gA.connection.id}`)?.summary ?? ""));
  const blob = JSON.stringify(onA);
  ok("privacy: no name, phone or message of a held enquiry in the snapshot", !blob.includes("Secretname") && !blob.includes("911") && !blob.includes("private message"));
  ok("a held enquiry is never a Lead", (await o.lead.count({ where: { businessId: A.id } })) === 0);
  const onList = await list(userA.id);
  const w = (id: number) => onList.connections.find((c) => c.id === id)?.waiting;
  ok("ON: the connections API — web 12 paused, Page 5 by Dubiz, Google 3 not included + 2 failed",
    w(webA.connection.id)?.paused === 12 && w(metaA.id)?.platform === 5 && w(gA.connection.id)?.notIncluded === 3 && w(gA.connection.id)?.failed === 2,
    JSON.stringify(onList.connections.map((c) => [c.id, c.waiting])));
  ok("privacy: the connections API answer carries no enquiry content", !JSON.stringify(onList).includes("Secretname") && !JSON.stringify(onList).includes("private message"));

  console.log("\n-- isolation --");
  const onB = await snapshot(B.id);
  ok("B (feature on, nothing waiting) sees no intake item", !onB.items.some((i) => i.itemId.startsWith("leads:intake_")));
  const listB = await list(userB.id);
  ok("B's connections API shows only B's connection, with nothing waiting", listB.connections.length === 1 && listB.connections[0].id === webB.connection.id && !listB.connections[0].waiting);

  console.log(`\nL1.5-b owner status battery: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log("FAILED:\n - " + failures.join("\n - ")); process.exitCode = 1; }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await o.$disconnect(); });
