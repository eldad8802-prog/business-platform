/**
 * ITA Sandbox token one-shot verification (run manually):
 *   npx tsx lib/services/billing/authority/ita-sandbox-token-oneshot.verify.test.ts
 *
 * No real network. Throwaway PKI via the openssl CLI in a temp dir; a local
 * mTLS fixture on 127.0.0.1 plays the gateway (Squid). The REAL egress transport
 * (createAuthorityEgressFetch) is used for the end-to-end cases. Every socket,
 * every DNS lookup and every global fetch call made by the process is counted.
 *
 *   W  deployment-wide controls: window placeholders / outside window / missing,
 *      wrong or malformed ticket → no socket, no fetch
 *   F  fuses (not preview / wrong branch / not SANDBOX / missing or malformed
 *      egress config / gateway mismatch / production path / foreign host /
 *      http / port / query / route POST without env) → no socket, no fetch
 *   E  real transport through the fixture: exactly one socket, one CONNECT to
 *      openapi.taxes.gov.il:443, no reconnect, no DNS, no global fetch —
 *      for proxy deny, tunnel closed, proxy silent (timeout), untrusted proxy CA
 *   H  HTTP status + media type mapping (fake transport 400) → HTTP_RESPONSE
 *   D  default endpoint = the Sandbox token path, empty body, no Authorization
 *   O  one start per instance, ever
 *   X  no PEM / message text in any result
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import dns from "node:dns";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { NextRequest } from "next/server";
import { createAuthorityEgressFetch } from "@/lib/services/billing/authority/billing-authority-egress";
import {
  ONESHOT_BRANCH,
  ONESHOT_NOT_AFTER,
  ONESHOT_NOT_BEFORE,
  ONESHOT_SANDBOX_TOKEN_PATH,
  resetOneshotForTests,
  runSandboxTokenOneshot,
  sanitizeErrorChain,
  type OneshotResult,
} from "@/lib/services/billing/authority/ita-sandbox-token-oneshot";

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

let dnsLookups = 0;
const originalLookup = dns.lookup;
(dns as { lookup: unknown }).lookup = (...args: unknown[]) => {
  dnsLookups += 1;
  return (originalLookup as (...a: unknown[]) => unknown)(...args);
};

let globalFetchCalls = 0;
globalThis.fetch = (async () => {
  globalFetchCalls += 1;
  throw new Error("global fetch must never be used");
}) as typeof fetch;

// ── throwaway PKI ───────────────────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), "ita-oneshot-test-"));
const ossl = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
function key(name: string): void {
  ossl(["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", `${name}.key`]);
}
function ca(name: string, cn: string): void {
  key(name);
  ossl([
    "req", "-x509", "-new", "-key", `${name}.key`, "-subj", `/O=OneshotTest/CN=${cn}`, "-days", "30",
    "-out", `${name}.pem`, "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign",
  ]);
}
function leaf(name: string, cn: string, issuer: string, ext: string[]): void {
  key(name);
  ossl(["req", "-new", "-key", `${name}.key`, "-subj", `/O=OneshotTest/CN=${cn}`, "-out", `${name}.csr`]);
  writeFileSync(join(dir, `${name}.ext`), ext.join("\n") + "\n");
  ossl(["x509", "-req", "-in", `${name}.csr`, "-CA", `${issuer}.pem`, "-CAkey", `${issuer}.key`, "-CAcreateserial", "-days", "30", "-out", `${name}.pem`, "-extfile", `${name}.ext`]);
}
const pem = (file: string) => readFileSync(join(dir, file), "utf8");
ca("server-ca", "Test SERVER CA");
ca("client-ca", "Test CLIENT CA");
ca("other-ca", "Unrelated CA");
leaf("proxy", "proxy", "server-ca", ["basicConstraints=CA:FALSE", "extendedKeyUsage=serverAuth", "subjectAltName=IP:127.0.0.1"]);
leaf("proxy-untrusted", "proxy", "other-ca", ["basicConstraints=CA:FALSE", "extendedKeyUsage=serverAuth", "subjectAltName=IP:127.0.0.1"]);
leaf("client", "dubiz-sandbox-client", "client-ca", ["basicConstraints=CA:FALSE", "extendedKeyUsage=clientAuth"]);
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

const GOOD_ENDPOINT = `https://openapi.taxes.gov.il${ONESHOT_SANDBOX_TOKEN_PATH}`;
const TEST_TICKET = "a".repeat(63) + "b";
const PIN = {
  ticketSha256: createHash("sha256").update(TEST_TICKET).digest("hex"),
  notBefore: new Date(Date.now() - 60_000).toISOString(),
  notAfter: new Date(Date.now() + 3_600_000).toISOString(),
};
const AUTH = { ticket: TEST_TICKET, pinned: PIN };
// As committed the window is a placeholder; once pinned at push time, a test
// ticket can never pass (inside the window → TICKET_INVALID, else OUTSIDE_WINDOW).
const COMMITTED_FUSE = ONESHOT_NOT_BEFORE.startsWith("__")
  ? "WINDOW_NOT_SET"
  : Date.now() >= Date.parse(ONESHOT_NOT_BEFORE) && Date.now() <= Date.parse(ONESHOT_NOT_AFTER)
    ? "TICKET_INVALID"
    : "OUTSIDE_WINDOW";

function env(proxyUrl: string, overrides: Record<string, string | undefined> = {}) {
  return {
    VERCEL_ENV: "preview",
    VERCEL_GIT_COMMIT_REF: ONESHOT_BRANCH,
    BILLING_AUTHORITY_RUNTIME_ENVIRONMENT: "SANDBOX",
    ITA_EGRESS_PROXY_URL_SANDBOX: proxyUrl,
    ITA_EGRESS_PROXY_CA_SANDBOX: b64(pem("server-ca.pem")),
    ITA_EGRESS_CLIENT_CERT_SANDBOX: b64(pem("client.pem")),
    ITA_EGRESS_CLIENT_KEY_SANDBOX: b64(pem("client.key")),
    ...overrides,
  };
}

// ── local mTLS "gateway" fixture ────────────────────────────────────────────

type Mode = "deny" | "close" | "silent";
type Fixture = { server: tls.Server; port: number; lines: string[]; clientAuthorized: boolean[]; sockets: tls.TLSSocket[] };

async function startFixture(certName: string, mode: Mode): Promise<Fixture> {
  const f: Fixture = { server: null as unknown as tls.Server, port: 0, lines: [], clientAuthorized: [], sockets: [] };
  f.server = tls.createServer(
    { key: pem(`${certName}.key`), cert: pem(`${certName}.pem`), ca: [pem("client-ca.pem")], requestCert: true, rejectUnauthorized: true },
    (socket) => {
      f.sockets.push(socket);
      f.clientAuthorized.push(socket.authorized);
      let buf = "";
      socket.on("data", (c) => {
        buf += c.toString("latin1");
        if (!buf.includes("\r\n\r\n")) return;
        f.lines.push(buf.split("\r\n")[0]);
        if (mode === "silent") return;
        if (mode === "close") {
          socket.destroy(); // tunnel closed by the gateway (TLS sockets have no resetAndDestroy)
          return;
        }
        socket.write("HTTP/1.1 403 Forbidden\r\nServer: squid/6.14\r\nX-Squid-Error: ERR_ACCESS_DENIED 0\r\nContent-Length: 0\r\n\r\n");
      });
      socket.on("error", () => undefined);
    }
  );
  f.server.on("tlsClientError", () => undefined);
  await new Promise<void>((r) => f.server.listen(0, "127.0.0.1", r));
  f.port = (f.server.address() as net.AddressInfo).port;
  return f;
}
const stop = (f: Fixture) =>
  new Promise<void>((r) => {
    for (const s of f.sockets) s.destroy();
    f.server.close(() => r());
  });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const leaks = (r: unknown) => /BEGIN|PRIVATE KEY|CERTIFICATE-----|second fetch|must never/.test(JSON.stringify(r));

async function refused(name: string, fuse: string, run: () => Promise<OneshotResult>) {
  resetOneshotForTests();
  const before = { s: socketConnects, d: dnsLookups, g: globalFetchCalls };
  const r = await run().catch((e) => ({ outcome: "THREW", e }) as unknown as OneshotResult);
  ok(`F ${name}: refused with ${fuse}`, r.outcome === "REFUSED_BY_FUSE" && r.fuse === fuse, r);
  ok(`F ${name}: no socket / DNS / fetch`, socketConnects === before.s && dnsLookups === before.d && globalFetchCalls === before.g && r.fetchCalls === 0, r);
}

const neverFetch = (async () => {
  throw new Error("transport must not be called");
}) as typeof fetch;

async function main() {
  const gw = "https://127.0.0.1:44300";
  const base = { ...AUTH, gatewayOrigin: gw, fetchImpl: neverFetch, buildTokenEndpoint: () => GOOD_ENDPOINT };

  // ── F: fuses ──
  await refused("not preview", "NOT_PREVIEW", () => runSandboxTokenOneshot({ ...base, env: env(gw, { VERCEL_ENV: "production" }) }));
  await refused("no VERCEL_ENV", "NOT_PREVIEW", () => runSandboxTokenOneshot({ ...base, env: env(gw, { VERCEL_ENV: undefined }) }));
  await refused("wrong branch", "WRONG_BRANCH", () => runSandboxTokenOneshot({ ...base, env: env(gw, { VERCEL_GIT_COMMIT_REF: "main" }) }));
  await refused("PRODUCTION runtime", "NOT_SANDBOX", () => runSandboxTokenOneshot({ ...base, env: env(gw, { BILLING_AUTHORITY_RUNTIME_ENVIRONMENT: "PRODUCTION" }) }));
  await refused("egress missing", "EGRESS_CONFIG:ITA_EGRESS_NOT_CONFIGURED", () => runSandboxTokenOneshot({ ...base, env: env(gw, { ITA_EGRESS_CLIENT_KEY_SANDBOX: undefined }) }));
  await refused("egress malformed", "EGRESS_CONFIG:ITA_EGRESS_CONFIG_INVALID", () => runSandboxTokenOneshot({ ...base, env: env(gw, { ITA_EGRESS_PROXY_CA_SANDBOX: "not-a-pem!" }) }));
  await refused("gateway mismatch", "GATEWAY_MISMATCH", () => runSandboxTokenOneshot({ ...base, env: env("https://127.0.0.1:44301") }));
  await refused("production token path", "TOKEN_ENDPOINT_UNEXPECTED", () =>
    runSandboxTokenOneshot({ ...base, env: env(gw), buildTokenEndpoint: () => "https://openapi.taxes.gov.il/shaam/production/longtimetoken/oauth2/token" }));
  await refused("foreign host", "TOKEN_ENDPOINT_UNEXPECTED", () =>
    runSandboxTokenOneshot({ ...base, env: env(gw), buildTokenEndpoint: () => `https://example.com${ONESHOT_SANDBOX_TOKEN_PATH}` }));
  await refused("http scheme", "TOKEN_ENDPOINT_UNEXPECTED", () =>
    runSandboxTokenOneshot({ ...base, env: env(gw), buildTokenEndpoint: () => `http://openapi.taxes.gov.il${ONESHOT_SANDBOX_TOKEN_PATH}` }));
  await refused("explicit port", "TOKEN_ENDPOINT_UNEXPECTED", () =>
    runSandboxTokenOneshot({ ...base, env: env(gw), buildTokenEndpoint: () => `https://openapi.taxes.gov.il:8443${ONESHOT_SANDBOX_TOKEN_PATH}` }));
  await refused("query string", "TOKEN_ENDPOINT_UNEXPECTED", () =>
    runSandboxTokenOneshot({ ...base, env: env(gw), buildTokenEndpoint: () => `${GOOD_ENDPOINT}?code=x` }));
  await refused("unresolvable endpoint", "TOKEN_ENDPOINT_UNRESOLVED", () =>
    runSandboxTokenOneshot({ ...base, env: env(gw), buildTokenEndpoint: () => { throw new Error("missing"); } }));

  // deployment-wide controls: ticket + pinned window
  await refused("pinned constants (as committed)", COMMITTED_FUSE, () => runSandboxTokenOneshot({ ...base, pinned: undefined, env: env(gw) }));
  await refused("before window", "OUTSIDE_WINDOW", () => runSandboxTokenOneshot({ ...base, env: env(gw), now: () => Date.parse(PIN.notBefore) - 1 }));
  await refused("after window", "OUTSIDE_WINDOW", () => runSandboxTokenOneshot({ ...base, env: env(gw), now: () => Date.parse(PIN.notAfter) + 1 }));
  await refused("inverted window", "WINDOW_NOT_SET", () => runSandboxTokenOneshot({ ...base, env: env(gw), pinned: { ...PIN, notAfter: PIN.notBefore } }));
  await refused("no ticket", "TICKET_INVALID", () => runSandboxTokenOneshot({ ...base, ticket: null, env: env(gw) }));
  await refused("wrong ticket", "TICKET_INVALID", () => runSandboxTokenOneshot({ ...base, ticket: "c".repeat(64), env: env(gw) }));
  await refused("malformed ticket", "TICKET_INVALID", () => runSandboxTokenOneshot({ ...base, ticket: TEST_TICKET.toUpperCase(), env: env(gw) }));
  await refused("ticket hash as ticket", "TICKET_INVALID", () => runSandboxTokenOneshot({ ...base, ticket: PIN.ticketSha256, env: env(gw) }));

  {
    resetOneshotForTests();
    const before = { s: socketConnects, d: dnsLookups, g: globalFetchCalls };
    const { POST } = await import("@/app/api/diagnostics/ita-sandbox-token-oneshot/route");
    const res = await POST(new NextRequest("http://localhost/api/diagnostics/ita-sandbox-token-oneshot", {
      method: "POST",
      headers: { "x-oneshot-ticket": TEST_TICKET, "x-target": "https://example.com" },
      body: JSON.stringify({ url: "https://example.com" }),
    }));
    const body = (await res.json()) as OneshotResult;
    ok(`F route as committed → 409 ${COMMITTED_FUSE}`, res.status === 409 && body.fuse === COMMITTED_FUSE, body);
    ok("F route: no socket / DNS / fetch", socketConnects === before.s && dnsLookups === before.d && globalFetchCalls === before.g);
  }

  // ── E: real egress transport through the local fixture ──
  for (const mode of ["deny", "close", "silent"] as const) {
    resetOneshotForTests();
    const f = await startFixture("proxy", mode);
    const origin = `https://127.0.0.1:${f.port}`;
    const e = env(origin);
    const before = { s: socketConnects, d: dnsLookups, g: globalFetchCalls };
    const r = await runSandboxTokenOneshot({
      ...AUTH,
      env: e,
      gatewayOrigin: origin,
      fetchImpl: createAuthorityEgressFetch({ env: e }),
      buildTokenEndpoint: () => GOOD_ENDPOINT,
      timeoutMs: 1500,
    });
    await pause(400); // any reconnect would land here
    ok(`E ${mode}: NETWORK_ERROR after exactly one transport call`, r.outcome === "NETWORK_ERROR" && r.fetchCalls === 1, r);
    ok(`E ${mode}: exactly one socket, one CONNECT`, socketConnects - before.s === 1 && f.lines.length === 1, { sockets: socketConnects - before.s, lines: f.lines });
    ok(`E ${mode}: CONNECT target is the ITA host on 443`, f.lines[0] === "CONNECT openapi.taxes.gov.il:443 HTTP/1.1", f.lines);
    ok(`E ${mode}: client certificate presented and accepted`, f.clientAuthorized.length === 1 && f.clientAuthorized[0] === true);
    ok(`E ${mode}: no DNS lookup, no global fetch`, dnsLookups === before.d && globalFetchCalls === before.g);
    ok(`E ${mode}: error chain is codes/names only`, r.errorChain.length > 0 && !leaks(r), r.errorChain);
    if (mode === "silent") ok("E silent: classified as timeout", r.networkErrorClass === "CONNECT_TIMEOUT", r.networkErrorClass);
    await stop(f);
  }

  {
    resetOneshotForTests();
    const f = await startFixture("proxy-untrusted", "deny");
    const origin = `https://127.0.0.1:${f.port}`;
    const e = env(origin);
    const before = socketConnects;
    const r = await runSandboxTokenOneshot({ ...AUTH, env: e, gatewayOrigin: origin, fetchImpl: createAuthorityEgressFetch({ env: e }), buildTokenEndpoint: () => GOOD_ENDPOINT, timeoutMs: 1500 });
    await pause(400);
    ok("E untrusted proxy CA: NETWORK_ERROR, no CONNECT sent", r.outcome === "NETWORK_ERROR" && f.lines.length === 0, { r, lines: f.lines });
    ok("E untrusted proxy CA: one socket, no retry", socketConnects - before === 1 && r.fetchCalls === 1);
    await stop(f);
  }

  // ── H / D: status mapping and the exact request ──
  {
    resetOneshotForTests();
    const seen: { url: string; init?: RequestInit }[] = [];
    const fake = (async (u: unknown, init?: RequestInit) => {
      seen.push({ url: String(u), init });
      return new Response(null, { status: 400, headers: { "content-type": "application/json; charset=utf-8" } });
    }) as typeof fetch;
    process.env.AUTHORITY_OAUTH_BASE_SANDBOX = "https://openapi.taxes.gov.il/";
    process.env.AUTHORITY_API_BASE_SANDBOX = "https://openapi.taxes.gov.il";
    process.env.BILLING_AUTHORITY_OAUTH_REDIRECT_BASE_URL = "https://example.test";
    delete process.env.AUTHORITY_OAUTH_PATH_SEGMENT_SANDBOX;
    const r = await runSandboxTokenOneshot({ ...AUTH, env: env(gw), gatewayOrigin: gw, fetchImpl: fake });
    ok("H media type only, parameters dropped", r.contentType === "application/json", r.contentType);
    ok("H 400 → HTTP_RESPONSE, httpStatus 400, one call", r.outcome === "HTTP_RESPONSE" && r.httpStatus === 400 && r.fetchCalls === 1 && seen.length === 1, r);
    ok("D default endpoint = Sandbox token path", seen[0]?.url === GOOD_ENDPOINT && r.tokenPath === ONESHOT_SANDBOX_TOKEN_PATH, seen[0]?.url);
    const headers = new Headers(seen[0]?.init?.headers);
    ok("D POST, empty body, no Authorization", seen[0]?.init?.method === "POST" && seen[0]?.init?.body === "" && !headers.has("authorization"), seen[0]?.init);

    // ── O: one start per instance ──
    const before = { s: socketConnects, n: seen.length };
    const again = await runSandboxTokenOneshot({ ...AUTH, env: env(gw), gatewayOrigin: gw, fetchImpl: fake });
    ok("O second start on the instance → ALREADY_RAN_ON_INSTANCE, no call", again.fuse === "ALREADY_RAN_ON_INSTANCE" && seen.length === before.n && socketConnects === before.s, again);
  }

  // ── X: sanitizer ──
  {
    const err = new Error("secret https://user:pw@host/ -----BEGIN PRIVATE KEY-----");
    (err as Error & { code: string }).code = "ECONNRESET";
    (err as Error & { cause: unknown }).cause = { name: "SocketError", code: "UND_ERR_SOCKET", message: "-----BEGIN CERTIFICATE-----" };
    const chain = sanitizeErrorChain(err);
    ok("X sanitizer keeps names/codes only", JSON.stringify(chain) === JSON.stringify([{ name: "Error", code: "ECONNRESET" }, { name: "SocketError", code: "UND_ERR_SOCKET" }]), chain);
    ok("X sanitizer drops unsafe tokens", JSON.stringify(sanitizeErrorChain({ name: "a b", code: "x".repeat(80) })) === JSON.stringify([{ name: null, code: null }]));
  }

  rmSync(dir, { recursive: true, force: true });
  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("UNCAUGHT", e);
  process.exit(1);
});
