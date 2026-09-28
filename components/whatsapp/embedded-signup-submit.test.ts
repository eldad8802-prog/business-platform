/**
 * Unit tests for the client → Dubiz submit of Embedded Signup. Run with:
 *   npx tsx components/whatsapp/embedded-signup-submit.test.ts
 *
 * Proves every backend outcome maps to a named, retryable state and that a
 * hanging request is aborted — the "sending" (מחברים…) step is always bounded.
 */
import assert from "node:assert/strict";
import { submitEmbeddedSignup, type SubmitDeps } from "./embedded-signup-submit";

const RESULT = { code: "CODE_SECRET", phoneNumberId: "PN1", wabaId: "WABA1" };

type Call = { input: string; init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal } };

function deps(
  respond: (call: Call) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>,
  timeoutMs = 50
): SubmitDeps & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: (input, init) => {
      const call = { input, init };
      calls.push(call);
      return respond(call);
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    timeoutMs,
  };
}

const reply = (status: number, body: unknown) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

let checks = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  checks++;
  console.log(`  ok  ${name}`);
}

async function main() {
  console.log("\nEmbedded Signup submit\n");

  await test("201 → ok with the display number; request is a bounded POST to our own API", async () => {
    const d = deps(reply(201, { connection: { displayPhoneNumber: "+972 50-000-0000" } }));
    const out = await submitEmbeddedSignup(RESULT, "TOKEN", d);
    assert.deepEqual(out, { ok: true, httpStatus: 201, displayPhoneNumber: "+972 50-000-0000" });
    const c = d.calls[0];
    assert.equal(c.input, "/api/integrations/whatsapp/embedded-signup");
    assert.equal(c.init.method, "POST");
    assert.equal(c.init.headers.Authorization, "Bearer TOKEN");
    assert.deepEqual(JSON.parse(c.init.body), { code: "CODE_SECRET", phoneNumberId: "PN1", wabaId: "WABA1" });
    assert.ok(c.init.signal instanceof AbortSignal, "the request carries an abort signal");
  });

  for (const [status, error] of [
    [400, "bad_request"],
    [401, "unauthorized"],
    [403, "forbidden"],
    [409, "number_taken"],
    [500, "server_error"],
    [503, "server_error"],
    [418, "unexpected_status"],
  ] as const) {
    await test(`${status} → error ${error}`, async () => {
      const out = await submitEmbeddedSignup(RESULT, "T", deps(reply(status, { error: "x" })));
      assert.equal(out.ok, false);
      if (!out.ok) {
        assert.equal(out.error, error);
        assert.equal(out.httpStatus, status);
      }
    });
  }

  for (const stage of ["exchange", "display", "subscribe"] as const) {
    await test(`502 from the ${stage} step → error meta_failed naming the stage`, async () => {
      const out = await submitEmbeddedSignup(
        RESULT,
        "T",
        deps(reply(502, { error: "Could not complete WhatsApp connection", stage, code: `${stage}_400_100` }))
      );
      assert.equal(out.ok, false);
      if (!out.ok) {
        assert.equal(out.error, "meta_failed");
        assert.equal(out.stage, stage);
        assert.equal(out.serverCode, `${stage}_400_100`);
      }
    });
  }

  await test("server stage/code outside the safe vocabulary are dropped", async () => {
    const out = await submitEmbeddedSignup(
      RESULT,
      "T",
      deps(reply(502, { stage: "exchange <script>", code: "token=abc def" }))
    );
    assert.equal(out.ok, false);
    if (!out.ok) {
      assert.equal(out.stage, null);
      assert.equal(out.serverCode, null);
    }
  });

  await test("non-JSON 500 body → error server_error (no throw)", async () => {
    const d = deps(async () => ({
      ok: false,
      status: 500,
      json: async () => {
        throw new SyntaxError("not json");
      },
    }));
    const out = await submitEmbeddedSignup(RESULT, "T", d);
    assert.equal(out.ok, false);
    if (!out.ok) assert.equal(out.error, "server_error");
  });

  await test("a hanging backend is aborted → error timeout (never an endless 'מחברים…')", async () => {
    const d = deps(
      (call) =>
        new Promise((_, reject) => {
          call.init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
      30
    );
    const started = Date.now();
    const out = await submitEmbeddedSignup(RESULT, "T", d);
    assert.equal(out.ok, false);
    if (!out.ok) {
      assert.equal(out.error, "timeout");
      assert.equal(out.httpStatus, null);
    }
    assert.ok(Date.now() - started < 2_000, "bounded by the timeout");
  });

  await test("a hanging body read after headers is also bounded → error timeout", async () => {
    const d = deps(
      (call) =>
        Promise.resolve({
          ok: true,
          status: 201,
          json: () =>
            new Promise((_, reject) => {
              call.init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
            }),
        }),
      30
    );
    const out = await submitEmbeddedSignup(RESULT, "T", d);
    assert.equal(out.ok, false);
    if (!out.ok) assert.equal(out.error, "timeout");
  });

  await test("network failure → error network", async () => {
    const out = await submitEmbeddedSignup(
      RESULT,
      "T",
      deps(async () => {
        throw new TypeError("Failed to fetch");
      })
    );
    assert.equal(out.ok, false);
    if (!out.ok) assert.equal(out.error, "network");
  });

  await test("no bearer token → no Authorization header (server answers 401)", async () => {
    const d = deps(reply(401, { error: "Unauthorized" }));
    const out = await submitEmbeddedSignup(RESULT, null, d);
    assert.equal("Authorization" in d.calls[0].init.headers, false);
    assert.equal(out.ok, false);
    if (!out.ok) assert.equal(out.error, "unauthorized");
  });

  await test("outcomes never carry the authorization code", async () => {
    const outs = [
      await submitEmbeddedSignup(RESULT, "T", deps(reply(201, { connection: { displayPhoneNumber: "X" } }))),
      await submitEmbeddedSignup(RESULT, "T", deps(reply(502, { stage: "exchange", code: "exchange_400" }))),
    ];
    assert.equal(JSON.stringify(outs).includes("CODE_SECRET"), false);
  });

  console.log(`\nALL EMBEDDED SIGNUP SUBMIT TESTS PASSED — ${checks} checks\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
