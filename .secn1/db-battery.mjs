#!/usr/bin/env node
// SEC N-1 DB battery — the five P0 evidence tables under tenant RLS, proven as the
// Production-shaped runtime login (app_runtime_prod: LOGIN NOSUPERUSER NOBYPASSRLS,
// member of app_runtime) on a lab built by .secn1/build-lab.sh.
//
//   OWNER_URL=postgresql://owner@host:port/<lab>   (lab owner; used only for setup facts
//                                                  and the FORCE owner probe)
//   RUNTIME_URL=postgresql://app_runtime_prod:pw@host:port/<lab>
//   node .secn1/db-battery.mjs [--only CHECK_NAME[,CHECK_NAME]]
//
// Every check is named. A denial must carry the exact SQLSTATE it expects (42501 for
// RLS / privilege refusal) and, for RLS, the message "violates row-level security";
// a unique/FK violation, a missing table or a connection error is NOT a denial.
// A setup failure (wrong role shape, missing tenants) fails the whole run.
import { spawnSync } from "node:child_process";

const OWNER_URL = process.env.OWNER_URL;
const RUNTIME_URL = process.env.RUNTIME_URL;
const PSQL = process.env.PSQL || "psql";
if (!OWNER_URL || !RUNTIME_URL) {
  console.error("SETUP FAIL: OWNER_URL and RUNTIME_URL are required");
  process.exit(2);
}
const onlyArg = process.argv.indexOf("--only");
const ONLY = onlyArg > 0 ? new Set(process.argv[onlyArg + 1].split(",")) : null;

const TABLES = [
  { t: "InventorySale", col: "businessId" },
  { t: "InventorySaleLine", col: "businessId" },
  { t: "InventorySourceSaleLine", col: "businessId" },
  { t: "BusinessAsset", col: "businessId" },
  { t: "CouponSurfaceEvent", col: "issuingBusinessId" },
];
const EXPECTED_PRIVS = {
  InventorySale: ["INSERT", "SELECT"],
  InventorySaleLine: ["INSERT", "SELECT"],
  InventorySourceSaleLine: ["INSERT", "SELECT", "UPDATE"],
  BusinessAsset: ["INSERT", "SELECT"],
  CouponSurfaceEvent: ["INSERT", "SELECT"],
};

/** Run SQL; returns { ok, out, sqlstate, message }. Never throws. */
function sql(url, text) {
  const r = spawnSync(PSQL, [url, "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"], {
    input: `\\set VERBOSITY verbose\n${text}`,
    encoding: "utf8",
  });
  if (r.error) return { ok: false, out: "", sqlstate: "SPAWN", message: String(r.error) };
  const err = r.stderr || "";
  const m = err.match(/ERROR:\s+([0-9A-Z]{5}):\s*([^\n]*)/);
  return {
    ok: r.status === 0,
    out: (r.stdout || "").trim(),
    sqlstate: m ? m[1] : r.status === 0 ? null : "UNKNOWN",
    message: m ? m[2] : err.trim().split("\n")[0] || "",
  };
}
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const asTenant = (biz, body) => `BEGIN;\nSELECT set_config('app.current_business_id', ${q(biz)}, true) \\gset n1guc_\n${body}\nROLLBACK;`;
const isRlsDenial = (r) => r.sqlstate === "42501" && /violates row-level security/.test(r.message);
const isPrivDenial = (r) => r.sqlstate === "42501" && /permission denied/.test(r.message);

