/**
 * Production pilot gate SELF-CHECK (report + platform-admin route). Run manually:
 *   npx tsx lib/services/billing/authority/billing-authority-pilot-gate.verify.test.ts
 *
 * Pure: injected env + authorize double. No DB (DATABASE_URL points at a
 * closed loopback port), no network, no ITA.
 *
 * Proves: with OPERATIONS="oauth" and both lists admitting the ids, OAuth start
 * and code exchange are allowed and refresh/validation/Approval/Decision/probe
 * are refused with the STAGE reason; non-admitted ids are refused with the
 * LIST reason; "oauth,submissions" allows all; unset runtime env and an unset
 * or invalid stage value are reported, not crashed on; raw env values are
 * never echoed; the route is admin-guarded, validates its input, and no-store.
 */
process.env.DATABASE_URL = "postgresql://pilot-test@127.0.0.1:1/none";

import { NextRequest, NextResponse } from "next/server";
import { UserRole } from "@prisma/client";
import {
  AUTHORITY_PRODUCTION_PILOT_ENV_VAR,
  AUTHORITY_PRODUCTION_PILOT_NOT_ENABLED,
  AUTHORITY_PRODUCTION_PILOT_OPERATIONS_ENV_VAR,
  AUTHORITY_PRODUCTION_PILOT_STAGE_OAUTH_ONLY,
  AUTHORITY_PRODUCTION_PILOT_USER_ENV_VAR,
} from "@/lib/services/billing/authority/billing-authority-production-pilot";
import {
  buildAuthorityPilotGateReport,
  type AuthorityPilotGateOperation,
  type AuthorityPilotGateReport,
} from "@/lib/services/billing/authority/billing-authority-pilot-gate-report";
import { handleAuthorityPilotGate } from "@/app/api/platform-admin/authority/pilot-gate/route";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`OK: ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL: ${name}`, extra ?? "");
  }
}

const B = 42;
const U = 7;
const OAUTH_OPS: AuthorityPilotGateOperation[] = ["oauthStart", "oauthCodeExchange"];
const OTHER_OPS: AuthorityPilotGateOperation[] = ["refresh", "validation", "approval", "decision", "probe"];

const base = {
  BILLING_AUTHORITY_RUNTIME_ENVIRONMENT: "PRODUCTION",
  [AUTHORITY_PRODUCTION_PILOT_ENV_VAR]: "42,57",
  [AUTHORITY_PRODUCTION_PILOT_USER_ENV_VAR]: "7",
};

const allowed = (r: AuthorityPilotGateReport, ops: AuthorityPilotGateOperation[]) =>
  ops.every((op) => r.operations[op].status === "allowed");
const refusedWith = (r: AuthorityPilotGateReport, ops: AuthorityPilotGateOperation[], reason: string) =>
  ops.every((op) => {
    const d = r.operations[op];
    return d.status === "refused" && d.reason === reason;
  });

