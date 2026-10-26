/**
 * 48h gateway probe verification (run manually):
 *   npx tsx lib/services/billing/authority/ita-gateway-probe48.verify.test.ts
 *
 * No real network. Throwaway PKI via the openssl CLI in a temp dir; a local
 * mTLS fixture on 127.0.0.1 plays Squid. Every socket opened by the process is
 * counted at net.Socket.prototype.connect.
 *
 *   F  fuses (not preview / production / wrong branch / missing or malformed
 *      config / gateway mismatch / route POST without env) → no socket
 *   R  route never reads the request; target and gateway are constants
 *   P  fixture 403 ERR_ACCESS_DENIED → OK_EXPECTED_403, CONNECT line shape
 *   S  fixture 200 / ERR_DNS_FAIL → STOP_ACL_NOT_DENIED
 *   T  closed port → TCP_FAIL; untrusted server CA → TLS_FAIL; silent → timeout
 *   G  in-flight / too-soon guards → no socket
 *   X  no PEM material in any result
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import {
  PROBE48_BRANCH,
  PROBE48_CONNECT_PORT,
  PROBE48_GATEWAY_HOST,
  PROBE48_GATEWAY_PORT,
  resetProbe48GuardsForTests,
  runProbe48,
  type Probe48Result,
} from "@/lib/services/billing/authority/ita-gateway-probe48";

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

// ── throwaway PKI ───────────────────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), "ita-probe48-test-"));
const ossl = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
function key(name: string): void {
  ossl(["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", `${name}.key`]);
}
function ca(name: string, cn: string): void {
  key(name);
  ossl([
    "req", "-x509", "-new", "-key", `${name}.key`, "-subj", `/O=Probe48Test/CN=${cn}`, "-days", "30",
    "-out", `${name}.pem`, "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign",
  ]);
}
function leaf(name: string, cn: string, issuer: string, ext: string[]): void {
  key(name);
  ossl(["req", "-new", "-key", `${name}.key`, "-subj", `/O=Probe48Test/CN=${cn}`, "-out", `${name}.csr`]);
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

function env(proxyUrl: string, overrides: Record<string, string | undefined> = {}) {
  return {
    VERCEL_ENV: "preview",
    VERCEL_GIT_COMMIT_REF: PROBE48_BRANCH,
    BILLING_AUTHORITY_RUNTIME_ENVIRONMENT: "SANDBOX",
    ITA_EGRESS_PROXY_URL_SANDBOX: proxyUrl,
    ITA_EGRESS_PROXY_CA_SANDBOX: b64(pem("server-ca.pem")),
    ITA_EGRESS_CLIENT_CERT_SANDBOX: b64(pem("client.pem")),
    ITA_EGRESS_CLIENT_KEY_SANDBOX: b64(pem("client.key")),
    ...overrides,
  };
}

// ── local mTLS "Squid" fixture ──────────────────────────────────────────────

type Mode = "deny" | "allow" | "dnsfail" | "silent";
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
        const reply =
          mode === "deny"
            ? "HTTP/1.1 403 Forbidden\r\nServer: squid/6.14\r\nX-Squid-Error: ERR_ACCESS_DENIED 0\r\nContent-Length: 0\r\n\r\n"
            : mode === "allow"
              ? "HTTP/1.1 200 Connection established\r\n\r\n"
              : "HTTP/1.1 503 Service Unavailable\r\nX-Squid-Error: ERR_DNS_FAIL 0\r\nContent-Length: 0\r\n\r\n";
        socket.write(reply);
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

const local = (port: number) => ({ host: "127.0.0.1", port, origin: `https://127.0.0.1:${port}` });
const hasPem = (r: unknown) => /BEGIN|PRIVATE KEY|CERTIFICATE-----/.test(JSON.stringify(r));

async function noSocket(name: string, run: () => Promise<Probe48Result>, fusePrefix: string) {
  resetProbe48GuardsForTests();
  const before = socketConnects;
  const r = await run();
  ok(`${name}: refused (${r.fuse})`, r.outcome === "REFUSED_BY_FUSE" && (r.fuse ?? "").startsWith(fusePrefix), r);
  ok(`${name}: no socket opened`, socketConnects === before, socketConnects - before);
  ok(`${name}: no attempt id / target`, r.attemptId === null && r.connectTarget === null);
}

async function main(): Promise<void> {
  const fixedUrl = `https://${PROBE48_GATEWAY_HOST}:${PROBE48_GATEWAY_PORT}`;

  // ── F. fuses ──────────────────────────────────────────────────────────────
  await noSocket("F1 no VERCEL_ENV", () => runProbe48({ env: env(fixedUrl, { VERCEL_ENV: undefined }) }), "NOT_PREVIEW");
  await noSocket("F2 production", () => runProbe48({ env: env(fixedUrl, { VERCEL_ENV: "production" }) }), "NOT_PREVIEW");
  await noSocket("F3 development", () => runProbe48({ env: env(fixedUrl, { VERCEL_ENV: "development" }) }), "NOT_PREVIEW");
  await noSocket("F4 wrong branch", () => runProbe48({ env: env(fixedUrl, { VERCEL_GIT_COMMIT_REF: "main" }) }), "WRONG_BRANCH");
  await noSocket("F5 branch missing", () => runProbe48({ env: env(fixedUrl, { VERCEL_GIT_COMMIT_REF: undefined }) }), "WRONG_BRANCH");
  await noSocket(
    "F6 config missing (btrl-like project)",
    () => runProbe48({ env: { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: PROBE48_BRANCH } }),
    "CONFIG:"
  );
  await noSocket("F7 client key missing", () => runProbe48({ env: env(fixedUrl, { ITA_EGRESS_CLIENT_KEY_SANDBOX: undefined }) }), "CONFIG:");
  await noSocket("F8 CA garbage", () => runProbe48({ env: env(fixedUrl, { ITA_EGRESS_PROXY_CA_SANDBOX: "@@" }) }), "CONFIG:");
  await noSocket("F9 proxy URL is another host", () => runProbe48({ env: env("https://10.1.2.3:443") }), "GATEWAY_MISMATCH");
  await noSocket("F10 proxy URL other port", () => runProbe48({ env: env(`https://${PROBE48_GATEWAY_HOST}:8443`) }), "GATEWAY_MISMATCH");

  // ── R. route surface ─────────────────────────────────────────────────────
  const routeSrc = readFileSync(join(process.cwd(), "app/api/diagnostics/ita-gateway-probe48/route.ts"), "utf8");
  const libSrc = readFileSync(join(process.cwd(), "lib/services/billing/authority/ita-gateway-probe48.ts"), "utf8");
  ok("R1 route exports POST only (no GET)", /export async function POST\(\)/.test(routeSrc) && !/export (async )?function (GET|PUT|PATCH|DELETE)/.test(routeSrc));
  ok("R2 route never reads the request", !/\b(request|req)\b\s*[:.,)]/.test(routeSrc) && !/searchParams|\.json\(\)\s*;?\s*$/m.test(routeSrc.replace(/NextResponse\.json/g, "")));
  ok("R3 runProbe48 called without arguments in route", /runProbe48\(\)/.test(routeSrc));
  ok("R4 constants fixed", PROBE48_GATEWAY_HOST === "91.223.106.183" && PROBE48_GATEWAY_PORT === 443 && PROBE48_CONNECT_PORT === 1);
  ok("R5 no taxes.gov.il anywhere in probe code", !/taxes\.gov\.il/.test(routeSrc + libSrc));
  const { POST } = await import("@/app/api/diagnostics/ita-gateway-probe48/route");
  {
    resetProbe48GuardsForTests();
    const saved = { ...process.env };
    for (const k of Object.keys(process.env)) if (k.startsWith("ITA_EGRESS_") || k.startsWith("VERCEL_")) delete process.env[k];
    const before = socketConnects;
    const res = await POST();
    const body = (await res.json()) as Probe48Result;
    ok("R6 route POST locally (no env) → 409 REFUSED_BY_FUSE", res.status === 409 && body.outcome === "REFUSED_BY_FUSE", body);
    ok("R6 route POST locally → no socket", socketConnects === before);
    process.env.VERCEL_ENV = "preview";
    process.env.VERCEL_GIT_COMMIT_REF = PROBE48_BRANCH;
    const res2 = await POST();
    const body2 = (await res2.json()) as Probe48Result;
    ok("R7 route POST preview+branch but no egress vars → CONFIG refusal, no socket", res2.status === 409 && (body2.fuse ?? "").startsWith("CONFIG:") && socketConnects === before, body2);
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }

  // ── P. expected deny ─────────────────────────────────────────────────────
  {
    const f = await startFixture("proxy", "deny");
    resetProbe48GuardsForTests();
    const before = socketConnects;
    const r = await runProbe48({ env: env(`https://127.0.0.1:${f.port}`), gateway: local(f.port) });
    ok("P1 OK_EXPECTED_403", r.outcome === "OK_EXPECTED_403", r);
    ok("P2 exactly one socket", socketConnects - before === 1, socketConnects - before);
    ok("P3 mTLS: client cert verified at fixture, server CA verified", f.clientAuthorized[0] === true && r.serverCaVerified && r.clientCertPresented);
    ok(
      "P4 CONNECT line = a<id>.dubiz-probe.invalid:1",
      f.lines.length === 1 && /^CONNECT a\d{8}t\d{9}z-[0-9a-f]{6}\.dubiz-probe\.invalid:1 HTTP\/1\.1$/.test(f.lines[0]),
      f.lines
    );
    ok("P5 attemptId echoed in target", r.connectTarget === f.lines[0].split(" ")[1]);
    ok("P6 stage timings present", r.tcpMs !== null && r.tlsMs !== null && r.proxyMs !== null && r.tcpMs <= r.tlsMs!);
    ok("P7 Squid fields", r.squidStatusLine === "HTTP/1.1 403 Forbidden" && r.squidErrorHeader === "ERR_ACCESS_DENIED 0");
    ok("X1 no PEM in result", !hasPem(r));
    // G. too soon (same instance)
    const b2 = socketConnects;
    const r2 = await runProbe48({ env: env(`https://127.0.0.1:${f.port}`), gateway: local(f.port) });
    ok("G1 second call within 20s refused TOO_SOON, no socket", r2.fuse === "TOO_SOON" && socketConnects === b2, r2);
    // G. in flight
    resetProbe48GuardsForTests();
    const b3 = socketConnects;
    const [a, b] = await Promise.all([
      runProbe48({ env: env(`https://127.0.0.1:${f.port}`), gateway: local(f.port) }),
      runProbe48({ env: env(`https://127.0.0.1:${f.port}`), gateway: local(f.port), now: () => Date.now() + 60_000 }),
    ]);
    ok("G2 concurrent call refused IN_FLIGHT, one socket only", a.outcome === "OK_EXPECTED_403" && b.fuse === "IN_FLIGHT" && socketConnects - b3 === 1, [a.outcome, b.fuse]);
    await stop(f);
  }

  // ── S. stop conditions ───────────────────────────────────────────────────
  for (const [mode, code] of [["allow", "HTTP_200"], ["dnsfail", "ERR_DNS_FAIL 0"]] as const) {
    const f = await startFixture("proxy", mode);
    resetProbe48GuardsForTests();
    const r = await runProbe48({ env: env(`https://127.0.0.1:${f.port}`), gateway: local(f.port) });
    ok(`S ${mode} → STOP_ACL_NOT_DENIED (${code})`, r.outcome === "STOP_ACL_NOT_DENIED" && r.errorCode === code, r);
    await stop(f);
  }

  // ── T. layer classification ──────────────────────────────────────────────
  {
    const tmp = net.createServer();
    await new Promise<void>((r) => tmp.listen(0, "127.0.0.1", r));
    const port = (tmp.address() as net.AddressInfo).port;
    await new Promise<void>((r) => tmp.close(() => r()));
    resetProbe48GuardsForTests();
    const r = await runProbe48({ env: env(`https://127.0.0.1:${port}`), gateway: local(port) });
    ok("T1 closed port → TCP_FAIL ECONNREFUSED", r.outcome === "TCP_FAIL" && r.failureStage === "tcp" && r.errorCode === "ECONNREFUSED", r);
  }
  {
    const f = await startFixture("proxy-untrusted", "deny");
    resetProbe48GuardsForTests();
    const r = await runProbe48({ env: env(`https://127.0.0.1:${f.port}`), gateway: local(f.port) });
    ok("T2 untrusted server CA → TLS_FAIL", r.outcome === "TLS_FAIL" && r.failureStage === "tls" && r.tcpConnected && !r.connectSent, r);
    ok("T2 no CONNECT reached fixture", f.lines.length === 0);
    await stop(f);
  }
  {
    const f = await startFixture("proxy", "silent");
    resetProbe48GuardsForTests();
    const r = await runProbe48({ env: env(`https://127.0.0.1:${f.port}`), gateway: local(f.port) });
    ok("T3 silent proxy → PROXY_UNEXPECTED TIMEOUT after CONNECT", r.outcome === "PROXY_UNEXPECTED" && r.errorCode === "TIMEOUT" && r.connectSent, r);
    await stop(f);
  }

  rmSync(dir, { recursive: true, force: true });
  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL", e instanceof Error ? e.stack : e);
  process.exit(2);
});