// ── setup facts (a crash here fails the run) ────────────────────────────────
const role = sql(RUNTIME_URL, "SELECT current_user || '|' || rolsuper || '|' || rolbypassrls FROM pg_roles WHERE rolname = current_user;");
if (!role.ok || role.out !== "app_runtime_prod|false|false") {
  console.error(`SETUP FAIL: runtime identity must be app_runtime_prod NOSUPERUSER NOBYPASSRLS, got ${JSON.stringify(role)}`);
  process.exit(2);
}
const ids = sql(OWNER_URL, `SELECT string_agg("name" || '=' || "id", ',' ORDER BY "name") FROM "Business" WHERE "name" IN ('n1-A','n1-B');`);
const idMap = Object.fromEntries((ids.out || "").split(",").filter(Boolean).map((kv) => kv.split("=")));
const A = Number(idMap["n1-A"]);
const B = Number(idMap["n1-B"]);
if (!A || !B) {
  console.error(`SETUP FAIL: seeded tenants n1-A / n1-B missing (${JSON.stringify(ids)})`);
  process.exit(2);
}
// Parent ids per tenant, read as owner, for well-formed inserts.
function parents(biz) {
  const r = sql(OWNER_URL, `SELECT
    (SELECT "id" FROM "InventoryItem" WHERE "businessId" = ${biz} ORDER BY "id" LIMIT 1) || ',' ||
    (SELECT "id" FROM "InventorySale" WHERE "businessId" = ${biz} ORDER BY "id" LIMIT 1) || ',' ||
    (SELECT "id" FROM "InventorySaleLine" WHERE "businessId" = ${biz} ORDER BY "id" LIMIT 1) || ',' ||
    (SELECT "id" FROM "ContentRun" WHERE "businessId" = ${biz} ORDER BY "id" LIMIT 1) || ',' ||
    (SELECT "id" FROM "Offer" WHERE "issuingBusinessId" = ${biz} ORDER BY "id" LIMIT 1) || ',' ||
    (SELECT "id" FROM "Coupon" WHERE "issuingBusinessId" = ${biz} ORDER BY "id" LIMIT 1);`);
  const [item, sale, line, run, offer, coupon] = r.out.split(",").map(Number);
  if (![item, sale, line, run, offer, coupon].every(Boolean)) {
    console.error(`SETUP FAIL: parent rows for ${biz} missing (${JSON.stringify(r)})`);
    process.exit(2);
  }
  return { item, sale, line, run, offer, coupon };
}
const PA = parents(A);
const PB = parents(B);

/** A fresh, well-formed insert for `table` carrying tenant `biz` (parents of `biz`). */
function insertFor(table, biz, p, tag, returning = true) {
  return returning ? insertSql(table, biz, p, tag) : insertSql(table, biz, p, tag).replace(/ RETURNING "id";$/, ";");
}
function insertSql(table, biz, p, tag) {
  switch (table) {
    case "InventorySale":
      return `INSERT INTO "InventorySale" ("businessId","source","externalSaleId") VALUES (${biz},'POS',${q(tag)}) RETURNING "id";`;
    case "InventorySaleLine":
      // A new movement is needed (movementId is unique per line); written by the
      // owner beforehand would bypass the point, so the line reuses the tenant's
      // existing sale and a fresh lineKey, and a movement created in-transaction.
      return `WITH mv AS (INSERT INTO "InventoryMovement" ("businessId","itemId","movementType","reason","quantityDelta","quantityBefore","quantityAfter") VALUES (${biz},${p.item},'OUT','SALE',-1,1,0) RETURNING "id")
        INSERT INTO "InventorySaleLine" ("businessId","saleId","itemId","movementId","lineKey","quantity") SELECT ${biz},${p.sale},${p.item},mv."id",${q(tag)},1 FROM mv RETURNING "id";`;
    case "InventorySourceSaleLine":
      return `INSERT INTO "InventorySourceSaleLine" ("businessId","externalSaleId","lineKey","quantity") VALUES (${biz},${q(tag)},'0',1) RETURNING "id";`;
    case "BusinessAsset":
      return `INSERT INTO "BusinessAsset" ("businessId","origin","assetRef","idempotencyKey") VALUES (${biz},'GENERATED',${q("https://x/" + tag)},${q(tag)}) RETURNING "id";`;
    case "CouponSurfaceEvent":
      return `INSERT INTO "CouponSurfaceEvent" ("issuingBusinessId","couponId","offerId","eventType") VALUES (${biz},${p.coupon},${p.offer},'PUBLIC_DETAIL_SERVED') RETURNING "id";`;
    default:
      throw new Error(table);
  }
}

// ── checks ───────────────────────────────────────────────────────────────────
const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check("EXISTING_ROWS_PRESERVED", () => {
  const bad = [];
  for (const { t, col } of TABLES) {
    const r = sql(OWNER_URL, `SELECT count(*) FILTER (WHERE "${col}" = ${A}) || ',' || count(*) FILTER (WHERE "${col}" = ${B}) FROM "${t}";`);
    if (r.out !== "1,1") bad.push(`${t}: ${r.out || r.message}`);
  }
  return bad.length ? `pre-existing rows changed: ${bad.join("; ")}` : null;
});

