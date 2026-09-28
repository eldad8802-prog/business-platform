/**
 * Server-side Embedded Signup completion. Run with:
 *   npx tsx lib/services/integrations/whatsapp/embedded-signup-complete.test.ts
 *
 * Part 1 — `completeEmbeddedSignup` with injected Graph/persist fakes: the
 * order (exchange → display → subscribe → persist), "no write unless every
 * Graph step succeeded", and that no response or log carries the code/token.
 *
 * Part 2 — graph.service: every connect-flow Graph call carries an abort
 * signal, and a timeout maps to a named `*_timeout` failure.
 *
 * No network, no database.
 */
import assert from "node:assert/strict";
import {
  completeEmbeddedSignup,
  type EmbeddedSignupCompleteDeps,
} from "./embedded-signup-complete";
import {
  exchangeCodeForToken,
  fetchPhoneNumberDisplay,
  fetchWabaPhoneNumber,
  GRAPH_CONNECT_TIMEOUT_MS,
  subscribeWabaToApp,
} from "./graph.service";
import type { PublicConnection } from "./connection.service";

const BODY = { code: "CODE_SECRET", phoneNumberId: "PN1", wabaId: "WABA1" };
const TOKEN = "EAAG_TOKEN_SECRET";

const CONNECTION: PublicConnection = {
  businessId: 7,
  status: "CONNECTED",
  phoneNumberId: "PN1",
  displayPhoneNumber: "+972 50-000-0000",
  wabaId: "WABA1",
  lastVerifiedAt: new Date(0),
  lastErrorAt: null,
  lastErrorCode: null,
  lastErrorMessage: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
} as PublicConnection;

function fakes(over: Partial<EmbeddedSignupCompleteDeps> = {}) {
  const order: string[] = [];
  const warnings: unknown[] = [];
  const persisted: unknown[] = [];
  const deps: EmbeddedSignupCompleteDeps = {
    exchangeCodeForToken: async () => {
      order.push("exchange");
      return { ok: true, accessToken: TOKEN };
    },
    fetchPhoneNumberDisplay: async () => {
      order.push("display");
      return { ok: true, displayPhoneNumber: "+972 50-000-0000", verifiedName: null };
    },
    fetchWabaPhoneNumber: async () => {
      order.push("waba_phones");
      return { ok: true, phoneNumberId: "PN_FROM_WABA", displayPhoneNumber: "+972 52-111-1111" };
    },
    subscribeWabaToApp: async () => {
      order.push("subscribe");
      return { ok: true };
    },
    persistFromEmbeddedSignup: async (input) => {
      order.push("persist");
      persisted.push(input);
      return CONNECTION;
    },
    warn: (event, fields) => warnings.push({ event, fields }),
    ...over,
  };
  return { deps, order, warnings, persisted };
}

let checks = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  checks++;
  console.log(`  ok  ${name}`);
}

function noSecrets(label: string, value: unknown) {
  const dump = JSON.stringify(value);
  for (const s of ["CODE_SECRET", TOKEN]) {
    assert.equal(dump.includes(s), false, `${label}: '${s}' must not appear`);
  }
}

