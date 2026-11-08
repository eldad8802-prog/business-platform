/**
 * Erasure contract, database-function path — pure proofs over fixtures (no database).
 *   npx tsx lib/services/account/erasure-db-function-contract.test.ts
 *
 * A model may count as erased by a database function only when the manifest declares it, the adapter
 * calls exactly that function in the purge transaction, the migration defines it safely and every column
 * is accounted for. Each way of breaking one of those must leave the model NOT erased, with a finding.
 * The real migration's functions are read last, so the parser is proven on the SQL that ships.
 */
import fs from "node:fs";
import path from "node:path";
import type { DbFunctionErasure } from "./account-erasure-manifest";
import { parseAdapterSource, type SchemaModel } from "./erasure-contract";
import { checkDbFunctionErasures, parseDbFunction } from "./erasure-db-function-contract";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = ""): void {
  if (cond) pass++; else fail++;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
}

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────────────
const col = (name: string, type: string, o: { id?: boolean } = {}) =>
  ({ name, type, isList: false, isOptional: !o.id, isScalar: true, isId: !!o.id, dbName: null });
const MODELS = new Map<string, SchemaModel>([
  ["Gadget", { name: "Gadget", dbName: null, delegate: "gadget", fields: [
    col("id", "Int", { id: true }), col("businessId", "Int"), col("note", "String"), col("serial", "String"),
    col("brand", "String"), col("snapshot", "Json"), col("erasedAt", "DateTime"),
  ] }],
]);

const SAFE_FN = (o: Partial<Record<"definer" | "path" | "revoke" | "grant" | "ctx" | "noctx" | "deleting" | "update", string>> = {}) => `
CREATE OR REPLACE FUNCTION public.gadget_erase_business()
RETURNS integer
LANGUAGE plpgsql
${o.definer ?? "SECURITY DEFINER"}
${o.path ?? "SET search_path = pg_catalog, public, pg_temp"}
AS $fn$
DECLARE
  ${o.ctx ?? "v_business integer := NULLIF(current_setting('app.current_business_id', true), '')::integer;"}
BEGIN
  ${o.noctx ?? "IF v_business IS NULL THEN\n    RAISE EXCEPTION 'no context';\n  END IF;"}
  ${o.deleting ?? `IF NOT EXISTS (SELECT 1 FROM public."Business" b WHERE b."id" = v_business
                   AND (b."deletionRequestedAt" IS NOT NULL OR b."deletedAt" IS NOT NULL)) THEN
    RAISE EXCEPTION 'not deleting';
  END IF;`}
  ${o.update ?? `UPDATE public."Gadget" SET "note" = NULL, "serial" = '', "snapshot" = '{}', "erasedAt" = CURRENT_TIMESTAMP
   WHERE "businessId" = v_business AND "erasedAt" IS NULL;`}
  RETURN 1;
END
$fn$;
${o.revoke ?? "REVOKE ALL ON FUNCTION public.gadget_erase_business() FROM PUBLIC;"}
${o.grant ?? "GRANT EXECUTE ON FUNCTION public.gadget_erase_business() TO app_runtime;"}
`;

const ADAPTER = (call: string, extra = "") => `
async function purge() {
  return withTenantTransaction(async (tx) => {
    await tx.user.updateMany({ where: { businessId }, data: { email: null, name: "" } });
    await tx.customer.updateMany({ where: { businessId }, data: { phone: null } });
    ${call}
  });
}
${extra}
`;
const CALL = "await tx.$queryRaw`SELECT public.gadget_erase_business() AS n`;";

const DECL: DbFunctionErasure = {
  fn: "gadget_erase_business",
  migration: "m1",
  models: [{ model: "Gadget", cleared: ["note", "serial", "snapshot"], kept: { brand: "the product make, not the person" } }],
};

