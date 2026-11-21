/**
 * Run: npx tsx lib/services/feature-access/owner-gated-features.test.ts   (from the repo root)
 *
 * The owner gate on the platform-admin feature override path — pure (no database, no network):
 *   G1 the list is exactly { service_desk, activity_packs } (adding or removing a key changes this test — a visible,
 *      reviewed change);
 *   G2 service_desk: only DISABLED and INHERIT pass; ENABLED and every unknown value are refused (fail closed);
 *   G3 every other catalog feature is untouched by the gate, whatever the state;
 *   G4 the real write service refuses service_desk ENABLED with 403 FEATURE_OWNER_GATED before any database work
 *      (no database is configured here; a request that passes the gate reaches the control-plane layer instead);
 *   G5 the gate runs before the reason check and before the control-plane transaction (static order);
 *   G6 authorization first: an unauthenticated PATCH learns nothing about the gate (401);
 *   G7 the owner's pilot (2026-11-20): service_desk ENABLED passes for business 9 ONLY — every other id (neighbours, a
 *      business created later, non-integers, strings, a missing id) is refused; closing / clearing stays open for every
 *      business, the pilot included; no other feature gains a pilot; the real service lets 9 through to the database
 *      layer and refuses any other business before it.
 *   G8 activity_packs (phase 2): gated with NO pilot — ENABLED is refused for every business, business 9 included;
 *      closing / clearing stays open for every business.
 */
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";

import { PLATFORM_FEATURE_CATALOG, PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";
import {
  FEATURE_OWNER_GATED,
  OWNER_GATED_FEATURES,
  OWNER_PILOT_BUSINESSES,
  isOwnerGatedFeature,
  isOwnerPilotBusiness,
  refusedByOwnerGate,
} from "@/lib/services/feature-access/owner-gated-features";

process.env.PLATFORM_ADMIN_EMAILS = process.env.PLATFORM_ADMIN_EMAILS || "admin@lab.invalid";
process.env.AUTH_TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET || "owner_gate_synthetic_secret_0123456789";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`OK: ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL: ${name}${detail ? " — " + detail : ""}`);
  }
}

const SD = PLATFORM_FEATURE_KEYS.SERVICE_DESK;
const AP = PLATFORM_FEATURE_KEYS.ACTIVITY_PACKS;

