/**
 * TEMPORARY, PREVIEW-ONLY diagnostic: Vercel runtime → ITA egress gateway
 * (TCP → TLS → mTLS → Squid ACL), with NO traffic to the Tax Authority.
 *
 * Path: POST /api/diagnostics/ita-gateway-acl-probe
 *
 * Opens exactly one TLS connection to the configured Sandbox gateway using the
 * existing pinned SERVER_CA and mTLS client identity (validated by the same
 * resolveAuthorityEgressConfig the real transport uses), sends a single
 * hard-coded `CONNECT example.com:443` — a destination outside the Squid
 * allowlist — reads only Squid's response head, and closes. Expected: 403
 * ERR_ACCESS_DENIED. Even if Squid answered 200, the socket is destroyed and
 * no TLS is ever started inside the tunnel.
 *
 * SAFETY
 *   - PREVIEW-ONLY FUSE: unless VERCEL_ENV === "preview" this answers 410.
 *   - SANDBOX only; no ITA host, no OAuth, no credentials besides the gateway
 *     mTLS material, no DB, no auth, no retries (one socket, 10s cap).
 *   - The request is never read; the CONNECT target is a constant.
 *   - Sanitized output only (stages, TLS version/cipher, Squid status line and
 *     X-Squid-Error). Never PEMs, keys or raw library messages.
 *
 * THROWAWAY: removed in a separate cleanup commit after one run. Not for main.
 */

import tls from "node:tls";
import { NextResponse } from "next/server";
import { resolveAuthorityEgressConfig } from "@/lib/services/billing/authority/billing-authority-egress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const CONNECT_TARGET = "example.com:443";
const TIMEOUT_MS = 10_000;

export type GatewayAclProbeResult = {
  tcpConnected: boolean;
  tlsHandshakeCompleted: boolean;
  serverCaVerified: boolean;
  serverCertCn: string | null;
  clientCertPresented: boolean;
  tlsVersion: string | null;
  tlsCipher: string | null;
  connectSent: boolean;
  squidStatusLine: string | null;
  squidServerHeader: string | null;
  squidErrorHeader: string | null;
  failureStage: "config" | "tcp" | "tls" | "after_connect" | "timeout" | null;
  errorCode: string | null;
  elapsedMs: number;
};

export function runGatewayAclProbe(
  env: Readonly<Record<string, string | undefined>> = process.env
): Promise<GatewayAclProbeResult> {
  const started = Date.now();
  const r: GatewayAclProbeResult = {
    tcpConnected: false,
    tlsHandshakeCompleted: false,
    serverCaVerified: false,
    serverCertCn: null,
    clientCertPresented: false,
    tlsVersion: null,
    tlsCipher: null,
    connectSent: false,
    squidStatusLine: null,
    squidServerHeader: null,
    squidErrorHeader: null,
    failureStage: null,
    errorCode: null,
    elapsedMs: 0,
  };

  let config: ReturnType<typeof resolveAuthorityEgressConfig>;
  try {
    config = resolveAuthorityEgressConfig(env, "SANDBOX");
  } catch (error) {
    r.failureStage = "config";
    r.errorCode = (error as { code?: string }).code ?? "CONFIG_ERROR";
    return Promise.resolve(r);
  }
  const proxy = new URL(config.proxyUrl);

  return new Promise((resolve) => {
    let done = false;
    let head = "";
    const socket = tls.connect({
      host: proxy.hostname,
      port: Number(proxy.port || 443),
      ca: [config.proxyCaPem],
      cert: config.clientCertPem,
      key: config.clientKeyPem,
      minVersion: "TLSv1.2",
      rejectUnauthorized: true,
    });
    const finish = (stage: GatewayAclProbeResult["failureStage"], code: string | null) => {
      if (done) return;
      done = true;
      if (stage) r.failureStage = stage;
      if (code) r.errorCode = code;
      r.elapsedMs = Date.now() - started;
      socket.destroy();
      resolve(r);
    };
    socket.setTimeout(TIMEOUT_MS, () => finish("timeout", "TIMEOUT"));
    socket.once("connect", () => {
      r.tcpConnected = true;
    });
    socket.once("secureConnect", () => {
      r.tlsHandshakeCompleted = true;
      r.serverCaVerified = socket.authorized;
      r.serverCertCn = (socket.getPeerCertificate()?.subject?.CN as string | undefined) ?? null;
      r.clientCertPresented = Boolean(socket.getCertificate());
      r.tlsVersion = socket.getProtocol();
      r.tlsCipher = socket.getCipher()?.name ?? null;
      socket.write(`CONNECT ${CONNECT_TARGET} HTTP/1.1\r\nHost: ${CONNECT_TARGET}\r\n\r\n`);
      r.connectSent = true;
    });
    socket.on("data", (chunk: Buffer) => {
      head += chunk.toString("latin1");
      const end = head.indexOf("\r\n\r\n");
      if (end < 0 && head.length < 8192) return;
      const lines = (end >= 0 ? head.slice(0, end) : head.slice(0, 2048)).split("\r\n");
      r.squidStatusLine = lines[0]?.slice(0, 120) ?? null;
      const header = (name: string) =>
        lines.find((l) => l.toLowerCase().startsWith(`${name}:`))?.slice(name.length + 1).trim().slice(0, 120) ?? null;
      r.squidServerHeader = header("server");
      r.squidErrorHeader = header("x-squid-error");
      // Never use the tunnel, whatever the status.
      finish(null, null);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      const stage = !r.tcpConnected ? "tcp" : !r.tlsHandshakeCompleted ? "tls" : "after_connect";
      finish(stage, error.code ?? error.name ?? "ERROR");
    });
    socket.once("close", () => finish(r.connectSent ? "after_connect" : "tcp", "CLOSED_WITHOUT_RESPONSE"));
  });
}

export type GatewayAclProbeDeps = {
  vercelEnv?: () => string | null;
  probe?: () => Promise<GatewayAclProbeResult>;
};

export async function handleGatewayAclProbe(deps: GatewayAclProbeDeps = {}): Promise<NextResponse> {
  const vercelEnv = (deps.vercelEnv ?? (() => process.env.VERCEL_ENV?.trim() || null))();
  if (vercelEnv !== "preview") {
    return NextResponse.json({ error: "Gone" }, { status: 410 });
  }
  const probe = deps.probe ?? (() => runGatewayAclProbe());
  const startedAt = new Date().toISOString();
  try {
    const result = await probe();
    const body = {
      startedAt,
      finishedAt: new Date().toISOString(),
      region: process.env.VERCEL_REGION ?? null,
      deploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? null,
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      connectTarget: CONNECT_TARGET,
      ...result,
    };
    console.log("ITA_GATEWAY_ACL_PROBE", JSON.stringify(body));
    return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("ITA_GATEWAY_ACL_PROBE_ERROR:", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json({ startedAt, error: "Probe failed" }, { status: 500, headers: { "cache-control": "no-store" } });
  }
}

export async function POST() {
  return handleGatewayAclProbe();
}
