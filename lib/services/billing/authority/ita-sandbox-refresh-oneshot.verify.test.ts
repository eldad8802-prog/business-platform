/**
 * Refresh one-shot verification (run manually, no DB, no network):
 *   npx tsx lib/services/billing/authority/ita-sandbox-refresh-oneshot.verify.test.ts
 *
 *   S  egress allowance scope: refresh refused outside the scope; admitted once
 *      inside; a second refresh in the same scope refused; Approval refused even
 *      inside the scope — all before any transport call
 *   F  fuses (window / ticket / env / gateway / endpoint / connection / status /
 *      refresh token / already-refreshed audit) → no refresh call, no transport
 *   O  outcome classes: REFRESHED, AUTH_REJECTED, NOT_SENT (egress / connect),
 *      UNCERTAIN_SENT (timeout / reset / 5xx), UNCERTAIN_RESPONSE, UNCERTAIN_PERSIST;
 *      one start per instance; the single refresh runs inside the allowance
 *   X  no token or ciphertext in any result
 */

import { createHash } from "node:crypto";
import {
  AUTHORITY_EGRESS_ERROR_CODES,
  AUTHORITY_EGRESS_OAUTH_ONLY_PATH,
  AuthorityEgressError,
  createAuthorityEgressFetch,
  isAuthorityEgressError,
  runWithAuthorityRefreshAllowance,
} from "@/lib/services/billing/authority/billing-authority-egress";
import {
  REFRESH_ONESHOT_BRANCH,
  REFRESH_ONESHOT_NOT_AFTER,
  REFRESH_ONESHOT_NOT_BEFORE,
  REFRESH_ONESHOT_TOKEN_PATH,
  resetRefreshOneshotForTests,
  runSandboxRefreshOneshot,
  type RefreshOneshotDeps,
} from "@/lib/services/billing/authority/ita-sandbox-refresh-oneshot";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else {
    failed += 1;
    console.error(`FAIL: ${name}`, extra ?? "");
  }
}

const TOKEN = `https://openapi.taxes.gov.il${AUTHORITY_EGRESS_OAUTH_ONLY_PATH}`;
const REFRESH_BODY = "grant_type=refresh_token&refresh_token=SECRET-REFRESH";

async function scopeTests() {
  // Config validation runs after the block, so an env without egress material
  // proves admission by failing later with NOT_CONFIGURED (never a socket).
  const f = createAuthorityEgressFetch({ env: { BILLING_AUTHORITY_RUNTIME_ENVIRONMENT: "SANDBOX" } });
  const codeOf = (e: unknown) => (isAuthorityEgressError(e) ? e.code : String(e));
  const call = (url: string, body: string) => f(url, { method: "POST", body }).then(() => "RESOLVED", codeOf);

  ok("S refresh outside the scope → OPERATION_BLOCKED", (await call(TOKEN, REFRESH_BODY)) === AUTHORITY_EGRESS_ERROR_CODES.OPERATION_BLOCKED);
  const inside = await runWithAuthorityRefreshAllowance(async () => [
    await call(TOKEN, REFRESH_BODY),
    await call(TOKEN, REFRESH_BODY),
    await call("https://ita-api.taxes.gov.il/shaam/tsandbox/Invoices/v2/Approval", "{}"),
  ]);
  ok("S first refresh inside the scope passes the block", inside[0] === AUTHORITY_EGRESS_ERROR_CODES.NOT_CONFIGURED, inside[0]);
  ok("S second refresh in the same scope → OPERATION_BLOCKED", inside[1] === AUTHORITY_EGRESS_ERROR_CODES.OPERATION_BLOCKED, inside[1]);
  ok("S Approval inside the scope → OPERATION_BLOCKED", inside[2] === AUTHORITY_EGRESS_ERROR_CODES.OPERATION_BLOCKED, inside[2]);
  ok("S refresh after the scope ended → OPERATION_BLOCKED", (await call(TOKEN, REFRESH_BODY)) === AUTHORITY_EGRESS_ERROR_CODES.OPERATION_BLOCKED);
  const parallel = await Promise.all([
    runWithAuthorityRefreshAllowance(() => call(TOKEN, REFRESH_BODY)),
    call(TOKEN, REFRESH_BODY),
  ]);
  ok("S a refresh outside a concurrently open scope stays blocked", parallel[0] === AUTHORITY_EGRESS_ERROR_CODES.NOT_CONFIGURED && parallel[1] === AUTHORITY_EGRESS_ERROR_CODES.OPERATION_BLOCKED, parallel);
  ok("S authorization_code still passes without a scope", (await call(TOKEN, "grant_type=authorization_code&code=k")) === AUTHORITY_EGRESS_ERROR_CODES.NOT_CONFIGURED);
}