check("RLS_ENABLED_AND_FORCED", () => {
  const r = sql(OWNER_URL, `SELECT string_agg(relname || ':' || relrowsecurity || ':' || relforcerowsecurity, ',' ORDER BY relname) FROM pg_class WHERE relname IN (${TABLES.map((x) => q(x.t)).join(",")}) AND relkind = 'r';`);
  const bad = r.out.split(",").filter((s) => !s.endsWith(":true:true"));
  return r.out.split(",").length !== 5 ? `expected 5 tables, got ${r.out}` : bad.length ? `not ENABLE+FORCE: ${bad.join(",")}` : null;
});

check("GRANTS_LEAST_PRIVILEGE", () => {
  const bad = [];
  for (const { t } of TABLES) {
    const r = sql(OWNER_URL, `SELECT string_agg(p, ',' ORDER BY p) FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p WHERE has_table_privilege('app_runtime_prod', '"${t}"', p);`);
    const want = EXPECTED_PRIVS[t].join(",");
    if (r.out !== want) bad.push(`${t}: has {${r.out}} want {${want}}`);
    const s = sql(OWNER_URL, `SELECT has_sequence_privilege('app_runtime_prod', '"${t}_id_seq"', 'USAGE');`);
    if (s.out !== "t") bad.push(`${t}_id_seq: no USAGE`);
  }
  return bad.length ? bad.join("; ") : null;
});

check("NO_GUC_READS_ZERO", () => {
  const bad = [];
  for (const { t } of TABLES) {
    const r = sql(RUNTIME_URL, `SELECT count(*) FROM "${t}";`);
    if (!r.ok || r.out !== "0") bad.push(`${t}: ${r.ok ? r.out + " rows" : r.sqlstate + " " + r.message}`);
  }
  return bad.length ? `context-less read not empty: ${bad.join("; ")}` : null;
});

check("NO_GUC_WRITE_REFUSED", () => {
  const bad = [];
  for (const { t } of TABLES) {
    const r = sql(RUNTIME_URL, `BEGIN;\n${insertFor(t, A, PA, "noguc-" + t)}\nROLLBACK;`);
    if (!isRlsDenial(r)) bad.push(`${t}: ${r.ok ? "INSERT ACCEPTED" : r.sqlstate + " " + r.message}`);
  }
  return bad.length ? `context-less insert not RLS-refused: ${bad.join("; ")}` : null;
});

check("TENANT_READS_OWN_ONLY", () => {
  const bad = [];
  for (const { t, col } of TABLES) {
    const r = sql(RUNTIME_URL, asTenant(A, `SELECT count(*) || ',' || count(*) FILTER (WHERE "${col}" = ${A}) FROM "${t}";`));
    if (!r.ok || r.out !== "1,1") bad.push(`${t}: ${r.ok ? r.out : r.sqlstate + " " + r.message}`);
  }
  return bad.length ? `tenant A read is not exactly its own row: ${bad.join("; ")}` : null;
});

check("CROSS_TENANT_READ_ZERO", () => {
  const bad = [];
  for (const { t, col } of TABLES) {
    const r = sql(RUNTIME_URL, asTenant(A, `SELECT count(*) FROM "${t}" WHERE "${col}" = ${B};`));
    if (!r.ok || r.out !== "0") bad.push(`${t}: ${r.ok ? r.out + " B rows visible" : r.sqlstate}`);
  }
  return bad.length ? `tenant A sees tenant B: ${bad.join("; ")}` : null;
});

check("CROSS_TENANT_INSERT_REFUSED", () => {
  // Two shapes. Without RETURNING only the INSERT policy's WITH CHECK stands between
  // tenant A and a row owned by B. With RETURNING (Prisma's create) the SELECT policy
  // must ALSO pass for the new row, so that shape alone cannot prove WITH CHECK.
  const bad = [];
  for (const { t } of TABLES) {
    const bare = sql(RUNTIME_URL, asTenant(A, insertFor(t, B, PB, "xins-" + t, false)));
    if (!isRlsDenial(bare)) bad.push(`${t} (no RETURNING): ${bare.ok ? "B ROW INSERTED UNDER A" : bare.sqlstate + " " + bare.message}`);
    const ret = sql(RUNTIME_URL, asTenant(A, insertFor(t, B, PB, "xinr-" + t, true)));
    if (!isRlsDenial(ret)) bad.push(`${t} (RETURNING): ${ret.ok ? "B ROW INSERTED UNDER A" : ret.sqlstate + " " + ret.message}`);
  }
  return bad.length ? `tenant A could write tenant B's row: ${bad.join("; ")}` : null;
});

