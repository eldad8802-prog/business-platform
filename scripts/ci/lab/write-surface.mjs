/**
 * write-surface.mjs — AST facts for "this code path writes nothing" proofs (M-16 F-3).
 *
 * The substring guards these replace could be walked around by formatting alone:
 * `db["historicalFiscalDocument"]["create"](...)`, an alias, a helper module one import
 * away. These functions parse with the TypeScript compiler and follow the import graph.
 *
 *   importClosure(entry, { within })  every repo module reachable from `entry` through
 *                                     static imports / re-exports / dynamic import(),
 *                                     restricted to paths matching `within`
 *   dbClientImports(file)             value imports of a database client module
 *   writeSites(file)                  calls that can mutate: .create/.createMany/.update/
 *                                     .updateMany/.delete/.deleteMany/.upsert, $executeRaw*,
 *                                     the same names through element access with a string
 *                                     literal, and ANY element-access call with a computed key
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

export const WRITE_METHODS = new Set(["create", "createMany", "createManyAndReturn", "update", "updateMany", "updateManyAndReturn", "delete", "deleteMany", "upsert", "$executeRaw", "$executeRawUnsafe"]);
export const DB_CLIENT_MODULES = ["lib/prisma", "lib/prisma-admin", "lib/prisma-auth", "lib/prisma-control-plane", "lib/tenant/transaction", "lib/tenant/tenant-tx", "lib/tenant/job"];

function parse(file) {
  const text = fs.readFileSync(file, "utf8");
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /\.tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function resolve(fromFile, spec, root) {
  let base;
  if (spec.startsWith("@/")) base = path.join(root, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
  else return null;
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, `${base}.mts`, path.join(base, "index.ts"), path.join(base, "index.tsx")])
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  return null;
}

export function moduleSpecifiers(file) {
  const sf = parse(file);
  const out = [];
  const visit = (n) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      const typeOnly = ts.isImportDeclaration(n) ? !!n.importClause?.isTypeOnly : !!n.isTypeOnly;
      out.push({ spec: n.moduleSpecifier.text, typeOnly });
    }
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) out.push({ spec: n.arguments[0].text, typeOnly: false });
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "require" && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) out.push({ spec: n.arguments[0].text, typeOnly: false });
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

export function importClosure(entry, { root = process.cwd(), within = /./ } = {}) {
  const seen = new Set();
  const rel = (f) => path.relative(root, f).split(path.sep).join("/");
  const stack = [path.resolve(root, entry)];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const { spec, typeOnly } of moduleSpecifiers(f)) {
      if (typeOnly) continue;
      const r = resolve(f, spec, root);
      if (r && within.test(rel(r))) stack.push(r);
    }
  }
  return [...seen].map(rel).sort();
}

export function dbClientImports(file, { root = process.cwd() } = {}) {
  const hits = [];
  for (const { spec, typeOnly } of moduleSpecifiers(path.resolve(root, file))) {
    if (typeOnly) continue;
    const norm = spec.startsWith("@/") ? spec.slice(2) : spec.startsWith(".") ? path.relative(root, path.resolve(path.dirname(path.resolve(root, file)), spec)).split(path.sep).join("/") : spec;
    if (DB_CLIENT_MODULES.includes(norm.replace(/\.(ts|tsx)$/, ""))) hits.push(spec);
  }
  return hits;
}

export function writeSites(file, { root = process.cwd() } = {}) {
  const sf = parse(path.resolve(root, file));
  const out = [];
  const line = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n) => {
    if (ts.isCallExpression(n) || ts.isTaggedTemplateExpression(n)) {
      const callee = ts.isCallExpression(n) ? n.expression : n.tag;
      // node:crypto `createHash(..).update(..)` / `createHmac(..).update(..)` feed a digest, not a row.
      const cryptoUpdate = ts.isPropertyAccessExpression(callee) && callee.name.text === "update" &&
        (/^create(Hash|Hmac)\(/.test(callee.expression.getText(sf)) || /^(hash|hmac|hasher|digest)\w*$/i.test(callee.expression.getText(sf)));
      if (ts.isPropertyAccessExpression(callee) && WRITE_METHODS.has(callee.name.text) && !cryptoUpdate) out.push({ line: line(n), text: callee.getText(sf).slice(0, 80) });
      if (ts.isElementAccessExpression(callee)) {
        const a = callee.argumentExpression;
        if (!ts.isStringLiteralLike(a) || WRITE_METHODS.has(a.text)) out.push({ line: line(n), text: callee.getText(sf).slice(0, 80) });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

export const PRISMA_OPS = new Set([...WRITE_METHODS, "findMany", "findFirst", "findFirstOrThrow", "findUnique", "findUniqueOrThrow", "count", "aggregate", "groupBy", "$queryRaw", "$queryRawUnsafe"]);

/** Every `<x>.<model>.<op>(...)` / `<x>["model"]["op"](...)` call: returns "model.op" strings
 *  (a computed key yields "<computed>"). Raw queries on the client itself yield "$.<op>". */
export function modelOps(file, { root = process.cwd() } = {}) {
  const sf = parse(path.resolve(root, file));
  const out = [];
  const nameOf = (e) => (ts.isPropertyAccessExpression(e) ? e.name.text : ts.isElementAccessExpression(e) ? (ts.isStringLiteralLike(e.argumentExpression) ? e.argumentExpression.text : "<computed>") : null);
  const inner = (e) => (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) ? e.expression : null);
  const strip = (e) => { while (e && (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e))) e = e.expression; return e; };
  const visit = (n) => {
    if (ts.isCallExpression(n) || ts.isTaggedTemplateExpression(n)) {
      const callee = strip(ts.isCallExpression(n) ? n.expression : n.tag);
      const op = nameOf(callee);
      if (op && (PRISMA_OPS.has(op) || op === "<computed>")) {
        const recv = strip(inner(callee));
        const model = recv ? nameOf(recv) : null;
        if (op.startsWith("$")) out.push(`$.${op}`);
        else if (model && !/^create(Hash|Hmac)$/.test(model)) out.push(`${model}.${op}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
