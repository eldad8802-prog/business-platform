/**
 * Route-level check of GET /api/taxes/oauth/connect for the production pilot.
 * Run manually:
 *   npx tsx lib/services/billing/authority/billing-authority-oauth-connect-route.verify.test.ts
 *
 * Pure: the authenticated user and the OAuth start are doubles; no DB, no
 * network (DATABASE_URL points at a closed loopback port).
 *
 * Proves: an AUTHENTICATED user (never a 401) asking for PRODUCTION gets
 * 403 { error: "forbidden", reason: "PRODUCTION_PILOT_NOT_ENABLED" } unless both
 * the business and the user are pilot-admitted — the same reason whichever
 * list failed — and gets the JSON authorize URL when both are; SANDBOX (the
 * default) is unaffected with both lists unset.
 */
process.env.DATABASE_URL = "postgresql://pilot-test@127.0.0.1:1/none";
process.env.BILLING_AUTHORITY_OAUTH_REDIRECT_BASE_URL = "https://app.invalid";

import { NextRequest } from "next/server";
import { UserRole } from "@prisma/client";
import {
  handleAuthorityConnect,
  type AuthorityConnectDeps,
} from "@/app/api/taxes/oauth/connect/route";
import {
  AUTHORITY_PRODUCTION_PILOT_ENV_VAR,
  AUTHORITY_PRODUCTION_PILOT_USER_ENV_VAR,
} from "@/lib/services/billing/authority/billing-authority-production-pilot";
import type { startAuthorityOAuth } from "@/lib/services/billing/authority/billing-authority-oauth-start.service";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`OK: ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL: ${name}`, extra ?? "");
  }
}

const PILOT = 42;
const PILOT_USER = 7;

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

let startCalls = 0;
const startOAuth = (async () => {
  startCalls += 1;
  return { authorizationUrl: "https://example.invalid/authorize?state=s", state: "s", cookies: [] };
}) as unknown as typeof startAuthorityOAuth;

function deps(userId: number, businessId = PILOT): AuthorityConnectDeps {
  return {
    getCurrentUser: async () => ({ id: userId, businessId, role: UserRole.USER }),
    hasAdminElevation: () => false,
    start: { startOAuth },
  };
}

function request(query: string): NextRequest {
  return new NextRequest(`https://app.invalid/api/taxes/oauth/connect${query}`, {
    headers: { accept: "application/json", "x-authority-connect-mode": "json", authorization: "Bearer test" },
  });
}

async function call(query: string, d: AuthorityConnectDeps) {
  const res = await handleAuthorityConnect(request(query), d);
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

const pilotRefusal = (r: { status: number; body: Record<string, unknown> }) =>
  r.status === 403 && r.body.error === "forbidden" && r.body.reason === "PRODUCTION_PILOT_NOT_ENABLED";

async function main() {
  try {
    setEnv(AUTHORITY_PRODUCTION_PILOT_ENV_VAR, String(PILOT));
    setEnv(AUTHORITY_PRODUCTION_PILOT_USER_ENV_VAR, undefined);
    let r = await call("?environment=PRODUCTION", deps(PILOT_USER));
    ok("authenticated, pilot business, user list unset → 403 PRODUCTION_PILOT_NOT_ENABLED (not 401)",
      pilotRefusal(r) && startCalls === 0, r);

    setEnv(AUTHORITY_PRODUCTION_PILOT_USER_ENV_VAR, "8");
    r = await call("?environment=PRODUCTION", deps(PILOT_USER));
    ok("authenticated, pilot business, non-pilot user → same 403 reason", pilotRefusal(r) && startCalls === 0, r);

    setEnv(AUTHORITY_PRODUCTION_PILOT_USER_ENV_VAR, String(PILOT_USER));
    r = await call("?environment=PRODUCTION", deps(PILOT_USER, 43));
    ok("authenticated, pilot user, non-pilot business → same 403 reason", pilotRefusal(r) && startCalls === 0, r);

    r = await call("?environment=PRODUCTION", deps(PILOT_USER));
    ok("business AND user admitted → 200 with the JSON authorize URL",
      r.status === 200 && typeof r.body.authorizeUrl === "string" && startCalls === 1, r);

    setEnv(AUTHORITY_PRODUCTION_PILOT_ENV_VAR, undefined);
    setEnv(AUTHORITY_PRODUCTION_PILOT_USER_ENV_VAR, undefined);
    r = await call("", deps(PILOT_USER, 43));
    ok("SANDBOX default with both lists unset → 200, unaffected",
      r.status === 200 && typeof r.body.authorizeUrl === "string" && startCalls === 2, r);

    const anon: AuthorityConnectDeps = { ...deps(PILOT_USER), getCurrentUser: async () => null };
    r = await call("?environment=PRODUCTION", anon);
    ok("unauthenticated → 401 (distinct from the pilot 403)", r.status === 401 && startCalls === 2, r);
  } finally {
    setEnv(AUTHORITY_PRODUCTION_PILOT_ENV_VAR, undefined);
    setEnv(AUTHORITY_PRODUCTION_PILOT_USER_ENV_VAR, undefined);
  }

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
