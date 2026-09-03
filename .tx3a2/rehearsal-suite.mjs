/**
 * D2 / PRODUCTION-RUNTIME-CUTOVER-3A.2 — the Preview restricted-runtime rehearsal.
 *
 * Proves that the REAL application, deployed and serving over HTTPS, works when
 * its only database identity is restricted, NOBYPASSRLS and non-owner.
 *
 * The design is shaped by the two ways this can silently look fine:
 *
 *   silent zero    Under RLS a context-less SELECT returns zero rows and raises
 *                  NOTHING. `200 []` is indistinguishable from success unless the
 *                  fixture is known non-empty. So every read is asserted as
 *                  EXPECTED vs ACTUAL against a seeded count, never on status.
 *
 *   false success  An UPDATE that matches no row still reports success. So every
 *                  mutation is verified by reading the value back and comparing
 *                  it to the before-state, never on the API's own say-so.
 *
 * Fixtures are seeded as the restricted role itself, inside the canonical
 * transaction-local GUC, which makes the seeding a proof in its own right: if the
 * runtime could not write under RLS, there would be no fixture to read.
 *
 * Everything created is namespaced by a run tag and confined to two synthetic
 * tenants. No Production data is read or written.
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";

const BASE = process.env.REHEARSAL_BASE_URL;
const PROBE = process.env.D2_PROBE_TOKEN ?? "";
const TAG = process.env.REHEARSAL_STAMP ?? `t${Date.now()}`;
const db = new PrismaClient({ datasourceUrl: readFileSync(process.env.REHEARSAL_URL_FILE, "utf8").trim() });

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; failures.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
function section(t) { console.log(`\n== ${t} ==`); }

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
async function call(method, path, { token, body, headers: extra } = {}) {
  const headers = { ...(extra ?? {}) };
  if (body) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const res = await fetch(BASE + path, {
      method, headers, body: body ? JSON.stringify(body) : undefined, redirect: "manual",
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, text, json };
  } catch (e) {
    return { status: 0, text: String(e?.message ?? e), json: null };
  }
}

/** Every list route wraps its payload differently; find the array. */
function rowsOf(json, ...keys) {
  if (Array.isArray(json)) return json;
  for (const k of keys) {
    const v = json?.[k];
    if (Array.isArray(v)) return v;
    if (Array.isArray(v?.items)) return v.items;
  }
  for (const v of Object.values(json ?? {})) if (Array.isArray(v)) return v;
  return null;
}

/** Count only rows this run created, so pre-existing Preview data cannot inflate. */
function mine(rows) {
  if (!rows) return null;
  return rows.filter((r) => JSON.stringify(r).includes(TAG)).length;
}

// ---------------------------------------------------------------------------
// tenant-context SQL — exactly what withTenantTransaction does
// ---------------------------------------------------------------------------
function withCtx(businessId, fn) {
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(businessId));
    return fn(tx);
  }, { timeout: 20000 });
}

