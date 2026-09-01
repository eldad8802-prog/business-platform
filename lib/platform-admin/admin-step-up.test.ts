/**
 * Run: npx tsx lib/platform-admin/admin-step-up.test.ts
 *
 * CASA Wave B — browser step-up client for platform-admin MFA (CASA 3.3.1).
 *
 * Deterministic and OFFLINE: `fetch` and `window.localStorage` are stubbed, so
 * nothing here touches the network, a database, or a real secret. What is
 * asserted is the part that decides whether a privileged browser request can
 * proceed: does a 403 ADMIN_MFA_REQUIRED produce exactly one challenge, does a
 * successful verification produce exactly one retry carrying the elevation, and
 * — the properties that actually matter under attack — is the six-digit code
 * ever retained anywhere, and can the retry ever loop.
 */
import assert from "node:assert/strict";
import {
  ADMIN_ELEVATION_HEADER,
  ADMIN_ELEVATION_MAX_SECONDS,
  ADMIN_MFA_REQUIRED_CODE,
  clearAdminElevation,
  getAdminElevation,
  registerAdminStepUpHandler,
  setAdminElevation,
  verifyAdminMfaCode,
  __testing as elevationTesting,
} from "./admin-elevation";
import {
  PlatformAdminFetchError,
  fetchPlatformAdminOverview,
  patchPlatformAdminBusinessFeature,
  postPlatformAdminTokenProbe,
} from "./fetch-platform-admin";

/* ── harness ─────────────────────────────────────────────────────────────── */

const BEARER = "synthetic.bearer.token";

type Call = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
};

let calls: Call[] = [];
let responder: (call: Call) => { status: number; body: unknown } = () => ({
  status: 200,
  body: {},
});

function installStubs() {
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (k: string) => (k === "token" ? BEARER : null),
      removeItem: () => {},
      setItem: () => {},
    },
  };
  (globalThis as unknown as { fetch: unknown }).fetch = async (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string }
  ) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? "GET",
      headers: init?.headers ?? {},
      body: init?.body,
    };
    calls.push(call);
    const { status, body } = responder(call);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response;
  };
}

function reset() {
  calls = [];
  elevationTesting.reset();
  responder = () => ({ status: 200, body: {} });
}

const privileged = (c: Call) => !c.url.includes("/mfa/verify");
const privilegedCalls = () => calls.filter(privileged);
const verifyCalls = () => calls.filter((c) => !privileged(c));

/** A server that demands elevation until a valid one arrives. */
function elevationDemandingServer(accepted: string) {
  return (call: Call) => {
    if (!privileged(call)) {
      return {
        status: 200,
        body: { elevation: accepted, expiresInSeconds: 900, via: "totp" },
      };
    }
    if (call.headers[ADMIN_ELEVATION_HEADER] === accepted) {
      return { status: 200, body: { ok: true } };
    }
    return {
      status: 403,
      body: { error: "Multi-factor elevation required", code: ADMIN_MFA_REQUIRED_CODE },
    };
  };
}

async function expectFetchError(
  run: () => Promise<unknown>,
  status: number,
  code?: string
) {
  try {
    await run();
  } catch (err) {
    assert.ok(
      err instanceof PlatformAdminFetchError,
      "must throw PlatformAdminFetchError"
    );
    assert.equal(err.status, status);
    if (code !== undefined) assert.equal(err.code, code);
    return err;
  }
  throw new Error("expected the request to reject");
}

/* ── matrix ──────────────────────────────────────────────────────────────── */

