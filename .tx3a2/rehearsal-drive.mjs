/**
 * D2 / PRODUCTION-RUNTIME-CUTOVER-3A.2 — drive the real application through the
 * restricted Preview runtime identity.
 *
 * This is the *behavioural* half of the rehearsal. The provisioning script proved
 * the identity has the right shape; this proves the application actually WORKS
 * when it is the only identity available:
 *
 *   - real Next.js server (production build), not a test harness
 *   - real HTTP against real route handlers
 *   - real authentication (signup issues a session, every later call carries it)
 *   - real non-empty synthetic tenant data created THROUGH the product
 *   - two tenants, so isolation is observable rather than assumed
 *
 * Every request is classified, because on Preview three very different things can
 * make a route fail and only one of them is a finding:
 *
 *   RESTRICTED-RUNTIME  the role lacks a privilege, or RLS refused it   -> FINDING
 *   PREVIEW-DRIFT       Preview's schema is behind main's migrations    -> not a finding
 *   EXTERNAL-DEP        R2 / Redis / Vision credentials are absent      -> not a finding
 *
 * Collapsing those three into "it failed" is how a rehearsal produces a false
 * verdict in either direction, so the classifier is deliberately explicit and
 * anything it cannot place is reported as UNCLASSIFIED rather than excused.
 *
 * PREVIEW ONLY. Touches no Production role, credential, grant, policy or row.
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const BASE = process.env.REHEARSAL_BASE_URL ?? "http://127.0.0.1:3210";

let pass = 0;
let fail = 0;
const findings = [];
const notFindings = [];

function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}

/** Preview's schema is behind main; those columns/tables simply are not there. */
const DRIFT = /column .* does not exist|relation .* does not exist|Unknown argument|clientRequestId/i;
/** Object storage, Redis and Vision have no Preview credentials in this run. */
const EXTERNAL = /R2_|UPSTASH|GOOGLE_VISION|RateLimiterConfigError|fetch failed|ENOTFOUND|ECONNREFUSED (?!127)/i;
/** The two shapes a restricted identity fails with — loud refusal, or silent zero. */
const RESTRICTED = /permission denied|must be owner|row-level security|violates row-level|insufficient privilege|nextval|currval|setval/i;

function classify(text) {
  if (!text) return null;
  if (RESTRICTED.test(text)) return "RESTRICTED-RUNTIME";
  if (DRIFT.test(text)) return "PREVIEW-DRIFT";
  if (EXTERNAL.test(text)) return "EXTERNAL-DEP";
  return "UNCLASSIFIED";
}

async function call(method, path, { token, body } = {}) {
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const logBefore = logSize();
  let res, text;
  try {
    res = await fetch(BASE + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      redirect: "manual",
    });
    text = await res.text();
  } catch (e) {
    return { status: 0, text: String(e?.message ?? e), json: null, serverLog: serverTail(logBefore) };
  }
  let json = null;
  try { json = JSON.parse(text); } catch { /* HTML page */ }
  // Give the handler's own stderr a moment to land before attributing a cause.
  const serverLog = res.status >= 500
    ? await new Promise((r) => setTimeout(() => r(serverTail(logBefore)), 250))
    : "";
  return { status: res.status, text, json, serverLog, headers: res.headers };
}

/**
 * A 500 body in this product is the opaque string `{"error":"Server error"}` — by
 * design, so the client learns nothing. That means the HTTP response alone CANNOT
 * be classified, and a classifier fed only the body would mark every real failure
 * "UNCLASSIFIED". The cause is on the server's stderr, so that is what gets read.
 */
const SERVER_LOG = process.env.REHEARSAL_SERVER_LOG ?? null;
function serverTail(sinceBytes) {
  if (!SERVER_LOG) return "";
  try {
    const buf = require("node:fs").readFileSync(SERVER_LOG);
    return buf.subarray(sinceBytes).toString("utf8");
  } catch { return ""; }
}
function logSize() {
  if (!SERVER_LOG) return 0;
  try { return require("node:fs").statSync(SERVER_LOG).size; } catch { return 0; }
}

/** A route is "healthy" if it answered without a server-side failure. */
function record(label, r, { expectOk = true } = {}) {
  const serverError = r.status === 0 || r.status >= 500;
  if (!serverError) {
    if (expectOk) ok(`${label} -> ${r.status}`, r.status < 400 || r.status === 401 || r.status === 403);
    return true;
  }
  const server = r.serverLog ?? "";
  const kind = classify(server) ?? classify(r.text);
  const snippet = (server || r.text).slice(0, 220).replace(/\s+/g, " ");
  if (kind === "RESTRICTED-RUNTIME" || kind === "UNCLASSIFIED") {
    findings.push({ label, status: r.status, kind, snippet });
    ok(`${label} -> ${r.status} [${kind}]`, false, snippet);
  } else {
    notFindings.push({ label, status: r.status, kind, snippet });
    console.log(`  [SKIP] ${label} -> ${r.status} [${kind}] (not a restricted-runtime defect)`);
  }
  return false;
}

