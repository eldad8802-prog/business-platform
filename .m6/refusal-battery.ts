/**
 * Leads L1.5-b · B1 — why a source is refused, on PostgreSQL with Production's RLS and a NOBYPASSRLS runtime (same lab
 * as the M6 battery); synthetic data only. Classification only — every refusal still records nothing.
 *
 *   - the seven intake sources × every state: granted / no grant / DISABLED "plan:excluded" / DISABLED other reason /
 *     DISABLED empty reason / the emergency switch / a business being erased → the gate's answer and its refusal
 *   - two routes end to end (web form, Google) with a real connection whose source left the plan: the SAME answer as
 *     today (web 404, Google 200) and nothing recorded
 *   - RLS: each business is classified from its own override only
 */
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { runWithTenantContext } from "../lib/tenant/context";
import { createKeyedConnection } from "../lib/intake/acquisition/connection.service";
import { CONNECTION_SOURCE_KEYS, SOURCE_FEATURE, sourceGate, type ConnectionSourceKey } from "../lib/intake/acquisition/gate";
import { POST as webPOST } from "../app/api/intake/acquisition/web/[publicId]/route";
import { POST as googlePOST } from "../app/api/intake/acquisition/google/[publicId]/route";

const RUN = `rf-${Date.now()}`;
let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
const o = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const SEVEN = CONNECTION_SOURCE_KEYS.filter((s) => s !== "pos.rivhit") as ConnectionSourceKey[];

type State = { label: string; state?: "ENABLED" | "DISABLED"; reason?: string | null; expect: string };
const STATES: State[] = [
  { label: "granted", state: "ENABLED", expect: "ok" },
  { label: "no grant", expect: "source_disabled:not_entitled" },
  { label: "DISABLED plan:excluded", state: "DISABLED", reason: "plan:excluded downgraded", expect: "source_disabled:plan_excluded" },
  { label: "DISABLED block:abuse", state: "DISABLED", reason: "block:abuse", expect: "source_disabled:blocked" },
  { label: "DISABLED free text", state: "DISABLED", reason: "the source left the plan", expect: "source_disabled:blocked" },
  { label: "DISABLED no reason", state: "DISABLED", reason: null, expect: "source_disabled:blocked" },
];
const said = (g: Awaited<ReturnType<typeof sourceGate>>) =>
  g.ok ? "ok" : g.reason === "source_disabled" ? `${g.reason}:${g.refusal}${g.holdable ? ":holdable" : ""}` : g.reason;

async function business(label: string) {
  return o.business.create({ data: { name: `${RUN}-${label}` } });
}
async function override(businessId: number, featureKey: string, state: "ENABLED" | "DISABLED", reason: string | null) {
  await o.businessFeatureAccess.upsert({
    where: { businessId_featureKey: { businessId, featureKey } },
    create: { businessId, featureKey, state, reason }, update: { state, reason },
  });
}

