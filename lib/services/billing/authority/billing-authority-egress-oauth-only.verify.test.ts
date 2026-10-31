/**
 * Temporary OAuth-only egress block verification (run manually):
 *   npx tsx lib/services/billing/authority/billing-authority-egress-oauth-only.verify.test.ts
 *
 * No real network. Throwaway PKI via the openssl CLI; the configured proxy is a
 * closed local port, so an admitted request fails at connect. Every socket and
 * every transport call is counted.
 *
 *   T  transport level: only POST to the SANDBOX token path with
 *      grant_type=authorization_code reaches the transport; every other shape
 *      (Approval, Decision, refresh, probe, GET, query, other path, PRODUCTION,
 *      non-string body, case variants) → OPERATION_BLOCKED, zero calls
 *   C  real call sites on the default transport: Approval NOT_SENT, Decision
 *      infrastructure_error, refresh NETWORK_FAILURE, probe EGRESS_UNAVAILABLE,
 *      validation NETWORK_FAILURE — zero sockets; the code exchange alone
 *      opens exactly one socket (to the local proxy)
 *   X  the refusal never echoes the body, the code or a token
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTHORITY_EGRESS_ERROR_CODES,
  AUTHORITY_EGRESS_OAUTH_ONLY_PATH,
  createAuthorityEgressFetch,
  isAuthorityEgressError,
} from "@/lib/services/billing/authority/billing-authority-egress";
import { sendInvoiceApproval } from "@/lib/services/billing/authority/billing-authority-approval-client";
import { sendInvoiceDecision } from "@/lib/services/billing/authority/billing-authority-decision-client";
import { exchangeAuthorityAuthorizationCode } from "@/lib/services/billing/authority/billing-authority-oauth-callback.service";
import { exchangeAuthorityRefreshToken } from "@/lib/services/billing/authority/billing-authority-token-refresh.service";
import { runAuthorityTokenNetworkProbe } from "@/lib/services/billing/authority/billing-authority-token-probe.service";
import { executeAuthorityValidationProbe } from "@/lib/services/billing/authority/billing-authority-validation.service";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`OK: ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL: ${name}`, extra ?? "");
  }
}

let socketConnects = 0;
const originalSocketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  socketConnects += 1;
  return (originalSocketConnect as (...a: unknown[]) => net.Socket).apply(this, args);
} as typeof net.Socket.prototype.connect;

let globalFetchCalls = 0;
globalThis.fetch = (async () => {
  globalFetchCalls += 1;
  throw new Error("global fetch must never be used");
}) as typeof fetch;

// ── throwaway PKI ───────────────────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), "ita-oauth-only-test-"));
const ossl = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
function key(name: string): void {
  ossl(["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", `${name}.key`]);
}
function ca(name: string, cn: string): void {
  key(name);
  ossl([
    "req", "-x509", "-new", "-key", `${name}.key`, "-subj", `/O=OAuthOnlyTest/CN=${cn}`, "-days", "30",
    "-out", `${name}.pem`, "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign",
  ]);
}
function leaf(name: string, cn: string, issuer: string, ext: string[]): void {
  key(name);
  ossl(["req", "-new", "-key", `${name}.key`, "-subj", `/O=OAuthOnlyTest/CN=${cn}`, "-out", `${name}.csr`]);
  writeFileSync(join(dir, `${name}.ext`), ext.join("\n") + "\n");
  ossl(["x509", "-req", "-in", `${name}.csr`, "-CA", `${issuer}.pem`, "-CAkey", `${issuer}.key`, "-CAcreateserial", "-days", "30", "-out", `${name}.pem`, "-extfile", `${name}.ext`]);
}
const pem = (file: string) => readFileSync(join(dir, file), "utf8");
ca("server-ca", "Test SERVER CA");
ca("client-ca", "Test CLIENT CA");
leaf("client", "dubiz-sandbox-client", "client-ca", ["basicConstraints=CA:FALSE", "extendedKeyUsage=clientAuth"]);
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

async function closedPort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

const TOKEN = `https://openapi.taxes.gov.il${AUTHORITY_EGRESS_OAUTH_ONLY_PATH}`;
const APPROVAL = "https://ita-api.taxes.gov.il/shaam/tsandbox/Invoices/v2/Approval";
const SECRET_CODE = "SECRETCODE-abc123";

async function main() {
  const port = await closedPort();
  const env = {
    BILLING_AUTHORITY_RUNTIME_ENVIRONMENT: "SANDBOX",
    ITA_EGRESS_PROXY_URL_SANDBOX: `https://127.0.0.1:${port}`,
    ITA_EGRESS_PROXY_CA_SANDBOX: b64(pem("server-ca.pem")),
    ITA_EGRESS_CLIENT_CERT_SANDBOX: b64(pem("client.pem")),
    ITA_EGRESS_CLIENT_KEY_SANDBOX: b64(pem("client.key")),
  };

  // ── T: transport level with a counting transport ──
  let transportCalls = 0;
  const transport = (async () => {
    transportCalls += 1;
    return new Response(null, { status: 400 });
  }) as unknown as Parameters<typeof createAuthorityEgressFetch>[0] extends { transportFetch?: infer T } ? T : never;
  const f = createAuthorityEgressFetch({ env, transportFetch: transport });

  const blocked: [string, string, RequestInit, Record<string, string>?][] = [
    ["Approval POST to ita-api", APPROVAL, { method: "POST", body: "{}" }],
    ["Decision-style POST to ita-api", "https://ita-api.taxes.gov.il/shaam/tsandbox/Invoices/v1/InvoiceDecision", { method: "POST", body: "{}" }],
    ["validation GET to ita-api", "https://ita-api.taxes.gov.il/shaam/tsandbox/invoice-information/v1/details", { method: "GET" }],
    ["refresh grant on the token path", TOKEN, { method: "POST", body: "grant_type=refresh_token&refresh_token=r" }],
    ["refresh grant as URLSearchParams", TOKEN, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token" }) }],
    ["probe (empty body)", TOKEN, { method: "POST", body: "" }],
    ["no body", TOKEN, { method: "POST" }],
    ["GET on the token path", TOKEN, { method: "GET" }],
    ["default method", TOKEN, {}],
    ["grant only in the query", `${TOKEN}?grant_type=authorization_code`, { method: "POST", body: "grant_type=authorization_code" }],
    ["upper-case grant value", TOKEN, { method: "POST", body: "grant_type=AUTHORIZATION_CODE" }],
    ["JSON body", TOKEN, { method: "POST", body: JSON.stringify({ grant_type: "authorization_code" }) }],
    ["Blob body", TOKEN, { method: "POST", body: new Blob(["grant_type=authorization_code"]) }],
    ["authorize path", "https://openapi.taxes.gov.il/shaam/tsandbox/longtimetoken/oauth2/authorize", { method: "POST", body: "grant_type=authorization_code" }],
    ["production token path", "https://openapi.taxes.gov.il/shaam/production/longtimetoken/oauth2/token", { method: "POST", body: "grant_type=authorization_code" }],
    ["token path on ita-api host", `https://ita-api.taxes.gov.il${AUTHORITY_EGRESS_OAUTH_ONLY_PATH}`, { method: "POST", body: "grant_type=authorization_code" }],
  ];
  for (const [name, url, init] of blocked) {
    const before = { t: transportCalls, s: socketConnects };
    const err = await f(url, init).then(() => null, (e: unknown) => e);
    ok(`T ${name}: OPERATION_BLOCKED`, isAuthorityEgressError(err) && err.code === AUTHORITY_EGRESS_ERROR_CODES.OPERATION_BLOCKED, err);
    ok(`T ${name}: no transport call, no socket`, transportCalls === before.t && socketConnects === before.s);
  }
  {
    const prod = createAuthorityEgressFetch({ env: { ...env, BILLING_AUTHORITY_RUNTIME_ENVIRONMENT: "PRODUCTION" }, transportFetch: transport });
    const before = transportCalls;
    const err = await prod(TOKEN, { method: "POST", body: "grant_type=authorization_code" }).then(() => null, (e: unknown) => e);
    ok("T PRODUCTION runtime: OPERATION_BLOCKED, no call", isAuthorityEgressError(err) && err.code === AUTHORITY_EGRESS_ERROR_CODES.OPERATION_BLOCKED && transportCalls === before, err);
  }
  {
    const before = transportCalls;
    const r1 = await f(TOKEN, { method: "POST", body: `grant_type=authorization_code&code=${SECRET_CODE}&redirect_uri=x` });
    const r2 = await f(TOKEN, { method: "post", body: new URLSearchParams({ grant_type: "authorization_code", code: SECRET_CODE }) });
    ok("T authorization-code exchange (string and URLSearchParams) reaches the transport once each", r1.status === 400 && r2.status === 400 && transportCalls === before + 2);
  }

  // ── X: the refusal never echoes the body / code ──
  {
    const err = await f(TOKEN, { method: "POST", body: `grant_type=refresh_token&refresh_token=${SECRET_CODE}` }).then(() => null, (e: unknown) => e);
    const text = `${(err as Error)?.message} ${JSON.stringify(err)} ${(err as Error)?.stack ?? ""}`;
    ok("X refusal carries no body, code or token", !text.includes(SECRET_CODE) && !text.includes("refresh_token="), text);
  }

  // ── C: real call sites on the default (process.env) transport ──
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const g0 = globalFetchCalls;
  {
    const s0 = socketConnects;
    const approvalConfig = { apiBaseUrl: "https://ita-api.taxes.gov.il/shaam/tsandbox", apiVersion: "v2", timeoutMs: 1000, scope: "scope" };
    const approval = await sendInvoiceApproval({ accessToken: "t", payload: {} as never, config: approvalConfig });
    ok("C Approval → infrastructure_error, NOT_SENT", approval.kind === "infrastructure_error" && (approval as { sendCertainty?: string }).sendCertainty === "NOT_SENT", approval);
    const decision = await sendInvoiceDecision({ accessToken: "t", action: "Cancel" as never, payload: {} as never, config: { apiBaseUrl: approvalConfig.apiBaseUrl, apiVersion: "v1", timeoutMs: 1000 } });
    ok("C Decision → infrastructure_error", decision.kind === "infrastructure_error", decision);
    const refresh = await exchangeAuthorityRefreshToken({ tokenEndpoint: TOKEN, clientId: "c", clientSecret: "s", refreshToken: SECRET_CODE });
    ok("C refresh → NETWORK_FAILURE, no response", refresh.outcome === "NETWORK_FAILURE" && refresh.response === undefined, refresh);
    const probe = await runAuthorityTokenNetworkProbe({ buildTokenEndpoint: () => TOKEN });
    ok("C token probe → EGRESS_UNAVAILABLE", !probe.networkReachable && probe.networkErrorClass === "EGRESS_UNAVAILABLE", probe);
    const validation = await executeAuthorityValidationProbe({ probeUrl: "https://ita-api.taxes.gov.il/shaam/tsandbox/invoice-information/v1/details", accessToken: "t", payload: {} as never });
    ok("C validation → NETWORK_FAILURE", validation.outcome === "NETWORK_FAILURE", validation);
    ok("C blocked call sites opened zero sockets", socketConnects === s0, socketConnects - s0);
  }
  {
    const s0 = socketConnects;
    const err = await exchangeAuthorityAuthorizationCode({ tokenEndpoint: TOKEN, clientId: "c", clientSecret: "s", code: SECRET_CODE, redirectUri: "https://x/cb", timeoutMs: 3000 }).then(() => null, (e: unknown) => e);
    ok("C code exchange passes the block: exactly one socket (to the local proxy), then fails", err !== null && socketConnects - s0 === 1, { sockets: socketConnects - s0 });
    ok("C code exchange error never echoes the code", !JSON.stringify(err ?? {}).includes(SECRET_CODE) && !String((err as Error)?.message).includes(SECRET_CODE));
  }
  ok("C global fetch never called", globalFetchCalls === g0);

  rmSync(dir, { recursive: true, force: true });
  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("UNCAUGHT", e);
  process.exit(1);
});
