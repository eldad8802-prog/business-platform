/**
 * Database availability probe — the database half: the REAL route (app/api/health/db/route.ts) and the real Prisma
 * clients against a real Postgres, one scenario per process (the clients are process singletons built from env).
 *
 *   LAB_RUNTIME_URL=postgresql://…  LAB_AUTH_URL=postgresql://…  npx tsx scripts/ops/db-health-lab.ts <scenario>
 *
 *   up            both connections answer                    → 200 ok / ok
 *   runtime-down  DATABASE_URL points at a closed port       → 503 runtime: unreachable, auth: ok
 *   auth-down     AUTH_DATABASE_URL names a role that cannot log in → 503 runtime: ok, auth: rejected
 *   blackhole     DATABASE_URL accepts TCP, never answers    → 503 runtime: timeout, answered within the deadline
 *   refused       no / wrong credential while the DB is black-holed → 401 at once, the DB never contacted;
 *                 no secret configured → 503 monitor_not_configured, the DB never contacted
 *   recovery      the runtime DB goes away, then comes back  → 200 → 503 unreachable → 200 (same process, same pool)
 *
 * Every scenario also checks: no-store headers on every answer, and that neither the answer nor anything the route
 * logged carries a password, host, role or connection string.
 */
import assert from "node:assert/strict";
import net from "node:net";