const run = (o: { decl?: DbFunctionErasure; adapter?: string; sql?: string | null } = {}) =>
  checkDbFunctionErasures({
    declarations: [o.decl ?? DECL],
    adapter: parseAdapterSource(o.adapter ?? ADAPTER(CALL)),
    models: MODELS,
    readMigration: (name) => (name === "m1" ? (o.sql === undefined ? SAFE_FN() : o.sql) : null),
  });
const codes = (r: ReturnType<typeof run>) => r.findings.map((f) => f.code);
const refused = (name: string, r: ReturnType<typeof run>, code: string) =>
  check(name, !r.erased.has("Gadget") && codes(r).includes(code), codes(r).join(",") || "erased");

// ── 1. the honest case ────────────────────────────────────────────────────────────────────────────────
console.log("— 1. declared, called in the purge transaction, defined safely, every column accounted for");
{
  const r = run();
  check("no finding, and the model counts as erased", r.findings.length === 0 && r.erased.has("Gadget"), JSON.stringify(r.findings));
  const facts = parseAdapterSource(ADAPTER(CALL));
  check("the adapter call is read with its transaction scope",
    facts.dbFunctionCalls.length === 1 && facts.dbFunctionCalls[0].fn === "gadget_erase_business" && facts.dbFunctionCalls[0].scope >= 0
    && facts.dbFunctionCalls[0].scope === facts.writes[0].scope);
  const $tx = run({ adapter: ADAPTER(CALL).replace("withTenantTransaction(", "prisma.$transaction(") });
  check("a prisma.$transaction callback is a transaction too", $tx.findings.length === 0);
}

// ── 2. the adapter ────────────────────────────────────────────────────────────────────────────────────
console.log("— 2. the adapter");
refused("declared but never called", run({ adapter: ADAPTER("") }), "C24-DBFN-NOT-CALLED");
refused("the adapter calls ANOTHER function", run({ adapter: ADAPTER("await tx.$queryRaw`SELECT public.gizmo_erase_business() AS n`;") }), "C24-DBFN-NOT-CALLED");
refused("a call in another shape is not the call", run({ adapter: ADAPTER("await tx.$queryRaw`SELECT public.gadget_erase_business(), 1`;") }), "C24-DBFN-NOT-CALLED");
refused("an interpolated call is not the call", run({ adapter: ADAPTER("await tx.$queryRaw`SELECT public.${fn}() AS n`;") }), "C24-DBFN-NOT-CALLED");
refused("called outside the purge transaction (its own transaction)",
  run({ adapter: ADAPTER("", `async function later() { return withTenantTransaction(async (tx) => { ${CALL} }); }`) }), "C24-DBFN-OUTSIDE-PURGE-TX");
refused("called outside any transaction", run({ adapter: ADAPTER("", `async function bare(tx) { ${CALL} }`) }), "C24-DBFN-OUTSIDE-PURGE-TX");

// ── 3. the migration ──────────────────────────────────────────────────────────────────────────────────
console.log("— 3. the function in its migration");
refused("no such migration", run({ sql: null }), "C25-DBFN-UNDEFINED");
refused("the migration does not define the function", run({ sql: SAFE_FN().replace(/gadget_erase_business/g, "gadget_erase_all") }), "C25-DBFN-UNDEFINED");
refused("not SECURITY DEFINER", run({ sql: SAFE_FN({ definer: "SECURITY INVOKER" }) }), "C25-DBFN-UNSAFE");
refused("search_path without pg_temp last", run({ sql: SAFE_FN({ path: "SET search_path = pg_temp, pg_catalog, public" }) }), "C25-DBFN-UNSAFE");
refused("no search_path at all", run({ sql: SAFE_FN({ path: "" }) }), "C25-DBFN-UNSAFE");
refused("EXECUTE left to PUBLIC", run({ sql: SAFE_FN({ revoke: "" }) }), "C25-DBFN-UNSAFE");
refused("not granted to app_runtime (the adapter could not call it)", run({ sql: SAFE_FN({ grant: "" }) }), "C25-DBFN-UNSAFE");
refused("the business is not taken from the tenant context", run({ sql: SAFE_FN({ ctx: "v_business integer := 9;" }) }), "C25-DBFN-UNSAFE");
refused("no refusal without a context", run({ sql: SAFE_FN({ noctx: "" }) }), "C25-DBFN-UNSAFE");
refused("no refusal unless the business is being deleted", run({ sql: SAFE_FN({ deleting: "" }) }), "C25-DBFN-UNSAFE");

