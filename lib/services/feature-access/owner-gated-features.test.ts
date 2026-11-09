/**
 * Run: npx tsx lib/services/feature-access/owner-gated-features.test.ts   (from the repo root)
 *
 * The owner gate on the platform-admin feature override path — pure (no database, no network):
 *   G1 the list is exactly { service_desk } (adding or removing a key changes this test — a visible, reviewed change);
 *   G2 service_desk: only DISABLED and INHERIT pass; ENABLED and every unknown value are refused (fail closed);
 *   G3 every other catalog feature is untouched by the gate, whatever the state;
 *   G4 the real write service refuses service_desk ENABLED with 403 FEATURE_OWNER_GATED before any database work
 *      (no database is configured here; a request that passes the gate reaches the control-plane layer instead);
 *   G5 the gate runs before the reason check and before the control-plane transaction (static order);
 *   G6 authorization first: an unauthenticated PATCH learns nothing about the gate (401).
 */
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";

import { PLATFORM_FEATURE_CATALOG, PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";
import {
  FEATURE_OWNER_GATED,
  OWNER_GATED_FEATURES,
  isOwnerGatedFeature,
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

async function main() {
  // G1
  ok("G1 the gated list is exactly { service_desk }", JSON.stringify([...OWNER_GATED_FEATURES]) === JSON.stringify(["service_desk"]) && SD === "service_desk");
  ok("G1 the refusal code is FEATURE_OWNER_GATED", FEATURE_OWNER_GATED === "FEATURE_OWNER_GATED");

  // G2
  ok("G2 service_desk DISABLED passes the gate", !refusedByOwnerGate(SD, "DISABLED"));
  ok("G2 service_desk INHERIT passes the gate", !refusedByOwnerGate(SD, "INHERIT"));
  for (const v of ["ENABLED", "enabled", "Enabled", "ENABLED ", "", null, undefined, 1, true, {}, ["ENABLED"], "ON", "GLOBAL"]) {
    ok(`G2 service_desk ${JSON.stringify(v) ?? "undefined"} is refused`, refusedByOwnerGate(SD, v));
  }

  // G3
  const others = PLATFORM_FEATURE_CATALOG.map((e) => e.key).filter((k) => k !== SD);
  ok("G3 the catalog has other features to compare with", others.length > 5, String(others.length));
  ok("G3 no other feature is gated, for any state", others.every((k) => !isOwnerGatedFeature(k) && ["ENABLED", "DISABLED", "INHERIT", "x"].every((s) => !refusedByOwnerGate(k, s))));
  ok("G3 an unknown feature key is not gated (it is refused as unknown elsewhere)", !isOwnerGatedFeature("not_a_feature"));

  // G4 — the real service, no database configured
  const saved = { db: process.env.DATABASE_URL, direct: process.env.DIRECT_URL, cp: process.env.CONTROL_PLANE_DATABASE_URL };
  delete process.env.DATABASE_URL;
  delete process.env.DIRECT_URL;
  delete process.env.CONTROL_PLANE_DATABASE_URL;
  const { updateBusinessFeatureAccess } = await import("@/lib/services/platform-admin/update-business-feature-access.service");
  const attempt = async (featureKey: string, state: string, reason = "owner gate test reason") => {
    try {
      await updateBusinessFeatureAccess({ actorUserId: 1, businessId: 9, featureKey, state: state as never, reason });
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
  } finally {
    console.error = origErr;
    console.warn = origWarn;
    for (const [k, v] of [["DATABASE_URL", saved.db], ["DIRECT_URL", saved.direct], ["CONTROL_PLANE_DATABASE_URL", saved.cp]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }

  // G5 — static order inside the service
  const src = fs.readFileSync(path.join(process.cwd(), "lib/services/platform-admin/update-business-feature-access.service.ts"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  const iGate = src.indexOf("refusedByOwnerGate(featureKey, input.state)");
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