async function main() {
  console.log("\nEmbedded Signup completion (server)\n");

  await test("success → 201, steps in order, persisted to the SESSION business with the resolved display number", async () => {
    const f = fakes();
    const out = await completeEmbeddedSignup({ businessId: 7, body: { ...BODY, businessId: 999 } }, f.deps);
    assert.equal(out.status, 201);
    assert.deepEqual(f.order, ["exchange", "display", "subscribe", "persist"]);
    assert.deepEqual(f.persisted[0], {
      businessId: 7,
      phoneNumberId: "PN1",
      displayPhoneNumber: "+972 50-000-0000",
      wabaId: "WABA1",
      accessToken: TOKEN,
    });
    assert.ok("connection" in out.body);
  });

  for (const missing of ["code", "wabaId"] as const) {
    await test(`missing ${missing} → 400, no Graph call, no write`, async () => {
      const f = fakes();
      const body: Record<string, unknown> = { ...BODY };
      delete body[missing];
      const out = await completeEmbeddedSignup({ businessId: 7, body }, f.deps);
      assert.equal(out.status, 400);
      assert.deepEqual(f.order, []);
      assert.equal((out.body as { stage: string }).stage, "input");
    });
  }

  await test("coexistence (no phoneNumberId) → the WABA's single number is resolved and persisted", async () => {
    const f = fakes();
    const out = await completeEmbeddedSignup({ businessId: 7, body: { code: "CODE_SECRET", wabaId: "WABA1" } }, f.deps);
    assert.equal(out.status, 201);
    assert.deepEqual(f.order, ["exchange", "waba_phones", "subscribe", "persist"]);
    assert.deepEqual(f.persisted[0], {
      businessId: 7,
      phoneNumberId: "PN_FROM_WABA",
      displayPhoneNumber: "+972 52-111-1111",
      wabaId: "WABA1",
      accessToken: TOKEN,
    });
  });

  for (const code of ["phones_none", "phones_multiple", "phones_timeout"]) {
    await test(`coexistence resolution failure (${code}) → 502 stage=display, no subscribe, no write`, async () => {
      const f = fakes({ fetchWabaPhoneNumber: async () => ({ ok: false, code, message: "m" }) });
      const out = await completeEmbeddedSignup({ businessId: 7, body: { code: "CODE_SECRET", wabaId: "WABA1" } }, f.deps);
      assert.equal(out.status, 502);
      assert.equal((out.body as { code: string }).code, code);
      assert.deepEqual(f.order, ["exchange"]);
      assert.equal(f.persisted.length, 0);
    });
  }

  await test("token exchange failure → 502 stage=exchange, nothing after it runs, no write", async () => {
    const f = fakes({
      exchangeCodeForToken: async () => ({ ok: false, code: "exchange_400_100", message: "Invalid code" }),
    });
    const out = await completeEmbeddedSignup({ businessId: 7, body: BODY }, f.deps);
    assert.equal(out.status, 502);
    assert.deepEqual(out.body, {
      error: "Could not complete WhatsApp connection",
      stage: "exchange",
      code: "exchange_400_100",
    });
    assert.deepEqual(f.order, []);
    assert.equal(f.persisted.length, 0);
    assert.equal(JSON.stringify(out.body).includes("Invalid code"), false, "Graph message not echoed");
  });

  await test("phone-number resolution failure → 502 stage=display, no subscribe, no write", async () => {
    const f = fakes({
      fetchPhoneNumberDisplay: async () => ({ ok: false, code: "display_timeout", message: "t" }),
    });
    const out = await completeEmbeddedSignup({ businessId: 7, body: BODY }, f.deps);
    assert.equal(out.status, 502);
    assert.equal((out.body as { stage: string }).stage, "display");
    assert.equal((out.body as { code: string }).code, "display_timeout");
    assert.deepEqual(f.order, ["exchange"]);
    assert.equal(f.persisted.length, 0);
  });

  await test("WABA subscription failure → 502 stage=subscribe, NO write (no CONNECTED row without webhooks)", async () => {
    const f = fakes({
      subscribeWabaToApp: async () => ({ ok: false, code: "subscribe_403_200", message: "perm" }),
    });
    const out = await completeEmbeddedSignup({ businessId: 7, body: BODY }, f.deps);
    assert.equal(out.status, 502);
    assert.equal((out.body as { stage: string }).stage, "subscribe");
    assert.deepEqual(f.order, ["exchange", "display"]);
    assert.equal(f.persisted.length, 0);
  });

  await test("number already bound to another business (P2002) → 409 number_taken", async () => {
    const f = fakes({
      persistFromEmbeddedSignup: async () => {
        throw Object.assign(new Error("unique"), { code: "P2002" });
      },
    });
    const out = await completeEmbeddedSignup({ businessId: 7, body: BODY }, f.deps);
    assert.equal(out.status, 409);
    assert.equal((out.body as { code: string }).code, "number_taken");
  });

  await test("persistence failure → 500 persist_failed, the error text is not echoed", async () => {
    const f = fakes({
      persistFromEmbeddedSignup: async () => {
        throw new Error("WHATSAPP_TOKEN_ENCRYPTION_KEY invalid");
      },
    });
    const out = await completeEmbeddedSignup({ businessId: 7, body: BODY }, f.deps);
    assert.equal(out.status, 500);
    assert.equal((out.body as { code: string }).code, "persist_failed");
    assert.equal(JSON.stringify(out.body).includes("ENCRYPTION"), false);
    assert.equal(JSON.stringify(f.warnings).includes("ENCRYPTION"), false);
  });

  await test("no response body or log line ever carries the code or the access token", async () => {
    const scenarios: Array<Partial<EmbeddedSignupCompleteDeps>> = [
      {},
      { exchangeCodeForToken: async () => ({ ok: false, code: "exchange_400", message: "m" }) },
      { fetchPhoneNumberDisplay: async () => ({ ok: false, code: "display_400", message: "m" }) },
      { subscribeWabaToApp: async () => ({ ok: false, code: "subscribe_400", message: "m" }) },
      {
        persistFromEmbeddedSignup: async () => {
          throw new Error(TOKEN);
        },
      },
    ];
    for (const s of scenarios) {
      const f = fakes(s);
      const out = await completeEmbeddedSignup({ businessId: 7, body: BODY }, f.deps);
      noSecrets("response", out.body);
      noSecrets("warnings", f.warnings);
    }
  });

  // ── Part 2: graph.service bounds every connect-flow call ────────────────
  const realFetch = globalThis.fetch;
  const savedEnv = { id: process.env.META_APP_ID, secret: process.env.WHATSAPP_APP_SECRET };
  process.env.META_APP_ID = "APPID";
  process.env.WHATSAPP_APP_SECRET = "APPSECRET";
  try {
    assert.ok(GRAPH_CONNECT_TIMEOUT_MS > 0 && GRAPH_CONNECT_TIMEOUT_MS <= 20_000);

    const signals: Array<AbortSignal | undefined> = [];
    globalThis.fetch = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
      signals.push(init?.signal);
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as typeof fetch;

    await test("token exchange timeout → exchange_timeout (bounded, signal attached)", async () => {
      const r = await exchangeCodeForToken("CODE");
      assert.deepEqual(r.ok ? null : r.code, "exchange_timeout");
    });
    await test("phone lookup timeout → display_timeout", async () => {
      const r = await fetchPhoneNumberDisplay("PN1", "TOKEN");
      assert.deepEqual(r.ok ? null : r.code, "display_timeout");
    });
    await test("WABA subscription timeout → subscribe_timeout", async () => {
      const r = await subscribeWabaToApp({ wabaId: "WABA1", accessToken: "TOKEN" });
      assert.deepEqual(r.ok ? null : r.code, "subscribe_timeout");
    });
    await test("WABA phone lookup timeout → phones_timeout", async () => {
      const r = await fetchWabaPhoneNumber("WABA1", "TOKEN");
      assert.deepEqual(r.ok ? null : r.code, "phones_timeout");
    });
    await test("every connect-flow Graph call carries an abort signal", async () => {
      assert.equal(signals.length, 4);
      assert.ok(signals.every((s) => s instanceof AbortSignal));
    });

    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await test("a plain network failure stays *_network (not mislabelled as timeout)", async () => {
      const r = await exchangeCodeForToken("CODE");
      assert.deepEqual(r.ok ? null : r.code, "exchange_network");
    });

    const phoneList = (list: unknown, status = 200) =>
      (globalThis.fetch = (async () => ({
        ok: status === 200,
        status,
        json: async () => list,
      })) as unknown as typeof fetch);
    await test("WABA with exactly one number → that number", async () => {
      phoneList({ data: [{ id: "PN9", display_phone_number: "+972 53-222-2222" }] });
      assert.deepEqual(await fetchWabaPhoneNumber("W", "T"), {
        ok: true,
        phoneNumberId: "PN9",
        displayPhoneNumber: "+972 53-222-2222",
      });
    });
    await test("WABA with no number → phones_none; several → phones_multiple (never a guess)", async () => {
      phoneList({ data: [] });
      const none = await fetchWabaPhoneNumber("W", "T");
      assert.equal(none.ok ? null : none.code, "phones_none");
      phoneList({ data: [{ id: "A", display_phone_number: "1" }, { id: "B", display_phone_number: "2" }] });
      const many = await fetchWabaPhoneNumber("W", "T");
      assert.equal(many.ok ? null : many.code, "phones_multiple");
    });
    await test("Graph error on the WABA lookup → phones_<status>_<code>", async () => {
      phoneList({ error: { code: 100, message: "Unsupported get request" } }, 400);
      const r = await fetchWabaPhoneNumber("W", "T");
      assert.equal(r.ok ? null : r.code, "phones_400_100");
    });
  } finally {
    globalThis.fetch = realFetch;
    if (savedEnv.id === undefined) delete process.env.META_APP_ID;
    else process.env.META_APP_ID = savedEnv.id;
    if (savedEnv.secret === undefined) delete process.env.WHATSAPP_APP_SECRET;
    else process.env.WHATSAPP_APP_SECRET = savedEnv.secret;
  }

  console.log(`\nALL EMBEDDED SIGNUP COMPLETION TESTS PASSED — ${checks} checks\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
