/**
 * Bounded authorization-code token exchange (run manually):
 *   npx tsx lib/services/billing/authority/billing-authority-oauth-token-timeout.verify.test.ts
 *
 * No real network: fetch is always injected. Proves the exchange is bounded,
 * attempted exactly once, never retried, and that a timeout is classified as an
 * uncertain outcome (the code may have been consumed) with sanitized
 * diagnostics only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AUTHORITY_OAUTH_CALLBACK_ERROR_CODES,
  AUTHORITY_TOKEN_EXCHANGE_TIMEOUT_MS,
  AuthorityOAuthCallbackError,
  exchangeAuthorityAuthorizationCode,
} from "@/lib/services/billing/authority/billing-authority-oauth-callback.service";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else {
    failed += 1;
    console.error(`FAIL: ${name}`, extra ?? "");
  }
}

const CLIENT_ID = "client-id-SENTINEL-1111";
const CLIENT_SECRET = "client-secret-SENTINEL-2222";
const CODE = "auth-code-SENTINEL-3333";
const BASE = {
  tokenEndpoint: "https://openapi.taxes.gov.il/shaam/tsandbox/longtimetoken/oauth2/token",
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  code: CODE,
  redirectUri: "http://localhost:3000/api/taxes/oauth/callback",
};

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Rejects with the signal's reason when it aborts; otherwise never settles. */
function waitForAbort(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (!signal) return;
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

async function run(fetchImpl: typeof fetch, timeoutMs?: number): Promise<unknown> {
  try {
    return await exchangeAuthorityAuthorizationCode({ ...BASE, fetchImpl, timeoutMs });
  } catch (error) {
    return error;
  }
}

function assertSanitized(label: string, error: unknown): void {
  const text = [
    String(error),
    (error as Error)?.stack ?? "",
    JSON.stringify((error as AuthorityOAuthCallbackError)?.diagnostics ?? {}),
  ].join("\n");
  ok(`${label}: no client id / secret / code / token in error`,
    ![CLIENT_ID, CLIENT_SECRET, CODE, "access-SENTINEL", "refresh-SENTINEL"].some((s) => text.includes(s)));
}

async function main(): Promise<void> {
  // AbortSignal.timeout uses an unref'd timer; keep this standalone script alive
  // while it waits on it (a server process always has a live event loop).
  const keepAlive = setInterval(() => undefined, 1_000);
  ok("timeout constant is 20s", AUTHORITY_TOKEN_EXCHANGE_TIMEOUT_MS === 20_000);

  // 1 + 5. Signal supplied; success path unchanged.
  {
    let calls = 0;
    let seenSignal: AbortSignal | null | undefined;
    const fake = (async (_url: unknown, init?: RequestInit) => {
      calls += 1;
      seenSignal = init?.signal;
      return new Response(
        JSON.stringify({ access_token: "access-SENTINEL", token_type: "Bearer", expires_in: 3600, refresh_token: "refresh-SENTINEL" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;
    const res = (await run(fake)) as { access_token?: string; refresh_token?: string };
    ok("1: an AbortSignal is supplied to fetch", seenSignal instanceof AbortSignal);
    ok("1: default signal is not already aborted", seenSignal?.aborted === false);
    ok("5: success returns the parsed token response",
      res?.access_token === "access-SENTINEL" && res?.refresh_token === "refresh-SENTINEL", res);
    ok("5: success performs exactly one fetch", calls === 1);
  }

  // 2 + 3 + 4. Timeout before any response → uncertain, one call, no retry.
  {
    let calls = 0;
    const fake = ((_url: unknown, init?: RequestInit) => {
      calls += 1;
      return waitForAbort(init?.signal);
    }) as typeof fetch;
    const started = Date.now();
    const err = await run(fake, 60);
    const elapsed = Date.now() - started;
    const e = err as AuthorityOAuthCallbackError;
    ok("2: timeout → TOKEN_EXCHANGE_OUTCOME_UNCERTAIN",
      e instanceof AuthorityOAuthCallbackError &&
        e.errorCode === AUTHORITY_OAUTH_CALLBACK_ERROR_CODES.TOKEN_EXCHANGE_OUTCOME_UNCERTAIN, err);
    ok("2: diagnostics = TOKEN_EXCHANGE / REQUEST_TIMEOUT / no provider status",
      e?.diagnostics?.stage === "TOKEN_EXCHANGE" &&
        e?.diagnostics?.networkErrorClass === "REQUEST_TIMEOUT" &&
        e?.diagnostics?.providerHttpStatus === null, e?.diagnostics);
    ok("2: the bound is honoured (settles near the timeout)", elapsed < 2_000, elapsed);
    ok("3: fetch invoked exactly once", calls === 1, calls);
    await pause(250);
    ok("4: no retry after the timeout", calls === 1, calls);
    assertSanitized("2", err);
  }

  // 2b. Timeout while reading the body of a response that already arrived.
  {
    let calls = 0;
    const fake = (async (_url: unknown, init?: RequestInit) => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        text: () => waitForAbort(init?.signal),
      } as unknown as Response;
    }) as typeof fetch;
    const err = await run(fake, 60);
    const e = err as AuthorityOAuthCallbackError;
    ok("2b: body-read timeout → TOKEN_EXCHANGE_OUTCOME_UNCERTAIN",
      e?.errorCode === AUTHORITY_OAUTH_CALLBACK_ERROR_CODES.TOKEN_EXCHANGE_OUTCOME_UNCERTAIN, err);
    ok("2b: records the provider status that had arrived", e?.diagnostics?.providerHttpStatus === 200, e?.diagnostics);
    await pause(150);
    ok("2b: exactly one fetch, no retry", calls === 1, calls);
    assertSanitized("2b", err);
  }

  // A non-timeout network failure keeps the pre-existing classification.
  {
    let calls = 0;
    const fake = (async () => {
      calls += 1;
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    }) as typeof fetch;
    const e = (await run(fake)) as AuthorityOAuthCallbackError;
    ok("non-timeout failure stays TOKEN_EXCHANGE_FAILED",
      e?.errorCode === AUTHORITY_OAUTH_CALLBACK_ERROR_CODES.TOKEN_EXCHANGE_FAILED &&
        e?.diagnostics?.networkErrorClass === "CONNECTION_RESET", e?.diagnostics);
    ok("non-timeout failure: exactly one fetch", calls === 1);
  }

  // A provider rejection is unchanged.
  {
    const fake = (async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as typeof fetch;
    const e = (await run(fake)) as AuthorityOAuthCallbackError;
    ok("provider 400 stays TOKEN_EXCHANGE_REJECTED",
      e?.errorCode === AUTHORITY_OAUTH_CALLBACK_ERROR_CODES.TOKEN_EXCHANGE_REJECTED &&
        e?.diagnostics?.providerHttpStatus === 400, e?.diagnostics);
  }

  // 6. Default production transport is still the authority egress fetch, and
  // nothing in the callback path loops over the exchange.
  {
    const src = readFileSync(
      join(process.cwd(), "lib/services/billing/authority/billing-authority-oauth-callback.service.ts"),
      "utf8"
    );
    const fn = src.slice(src.indexOf("export async function exchangeAuthorityAuthorizationCode"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    ok("6: default transport is authorityEgressFetch", /input\.fetchImpl \?\? authorityEgressFetch/.test(body));
    ok("6: exchange passes the bounded signal", /signal,/.test(body) && /AbortSignal\.timeout\(/.test(body));
    ok("6: exchange contains no loop", !/\b(for|while)\s*\(/.test(body));
    const calls = src.match(/exchangeAuthorityAuthorizationCode\(/g) ?? [];
    ok("6: exactly one call-site of the exchange in the callback service", calls.length === 2, calls.length);
  }

  clearInterval(keepAlive);
  if (failed > 0) {
    console.error(`\n${failed} FAILED`);
    process.exit(1);
  }
  console.log("\nALL PASS");
}

void main();
