/**
 * TEMPORARY, PREVIEW-ONLY diagnostic for the 48h gateway stability measurement
 * (Kamatera ticket #36423501). Vercel runtime → ITA egress gateway
 * (TCP → TLS → mTLS → Squid ACL), with NO traffic to the Tax Authority.
 *
 * One attempt = exactly one TCP connection to the FIXED gateway
 * 91.223.106.183:443, TLS with the pinned SERVER_CA and the existing mTLS client
 * identity, then a single `CONNECT a<attemptId>.dubiz-probe.invalid:1`, a read
 * of Squid's response head, and close. Port 1 is outside `ita_ports`, so the
 * first http_access rule (`deny CONNECT !ita_ports`, method + port ACLs only)
 * denies it before any dstdomain match, DNS lookup or forwarding. The tunnel is
 * never used, whatever the answer.
 *
 * SAFETY (every fuse is checked before any socket is opened)
 *   - VERCEL_ENV must be "preview" and VERCEL_GIT_COMMIT_REF the egress branch.
 *   - The request is never read: no target, host, port or certificate material
 *     can come from the caller. The attempt id is generated here.
 *   - The configured proxy URL must equal the fixed gateway origin; the socket
 *     is opened to the constant, not to the configured value.
 *   - SANDBOX gateway material only, validated by resolveAuthorityEgressConfig.
 *   - One socket, 10s cap, no retries; one attempt in flight per instance and
 *     at most one start per MIN_INTERVAL_MS per instance.
 *   - Output is sanitized: stages, timings, TLS version/cipher, Squid status
 *     line and X-Squid-Error. Never PEMs, keys or raw library messages.
 *
 * THROWAWAY: removed in a separate cleanup commit; the deployments that carry
 * it are deleted after the evidence is preserved. Not for main.
 */

import { randomBytes } from "node:crypto";
import tls from "node:tls";
import { resolveAuthorityEgressConfig } from "@/lib/services/billing/authority/billing-authority-egress";

export const PROBE48_GATEWAY_HOST = "91.223.106.183";
export const PROBE48_GATEWAY_PORT = 443;
export const PROBE48_GATEWAY_ORIGIN = `https://${PROBE48_GATEWAY_HOST}`;
export const PROBE48_BRANCH = "feat/ita-authority-egress";
export const PROBE48_CONNECT_PORT = 1;
export const PROBE48_TARGET_SUFFIX = ".dubiz-probe.invalid";
const TIMEOUT_MS = 10_000;
const MIN_INTERVAL_MS = 20_000;

export type Probe48Outcome =
  | "OK_EXPECTED_403"
  | "TCP_FAIL"
  | "TLS_FAIL"
  | "PROXY_UNEXPECTED"
  | "STOP_ACL_NOT_DENIED"
  | "REFUSED_BY_FUSE";

export type Probe48Result = {
  attemptId: string | null;
  outcome: Probe48Outcome;
  fuse: string | null;
  connectTarget: string | null;
  gateway: string | null;
  tcpConnected: boolean;
  tcpMs: number | null;
  tlsHandshakeCompleted: boolean;
  tlsMs: number | null;
  serverCaVerified: boolean;
  serverCertCn: string | null;
  clientCertPresented: boolean;
  tlsVersion: string | null;
  tlsCipher: string | null;
  connectSent: boolean;
  proxyMs: number | null;
  squidStatusLine: string | null;
  squidErrorHeader: string | null;
  failureStage: "tcp" | "tls" | "proxy" | "timeout" | null;
  errorCode: string | null;
  elapsedMs: number;
};

type Env = Readonly<Record<string, string | undefined>>;

export type Probe48Deps = {
  env?: Env;
  now?: () => number;
  /** Test seam only: replaces tls.connect. Never reachable from a request. */
  connect?: typeof tls.connect;
  /** Test seam only: replaces the fixed gateway endpoint. */
  gateway?: { host: string; port: number; origin: string };
};

let inFlight = false;
let lastStartedAt = 0;

export function resetProbe48GuardsForTests(): void {
  inFlight = false;
  lastStartedAt = 0;
}

function emptyResult(): Probe48Result {
  return {
    attemptId: null,
    outcome: "REFUSED_BY_FUSE",
    fuse: null,
    connectTarget: null,
    gateway: null,
    tcpConnected: false,
    tcpMs: null,
    tlsHandshakeCompleted: false,
    tlsMs: null,
    serverCaVerified: false,
    serverCertCn: null,
    clientCertPresented: false,
    tlsVersion: null,
    tlsCipher: null,
    connectSent: false,
    proxyMs: null,
    squidStatusLine: null,
    squidErrorHeader: null,
    failureStage: null,
    errorCode: null,
    elapsedMs: 0,
  };
}

function refuse(fuse: string): Probe48Result {
  return { ...emptyResult(), fuse };
}