function report(): void {
  // Explicit OAuth-only stage, both ids admitted.
  const oauth = buildAuthorityPilotGateReport({ businessId: B, userId: U }, { ...base, [AUTHORITY_PRODUCTION_PILOT_OPERATIONS_ENV_VAR]: "oauth" });
  ok("oauth: stage OAUTH_ONLY, value explicit", oauth.stage.stage === "OAUTH_ONLY" && oauth.stage.valueStatus === "explicit", oauth.stage);
  ok("oauth: business + user admitted", oauth.businessAdmitted && oauth.userAdmitted);
  ok("oauth: OAuth start + code exchange allowed", allowed(oauth, OAUTH_OPS), oauth.operations);
  ok("oauth: refresh/validation/approval/decision/probe refused with the STAGE reason",
    refusedWith(oauth, OTHER_OPS, AUTHORITY_PRODUCTION_PILOT_STAGE_OAUTH_ONLY), oauth.operations);
  ok("oauth: lists reported as status + count",
    oauth.lists.business.status === "ok" && oauth.lists.business.count === 2 &&
    oauth.lists.user.status === "ok" && oauth.lists.user.count === 1);
  ok("oauth: runtime environment reported (name + parsed value)",
    oauth.runtimeEnvironment.name === "BILLING_AUTHORITY_RUNTIME_ENVIRONMENT" &&
    oauth.runtimeEnvironment.status === "ok" && oauth.runtimeEnvironment.value === "PRODUCTION");

  // Non-admitted ids → LIST reason everywhere (lists are checked first).
  const otherUser = buildAuthorityPilotGateReport({ businessId: B, userId: 8 }, { ...base, [AUTHORITY_PRODUCTION_PILOT_OPERATIONS_ENV_VAR]: "oauth" });
  ok("non-admitted user: OAuth start + exchange refused with the LIST reason",
    !otherUser.userAdmitted && refusedWith(otherUser, OAUTH_OPS, AUTHORITY_PRODUCTION_PILOT_NOT_ENABLED), otherUser.operations);
  ok("non-admitted user: business operations keep the STAGE reason (user list is not consulted there)",
    refusedWith(otherUser, OTHER_OPS, AUTHORITY_PRODUCTION_PILOT_STAGE_OAUTH_ONLY), otherUser.operations);
  const otherBiz = buildAuthorityPilotGateReport({ businessId: 43, userId: U }, { ...base, [AUTHORITY_PRODUCTION_PILOT_OPERATIONS_ENV_VAR]: "oauth" });
  ok("non-admitted business: every business operation refused with the LIST reason",
    !otherBiz.businessAdmitted &&
    refusedWith(otherBiz, [...OAUTH_OPS, "refresh", "validation", "approval", "decision"], AUTHORITY_PRODUCTION_PILOT_NOT_ENABLED),
    otherBiz.operations);

  // Full pilot.
  const full = buildAuthorityPilotGateReport({ businessId: B, userId: U }, { ...base, [AUTHORITY_PRODUCTION_PILOT_OPERATIONS_ENV_VAR]: "oauth,submissions" });
  ok("oauth,submissions: SUBMISSIONS explicit, every operation allowed",
    full.stage.stage === "SUBMISSIONS" && full.stage.valueStatus === "explicit" && allowed(full, [...OAUTH_OPS, ...OTHER_OPS]), full.operations);

  // Unset / invalid stage values and runtime env; lists unset / invalid.
  const unset = buildAuthorityPilotGateReport({ businessId: B, userId: U }, {});
  ok("nothing set: runtime env reported unset (no crash)",
    unset.runtimeEnvironment.status === "unset" && unset.runtimeEnvironment.value === null);
  ok("nothing set: stage OAUTH_ONLY, value unset", unset.stage.stage === "OAUTH_ONLY" && unset.stage.valueStatus === "unset");
  ok("nothing set: lists unset, count 0, everything refused with the LIST reason",
    unset.lists.business.status === "unset" && unset.lists.user.count === 0 &&
    refusedWith(unset, [...OAUTH_OPS, ...OTHER_OPS], AUTHORITY_PRODUCTION_PILOT_NOT_ENABLED), unset.operations);

  const invalid = buildAuthorityPilotGateReport({ businessId: B, userId: U }, {
    BILLING_AUTHORITY_RUNTIME_ENVIRONMENT: "staging",
    [AUTHORITY_PRODUCTION_PILOT_ENV_VAR]: "42,x",
    [AUTHORITY_PRODUCTION_PILOT_USER_ENV_VAR]: "7",
    [AUTHORITY_PRODUCTION_PILOT_OPERATIONS_ENV_VAR]: "OAUTH,SUBMISSIONS",
  });
  ok("invalid values classified: runtime invalid, business list invalid (count 0), stage OAUTH_ONLY invalid",
    invalid.runtimeEnvironment.status === "invalid" && invalid.lists.business.status === "invalid" &&
    invalid.lists.business.count === 0 && invalid.stage.stage === "OAUTH_ONLY" && invalid.stage.valueStatus === "invalid");
  for (const v of [" oauth", "oauth ", "OAUTH", "submissions", "oauth,submissions ", "   "]) {
    const r = buildAuthorityPilotGateReport({ businessId: B, userId: U }, { ...base, [AUTHORITY_PRODUCTION_PILOT_OPERATIONS_ENV_VAR]: v });
    ok(`stage value "${v}" → OAUTH_ONLY, invalid; business operations refused (STAGE)`,
      r.stage.stage === "OAUTH_ONLY" && r.stage.valueStatus === "invalid" &&
      refusedWith(r, OTHER_OPS, AUTHORITY_PRODUCTION_PILOT_STAGE_OAUTH_ONLY));
  }

  const serialized = JSON.stringify(invalid) + JSON.stringify(oauth);
  ok("raw env values never echoed", !serialized.includes("42,57") && !serialized.includes("42,x") &&
    !serialized.includes("OAUTH,SUBMISSIONS") && !serialized.includes("staging"));
}

async function route(): Promise<void> {
  const admin = async () => ({ id: 1, email: "admin@example.invalid", name: null, role: UserRole.PLATFORM_ADMIN });
  const env = { ...base, [AUTHORITY_PRODUCTION_PILOT_OPERATIONS_ENV_VAR]: "oauth" };
  const req = (q: string) => new NextRequest(`https://app.invalid/api/platform-admin/authority/pilot-gate${q}`);

  let computed = false;
  const denied = await handleAuthorityPilotGate(req("?businessId=42&userId=7"), {
    authorize: async () => NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    env: new Proxy(env, { get: (t, k) => { computed = true; return (t as Record<string | symbol, unknown>)[k]; } }) as typeof env,
  });
  ok("non-admin → guard response (403), nothing computed", denied.status === 403 && !computed);

  const res = await handleAuthorityPilotGate(req("?businessId=42&userId=7"), { authorize: admin, env });
  const body = (await res.json()) as AuthorityPilotGateReport;
  ok("admin → 200 no-store", res.status === 200 && res.headers.get("cache-control") === "no-store");
  ok("admin → report reflects the env (OAuth allowed, rest STAGE-refused)",
    allowed(body, OAUTH_OPS) && refusedWith(body, OTHER_OPS, AUTHORITY_PRODUCTION_PILOT_STAGE_OAUTH_ONLY), body.operations);

  for (const q of ["", "?businessId=42", "?businessId=0&userId=7", "?businessId=abc&userId=7", "?businessId=42&userId=-1"]) {
    const bad = await handleAuthorityPilotGate(req(q), { authorize: admin, env });
    ok(`invalid input "${q}" → 400 no-store`, bad.status === 400 && bad.headers.get("cache-control") === "no-store");
  }

  const bare = await handleAuthorityPilotGate(req("?businessId=42&userId=7"), { authorize: admin, env: {} });
  const bareBody = (await bare.json()) as AuthorityPilotGateReport;
  ok("unset runtime env → 200 with runtimeEnvironment unset (no crash)",
    bare.status === 200 && bareBody.runtimeEnvironment.status === "unset");
}

async function main() {
  report();
  await route();
  if (failed > 0) {
    console.error(`\n${failed} FAILED`);
    process.exit(1);
  }
  console.log("\nALL PASS");
}

main().catch((e) => {
  console.error("UNCAUGHT", e);
  process.exit(1);
});
