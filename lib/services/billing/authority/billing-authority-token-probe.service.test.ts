/**
 * Authority token-endpoint network probe (run manually):
 *   npx tsx lib/services/billing/authority/billing-authority-token-probe.service.test.ts
 *
 * Covers the credential-less probe result mapping (HTTP reachable + each network
 * error class), the request shape (POST, empty body, NO Authorization), and the
 * guarantee that the sanitized result never carries a URL/host/IP or raw error.
 */

import { runAuthorityTokenNetworkProbe } from "@/lib/services/billing/authority/billing-authority-token-probe.service";

let failed = 0;
function ok(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok  - ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL  - ${name}`);
  }
}

const ENDPOINT = "https://openapi.taxes.gov.il/shaam/tsandbox/longtimetoken/oauth2/token";
const deps = (fetchImpl: typeof fetch) => ({
  buildTokenEndpoint: () => ENDPOINT,
  fetchImpl,
  now: () => 1000,
  region: () => "iad1",
});

const undici = (code: string, message = "fetch failed") =>
  Object.assign(new TypeError(message), {
    cause: Object.assign(new Error(), { code }),
  });

async function main() {
  // ---- HTTP reachable ------------------------------------------------------
  {
    let seen: { method?: string; body?: unknown; auth: boolean } = { auth: true };
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen = {
        method: init?.method,
        body: init?.body,
        auth:
          "Authorization" in headers ||
          "authorization" in headers,
      };
      return new Response("", { status: 400 });
    }) as typeof fetch;

    const r = await runAuthorityTokenNetworkProbe(deps(fetchImpl));
    ok("HTTP response -> reachable true", r.networkReachable === true);
    ok("HTTP response -> httpStatusIfAny 400", r.httpStatusIfAny === 400);
    ok("HTTP response -> networkErrorClass null", r.networkErrorClass === null);
    ok("request is POST", seen.method === "POST");
    ok("request body is empty", seen.body === "");
    ok("request carries NO Authorization", seen.auth === false);
    ok("runtime nodejs", r.runtime === "nodejs");
    ok("region surfaced", r.region === "iad1");
  }

  // ---- Network error classes ----------------------------------------------
  const cases: Array<[string, string, string]> = [
    ["DNS", "ENOTFOUND", "DNS_ERROR"],
    ["TLS", "EPROTO", "TLS_ERROR"],
    ["certificate", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "CERTIFICATE_ERROR"],
    ["connect timeout", "UND_ERR_CONNECT_TIMEOUT", "CONNECT_TIMEOUT"],
    ["connection refused", "ECONNREFUSED", "CONNECTION_REFUSED"],
    ["connection reset", "ECONNRESET", "CONNECTION_RESET"],
  ];
  for (const [label, code, expected] of cases) {
    const fetchImpl = (async () => {
      throw undici(code, `connect ${code} 199.203.206.249:443`);
    }) as typeof fetch;
    const r = await runAuthorityTokenNetworkProbe(deps(fetchImpl));
    ok(`${label} -> reachable false`, r.networkReachable === false);
    ok(`${label} -> ${expected}`, r.networkErrorClass === expected);
    ok(`${label} -> httpStatusIfAny null`, r.httpStatusIfAny === null);
  }

  // ---- AbortSignal.timeout (TimeoutError) -> CONNECT_TIMEOUT ---------------
  {
    const fetchImpl = (async () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), {
        name: "TimeoutError",
      });
    }) as typeof fetch;
    const r = await runAuthorityTokenNetworkProbe(deps(fetchImpl));
    ok("TimeoutError -> CONNECT_TIMEOUT", r.networkErrorClass === "CONNECT_TIMEOUT");
  }

  // ---- No sensitive material in the result --------------------------------
  {
    const fetchImpl = (async () => {
      throw undici("ECONNREFUSED", "connect ECONNREFUSED 199.203.206.249:443");
    }) as typeof fetch;
    const r = await runAuthorityTokenNetworkProbe(deps(fetchImpl));
    const keys = Object.keys(r).sort();
    const allowed = [
      "httpStatusIfAny",
      "networkErrorClass",
      "networkReachable",
      "region",
      "requestDurationBucket",
      "runtime",
    ];
    ok("result exposes only the safe key set", JSON.stringify(keys) === JSON.stringify(allowed));
    // Inspect VALUES only (key names like `httpStatusIfAny` are not sensitive).
    const values = JSON.stringify(Object.values(r)).toLowerCase();
    ok(
      "result values carry no host/ip/url/endpoint",
      !values.includes("199.203.206.249") &&
        !values.includes("taxes.gov.il") &&
        !values.includes("openapi") &&
        !values.includes("https")
    );
    ok("duration bucket present", typeof r.requestDurationBucket === "string");
  }

  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