export function newProbe48AttemptId(now: number): string {
  const stamp = new Date(now).toISOString().replace(/[-:.]/g, "").toLowerCase();
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

export async function runProbe48(deps: Probe48Deps = {}): Promise<Probe48Result> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const gateway = deps.gateway ?? {
    host: PROBE48_GATEWAY_HOST,
    port: PROBE48_GATEWAY_PORT,
    origin: PROBE48_GATEWAY_ORIGIN,
  };

  if (env.VERCEL_ENV?.trim() !== "preview") return refuse("NOT_PREVIEW");
  if (env.VERCEL_GIT_COMMIT_REF?.trim() !== PROBE48_BRANCH) return refuse("WRONG_BRANCH");

  let config: ReturnType<typeof resolveAuthorityEgressConfig>;
  try {
    config = resolveAuthorityEgressConfig(env, "SANDBOX");
  } catch (error) {
    return refuse(`CONFIG:${(error as { code?: string }).code ?? "CONFIG_ERROR"}`);
  }
  if (config.proxyUrl.replace(/\/$/, "") !== gateway.origin && config.proxyUrl.replace(/\/$/, "") !== `${gateway.origin}:${gateway.port}`) {
    return refuse("GATEWAY_MISMATCH");
  }

  const started = now();
  if (inFlight) return refuse("IN_FLIGHT");
  if (lastStartedAt && started - lastStartedAt < MIN_INTERVAL_MS) return refuse("TOO_SOON");
  inFlight = true;
  lastStartedAt = started;

  const r = emptyResult();
  r.attemptId = newProbe48AttemptId(started);
  r.connectTarget = `a${r.attemptId}${PROBE48_TARGET_SUFFIX}:${PROBE48_CONNECT_PORT}`;
  r.gateway = `${gateway.host}:${gateway.port}`;
  const connect = deps.connect ?? tls.connect;

  try {
    return await new Promise<Probe48Result>((resolve) => {
      let done = false;
      let head = "";
      let connectSentAt = 0;
      const socket = connect({
        host: gateway.host,
        port: gateway.port,
        ca: [config.proxyCaPem],
        cert: config.clientCertPem,
        key: config.clientKeyPem,
        minVersion: "TLSv1.2",
        rejectUnauthorized: true,
      });
      const finish = (
        outcome: Probe48Outcome,
        stage: Probe48Result["failureStage"],
        code: string | null
      ) => {
        if (done) return;
        done = true;
        r.outcome = outcome;
        r.failureStage = stage;
        r.errorCode = code;
        r.elapsedMs = now() - started;
        socket.destroy();
        resolve(r);
      };
      const failAtCurrentStage = (code: string) => {
        if (!r.tcpConnected) finish("TCP_FAIL", "tcp", code);
        else if (!r.tlsHandshakeCompleted) finish("TLS_FAIL", "tls", code);
        else finish("PROXY_UNEXPECTED", "proxy", code);
      };
      socket.setTimeout(TIMEOUT_MS, () => failAtCurrentStage("TIMEOUT"));
      socket.once("connect", () => {
        r.tcpConnected = true;
        r.tcpMs = now() - started;
      });
      socket.once("secureConnect", () => {
        r.tlsHandshakeCompleted = true;
        r.tlsMs = now() - started;
        r.serverCaVerified = socket.authorized;
        r.serverCertCn = (socket.getPeerCertificate()?.subject?.CN as string | undefined) ?? null;
        r.clientCertPresented = Boolean(socket.getCertificate());
        r.tlsVersion = socket.getProtocol();
        r.tlsCipher = socket.getCipher()?.name ?? null;
        socket.write(`CONNECT ${r.connectTarget} HTTP/1.1\r\nHost: ${r.connectTarget}\r\n\r\n`);
        r.connectSent = true;
        connectSentAt = now();
      });
      socket.on("data", (chunk: Buffer) => {
        head += chunk.toString("latin1");
        const end = head.indexOf("\r\n\r\n");
        if (end < 0 && head.length < 8192) return;
        const lines = (end >= 0 ? head.slice(0, end) : head.slice(0, 2048)).split("\r\n");
        r.squidStatusLine = lines[0]?.slice(0, 120) ?? null;
        r.squidErrorHeader =
          lines
            .find((l) => l.toLowerCase().startsWith("x-squid-error:"))
            ?.slice("x-squid-error:".length)
            .trim()
            .slice(0, 120) ?? null;
        r.proxyMs = now() - connectSentAt;
        const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(r.squidStatusLine ?? "")?.[1] ?? NaN);
        const deniedByAcl = status === 403 && (r.squidErrorHeader ?? "").startsWith("ERR_ACCESS_DENIED");
        if (deniedByAcl) finish("OK_EXPECTED_403", null, null);
        else if (status >= 200 && status < 300) finish("STOP_ACL_NOT_DENIED", "proxy", `HTTP_${status}`);
        else if (/ERR_DNS|ERR_CONNECT_FAIL/.test(r.squidErrorHeader ?? ""))
          finish("STOP_ACL_NOT_DENIED", "proxy", r.squidErrorHeader);
        else finish("PROXY_UNEXPECTED", "proxy", Number.isNaN(status) ? "UNPARSEABLE_STATUS" : `HTTP_${status}`);
      });
      socket.once("error", (error: NodeJS.ErrnoException) => failAtCurrentStage(error.code ?? error.name ?? "ERROR"));
      socket.once("close", () => failAtCurrentStage("CLOSED_WITHOUT_RESPONSE"));
    });
  } finally {
    inFlight = false;
  }
}
