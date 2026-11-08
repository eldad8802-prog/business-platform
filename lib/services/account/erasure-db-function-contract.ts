/**
 * ERASURE CONTRACT — the database-function path.
 *
 * WHY THIS EXISTS
 *
 * Some modules protect their personal columns with table guards that refuse the change
 * from the application's own runtime role: only the table owner, inside a marked erasure,
 * may blank them. Their erasure therefore cannot be a Prisma write in the adapter — it is
 * a SECURITY DEFINER function the adapter calls, in the erased business's transaction.
 * The contract used to see only adapter writes, so such a model could never be honestly
 * `ERASURE_MANAGED`.
 *
 * This module makes that path checkable instead of declarable. A model counts as erased
 * by a database function ONLY when all of these hold, read from the code itself:
 *
 *   manifest   DB_FUNCTION_ERASURES names the function, the migration that defines it,
 *              and per model which columns it clears and why every other text column stays;
 *   adapter    calls exactly `tx.$queryRaw\`SELECT public.<fn>() AS n\`` inside the SAME
 *              transaction callback as the rest of the purge (a failure rolls it all back);
 *   migration  defines the function SECURITY DEFINER with `search_path … pg_temp` last,
 *              revoked from PUBLIC and granted to app_runtime; it takes the business from
 *              the tenant context only, refuses without one and unless that business is being
 *              deleted, and every write it makes is an UPDATE or a DELETE whose WHERE begins
 *              with "businessId" = <that business> and has no top-level OR (or a single-row
 *              INSERT of the erasure's own job record for that business);
 *   rows       a model declared `deleted` has its rows removed by such a DELETE of its table
 *              (no column-by-column accounting: nothing of the row is left);
 *   columns    every declared column is a real scalar of the model and is set to NULL / '' /
 *              '{}' by such an UPDATE of the model's table; every non-@id String / Json column
 *              of the model is either cleared or listed as kept, with a reason.
 *
 * A declaration that fails any of these is a finding and the model is NOT counted as erased,
 * so C11 still reports it. Nothing here proves that a stored OBJECT (bytes in storage) is
 * deleted: clearing a key column is not an object deletion, and object surfaces stay with
 * the C19…C23 checks.
 */
import type { AdapterFacts, SchemaModel } from "./erasure-contract";
import type { DbFunctionErasure } from "./account-erasure-manifest";

export type DbFunctionFinding = { code: string; key: string; detail: string };

export type ParsedDbFunction = {
  defined: boolean;
  securityDefiner: boolean;
  searchPathPgTempLast: boolean;
  revokedFromPublic: boolean;
  grantedToRuntime: boolean;
  /** The plpgsql variable that holds the business, taken from the tenant context. */
  tenantVar: string | null;
  refusesWithoutContext: boolean;
  refusesUnlessDeleting: boolean;
  /** UPDATEs scoped to the tenant business: table → column → assigned expression. */
  updates: Map<string, Map<string, string>>;
  /** Tables whose rows a tenant-scoped DELETE removes (same scoping rule as an UPDATE). */
  deletes: Set<string>;
  /** Tables given one row for the tenant business (the erasure's own job record). */
  inserts: Set<string>;
  /** Writes that are none of the above (an unscoped UPDATE / DELETE, INSERT … SELECT, TRUNCATE, dynamic SQL …). */
  unscopedWrites: string[];
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Remove `--` comments outside string literals (plpgsql bodies have no block comments here). */
function stripLineComments(sql: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (inString) {
      out += c;
      if (c === "'" && sql[i + 1] === "'") { out += "'"; i++; continue; }
      if (c === "'") inString = false;
      continue;
    }
    if (c === "'") { inString = true; out += c; continue; }
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    out += c;
  }
  return out;
}

/** Split at `;` outside '…' literals. */
function statements(sql: string): string[] {
  const out: string[] = [];
  let cur = "", inString = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (inString) {
      cur += c;
      if (c === "'" && sql[i + 1] === "'") { cur += "'"; i++; continue; }
      if (c === "'") inString = false;
      continue;
    }
    if (c === "'") { inString = true; cur += c; continue; }
    if (c === ";") { out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Split at commas that are not inside parentheses or literals. */
function topLevelCommas(text: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "", inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      cur += c;
      if (c === "'") { if (text[i + 1] === "'") { cur += "'"; i++; } else inString = false; }
      continue;
    }
    if (c === "'") { inString = true; cur += c; continue; }
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The text with every parenthesised group and literal blanked — what is left is top level. */
function topLevel(text: string): string {
  let depth = 0, out = "", inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) { if (c === "'" && text[i + 1] !== "'") inString = false; else if (c === "'") i++; continue; }
    if (c === "'") { inString = true; continue; }
    if (c === "(") { depth++; continue; }
    if (c === ")") { depth--; continue; }
    if (depth === 0) out += c;
  }
  return out;
}