// ── 4. tenant scope: no other business's rows ─────────────────────────────────────────────────────────
console.log("— 4. every write is scoped to the erased business");
const upd = (where: string) => `UPDATE public."Gadget" SET "note" = NULL, "serial" = '', "snapshot" = '{}' WHERE ${where};`;
refused("an UPDATE with no business filter", run({ sql: SAFE_FN({ update: upd(`"erasedAt" IS NULL`) }) }), "C25-DBFN-UNSAFE");
refused("an UPDATE whose filter can be widened by OR", run({ sql: SAFE_FN({ update: upd(`"businessId" = v_business OR true`) }) }), "C25-DBFN-UNSAFE");
refused("an UPDATE filtered on a constant business", run({ sql: SAFE_FN({ update: upd(`"businessId" = 9`) }) }), "C25-DBFN-UNSAFE");
refused("an UPDATE on another variable", run({ sql: SAFE_FN({ update: upd(`"businessId" = v_other`) }) }), "C25-DBFN-UNSAFE");
refused("a DELETE inside an IF", run({ sql: SAFE_FN({ update: upd(`"businessId" = v_business`) + `\n  IF true THEN DELETE FROM public."Gadget" WHERE true; END IF;` }) }), "C25-DBFN-UNSAFE");
refused("dynamic SQL (EXECUTE) cannot be scoped statically", run({ sql: SAFE_FN({ update: upd(`"businessId" = v_business`) + `\n  EXECUTE format('UPDATE %I SET x = 1', 'Gadget');` }) }), "C25-DBFN-UNSAFE");
check("a scoped UPDATE with a parenthesised OR inside AND is accepted",
  run({ sql: SAFE_FN({ update: upd(`"businessId" = v_business AND ("note" IS NOT NULL OR "serial" IS NOT NULL)`) }) }).findings.length === 0);

// ── 5. the columns ────────────────────────────────────────────────────────────────────────────────────
console.log("— 5. the declared columns against the function and the schema");
refused("a declared column the function does not clear",
  run({ sql: SAFE_FN({ update: upd(`"businessId" = v_business`).replace(`"serial" = '', `, "") }) }), "C26-DBFN-FIELD-NOT-CLEARED");
refused("a declared column the function OVERWRITES instead of clearing",
  run({ sql: SAFE_FN({ update: upd(`"businessId" = v_business`).replace(`"serial" = ''`, `"serial" = 'x'`) }) }), "C26-DBFN-FIELD-NOT-CLEARED");
refused("a declared column that does not exist",
  run({ decl: { ...DECL, models: [{ ...DECL.models[0], cleared: [...DECL.models[0].cleared, "ghost"] }] } }), "C26-DBFN-NO-SUCH-COLUMN");
refused("a model that does not exist", run({ decl: { ...DECL, models: [{ model: "Gizmo", cleared: [], kept: {} }] } }), "C26-DBFN-NO-SUCH-COLUMN");
refused("a text column neither cleared nor kept", run({ decl: { ...DECL, models: [{ ...DECL.models[0], kept: {} }] } }), "C27-DBFN-TEXT-UNACCOUNTED");
refused("a kept column without a reason", run({ decl: { ...DECL, models: [{ ...DECL.models[0], kept: { brand: " " } }] } }), "C27-DBFN-KEPT-WITHOUT-REASON");
refused("a column both cleared and kept", run({ decl: { ...DECL, models: [{ ...DECL.models[0], kept: { brand: "x", note: "x" } }] } }), "C27-DBFN-KEPT-AND-CLEARED");
refused("declared twice",
  checkDbFunctionErasures({ declarations: [DECL, DECL], adapter: parseAdapterSource(ADAPTER(CALL)), models: MODELS, readMigration: () => SAFE_FN() }) as ReturnType<typeof run>,
  "C25-DBFN-DECLARED-TWICE");