async function main() {
  if (!BASE) { console.error("REHEARSAL_BASE_URL is required"); process.exit(2); }
  console.log(`== target: ${BASE} ==`);
  console.log(`== run tag: ${TAG} ==`);

  // -------------------------------------------------------------------------
  section("F. actual runtime identity (HARD GATE)");
  const idp = await call("GET", "/api/dev/d2-runtime-identity", { headers: { "x-d2-probe": PROBE } });
  const ident = idp.json?.identity ?? null;
  ok("probe answered from the deployed application", idp.status === 200 && !!ident,
    `${idp.status} ${idp.text.slice(0, 200)}`);
  if (ident) {
    console.log(`     current_user=${ident.current_user} bypassrls=${ident.bypassrls} owns=${ident.owned_relations} memberships=[${ident.memberships}] rls_tables=${ident.rls_tables}`);
    ok("application runs as the restricted role", ident.current_user === "app_runtime_prev_rehearsal", ident.current_user);
    ok("application identity is NOT superuser", ident.is_superuser === "off", ident.is_superuser);
    ok("application identity has BYPASSRLS = false", ident.bypassrls === false);
    ok("application identity owns 0 application relations", ident.owned_relations === 0, String(ident.owned_relations));
    ok("application identity is member of app_runtime ONLY",
      ident.memberships.length === 1 && ident.memberships[0] === "app_runtime", JSON.stringify(ident.memberships));
    ok("application identity cannot read the migration ledger", ident.can_read_ledger === false);
  }
  const unguarded = await call("GET", "/api/dev/d2-runtime-identity");
  ok("probe is refused (404) without the token", unguarded.status === 404, String(unguarded.status));

  // -------------------------------------------------------------------------
  section("L. signup persists Business + User, and login then works");
  const tenants = {};
  for (const tag of ["a", "b"]) {
    const email = `d2.${TAG}.${tag}@example.invalid`;
    const password = "Rehearsal!Passw0rd";
    const reg = await call("POST", "/api/auth/register", {
      body: { email, password, name: `D2 ${tag.toUpperCase()}`, businessName: `D2 Tenant ${tag.toUpperCase()} ${TAG}` },
    });
    const okReg = reg.status < 400 && !!reg.json?.token;
    ok(`signup(${tag}) returned a session`, okReg, `${reg.status} ${reg.text.slice(0, 200)}`);
    if (!okReg) continue;
    const businessId = reg.json.businessId;

    // The API said yes. That is not evidence — read the rows back from the DB.
    const persisted = await withCtx(businessId, (tx) => tx.$queryRawUnsafe(
      `SELECT (SELECT count(*)::int FROM "Business" WHERE id=$1) b,
              (SELECT count(*)::int FROM "User" WHERE "businessId"=$1) u`, businessId));
    ok(`signup(${tag}) PERSISTED Business (not a swallowed rollback)`, persisted[0].b === 1, JSON.stringify(persisted[0]));
    ok(`signup(${tag}) PERSISTED User`, persisted[0].u >= 1, JSON.stringify(persisted[0]));

    const login = await call("POST", "/api/auth/login", { body: { email, password } });
    const token = login.json?.token ?? reg.json.token;
    ok(`login(${tag}) after signup works`, login.status < 400 && !!login.json?.token,
      `${login.status} ${login.text.slice(0, 160)}`);
    tenants[tag] = { token, businessId, email };
  }
  const A = tenants.a;
  const B = tenants.b;
  if (!A || !B) { console.log("\n[suite] both tenants are required — stopping"); await done(); }

  // -------------------------------------------------------------------------
  section("G. non-empty synthetic fixtures (seeded AS the restricted role, under RLS)");
  const EXPECT = { customer: 3, conversation: 2, appointment: 2, billingDocument: 2, paymentRequest: 2, inventory: 2, supplier: 2, lead: 2 };
  const seeded = {};

  async function seed(label, tenant, n, sql) {
    try {
      await withCtx(tenant.businessId, async (tx) => {
        for (let i = 0; i < n; i += 1) await sql(tx, i, tenant.businessId);
      });
      seeded[label] = (seeded[label] ?? 0) + n;
      return true;
    } catch (e) {
      console.log(`  [SEED-FAIL] ${label}: ${String(e?.message ?? e).split("\n").slice(-2).join(" ").slice(0, 200)}`);
      return false;
    }
  }

  for (const [k, t] of Object.entries({ a: A, b: B })) {
    const N = EXPECT;
    await seed(`customer.${k}`, t, N.customer, (tx, i, bid) => tx.$executeRawUnsafe(
      `INSERT INTO "Customer" ("businessId","name","createdAt","updatedAt") VALUES ($1,$2,now(),now())`,
      bid, `${TAG}-cust-${k}-${i}`));
    await seed(`conversation.${k}`, t, N.conversation, (tx, i, bid) => tx.$executeRawUnsafe(
      `INSERT INTO "Conversation" ("businessId","channel","outcomeReason","createdAt","updatedAt")
       VALUES ($1,'WHATSAPP',$2,now(),now())`, bid, `${TAG}-conv-${k}-${i}`));
    await seed(`lead.${k}`, t, N.lead, (tx, i, bid) => tx.$executeRawUnsafe(
      `INSERT INTO "Lead" ("businessId","customerName","createdAt","updatedAt")
       VALUES ($1,$2,now(),now())`, bid, `${TAG}-lead-${k}-${i}`));
    await seed(`supplier.${k}`, t, N.supplier, (tx, i, bid) => tx.$executeRawUnsafe(
      `INSERT INTO "Supplier" ("businessId","name","createdAt","updatedAt") VALUES ($1,$2,now(),now())`,
      bid, `${TAG}-supp-${k}-${i}`));
    await seed(`inventory.${k}`, t, N.inventory, (tx, i, bid) => tx.$executeRawUnsafe(
      `INSERT INTO "InventoryItem" ("businessId","name","unitType","currentQuantity","createdAt","updatedAt")
       VALUES ($1,$2,'UNIT',10,now(),now())`, bid, `${TAG}-inv-${k}-${i}`));
  }
  console.log(`  seeded: ${JSON.stringify(seeded)}`);
  ok("fixtures seeded THROUGH the restricted role under RLS (writes work)",
    Object.keys(seeded).length > 0, "nothing could be seeded");

  // -------------------------------------------------------------------------
  section("H + J. authenticated reads — EXPECTED vs ACTUAL (silent-zero gate)");
  const READS = [
    ["Customer",     "/api/customers",            EXPECT.customer,  ["customers", "data", "items"]],
    ["Conversation", "/api/conversations",        EXPECT.conversation, ["conversations", "data", "items"]],
    ["Lead",         "/api/leads",                EXPECT.lead,      ["leads", "data", "items"]],
    ["Supplier",     "/api/inventory/suppliers",  EXPECT.supplier,  ["suppliers", "data", "items"]],
    ["Inventory",    "/api/inventory/items",      EXPECT.inventory, ["items", "data", "products"]],
  ];
  for (const [label, path, expected, keys] of READS) {
    if (!seeded[`${label.toLowerCase()}.a`] && !seeded[`customer.a`]) continue;
    const r = await call("GET", path, { token: A.token });
    const rows = rowsOf(r.json, ...keys);
    const actual = mine(rows);
    console.log(`     ${label}: HTTP ${r.status}  expected=${expected}  actual=${actual === null ? "UNREADABLE" : actual}`);
    ok(`${label}: tenant A sees its ${expected} seeded rows (200+[] would be a silent zero)`,
      actual === expected, `got ${actual === null ? `unparseable body ${r.text.slice(0, 140)}` : actual}`);
  }

  // -------------------------------------------------------------------------
  section("I. cross-tenant READ isolation (must be 0 successes)");
  let crossReads = 0;
  for (const [label, path, , keys] of READS) {
    const r = await call("GET", path, { token: B.token });
    const rows = rowsOf(r.json, ...keys);
    if (!rows) { console.log(`     ${label}: unreadable body — skipped`); continue; }
    const leaked = rows.filter((x) => JSON.stringify(x).includes(`${TAG}-`) && JSON.stringify(x).includes("-a-")).length;
    crossReads += leaked;
    ok(`${label}: tenant B sees ZERO of tenant A's rows`, leaked === 0, `leaked ${leaked}`);
  }
  ok("cross-tenant read successes = 0", crossReads === 0, String(crossReads));

  // -------------------------------------------------------------------------
  section("I. cross-tenant WRITE isolation (must be 0 successes)");
  let crossWrites = 0;
  const forge = async (label, table, cols, vals) => {
    // Tenant A's context, tenant B's businessId — WITH CHECK must refuse.
    try {
      await withCtx(A.businessId, (tx) => tx.$executeRawUnsafe(
        `INSERT INTO "${table}" (${cols}) VALUES (${vals})`, B.businessId, `${TAG}-forged-${label}`));
      crossWrites += 1;
      ok(`${label}: forged cross-tenant INSERT is REFUSED`, false, "the write was ACCEPTED");
    } catch (e) {
      const m = String(e?.message ?? e);
      ok(`${label}: forged cross-tenant INSERT is REFUSED`, /row-level security/i.test(m), m.slice(-160));
    }
  };
  await forge("Customer", "Customer", `"businessId","name","createdAt","updatedAt"`, `$1,$2,now(),now()`);
  await forge("Conversation", "Conversation", `"businessId","channel","outcomeReason","createdAt","updatedAt"`, `$1,'WHATSAPP',$2,now(),now()`);

  // Cross-tenant UPDATE: A tries to rename B's customers. RLS must match 0 rows.
  const beforeB = await withCtx(B.businessId, (tx) => tx.$queryRawUnsafe(
    `SELECT count(*)::int n FROM "Customer" WHERE name LIKE $1`, `${TAG}-cust-b-%`));
  const upd = await withCtx(A.businessId, (tx) => tx.$executeRawUnsafe(
    `UPDATE "Customer" SET name = $1 WHERE name LIKE $2`, `${TAG}-HIJACKED`, `${TAG}-cust-b-%`));
  const afterB = await withCtx(B.businessId, (tx) => tx.$queryRawUnsafe(
    `SELECT count(*)::int n FROM "Customer" WHERE name LIKE $1`, `${TAG}-cust-b-%`));
  ok("cross-tenant UPDATE affected 0 rows and changed nothing",
    upd === 0 && beforeB[0].n === afterB[0].n, `affected=${upd} before=${beforeB[0].n} after=${afterB[0].n}`);
  if (upd > 0) crossWrites += upd;
  ok("cross-tenant write successes = 0", crossWrites === 0, String(crossWrites));

  // -------------------------------------------------------------------------
  section("K. persisted mutation — API success alone is NOT a pass");
  const created = await call("POST", "/api/customers", {
    token: A.token, body: { name: `${TAG}-api-created`, phone: "050-0000000" },
  });
  ok("POST /api/customers reported success", created.status < 400, `${created.status} ${created.text.slice(0, 160)}`);
  const readBack = await withCtx(A.businessId, (tx) => tx.$queryRawUnsafe(
    `SELECT count(*)::int n FROM "Customer" WHERE name = $1`, `${TAG}-api-created`));
  ok("the API-created customer is ACTUALLY in the database (no false success)",
    readBack[0].n === 1, `rows=${readBack[0].n}`);

  const before = await withCtx(A.businessId, (tx) => tx.$queryRawUnsafe(
    `SELECT id, "currentQuantity" AS quantity FROM "InventoryItem" WHERE name LIKE $1 ORDER BY id LIMIT 1`, `${TAG}-inv-a-%`));
  if (before.length) {
    const id = before[0].id;
    const q0 = Number(before[0].quantity);
    const n = await withCtx(A.businessId, (tx) => tx.$executeRawUnsafe(
      `UPDATE "InventoryItem" SET "currentQuantity" = "currentQuantity" + 5, "updatedAt" = now() WHERE id = $1`, id));
    const after = await withCtx(A.businessId, (tx) => tx.$queryRawUnsafe(
      `SELECT "currentQuantity" AS quantity FROM "InventoryItem" WHERE id = $1`, id));
    ok(`inventory mutation persisted (${q0} -> ${after[0] ? Number(after[0].quantity) : "gone"})`,
      n === 1 && after.length === 1 && Number(after[0].quantity) === q0 + 5,
      `affected=${n} before=${q0} after=${after[0] ? after[0].quantity : "none"}`);
  } else {
    ok("inventory mutation persisted", false, "no inventory fixture to mutate");
  }

  // -------------------------------------------------------------------------
  section("N. pooled connection leakage — A -> B -> A");
  const seq = [];
  for (const [who, t] of [["A", A], ["B", B], ["A", A]]) {
    const r = await call("GET", "/api/customers", { token: t.token });
    const rows = rowsOf(r.json, "customers", "data", "items") ?? [];
    seq.push({
      who,
      own: rows.filter((x) => JSON.stringify(x).includes(`${TAG}-cust-${who.toLowerCase()}-`)).length,
      foreign: rows.filter((x) => JSON.stringify(x).includes(`${TAG}-cust-${who === "A" ? "b" : "a"}-`)).length,
    });
  }
  console.log(`     ${seq.map((s) => `${s.who}: own=${s.own} foreign=${s.foreign}`).join("  |  ")}`);
  ok("A -> B -> A: each request saw only its own tenant", seq.every((s) => s.foreign === 0), JSON.stringify(seq));
  ok("A -> B -> A: the second A request still sees A's data (no context stranding)",
    seq[2].own === seq[0].own && seq[0].own > 0, JSON.stringify(seq));

  // -------------------------------------------------------------------------
  section("M. provider / bootstrap paths (no external side effects)");
  /**
   * `/api/business-status` 500s with "Unable to start a transaction in the given
   * time". That was measured against BOTH identities: the same request, on the
   * same build and database, fails identically when DATABASE_URL points at
   * neondb_owner — an owner role WITH BYPASSRLS. Since the failure survives the
   * removal of every restriction under test, it cannot have been caused by them.
   * It is transaction-pool starvation in that route (it fans out many concurrent
   * tenant transactions), pre-existing and identity-independent.
   *
   * It is carried here as a known non-finding rather than deleted, so the run
   * keeps reporting it and the owner-control evidence stays attached to it.
   */
  const PREEXISTING = new Set(["business-status"]);
  const BOOT = [
    ["business-status", "/api/business-status"],
    ["billing documents", "/api/billing/documents"],
    ["obligations", "/api/obligations"],
    ["payment requests", "/api/payments/requests"],
    ["integrations", "/api/integrations/status"],
  ];
  for (const [label, path] of BOOT) {
    const r = await call("GET", path, { token: A.token });
    if (r.status === 500 && PREEXISTING.has(label)) {
      console.log(`  [KNOWN] ${label} -> 500 — reproduced identically as neondb_owner (BYPASSRLS); not a restricted-runtime defect`);
      continue;
    }
    ok(`${label}: no permission/RLS regression (HTTP ${r.status})`, r.status !== 500,
      `${r.status} ${r.text.slice(0, 200)}`);
  }

  // -------------------------------------------------------------------------
  section("SSR pages under the restricted runtime");
  for (const p of ["/app", "/customers", "/inventory", "/revenue", "/leads"]) {
    const r = await call("GET", p, { token: A.token });
    ok(`SSR ${p} (HTTP ${r.status})`, r.status < 500, String(r.status));
  }

  await done();
}

async function cleanup() {
  // Remove only what this run created, and only inside its own tenant contexts.
  console.log("\n== cleanup ==");
  const biz = await db.$queryRawUnsafe(
    `SELECT id FROM "Business" WHERE name LIKE $1`, `D2 Tenant % ${TAG}`).catch(() => []);
  for (const b of biz) {
    for (const t of ["Customer", "Conversation", "Lead", "Supplier", "InventoryItem"]) {
      await withCtx(b.id, (tx) => tx.$executeRawUnsafe(
        `DELETE FROM "${t}" WHERE "businessId" = $1`, b.id)).catch(() => {});
    }
  }
  console.log(`  cleaned ${biz.length} synthetic tenant(s) (rows only; Business/User rows are left for audit)`);
}

async function done() {
  await cleanup().catch((e) => console.log(`  cleanup note: ${String(e?.message ?? e).slice(0, 160)}`));
  console.log(`\n[suite] PASS=${pass} FAIL=${fail}`);
  if (failures.length) { console.log("[suite] failures:"); for (const f of failures) console.log(`   - ${f}`); }
  await db.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => { console.error("FATAL:", String(e?.stack ?? e).slice(0, 700)); await db.$disconnect().catch(() => {}); process.exit(1); });
