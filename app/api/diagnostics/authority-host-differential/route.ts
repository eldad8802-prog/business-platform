/**
 * TEMPORARY, PREVIEW-ONLY diagnostic: ITA OAuth token-host differential.
 *
 * Path: POST /api/diagnostics/authority-host-differential
 *
 * Answers exactly one question, from Dubiz's own Vercel runtime, in one run:
 * is the ITA OAuth *token* endpoint reachable on `ita-api` while it is not
 * reachable on `openapi`? Both targets are probed back to back so the two
 * results share a runtime, a region and a moment in time.
 *
 * WHY A SEPARATE ROUTE, not a change to the existing token probe:
 *   - the existing probe resolves its target from AUTHORITY_* env, so it can
 *     only ever hit one host and needs authority config to exist;
 *   - this one hardcodes two PUBLIC, officially published hostnames, so it needs
 *     NO authority env, NO client id/secret and NO database at all.
 *     Nothing has to be copied into Preview to run it.
 *
 * WHY IT LIVES UNDER /api/diagnostics AND NOT /api/platform-admin: it carries no
 * platform-admin guard (see SAFETY), and CI-3 in scripts/ci/admin-boundary-guard.sh
 * requires every route under app/api/platform-admin/** to call
 * requirePlatformAdmin. An unguarded route does not belong in the admin
 * namespace, and the guard correctly refuses one — so it sits outside it.
 *
 * SAFETY
 *   - PREVIEW-ONLY FUSE: unless `VERCEL_ENV === "preview"` this route answers
 *     410 and does nothing else. Production, Development and any unknown
 *     environment are all refused. The check runs first, so an accidental merge
 *     cannot arm this in prod.
 *   - NO application-level admin guard, DELIBERATELY, and ONLY on this one
 *     throwaway route. The Preview database holds no PLATFORM_ADMIN user
 *     (verified read-only: 16 users, every one of them role USER), so the
 *     canonical guard is unsatisfiable there and the experiment could not run at
 *     all. The owner explicitly approved relying on Vercel SSO instead, which
 *     already fronts every Preview deployment of both projects.
 *     `assertPlatformAdminAccess`, the shared auth helpers, the middleware and
 *     every other route are UNCHANGED by this branch.
 *   - Credential-less by construction: empty body, no Authorization header, no
 *     grant_type, no code. It cannot mint, refresh or spend a token, and it
 *     touches no business endpoint.
 *   - No DB reads, no DB writes, no audit events. Returns only sanitized network
 *     facts — never a URL, host, header, body, certificate, token or raw error.
 *
 * TIMEOUT DESIGN (deliberately different from the existing probe): the guard
 * timeout is 20s, comfortably ABOVE undici's own 10s connect timeout, so a dead
 * TCP path surfaces as a genuine `UND_ERR_CONNECT_TIMEOUT` from the transport
 * rather than as our own AbortSignal firing. The existing probe used a 10s abort,
 * which made "connect timeout" and "we gave up" indistinguishable.
 *
 * THROWAWAY: delete this route together with the diag/authority-host-differential
 * branch once the token-host question is settled. It is not meant for main.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  mapNetworkErrorClass,
  toDurationBucket,
  type AuthorityOAuthDurationBucket,
  type AuthorityOAuthNetworkErrorClass,
} from "@/lib/services/billing/authority/billing-authority-oauth-callback.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Guard timeout, above undici's 10s connect timeout — see TIMEOUT DESIGN. */
export const HOST_DIFFERENTIAL_TIMEOUT_MS = 20_000;

/**
 * The two officially published Sandbox token endpoints. Identical path,
 * protocol, port and environment segment — only the host differs, which is the
 * whole point of the differential. Public values; not secrets.
 */
export const HOST_DIFFERENTIAL_TARGETS = {
  openapi: "https://openapi.taxes.gov.il/shaam/tsandbox/longtimetoken/oauth2/token",
  itaApi: "https://ita-api.taxes.gov.il/shaam/tsandbox/longtimetoken/oauth2/token",
} as const;

export type HostDifferentialTargetKey = keyof typeof HOST_DIFFERENTIAL_TARGETS;

/**
 * Transport error codes we are willing to echo. An allowlist, not the raw code:
 * an unrecognised value becomes null so nothing unexpected can reach the client.
 */