async function main() {
  // G1
  ok("G1 the gated list is exactly { service_desk, activity_packs }", JSON.stringify([...OWNER_GATED_FEATURES]) === JSON.stringify(["service_desk", "activity_packs"]) && SD === "service_desk" && AP === "activity_packs");
  ok("G1 the refusal code is FEATURE_OWNER_GATED", FEATURE_OWNER_GATED === "FEATURE_OWNER_GATED");

  // G2
  ok("G2 service_desk DISABLED passes the gate", !refusedByOwnerGate(SD, "DISABLED"));
  ok("G2 service_desk INHERIT passes the gate", !refusedByOwnerGate(SD, "INHERIT"));
  for (const v of ["ENABLED", "enabled", "Enabled", "ENABLED ", "", null, undefined, 1, true, {}, ["ENABLED"], "ON", "GLOBAL"]) {
    ok(`G2 service_desk ${JSON.stringify(v) ?? "undefined"} is refused`, refusedByOwnerGate(SD, v));
  }

  // G3
  const others = PLATFORM_FEATURE_CATALOG.map((e) => e.key).filter((k) => k !== SD && k !== AP);
  ok("G3 the catalog has other features to compare with", others.length > 5, String(others.length));
  ok("G3 no other feature is gated, for any state", others.every((k) => !isOwnerGatedFeature(k) && ["ENABLED", "DISABLED", "INHERIT", "x"].every((s) => !refusedByOwnerGate(k, s))));
  ok("G3 an unknown feature key is not gated (it is refused as unknown elsewhere)", !isOwnerGatedFeature("not_a_feature"));

  // G7 — the pilot, pure
  ok("G7 the pilot list is exactly { service_desk: [9] }",
    JSON.stringify([...OWNER_PILOT_BUSINESSES].map(([k, v]) => [k, [...v]])) === JSON.stringify([["service_desk", [9]]]));
  ok("G7 every pilot feature is a gated feature", [...OWNER_PILOT_BUSINESSES.keys()].every((k) => isOwnerGatedFeature(k)));
  ok("G7 service_desk ENABLED for business 9 passes", !refusedByOwnerGate(SD, "ENABLED", 9) && isOwnerPilotBusiness(SD, 9));
  for (const id of [8, 10, 1, 0, -9, 19, 90, 99, 109, 900, 10_000, 2_147_483_647, Number.MAX_SAFE_INTEGER]) {
    ok(`G7 service_desk ENABLED for business ${id} is refused`, refusedByOwnerGate(SD, "ENABLED", id) && !isOwnerPilotBusiness(SD, id));
  }
  for (const id of ["9", " 9", "09", 9.0000001, 8.9999999, 9.5, Number.NaN, Infinity, -Infinity, null, undefined, true, {}, [9], { id: 9 }, BigInt(9)]) {
    const label = typeof id === "bigint" ? "9n" : JSON.stringify(id) ?? String(id);
    ok(`G7 service_desk ENABLED with business id ${label} (${typeof id}) is refused`, refusedByOwnerGate(SD, "ENABLED", id));
  }
  ok("G7 without a business id ENABLED is refused (the old two-argument call stays closed)", refusedByOwnerGate(SD, "ENABLED"));
  for (const v of ["enabled", "Enabled", "ENABLED ", "", null, undefined, 1, true, "ON", "GLOBAL"]) {
    ok(`G7 business 9 with state ${JSON.stringify(v) ?? "undefined"} is refused`, refusedByOwnerGate(SD, v, 9));
  }
  for (const id of [9, 8, 10, 10_000]) {
    ok(`G7 business ${id}: DISABLED and INHERIT pass (instant switch-off stays open)`, !refusedByOwnerGate(SD, "DISABLED", id) && !refusedByOwnerGate(SD, "INHERIT", id));
  }
  ok("G7 no other feature gains a pilot: business 9 is not a pilot of any other key",
    PLATFORM_FEATURE_CATALOG.map((e) => e.key).filter((k) => k !== SD).every((k) => !isOwnerPilotBusiness(k, 9)) && !isOwnerPilotBusiness("not_a_feature", 9));
  ok("G7 other features stay ungated for business 9 and for others", others.every((k) => [9, 8].every((id) => !refusedByOwnerGate(k, "ENABLED", id))));

  // G8 — activity_packs: gated, no pilot (nobody can be switched on through the admin path until the owner names one)
  ok("G8 activity_packs is gated", isOwnerGatedFeature(AP));
  ok("G8 activity_packs has no pilot business", !OWNER_PILOT_BUSINESSES.has(AP));
  for (const id of [9, 1, 8, 10, 1000]) {
    ok(`G8 activity_packs ENABLED for business ${id} is refused`, refusedByOwnerGate(AP, "ENABLED", id) && !isOwnerPilotBusiness(AP, id));
    ok(`G8 business ${id}: activity_packs DISABLED and INHERIT pass`, !refusedByOwnerGate(AP, "DISABLED", id) && !refusedByOwnerGate(AP, "INHERIT", id));
  }
  ok("G8 activity_packs ENABLED without a business id is refused", refusedByOwnerGate(AP, "ENABLED"));

  // G4 — the real service, no database configured
  const saved = { db: process.env.DATABASE_URL, direct: process.env.DIRECT_URL, cp: process.env.CONTROL_PLANE_DATABASE_URL };
  delete process.env.DATABASE_URL;
  delete process.env.DIRECT_URL;
  delete process.env.CONTROL_PLANE_DATABASE_URL;
  const { updateBusinessFeatureAccess } = await import("@/lib/services/platform-admin/update-business-feature-access.service");
  // Business 8 by default: NOT a pilot business. Business 9 is asked for explicitly (G7).
  const attempt = async (featureKey: string, state: string, reason = "owner gate test reason", businessId = 8) => {
    try {
      await updateBusinessFeatureAccess({ actorUserId: 1, businessId, featureKey, state: state as never, reason });
      return { code: "RESOLVED", status: 0 };
    } catch (e) {
      const err = e as { code?: string; statusCode?: number; name?: string };
      return { code: err.code ?? err.name ?? "unknown", status: err.statusCode ?? 0 };
    }
  };
  const origErr = console.error;
  const origWarn = console.warn;
  console.error = () => {};
  console.warn = () => {};
  try {
    const en = await attempt(SD, "ENABLED");
    ok("G4 service_desk ENABLED → 403 FEATURE_OWNER_GATED", en.code === FEATURE_OWNER_GATED && en.status === 403, JSON.stringify(en));
    const bogus = await attempt(SD, "SOMETHING");
    ok("G4 service_desk with an unknown state → FEATURE_OWNER_GATED (refused before the state check)", bogus.code === FEATURE_OWNER_GATED, JSON.stringify(bogus));
    const shortReason = await attempt(SD, "ENABLED", "x");
    ok("G4 service_desk ENABLED with an invalid reason is still refused by the gate first", shortReason.code === FEATURE_OWNER_GATED, JSON.stringify(shortReason));
    const dis = await attempt(SD, "DISABLED");
    ok("G4 service_desk DISABLED passes the gate (reaches the control-plane layer)", dis.code !== FEATURE_OWNER_GATED && dis.status !== 403, JSON.stringify(dis));
    const inh = await attempt(SD, "INHERIT");
    ok("G4 service_desk INHERIT passes the gate", inh.code !== FEATURE_OWNER_GATED && inh.status !== 403, JSON.stringify(inh));
    const other = await attempt(PLATFORM_FEATURE_KEYS.DOCUMENTS ?? others[0], "ENABLED");
    ok("G4 another feature ENABLED passes the gate", other.code !== FEATURE_OWNER_GATED && other.status !== 403, JSON.stringify(other));
    const unknown = await attempt("not_a_feature", "ENABLED");
    ok("G4 an unknown feature is still 404 (the gate changes nothing there)", unknown.status === 404, JSON.stringify(unknown));

    // G7 — the real service: business 9 passes the gate (reaches the control-plane layer), others are refused first
    const pilot = await attempt(SD, "ENABLED", "owner pilot test reason", 9);
    ok("G7 service_desk ENABLED for business 9 passes the gate (reaches the control-plane layer)", pilot.code !== FEATURE_OWNER_GATED && pilot.status !== 403, JSON.stringify(pilot));
    for (const id of [1, 8, 10, 19, 90, 99, 109, 10_000, 2_147_483_647]) {
      const r = await attempt(SD, "ENABLED", "owner pilot test reason", id);
      ok(`G7 service_desk ENABLED for business ${id} → 403 FEATURE_OWNER_GATED`, r.code === FEATURE_OWNER_GATED && r.status === 403, JSON.stringify(r));
    }
    const pilotBogus = await attempt(SD, "SOMETHING", "owner pilot test reason", 9);
    ok("G7 business 9 with an unknown state is still refused by the gate", pilotBogus.code === FEATURE_OWNER_GATED, JSON.stringify(pilotBogus));
    const pilotOff = await attempt(SD, "DISABLED", "owner pilot test reason", 9);
    ok("G7 business 9 can be switched off (DISABLED passes the gate)", pilotOff.code !== FEATURE_OWNER_GATED && pilotOff.status !== 403, JSON.stringify(pilotOff));
    const pilotClear = await attempt(SD, "INHERIT", "owner pilot test reason", 9);
    ok("G7 business 9 can be cleared (INHERIT passes the gate)", pilotClear.code !== FEATURE_OWNER_GATED && pilotClear.status !== 403, JSON.stringify(pilotClear));
  } finally {
    console.error = origErr;
    console.warn = origWarn;
    for (const [k, v] of [["DATABASE_URL", saved.db], ["DIRECT_URL", saved.direct], ["CONTROL_PLANE_DATABASE_URL", saved.cp]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }

  // G5 — static order inside the service
  const src = fs.readFileSync(path.join(process.cwd(), "lib/services/platform-admin/update-business-feature-access.service.ts"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  const iGate = src.indexOf("refusedByOwnerGate(featureKey, input.state, input.businessId)");
  const iState = src.indexOf('throw new ValidationError("Invalid state")');
  const iReason = src.indexOf("validateReason(input.reason)");
  const iTx = src.indexOf("withControlPlaneTransaction(input.businessId");
  ok("G5 the gate runs before the state check, the reason check and the control-plane transaction", iGate > 0 && iGate < iState && iGate < iReason && iGate < iTx, `${iGate} ${iState} ${iReason} ${iTx}`);

  // G6 — authorization first
  const route = await import("@/app/api/platform-admin/businesses/[id]/features/[featureKey]/route");
  process.env.FEATURE_ACCESS_MUTATIONS_ENABLED = "true";
  const res = await route.PATCH(
    new NextRequest("http://localhost/api/platform-admin/businesses/9/features/service_desk", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "ENABLED", reason: "owner gate test reason" }),
    }),
    { params: Promise.resolve({ id: "9", featureKey: SD }) }
  );
  delete process.env.FEATURE_ACCESS_MUTATIONS_ENABLED;
  const body = JSON.stringify(await res.json());
  ok("G6 an unauthenticated PATCH of service_desk ENABLED → 401, nothing about the gate", res.status === 401 && !body.includes(FEATURE_OWNER_GATED), `${res.status} ${body}`);

  console.log(`\nowner-gated-features: ${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
