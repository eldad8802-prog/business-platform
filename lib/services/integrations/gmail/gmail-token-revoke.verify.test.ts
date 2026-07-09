/**
* gmail-token-revoke tests (mocked - no real Google endpoint).
* npx tsx lib/services/integrations/gmail/gmail-token-revoke.verify.test.ts
*/
import assert from "node:assert/strict";
import { revokeGoogleGmailToken } from "./gmail-token-revoke.service";

function fakeFetch(
  impl: (url: string, init?: RequestInit) => Promise<Response>
  ): typeof fetch {
  return impl as unknown as typeof fetch;
}

async function run(): Promise<void> {
  // --- No token ---
const noToken = await revokeGoogleGmailToken(null);
  assert.equal(noToken.ok, false);
  if (!noToken.ok) assert.equal(noToken.reason, "no_token");

const emptyToken = await revokeGoogleGmailToken("   ");
  assert.equal(emptyToken.ok, false);
  if (!emptyToken.ok) assert.equal(emptyToken.reason, "no_token");

// --- Success ---
let calledUrl = "";
  let calledBody = "";
  const success = await revokeGoogleGmailToken("real-token", {
    fetchImpl: fakeFetch(async (url, init) => {
      calledUrl = url;
      calledBody = String(init?.body ?? "");
      return new Response(null, { status: 200 });
    }),
  });
  assert.equal(success.ok, true);
  assert.equal(calledUrl, "https://oauth2.googleapis.com/revoke");
  assert.equal(calledBody, "token=real-token");

// --- HTTP error (e.g. invalid_token) ---
const httpError = await revokeGoogleGmailToken("bad-token", {
  fetchImpl: fakeFetch(async () => new Response(null, { status: 400 })),
});
  assert.equal(httpError.ok, false);
  if (!httpError.ok) assert.equal(httpError.reason, "http_error");

// --- Network error ---
const networkError = await revokeGoogleGmailToken("token", {
  fetchImpl: fakeFetch(async () => {
    throw new TypeError("network down");
  }),
});
  assert.equal(networkError.ok, false);
  if (!networkError.ok) assert.equal(networkError.reason, "network_error");

// --- Timeout (AbortError) ---
const timeout = await revokeGoogleGmailToken("token", {
  fetchImpl: fakeFetch(async () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  }),
});
  assert.equal(timeout.ok, false);
  if (!timeout.ok) assert.equal(timeout.reason, "timeout");

console.log("gmail-token-revoke tests: OK");
}

void run().catch((err) => {
  console.error(err);
  process.exit(1);
});