// ── 5b. rows deleted instead of cleared ───────────────────────────────────────────────────────────────
console.log("— 5b. a model whose rows the function deletes");
{
  const DEL_DECL: DbFunctionErasure = { ...DECL, models: [{ model: "Gadget", deleted: true, cleared: [], kept: {} }] };
  const del = (where: string, extra = "") => SAFE_FN({ update: `DELETE FROM public."Gadget" WHERE ${where};${extra}` });
  const job = `\n  INSERT INTO public."GadgetErasure" ("businessId", "state") VALUES (v_business, 'RUNNING') ON CONFLICT ("businessId") DO NOTHING;`;
  const okRun = run({ decl: DEL_DECL, sql: del(`"businessId" = v_business`, job) });
  check("a scoped DELETE (+ the job's own scoped INSERT) erases the model", okRun.findings.length === 0 && okRun.erased.has("Gadget"), codes(okRun).join(","));
  check("a scoped DELETE with an AND tail is accepted", run({ decl: DEL_DECL, sql: del(`"businessId" = v_business AND "erasedAt" IS NULL`) }).findings.length === 0);
  refused("a DELETE with no business filter", run({ decl: DEL_DECL, sql: del(`"erasedAt" IS NULL`) }), "C25-DBFN-UNSAFE");
  refused("a DELETE widened by OR", run({ decl: DEL_DECL, sql: del(`"businessId" = v_business OR true`) }), "C25-DBFN-UNSAFE");
  refused("a DELETE on a constant business", run({ decl: DEL_DECL, sql: del(`"businessId" = 9`) }), "C25-DBFN-UNSAFE");
  refused("declared deleted, but the function only UPDATEs", run({ decl: DEL_DECL }), "C26-DBFN-ROWS-NOT-DELETED");
  refused("declared deleted, but the function deletes ANOTHER table",
    run({ decl: DEL_DECL, sql: SAFE_FN({ update: `DELETE FROM public."Gizmo" WHERE "businessId" = v_business;` }) }), "C26-DBFN-ROWS-NOT-DELETED");
  refused("declared deleted AND with cleared columns",
    run({ decl: { ...DECL, models: [{ model: "Gadget", deleted: true, cleared: ["note"], kept: {} }] }, sql: del(`"businessId" = v_business`) }), "C27-DBFN-DELETED-AND-CLEARED");
  const ins = (stmt: string) => del(`"businessId" = v_business`, `\n  ${stmt};`);
  refused("an INSERT … SELECT is not the job record", run({ decl: DEL_DECL, sql: ins(`INSERT INTO public."GadgetErasure" ("businessId") SELECT "id" FROM public."Business"`) }), "C25-DBFN-UNSAFE");
  refused("an INSERT for a constant business", run({ decl: DEL_DECL, sql: ins(`INSERT INTO public."GadgetErasure" ("businessId", "state") VALUES (9, 'RUNNING')`) }), "C25-DBFN-UNSAFE");
  refused("an INSERT whose first column is not the business", run({ decl: DEL_DECL, sql: ins(`INSERT INTO public."GadgetErasure" ("state", "businessId") VALUES ('RUNNING', v_business)`) }), "C25-DBFN-UNSAFE");
  refused("an upsert that updates", run({ decl: DEL_DECL, sql: ins(`INSERT INTO public."GadgetErasure" ("businessId", "state") VALUES (v_business, 'RUNNING') ON CONFLICT ("businessId") DO UPDATE SET "state" = 'RUNNING'`) }), "C25-DBFN-UNSAFE");
  refused("several rows", run({ decl: DEL_DECL, sql: ins(`INSERT INTO public."GadgetErasure" ("businessId", "state") VALUES (v_business, 'A'), (v_business, 'B')`) }), "C25-DBFN-UNSAFE");
}