async function main() {
  installStubs();

  // 1. a 403 ADMIN_MFA_REQUIRED triggers the step-up handler
  {
    reset();
    responder = elevationDemandingServer("elev-1");
    let prompts = 0;
    registerAdminStepUpHandler(async () => {
      prompts += 1;
      const r = await verifyAdminMfaCode("123456", BEARER);
      if (!r.ok) return null;
      setAdminElevation(r.elevation, r.expiresInSeconds);
      return r.elevation;
    });

    await fetchPlatformAdminOverview();
    assert.equal(prompts, 1, "exactly one challenge");
  }

  // 2. a valid verification retries the ORIGINAL request carrying the elevation
  {
    const first = privilegedCalls()[0];
    const second = privilegedCalls()[1];
    assert.equal(privilegedCalls().length, 2, "one original + one retry");
    assert.equal(first.url, second.url, "the same privileged request is retried");
    assert.equal(
      first.headers[ADMIN_ELEVATION_HEADER],
      undefined,
      "the first attempt carries no elevation"
    );
    assert.equal(
      second.headers[ADMIN_ELEVATION_HEADER],
      "elev-1",
      "the retry carries the elevation the server issued"
    );
    assert.equal(getAdminElevation(), "elev-1", "the elevation is held for reuse");
  }

  // 3. a held elevation is sent up-front — a second call must not re-prompt
  {
    calls = [];
    let prompts = 0;
    registerAdminStepUpHandler(async () => {
      prompts += 1;
      return null;
    });
    await fetchPlatformAdminOverview();
    assert.equal(prompts, 0, "no challenge while a live elevation exists");
    assert.equal(privilegedCalls().length, 1, "no retry needed");
    assert.equal(privilegedCalls()[0].headers[ADMIN_ELEVATION_HEADER], "elev-1");
  }

  // 4. an INVALID code must not retry the privileged operation
  {
    reset();
    responder = (call) =>
      privileged(call)
        ? {
            status: 403,
            body: { error: "Multi-factor elevation required", code: ADMIN_MFA_REQUIRED_CODE },
          }
        : { status: 401, body: { error: "Verification failed", code: "invalid_code" } };

    let prompts = 0;
    registerAdminStepUpHandler(async () => {
      prompts += 1;
      const r = await verifyAdminMfaCode("000000", BEARER);
      if (!r.ok) return null; // stays open in the UI; returns null on give-up
      setAdminElevation(r.elevation, r.expiresInSeconds);
      return r.elevation;
    });

    await expectFetchError(
      () => fetchPlatformAdminOverview(),
      403,
      ADMIN_MFA_REQUIRED_CODE
    );
    assert.equal(prompts, 1);
    assert.equal(
      privilegedCalls().length,
      1,
      "the privileged operation is NOT retried after a rejected code"
    );
    assert.equal(getAdminElevation(), null, "nothing is held after a failed verify");
  }

  // 5. a CANCELLED prompt must not retry the privileged operation
  {
    reset();
    responder = () => ({
      status: 403,
      body: { error: "Multi-factor elevation required", code: ADMIN_MFA_REQUIRED_CODE },
    });
    registerAdminStepUpHandler(async () => null); // user pressed cancel

    await expectFetchError(
      () => fetchPlatformAdminOverview(),
      403,
      ADMIN_MFA_REQUIRED_CODE
    );
    assert.equal(privilegedCalls().length, 1, "cancel means no retry");
    assert.equal(verifyCalls().length, 0, "cancel never calls /mfa/verify");
  }

  // 6. a stale elevation is CLEARED and replaced, not resent
  {
    reset();
    setAdminElevation("stale-elevation", 900);
    responder = elevationDemandingServer("elev-fresh");
    registerAdminStepUpHandler(async () => {
      // The refused elevation must already be gone when the UI is asked.
      assert.equal(
        getAdminElevation(),
        null,
        "the refused elevation is cleared before the challenge"
      );
      const r = await verifyAdminMfaCode("123456", BEARER);
      if (!r.ok) return null;
      setAdminElevation(r.elevation, r.expiresInSeconds);
      return r.elevation;
    });

    await fetchPlatformAdminOverview();
    assert.equal(privilegedCalls()[0].headers[ADMIN_ELEVATION_HEADER], "stale-elevation");
    assert.equal(privilegedCalls()[1].headers[ADMIN_ELEVATION_HEADER], "elev-fresh");
  }

  // 7. expiry is self-clearing and never exceeds the server's own lifetime
  {
    reset();
    const t0 = 1_000_000;
    setAdminElevation("bounded", ADMIN_ELEVATION_MAX_SECONDS, t0);
    assert.equal(getAdminElevation(t0), "bounded");
    assert.equal(
      getAdminElevation(t0 + ADMIN_ELEVATION_MAX_SECONDS * 1000),
      null,
      "expired elevation is dropped"
    );

    // A server that claims a longer life cannot extend the client's window.
    setAdminElevation("greedy", 60 * 60, t0);
    assert.equal(
      getAdminElevation(t0 + ADMIN_ELEVATION_MAX_SECONDS * 1000),
      null,
      "an over-long expiry is clamped to the server maximum"
    );
    clearAdminElevation();
    assert.equal(getAdminElevation(), null, "clear works");
  }

  // 8. the retry is BOUNDED — a server that always refuses cannot loop
  {
    reset();
    responder = (call) =>
      privileged(call)
        ? {
            status: 403,
            body: { error: "Multi-factor elevation required", code: ADMIN_MFA_REQUIRED_CODE },
          }
        : { status: 200, body: { elevation: "never-good", expiresInSeconds: 900 } };

    let prompts = 0;
    registerAdminStepUpHandler(async () => {
      prompts += 1;
      const r = await verifyAdminMfaCode("123456", BEARER);
      if (!r.ok) return null;
      setAdminElevation(r.elevation, r.expiresInSeconds);
      return r.elevation;
    });

    await expectFetchError(
      () => fetchPlatformAdminOverview(),
      403,
      ADMIN_MFA_REQUIRED_CODE
    );
    assert.equal(prompts, 1, "at most ONE challenge per request");
    assert.equal(
      privilegedCalls().length,
      2,
      "at most ONE retry per request — no loop"
    );
    assert.equal(
      getAdminElevation(),
      null,
      "an elevation the server keeps refusing is discarded"
    );
  }

  // 9. the code is never persisted, logged, or placed in a URL
  {
    reset();
    const SECRET_CODE = "424242";
    const logged: string[] = [];
    const realLog = console.log;
    const realError = console.error;
    const realWarn = console.warn;
    console.log = (...a: unknown[]) => logged.push(a.join(" "));
    console.error = (...a: unknown[]) => logged.push(a.join(" "));
    console.warn = (...a: unknown[]) => logged.push(a.join(" "));
    try {
      responder = elevationDemandingServer("elev-9");
      registerAdminStepUpHandler(async () => {
        const r = await verifyAdminMfaCode(SECRET_CODE, BEARER);
        if (!r.ok) return null;
        setAdminElevation(r.elevation, r.expiresInSeconds);
        return r.elevation;
      });
      await fetchPlatformAdminOverview();
    } finally {
      console.log = realLog;
      console.error = realError;
      console.warn = realWarn;
    }

    const verify = verifyCalls();
    assert.equal(verify.length, 1, "the code goes to exactly one endpoint");
    assert.equal(verify[0].method, "POST", "never a GET — codes do not go in URLs");
    assert.ok(
      !calls.some((c) => c.url.includes(SECRET_CODE)),
      "the code never appears in any URL or query string"
    );
    assert.equal(
      JSON.parse(verify[0].body ?? "{}").code,
      SECRET_CODE,
      "it travels in the request body"
    );
    assert.ok(
      !privilegedCalls().some((c) => JSON.stringify(c).includes(SECRET_CODE)),
      "the code never leaks into a privileged request"
    );
    assert.ok(
      !logged.some((line) => line.includes(SECRET_CODE)),
      "the code is never written to the console"
    );
    assert.ok(
      !JSON.stringify(elevationTesting.peek() ?? {}).includes(SECRET_CODE),
      "the code is never retained in the elevation store"
    );
  }

  // 10. non-MFA failures are passed straight through — no spurious challenge
  {
    for (const [status, code] of [
      [401, undefined],
      [403, "FORBIDDEN"],
      [500, undefined],
    ] as const) {
      reset();
      responder = () => ({ status, body: { error: "nope", code } });
      let prompts = 0;
      registerAdminStepUpHandler(async () => {
        prompts += 1;
        return null;
      });
      await expectFetchError(() => fetchPlatformAdminOverview(), status);
      assert.equal(prompts, 0, `HTTP ${status} must not trigger a step-up`);
      assert.equal(privilegedCalls().length, 1, `HTTP ${status} must not retry`);
    }
  }

  // 11. a request with no elevation held sends no elevation header at all
  {
    reset();
    responder = () => ({ status: 200, body: { ok: true } });
    await fetchPlatformAdminOverview();
    assert.equal(
      privilegedCalls()[0].headers[ADMIN_ELEVATION_HEADER],
      undefined,
      "ordinary flows are byte-for-byte unchanged until the server asks"
    );
    assert.equal(verifyCalls().length, 0, "no MFA traffic on a healthy request");
  }

  // 12. EVERY privileged verb shares the core: GET, PATCH and probe POST
  {
    for (const invoke of [
      () => fetchPlatformAdminOverview(),
      () =>
        patchPlatformAdminBusinessFeature(7, "billing", {
          state: "ENABLED" as never,
          reason: "test",
        }),
      () => postPlatformAdminTokenProbe(),
    ]) {
      reset();
      responder = elevationDemandingServer("elev-12");
      let prompts = 0;
      registerAdminStepUpHandler(async () => {
        prompts += 1;
        const r = await verifyAdminMfaCode("123456", BEARER);
        if (!r.ok) return null;
        setAdminElevation(r.elevation, r.expiresInSeconds);
        return r.elevation;
      });
      await invoke();
      assert.equal(prompts, 1, "this verb participates in the step-up");
      assert.equal(
        privilegedCalls()[1].headers[ADMIN_ELEVATION_HEADER],
        "elev-12",
        "this verb retries with the elevation"
      );
    }
  }

  // 13. with no UI mounted the challenge surfaces instead of hanging
  {
    reset();
    elevationTesting.reset(); // no handler registered
    responder = () => ({
      status: 403,
      body: { error: "Multi-factor elevation required", code: ADMIN_MFA_REQUIRED_CODE },
    });
    await expectFetchError(
      () => fetchPlatformAdminOverview(),
      403,
      ADMIN_MFA_REQUIRED_CODE
    );
    assert.equal(privilegedCalls().length, 1, "no handler means no retry");
  }

  console.log("platform-admin MFA step-up client (Wave B / CASA 3.3.1): OK — 13/13");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