/** Sessions are Bearer tokens, not cookies — the register route returns one. */
function tokenFrom(r) {
  return r.json?.token ?? r.json?.session?.token ?? r.json?.authToken ?? null;
}

async function signup(tag) {
  const email = `rehearsal.${tag}.${process.env.REHEARSAL_STAMP}@example.invalid`;
  const r = await call("POST", "/api/auth/register", {
    body: {
      email,
      password: "Rehearsal!Passw0rd",
      name: `Rehearsal ${tag}`,
      businessName: `Rehearsal Tenant ${tag}`,
    },
  });
  if (r.status >= 500 || r.status === 0) {
    record(`signup(${tag})`, r);
    return null;
  }
  const token = tokenFrom(r) ?? r.json?.token ?? null;
  ok(`signup(${tag}) created a tenant and issued a session (${r.status})`,
    r.status < 400 && !!token, `${r.status} ${r.text.slice(0, 160)}`);
  return token ? { token, email, businessId: r.json?.businessId ?? r.json?.business?.id ?? null } : null;
}

async function main() {
  console.log(`== rehearsal target: ${BASE} ==`);

  // ---- 0. the server is up and serving the real build ----------------------
  const health = await call("GET", "/api/auth/me");
  ok("server answers (unauthenticated /api/auth/me)", health.status !== 0, health.text.slice(0, 120));
  if (health.status === 0) { console.log("\n[drive] server unreachable"); process.exit(1); }

  // ---- 1. two real tenants, created through the product --------------------
  console.log("\n== 1. authenticated signup (real writes as the restricted role) ==");
  const a = await signup("a");
  const b = await signup("b");
  if (!a) { console.log("\n[drive] tenant A signup failed — cannot continue"); }

  // ---- 2. authenticated identity round-trips -------------------------------
  console.log("\n== 2. authenticated session round-trip ==");
  if (a) {
    const me = await call("GET", "/api/auth/me", { token: a.token });
    record("GET /api/auth/me (tenant A)", me);
    ok("authenticated /me returns tenant A", me.status === 200 && me.text.includes("Rehearsal Tenant a"),
      `${me.status} ${me.text.slice(0, 160)}`);
  }

  // ---- 3. read paths across the RLS surface --------------------------------
  console.log("\n== 3. authenticated READ paths (silent-zero is the hazard here) ==");
  const READS = [
    "/api/customers",
    "/api/inventory/items",
    "/api/documents",
    "/api/billing/documents",
    "/api/offers",
    "/api/leads",
    "/api/business-status",
    "/api/suppliers",
  ];
  for (const p of READS) {
    if (!a) break;
    const r = await call("GET", p, { token: a.token });
    record(`GET ${p}`, r);
  }

  // ---- 4. a real tenant WRITE, then read it back ---------------------------
  console.log("\n== 4. authenticated WRITE then read-back (non-empty data) ==");
  let created = null;
  if (a) {
    const w = await call("POST", "/api/customers", {
      token: a.token,
      body: { name: "לקוח חזרה כללית", phone: "050-0000000" },
    });
    if (record("POST /api/customers (tenant A)", w)) {
      created = w.json?.id ?? w.json?.customer?.id ?? null;
      ok("customer write accepted under FORCE RLS + restricted role",
        w.status < 400, `${w.status} ${w.text.slice(0, 160)}`);
      const back = await call("GET", "/api/customers", { token: a.token });
      ok("tenant A reads its OWN customer back (not a silent zero)",
        back.status === 200 && back.text.includes("לקוח חזרה כללית"),
        `${back.status} ${back.text.slice(0, 200)}`);
    }
  }

  // ---- 5. cross-tenant isolation, observed through the product -------------
  console.log("\n== 5. cross-tenant isolation through real HTTP ==");
  if (a && b) {
    const bSees = await call("GET", "/api/customers", { token: b.token });
    if (bSees.status < 500) {
      ok("tenant B does NOT see tenant A's customer",
        !bSees.text.includes("לקוח חזרה כללית"), bSees.text.slice(0, 200));
    } else {
      record("GET /api/customers (tenant B)", bSees);
    }
  }

  // ---- 6. server-rendered authenticated pages ------------------------------
  console.log("\n== 6. server-rendered authenticated pages ==");
  const PAGES = ["/app", "/customers", "/inventory", "/documents", "/revenue"];
  for (const p of PAGES) {
    if (!a) break;
    const r = await call("GET", p, { token: a.token });
    record(`GET ${p} (SSR)`, r);
  }

  // ---- 7. verdict ----------------------------------------------------------
  console.log(`\n[drive] PASS=${pass} FAIL=${fail}`);
  console.log(`[drive] restricted-runtime findings: ${findings.length}`);
  for (const f of findings) console.log(`   FINDING ${f.kind} ${f.label} (${f.status}) ${f.snippet}`);
  console.log(`[drive] non-findings (drift / external dep): ${notFindings.length}`);
  for (const f of notFindings) console.log(`   ${f.kind} ${f.label} (${f.status})`);
  process.exit(findings.length > 0 ? 1 : fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", String(e?.stack ?? e).slice(0, 600)); process.exit(1); });