const SECRET = "lab_monitor_secret_0123456789abcdefghijklmnop";
const scenario = process.argv[2] ?? "";
const RUNTIME = need("LAB_RUNTIME_URL");
const AUTH = need("LAB_AUTH_URL");

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is required`);
  return v;
}
function withHostPort(url: string, host: string, port: number) {
  const u = new URL(url);
  u.hostname = host;
  u.port = String(port);
  return u.toString();
}
function withCredential(url: string, username: string, password: string) {
  const u = new URL(url);
  u.username = username;
  u.password = password;
  return u.toString();
}
/** Secrets this process holds: none of them may appear in an answer or a log line. */
function secretsOf(...urls: string[]) {
  const out = new Set<string>([SECRET, "postgresql://", "postgres://"]);
  for (const s of urls) {
    const u = new URL(s);
    if (u.password) out.add(decodeURIComponent(u.password));
    if (u.username) out.add(decodeURIComponent(u.username));
    out.add(`${u.hostname}:${u.port || 5432}`);
    out.add(u.pathname.slice(1));
  }
  return [...out].filter((s) => s.length >= 4);
}

/** A TCP server that accepts and never says a word (a hung database). Counts connections. */
async function blackhole() {
  let connections = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((s) => { connections += 1; sockets.add(s); s.on("error", () => {}); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as net.AddressInfo).port;
  return { port, connections: () => connections, close: () => { for (const s of sockets) s.destroy(); server.close(); } };
}
/** A TCP proxy to the real database that can be cut (refusing and dropping) and restored. */
async function switchableProxy(target: URL) {
  let open = true;
  const live = new Set<net.Socket>();
  const server = net.createServer((client) => {
    if (!open) { client.destroy(); return; }
    const upstream = net.connect(Number(target.port || 5432), target.hostname);
    live.add(client); live.add(upstream);
    client.pipe(upstream).pipe(client);
    const drop = () => { client.destroy(); upstream.destroy(); live.delete(client); live.delete(upstream); };
    client.on("error", drop); upstream.on("error", drop); client.on("close", drop); upstream.on("close", drop);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    cut: () => { open = false; for (const s of live) s.destroy(); live.clear(); },
    restore: () => { open = true; },
    close: () => { open = false; for (const s of live) s.destroy(); server.close(); },
  };
}
async function closedPort() {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

const logged: string[] = [];
for (const k of ["error", "warn", "log", "info"] as const) {
  const orig = console[k].bind(console);
  console[k] = (...args: unknown[]) => {
    logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message } : v)))).join(" "));
    orig(...args);
  };
}

type Answer = { status: number; body: Record<string, unknown>; ms: number; headers: Headers };
async function call(authorization: string | null): Promise<Answer> {
  const { GET } = await import("../../app/api/health/db/route");
  const { NextRequest } = await import("next/server");
  const headers = new Headers();
  if (authorization !== null) headers.set("authorization", authorization);
  const t0 = Date.now();
  const res = await GET(new NextRequest("http://lab.local/api/health/db", { headers }));
  const ms = Date.now() - t0;
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, ms, headers: res.headers };
}
function noStore(a: Answer) {
  assert.match(a.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(a.headers.get("cdn-cache-control"), "no-store");
  assert.equal(a.headers.get("vercel-cdn-cache-control"), "no-store");
}
function noLeak(a: Answer, secrets: string[]) {
  // The route's own lines. (The shared Prisma client's `log: ["warn","error"]` output is the client's, unchanged here.)
  const own = logged.filter((l) => l.startsWith("[health-db]"));
  const text = JSON.stringify(a.body) + "\n" + own.join("\n");
  for (const s of secrets) assert.ok(!text.includes(s), `leaked a secret fragment (${s.length} chars)`);
}
const show = (a: Answer) => `${a.status} ${JSON.stringify(a.body.checks ?? a.body.error)} in ${a.ms} ms`;

function env(runtimeUrl: string, authUrl: string, secret: string | null = SECRET) {
  process.env.DATABASE_URL = runtimeUrl;
  process.env.AUTH_DATABASE_URL = authUrl;
  process.env.AUTH_PLANE_ENABLED = "true";
  process.env.CRON_SECRET = "cron_lab_secret_0123456789abcdefghijklmnopqrs";
  if (secret === null) delete process.env.HEALTH_MONITOR_SECRET;
  else process.env.HEALTH_MONITOR_SECRET = secret;
}
const bearer = `Bearer ${SECRET}`;

async function main() {
  console.log(`== db-health lab: ${scenario}`);
  if (scenario === "up") {
    env(RUNTIME, AUTH);
    const a = await call(bearer);
    console.log(show(a));
    assert.equal(a.status, 200);
    assert.deepEqual(a.body.checks, { runtime: "ok", auth: "ok" });
    assert.equal(a.body.status, "ok");
    noStore(a); noLeak(a, secretsOf(RUNTIME, AUTH));
  } else if (scenario === "runtime-down") {
    const bad = withHostPort(RUNTIME, "127.0.0.1", await closedPort());
    env(bad, AUTH);
    const a = await call(bearer);
    console.log(show(a));
    assert.equal(a.status, 503);
    assert.deepEqual(a.body.checks, { runtime: "unreachable", auth: "ok" });
    assert.ok(a.ms < 4500, `took ${a.ms}`);
    noStore(a); noLeak(a, secretsOf(bad, AUTH));
  } else if (scenario === "auth-down") {
    // A role that does not exist: refused whatever the server's pg_hba method (a local trust setup accepts any password).
    const bad = withCredential(AUTH, "lab_no_such_role", "wrong_password_for_lab_only");
    env(RUNTIME, bad);
    const a = await call(bearer);
    console.log(show(a));
    assert.equal(a.status, 503);
    assert.deepEqual(a.body.checks, { runtime: "ok", auth: "rejected" });
    noStore(a); noLeak(a, secretsOf(RUNTIME, bad, AUTH));
  } else if (scenario === "blackhole") {
    const hole = await blackhole();
    const bad = withHostPort(RUNTIME, "127.0.0.1", hole.port);
    env(bad, AUTH);
    const a = await call(bearer);
    console.log(show(a), `(black hole saw ${hole.connections()} connection(s))`);
    assert.equal(a.status, 503);
    assert.deepEqual(a.body.checks, { runtime: "timeout", auth: "ok" });
    assert.ok(a.ms >= 2900 && a.ms < 4800, `took ${a.ms}`);
    assert.ok(hole.connections() >= 1);
    noStore(a); noLeak(a, secretsOf(bad, AUTH));
    hole.close();
  } else if (scenario === "refused") {
    const hole = await blackhole();
    const bad = withHostPort(RUNTIME, "127.0.0.1", hole.port);
    const badAuth = withHostPort(AUTH, "127.0.0.1", hole.port);
    env(bad, badAuth);
    for (const h of [null, "Bearer wrong_secret_wrong_secret_wrong_secret", `Bearer ${process.env.CRON_SECRET}`, SECRET]) {
      const a = await call(h);
      console.log(`credential ${h === null ? "none" : "wrong"}: ${show(a)}`);
      assert.equal(a.status, 401);
      assert.deepEqual(a.body, { error: "unauthorized" });
      assert.ok(a.ms < 500, `took ${a.ms}`);
      noStore(a); noLeak(a, secretsOf(bad, badAuth));
    }
    env(bad, badAuth, null);
    const n = await call(bearer);
    console.log(`no secret configured: ${show(n)}`);
    assert.equal(n.status, 503);
    assert.deepEqual(n.body, { error: "monitor_not_configured" });
    noStore(n);
    env(bad, badAuth, process.env.CRON_SECRET);
    const c = await call(`Bearer ${process.env.CRON_SECRET}`);
    console.log(`secret equal to CRON_SECRET: ${show(c)}`);
    assert.equal(c.status, 503);
    await new Promise((r) => setTimeout(r, 200));
    console.log(`black hole saw ${hole.connections()} connection(s)`);
    assert.equal(hole.connections(), 0, "a refused caller reached the database");
    hole.close();
  } else if (scenario === "recovery") {
    const proxy = await switchableProxy(new URL(RUNTIME));
    const via = withHostPort(RUNTIME, "127.0.0.1", proxy.port);
    env(via, AUTH);
    const a = await call(bearer);
    console.log(`before: ${show(a)}`);
    assert.equal(a.status, 200);
    proxy.cut();
    const b = await call(bearer);
    console.log(`database gone: ${show(b)}`);
    assert.equal(b.status, 503);
    assert.ok(["unreachable", "error", "timeout"].includes(String((b.body.checks as Record<string, string>).runtime)));
    assert.equal((b.body.checks as Record<string, string>).auth, "ok");
    proxy.restore();
    let c = await call(bearer);
    for (let i = 0; i < 3 && c.status !== 200; i += 1) c = await call(bearer); // the pool may need one probe to drop dead sockets
    console.log(`database back: ${show(c)}`);
    assert.equal(c.status, 200);
    assert.deepEqual(c.body.checks, { runtime: "ok", auth: "ok" });
    for (const x of [a, b, c]) { noStore(x); noLeak(x, secretsOf(via, AUTH, RUNTIME)); }
    proxy.close();
  } else {
    throw new Error(`unknown scenario "${scenario}"`);
  }
  console.log(`PASS ${scenario}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(`FAIL ${scenario}:`, e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
