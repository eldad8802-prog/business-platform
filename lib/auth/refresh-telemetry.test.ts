/**
 * Refresh telemetry (no database):
 *   npx tsx lib/auth/refresh-telemetry.test.ts
 *
 * Two properties, and the second matters more than the first:
 *
 *   EVERY REFRESH LEAVES ONE LINE that says what the engine decided, why, and on
 *   which class of device — so a sign-in screen on a phone can be traced to
 *   "revoked", "expired", "lost response" or "no cookie at all".
 *
 *   NOTHING ELSE CHANGES. The response body still says only "Unauthorized", the
 *   status codes are the ones they were, and no line carries a credential, a
 *   secret, a token or a User-Agent string.
 */

process.env.AUTH_TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET ?? "telemetry-test-secret-not-a-real-key";
process.env.AUTH_PLANE_ENABLED = "true";
process.env.AUTH_DATABASE_URL = process.env.AUTH_DATABASE_URL ?? "postgresql://nobody:nothing@127.0.0.1:1/none";
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://nobody:nothing@127.0.0.1:1/none";
process.env.RATE_LIMIT_BACKEND = "memory";

let failed = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) console.log(`  ok  - ${name}`);
  else {
    failed += 1;
    console.error(`FAIL  - ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const UA = {
  webview:
    "Mozilla/5.0 (Linux; Android 14; SM-S911B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.0.0 Mobile Safari/537.36",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  ipad: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  windows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
};

const SID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const SECRET = "ab".repeat(32);
const CREDENTIAL = `${SID}.${SECRET}`;

async function main() {
  const { platformClass } = await import("@/lib/auth/device-label");
  const route = await import("@/app/api/auth/refresh/route");

  // ── classifier ───────────────────────────────────────────────────────────
  ok("Android System WebView (the app) → android_webview", platformClass(UA.webview) === "android_webview");
  ok("Android Chrome → android", platformClass(UA.androidChrome) === "android");
  ok("iPhone → ios", platformClass(UA.iphone) === "ios");
  ok("iPad → ios", platformClass(UA.ipad) === "ios");
  ok("Windows → desktop", platformClass(UA.windows) === "desktop");
  ok("Mac → desktop", platformClass(UA.mac) === "desktop");
  ok("absent → unknown", platformClass(null) === "unknown" && platformClass("") === "unknown");
  ok("unfamiliar → unknown", platformClass("curl/8.5.0") === "unknown");
  const CLOSED = new Set(["android_webview", "android", "ios", "desktop", "unknown"]);
  for (const hostile of [
    'Android 14; wv) "}<script>alert(1)</script>',
    "Windows\n{\"event\":\"forged\"}",
    "Z".repeat(5000),
  ]) {
    const v = platformClass(hostile);
    ok(`hostile UA lands in the closed set (${JSON.stringify(hostile.slice(0, 24))}…) → ${v}`, CLOSED.has(v));
  }

  // ── the route: one line per decision, nothing else changes ──────────────
  const captured: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  const capture = (...args: unknown[]) => captured.push(args.map(String).join(" "));

  const request = (ua: string | null, headers: Record<string, string> = {}) =>
    new Request("https://lab.invalid/api/auth/refresh", {
      method: "POST",
      headers: {
        origin: "https://lab.invalid",
        host: "lab.invalid",
        cookie: `dubiz_rt=${CREDENTIAL}`,
        ...(ua !== null ? { "user-agent": ua } : {}),
        ...headers,
      },
    });

  type Run = NonNullable<Parameters<typeof route.handleRefresh>[1]>["run"];
  const cases: Array<{
    label: string;
    ua: string | null;
    run: Run;
    status: number;
    expect: Record<string, string>;
  }> = [
    {
      label: "rotated",
      ua: UA.webview,
      run: (async () => ({
        kind: "rotated",
        userId: 7,
        tokenVersion: 1,
        sessionId: SID,
        credential: `${SID}.${"cd".repeat(32)}`,
        absoluteExpiresAt: new Date(Date.now() + 86_400_000),
      })) as Run,
      status: 200,
      expect: { outcome: "rotated", platform: "android_webview", sid: SID.slice(0, 8) },
    },
    {
      label: "no cookie",
      ua: UA.webview,
      run: (async () => ({ kind: "unauthorized", reason: "no_credential" })) as Run,
      status: 401,
      expect: { outcome: "unauthorized", reason: "no_credential", platform: "android_webview" },
    },
    {
      label: "revoked",
      ua: UA.iphone,
      run: (async () => ({ kind: "invalid", reason: "revoked" })) as Run,
      status: 401,
      expect: { outcome: "invalid", reason: "revoked", platform: "ios" },
    },
    {
      label: "generation mismatch",
      ua: UA.windows,
      run: (async () => ({ kind: "invalid", reason: "token_version_mismatch" })) as Run,
      status: 401,
      expect: { outcome: "invalid", reason: "token_version_mismatch", platform: "desktop" },
    },
    {
      label: "lost response past grace",
      ua: UA.androidChrome,
      run: (async () => ({ kind: "replay_unproven" })) as Run,
      status: 401,
      expect: { outcome: "replay_unproven", platform: "android" },
    },
    {
      label: "proven reuse",
      ua: null,
      run: (async () => ({ kind: "replay_revoked", sessionId: SID, userId: 7 })) as Run,
      status: 401,
      expect: { outcome: "replay_revoked", platform: "unknown", sid: SID.slice(0, 8) },
    },
    {
      label: "driver failure",
      ua: UA.mac,
      run: (async () => {
        throw new Error(`connection to postgresql://u:p@h/db failed for ${CREDENTIAL}`);
      }) as Run,
      status: 500,
      expect: { outcome: "error", platform: "desktop" },
    },
  ];

  for (const c of cases) {
    captured.length = 0;
    console.log = capture;
    console.warn = capture;
    console.error = capture;
    let res: Response;
    try {
      res = await route.handleRefresh(request(c.ua), { run: c.run });
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    }
    const lines = captured
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((l): l is Record<string, unknown> => l !== null && l.event === "refresh_outcome");
    ok(`${c.label}: status unchanged (${c.status})`, res.status === c.status, `${res.status}`);
    ok(`${c.label}: exactly one refresh_outcome line`, lines.length === 1, `${lines.length}`);
    const line = lines[0] ?? {};
    for (const [k, v] of Object.entries(c.expect)) {
      ok(`${c.label}: ${k}=${v}`, line[k] === v, JSON.stringify(line));
    }
    const keys = Object.keys(line).sort().join(",");
    ok(
      `${c.label}: only the closed set of keys`,
      keys.split(",").every((k) => ["event", "outcome", "platform", "reason", "sid"].includes(k)),
      keys
    );

    const all = captured.join("\n");
    ok(`${c.label}: no secret in any log line`, !all.includes(SECRET) && !all.includes("cd".repeat(32)));
    ok(`${c.label}: no credential in any log line`, !all.includes(CREDENTIAL));
    ok(`${c.label}: no User-Agent string in any log line`, !all.includes("Mozilla") && !all.includes("AppleWebKit"));
    ok(`${c.label}: no connection string in any log line`, !all.includes("postgresql://"));
    // The pre-existing refresh_chain_divergence alert keeps the full id on purpose
    // (incident response needs the row); the per-refresh line never does.
    ok(`${c.label}: the outcome line carries no full session id`, !JSON.stringify(line).includes(SID));

    if (c.status === 401) {
      const body = (await res.json()) as Record<string, unknown>;
      ok(`${c.label}: the body is still only {error:"Unauthorized"} — no oracle`,
        JSON.stringify(body) === JSON.stringify({ error: "Unauthorized" }), JSON.stringify(body));
    }
  }

  // CSRF refusal is logged too, and still changes nothing.
  {
    captured.length = 0;
    console.log = capture;
    console.warn = capture;
    let res: Response;
    try {
      res = await route.handleRefresh(request(UA.webview, { origin: "https://evil.invalid" }), {
        run: (async () => {
          throw new Error("must not be called");
        }) as Run,
      });
    } finally {
      console.log = origLog;
      console.warn = origWarn;
    }
    const line = captured.map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .find((l) => l?.event === "refresh_outcome");
    ok("csrf: 403 as before", res.status === 403);
    ok("csrf: logged as csrf_refused with its reason", line?.outcome === "csrf_refused" && line?.reason === "bad_origin");
    ok("csrf: the cookie is untouched", res.headers.get("set-cookie") === null);
  }

  console.log(`\n[refresh-telemetry] FAIL=${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("TEST ERROR:", e);
  process.exit(1);
});