// ── 6. the SQL that ships ─────────────────────────────────────────────────────────────────────────────
console.log("— 6. the real migrations' erasure functions");
const MIG = path.join(process.cwd(), "prisma", "migrations");
for (const [dir, fn, tables, [sampleTable, sampleColumn]] of [
  ["20261112090000_service_desk_foundation", "service_erase_business", ["ServiceCase", "ServiceDevice", "ServiceCaseIntake", "ServiceHandover", "ServiceCaseEvent", "ServiceQuote"], ["ServiceCase", "problemDescription"]],
  ["20261113090000_service_external_work", "service_external_erase_business", ["ServiceExternalWork", "ServiceExternalWorkEvent"], ["ServiceExternalWorkEvent", "reason"]],
  ["20261115090000_service_parts", "service_parts_erase_business", ["ServicePart", "ServicePartEvent"], ["ServicePartEvent", "reason"]],
] as const) {
  const file = path.join(MIG, dir, "migration.sql");
  if (!fs.existsSync(file)) { check(`${fn}: migration present`, false, file); continue; }
  const p = parseDbFunction(fs.readFileSync(file, "utf8"), fn);
  check(`${fn}: defined, SECURITY DEFINER, search_path … pg_temp last`, p.defined && p.securityDefiner && p.searchPathPgTempLast);
  check(`${fn}: revoked from PUBLIC, granted to app_runtime`, p.revokedFromPublic && p.grantedToRuntime);
  check(`${fn}: business from the tenant context; refuses without one and unless deleting`,
    p.tenantVar === "v_business" && p.refusesWithoutContext && p.refusesUnlessDeleting);
  check(`${fn}: every write is a tenant-scoped UPDATE`, p.unscopedWrites.length === 0, p.unscopedWrites.join(" | "));
  check(`${fn}: updates exactly its ${tables.length} tables`, JSON.stringify([...p.updates.keys()].sort()) === JSON.stringify([...tables].sort()), [...p.updates.keys()].join(","));
  check(`${fn}: ${sampleTable}.${sampleColumn} is cleared to NULL`, p.updates.get(sampleTable)?.get(sampleColumn) === "NULL");
}
{
  const fn = "business_documents_erase";
  const file = path.join(MIG, "20261114090000_business_documents_records", "migration.sql");
  if (!fs.existsSync(file)) check(`${fn}: migration present`, false, file);
  else {
    const p = parseDbFunction(fs.readFileSync(file, "utf8"), fn);
    check(`${fn}: defined, SECURITY DEFINER, search_path … pg_temp last, revoked / granted`,
      p.defined && p.securityDefiner && p.searchPathPgTempLast && p.revokedFromPublic && p.grantedToRuntime);
    check(`${fn}: business from the tenant context; refuses without one and unless deleting`,
      p.tenantVar === "v_business" && p.refusesWithoutContext && p.refusesUnlessDeleting);
    check(`${fn}: every write is scoped to the business`, p.unscopedWrites.length === 0, p.unscopedWrites.join(" | "));
    check(`${fn}: deletes exactly the four record tables`,
      JSON.stringify([...p.deletes].sort()) === JSON.stringify(["BusinessDocumentRequest", "BusinessLetter", "QuoteShareCopy", "QuoteShareEvent"]), [...p.deletes].join(","));
    check(`${fn}: writes its job record and marks the files (keys kept: no file DELETE)`,
      p.inserts.has("BusinessDocumentErasure") && p.updates.get("BusinessDocumentFile")?.get("state") === "'DELETING'" && !p.deletes.has("BusinessDocumentFile"));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