async function main() {
  console.log("\n-- the seven sources × every state --");
  for (const st of STATES) {
    const B = await business(st.label.replace(/\W+/g, "-"));
    if (st.state) for (const s of SEVEN) await override(B.id, SOURCE_FEATURE[s], st.state, st.reason ?? null);
    const got = await Promise.all(SEVEN.map(async (s) => [s, said(await sourceGate(B.id, s))] as const));
    const wrong = got.filter(([, g]) => g !== st.expect);
    ok(`${st.label}: all seven → ${st.expect}`, wrong.length === 0, JSON.stringify(wrong));
  }

  console.log("\n-- the emergency switch wins (and stays holdable); a business being erased is refused first --");
  const saved = await o.platformFeaturePolicy.findMany({ where: { featureKey: { in: SEVEN.map((s) => SOURCE_FEATURE[s]) } } });
  const E = await business("emergency");
  for (const s of SEVEN) await override(E.id, SOURCE_FEATURE[s], "DISABLED", "plan:excluded");
  try {
    for (const s of SEVEN) {
      await o.platformFeaturePolicy.upsert({ where: { featureKey: SOURCE_FEATURE[s] }, create: { featureKey: SOURCE_FEATURE[s], globalEnabled: false, emergencyDisabled: true }, update: { emergencyDisabled: true } });
    }
    const got = await Promise.all(SEVEN.map(async (s) => said(await sourceGate(E.id, s))));
    ok("emergency + DISABLED plan:excluded: all seven → emergency, holdable", got.every((g) => g === "source_disabled:emergency:holdable"), JSON.stringify(got));
  } finally {
    for (const s of SEVEN) {
      const prev = saved.find((p) => p.featureKey === SOURCE_FEATURE[s]);
      if (prev) await o.platformFeaturePolicy.update({ where: { featureKey: prev.featureKey }, data: { emergencyDisabled: prev.emergencyDisabled, globalEnabled: prev.globalEnabled } });
      else await o.platformFeaturePolicy.deleteMany({ where: { featureKey: SOURCE_FEATURE[s] } });
    }
  }
  const Q = await business("erased");
  for (const s of SEVEN) await override(Q.id, SOURCE_FEATURE[s], "DISABLED", "plan:excluded");
  await o.business.update({ where: { id: Q.id }, data: { deletionRequestedAt: new Date() } });
  const q = await Promise.all(SEVEN.map(async (s) => said(await sourceGate(Q.id, s))));
  ok("a business being erased (even with plan:excluded): all seven → business_inactive", q.every((g) => g === "business_inactive"), JSON.stringify(q));

  console.log("\n-- end to end: a real connection whose source left the plan → the same answer as today, nothing recorded --");
  const P = await business("plan-left");
  await override(P.id, "acquisition_web_forms", "ENABLED", null);
  await override(P.id, "acquisition_google_lead_forms", "ENABLED", null);
  const w = await runWithTenantContext({ businessId: P.id }, () => createKeyedConnection({ businessId: P.id, userId: null, sourceKey: "web.form", allowedOrigins: [] }));
  const g = await runWithTenantContext({ businessId: P.id }, () => createKeyedConnection({ businessId: P.id, userId: null, sourceKey: "google.lead_form", allowedOrigins: [] }));
  await override(P.id, "acquisition_web_forms", "DISABLED", "plan:excluded");
  await override(P.id, "acquisition_google_lead_forms", "DISABLED", "plan:excluded");
  const webRes = await webPOST(new NextRequest(`http://rf.local/api/intake/acquisition/web/${w.connection.publicId}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${w.key}`, "x-forwarded-for": "203.0.113.91" },
    body: JSON.stringify({ submission_id: `${RUN}-w`, name: "Plan Left", phone: "054-600-9101" }),
  }), { params: Promise.resolve({ publicId: w.connection.publicId }) });
  const googleRes = await googlePOST(new NextRequest(`http://rf.local/api/intake/acquisition/google/${g.connection.publicId}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ lead_id: `${RUN}-g`, google_key: g.key, user_column_data: [{ column_id: "FULL_NAME", string_value: "Plan Left" }, { column_id: "PHONE_NUMBER", string_value: "+972546009102" }] }),
  }), { params: Promise.resolve({ publicId: g.connection.publicId }) });
  const recorded = await o.intakeEvent.count({ where: { businessId: P.id } });
  ok(`web form: 404 as today (${webRes.status})`, webRes.status === 404);
  ok(`Google: 200 as today (${googleRes.status})`, googleRes.status === 200);
  ok("nothing recorded for either (B1 changes no outcome)", recorded === 0, String(recorded));

  console.log("\n-- RLS: each business from its own override --");
  const X = await business("x");
  const Y = await business("y");
  await override(X.id, "acquisition_web_forms", "DISABLED", "plan:excluded");
  await override(Y.id, "acquisition_web_forms", "DISABLED", "block:abuse");
  const [gx, gy] = [said(await sourceGate(X.id, "web.form")), said(await sourceGate(Y.id, "web.form"))];
  ok("X → plan_excluded, Y → blocked (never the other's reason)", gx === "source_disabled:plan_excluded" && gy === "source_disabled:blocked", JSON.stringify({ gx, gy }));

  console.log(`\nL1.5-b refusal battery: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log("FAILED:\n - " + failures.join("\n - ")); process.exitCode = 1; }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await o.$disconnect(); });