const SAFE_TRANSPORT_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPROTO",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

export type HostProbeResult = {
  target: HostDifferentialTargetKey;
  /** True once any HTTP response was read, whatever its status. */
  httpResponseReceived: boolean;
  httpStatus: number | null;
  networkErrorClass: AuthorityOAuthNetworkErrorClass | null;
  /** Allowlisted transport code, or null. Disambiguates the timeout bucket. */
  transportCode: string | null;
  durationMs: number;
  durationBucket: AuthorityOAuthDurationBucket;
};

export type HostDifferentialResult = {
  results: HostProbeResult[];
  runtime: "nodejs";
  region: string | null;
  vercelEnv: string | null;
};

/** Walks `error` and `error.cause` for an allowlisted transport code. */
export function extractTransportCode(error: unknown): string | null {
  const seen: unknown[] = [error, (error as { cause?: unknown } | null)?.cause];
  for (const candidate of seen) {
    const code = (candidate as { code?: unknown } | null)?.code;
    if (typeof code === "string" && SAFE_TRANSPORT_CODES.has(code)) {
      return code;
    }
  }
  return null;
}

/**
 * Probes one target once. Never throws: a transport failure becomes a result.
 * Any HTTP status counts as reachable — a 400 proves DNS, TCP, TLS and HTTP all
 * completed, which is exactly what this experiment is measuring.
 */
export async function probeHost(
  target: HostDifferentialTargetKey,
  deps: { fetchImpl?: typeof fetch; now?: () => number; timeoutMs?: number } = {}
): Promise<HostProbeResult> {
  const fetchFn = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? HOST_DIFFERENTIAL_TIMEOUT_MS;

  const startedAt = now();
  try {
    const response = await fetchFn(HOST_DIFFERENTIAL_TARGETS[target], {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const elapsed = now() - startedAt;
    return {
      target,
      httpResponseReceived: true,
      httpStatus: response.status,
      networkErrorClass: null,
      transportCode: null,
      durationMs: elapsed,
      durationBucket: toDurationBucket(elapsed),
    };
  } catch (error) {
    const elapsed = now() - startedAt;
    const name = (error as { name?: unknown } | null)?.name;
    return {
      target,
      httpResponseReceived: false,
      httpStatus: null,
      // Our own abort stays distinguishable from a transport connect timeout.
      networkErrorClass:
        name === "TimeoutError" ? "ABORTED" : mapNetworkErrorClass(error),
      transportCode: extractTransportCode(error),
      durationMs: elapsed,
      durationBucket: toDurationBucket(elapsed),
    };
  }
}

export type HostDifferentialDeps = {
  probe?: typeof probeHost;
  vercelEnv?: () => string | null;
  region?: () => string | null;
};

export async function handleHostDifferential(
  _req: NextRequest,
  deps: HostDifferentialDeps = {}
): Promise<NextResponse> {
  const probe = deps.probe ?? probeHost;
  const vercelEnv =
    deps.vercelEnv ?? (() => process.env.VERCEL_ENV?.trim() || null);
  const region = deps.region ?? (() => process.env.VERCEL_REGION?.trim() || null);

  try {
    // Fuse FIRST, before any work: Preview and nothing else. An allowlist rather
    // than a production denylist, so Production, Development and an unset/unknown
    // VERCEL_ENV are all refused by default.
    const env = vercelEnv();
    if (env !== "preview") {
      return NextResponse.json(
        { error: "Diagnostic available only in Preview" },
        { status: 410, headers: { "cache-control": "no-store" } }
      );
    }

    // Sequential, not parallel: keeps the two measurements from contending for
    // sockets or DNS and makes the durations directly comparable.
    const results: HostProbeResult[] = [];
    for (const target of ["openapi", "itaApi"] as HostDifferentialTargetKey[]) {
      results.push(await probe(target));
    }

    const body: HostDifferentialResult = {
      results,
      runtime: "nodejs",
      region: region(),
      vercelEnv: env,
    };
    return NextResponse.json(body, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    console.error(
      "AUTHORITY_HOST_DIFFERENTIAL_ERROR:",
      error instanceof Error ? error.name : "UnknownError"
    );
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  return handleHostDifferential(req);
}