// ── fixtures for the one-shot ──
const TICKET = "c".repeat(63) + "d";
const PIN = {
  ticketSha256: createHash("sha256").update(TICKET).digest("hex"),
  notBefore: new Date(Date.now() - 60_000).toISOString(),
  notAfter: new Date(Date.now() + 3_600_000).toISOString(),
};
const GW = "https://127.0.0.1:44300";
const b64 = (s: string) => Buffer.from(s).toString("base64");
type Conn = NonNullable<Awaited<ReturnType<NonNullable<RefreshOneshotDeps["loadConnection"]>>>>;
const CONN: Conn = {
  id: 2, businessId: 9, environment: "SANDBOX", status: "CONNECTED",
  accessTokenEncrypted: "ACCESS-CT-1", refreshTokenEncrypted: "REFRESH-CT-1", refreshTokenIv: "iv1", refreshTokenTag: "tag1",
  accessTokenExpiresAt: new Date("2026-11-01T04:53:45Z"), refreshTokenExpiresAt: null, lastTokenRefreshAt: null, lastErrorCode: null,
};

function harness(over: Partial<RefreshOneshotDeps> & { afterConn?: Conn | null } = {}) {
  let refreshCalls = 0;
  let transportCalls = 0;
  let current: Conn | null = CONN;
  const harnessTransport = (async () => {
    transportCalls += 1;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const harnessRefresh: NonNullable<RefreshOneshotDeps["refresh"]> = async (input) => {
    refreshCalls += 1;
    await input.fetchImpl!(TOKEN, { method: "POST", body: REFRESH_BODY });
    if (over.afterConn !== undefined) current = over.afterConn;
    return { ok: true, refreshed: true, refreshTimestamp: new Date(), outcome: "REFRESHED" };
  };
  const deps: RefreshOneshotDeps = {
    env: { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: REFRESH_ONESHOT_BRANCH, BILLING_AUTHORITY_RUNTIME_ENVIRONMENT: "SANDBOX" },
    ticket: TICKET,
    pinned: PIN,
    gatewayOrigin: GW,
    buildTokenEndpoint: () => TOKEN,
    loadConnection: async () => current,
    countRefreshAudits: async () => 0,
    latestAuditEventType: async () => "BILLING_AUTHORITY_TOKEN_REFRESHED",
    pingDb: async () => undefined,
    transport: harnessTransport,
    refresh: harnessRefresh,
    ...over,
  };
  // Count every refresh and transport call, including overrides.
  const innerRefresh = deps.refresh!;
  deps.refresh = async (input) => {
    if (innerRefresh !== harnessRefresh) refreshCalls += 1;
    return innerRefresh(input);
  };
  const innerTransport = deps.transport!;
  if (innerTransport !== harnessTransport) {
    deps.transport = (async (u: Parameters<typeof fetch>[0], i?: Parameters<typeof fetch>[1]) => {
      transportCalls += 1;
      return innerTransport(u, i);
    }) as typeof fetch;
  }
  return { deps, counts: () => ({ refreshCalls, transportCalls }) };
}

// Throwaway PKI so the egress config fuse validates; no socket is ever opened.
async function withValidEgress<T>(fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, readFileSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "ita-refresh-oneshot-"));
  const ossl = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  const key = (n: string) => ossl(["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", `${n}.key`]);
  key("ca");
  ossl(["req", "-x509", "-new", "-key", "ca.key", "-subj", "/CN=Test CA", "-days", "30", "-out", "ca.pem", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
  key("client");
  ossl(["req", "-new", "-key", "client.key", "-subj", "/CN=client", "-out", "client.csr"]);
  writeFileSync(join(dir, "client.ext"), "basicConstraints=CA:FALSE\nextendedKeyUsage=clientAuth\n");
  ossl(["x509", "-req", "-in", "client.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "30", "-out", "client.pem", "-extfile", "client.ext"]);
  const pem = (f: string) => readFileSync(join(dir, f), "utf8");
  try {
    return await fn({
      VERCEL_ENV: "preview",
      VERCEL_GIT_COMMIT_REF: REFRESH_ONESHOT_BRANCH,
      BILLING_AUTHORITY_RUNTIME_ENVIRONMENT: "SANDBOX",
      ITA_EGRESS_PROXY_URL_SANDBOX: GW,
      ITA_EGRESS_PROXY_CA_SANDBOX: b64(pem("ca.pem")),
      ITA_EGRESS_CLIENT_CERT_SANDBOX: b64(pem("client.pem")),
      ITA_EGRESS_CLIENT_KEY_SANDBOX: b64(pem("client.key")),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function oneshotTests(env: Record<string, string>) {
  const run = async (name: string, over: Partial<RefreshOneshotDeps> & { afterConn?: Conn | null }, expectFuse: string) => {
    resetRefreshOneshotForTests();
    const h = harness({ env, ...over });
    const r = await runSandboxRefreshOneshot(h.deps);
    ok(`F ${name} → ${expectFuse}`, r.outcome === "REFUSED_BY_FUSE" && r.fuse === expectFuse, r.fuse);
    ok(`F ${name}: no refresh, no transport`, h.counts().refreshCalls === 0 && h.counts().transportCalls === 0);
  };
  // As committed: placeholders → WINDOW_NOT_SET; once pinned at push, a test
  // ticket can never pass (inside the window → TICKET_INVALID, else OUTSIDE_WINDOW).
  const committedFuse = REFRESH_ONESHOT_NOT_BEFORE.startsWith("__")
    ? "WINDOW_NOT_SET"
    : Date.now() >= Date.parse(REFRESH_ONESHOT_NOT_BEFORE) && Date.now() <= Date.parse(REFRESH_ONESHOT_NOT_AFTER)
      ? "TICKET_INVALID"
      : "OUTSIDE_WINDOW";
  await run("pinned constants (as committed)", { pinned: undefined }, committedFuse);
  await run("before window", { now: () => Date.parse(PIN.notBefore) - 1 }, "OUTSIDE_WINDOW");
  await run("no ticket", { ticket: null }, "TICKET_INVALID");
  await run("wrong ticket", { ticket: "e".repeat(64) }, "TICKET_INVALID");
  await run("production deployment", { env: { ...env, VERCEL_ENV: "production" } }, "NOT_PREVIEW");
  await run("wrong branch", { env: { ...env, VERCEL_GIT_COMMIT_REF: "main" } }, "WRONG_BRANCH");
  await run("PRODUCTION runtime", { env: { ...env, BILLING_AUTHORITY_RUNTIME_ENVIRONMENT: "PRODUCTION" } }, "NOT_SANDBOX");
  await run("egress missing", { env: { ...env, ITA_EGRESS_CLIENT_KEY_SANDBOX: "" } }, "EGRESS_CONFIG:ITA_EGRESS_NOT_CONFIGURED");
  await run("gateway mismatch", { gatewayOrigin: "https://91.223.106.183" }, "GATEWAY_MISMATCH");
  await run("production token path", { buildTokenEndpoint: () => "https://openapi.taxes.gov.il/shaam/production/longtimetoken/oauth2/token" }, "TOKEN_ENDPOINT_UNEXPECTED");
  await run("no connection", { loadConnection: async () => null }, "CONNECTION_NOT_FOUND");
  await run("other connection id", { loadConnection: async () => ({ ...CONN, id: 1, businessId: 5 }) }, "CONNECTION_MISMATCH");
  await run("not connected", { loadConnection: async () => ({ ...CONN, status: "AUTHORIZATION_REQUIRED" }) }, "CONNECTION_STATUS:AUTHORIZATION_REQUIRED");
  await run("no refresh token", { loadConnection: async () => ({ ...CONN, refreshTokenEncrypted: null }) }, "NO_REFRESH_TOKEN");
  await run("already refreshed once", { countRefreshAudits: async () => 1 }, "ALREADY_REFRESHED_ONCE");

  const outcome = async (name: string, over: Partial<RefreshOneshotDeps> & { afterConn?: Conn | null }, expect: string) => {
    resetRefreshOneshotForTests();
    const h = harness({ env, ...over });
    const r = await runSandboxRefreshOneshot(h.deps);
    ok(`O ${name} → ${expect}`, r.outcome === expect, { outcome: r.outcome, svc: r.serviceOutcome, chain: r.errorChain });
    ok(`O ${name}: exactly one refresh, at most one transport call`, h.counts().refreshCalls === 1 && h.counts().transportCalls <= 1 && r.transportCalls <= 1);
    ok(`O ${name}: no token or ciphertext in the result`, !/SECRET|ACCESS-CT|REFRESH-CT/.test(JSON.stringify(r)), r);
    return r;
  };
  const rotated: Conn = { ...CONN, accessTokenEncrypted: "ACCESS-CT-2", refreshTokenEncrypted: "REFRESH-CT-2", refreshTokenIv: "iv2", accessTokenExpiresAt: new Date("2026-11-01T09:00:00Z"), lastTokenRefreshAt: new Date() };
  const r1 = await outcome("refreshed with rotation", { afterConn: rotated }, "REFRESHED");
  ok("O refreshed: accessTokenChanged + refreshTokenRotated + new expiry reported", r1.accessTokenChanged === true && r1.refreshTokenRotated === true && r1.after?.accessTokenExpiresAt === "2026-11-01T09:00:00.000Z");
  const r2 = await outcome("refreshed without rotation", { afterConn: { ...rotated, refreshTokenEncrypted: CONN.refreshTokenEncrypted, refreshTokenIv: CONN.refreshTokenIv } }, "REFRESHED");
  ok("O no rotation reported as such", r2.refreshTokenRotated === false);
  await outcome("service says REFRESHED but nothing changed", { afterConn: CONN }, "UNCERTAIN_PERSIST");

  const svc = (o: "AUTH_FAILURE" | "NETWORK_FAILURE" | "CONFIGURATION_FAILURE", useTransport: boolean, transport?: typeof fetch): Partial<RefreshOneshotDeps> => ({
    ...(transport ? { transport } : {}),
    refresh: async (input) => {
      if (useTransport) await input.fetchImpl!(TOKEN, { method: "POST", body: REFRESH_BODY }).catch(() => undefined);
      return { ok: false, refreshed: false, refreshTimestamp: new Date(), outcome: o, errorCode: "X" };
    },
  });
  const throwing = (err: unknown) => (async () => { throw err; }) as unknown as typeof fetch;
  const status = (s: number) => (async () => new Response("{}", { status: s })) as unknown as typeof fetch;
  const withCode = (name: string, code: string) => Object.assign(new Error("x"), { name, code });

  await outcome("provider 400 invalid_grant", svc("AUTH_FAILURE", true, status(400)), "AUTH_REJECTED");
  await outcome("egress refused before I/O", svc("NETWORK_FAILURE", true, throwing(new AuthorityEgressError(AUTHORITY_EGRESS_ERROR_CODES.OPERATION_BLOCKED, "x"))), "NOT_SENT");
  await outcome("connect refused", svc("NETWORK_FAILURE", true, throwing(Object.assign(new TypeError("fetch failed"), { cause: withCode("Error", "ECONNREFUSED") }))), "NOT_SENT");
  await outcome("tunnel closed at connect", svc("NETWORK_FAILURE", true, throwing(Object.assign(new TypeError("fetch failed"), { cause: withCode("Error", "ITA_EGRESS_TUNNEL_CLOSED") }))), "NOT_SENT");
  await outcome("generic SSL error (may be mid-stream)", svc("NETWORK_FAILURE", true, throwing(Object.assign(new TypeError("fetch failed"), { cause: withCode("Error", "ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC") }))), "UNCERTAIN_SENT");
  await outcome("EPROTO (may be mid-stream)", svc("NETWORK_FAILURE", true, throwing(Object.assign(new TypeError("fetch failed"), { cause: withCode("Error", "EPROTO") }))), "UNCERTAIN_SENT");
  await outcome("certificate verification failure (handshake only)", svc("NETWORK_FAILURE", true, throwing(Object.assign(new TypeError("fetch failed"), { cause: withCode("Error", "UNABLE_TO_VERIFY_LEAF_SIGNATURE") }))), "NOT_SENT");
  await outcome("unknown error without code", svc("NETWORK_FAILURE", true, throwing(new TypeError("fetch failed"))), "UNCERTAIN_SENT");
  await outcome("timeout after send", svc("NETWORK_FAILURE", true, throwing(withCode("AbortError", "ABORT_ERR"))), "UNCERTAIN_SENT");
  await outcome("reset mid-request", svc("NETWORK_FAILURE", true, throwing(Object.assign(new TypeError("fetch failed"), { cause: withCode("Error", "ECONNRESET") }))), "UNCERTAIN_SENT");
  await outcome("provider 5xx", svc("NETWORK_FAILURE", true, status(503)), "UNCERTAIN_SENT");
  await outcome("2xx without access_token", svc("CONFIGURATION_FAILURE", true, status(200)), "UNCERTAIN_RESPONSE");
  await outcome("config failure before transport", svc("CONFIGURATION_FAILURE", false), "NOT_SENT");
  await outcome("persist threw after 2xx", { transport: status(200), refresh: async (input) => { await input.fetchImpl!(TOKEN, { method: "POST", body: REFRESH_BODY }); throw new Error("db closed"); } }, "UNCERTAIN_PERSIST");

  {
    resetRefreshOneshotForTests();
    const h = harness({ env, afterConn: rotated });
    await runSandboxRefreshOneshot(h.deps);
    const again = await runSandboxRefreshOneshot(h.deps);
    ok("O second start on the instance → ALREADY_RAN_ON_INSTANCE, no call", again.fuse === "ALREADY_RAN_ON_INSTANCE" && h.counts().refreshCalls === 1);
  }
  {
    resetRefreshOneshotForTests();
    let blockedOutside: string | null = null;
    const h = harness({
      env,
      refresh: async (input) => {
        // The real egress fetch, inside vs outside the allowance the one-shot opened.
        const real = createAuthorityEgressFetch({ env: { BILLING_AUTHORITY_RUNTIME_ENVIRONMENT: "SANDBOX" } });
        const inside = await real(TOKEN, { method: "POST", body: REFRESH_BODY }).then(() => "RESOLVED", (e) => (isAuthorityEgressError(e) ? e.code : "OTHER"));
        blockedOutside = inside;
        void input;
        return { ok: false, refreshed: false, refreshTimestamp: new Date(), outcome: "CONFIGURATION_FAILURE" };
      },
    });
    await runSandboxRefreshOneshot(h.deps);
    ok("O the single refresh runs inside the egress allowance", blockedOutside === AUTHORITY_EGRESS_ERROR_CODES.NOT_CONFIGURED, blockedOutside);
  }
  ok("O token path constant matches the egress block path", REFRESH_ONESHOT_TOKEN_PATH === AUTHORITY_EGRESS_OAUTH_ONLY_PATH);
}

async function main() {
  await scopeTests();
  await withValidEgress(oneshotTests);
  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("UNCAUGHT", e);
  process.exit(1);
});
