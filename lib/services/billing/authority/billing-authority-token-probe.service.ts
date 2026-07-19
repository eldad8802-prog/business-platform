/**
 * Authority token-endpoint NETWORK probe (temporary diagnostic).
 *
 * Reproduces ONLY the network layer of the OAuth token exchange — DNS → TCP →
 * TLS → connect — from the deployment's own runtime/region, WITHOUT an
 * authorization code or any credentials. The network layer is established before
 * the provider ever reads the request body/credentials, so a credential-less
 * POST to the identical token endpoint exercises the exact same path and
 * reproduces the same class of network failure.
 *
 * Returns ONLY a sanitized result: reachability, an HTTP status if any, the
 * safe network-error class, a coarse duration bucket, the runtime, and the
 * region. Never the URL, host, IP, headers, body, certificate, tokens, secrets,
 * stack, or raw error message. No DB writes, no audit events, no projections.
 */

import {
  mapNetworkErrorClass,
  toDurationBucket,
  type AuthorityOAuthDurationBucket,
  type AuthorityOAuthNetworkErrorClass,
} from "@/lib/services/billing/authority/billing-authority-oauth-callback.service";
import {
  buildAuthorityOAuthTokenUrl,
  resolveAuthorityEnvConfig,
  resolveRuntimeAuthorityEnvironment,
} from "@/lib/services/billing/authority/billing-authority-env.service";

export const AUTHORITY_TOKEN_PROBE_TIMEOUT_MS = 10_000;

export type AuthorityTokenProbeResult = {
  networkReachable: boolean;
  httpStatusIfAny: number | null;
  networkErrorClass: AuthorityOAuthNetworkErrorClass | null;
  requestDurationBucket: AuthorityOAuthDurationBucket;
  runtime: "nodejs";
  region: string | null;
};

export type AuthorityTokenProbeDeps = {
  /** Builds the token endpoint (defaults to the exact OAuth production path). */
  buildTokenEndpoint?: () => string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  region?: () => string | null;
  timeoutMs?: number;
};

/**
 * Classifies a probe error. Our own AbortSignal.timeout surfaces as a
 * `TimeoutError`; treat it as a connect timeout (the request did not complete
 * within the bound). Everything else defers to the shared network classifier.
 */
function classifyProbeError(error: unknown): AuthorityOAuthNetworkErrorClass {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "TimeoutError") return "CONNECT_TIMEOUT";
  return mapNetworkErrorClass(error);
}

/**
 * Runs the credential-less network probe exactly once (no retries) with a hard
 * timeout. Builds the endpoint via the same code the real OAuth flow uses.
 */
export async function runAuthorityTokenNetworkProbe(
  deps: AuthorityTokenProbeDeps = {}
): Promise<AuthorityTokenProbeResult> {
  const buildEndpoint =
    deps.buildTokenEndpoint ??
    (() =>
      buildAuthorityOAuthTokenUrl(
        resolveAuthorityEnvConfig(resolveRuntimeAuthorityEnvironment())
      ));
  const fetchFn = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const region =
    deps.region ?? (() => process.env.VERCEL_REGION?.trim() || null);
  const timeoutMs = deps.timeoutMs ?? AUTHORITY_TOKEN_PROBE_TIMEOUT_MS;

  // May throw on misconfiguration — surfaced to the caller as a generic 500.
  const tokenEndpoint = buildEndpoint();

  const startedAt = now();
  try {
    const response = await fetchFn(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      networkReachable: true,
      httpStatusIfAny: response.status,
      networkErrorClass: null,
      requestDurationBucket: toDurationBucket(now() - startedAt),
      runtime: "nodejs",
      region: region(),
    };
  } catch (error) {
    return {
      networkReachable: false,
      httpStatusIfAny: null,
      networkErrorClass: classifyProbeError(error),
      requestDurationBucket: toDurationBucket(now() - startedAt),
      runtime: "nodejs",
      region: region(),
    };
  }
}
