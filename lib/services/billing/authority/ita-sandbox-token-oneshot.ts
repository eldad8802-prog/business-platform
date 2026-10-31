/**
 * TEMPORARY, PREVIEW-ONLY, ONE-SHOT diagnostic: the first positive path through
 * the Kamatera egress gateway after the 48h stability measurement (#36423501).
 *
 *   Vercel runtime → mTLS gateway 91.223.106.183 → Squid CONNECT (allowlisted
 *   ITA host, port 443) → ITA Sandbox token endpoint
 *
 * It runs the existing credential-less token-endpoint network probe
 * (runAuthorityTokenNetworkProbe) exactly once: a single POST with an EMPTY body
 * and NO Authorization header — no client id, secret, code, token or business
 * data. Nothing is written anywhere (no DB, no audit). The response body is never
 * read; only the HTTP status is kept.
 *
 * SAFETY (every fuse is checked before any network I/O)
 *   - VERCEL_ENV must be "preview" and VERCEL_GIT_COMMIT_REF the egress branch.
 *   - BILLING_AUTHORITY_RUNTIME_ENVIRONMENT must be SANDBOX; the SANDBOX egress
 *     config must validate and its proxy must be the fixed gateway origin.
 *   - The token endpoint must be https on an allowlisted ITA host, default port,
 *     with exactly the Sandbox token path — never the production path.
 *   - Access limits (NOT a deployment-wide single-use guarantee): the caller
 *     must present the ticket whose SHA-256 is pinned below (the ticket never
 *     leaves the operator's machine), inside a window pinned at push time.
 *     There is no shared state, so parallel requests that carry the ticket
 *     could each reach a different instance. The single attempt rests on the
 *     controlled operator: one request, no retry, then the deployment is
 *     deleted once the evidence is saved.
 *   - Only the ticket header is read: no target, host or path can come from the
 *     caller.
 *   - Transport = authorityEgressFetch only (fail closed, no direct fallback).
 *   - One fetch call, 10s bound, no retries; one start per instance, ever.
 *   - Output is sanitized: status, media type, error class, error code/name
 *     chain only. The response body is never read.
 *
 * THROWAWAY: removed in a separate cleanup commit; the deployments that carry
 * it are deleted after the evidence is preserved. Not for main.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  AUTHORITY_EGRESS_ALLOWED_HOSTS,
  authorityEgressFetch,
  isAuthorityEgressError,
  resolveAuthorityEgressConfig,
} from "@/lib/services/billing/authority/billing-authority-egress";
import {
  buildAuthorityOAuthTokenUrl,
  resolveAuthorityEnvConfig,
} from "@/lib/services/billing/authority/billing-authority-env.service";
import type {
  AuthorityOAuthDurationBucket,
  AuthorityOAuthNetworkErrorClass,
} from "@/lib/services/billing/authority/billing-authority-oauth-callback.service";
import { runAuthorityTokenNetworkProbe } from "@/lib/services/billing/authority/billing-authority-token-probe.service";

export const ONESHOT_BRANCH = "feat/ita-authority-egress";
export const ONESHOT_GATEWAY_ORIGIN = "https://91.223.106.183";
export const ONESHOT_SANDBOX_TOKEN_PATH = "/shaam/tsandbox/longtimetoken/oauth2/token";
/** SHA-256 of the operator's single-use ticket (hex). */
export const ONESHOT_TICKET_SHA256 = "db8069039a1afe80ef496056ee876c9322d8fc1721da8c275dcd9b9cc57505c7";
/** Run window, pinned at push time. Placeholders refuse every call. */
export const ONESHOT_NOT_BEFORE = "2026-10-31T19:59:32.760Z";
export const ONESHOT_NOT_AFTER = "2026-10-31T20:44:32.760Z";
const TIMEOUT_MS = 10_000;

export type OneshotOutcome = "HTTP_RESPONSE" | "NETWORK_ERROR" | "REFUSED_BY_FUSE";

export type OneshotErrorLink = { name: string | null; code: string | null };

export type OneshotResult = {
  attemptId: string | null;
  outcome: OneshotOutcome;
  fuse: string | null;
  gateway: string | null;
  tokenHost: string | null;
  tokenPath: string | null;
  fetchCalls: number;
  networkReachable: boolean;
  httpStatus: number | null;
  contentType: string | null;
  networkErrorClass: AuthorityOAuthNetworkErrorClass | null;
  durationBucket: AuthorityOAuthDurationBucket | null;
  errorChain: OneshotErrorLink[];
  elapsedMs: number;
};

type Env = Readonly<Record<string, string | undefined>>;

export type OneshotDeps = {
  env?: Env;
  /** The x-oneshot-ticket header value as received (never logged). */
  ticket?: string | null;
  /** Test seam only: replaces the pinned ticket hash and window. */
  pinned?: { ticketSha256: string; notBefore: string; notAfter: string };
  /** Test seam only: the egress transport (defaults to authorityEgressFetch). */
  fetchImpl?: typeof fetch;
  /** Test seam only: the expected gateway origin. */
  gatewayOrigin?: string;
  /** Test seam only: builds the token endpoint (defaults to the OAuth path). */
  buildTokenEndpoint?: () => string;
  timeoutMs?: number;
  now?: () => number;
};

let used = false;

export function resetOneshotForTests(): void {
  used = false;
}

function result(partial: Partial<OneshotResult>): OneshotResult {
  return {
    attemptId: null,
    outcome: "REFUSED_BY_FUSE",
    fuse: null,
    gateway: null,
    tokenHost: null,
    tokenPath: null,
    fetchCalls: 0,
    networkReachable: false,
    httpStatus: null,
    contentType: null,
    networkErrorClass: null,
    durationBucket: null,
    errorChain: [],
    elapsedMs: 0,
    ...partial,
  };
}