check("OWN_TENANT_WRITES_WORK", () => {
  const bad = [];
  for (const { t } of TABLES) {
    const r = sql(RUNTIME_URL, asTenant(A, insertFor(t, A, PA, "own-" + t)));
    if (!r.ok || !/^\d+$/.test(r.out)) bad.push(`${t}: ${r.sqlstate} ${r.message}`);
  }
  const u = sql(RUNTIME_URL, asTenant(A, `UPDATE "InventorySourceSaleLine" SET "saleLineId" = NULL WHERE "businessId" = ${A} RETURNING "id";`));
  if (!u.ok || !/^\d+$/.test(u.out)) bad.push(`InventorySourceSaleLine UPDATE own: ${u.sqlstate} ${u.message} (${u.out})`);
  return bad.length ? `own-tenant write refused: ${bad.join("; ")}` : null;
});

check("CROSS_TENANT_UPDATE_REFUSED", () => {
  // Moving an own row to tenant B must hit WITH CHECK; B's rows must be invisible to UPDATE.
  // No WHERE and no RETURNING on the move: a statement that reads the row's columns also
  // runs the SELECT policy against the new row, which would hide a missing WITH CHECK.
  // The UPDATE policy's USING already limits the target set to tenant A's rows.
  const move = sql(RUNTIME_URL, asTenant(A, `UPDATE "InventorySourceSaleLine" SET "businessId" = ${B}, "recognizedItemId" = NULL, "saleLineId" = NULL;`));
  const other = sql(RUNTIME_URL, asTenant(A, `UPDATE "InventorySourceSaleLine" SET "sku" = 'hijack' WHERE "businessId" = ${B} RETURNING "id";`));
  const bad = [];
  if (!isRlsDenial(move)) bad.push(`move A->B: ${move.ok ? "ACCEPTED" : move.sqlstate + " " + move.message}`);
  if (!other.ok || other.out !== "") bad.push(`update B's row: ${other.ok ? "rows " + other.out : other.sqlstate}`);
  return bad.length ? bad.join("; ") : null;
});

check("DELETE_NOT_GRANTED", () => {
  const bad = [];
  for (const { t, col } of TABLES) {
    const r = sql(RUNTIME_URL, asTenant(A, `DELETE FROM "${t}" WHERE "${col}" = ${A};`));
    if (!isPrivDenial(r)) bad.push(`${t}: ${r.ok ? "DELETE ACCEPTED" : r.sqlstate + " " + r.message}`);
  }
  return bad.length ? bad.join("; ") : null;
});

check("FORCE_BINDS_OWNER", () => {
  // FORCE is what subjects the table OWNER to the policies. Probe: hand each table to a
  // NOBYPASSRLS role inside a rolled-back transaction and read as that owner under
  // tenant A. With FORCE it sees 1 row; without FORCE it sees both tenants' rows.
  const bad = [];
  for (const { t } of TABLES) {
    const r = sql(OWNER_URL, `BEGIN;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'n1_owner_probe') THEN CREATE ROLE n1_owner_probe NOLOGIN NOBYPASSRLS NOSUPERUSER; END IF; END $$;
ALTER TABLE "${t}" OWNER TO n1_owner_probe;
SET LOCAL ROLE n1_owner_probe;
SELECT set_config('app.current_business_id', ${q(A)}, true) \\gset n1guc_
SELECT count(*) FROM "${t}";
ROLLBACK;`);
    if (!r.ok || r.out !== "1") bad.push(`${t}: owner sees ${r.ok ? r.out : r.sqlstate + " " + r.message}`);
  }
  return bad.length ? `owner not bound by RLS: ${bad.join("; ")}` : null;
});

// ── run ──────────────────────────────────────────────────────────────────────
let failed = 0;
let ran = 0;
for (const c of checks) {
  if (ONLY && !ONLY.has(c.name)) continue;
  ran++;
  let why;
  try {
    why = c.fn();
  } catch (e) {
    why = `CRASH ${e instanceof Error ? e.message : String(e)}`;
  }
  if (why) {
    failed++;
    console.log(`RED   ${c.name} :: ${why}`);
  } else {
    console.log(`GREEN ${c.name}`);
  }
}
if (ONLY && ran !== ONLY.size) {
  console.error(`SETUP FAIL: --only named unknown checks (${[...ONLY].join(",")})`);
  process.exit(2);
}
console.log(`sec-n1 db battery: ${ran - failed}/${ran} green`);
process.exit(failed ? 1 : 0);
