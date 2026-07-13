/**
 * Unit tests for AuthorityApprovalRuntimeContextProvider (run manually):
 *   npx tsx lib/services/billing/authority/billing-authority-approval-runtime-context.provider.test.ts
 *
 * Fully injected composition: config/app/token are stubbed. No DB/network.
 */
import { BillingAuthorityEnvironment } from "@prisma/client";
import type { AccessTokenProviderDeps } from "@/lib/services/billing/authority/billing-authority-approval-token.provider";
import {
  resolveApprovalRuntimeContext,
  type RuntimeContextProviderDeps,
} from "@/lib/services/billing/authority/billing-authority-approval-runtime-context.provider";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else { failed += 1; console.error(`FAIL: ${name}`, extra ?? ""); }
}

const ENV = BillingAuthorityEnvironment.SANDBOX;
const CONFIG = { apiBaseUrl: "https://t-ita-api.taxes.gov.il/shaam/tsandbox", apiVersion: "v2", timeoutMs: 15000 };

type Spies = { config: number; app: number; token: number; forceRefreshSeen: boolean | undefined };
function makeDeps(over: Partial<RuntimeContextProviderDeps>, spies: Spies): RuntimeContextProviderDeps {
  return {
    resolveConfig: () => { spies.config += 1; return { ok: true, config: CONFIG }; },
    resolveAccountingSoftwareNumber: async () => { spies.app += 1; return { ok: true, value: "12345678" }; },
    resolveToken: async (input) => { spies.token += 1; spies.forceRefreshSeen = input.forceRefresh; return { ok: true, accessToken: "TOK", connectionId: 5, accessTokenExpiresAt: null }; },
    tokenDeps: {} as unknown as AccessTokenProviderDeps,
    ...over,
  };
}
function spies(): Spies { return { config: 0, app: 0, token: 0, forceRefreshSeen: undefined }; }

async function main(): Promise<void> {
  // Happy path
  {
    const s = spies();
    const r = await resolveApprovalRuntimeContext({ businessId: 3, environment: ENV }, makeDeps({}, s));
    ok("happy → ok", r.ok);
    ok("context fields exact", r.ok && JSON.stringify(Object.keys(r.context).sort()) === JSON.stringify(["accessToken", "accountingSoftwareNumber", "approvalConfig", "connectionId", "environment"]));
    ok("no scope in context", r.ok && !("scope" in (r.context as Record<string, unknown>)) && !("scope" in (r.context.approvalConfig as Record<string, unknown>)));
    ok("values composed", r.ok && r.context.accessToken === "TOK" && r.context.accountingSoftwareNumber === "12345678" && r.context.connectionId === 5 && r.context.environment === ENV);
  }
  // Config fails → app + token NOT called
  {
    const s = spies();
    const deps = makeDeps({ resolveConfig: () => { s.config += 1; return { ok: false, code: "ENVIRONMENT_NOT_CONFIGURED", message: "x" }; } }, s);
    const r = await resolveApprovalRuntimeContext({ businessId: 3, environment: ENV }, deps);
    ok("config fail → error code", !r.ok && r.code === "ENVIRONMENT_NOT_CONFIGURED");
    ok("config fail → app+token not called", s.app === 0 && s.token === 0);
  }
  // App fails → token NOT called
  {
    const s = spies();
    const deps = makeDeps({ resolveAccountingSoftwareNumber: async () => { s.app += 1; return { ok: false, code: "APP_NOT_REGISTERED", message: "x" }; } }, s);
    const r = await resolveApprovalRuntimeContext({ businessId: 3, environment: ENV }, deps);
    ok("app fail → error code", !r.ok && r.code === "APP_NOT_REGISTERED");
    ok("app fail → token not called", s.token === 0);
  }
  // Token fails → mapped
  {
    const s = spies();
    const deps = makeDeps({ resolveToken: async () => { s.token += 1; return { ok: false, code: "AUTHENTICATION", message: "x" }; } }, s);
    const r = await resolveApprovalRuntimeContext({ businessId: 3, environment: ENV }, deps);
    ok("token fail → error code mapped", !r.ok && r.code === "AUTHENTICATION");
  }
  // forceRefresh passthrough
  {
    const s = spies();
    const r = await resolveApprovalRuntimeContext({ businessId: 3, environment: ENV, forceRefresh: true }, makeDeps({}, s));
    ok("forceRefresh passed to token provider", r.ok && s.forceRefreshSeen === true);
  }
  // deterministic composition
  {
    const s1 = spies(); const s2 = spies();
    const r1 = await resolveApprovalRuntimeContext({ businessId: 3, environment: ENV }, makeDeps({}, s1));
    const r2 = await resolveApprovalRuntimeContext({ businessId: 3, environment: ENV }, makeDeps({}, s2));
    ok("deterministic composition", JSON.stringify(r1) === JSON.stringify(r2));
  }
}

main()
  .then(() => { if (failed > 0) { console.error(`\n${failed} test(s) failed.`); process.exit(1); } console.log("\nAll runtime context provider tests passed."); })
  .catch((e) => { console.error(e); process.exit(1); });
