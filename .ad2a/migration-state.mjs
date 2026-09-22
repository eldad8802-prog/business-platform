/**
 * AD-2A — the row-level-security state the MIGRATIONS produce, derived on its own.
 *
 * WHY THIS IS A SEPARATE FILE, AND WHY IT IMPORTS NOTHING FROM THE CONTRACT
 *
 * `production-contract.mjs` is a hand-written claim: "this is what Production
 * does". A check of that claim is only worth something if it reaches its answer
 * from somewhere else. So this module reads `prisma/migrations/` in order and
 * replays the statements that change row-level security, and it never looks at
 * the contract — not its tables, not its policy names, not its predicates. The
 * comparison happens in `contract-crosscheck.mjs`, which is the only place both
 * sides meet.
 *
 * WHAT IT RECOGNISES, AND WHAT IT REFUSES TO GUESS
 *
 * This is not a SQL parser. It splits a migration into statements (respecting
 * comments, quotes and dollar-quoted bodies) and recognises exactly these shapes:
 *
 *   ALTER TABLE [ONLY] "T" ENABLE | DISABLE | FORCE | NO FORCE ROW LEVEL SECURITY
 *   CREATE POLICY p ON "T" [AS PERMISSIVE|RESTRICTIVE] [FOR cmd] [TO roles]
 *                          [USING (…)] [WITH CHECK (…)]
 *   DROP POLICY [IF EXISTS] p ON "T"
 *   DROP TABLE [IF EXISTS] "T"            (the table's state goes with it)
 *   ALTER TABLE "T" RENAME TO "U"         (the state moves)
 *
 * Any OTHER statement that mentions a policy or row-level security — inside a DO
 * block, through EXECUTE, an ALTER POLICY — is not interpreted. It is recorded in
 * `unproven`, and a caller must treat every table it could touch as unproven
 * rather than as matching. A guess that happens to agree is still a guess.
 *
 * Grants are deliberately NOT derived here. Production's runtime privileges come
 * from migrations, from per-environment scripts applied by hand, and from default
 * privileges that hand new tables to the runtime role (measured: see migration
 * 20260922090000). None of that is determinable from the repository alone.
 */
import fs from "node:fs";
import path from "node:path";

/** Split SQL into statements, ignoring `;` inside comments, strings, identifiers and $tag$ bodies. */
export function splitStatements(sql) {
  const out = [];
  let buf = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      const nl = sql.indexOf("\n", i);
      const end = nl < 0 ? sql.length : nl;
      buf += " ";
      i = end;
      continue;
    }
    if (two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) throw new Error("unterminated block comment");
      buf += " ";
      i = end + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c && sql[j + 1] === c) { j += 2; continue; }
        if (sql[j] === c) break;
        j++;
      }
      if (j >= sql.length) throw new Error(`unterminated ${c} literal`);
      buf += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "$") {
      const m = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end < 0) throw new Error(`unterminated ${tag} body`);
        buf += sql.slice(i, end + tag.length);
        i = end + tag.length;
        continue;
      }
    }
    if (c === ";") {
      if (buf.trim()) out.push(buf.trim());
      buf = "";
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

const IDENT = String.raw`(?:"((?:[^"]|"")+)"|([A-Za-z_][A-Za-z_0-9$]*))`;
const ident = (quoted, bare) => (quoted !== undefined ? quoted.replace(/""/g, '"') : bare.toLowerCase());

/** The text inside the parenthesis group that opens at `open` (which must be "("). */
function balanced(s, open) {
  if (s[open] !== "(") return null;
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === c && s[j + 1] === c) { j += 2; continue; }
        if (s[j] === c) break;
        j++;
      }
      i = j;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return { inner: s.slice(open + 1, i), end: i + 1 };
    }
  }
  return null;
}