/** The text with every '…' literal replaced by spaces of the same length (offsets stay valid). */
function topLevelLiteralsBlanked(text: string): string {
  let out = "", inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "'" && text[i + 1] === "'") { out += "  "; i++; continue; }
      if (c === "'") { inString = false; out += c; continue; }
      out += " ";
      continue;
    }
    if (c === "'") inString = true;
    out += c;
  }
  return out;
}

/** Read one function out of one migration. Pure. */
export function parseDbFunction(migrationSql: string, fn: string): ParsedDbFunction {
  const sql = stripLineComments(String(migrationSql));
  const empty: ParsedDbFunction = {
    defined: false, securityDefiner: false, searchPathPgTempLast: false, revokedFromPublic: false,
    grantedToRuntime: false, tenantVar: null, refusesWithoutContext: false, refusesUnlessDeleting: false,
    updates: new Map(), deletes: new Set(), inserts: new Set(), unscopedWrites: [],
  };
  const head = new RegExp(String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.${esc(fn)}\s*\(\s*\)([\s\S]*?)\bAS\s+(\$[A-Za-z_]*\$)`, "i").exec(sql);
  if (!head) return empty;
  const tag = head[2];
  const bodyStart = head.index + head[0].length;
  const bodyEnd = sql.indexOf(tag, bodyStart);
  if (bodyEnd < 0) return empty;
  const header = head[1];
  const body = sql.slice(bodyStart, bodyEnd);
  const sig = String.raw`public\.${esc(fn)}\s*\(\s*\)`;

  const r: ParsedDbFunction = { ...empty, defined: true, updates: new Map(), deletes: new Set(), inserts: new Set(), unscopedWrites: [] };
  r.securityDefiner = /\bSECURITY\s+DEFINER\b/i.test(header);
  const sp = /\bSET\s+search_path\s*(?:=|TO)\s*([^\n]+)/i.exec(header);
  r.searchPathPgTempLast = !!sp && /(^|,)\s*pg_temp\s*$/i.test(sp[1].trim());
  r.revokedFromPublic = new RegExp(String.raw`REVOKE\s+(?:ALL|EXECUTE)\s+ON\s+FUNCTION\s+${sig}\s+FROM\s+PUBLIC`, "i").test(sql);
  r.grantedToRuntime = new RegExp(String.raw`GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+${sig}\s+TO\s+app_runtime\b`, "i").test(sql);

  const tv = /\b([a-z_][a-z0-9_]*)\s+integer\s*:=\s*NULLIF\(\s*current_setting\(\s*'app\.current_business_id'\s*,\s*true\s*\)\s*,\s*''\s*\)\s*::\s*int(?:eger)?\b/i.exec(body);
  r.tenantVar = tv ? tv[1] : null;
  if (r.tenantVar) {
    const v = esc(r.tenantVar);
    r.refusesWithoutContext = new RegExp(String.raw`IF\s+${v}\s+IS\s+NULL\s+THEN\s+RAISE\s+EXCEPTION`, "i").test(body);
    r.refusesUnlessDeleting = new RegExp(
      String.raw`IF\s+NOT\s+EXISTS\s*\(\s*SELECT[\s\S]*?"Business"[\s\S]*?=\s*${v}\b[\s\S]*?"(?:deletionRequestedAt|deletedAt)"\s+IS\s+NOT\s+NULL[\s\S]*?\)\s*\)?\s*THEN\s+RAISE\s+EXCEPTION`,
      "i",
    ).test(body);
  }

  for (const whole of statements(body)) {
    // A write anywhere in the statement — also inside IF … THEN — and dynamic SQL, which no
    // static read can scope, always counts as unscoped.
    const write = /\b(UPDATE|DELETE\s+FROM|INSERT\s+INTO|TRUNCATE|MERGE\s+INTO|EXECUTE)\b/i.exec(topLevelLiteralsBlanked(whole));
    if (!write) continue;
    const st = whole.slice(write.index);
    const scopedWhere = (whereText: string) => {
      if (!r.tenantVar) return false;
      const where = whereText.trim();
      const lead = new RegExp(String.raw`^"businessId"\s*=\s*${esc(r.tenantVar)}\b`, "i").exec(where);
      if (!lead) return false;
      const rest = where.slice(lead[0].length);
      if (rest.trim() !== "" && !/^\s*AND\b/i.test(rest)) return false;
      return !/\bOR\b/i.test(topLevel(where));
    };
    // A row DELETE under the same scoping rule as an UPDATE: WHERE begins with the tenant business, no top-level OR.
    const del = /^DELETE\s+FROM\s+(?:public\s*\.\s*)?"([^"]+)"\s+WHERE\s+([\s\S]+)$/i.exec(st);
    if (del) {
      if (scopedWhere(del[2])) r.deletes.add(del[1]);
      else r.unscopedWrites.push(st.replace(/\s+/g, " ").slice(0, 120));
      continue;
    }
    // A single-row INSERT whose first column is "businessId" and first value the tenant business (a job record of the
    // erasure itself); anything else — a SELECT source, several rows, an upsert that updates — stays unscoped.
    const ins = /^INSERT\s+INTO\s+(?:public\s*\.\s*)?"([^"]+)"\s*\(\s*"businessId"\s*(?:,[^()]*)?\)\s*VALUES\s*\(\s*([a-z_][a-z0-9_]*)\s*(?:,[^()]*)?\)\s*(?:ON\s+CONFLICT\s*(?:\([^()]*\))?\s*DO\s+NOTHING\s*)?$/i.exec(st);
    if (ins && r.tenantVar && ins[2].toLowerCase() === r.tenantVar.toLowerCase()) {
      r.inserts.add(ins[1]);
      continue;
    }
    const up = /^UPDATE\s+(?:public\s*\.\s*)?"([^"]+)"\s+SET\s+([\s\S]+?)\s+WHERE\s+([\s\S]+)$/i.exec(st);
    const scoped = up && scopedWhere(up[3]);
    if (!up || !scoped) { r.unscopedWrites.push(st.replace(/\s+/g, " ").slice(0, 120)); continue; }
    const set = r.updates.get(up[1]) ?? new Map<string, string>();
    for (const assignment of topLevelCommas(up[2])) {
      const a = /^"([^"]+)"\s*=\s*([\s\S]+)$/.exec(assignment);
      if (a) set.set(a[1], a[2].trim());
    }
    r.updates.set(up[1], set);
  }
  return r;
}

const CLEARED = /^(?:NULL|''|'\{\}'(?:\s*::\s*jsonb?)?)$/i;

/** The transaction most of the adapter's erasure writes run in — the purge transaction. */
export function purgeScope(adapter: AdapterFacts): number {
  const counts = new Map<number, number>();
  for (const w of adapter.writes) if (w.scope >= 0) counts.set(w.scope, (counts.get(w.scope) ?? 0) + 1);
  let best = -1, n = 0;
  for (const [scope, c] of counts) if (c > n) { best = scope; n = c; }
  return best;
}

/**
 * Check every declaration. Returns the findings and the models proven erased — only those
 * may count as erasure-managed. Pure: the migration text is handed in by `readMigration`.
 */
export function checkDbFunctionErasures(input: {
  declarations: readonly DbFunctionErasure[];
  adapter: AdapterFacts;
  models: ReadonlyMap<string, SchemaModel>;
  readMigration: (name: string) => string | null;
}): { findings: DbFunctionFinding[]; erased: Set<string> } {
  const findings: DbFunctionFinding[] = [];
  const erased = new Set<string>();
  const purge = purgeScope(input.adapter);
  const declaredCount = new Map<string, number>();
  for (const d of input.declarations) declaredCount.set(d.fn, (declaredCount.get(d.fn) ?? 0) + 1);

  for (const decl of input.declarations) {
    const before = findings.length;
    const f = (code: string, key: string, detail: string) => findings.push({ code, key, detail });
    // One function, one declaration: two would let either half vouch for the other.
    if ((declaredCount.get(decl.fn) ?? 0) > 1) f("C25-DBFN-DECLARED-TWICE", decl.fn, `${decl.fn} is declared more than once`);

    // adapter: called, exactly, in the purge transaction
    const calls = input.adapter.dbFunctionCalls.filter((c) => c.fn === decl.fn);
    if (calls.length === 0) {
      f("C24-DBFN-NOT-CALLED", decl.fn, `the manifest declares ${decl.fn}() but the adapter never calls it`);
    } else if (!calls.some((c) => c.scope >= 0 && c.scope === purge)) {
      f("C24-DBFN-OUTSIDE-PURGE-TX", decl.fn,
        `${decl.fn}() is called (line ${calls.map((c) => c.line).join(", ")}) outside the purge transaction — a failure there would not roll the erasure back`);
    }

    // migration: defined, and safe
    const sql = input.readMigration(decl.migration);
    const p = sql === null ? null : parseDbFunction(sql, decl.fn);
    if (!p || !p.defined) {
      f("C25-DBFN-UNDEFINED", decl.fn, `${decl.fn}() is not defined in migration ${decl.migration}${sql === null ? " (no such migration)" : ""}`);
    } else {
      const unsafe = (ok: boolean, why: string) => { if (!ok) f("C25-DBFN-UNSAFE", `${decl.fn}:${why}`, `${decl.fn}(): ${why}`); };
      unsafe(p.securityDefiner, "not SECURITY DEFINER");
      unsafe(p.searchPathPgTempLast, "search_path does not end with pg_temp");
      unsafe(p.revokedFromPublic, "EXECUTE is not revoked from PUBLIC");
      unsafe(p.grantedToRuntime, "EXECUTE is not granted to app_runtime");
      unsafe(p.tenantVar !== null, "the business is not taken from app.current_business_id");
      unsafe(p.refusesWithoutContext, "does not refuse without a tenant context");
      unsafe(p.refusesUnlessDeleting, "does not refuse unless the business is being deleted");
      for (const w of p.unscopedWrites) f("C25-DBFN-UNSAFE", `${decl.fn}:unscoped`, `${decl.fn}(): a write not scoped to the tenant business: ${w}`);
    }

    // columns
    for (const m of decl.models) {
      const model = input.models.get(m.model);
      if (!model) { f("C26-DBFN-NO-SUCH-COLUMN", `${decl.fn}:${m.model}`, `${m.model} is not a model in the schema`); continue; }
      const table = model.dbName ?? model.name;
      if (m.deleted) {
        // The rows themselves go: nothing to account for column by column, but the DELETE must be really there.
        if (!p?.deletes.has(table)) f("C26-DBFN-ROWS-NOT-DELETED", `${decl.fn}:${m.model}`, `${decl.fn}() does not delete the ${m.model} rows of the business`);
        if (m.cleared.length > 0 || Object.keys(m.kept).length > 0) {
          f("C27-DBFN-DELETED-AND-CLEARED", `${decl.fn}:${m.model}`, `${m.model} is declared deleted and also lists cleared / kept columns`);
        }
        continue;
      }
      const columnOf = (field: string) => model.fields.find((x) => x.name === field && x.isScalar);
      const set = p?.updates.get(table);
      for (const field of m.cleared) {
        const col = columnOf(field);
        if (!col) { f("C26-DBFN-NO-SUCH-COLUMN", `${m.model}.${field}`, `${m.model}.${field} is not a column`); continue; }
        const expr = set?.get(col.dbName ?? col.name);
        if (!expr || !CLEARED.test(expr)) {
          f("C26-DBFN-FIELD-NOT-CLEARED", `${m.model}.${field}`,
            `${decl.fn}() does not clear ${m.model}.${field}${expr ? ` (it sets ${expr})` : ""}`);
        }
      }
      for (const [field, reason] of Object.entries(m.kept)) {
        if (!columnOf(field)) f("C26-DBFN-NO-SUCH-COLUMN", `${m.model}.${field}`, `${m.model}.${field} (kept) is not a column`);
        if (!reason || !reason.trim()) f("C27-DBFN-KEPT-WITHOUT-REASON", `${m.model}.${field}`, `${m.model}.${field} is kept without a reason`);
        if (m.cleared.includes(field)) f("C27-DBFN-KEPT-AND-CLEARED", `${m.model}.${field}`, `${m.model}.${field} is both cleared and kept`);
      }
      for (const col of model.fields) {
        if (!col.isScalar || col.isId || (col.type !== "String" && col.type !== "Json")) continue;
        if (!m.cleared.includes(col.name) && !(col.name in m.kept)) {
          f("C27-DBFN-TEXT-UNACCOUNTED", `${m.model}.${col.name}`,
            `${m.model}.${col.name} holds text and is neither cleared by ${decl.fn}() nor declared kept with a reason`);
        }
      }
    }

    if (findings.length === before) for (const m of decl.models) erased.add(m.model);
  }
  return { findings, erased };
}
