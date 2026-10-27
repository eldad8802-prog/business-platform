/**
 * Bank file import (B1) — the browser client, without a browser. A browser walkthrough found that the screen
 * called its routes WITHOUT the session's Bearer token (the app keeps it in localStorage, there is no auth
 * cookie): every call answered 401, the screen said "not open" for a business that had it. This proves every
 * request now carries the token, sends a real multipart body (no forced Content-Type), and keys decisions by
 * row number exactly as the server parses them.
 *
 * Run: npx tsx lib/bank-file-import/bank-import-client.test.ts
 */
let total = 0;
let failures = 0;
function check(name: string, cond: boolean, extra = ""): void {
  total += 1;
  if (!cond) failures += 1;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra && !cond ? " — " + extra : ""}`);
}

type Call = { url: string; init: RequestInit };
const calls: Call[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };
const store = new Map<string, string>();

(globalThis as unknown as { window: unknown }).window = globalThis;
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
  calls.push({ url: String(url), init });
  const { status, body } = nextResponse;
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const headerOf = (init: RequestInit, name: string): string | null => new Headers(init.headers ?? {}).get(name);

(async () => {
  const client = await import("./bank-import-client");
  store.set("token", "synthetic-token");

  console.log("Every request carries the session's Bearer token");
  nextResponse = { status: 200, body: { enabled: true } };
  check("status: open when the route answers 200", (await client.fetchBankImportOpen()) === true);
  check("status: sent with Authorization: Bearer <token>", headerOf(calls[0].init, "authorization") === "Bearer synthetic-token", JSON.stringify(calls[0].init.headers));
  nextResponse = { status: 404, body: { error: "Not found" } };
  check("status: closed when the flag is OFF (404)", (await client.fetchBankImportOpen()) === false);

  const file = new File([new Uint8Array([0xff, 0xfe, 0x41, 0x00])], "statement.csv");
  const form = client.buildBankImportForm({ file, accountId: 7, mapping: { amount: 3, balance: null }, token: "tok", decisions: { 12: "IMPORT", 4: "SKIP" } });
  nextResponse = { status: 200, body: { status: "READY", token: "t" } };
  const ok = await client.postBankImport<{ status: string }>("analyze", form);
  const post = calls[calls.length - 1];
  check("analyze: the JSON body comes back", ok.status === "READY");
  check("analyze: posted to /api/payables/bank-import/analyze", post.url === "/api/payables/bank-import/analyze" && post.init.method === "POST");
  check("analyze: sent with the Bearer token", headerOf(post.init, "authorization") === "Bearer synthetic-token");
  check("analyze: no Content-Type forced (the browser sets the multipart boundary)", headerOf(post.init, "content-type") === null);
  check("analyze: the body is the FormData itself", post.init.body instanceof FormData);

  console.log("The multipart body");
  check("file, account, mapping and token are set", form.get("file") instanceof File && form.get("accountId") === "7" && form.get("mapping") === JSON.stringify({ amount: 3, balance: null }) && form.get("token") === "tok");
  const decisions = JSON.parse(String(form.get("decisions")));
  check("decisions are keyed by row number (digits), valued IMPORT / SKIP", JSON.stringify(Object.keys(decisions).sort()) === JSON.stringify(["12", "4"]) && decisions["12"] === "IMPORT" && decisions["4"] === "SKIP");
  const bare = client.buildBankImportForm({ file, accountId: 7 });
  check("nothing optional is sent when there is nothing to send", bare.get("mapping") === null && bare.get("token") === null && bare.get("decisions") === null);

  console.log("Errors keep the status and the server's code");
  nextResponse = { status: 409, body: { error: "DECISIONS_REQUIRED" } };
  const e1 = await client.postBankImport("commit", bare).catch((e) => e);
  check("409 DECISIONS_REQUIRED surfaces as such", e1 instanceof client.BankImportRequestError && e1.status === 409 && e1.code === "DECISIONS_REQUIRED");
  nextResponse = { status: 401, body: { error: "Unauthorized" } };
  const e2 = await client.postBankImport("commit", bare).catch((e) => e);
  check("401 surfaces as 401 (the screen says the session expired)", e2 instanceof client.BankImportRequestError && e2.status === 401);

  store.delete("token");
  nextResponse = { status: 401, body: {} };
  await client.fetchBankImportOpen();
  check("signed out: no Authorization header is invented", headerOf(calls[calls.length - 1].init, "authorization") === null);

  console.log(`\n${total - failures}/${total} passed`);
  if (failures) process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
