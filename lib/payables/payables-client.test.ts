/**
 * Payables client — every request carries the session. Run:
 *   npx tsx lib/payables/payables-client.test.ts
 *
 * The regression this guards: from Phase 1b until this test existed, the
 * payables client sent NO Authorization header, so every /api/payables call from
 * the real screens was a 401 in Production. The runtime QA could not see it — it
 * answered requests at the network layer without ever looking at them. This test
 * looks at them.
 */

type Captured = { url: string; headers: Record<string, string> };
const captured: Captured[] = [];

const store = new Map<string, string>([["token", "test-session-token"]]);
(globalThis as unknown as { window: unknown }).window = globalThis;
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const headers: Record<string, string> = {};
  new Headers(init?.headers ?? {}).forEach((v, k) => (headers[k] = v));
  captured.push({ url: String(input), headers });
  const body = JSON.stringify({
    commitments: [], commitment: {}, cheques: [], cheque: {}, accounts: [], configured: true,
    account: {}, payees: [], payee: {},
  });
  const status = 200;
  return new Response(body, { status, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, extra = ""): void {
  total += 1;
  if (!cond) failures += 1;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
}

async function main() {
  const client = await import("./payables-client");

  await client.fetchCommitments("open");
  await client.fetchBankAccounts();
  await client.fetchCheques({ scope: "all" });
  await client.createBankAccount({ label: "x", bankCode: "00", branchCode: "000", accountNumber: "0000123456" });
  await client.clearCheque(1, new Date().toISOString());
  await client.searchPayees("q");

  check("six requests were made", captured.length === 6, `saw ${captured.length}`);
  for (const c of captured) {
    check(
      `${c.url.split("?")[0]} carries Authorization: Bearer <session>`,
      c.headers["authorization"] === "Bearer test-session-token",
      c.headers["authorization"] ?? "missing",
    );
    check(
      `${c.url.split("?")[0]} has exactly one JSON content type`,
      c.headers["content-type"] === "application/json",
      c.headers["content-type"] ?? "missing",
    );
  }

  const h = client.payablesRequestHeaders({ "content-type": "text/plain", "X-Extra": "1" });
  check("caller headers are kept", h["x-extra"] === "1");
  check("a caller content-type cannot produce a duplicate", Object.keys(h).filter((k) => k.toLowerCase() === "content-type").length === 1);

  let message = "";
  globalThis.fetch = (async () => new Response("{}", { status: 401 })) as typeof fetch;
  try {
    await client.fetchCheques();
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  check("a 401 tells the owner to sign in again, not a raw status", message.includes("להתחבר מחדש"), message);

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${total - failures}/${total} checks passed\n`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
