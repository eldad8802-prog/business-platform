/**
 * ITA egress transport verification (run manually):
 *   npx tsx lib/services/billing/authority/billing-authority-egress.verify.test.ts
 *
 * No real network and no ITA credentials. Throwaway CAs/certs are generated at
 * runtime with the openssl CLI into a temp dir (nothing is committed) and a
 * local mTLS CONNECT proxy fixture on 127.0.0.1 plays the gateway. The fixture
 * answers every CONNECT with 403, so no tunnel ever reaches the internet.
 *
 *   A  missing config            → rejected before any socket
 *   B  malformed config          → rejected before any socket
 *   C  openapi.taxes.gov.il:443  → allowed (CONNECT observed at proxy)
 *   D  ita-api.taxes.gov.il:443  → allowed (CONNECT observed at proxy)
 *   E  arbitrary host            → rejected locally, no socket
 *   F  non-443 ITA destination   → rejected locally, no socket
 *   G  explicit fetchImpl        → still used as-is by every call-site
 *   H  default call path         → never global fetch, fails closed
 *   I  unrelated integrations    → untouched (no global fetch/dispatcher change)
 *   J  secrets                   → absent from thrown errors and console output
 *   M  mTLS fixture              → client cert presented and verified, pinned
 *                                  proxy CA, proxy identity verified, bad client
 *                                  cert / untrusted proxy / wrong identity fail
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { getGlobalDispatcher, ProxyAgent } from "undici";
import {
  AUTHORITY_EGRESS_ERROR_CODES,
  assertAuthorityEgressDestination,
  createAuthorityEgressFetch,
  describeAuthorityEgressConfig,
  isAuthorityEgressError,
  resolveAuthorityEgressConfig,
} from "@/lib/services/billing/authority/billing-authority-egress";
import { sendInvoiceApproval } from "@/lib/services/billing/authority/billing-authority-approval-client";
import { sendInvoiceDecision } from "@/lib/services/billing/authority/billing-authority-decision-client";
import {
  AuthorityOAuthCallbackError,
  exchangeAuthorityAuthorizationCode,
  mapNetworkErrorClass,
} from "@/lib/services/billing/authority/billing-authority-oauth-callback.service";
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

// ── socket + global-fetch instrumentation ───────────────────────────────────

let socketConnects = 0;
const originalSocketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  socketConnects += 1;
  return (originalSocketConnect as (...a: unknown[]) => net.Socket).apply(this, args);
} as typeof net.Socket.prototype.connect;

const originalGlobalFetch = globalThis.fetch;
let globalFetchCalls = 0;
globalThis.fetch = (async () => {
  globalFetchCalls += 1;
  throw new Error("global fetch must never be used for ITA traffic");
}) as typeof fetch;
const instrumentedGlobalFetch = globalThis.fetch;
const globalDispatcherBefore = getGlobalDispatcher();

async function rejectsWith(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return undefined;
  } catch (error) {
    return error;
  }
}

// ── throwaway PKI (openssl CLI, temp dir) ───────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), "ita-egress-test-"));
const ossl = (args: string[]) =>
  execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });

function key(name: string): void {
  ossl(["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", `${name}.key`]);
}
function ca(name: string, cn: string): void {
  key(name);
  ossl([
    "req", "-x509", "-new", "-key", `${name}.key`, "-subj", `/O=EgressTest/CN=${cn}`,
    "-days", "30", "-out", `${name}.pem`,
    "-addext", "basicConstraints=critical,CA:TRUE",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign",
  ]);
}
function leaf(name: string, cn: string, issuer: string, ext: string[]): void {
  key(name);
  ossl(["req", "-new", "-key", `${name}.key`, "-subj", `/O=EgressTest/CN=${cn}`, "-out", `${name}.csr`]);
  writeFileSync(join(dir, `${name}.ext`), ext.join("\n") + "\n");
  ossl([
    "x509", "-req", "-in", `${name}.csr`, "-CA", `${issuer}.pem`, "-CAkey", `${issuer}.key`,
    "-CAcreateserial", "-days", "30", "-out", `${name}.pem`, "-extfile", `${name}.ext`,
  ]);
}
const pem = (file: string) => readFileSync(join(dir, file), "utf8");

ca("server-ca", "Test SERVER CA");
ca("client-ca", "Test CLIENT CA");
ca("other-ca", "Unrelated CA");
ca("rogue-client-ca", "Rogue CLIENT CA");
const serverExt = ["basicConstraints=CA:FALSE", "extendedKeyUsage=serverAuth"];
const clientExt = ["basicConstraints=CA:FALSE", "extendedKeyUsage=clientAuth"];
leaf("proxy", "proxy", "server-ca", [...serverExt, "subjectAltName=IP:127.0.0.1"]);
leaf("proxy-wrong-id", "proxy", "server-ca", [...serverExt, "subjectAltName=IP:10.9.9.9"]);
leaf("proxy-untrusted", "proxy", "other-ca", [...serverExt, "subjectAltName=IP:127.0.0.1"]);
leaf("client", "dubiz-sandbox-client", "client-ca", clientExt);
leaf("rogue-client", "rogue-client", "rogue-client-ca", clientExt);
leaf("server-only", "server-only", "client-ca", serverExt);
key("unrelated");

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

const SANDBOX = "SANDBOX" as const;
function egressEnv(port: number, overrides: Record<string, string | undefined> = {}) {
  return {
    BILLING_AUTHORITY_RUNTIME_ENVIRONMENT: SANDBOX,
    ITA_EGRESS_PROXY_URL_SANDBOX: `https://127.0.0.1:${port}`,
    ITA_EGRESS_PROXY_CA_SANDBOX: b64(pem("server-ca.pem")),
    ITA_EGRESS_CLIENT_CERT_SANDBOX: b64(pem("client.pem")),
    ITA_EGRESS_CLIENT_KEY_SANDBOX: b64(pem("client.key")),
    ...overrides,
  };
}

// ── local mTLS CONNECT proxy fixture ────────────────────────────────────────

type ConnectRecord = {
  target: string | undefined;
  authorized: boolean;
  peerCn: string | null;
  proxyAuthorization: string | undefined;
};

type Fixture = {
  server: Server;
  port: number;
  connects: ConnectRecord[];
  tlsErrors: number;
  secureConnections: number;
};

async function startProxy(certName: string): Promise<Fixture> {
  const fixture = { connects: [], tlsErrors: 0, secureConnections: 0 } as unknown as Fixture;
  const server = createServer({
    key: pem(`${certName}.key`),
    cert: pem(`${certName}.pem`),
    ca: [pem("client-ca.pem")],
    requestCert: true,
    rejectUnauthorized: true,
  });
  server.on("secureConnection", () => {
    fixture.secureConnections += 1;
  });
  server.on("tlsClientError", () => {
    fixture.tlsErrors += 1;
  });
  server.on("connect", (req, socket) => {
    const tlsSocket = req.socket as TLSSocket;
    const peer = tlsSocket.getPeerCertificate();
    fixture.connects.push({
      target: req.url,
      authorized: tlsSocket.authorized,
      peerCn: peer && peer.subject ? String(peer.subject.CN) : null,
      proxyAuthorization: req.headers["proxy-authorization"],
    });
    // Same stance as the real gateway for anything we do not tunnel: refuse.
    socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fixture.server = server;
  fixture.port = (server.address() as net.AddressInfo).port;
  return fixture;
}

const closeProxy = (f: Fixture) =>
  new Promise<void>((resolve) => {
    f.server.closeAllConnections?.();
    f.server.close(() => resolve());
  });

const OPENAPI_TOKEN = "https://openapi.taxes.gov.il/shaam/tsandbox/longtimetoken/oauth2/token";
const ITA_API_APPROVAL = "https://ita-api.taxes.gov.il/shaam/tsandbox/Invoices/v2/Approval";

async function main(): Promise<void> {
  // ── A. missing config ─────────────────────────────────────────────────────
  {
    const names = [
      "ITA_EGRESS_PROXY_URL_SANDBOX",
      "ITA_EGRESS_PROXY_CA_SANDBOX",
      "ITA_EGRESS_CLIENT_CERT_SANDBOX",
      "ITA_EGRESS_CLIENT_KEY_SANDBOX",
    ];
    for (const name of names) {
      const before = socketConnects;
      const f = createAuthorityEgressFetch({ env: egressEnv(9, { [name]: undefined }) });
      const err = await rejectsWith(f(OPENAPI_TOKEN, { method: "POST" }));
      ok(`A: missing ${name} → NOT_CONFIGURED`,
        isAuthorityEgressError(err) && err.code === AUTHORITY_EGRESS_ERROR_CODES.NOT_CONFIGURED, err);
      ok(`A: missing ${name} → no socket opened`, socketConnects === before);
    }
    const blank = createAuthorityEgressFetch({ env: egressEnv(9, { ITA_EGRESS_PROXY_URL_SANDBOX: "   " }) });
    const errBlank = await rejectsWith(blank(OPENAPI_TOKEN));
    ok("A: whitespace-only value counts as missing",
      isAuthorityEgressError(errBlank) && errBlank.code === AUTHORITY_EGRESS_ERROR_CODES.NOT_CONFIGURED);

    const noEnv = createAuthorityEgressFetch({ env: { ...egressEnv(9), BILLING_AUTHORITY_RUNTIME_ENVIRONMENT: undefined } });
    const errEnv = await rejectsWith(noEnv(OPENAPI_TOKEN));
    ok("A: missing runtime environment → ENVIRONMENT_INVALID",
      isAuthorityEgressError(errEnv) && errEnv.code === AUTHORITY_EGRESS_ERROR_CODES.ENVIRONMENT_INVALID);

    // PRODUCTION runtime with only SANDBOX egress material → fail closed.
    const prod = createAuthorityEgressFetch({ env: { ...egressEnv(9), BILLING_AUTHORITY_RUNTIME_ENVIRONMENT: "PRODUCTION" } });
    const errProd = await rejectsWith(prod(OPENAPI_TOKEN));
    ok("A: PRODUCTION runtime never borrows SANDBOX egress material",
      isAuthorityEgressError(errProd) && errProd.code === AUTHORITY_EGRESS_ERROR_CODES.NOT_CONFIGURED);
  }

  // ── B. malformed config ───────────────────────────────────────────────────
  {
    const certPem = pem("client.pem");
    const cases: Array<[string, Record<string, string | undefined>, Date?]> = [
      ["proxy URL not a URL", { ITA_EGRESS_PROXY_URL_SANDBOX: "not a url" }],
      ["proxy URL http://", { ITA_EGRESS_PROXY_URL_SANDBOX: "http://127.0.0.1:9" }],
      ["proxy URL socks5://", { ITA_EGRESS_PROXY_URL_SANDBOX: "socks5://127.0.0.1:9" }],
      ["proxy URL with Basic credentials", { ITA_EGRESS_PROXY_URL_SANDBOX: "https://u:p@127.0.0.1:9" }],
      ["proxy URL with path", { ITA_EGRESS_PROXY_URL_SANDBOX: "https://127.0.0.1:9/x" }],
      ["CA garbage", { ITA_EGRESS_PROXY_CA_SANDBOX: "@@not-pem@@" }],
      ["CA base64 of non-PEM", { ITA_EGRESS_PROXY_CA_SANDBOX: b64("hello") }],
      ["CA corrupted PEM body", { ITA_EGRESS_PROXY_CA_SANDBOX: "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----" }],
      ["CA is a leaf, not a CA", { ITA_EGRESS_PROXY_CA_SANDBOX: b64(pem("proxy.pem")) }],
      ["CA bundle with two certs", { ITA_EGRESS_PROXY_CA_SANDBOX: b64(pem("server-ca.pem") + pem("other-ca.pem")) }],
      ["client cert garbage", { ITA_EGRESS_CLIENT_CERT_SANDBOX: "@@not-pem@@" }],
      ["client cert is a CA", { ITA_EGRESS_CLIENT_CERT_SANDBOX: b64(pem("client-ca.pem")), ITA_EGRESS_CLIENT_KEY_SANDBOX: b64(pem("client-ca.key")) }],
      ["client cert without clientAuth EKU", { ITA_EGRESS_CLIENT_CERT_SANDBOX: b64(pem("server-only.pem")), ITA_EGRESS_CLIENT_KEY_SANDBOX: b64(pem("server-only.key")) }],
      ["private key garbage", { ITA_EGRESS_CLIENT_KEY_SANDBOX: b64("-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----") }],
      ["private key is a certificate", { ITA_EGRESS_CLIENT_KEY_SANDBOX: b64(certPem) }],
      ["cert/key mismatch", { ITA_EGRESS_CLIENT_KEY_SANDBOX: b64(pem("unrelated.key")) }],
      ["expired client cert (clock far ahead)", {}, new Date("2100-01-01T00:00:00Z")],
      ["not-yet-valid certs (clock far behind)", {}, new Date("2000-01-01T00:00:00Z")],
    ];
    for (const [label, overrides, now] of cases) {
      const before = socketConnects;
      const f = createAuthorityEgressFetch({ env: egressEnv(9, overrides), now: now ? () => now : undefined });
      const err = await rejectsWith(f(OPENAPI_TOKEN));
      ok(`B: ${label} → CONFIG_INVALID`,
        isAuthorityEgressError(err) && err.code === AUTHORITY_EGRESS_ERROR_CODES.CONFIG_INVALID, err);
      ok(`B: ${label} → no socket opened`, socketConnects === before);
    }
    const envBad = createAuthorityEgressFetch({ env: { ...egressEnv(9), BILLING_AUTHORITY_RUNTIME_ENVIRONMENT: "STAGING" } });
    const errEnvBad = await rejectsWith(envBad(OPENAPI_TOKEN));
    ok("B: unexpected environment → ENVIRONMENT_INVALID",
      isAuthorityEgressError(errEnvBad) && errEnvBad.code === AUTHORITY_EGRESS_ERROR_CODES.ENVIRONMENT_INVALID);

    // Raw PEM (real newlines and \n-escaped) is accepted as well as base64.
    const raw = { ...egressEnv(9), ITA_EGRESS_CLIENT_CERT_SANDBOX: pem("client.pem"), ITA_EGRESS_CLIENT_KEY_SANDBOX: pem("client.key").replace(/\n/g, "\\n") };
    let rawOk = false;
    try {
      resolveAuthorityEgressConfig(raw, SANDBOX);
      rawOk = true;
    } catch {
      rawOk = false;
    }
    ok("B: raw and \\n-escaped PEM accepted", rawOk);
  }

  // ── E / F. destination allowlist (local, before any socket) ───────────────
  {
    const blocked = [
      "https://example.com/",
      "https://t-ita-api.taxes.gov.il/x",
      "https://openapi.taxes.gov.il.evil.example/x",
      "https://evil.example/?h=openapi.taxes.gov.il",
      "https://api.cardcom.solutions/x",
      "https://127.0.0.1/x",
      "https://openapi.taxes.gov.il:8443/x",
      "https://ita-api.taxes.gov.il:80/x",
      "http://openapi.taxes.gov.il/x",
      "https://user:pw@openapi.taxes.gov.il/x",
      "/relative/path",
    ];
    for (const url of blocked) {
      const before = socketConnects;
      const f = createAuthorityEgressFetch({ env: egressEnv(9) });
      const err = await rejectsWith(f(url));
      const isPort = /:(8443|80)\//.test(url);
      ok(`${isPort ? "F" : "E"}: ${url} → DESTINATION_BLOCKED`,
        isAuthorityEgressError(err) && err.code === AUTHORITY_EGRESS_ERROR_CODES.DESTINATION_BLOCKED, err);
      ok(`${isPort ? "F" : "E"}: ${url} → no socket opened`, socketConnects === before);
    }
    let requestObjBlocked = false;
    try {
      assertAuthorityEgressDestination(new Request(OPENAPI_TOKEN));
    } catch (error) {
      requestObjBlocked = isAuthorityEgressError(error);
    }
    ok("E: Request objects are refused (string/URL only)", requestObjBlocked);
    ok("C/D: explicit :443 accepted", assertAuthorityEgressDestination("https://openapi.taxes.gov.il:443/x").hostname === "openapi.taxes.gov.il");
  }

  // ── C / D / M. through the local mTLS proxy fixture ───────────────────────
  {
    const fx = await startProxy("proxy");
    const f = createAuthorityEgressFetch({ env: egressEnv(fx.port) });

    const errC = await rejectsWith(f(OPENAPI_TOKEN, { method: "POST", body: "", signal: AbortSignal.timeout(10_000) }));
    ok("C: openapi.taxes.gov.il:443 CONNECT reached the proxy",
      fx.connects.some((c) => c.target === "openapi.taxes.gov.il:443"), fx.connects);
    ok("C: fixture 403 surfaces as a failure (no direct fallback)", errC !== undefined);

    await rejectsWith(f(ITA_API_APPROVAL, { method: "POST", body: "{}", signal: AbortSignal.timeout(10_000) }));
    ok("D: ita-api.taxes.gov.il:443 CONNECT reached the proxy",
      fx.connects.some((c) => c.target === "ita-api.taxes.gov.il:443"), fx.connects);

    ok("M: every CONNECT was over an authorized mTLS session",
      fx.connects.length >= 2 && fx.connects.every((c) => c.authorized));
    ok("M: the presented client identity is the configured client cert",
      fx.connects.every((c) => c.peerCn === "dubiz-sandbox-client"));
    ok("M: no Proxy-Authorization (no Basic auth) header sent",
      fx.connects.every((c) => c.proxyAuthorization === undefined));
    ok("M: only allowlisted CONNECT targets were ever requested",
      fx.connects.every((c) => c.target === "openapi.taxes.gov.il:443" || c.target === "ita-api.taxes.gov.il:443"));

    const connectsBefore = fx.connects.length;
    await rejectsWith(f("https://example.com/"));
    ok("E: blocked host never reaches the proxy", fx.connects.length === connectsBefore);

    // Bad client certificate (issued by an unknown CA) → proxy refuses TLS.
    // Must fail on the FIRST refusal — never a reconnect loop against the gateway.
    const rogue = createAuthorityEgressFetch({
      env: egressEnv(fx.port, {
        ITA_EGRESS_CLIENT_CERT_SANDBOX: b64(pem("rogue-client.pem")),
        ITA_EGRESS_CLIENT_KEY_SANDBOX: b64(pem("rogue-client.key")),
      }),
    });
    const n0 = fx.connects.length;
    const tls0 = fx.tlsErrors;
    const t0 = Date.now();
    const errRogue = await rejectsWith(rogue(OPENAPI_TOKEN, { signal: AbortSignal.timeout(10_000) }));
    const rogueMs = Date.now() - t0;
    ok("M: bad client cert → request fails", errRogue !== undefined);
    ok("M: bad client cert → fails fast (not by timeout)", rogueMs < 5_000, rogueMs);
    ok("M: bad client cert → at most 2 TLS attempts at the gateway (no reconnect loop)",
      fx.tlsErrors - tls0 >= 1 && fx.tlsErrors - tls0 <= 2, fx.tlsErrors - tls0);
    ok("M: bad client cert → proxy saw no CONNECT", fx.connects.length === n0);
    ok("M: bad client cert → classified EGRESS_TUNNEL_CLOSED",
      mapNetworkErrorClass(errRogue) === "EGRESS_TUNNEL_CLOSED", mapNetworkErrorClass(errRogue));
    await closeProxy(fx);

    // Proxy presents a cert from a CA we did not pin → client refuses.
    const untrusted = await startProxy("proxy-untrusted");
    const fu = createAuthorityEgressFetch({ env: egressEnv(untrusted.port) });
    const tu = Date.now();
    const errUntrusted = await rejectsWith(fu(OPENAPI_TOKEN, { signal: AbortSignal.timeout(10_000) }));
    ok("M: proxy cert outside the pinned SERVER_CA → rejected", errUntrusted !== undefined);
    ok("M: untrusted proxy → fails fast", Date.now() - tu < 5_000);
    ok("M: untrusted proxy → classified as a certificate error",
      mapNetworkErrorClass(errUntrusted) === "CERTIFICATE_ERROR", mapNetworkErrorClass(errUntrusted));
    ok("M: untrusted proxy received no CONNECT", untrusted.connects.length === 0);
    await closeProxy(untrusted);

    // Proxy cert chains to the pinned CA but names another identity → refused.
    const wrongId = await startProxy("proxy-wrong-id");
    const fw = createAuthorityEgressFetch({ env: egressEnv(wrongId.port) });
    const tw = Date.now();
    const errWrongId = await rejectsWith(fw(OPENAPI_TOKEN, { signal: AbortSignal.timeout(10_000) }));
    ok("M: proxy identity (IP SAN) mismatch → rejected", errWrongId !== undefined);
    ok("M: wrong identity → fails fast", Date.now() - tw < 5_000);
    ok("M: wrong-identity proxy received no CONNECT", wrongId.connects.length === 0);
    await closeProxy(wrongId);
  }

  // ── G. explicit fetchImpl injection still wins ────────────────────────────
  {
    let injected = 0;
    const fake = (async () => {
      injected += 1;
      return new Response(JSON.stringify({ access_token: "x", token_type: "Bearer", expires_in: 60, refresh_token: "r" }), { status: 200 });
    }) as typeof fetch;
    const approvalConfig = { apiBaseUrl: "https://ita-api.taxes.gov.il/shaam/tsandbox", apiVersion: "v2", timeoutMs: 1000, scope: "scope" };
    await sendInvoiceApproval({ accessToken: "t", payload: {} as never, config: approvalConfig, fetchImpl: fake });
    await sendInvoiceDecision({ accessToken: "t", action: "Cancel" as never, payload: {} as never, config: { apiBaseUrl: approvalConfig.apiBaseUrl, apiVersion: "v1", timeoutMs: 1000 }, fetchImpl: fake });
    await rejectsWith(exchangeAuthorityAuthorizationCode({ tokenEndpoint: OPENAPI_TOKEN, clientId: "c", clientSecret: "s", code: "k", redirectUri: "https://x/cb", fetchImpl: fake }));
    await exchangeAuthorityRefreshToken({ tokenEndpoint: OPENAPI_TOKEN, clientId: "c", clientSecret: "s", refreshToken: "r", fetchImpl: fake });
    await runAuthorityTokenNetworkProbe({ buildTokenEndpoint: () => OPENAPI_TOKEN, fetchImpl: fake });
    await executeAuthorityValidationProbe({ probeUrl: "https://ita-api.taxes.gov.il/shaam/tsandbox/invoice-information/v1/details", accessToken: "t", payload: {} as never, fetchImpl: fake });
    ok("G: injected fetchImpl used by all 6 call-sites", injected === 6, injected);
  }

  // ── H. default path: egress transport, fail closed, never global fetch ────
  {
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("ITA_EGRESS_")) {
        saved[k] = process.env[k];
        delete process.env[k];
      }
    }
    const savedRuntime = process.env.BILLING_AUTHORITY_RUNTIME_ENVIRONMENT;
    process.env.BILLING_AUTHORITY_RUNTIME_ENVIRONMENT = "SANDBOX";
    const g0 = globalFetchCalls;
    const s0 = socketConnects;

    const approvalConfig = { apiBaseUrl: "https://ita-api.taxes.gov.il/shaam/tsandbox", apiVersion: "v2", timeoutMs: 1000, scope: "scope" };
    const approval = await sendInvoiceApproval({ accessToken: "t", payload: {} as never, config: approvalConfig });
    ok("H: Approval default → infrastructure_error (not sent)", approval.kind === "infrastructure_error", approval);

    const decision = await sendInvoiceDecision({ accessToken: "t", action: "Cancel" as never, payload: {} as never, config: { apiBaseUrl: approvalConfig.apiBaseUrl, apiVersion: "v1", timeoutMs: 1000 } });
    ok("H: Decision default → infrastructure_error (not sent)", decision.kind === "infrastructure_error", decision);

    const exch = await rejectsWith(exchangeAuthorityAuthorizationCode({ tokenEndpoint: OPENAPI_TOKEN, clientId: "c", clientSecret: "s", code: "k", redirectUri: "https://x/cb" }));
    ok("H: token exchange default → EGRESS_UNAVAILABLE diagnostic",
      exch instanceof AuthorityOAuthCallbackError &&
        (exch as unknown as { diagnostics?: { networkErrorClass?: string } }).diagnostics?.networkErrorClass === "EGRESS_UNAVAILABLE",
      exch);

    const refresh = await exchangeAuthorityRefreshToken({ tokenEndpoint: OPENAPI_TOKEN, clientId: "c", clientSecret: "s", refreshToken: "r" });
    ok("H: refresh default → NETWORK_FAILURE (no state change)", refresh.outcome === "NETWORK_FAILURE" && refresh.response === undefined, refresh);

    const probe = await runAuthorityTokenNetworkProbe({ buildTokenEndpoint: () => OPENAPI_TOKEN });
    ok("H: token probe default → EGRESS_UNAVAILABLE", !probe.networkReachable && probe.networkErrorClass === "EGRESS_UNAVAILABLE", probe);

    const probeBlocked = await runAuthorityTokenNetworkProbe({ buildTokenEndpoint: () => "https://example.com/token" });
    ok("H: token probe cannot target arbitrary hosts", probeBlocked.networkErrorClass === "EGRESS_DESTINATION_BLOCKED", probeBlocked);

    const validation = await executeAuthorityValidationProbe({ probeUrl: "https://ita-api.taxes.gov.il/shaam/tsandbox/invoice-information/v1/details", accessToken: "t", payload: {} as never });
    ok("H: validation default → NETWORK_FAILURE (no state change)", validation.outcome === "NETWORK_FAILURE", validation);

    ok("H: global fetch was never called by any call-site", globalFetchCalls === g0, globalFetchCalls - g0);
    ok("H: no socket opened on the unconfigured default path", socketConnects === s0, socketConnects - s0);

    for (const [k, v] of Object.entries(saved)) process.env[k] = v;
    if (savedRuntime === undefined) delete process.env.BILLING_AUTHORITY_RUNTIME_ENVIRONMENT;
    else process.env.BILLING_AUTHORITY_RUNTIME_ENVIRONMENT = savedRuntime;
  }

  // Static coverage guard: the six call-sites default to the egress transport,
  // and no other runtime file in the authority module calls fetch directly.
  {
    const authDir = join(process.cwd(), "lib/services/billing/authority");
    const runtimeFiles = readdirSync(authDir).filter(
      (f) => f.endsWith(".ts") && !f.includes(".test.") && f !== "billing-authority-egress.ts"
    );
    const offenders = runtimeFiles.filter((f) => {
      const src = readFileSync(join(authDir, f), "utf8");
      return /\?\?\s*fetch\b|globalThis\.fetch|(^|[^.\w])fetch\(/m.test(src);
    });
    ok("H: no authority runtime file defaults to / calls global fetch", offenders.length === 0, offenders);
    const wired = runtimeFiles.filter((f) => /\?\?\s*authorityEgressFetch\b/.test(readFileSync(join(authDir, f), "utf8")));
    ok("H: exactly the six known call-sites are wired", wired.length === 6, wired);
  }

  // ── I. unrelated integrations untouched ───────────────────────────────────
  {
    ok("I: globalThis.fetch identity unchanged by the egress module", globalThis.fetch === instrumentedGlobalFetch);
    ok("I: undici global dispatcher unchanged", getGlobalDispatcher() === globalDispatcherBefore);
    ok("I: global dispatcher is not a ProxyAgent", !(getGlobalDispatcher() instanceof ProxyAgent));
    ok("I: no HTTP(S)_PROXY set by the module",
      process.env.HTTP_PROXY === undefined && process.env.HTTPS_PROXY === undefined &&
        process.env.http_proxy === undefined && process.env.https_proxy === undefined);
    const src = readFileSync(join(process.cwd(), "lib/services/billing/authority/billing-authority-egress.ts"), "utf8");
    ok("I: module never sets a global dispatcher or global fetch",
      !/setGlobalDispatcher|globalThis\.fetch\s*=|process\.env\.(HTTPS?_PROXY|https?_proxy)\s*=/.test(src));
    ok("I: module never weakens TLS", !/(rejectUnauthorized|checkServerIdentity)\s*[:=]|NODE_TLS_REJECT_UNAUTHORIZED/.test(src));
    const importers = execFileSync("git", ["grep", "-l", "billing-authority-egress", "--", "app", "lib", "components"], { encoding: "utf8" })
      .split(/\r?\n/).filter(Boolean);
    ok("I: only authority files import the egress module",
      importers.every((p) => p.startsWith("lib/services/billing/authority/")), importers);
    for (const p of [
      "lib/services/payments/providers/cardcom/cardcom.provider.ts",
      "lib/services/payments/providers/paypal/paypal.provider.ts",
      "lib/services/payments/providers/sumit/sumit.provider.ts",
      "lib/services/integrations/gmail/gmail-token-revoke.service.ts",
    ]) {
      ok(`I: ${p.split("/").pop()} does not use the ITA transport`,
        !readFileSync(join(process.cwd(), p), "utf8").includes("billing-authority-egress"));
    }
  }

  // ── J. secrets never appear in errors or console output ───────────────────
  {
    const keyPem = pem("client.key");
    const certPem = pem("client.pem");
    const keyBody = keyPem.split("\n")[1];
    const certBody = certPem.split("\n")[1];
    const marker = "SECRET-MARKER-7f3a";
    const captured: string[] = [];
    const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
    for (const m of ["log", "error", "warn", "info"] as const) {
      console[m] = (...a: unknown[]) => {
        captured.push(a.map(String).join(" "));
      };
    }
    const errors: unknown[] = [];
    const variants: Array<Record<string, string | undefined>> = [
      { ITA_EGRESS_CLIENT_KEY_SANDBOX: b64(pem("unrelated.key")) },
      { ITA_EGRESS_CLIENT_KEY_SANDBOX: `-----BEGIN PRIVATE KEY-----\n${marker}\n-----END PRIVATE KEY-----` },
      { ITA_EGRESS_CLIENT_CERT_SANDBOX: `-----BEGIN CERTIFICATE-----\n${marker}\n-----END CERTIFICATE-----` },
      { ITA_EGRESS_PROXY_CA_SANDBOX: `${marker}!!` },
      { ITA_EGRESS_PROXY_URL_SANDBOX: `https://${marker}:${marker}@127.0.0.1:9` },
      { BILLING_AUTHORITY_RUNTIME_ENVIRONMENT: marker },
    ];
    for (const v of variants) {
      errors.push(await rejectsWith(createAuthorityEgressFetch({ env: egressEnv(9, v) })(OPENAPI_TOKEN)));
    }
    errors.push(await rejectsWith(createAuthorityEgressFetch({ env: egressEnv(9) })(`https://${marker}.example/`)));
    for (const m of ["log", "error", "warn", "info"] as const) console[m] = orig[m];

    const haystack = errors
      .map((e) => [String(e), (e as Error)?.stack ?? "", JSON.stringify(e, Object.getOwnPropertyNames(e ?? {}))].join("\n"))
      .join("\n") + captured.join("\n");
    ok("J: every variant failed closed with an egress error", errors.every(isAuthorityEgressError));
    ok("J: no marker / credential value in errors or console", !haystack.includes(marker));
    ok("J: no private key material in errors or console", !haystack.includes(keyBody) && !haystack.includes("PRIVATE KEY-----\n"));
    ok("J: no certificate material in errors or console", !haystack.includes(certBody));
    ok("J: no `cause` attached to egress errors", errors.every((e) => (e as Error).cause === undefined));
    ok("J: egress module wrote nothing to the console", captured.length === 0, captured);

    const diag = describeAuthorityEgressConfig(egressEnv(4443));
    const diagText = JSON.stringify(diag);
    ok("J: diagnostics report presence only",
      diag.egressConfigured && diag.clientCertPresent && diag.privateKeyPresent && diag.proxyCaPresent && diag.proxyHost === "127.0.0.1");
    ok("J: diagnostics carry no PEM", !diagText.includes("BEGIN") && !diagText.includes(keyBody) && !diagText.includes(certBody));
    const diagMissing = describeAuthorityEgressConfig({ BILLING_AUTHORITY_RUNTIME_ENVIRONMENT: "SANDBOX" });
    ok("J: diagnostics for missing config", !diagMissing.egressConfigured && diagMissing.errorCode === AUTHORITY_EGRESS_ERROR_CODES.NOT_CONFIGURED);
  }
}

main()
  .catch((error) => {
    failed += 1;
    console.error("FAIL: unexpected harness error", error);
  })
  .finally(() => {
    globalThis.fetch = originalGlobalFetch;
    net.Socket.prototype.connect = originalSocketConnect;
    rmSync(dir, { recursive: true, force: true });
    if (failed > 0) {
      console.error(`\n${failed} FAILED`);
      process.exit(1);
    }
    console.log("\nALL PASS");
    process.exit(0);
  });
