/**
 * Unit tests for AuthorityAccessTokenProvider (run manually):
 *   npx tsx lib/services/billing/authority/billing-authority-approval-token.provider.test.ts
 *
 * Fully injected: no DB, no network, no real crypto. Deterministic clock.
 */
import { BillingAuthorityConnectionStatus, BillingAuthorityEnvironment } from "@prisma/client";
import { BillingAuthorityTokenCryptoConfigError } from "@/lib/services/billing/authority/billing-authority-token-crypto.service";
import type { RefreshAuthorityConnectionTokenResult } from "@/lib/services/billing/authority/billing-authority-token-refresh.service";
import {
  resolveAccessToken,
  type AccessTokenProviderDeps,
  type TokenConnectionRow,
} from "@/lib/services/billing/authority/billing-authority-approval-token.provider";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else { failed += 1; console.error(`FAIL: ${name}`, extra ?? ""); }
}

const ENV = BillingAuthorityEnvironment.SANDBOX;
const NOW = new Date("2026-06-15T10:00:00.000Z");

function conn(over: Partial<TokenConnectionRow> = {}): TokenConnectionRow {
  return {
    id: 5,
    status: BillingAuthorityConnectionStatus.CONNECTED,
    accessTokenEncrypted: "enc",
    accessTokenIv: "iv",
    accessTokenTag: "tag",
    accessTokenExpiresAt: null,
    ...over,
  };
}

const refreshedOk: RefreshAuthorityConnectionTokenResult = { ok: true, refreshed: true, refreshTimestamp: new Date(0), outcome: "REFRESHED" };
const refreshAuth: RefreshAuthorityConnectionTokenResult = { ok: false, refreshed: false, refreshTimestamp: new Date(0), outcome: "AUTH_FAILURE", errorCode: "ITA_REFRESH_REJECTED" };
const refreshNet: RefreshAuthorityConnectionTokenResult = { ok: false, refreshed: false, refreshTimestamp: new Date(0), outcome: "NETWORK_FAILURE", errorCode: "ITA_UPSTREAM_ERROR" };

type Spies = { load: number; decrypt: number; refresh: number; lastEnv: BillingAuthorityEnvironment | null };
type Opts = {
  row?: TokenConnectionRow | null;
  refresh?: () => Promise<RefreshAuthorityConnectionTokenResult>;
  decrypt?: () => string | null;
};
function makeDeps(opts: Opts = {}): { deps: AccessTokenProviderDeps; spies: Spies } {
  const spies: Spies = { load: 0, decrypt: 0, refresh: 0, lastEnv: null };
  const row = opts.row === undefined ? conn() : opts.row;
  const deps: AccessTokenProviderDeps = {
    loadConnection: async (_businessId, environment) => { spies.load += 1; spies.lastEnv = environment; return row; },
    decrypt: opts.decrypt ? (() => { spies.decrypt += 1; return opts.decrypt!(); }) : (() => { spies.decrypt += 1; return "PLAINTEXT_TOKEN"; }),
    refresh: opts.refresh ? (async () => { spies.refresh += 1; return opts.refresh!(); }) : (async () => { spies.refresh += 1; return refreshedOk; }),
    now: () => NOW,
    refreshSkewMs: 60_000,
  };
  return { deps, spies };
}