const refuse = (fuse: string) => result({ fuse });

const SAFE_TOKEN = /^[A-Za-z0-9_.-]{1,64}$/;

/** error / error.cause chain → names and codes only (never messages). */
export function sanitizeErrorChain(error: unknown): OneshotErrorLink[] {
  const chain: OneshotErrorLink[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const e = current as { name?: unknown; code?: unknown; cause?: unknown };
    const name = typeof e.name === "string" && SAFE_TOKEN.test(e.name) ? e.name : null;
    const code = typeof e.code === "string" && SAFE_TOKEN.test(e.code) ? e.code : null;
    chain.push({ name, code });
    current = e.cause;
  }
  return chain;
}

function ticketMatches(ticket: string | null | undefined, expectedHex: string): boolean {
  if (typeof ticket !== "string" || !/^[0-9a-f]{64}$/.test(ticket)) return false;
  const actual = createHash("sha256").update(ticket).digest();
  const expected = Buffer.from(expectedHex, "hex");
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

/** Media type only (no parameters), or null if absent / odd. */
function sanitizeContentType(value: string | null): string | null {
  const media = value?.split(";")[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9.+-]{1,40}\/[a-z0-9.+-]{1,60}$/.test(media) ? media : null;
}

function sandboxTokenEndpoint(): string {
  return buildAuthorityOAuthTokenUrl(resolveAuthorityEnvConfig("SANDBOX"));
}

export async function runSandboxTokenOneshot(deps: OneshotDeps = {}): Promise<OneshotResult> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const gatewayOrigin = deps.gatewayOrigin ?? ONESHOT_GATEWAY_ORIGIN;

  const pinned = deps.pinned ?? {
    ticketSha256: ONESHOT_TICKET_SHA256,
    notBefore: ONESHOT_NOT_BEFORE,
    notAfter: ONESHOT_NOT_AFTER,
  };

  if (used) return refuse("ALREADY_RAN_ON_INSTANCE");
  const notBefore = Date.parse(pinned.notBefore);
  const notAfter = Date.parse(pinned.notAfter);
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter) || notAfter <= notBefore) {
    return refuse("WINDOW_NOT_SET");
  }
  if (now() < notBefore || now() > notAfter) return refuse("OUTSIDE_WINDOW");
  if (!ticketMatches(deps.ticket, pinned.ticketSha256)) return refuse("TICKET_INVALID");
  if (env.VERCEL_ENV !== "preview") return refuse("NOT_PREVIEW");
  if (env.VERCEL_GIT_COMMIT_REF !== ONESHOT_BRANCH) return refuse("WRONG_BRANCH");
  if (env.BILLING_AUTHORITY_RUNTIME_ENVIRONMENT?.trim().toUpperCase() !== "SANDBOX") {
    return refuse("NOT_SANDBOX");
  }

  let proxyUrl: string;
  try {
    proxyUrl = resolveAuthorityEgressConfig(env, "SANDBOX").proxyUrl;
  } catch (error) {
    return refuse(`EGRESS_CONFIG:${isAuthorityEgressError(error) ? error.code : "INVALID"}`);
  }
  if (proxyUrl !== gatewayOrigin) return refuse("GATEWAY_MISMATCH");

  let endpoint: URL;
  try {
    endpoint = new URL((deps.buildTokenEndpoint ?? sandboxTokenEndpoint)());
  } catch {
    return refuse("TOKEN_ENDPOINT_UNRESOLVED");
  }
  const endpointOk =
    endpoint.protocol === "https:" &&
    endpoint.port === "" &&
    !endpoint.username &&
    !endpoint.password &&
    !endpoint.search &&
    !endpoint.hash &&
    AUTHORITY_EGRESS_ALLOWED_HOSTS.includes(endpoint.hostname) &&
    endpoint.pathname === ONESHOT_SANDBOX_TOKEN_PATH;
  if (!endpointOk) return refuse("TOKEN_ENDPOINT_UNEXPECTED");

  // Past every fuse: this instance never starts another attempt.
  used = true;
  const attemptId = `${new Date(now()).toISOString().replace(/[-:.]/g, "").toLowerCase()}-${randomBytes(3).toString("hex")}`;
  const transport = deps.fetchImpl ?? authorityEgressFetch;
  let fetchCalls = 0;
  let errorChain: OneshotErrorLink[] = [];
  let contentType: string | null = null;
  const fetchOnce: typeof fetch = async (input, init) => {
    fetchCalls += 1;
    if (fetchCalls > 1) throw new Error("oneshot: second fetch refused");
    try {
      const response = await transport(input, init);
      contentType = sanitizeContentType(response.headers.get("content-type"));
      return response;
    } catch (error) {
      errorChain = sanitizeErrorChain(error);
      throw error;
    }
  };

  const startedAt = now();
  const probe = await runAuthorityTokenNetworkProbe({
    buildTokenEndpoint: () => endpoint.href,
    fetchImpl: fetchOnce,
    now,
    timeoutMs: deps.timeoutMs ?? TIMEOUT_MS,
  });

  return result({
    attemptId,
    outcome: probe.networkReachable ? "HTTP_RESPONSE" : "NETWORK_ERROR",
    gateway: gatewayOrigin,
    tokenHost: endpoint.hostname,
    tokenPath: endpoint.pathname,
    fetchCalls,
    networkReachable: probe.networkReachable,
    httpStatus: probe.httpStatusIfAny,
    contentType,
    networkErrorClass: probe.networkErrorClass,
    durationBucket: probe.requestDurationBucket,
    errorChain,
    elapsedMs: now() - startedAt,
  });
}
