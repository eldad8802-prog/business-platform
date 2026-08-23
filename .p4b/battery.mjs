/**
 * D2 / P4-B Steps 1-5 — Preview runtime-role cutover proof (PREVIEW ONLY).
 *
 * Single process:
 *  - OWNER (DIRECT_URL) provisions: SQL role app_runtime_preview + least-privilege
 *    grants + FORCE RLS on the 5 pilot tables + synthetic p4b-* fixtures.
 *  - RUNTIME (pooled, authenticates as app_runtime_preview) drives the REAL Next
 *    route handlers (P5 stack) to prove auth bootstrap + Customer + Customer Card
 *    + cross-tenant denial + no-context fail-closed + raw RLS + DDL denial +
 *    concurrency, on the real Neon Preview transport.
 *  - OWNER tears down ONLY the synthetic fixtures; the role + grants + RLS remain
 *    as substrate for Step 6.
 *
 * The role password is generated in-process and never printed. No public data
 * outside the p4b-* fixtures is touched. app_runtime is never referenced.
 */
import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { PrismaClient } from "@prisma/client";

const EXPECT_ENDPOINT = process.env.P4_EXPECT_ENDPOINT;
const EXPECT_DB = process.env.P4_EXPECT_DB;
const SUFFIX = process.env.P4_EXPECT_HOST_SUFFIX;
const DENY = (process.env.P4_DENY_ENDPOINTS || "").split(/\s+/).filter(Boolean);
const ROLE = "app_runtime_preview_p4b"; // fresh, never drop-recreated (Neon pooler caches role OID)
const GUC = "app.current_business_id";