/** Parse one CREATE POLICY statement, or return null if it is not in the recognised shape. */
export function parseCreatePolicy(stmt) {
  const head = new RegExp(String.raw`^CREATE\s+POLICY\s+${IDENT}\s+ON\s+(?:ONLY\s+)?${IDENT}`, "i").exec(stmt);
  if (!head) return null;
  const name = ident(head[1], head[2]);
  const table = ident(head[3], head[4]);
  let rest = stmt.slice(head[0].length);
  let permissive = true;
  let command = "ALL";
  let roles = ["public"];
  let using = null;
  let check = null;
  for (;;) {
    rest = rest.replace(/^\s+/, "");
    if (!rest) break;
    let m;
    if ((m = /^AS\s+(PERMISSIVE|RESTRICTIVE)\b/i.exec(rest))) {
      permissive = m[1].toUpperCase() === "PERMISSIVE";
      rest = rest.slice(m[0].length);
    } else if ((m = /^FOR\s+(ALL|SELECT|INSERT|UPDATE|DELETE)\b/i.exec(rest))) {
      command = m[1].toUpperCase();
      rest = rest.slice(m[0].length);
    } else if ((m = new RegExp(String.raw`^TO\s+(${IDENT}(?:\s*,\s*${IDENT})*)`, "i").exec(rest))) {
      roles = m[1].split(",").map((r) => {
        const x = new RegExp(`^\\s*${IDENT}\\s*$`).exec(r);
        return ident(x[1], x[2]);
      }).sort();
      rest = rest.slice(m[0].length);
    } else if ((m = /^USING\s*/i.exec(rest))) {
      const b = balanced(rest, m[0].length);
      if (!b) return null;
      using = b.inner.trim();
      rest = rest.slice(b.end);
    } else if ((m = /^WITH\s+CHECK\s*/i.exec(rest))) {
      const b = balanced(rest, m[0].length);
      if (!b) return null;
      check = b.inner.trim();
      rest = rest.slice(b.end);
    } else {
      return null;
    }
  }
  return { name, table, permissive, command, roles, using, check };
}

/**
 * Replay every migration, in directory order, and return the resulting state.
 *
 * @returns {{
 *   tables: Map<string, {rls: boolean, force: boolean, policies: Map<string, object>}>,
 *   unproven: {migration: string, statement: string}[],
 *   migrations: number,
 * }}
 */
export function deriveMigrationState(root = process.cwd()) {
  const dir = path.join(root, "prisma", "migrations");
  const names = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, "migration.sql")))
    .map((d) => d.name)
    .sort();

  const tables = new Map();
  const unproven = [];
  const state = (t) => {
    if (!tables.has(t)) tables.set(t, { rls: false, force: false, policies: new Map() });
    return tables.get(t);
  };

  for (const mig of names) {
    const sql = fs.readFileSync(path.join(dir, mig, "migration.sql"), "utf8");
    for (const stmt of splitStatements(sql)) {
      const flat = stmt.replace(/\s+/g, " ");
      let m;
      if ((m = new RegExp(String.raw`^ALTER TABLE (?:ONLY )?${IDENT} (ENABLE|DISABLE|FORCE|NO FORCE) ROW LEVEL SECURITY$`, "i").exec(flat))) {
        const s = state(ident(m[1], m[2]));
        const verb = m[3].toUpperCase();
        if (verb === "ENABLE") s.rls = true;
        else if (verb === "DISABLE") s.rls = false;
        else if (verb === "FORCE") s.force = true;
        else s.force = false;
        continue;
      }
      if (/^CREATE POLICY /i.test(flat)) {
        const p = parseCreatePolicy(flat);
        if (!p) {
          unproven.push({ migration: mig, statement: flat.slice(0, 160) });
          continue;
        }
        state(p.table).policies.set(p.name, { ...p, migration: mig });
        continue;
      }
      if ((m = new RegExp(String.raw`^DROP POLICY (IF EXISTS )?${IDENT} ON (?:ONLY )?${IDENT}$`, "i").exec(flat))) {
        const t = ident(m[4], m[5]);
        const name = ident(m[2], m[3]);
        if (tables.has(t)) tables.get(t).policies.delete(name);
        continue;
      }
      if ((m = new RegExp(String.raw`^DROP TABLE (?:IF EXISTS )?${IDENT}(?: CASCADE)?$`, "i").exec(flat))) {
        tables.delete(ident(m[1], m[2]));
        continue;
      }
      if ((m = new RegExp(String.raw`^ALTER TABLE (?:ONLY )?${IDENT} RENAME TO ${IDENT}$`, "i").exec(flat))) {
        const from = ident(m[1], m[2]);
        const to = ident(m[3], m[4]);
        if (tables.has(from)) {
          const s = tables.get(from);
          tables.delete(from);
          for (const p of s.policies.values()) p.table = to;
          tables.set(to, s);
        }
        continue;
      }
      // Anything else that touches the same machinery is refused, not interpreted.
      if (/\bPOLICY\b|ROW LEVEL SECURITY/i.test(flat)) {
        unproven.push({ migration: mig, statement: flat.slice(0, 160) });
      }
    }
  }
  return { tables, unproven, migrations: names.length };
}