async function main(): Promise<void> {
  {
    const { deps } = makeDeps({ row: null });
    const r = await resolveAccessToken({ businessId: 3, environment: ENV }, deps);
    ok("no connection → CONNECTION_NOT_FOUND", !r.ok && r.code === "CONNECTION_NOT_FOUND");
  }
  {
    const { deps } = makeDeps({ row: conn({ status: BillingAuthorityConnectionStatus.DISCONNECTED }) });
    const r = await resolveAccessToken({ businessId: 3, environment: ENV }, deps);
    ok("bad status → CONNECTION_NOT_USABLE", !r.ok && r.code === "CONNECTION_NOT_USABLE");
  }
  {
    const { deps } = makeDeps({ row: conn({ accessTokenEncrypted: null }) });
    const r = await resolveAccessToken({ businessId: 3, environment: ENV }, deps);
    ok("no token → TOKEN_MISSING", !r.ok && r.code === "TOKEN_MISSING");
  }
  {
    const { deps, spies } = makeDeps({ row: conn({ accessTokenExpiresAt: new Date("2027-01-01T00:00:00Z") }) });
    const r = await resolveAccessToken({ businessId: 3, environment: ENV }, deps);
    ok("valid token → ok, no refresh", r.ok && r.accessToken === "PLAINTEXT_TOKEN" && r.connectionId === 5 && spies.refresh === 0);
  }
  {
    const { deps, spies } = makeDeps({ row: conn({ accessTokenExpiresAt: null }) });
    const r = await resolveAccessToken({ businessId: 3, environment: ENV }, deps);
    ok("no expiry → ok, no refresh", r.ok && spies.refresh === 0);
  }
  {
    const { deps, spies } = makeDeps({ row: conn({ accessTokenExpiresAt: new Date(NOW.getTime() + 30_000) }) });
    const r = await resolveAccessToken({ businessId: 3, environment: ENV }, deps);
    ok("expiring → single refresh + reload", r.ok && spies.refresh === 1 && spies.load === 2);
  }
  {
    const { deps, spies } = makeDeps({ row: conn({ accessTokenExpiresAt: new Date(NOW.getTime() - 1000) }) });
    const r = await resolveAccessToken({ businessId: 3, environment: ENV }, deps);
    ok("expired → refresh", r.ok && spies.refresh === 1);
  }
  {
    const { deps, spies } = makeDeps({ row: conn({ accessTokenExpiresAt: new Date("2027-01-01T00:00:00Z") }) });
    const r = await resolveAccessToken({ businessId: 3, environment: ENV, forceRefresh: true }, deps);
    ok("forceRefresh → single refresh + reload", r.ok && spies.refresh === 1 && spies.load === 2);
  }
  {
    const { deps, spies } = makeDeps({ row: conn({ accessTokenExpiresAt: new Date(NOW.getTime() - 1000) }), refresh: () => Promise.resolve(refreshNet) });
    const r = await resolveAccessToken({ businessId: 3, environment: ENV }, deps);
    ok("refresh network fail → TOKEN_REFRESH_FAILED", !r.ok && r.code === "TOKEN_REFRESH_FAILED");
    ok("no fallback: decrypt not called after refresh fail", spies.decrypt === 0);
  }
  {
    const { deps } = makeDeps({ row: conn({ accessTokenExpiresAt: new Date(NOW.getTime() - 1000) }), refresh: () => Promise.resolve(refreshAuth) });
    const r = await resolveAccessToken({ businessId: 3, environment: ENV }, deps);
    ok("refresh auth fail → AUTHENTICATION", !r.ok && r.code === "AUTHENTICATION");
  }
  {
    const { deps } = makeDeps({ decrypt: () => null });
    const r = await resolveAccessToken({ businessId: 3, environment: ENV }, deps);
    ok("decrypt null → DECRYPTION_FAILED", !r.ok && r.code === "DECRYPTION_FAILED");
  }
  {
    const { deps } = makeDeps({ decrypt: () => { throw new BillingAuthorityTokenCryptoConfigError("Missing key"); } });
    const r = await resolveAccessToken({ businessId: 3, environment: ENV }, deps);
    ok("key missing → ENCRYPTION_KEY_MISSING", !r.ok && r.code === "ENCRYPTION_KEY_MISSING");
  }
  {
    const { deps, spies } = makeDeps({ row: conn({ accessTokenExpiresAt: new Date(NOW.getTime() - 1000) }) });
    await resolveAccessToken({ businessId: 3, environment: ENV, forceRefresh: true }, deps);
    ok("no double refresh in one call", spies.refresh === 1);
  }
  {
    const { deps, spies } = makeDeps();
    await resolveAccessToken({ businessId: 3, environment: BillingAuthorityEnvironment.PRODUCTION }, deps);
    ok("environment passed to loader (isolation)", spies.lastEnv === BillingAuthorityEnvironment.PRODUCTION);
  }
  {
    const { deps } = makeDeps();
    const r = await resolveAccessToken({ businessId: 3, environment: ENV }, deps);
    ok("success output keys are exactly the contract", r.ok && JSON.stringify(Object.keys(r).sort()) === JSON.stringify(["accessToken", "accessTokenExpiresAt", "connectionId", "ok"]));
  }
}

main()
  .then(() => { if (failed > 0) { console.error(`\n${failed} test(s) failed.`); process.exit(1); } console.log("\nAll access token provider tests passed."); })
  .catch((e) => { console.error(e); process.exit(1); });