const R = {};
const notes = [];
let failures = 0;
const mark = (k, ok, note) => { R[k] = ok ? "PASS" : "FAIL"; if (!ok) failures++; if (note) notes.push("[" + k + "] " + note); };
const check = (name, cond, extra = "") => { if (!cond) failures++; notes.push("  [" + (cond ? "PASS" : "FAIL") + "] " + name + (extra ? " — " + extra : "")); return cond; };
const empty = (v) => v === null || v === "";
const pgcode = (e) => { const m = /Code: `([^`]+)`/.exec(String(e && e.message)); const t = /Message: `([^`]+)`/.exec(String(e && e.message)); return (m ? m[1] : "N/A") + (t ? " " + t[1].slice(0, 80) : " " + String(e && e.message ? e.message : e).slice(0, 80)); };

function idOf(raw, name) {
  const u = new URL(raw);
  const first = u.hostname.split(".")[0];
  const ep = first.endsWith("-pooler") ? first.slice(0, -"-pooler".length) : first;
  if (DENY.includes(ep)) throw new Error(name + ": DENY endpoint");
  if (ep !== EXPECT_ENDPOINT) throw new Error(name + ": endpoint " + ep + " != " + EXPECT_ENDPOINT);
  if (!u.hostname.endsWith(SUFFIX)) throw new Error(name + ": suffix");
  if ((u.pathname || "").replace(/^\//, "") !== EXPECT_DB) throw new Error(name + ": db");
}
idOf(process.env.DATABASE_URL, "DATABASE_URL(owner-pooled)");
idOf(process.env.DIRECT_URL, "DIRECT_URL(owner-direct)");

const PW = "p4b" + randomBytes(20).toString("base64url");
const OWNER_POOLED = process.env.DATABASE_URL;
function runtimeUrl(base, pgbouncer) { const u = new URL(base); u.username = ROLE; u.password = PW; if (pgbouncer) u.searchParams.set("pgbouncer", "true"); return u.toString(); }
const RUNTIME_POOLED = runtimeUrl(OWNER_POOLED, false);
const RUNTIME_POOLED_PGB = runtimeUrl(OWNER_POOLED, true);

const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
const oexec = (sql) => owner.$executeRawUnsafe(sql);
const oq = (sql) => owner.$queryRawUnsafe(sql);

const PILOT = ["Customer", "BillingDocument", "PaymentRequest", "Conversation", "Appointment"];
const ids = {};

async function attrsOf(client, who) {
  const a = await client.$queryRawUnsafe("SELECT current_user::text AS u, (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS s, (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS b, (SELECT rolcreaterole FROM pg_roles WHERE rolname=current_user) AS cr, (SELECT rolcreatedb FROM pg_roles WHERE rolname=current_user) AS cd, (SELECT count(*)::int FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.roleid JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=current_user AND g.rolname='neon_superuser') AS ns, (SELECT count(*)::int FROM pg_tables WHERE tableowner=current_user) AS owns");
  return a[0];
}

async function cleanSlate() {
  // Self-healing from any prior (failed) run — clear OUR markers only (p4b-* / p4b_tenant).
  // NOTE: never drop+recreate the role in the same run — Neon's pooler caches the role
  // OID and a same-run recreate yields "invalid role OID" via the pooled endpoint.
  for (const t of PILOT) await oexec('DROP POLICY IF EXISTS p4b_tenant ON "' + t + '"').catch(() => {});
  const inMarker = 'IN (SELECT id FROM "Business" WHERE name LIKE \'p4b-%\')';
  for (const t of ["Appointment", "Conversation", "PaymentRequest", "BillingDocument", "Customer"]) await oexec('DELETE FROM "' + t + '" WHERE "businessId" ' + inMarker).catch(() => {});
  await oexec("DELETE FROM \"Customer\" WHERE name LIKE 'p4b-%'").catch(() => {});
  await oexec("DELETE FROM \"User\" WHERE email LIKE '%@p4b.test'").catch(() => {});
  await oexec("DELETE FROM \"Business\" WHERE name LIKE 'p4b-%'").catch(() => {});
}

async function provision() {
  await cleanSlate();
  // STEP 1 — role: create fresh, or REUSE a leftover (rotate password only — OID
  // preserved so the pooler keeps serving it). This is also the persistent-role model.
  const exists = Number((await oq("SELECT count(*)::int AS c FROM pg_roles WHERE rolname='" + ROLE + "'"))[0].c) > 0;
  if (exists) {
    await oexec("ALTER ROLE " + ROLE + " LOGIN PASSWORD '" + PW + "'");
    notes.push("[role] reused existing " + ROLE + " (password rotated, OID preserved)");
  } else {
    await oexec("CREATE ROLE " + ROLE + " LOGIN PASSWORD '" + PW + "' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT");
  }
  const ra = await oq("SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname='" + ROLE + "'");
  const nsm = await oq("SELECT count(*)::int AS c FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.roleid JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='" + ROLE + "' AND g.rolname='neon_superuser'");
  const own = await oq("SELECT count(*)::int AS c FROM pg_tables WHERE tableowner='" + ROLE + "'");
  const posture = ra[0].rolcanlogin === true && ra[0].rolsuper === false && ra[0].rolbypassrls === false && ra[0].rolcreaterole === false && ra[0].rolcreatedb === false && Number(nsm[0].c) === 0 && Number(own[0].c) === 0;
  mark("RUNTIME_ROLE_POSTURE", posture, "login=" + ra[0].rolcanlogin + " super=" + ra[0].rolsuper + " bypassrls=" + ra[0].rolbypassrls + " createrole=" + ra[0].rolcreaterole + " createdb=" + ra[0].rolcreatedb + " neon_superuser=" + nsm[0].c + " owns=" + own[0].c);
  if (!posture) throw new Error("role posture failed — STOP");

  // STEP 2/3 — least-privilege grants (bootstrap SELECT; pilot DML/read; no DDL, no _prisma_migrations).
  await oexec("GRANT CONNECT ON DATABASE " + EXPECT_DB + " TO " + ROLE);
  await oexec("GRANT USAGE ON SCHEMA public TO " + ROLE);
  await oexec('GRANT SELECT ON "User", "Business" TO ' + ROLE);
  await oexec('GRANT SELECT, INSERT, UPDATE, DELETE ON "Customer" TO ' + ROLE);
  await oexec('GRANT SELECT ON "BillingDocument", "PaymentRequest", "Conversation", "Appointment" TO ' + ROLE);
  await oexec('GRANT USAGE, SELECT ON SEQUENCE "Customer_id_seq" TO ' + ROLE);
  R.GRANT_MATRIX = "USAGE(public); SELECT(User,Business); SELECT/INSERT/UPDATE/DELETE(Customer)+seq; SELECT(BillingDocument,PaymentRequest,Conversation,Appointment); CONNECT. DENY: _prisma_migrations, DDL, other tables/sequences.";
  mark("LEAST_PRIVILEGE_GRANTS", true, R.GRANT_MATRIX);

  // STEP 4 — verify tenancy shape firsthand, then FORCE RLS + direct policy on the 5 pilot tables.
  const gucExpr = "NULLIF(current_setting('" + GUC + "', true), '')::int";
  for (const t of PILOT) {
    const has = await oq("SELECT count(*)::int AS c FROM information_schema.columns WHERE table_schema='public' AND table_name='" + t + "' AND column_name='businessId'");
    if (Number(has[0].c) !== 1) throw new Error(t + " is not direct-businessId — STOP (no guessing)");
    // Idempotent: drop any prior p4b policy, then (re)enable.
    await oexec('ALTER TABLE "' + t + '" ENABLE ROW LEVEL SECURITY');
    await oexec('ALTER TABLE "' + t + '" FORCE ROW LEVEL SECURITY');
    await oexec('DROP POLICY IF EXISTS p4b_tenant ON "' + t + '"');
    await oexec('CREATE POLICY p4b_tenant ON "' + t + '" USING ("businessId" = ' + gucExpr + ') WITH CHECK ("businessId" = ' + gucExpr + ')');
  }
  mark("PILOT_RLS", true, "ENABLE+FORCE + direct policy (USING+WITH CHECK) on " + PILOT.join(","));

  // Baseline (pilot table totals) — proves no collateral change later.
  R._baseline = {};
  for (const t of PILOT) R._baseline[t] = Number((await oq('SELECT count(*)::int AS c FROM "' + t + '"'))[0].c);

  // Synthetic p4b-* fixtures (owner bypasses RLS). Two synthetic tenants + related rows + poisoning.
  await oexec("INSERT INTO \"Business\"(name,\"updatedAt\") VALUES ('p4b-a-business', now()), ('p4b-b-business', now())");
  ids.bizA = Number((await oq("SELECT id FROM \"Business\" WHERE name='p4b-a-business'"))[0].id);
  ids.bizB = Number((await oq("SELECT id FROM \"Business\" WHERE name='p4b-b-business'"))[0].id);
  await oexec("INSERT INTO \"User\"(email,password,\"businessId\",\"updatedAt\") VALUES ('a@p4b.test','x'," + ids.bizA + ",now()), ('b@p4b.test','x'," + ids.bizB + ",now())");
  ids.userA = Number((await oq("SELECT id FROM \"User\" WHERE email='a@p4b.test'"))[0].id);
  ids.userB = Number((await oq("SELECT id FROM \"User\" WHERE email='b@p4b.test'"))[0].id);
  await oexec("INSERT INTO \"Customer\"(\"businessId\",name,\"updatedAt\") VALUES (" + ids.bizA + ",'p4b-a-customer',now()), (" + ids.bizB + ",'p4b-b-customer',now())");
  ids.custA = Number((await oq("SELECT id FROM \"Customer\" WHERE \"businessId\"=" + ids.bizA + " AND name='p4b-a-customer'"))[0].id);
  ids.custB = Number((await oq("SELECT id FROM \"Customer\" WHERE \"businessId\"=" + ids.bizB + " AND name='p4b-b-customer'"))[0].id);
  const rel = (biz, cust) => {
    return [
      "INSERT INTO \"BillingDocument\"(\"businessId\",\"documentType\",\"customerId\",\"updatedAt\") VALUES (" + biz + ",'TAX_INVOICE'," + cust + ",now())",
      "INSERT INTO \"PaymentRequest\"(\"businessId\",provider,amount,\"customerId\",\"updatedAt\") VALUES (" + biz + ",'TRANZILA',100," + cust + ",now())",
      "INSERT INTO \"Conversation\"(\"businessId\",channel,\"customerId\",\"updatedAt\") VALUES (" + biz + ",'WHATSAPP'," + cust + ",now())",
      "INSERT INTO \"Appointment\"(\"businessId\",\"createdByActor\",\"sourceChannel\",\"createdByUserId\",\"customerId\",\"startsAt\",\"updatedAt\") VALUES (" + biz + ",'OWNER','INBOX_WEB'," + (biz === ids.bizA ? ids.userA : ids.userB) + "," + cust + ",now(),now())",
    ];
  };
  for (const s of rel(ids.bizA, ids.custA)) await oexec(s);            // A owns A
  for (const s of rel(ids.bizB, ids.custB)) await oexec(s);            // B owns B
  for (const s of rel(ids.bizB, ids.custA)) await oexec(s);            // POISON: B owns, references A's customer
  notes.push("[fixtures] bizA=" + ids.bizA + " bizB=" + ids.bizB + " custA=" + ids.custA + " custB=" + ids.custB);

  // Owner-path control: owner still reads its synthetic rows (no lockout).
  const oc = await oq("SELECT count(*)::int AS c FROM \"Customer\" WHERE \"businessId\" IN (" + ids.bizA + "," + ids.bizB + ")");
  mark("OWNER_PATH_CONTROL", Number(oc[0].c) === 2, "owner sees both synthetic customers = " + oc[0].c + " (owner bypassrls intact)");
}

async function routeProof() {
  // Switch the singleton's datasource to the RUNTIME pooled role BEFORE importing app code.
  process.env.DATABASE_URL = RUNTIME_POOLED;
  const { GET, POST } = await import("@/app/api/customers/route");
  const idRoute = await import("@/app/api/customers/[id]/route");
  const { signAuthToken } = await import("@/lib/auth-token");
  const { prisma: rt } = await import("@/lib/prisma");
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const { withTenantTransaction } = await import("@/lib/tenant/transaction");
  const { NextRequest } = await import("next/server");

  // Pooler propagation guard (P4-B-POOLCHECK showed ~1s; provisioning already elapsed longer).
  for (let i = 0; i < 6; i++) { try { await rt.$queryRaw`SELECT 1`; break; } catch (e) { if (i === 5) throw e; await new Promise((r) => setTimeout(r, 2000)); } }

  const tokenA = signAuthToken(ids.userA), tokenB = signAuthToken(ids.userB);
  const getReq = (tok, qs = "") => new NextRequest("http://localhost/api/customers" + qs, { headers: { authorization: "Bearer " + tok } });
  const jsonReq = (method, tok, body) => new NextRequest("http://localhost/api/customers", { method, headers: { authorization: "Bearer " + tok, "content-type": "application/json" }, body: JSON.stringify(body) });
  const cardReq = (tok) => new NextRequest("http://localhost/api/customers/x", { headers: { authorization: "Bearer " + tok } });
  const getCard = (tok, id) => idRoute.GET(cardReq(tok), { params: Promise.resolve({ id: String(id) }) });

  // Runtime posture (through the pooled runtime connection the handlers use).
  const at = await attrsOf(rt);
  R.RUNTIME_CURRENT_USER = at.u;
  mark("RUNTIME_POOLED_IDENTITY", at.u === ROLE && at.s === false && at.b === false && Number(at.ns) === 0 && Number(at.owns) === 0, "current_user=" + at.u + " super=" + at.s + " bypassrls=" + at.b + " neon_superuser=" + at.ns + " owns=" + at.owns);

  // AUTH BOOTSTRAP — getCurrentUser looks up User+Business as the runtime role (no RLS on them).
  const rb = await GET(getReq(tokenA));
  mark("AUTH_BOOTSTRAP", rb.status === 200, "GET /api/customers as A -> " + rb.status + " (getCurrentUser resolved via runtime SELECT on User/Business)");

  // CUSTOMER pilot.
  const jA = await (await GET(getReq(tokenA))).json();
  const jB = await (await GET(getReq(tokenB))).json();
  check("A lists own (1)", jA.customers?.length === 1, "n=" + jA.customers?.length);
  check("B lists own (1)", jB.customers?.length === 1, "n=" + jB.customers?.length);
  const r5 = await POST(jsonReq("POST", tokenA, { name: "p4b-a-created" }));
  check("A create own -> 201", r5.status === 201, "status=" + r5.status);
  const r6 = await POST(jsonReq("POST", tokenA, { name: "p4b-evil", businessId: ids.bizB }));
  const evilA = Number((await owner.$queryRawUnsafe("SELECT count(*)::int AS c FROM \"Customer\" WHERE name='p4b-evil' AND \"businessId\"=" + ids.bizA))[0].c);
  const evilB = Number((await owner.$queryRawUnsafe("SELECT count(*)::int AS c FROM \"Customer\" WHERE name='p4b-evil' AND \"businessId\"=" + ids.bizB))[0].c);
  check("malicious body businessId=B ignored (A only)", r6.status === 201 && evilA === 1 && evilB === 0, "A=" + evilA + " B=" + evilB);
  const r4 = await idRoute.PATCH(jsonReq("PATCH", tokenA, { name: "hacked" }), { params: Promise.resolve({ id: String(ids.custB) }) });
  check("A update B -> 404", r4.status === 404, "status=" + r4.status);
  mark("CUSTOMER_ROUTES", true);

  // CUSTOMER CARD — section-by-section + poisoning control.
  const cardA = await getCard(tokenA, ids.custA);
  const cA = await cardA.json();
  check("A card root = A", cardA.status === 200 && cA.customer?.id === ids.custA, "status=" + cardA.status + " id=" + cA.customer?.id);
  check("card billing = 1 (own)", cA.billingDocuments?.total === 1, "total=" + cA.billingDocuments?.total);
  check("card payments = 1 (own)", cA.paymentRequests?.total === 1, "total=" + cA.paymentRequests?.total);
  check("card conversations = 1 (own)", cA.conversations?.total === 1, "total=" + cA.conversations?.total);
  check("card appointments = 1 (own)", cA.appointments?.total === 1, "total=" + cA.appointments?.total);
  const cardCross = await getCard(tokenA, ids.custB);
  check("A reads B card -> 404", cardCross.status === 404, "status=" + cardCross.status);
  mark("CUSTOMER_CARD", true);
  // POISONING: B-owned related rows referencing custA must not appear on A's card (totals stay 1).
  mark("POISONING_CONTROL", cA.billingDocuments?.total === 1 && cA.paymentRequests?.total === 1 && cA.conversations?.total === 1 && cA.appointments?.total === 1, "all A card sections = 1 (B-owned A-ref excluded)");

  // NO-CONTEXT fail-closed (runtime tenant helper without ALS).
  let noCtx = false;
  try { await withTenantTransaction((tx) => tx.customer.count()); } catch { noCtx = true; }
  mark("NO_CONTEXT", noCtx, "withTenantTransaction with no ALS context threw (fail-closed)");

  // RAW RLS-only: under context A, count B's customers by explicit businessId (no app filter) -> 0.
  const rawB = await runWithTenantContext({ businessId: ids.bizA }, () => withTenantTransaction((tx) => tx.customer.count({ where: { businessId: ids.bizB } })));
  const rawCross = await runWithTenantContext({ businessId: ids.bizA }, () => withTenantTransaction((tx) => tx.billingDocument.count({ where: { businessId: ids.bizB } })));
  mark("RAW_RLS", Number(rawB) === 0 && Number(rawCross) === 0, "context A sees B rows: customer=" + rawB + " billing=" + rawCross + " (RLS blocks, not app filter)");

  // DDL DENIAL (runtime credential). Harmless disposable probes.
  const denied = async (fn) => { try { await fn(); return false; } catch { return true; } };
  const dC = await denied(() => rt.$executeRawUnsafe("CREATE TABLE public.p4b_evil (x int)"));
  const dA = await denied(() => rt.$executeRawUnsafe('ALTER TABLE "Customer" ADD COLUMN p4b_evil int'));
  const dD = await denied(() => rt.$executeRawUnsafe('DROP TABLE "Appointment"'));
  const dR = await denied(() => rt.$executeRawUnsafe("CREATE ROLE p4b_evil_role LOGIN"));
  const dM = await denied(() => rt.$queryRawUnsafe("SELECT count(*) FROM public._prisma_migrations"));
  mark("DDL_DENIAL", dC && dA && dD && dR && dM, "create=" + dC + " alter=" + dA + " drop=" + dD + " createRole=" + dR + " _prisma_migrations=" + dM);

  // CONCURRENCY — each tenant sees exactly its OWN customers (route proofs added
  // rows to A, so compute expected counts per tenant rather than assume 1).
  const expA = Number((await owner.$queryRawUnsafe("SELECT count(*)::int AS c FROM \"Customer\" WHERE \"businessId\"=" + ids.bizA))[0].c);
  const expB = Number((await owner.$queryRawUnsafe("SELECT count(*)::int AS c FROM \"Customer\" WHERE \"businessId\"=" + ids.bizB))[0].c);
  async function concProbe(url) {
    const c = new PrismaClient({ datasourceUrl: url });
    try {
      const N = 12;
      const res = await Promise.allSettled(Array.from({ length: N }, (_, i) => {
        const biz = i % 2 === 0 ? ids.bizA : ids.bizB;
        const exp = i % 2 === 0 ? expA : expB;
        return c.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT set_config(${GUC}, ${String(biz)}, true)`;
          await tx.$executeRawUnsafe("SELECT pg_sleep(0.02)");
          const got = (await tx.$queryRaw`SELECT current_setting(${GUC}, true) AS v`)[0].v;
          const seen = Number((await tx.$queryRawUnsafe("SELECT count(*)::int AS c FROM \"Customer\""))[0].c);
          return { want: String(biz), got, seen, exp };
        }, { maxWait: 15000, timeout: 20000 });
      }));
      const ok = res.filter((r) => r.status === "fulfilled").map((r) => r.value);
      // Isolation: read back own GUC (got===want) AND see exactly own-tenant rows (seen===exp, no cross-leak).
      const bad = ok.filter((r) => r.got !== r.want || r.seen !== r.exp).length;
      return { total: N, ok: ok.length, bad, err: res.length - ok.length, sample: res.find((r) => r.status === "rejected")?.reason };
    } finally { try { await c.$disconnect(); } catch {} }
  }
  let conc = await concProbe(RUNTIME_POOLED);
  if (conc.err === 0 && conc.bad === 0) {
    R.PGBOUNCER_REQUIRED = "NOT REQUIRED";
  } else {
    // Preserve plain-failure evidence, then retry pgbouncer=true. An auth/RLS/grant
    // issue would NOT be fixed by pgbouncer, so it stays failed (correctly surfaced).
    notes.push("[concurrency] plain pooled: " + conc.ok + "/" + conc.total + " ok, " + conc.err + " errors" + (conc.sample ? " (" + pgcode(conc.sample) + ")" : "") + " -> retrying pgbouncer=true");
    conc = await concProbe(RUNTIME_POOLED_PGB);
    R.PGBOUNCER_REQUIRED = conc.err === 0 && conc.bad === 0 ? "REQUIRED" : "UNRESOLVED";
  }
  mark("CONCURRENT_ISOLATION", conc.err === 0 && conc.bad === 0, conc.ok + "/" + conc.total + " ok, " + conc.bad + " cross, " + conc.err + " errors (" + (R.PGBOUNCER_REQUIRED) + ")");

  try { await rt.$disconnect(); } catch {}
}

async function teardown() {
  // Remove ONLY synthetic fixtures (by our synthetic businessIds). Keep role/grants/RLS.
  try {
    if (ids.bizA && ids.bizB) {
      const inBiz = "(" + ids.bizA + "," + ids.bizB + ")";
      for (const t of ["Appointment", "Conversation", "PaymentRequest", "BillingDocument", "Customer"]) await oexec('DELETE FROM "' + t + '" WHERE "businessId" IN ' + inBiz);
      await oexec("DELETE FROM \"User\" WHERE \"businessId\" IN " + inBiz);
      await oexec("DELETE FROM \"Business\" WHERE id IN " + inBiz);
    }
    const leftover = ids.bizA ? Number((await oq("SELECT count(*)::int AS c FROM \"Customer\" WHERE \"businessId\" IN (" + ids.bizA + "," + ids.bizB + ")"))[0].c) : 0;
    const bizGone = ids.bizA ? Number((await oq("SELECT count(*)::int AS c FROM \"Business\" WHERE id IN (" + ids.bizA + "," + ids.bizB + ")"))[0].c) : 0;
    // Collateral check: pilot totals back to baseline.
    let collateral = "ok";
    if (R._baseline) for (const t of PILOT) { const now = Number((await oq('SELECT count(*)::int AS c FROM "' + t + '"'))[0].c); if (now !== R._baseline[t]) collateral = t + " " + R._baseline[t] + "->" + now; }
    R.SYNTHETIC_RESIDUE = (leftover === 0 && bizGone === 0) ? "0" : "FAILURE(" + leftover + "/" + bizGone + ")";
    R._collateral = collateral;
    notes.push("[teardown] synthetic_customer_leftover=" + leftover + " synthetic_business_leftover=" + bizGone + " pilot_totals=" + collateral);
  } catch (e) { R.SYNTHETIC_RESIDUE = "FAILURE"; notes.push("[teardown] " + pgcode(e)); }
}

let fatal = null;
try { await provision(); await routeProof(); } catch (e) { fatal = e; notes.push("[fatal] " + String(e && e.message ? e.message : e).slice(0, 300)); }
await teardown();
try { await owner.$disconnect(); } catch {}

const gates = ["RUNTIME_ROLE_POSTURE", "LEAST_PRIVILEGE_GRANTS", "PILOT_RLS", "OWNER_PATH_CONTROL", "RUNTIME_POOLED_IDENTITY", "AUTH_BOOTSTRAP", "CUSTOMER_ROUTES", "CUSTOMER_CARD", "POISONING_CONTROL", "NO_CONTEXT", "RAW_RLS", "DDL_DENIAL", "CONCURRENT_ISOLATION"];
const allPass = gates.every((k) => R[k] === "PASS") && failures === 0 && R.SYNTHETIC_RESIDUE === "0" && !fatal;
R.STEPS = allPass ? "PASS" : "FAIL";

const L = (k, v) => k.padEnd(30) + "= " + v;
const report = [
  L("RUNTIME ROLE", ROLE),
  L("RUNTIME CURRENT_USER", R.RUNTIME_CURRENT_USER || "?"),
  L("RUNTIME ROLE POSTURE", R.RUNTIME_ROLE_POSTURE || "FAIL"),
  L("LEAST-PRIVILEGE GRANTS", R.LEAST_PRIVILEGE_GRANTS || "FAIL"),
  L("PILOT RLS", R.PILOT_RLS || "FAIL"),
  L("OWNER PATH CONTROL", R.OWNER_PATH_CONTROL || "FAIL"),
  L("AUTH BOOTSTRAP", R.AUTH_BOOTSTRAP || "FAIL"),
  L("CUSTOMER ROUTES", R.CUSTOMER_ROUTES || "FAIL"),
  L("CUSTOMER CARD", R.CUSTOMER_CARD || "FAIL"),
  L("POISONING CONTROL", R.POISONING_CONTROL || "FAIL"),
  L("NO-CONTEXT", R.NO_CONTEXT || "FAIL"),
  L("RAW RLS", R.RAW_RLS || "FAIL"),
  L("DDL DENIAL", R.DDL_DENIAL || "FAIL"),
  L("CONCURRENT ISOLATION", R.CONCURRENT_ISOLATION || "FAIL"),
  L("PGBOUNCER=true", R.PGBOUNCER_REQUIRED || "UNRESOLVED"),
  L("SYNTHETIC RESIDUE", R.SYNTHETIC_RESIDUE || "FAILURE"),
  L("COLLATERAL (pilot totals)", R._collateral || "?"),
  L("PERSISTENT PREVIEW MUTATIONS", "role " + ROLE + " + least-privilege grants + FORCE RLS(p4b_tenant) on " + PILOT.join(",")),
  L("PRODUCTION TOUCHED", "NO"),
  L("P4-B STEPS 1-5", R.STEPS),
];
console.log("\n" + report.join("\n") + "\n--- checks ---\n" + notes.join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) { const fs = await import("node:fs"); fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, "## D2 / P4-B Steps 1-5\n\n```\n" + report.join("\n") + "\n```\n"); }
if (fatal || R.STEPS !== "PASS") process.exit(1);
