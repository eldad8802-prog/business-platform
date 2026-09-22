/**
 * AD-2A — the contract (A) against the migrations (B). The only place both meet.
 *
 * A = `production-contract.mjs`, written by hand.
 * B = `migration-state.mjs`, replayed from `prisma/migrations/` without reading A.
 *
 * WHICH TABLES ARE COMPARED, AND WHY THAT LIST DOES NOT COME FROM THE CONTRACT
 *
 * If the set of tables to check were the contract's own table list, a table left out
 * of the contract would also be left out of the check — the exact omission this
 * exists to catch. So the set is the union of:
 *
 *   - every table the erasure adapter writes or deletes, read from its AST
 *     (`parseAdapter`, the same analyser the erasure contract uses);
 *   - every table a migration-derived policy predicate of those tables reads
 *     (`EXISTS (SELECT … FROM "Parent" …)`) — the parent a relation-scoped policy
 *     depends on is part of the proof;
 *   - every table the contract names — so a stale contract entry is compared too.
 *
 * For each: B's RLS, FORCE, policy names, commands, roles, permissiveness and
 * predicates must equal A's. Predicates are compared after PostgreSQL has parsed both
 * (`pg-deparse.mjs`), never as source text. A table B puts under RLS that A does not
 * declare is a failure; a table in the flow that B leaves without RLS must be declared
 * in PRODUCTION_NO_RLS rather than silently absent.
 *
 * GRANTS ARE NOT COMPARED HERE, AND THAT IS STATED, NOT HIDDEN: Production's runtime
 * privileges are not derivable from the repository (see migration-state.mjs). The
 * dimension is reported UNPROVEN every run.
 */
import { deriveMigrationState } from "./migration-state.mjs";
import { deparseAll } from "./pg-deparse.mjs";

/**
 * @param owner          Prisma client as the lab owner (for predicate normalisation)
 * @param contract       { rls: TableSpec[], noRls: {table}[] }
 * @param flowTables     table names the erasure adapter touches (from its AST)
 * @param root           repository root
 * @returns { findings: [{dimension, table, detail}], unproven: [{dimension, detail}], compared: string[] }
 */
export async function crossCheckContract(owner, contract, flowTables, root = process.cwd()) {
  const mig = deriveMigrationState(root);
  const findings = [];
  const unproven = [];
  const find = (dimension, table, detail) => findings.push({ dimension, table, detail });

  const A = new Map(contract.rls.map((s) => [s.table, s]));
  const noRls = new Set(contract.noRls.map((s) => s.table));

  // Parents read by the migration-derived predicates of the flow's tables.
  const parents = new Set();
  for (const t of flowTables) {
    for (const p of mig.tables.get(t)?.policies.values() ?? []) {
      for (const e of [p.using, p.check]) for (const m of (e ?? "").matchAll(/\bFROM\s+"([^"]+)"/gi)) parents.add(m[1]);
    }
  }
  const compared = [...new Set([...flowTables, ...parents, ...A.keys(), ...noRls])].sort();

  // Any statement the replay refused to interpret, touching a compared table, makes
  // that table unprovable — and an unprovable table cannot be reported as matching.
  for (const u of mig.unproven) {
    const hit = compared.filter((t) => u.statement.includes(`"${t}"`));
    if (hit.length && /POLICY|ROW LEVEL SECURITY/i.test(u.statement)) {
      find("UNINTERPRETABLE MIGRATION", hit.join(","), `${u.migration}: ${u.statement}`);
    } else if (hit.length) {
      unproven.push({ dimension: "GRANTS", detail: `${u.migration} changes privileges on ${hit.join(",")} inside a block the replay does not interpret` });
    }
  }

  const exprItems = [];
  const pairs = [];
  for (const t of compared) {
    const b = mig.tables.get(t) ?? { rls: false, force: false, policies: new Map() };
    const a = A.get(t);
    if (!a) {
      if (b.rls || b.force || b.policies.size) {
        find("TABLE MEMBERSHIP", t, `migrations: rls=${b.rls} force=${b.force} policies=[${[...b.policies.keys()]}] — the contract does not declare it`);
      } else if (!noRls.has(t) && flowTables.includes(t)) {
        find("TABLE MEMBERSHIP", t, "in the erasure flow without RLS, and not declared in PRODUCTION_NO_RLS");
      }
      continue;
    }
    if (noRls.has(t)) find("TABLE MEMBERSHIP", t, "declared both RLS and NO_RLS");
    if (!b.rls) find("RLS ENABLED", t, "the contract enables RLS; the migrations leave it disabled");
    if (!b.force) find("RLS FORCE", t, "the contract forces RLS; the migrations do not");
    const aPol = new Map(a.policies.map((p) => [p.name, p]));
    for (const n of aPol.keys()) if (!b.policies.has(n)) find("POLICY MEMBERSHIP", t, `contract has ${n}; the migrations do not`);
    for (const n of b.policies.keys()) if (!aPol.has(n)) find("POLICY MEMBERSHIP", t, `migrations have ${n} (${b.policies.get(n).migration}); the contract does not`);
    for (const [n, ap] of aPol) {
      const bp = b.policies.get(n);
      if (!bp) continue;
      if (ap.command !== bp.command) find("POLICY COMMAND", t, `${n}: contract=${ap.command} migrations=${bp.command}`);
      const ar = [...(ap.roles ?? ["public"])].sort().join(",");
      if (ar !== bp.roles.join(",")) find("POLICY ROLES", t, `${n}: contract=${ar} migrations=${bp.roles.join(",")}`);
      if (!bp.permissive) find("POLICY PERMISSIVE", t, `${n}: migrations create it RESTRICTIVE; the contract cannot express that`);
      pairs.push({ t, n });
      exprItems.push(
        { table: t, expr: ap.using ?? null },
        { table: t, expr: bp.using ?? null },
        { table: t, expr: ap.check ?? null },
        { table: t, expr: bp.check ?? null }
      );
    }
  }
  const dep = await deparseAll(owner, exprItems);
  pairs.forEach(({ t, n }, i) => {
    const [au, bu, ac, bc] = dep.slice(4 * i, 4 * i + 4);
    for (const [dim, a, b] of [["POLICY USING", au, bu], ["POLICY WITH CHECK", ac, bc]]) {
      if ((a && a.error) || (b && b.error)) find(dim, t, `${n}: PostgreSQL could not parse a predicate: ${JSON.stringify(a?.error ?? b?.error)}`);
      else if (a !== b) find(dim, t, `${n}: contract=${JSON.stringify(a)} migrations=${JSON.stringify(b)}`);
    }
  });

  unproven.push({
    dimension: "GRANTS / REVOKES",
    detail:
      "Production runtime privileges come from per-environment scripts and default privileges, not only migrations; not derivable from the repository",
  });
  return { findings, unproven, compared, migrations: mig.migrations };
}
