/**
 * Session guard — the one decision for a refused session (no browser, no DB):
 *   npx tsx lib/auth/session-guard.test.ts
 *
 * Runs the REAL refresh client underneath (lib/auth/refresh-client.ts) against a
 * scripted /api/auth/refresh, so "recovered", "signed out" and "transient" are
 * what the actual single-flight, cross-tab-locked refresh decides.
 */

let failed = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) console.log(`  ok  - ${name}`);
  else {
    failed += 1;
    console.error(`FAIL  - ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const tok = (n: string) => `v1.${Buffer.from(JSON.stringify({ sub: 1, sid: "s", exp: 9_999_999_999, n })).toString("base64url")}.sig`;

type Browser = {
  store: Map<string, string>;
  replaced: string[];
  reloads: number;
  visibility: string;
  path: string;
};
function installBrowser(token: string | null, path = "/settings/team"): Browser {
  const b: Browser = { store: new Map(), replaced: [], reloads: 0, visibility: "", path };
  if (token !== null) b.store.set("token", token);
  b.store.set("user", "{}");
  b.store.set("sessionId", "x");
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = {
    localStorage: {
      getItem: (k: string) => b.store.get(k) ?? null,
      setItem: (k: string, v: string) => void b.store.set(k, v),
      removeItem: (k: string) => void b.store.delete(k),
    },
    location: {
      get pathname() { return b.path; },
      origin: "https://app.invalid",
      replace: (u: string) => { b.replaced.push(u); },
      reload: () => { b.reloads += 1; },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  g.document = { documentElement: { style: { set visibility(v: string) { b.visibility = v; }, get visibility() { return b.visibility; } } } };
  return b;
}

let refreshCalls = 0;
function serverSays(kind: "ok" | "401" | "429" | "offline" | "500", newToken = tok("fresh")) {
  refreshCalls = 0;
  (globalThis as unknown as { fetch: unknown }).fetch = async () => {
    refreshCalls += 1;
    if (kind === "offline") throw new TypeError("Failed to fetch");
    if (kind === "ok") return { ok: true, status: 200, json: async () => ({ token: newToken }) } as unknown as Response;
    const status = kind === "401" ? 401 : kind === "429" ? 429 : 500;
    return { ok: false, status, json: async () => ({}) } as unknown as Response;
  };
}

async function main() {
  installBrowser(tok("old"));
  const rc = await import("@/lib/auth/refresh-client");
  rc.__testing.useEnv({ sleep: async () => {} }); // retries are about the clock; these cases are about the verdict
  const sg = await import("@/lib/auth/session-guard");

  // ── refreshable: stay, retry the READ once ───────────────────────────────
  {
    const b = installBrowser(tok("old")); sg.__testing.reset(); rc.__testing.resetInFlight();
    serverSays("ok");
    let retries = 0;
    const r = await sg.handleUnauthorized({ rejectedToken: tok("old"), retry: () => { retries += 1; } });
    ok("REFRESHABLE: recovered", r === "recovered", r);
    ok("...the read is retried exactly once", retries === 1, `${retries}`);
    ok("...the new token is stored", b.store.get("token") === tok("fresh"));
    ok("...no navigation, nothing hidden", b.replaced.length === 0 && b.visibility === "");
  }
  {
    // A write passes no retry: recovered, and nothing is re-executed.
    const b = installBrowser(tok("old")); sg.__testing.reset(); rc.__testing.resetInFlight();
    serverSays("ok");
    const r = await sg.handleUnauthorized({ rejectedToken: tok("old") });
    ok("WRITE (no retry given): recovered and nothing re-run, no navigation", r === "recovered" && b.replaced.length === 0 && b.reloads === 0);
  }

  // ── ended by the server: clear, hide, /login ─────────────────────────────
  {
    const b = installBrowser(tok("old")); sg.__testing.reset(); rc.__testing.resetInFlight();
    b.store.set("dubiz.auth.pendingRevoke", "{\"sid\":\"a\",\"since\":1}");
    serverSays("401");
    let retries = 0;
    const r = await sg.handleUnauthorized({ rejectedToken: tok("old"), retry: () => { retries += 1; } });
    ok("ENDED: signed_out", r === "signed_out", r);
    ok("...token, user and sessionId removed", !b.store.has("token") && !b.store.has("user") && !b.store.has("sessionId"));
    ok("...the page is hidden at once (no business data left visible)", b.visibility === "hidden");
    ok("...and replaced by /login", b.replaced.length === 1 && b.replaced[0].endsWith("/login"), JSON.stringify(b.replaced));
    ok("...no retry", retries === 0);
    ok("...an unfinished sign-out's marker is left for the login screen", b.store.has("dubiz.auth.pendingRevoke"));
  }
  {
    // Already on /login: clear, but never redirect to itself.
    const b = installBrowser(tok("old"), "/login"); sg.__testing.reset(); rc.__testing.resetInFlight();
    serverSays("401");
    const r = await sg.handleUnauthorized({ rejectedToken: tok("old") });
    ok("ENDED on /login: cleared, NO redirect (no loop)", r === "signed_out" && !b.store.has("token") && b.replaced.length === 0);
  }

  // ── transient: nothing cleared, nothing navigated ────────────────────────
  for (const kind of ["offline", "429", "500"] as const) {
    const b = installBrowser(tok("old")); sg.__testing.reset(); rc.__testing.resetInFlight();
    serverSays(kind);
    let retries = 0;
    const r = await sg.handleUnauthorized({ rejectedToken: tok("old"), retry: () => { retries += 1; } });
    ok(`TRANSIENT (${kind}): transient, token kept, no navigation, no retry`,
      r === "transient" && b.store.get("token") === tok("old") && b.replaced.length === 0 && b.visibility === "" && retries === 0, r);
  }

  // ── no loops ─────────────────────────────────────────────────────────────
  {
    const b = installBrowser(tok("old")); sg.__testing.reset(); rc.__testing.resetInFlight();
    serverSays("ok");
    await sg.handleUnauthorized({ rejectedToken: tok("old"), retry: () => {} });
    const callsAfterRecovery = refreshCalls;
    // The endpoint refuses the FRESH token for a reason that is not the session.
    const r = await sg.handleUnauthorized({ rejectedToken: tok("fresh"), retry: () => {} });
    ok("LOOP GUARD: a 401 on the token just recovered is transient", r === "transient", r);
    ok("...with NO second refresh", refreshCalls === callsAfterRecovery, `${refreshCalls - callsAfterRecovery}`);
    ok("...and no navigation", b.replaced.length === 0);
  }
  {
    // Three screens get 401 at once: one refresh, each read retried once.
    const b = installBrowser(tok("old")); sg.__testing.reset(); rc.__testing.resetInFlight();
    serverSays("ok");
    let retries = 0;
    const rs = await Promise.all([1, 2, 3].map(() => sg.handleUnauthorized({ rejectedToken: tok("old"), retry: () => { retries += 1; } })));
    ok("CONCURRENT 401s: one refresh request", refreshCalls === 1, `${refreshCalls}`);
    ok("...all recovered, each read retried once", rs.every((r) => r === "recovered") && retries === 3, `${rs} ${retries}`);
    ok("...no navigation", b.replaced.length === 0);
  }
  {
    // Another tab already replaced the token: no request at all.
    const b = installBrowser(tok("newer")); sg.__testing.reset(); rc.__testing.resetInFlight();
    serverSays("ok");
    let retries = 0;
    const r = await sg.handleUnauthorized({ rejectedToken: tok("old"), retry: () => { retries += 1; } });
    ok("ALREADY REPLACED: recovered with no refresh request, read retried", r === "recovered" && refreshCalls === 0 && retries === 1 && b.replaced.length === 0);
  }

  // ── a pending sign-out is never undone by recovery (M6, device QA) ───────
  {
    // "Clear this device anyway": no token, the marker, and the cookie still in
    // the jar as the proof. The server WOULD refresh it — the guard must not ask.
    const b = installBrowser(null, "/setup"); sg.__testing.reset(); rc.__testing.resetInFlight();
    b.store.set(sg.PENDING_REVOKE_KEY, JSON.stringify({ since: 1, sid: "a" }));
    serverSays("ok");
    const r = await sg.handleUnauthorized({ rejectedToken: null });
    ok("PENDING SIGN-OUT, no token: signed_out — the cleared session is NOT resumed", r === "signed_out", r);
    ok("...with NO refresh request (the cookie is proof, not a session)", refreshCalls === 0, `${refreshCalls}`);
    ok("...no reload, but /login — where the pending sign-out is finished", b.reloads === 0 && b.replaced.length === 1 && b.replaced[0].endsWith("/login"));
    ok("...and the marker is kept for the login screen", b.store.has(sg.PENDING_REVOKE_KEY));
  }
  {
    // A later sign-in (a token present) is a different session: the old marker
    // does not stop its normal recovery.
    const b = installBrowser(tok("later")); sg.__testing.reset(); rc.__testing.resetInFlight();
    b.store.set(sg.PENDING_REVOKE_KEY, JSON.stringify({ since: 1, sid: "a" }));
    serverSays("ok");
    let retries = 0;
    const r = await sg.handleUnauthorized({ rejectedToken: tok("later"), retry: () => { retries += 1; } });
    ok("PENDING SIGN-OUT + a later sign-in's token: recovered normally", r === "recovered" && retries === 1 && b.replaced.length === 0, r);
  }

  // ── no token at all ──────────────────────────────────────────────────────
  {
    const b = installBrowser(null); sg.__testing.reset(); rc.__testing.resetInFlight();
    serverSays("ok");
    const r = await sg.handleUnauthorized({ rejectedToken: null });
    ok("NO TOKEN, live cookie: recovered and the page reloads (it rendered nothing private)", r === "recovered" && b.reloads === 1 && b.replaced.length === 0);
  }
  {
    const b = installBrowser(null); sg.__testing.reset(); rc.__testing.resetInFlight();
    serverSays("401");
    const r = await sg.handleUnauthorized({ rejectedToken: null });
    ok("NO TOKEN, no session: signed_out → /login", r === "signed_out" && b.replaced.length === 1);
  }

  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  if (failed > 0) process.exit(1);
}

void main().catch((e) => { console.error("TEST ERROR:", e); process.exit(1); });
