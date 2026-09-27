#!/usr/bin/env node
/**
 * tenant-fallback-inventory.mjs — latent-defect inventory (report, not a gate).
 *
 * For every AST-2/AST-3 debt site in scripts/ci/ast-security-guard.ratchet.json (a function that
 * falls back to the bare tenant client), find the app/api route handlers that call that function
 * — directly, or through ONE intermediate exported function in lib/ — and decide whether the call
 * carries tenant context:
 *   CONTEXT  lexically inside tenantTx / withTenantTransaction / runWithTenantContext /
 *            runTenantJob / billingTenantTx, or passes an argument object with a `tx` property
 *   BARE     neither — under FORCE RLS a read returns nothing and a write is refused
 * Output: one line per route → [intermediate →] service chain, with the verdict.
 *
 * Limits (stated, not hidden): name-based call matching; two hops; a context set by a caller
 * further up (middleware, wrapper HOF) is not seen, so BARE is "no context visible on the path".
 *
 * Usage: node scripts/ci/tenant-fallback-inventory.mjs [--json]
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = process.cwd();
const CONTEXT_FNS = /^(tenantTx|withTenantTransaction|runWithTenantContext|runTenantJob|billingTenantTx|withBillingTenant\w*|tenantScoped\w*)$/;

const ratchet = JSON.parse(fs.readFileSync("scripts/ci/ast-security-guard.ratchet.json", "utf8")).sites;
// file -> Set(symbol leaf)
const targets = new Map();
for (const id of Object.keys(ratchet)) {
  const [file, symbol, kind] = id.split("::");
  if (!/^(fallback|arg|default-param|alias|bare|raw|element)/.test(kind)) continue;
  const leaf = symbol.split(".").pop();
  if (leaf === "<module>") continue;
  if (!targets.has(file)) targets.set(file, new Set());
  targets.get(file).add(leaf);
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".next"].includes(e.name)) continue;
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(f);
  }
  return out;
}
const rel = (f) => path.relative(root, f).split(path.sep).join("/");
const parsed = new Map();
const parse = (f) => parsed.get(f) ?? (parsed.set(f, parseRaw(f)), parsed.get(f));
const parseRaw = (f) => ts.createSourceFile(f, fs.readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true, f.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

function resolveSpec(fromRel, spec) {
  let base;
  if (spec.startsWith("@/")) base = spec.slice(2);
  else if (spec.startsWith(".")) base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  else return null;
  for (const c of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) if (fs.existsSync(c)) return c;
  return null;
}

/** calls in `file` to any name in `names` imported from `target`; returns [{name, line, context}] */
const srcCache = new Map();
function callsInto(file, target, names) {
  const r = rel(file);
  const raw = srcCache.get(file) ?? (srcCache.set(file, fs.readFileSync(file, "utf8")), srcCache.get(file));
  const base = path.posix.basename(target).replace(/.tsx?$/, "");
  if (!raw.includes(base)) return [];
  const sf = parse(file);
  const local = new Map(); // local identifier -> imported name ('*' for namespace/objects)
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    if (resolveSpec(r, st.moduleSpecifier.text) !== target) continue;
    const c = st.importClause;
    if (!c) continue;
    if (c.name) local.set(c.name.text, "*");
    if (c.namedBindings && ts.isNamedImports(c.namedBindings)) for (const el of c.namedBindings.elements) local.set(el.name.text, (el.propertyName ?? el.name).text);
    if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) local.set(c.namedBindings.name.text, "*");
  }
  if (!local.size) return [];
  const out = [];
  const visit = (n) => {
    if (ts.isCallExpression(n)) {
      let called = null;
      const e = n.expression;
      if (ts.isIdentifier(e) && local.has(e.text) && names.has(local.get(e.text))) called = local.get(e.text);
      if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && local.get(e.expression.text) === "*" && names.has(e.name.text)) called = e.name.text;
      if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && local.has(e.expression.text) && local.get(e.expression.text) !== "*" && names.has(e.name.text)) called = e.name.text;
      if (called) {
        let ctx = false;
        for (let p = n.parent; p; p = p.parent) {
          if (ts.isCallExpression(p) && ts.isIdentifier(p.expression) && CONTEXT_FNS.test(p.expression.text)) { ctx = true; break; }
        }
        const txArg = n.arguments.some((a) => ts.isObjectLiteralExpression(a) && a.properties.some((pp) => pp.name && pp.name.getText(sf) === "tx"));
        let fn = null;
        for (let p = n.parent; p; p = p.parent) {
          if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name) { fn = p.name.getText(sf); break; }
          if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && ts.isVariableDeclaration(p.parent)) { fn = p.parent.name.getText(sf); break; }
        }
        out.push({ name: called, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, context: ctx || txArg, enclosing: fn });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const routes = walk("app/api").filter((f) => /route\.tsx?$/.test(f));
const libs = walk("lib");
const rows = [];
for (const [target, names] of targets) {
  // direct route calls
  for (const r of routes) for (const c of callsInto(r, target, names)) rows.push({ route: rel(r), line: c.line, via: null, service: `${target}#${c.name}`, verdict: c.context ? "CONTEXT" : "BARE" });
  // one hop through lib/
  for (const l of libs) {
    if (rel(l) === target) continue;
    const mids = callsInto(l, target, names).filter((c) => !c.context && c.enclosing);
    if (!mids.length) continue;
    const midNames = new Set(mids.map((m) => m.enclosing));
    for (const r of routes) for (const c of callsInto(r, rel(l), midNames)) {
      const m = mids.find((x) => x.enclosing === c.name);
      rows.push({ route: rel(r), line: c.line, via: `${rel(l)}#${c.name}`, service: `${target}#${m.name}`, verdict: c.context ? "CONTEXT" : "BARE" });
    }
  }
}
rows.sort((a, b) => (a.verdict + a.route).localeCompare(b.verdict + b.route));
if (process.argv.includes("--json")) console.log(JSON.stringify(rows, null, 1));
else {
  for (const r of rows) console.log(`${r.verdict.padEnd(7)} ${r.route}:${r.line} -> ${r.via ? r.via + " -> " : ""}${r.service}`);
  const bare = rows.filter((r) => r.verdict === "BARE");
  console.log(`\n${rows.length} route->service chains into a bare-client fallback; ${bare.length} carry NO visible tenant context`);
}
