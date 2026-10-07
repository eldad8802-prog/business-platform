#!/usr/bin/env node
/**
 * ast-security-guard.mjs — AST replacement for the grep guards (M-16 F-7 / F-11).
 *
 * The grep guards it supersedes could be bypassed by formatting alone: an aliased
 * `PrismaClient as C`, a newline between `new` and `PrismaClient`, `prisma["model"]`,
 * `const db = options?.tx ?? prisma`, a dynamic `import("@/lib/prisma-admin")`, a
 * guard name that appears anywhere in the file (even a comment). This guard parses
 * every runtime source file with the TypeScript compiler and reasons about bindings.
 *
 * RULES
 *   AST-1  PRISMA-NEW        `new PrismaClient(...)` (any alias / namespace / require)
 *                            outside the four sanctioned client modules. No ratchet:
 *                            zero sites allowed. *.deps.ts files are NOT exempt.
 *   AST-2  PRISMA-FALLBACK   the canonical tenant `prisma` used as a fallback or
 *                            alias (`x ?? prisma`, `x || prisma`, `c ? a : prisma`,
 *                            default parameter `= prisma`, `const db = prisma`).
 *                            Every such site silently runs WITHOUT tenant context
 *                            when the caller omits a transaction. Existing sites are
 *                            DEBT pinned in an EXACT-SET ratchet (file::symbol::kind
 *                            with count): a new site fails, and a removed site fails
 *                            until its entry is deleted (the set can only shrink).
 *   AST-2  ESCAPE           (sec/INT) the canonical client may be used ONLY as
 *                            `prisma.<member>`. Every other value flow is an escape
 *                            that could carry the bare client somewhere this guard does
 *                            not look: `return prisma` / `() => prisma` (wrapper),
 *                            `{ prisma }` (DI object), `[prisma]`, `x = prisma`,
 *                            destructuring, `export { prisma }`, `export ... from` the
 *                            client module, `require()` / `import()` / `import = require`
 *                            of it, a namespace import used other than `NS.prisma`, and
 *                            `globalThis.prisma`. Each is ratchet debt (new site = FAIL).
 *   AST-3  BARE-TENANT       canonical `prisma.<FORCE-RLS model>.*`, `prisma[<expr>]`
 *                            and `prisma.$queryRaw*` / `$executeRaw*` — same exact-set
 *                            ratchet. FORCE-RLS models are read from the migrations.
 *                            ONE data-flow exception, derived from the database, never
 *                            from a file or function name: a bare `create`/`createMany`
 *                            on model M whose every data row is an object literal that
 *                            ENDS with `businessId: null` (nothing after it can override
 *                            it), where M's migrations declare an INSERT policy whose
 *                            WITH CHECK admits "businessId" IS NULL — i.e. the database
 *                            itself restricts a GUC-less insert to the untenanted shape.
 *                            And one for raw SQL, also derived from the migrations: a
 *                            TAGGED `prisma.$queryRaw` whose whole text is a single
 *                            `SELECT [cols FROM] public.<fn>(${...})` where <fn> is
 *                            declared SECURITY DEFINER with a pinned search_path and
 *                            REVOKE ALL ... FROM PUBLIC (a narrow pre-context lookup the
 *                            database scopes; no table is read by the caller's query).
 *   AST-4  PRIVILEGED-CLIENT `@/lib/prisma-admin`, `@/lib/prisma-auth`,
 *                            `@/lib/prisma-control-plane` reached by static import,
 *                            `export ... from`, dynamic `import()` or `require()` from
 *                            outside their approved surfaces.
 *   AST-5  ADMIN-HANDLER     every exported HTTP handler under app/api/platform-admin/**
 *                            and app/api/dev/** awaits the canonical platform-admin
 *                            guard as its FIRST await (following a same-file delegate
 *                            called with the request only), and a *OrResponse result
 *                            is returned when it is a NextResponse in the very next
 *                            statement. Identity-only (no-MFA) guards only on the
 *                            allowlisted step-up routes.
 *
 * Usage:
 *   node scripts/ci/ast-security-guard.mjs [ROOT]            check (exit 1 on violation)
 *   node scripts/ci/ast-security-guard.mjs --write-ratchet   regenerate the ratchet
 *        (a human decision; CI never writes it)
 *   node scripts/ci/ast-security-guard.mjs --self-test       planted offenders per rule
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

export const RATCHET_FILE = "scripts/ci/ast-security-guard.ratchet.json";
const SCAN_DIRS = ["app", "lib", "components", "features", "hooks"];
const ROOT_FILES = ["proxy.ts", "middleware.ts", "instrumentation.ts"];
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "__tests__", "__mocks__"]);
const SKIP_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|\.d\.ts$/;
const SRC_FILE = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/;

const SANCTIONED_CLIENTS = new Set(["lib/prisma.ts", "lib/prisma-admin.ts", "lib/prisma-auth.ts", "lib/prisma-control-plane.ts"]);
const CANONICAL_PRISMA = "lib/prisma";

/** Privileged client module -> the only surfaces allowed to import it (regex on repo path). */
const PRIVILEGED = {
  "lib/prisma-admin": [/^app\/api\/platform-admin\//, /^app\/api\/dev\//, /^lib\/services\/platform-admin\//, /^lib\/services\/learning-center\//],
  "lib/prisma-auth": [/^app\/api\/auth\/(login|logout|me|refresh)\/route\.ts$/, /^lib\/auth\.ts$/, /^lib\/auth\/signup\.ts$/, /^lib\/auth\/session-directory\.ts$/, /^lib\/auth\/admin-mfa\.service\.ts$/ /* T-04: PlatformAdminMfa on the auth plane */, /^lib\/email\/transactional\/(delivery|sweep)\.ts$/ /* the delivery half of the signup plane: TransactionalEmail only */],
  "lib/prisma-control-plane": null, // read from privwrite-guard's own allowlist below
};

const ADMIN_ROUTE = /^app\/api\/(platform-admin|dev)\/.*route\.(ts|tsx|js)$/;
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const FULL_GUARDS = new Set(["requirePlatformAdmin", "requirePlatformAdminOrResponse"]);
const IDENTITY_GUARDS = new Set(["requirePlatformAdminIdentity", "requirePlatformAdminIdentityOrResponse"]);
const IDENTITY_ONLY_ALLOWLIST = /^app\/api\/platform-admin\/(mfa\/(enroll|confirm|verify)|session)\/route\.ts$/;

const rel = (root, f) => path.relative(root, f).split(path.sep).join("/");

function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (SRC_FILE.test(e.name) && !SKIP_FILE.test(e.name)) out.push(full);
  }
  return out;
}

/** Models whose migrations admit a GUC-less INSERT only for businessId NULL. */
export function nullInsertModels(root) {
  const out = new Set();
  const dir = path.join(root, "prisma/migrations");
  if (!fs.existsSync(dir)) return out;
  for (const d of fs.readdirSync(dir)) {
    const f = path.join(dir, d, "migration.sql");
    if (!fs.existsSync(f)) continue;
    const sql = fs.readFileSync(f, "utf8").replace(/--[^\n]*/g, "");
    for (const m of sql.matchAll(/CREATE POLICY\s+"?\w+"?\s+ON\s+"?(\w+)"?([^;]*);/gi)) {
      const body = m[2];
      if (/FOR\s+INSERT/i.test(body) && /WITH\s+CHECK[\s\S]*"businessId"\s+IS\s+NULL/i.test(body)) out.add(m[1].charAt(0).toLowerCase() + m[1].slice(1));
    }
  }
  return out;
}

/**
 * B4 — models whose migrations declare a SELECT policy open to every role and every row
 * (`FOR SELECT USING (true)`, no TO clause): read-open, write-pinned. A bare READ of such a model
 * is not tenant access (the database returns the same rows with or without a tenant context);
 * every WRITE on it stays a site, because its write policies are tenant-pinned.
 */
export function readOpenModels(root) {
  const out = new Set();
  const dir = path.join(root, "prisma/migrations");
  if (!fs.existsSync(dir)) return out;
  for (const d of fs.readdirSync(dir)) {
    const f = path.join(dir, d, "migration.sql");
    if (!fs.existsSync(f)) continue;
    const sql = fs.readFileSync(f, "utf8").replace(/--[^\n]*/g, "");
    for (const m of sql.matchAll(/CREATE POLICY\s+"?\w+"?\s+ON\s+"?(\w+)"?([^;]*);/gi)) {
      const body = m[2].trim();
      if (/^FOR\s+SELECT\s+USING\s*\(\s*true\s*\)$/i.test(body)) out.add(m[1].charAt(0).toLowerCase() + m[1].slice(1));
    }
  }
  return out;
}
export const READ_OPS = new Set(["findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "findMany", "count", "aggregate", "groupBy"]);

/** SECURITY DEFINER functions with a pinned search_path and EXECUTE revoked from PUBLIC. */
export function definerLookupFns(root) {
  const out = new Set();
  const dir = path.join(root, "prisma/migrations");
  if (!fs.existsSync(dir)) return out;
  const all = fs.readdirSync(dir).map((d) => path.join(dir, d, "migration.sql")).filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f, "utf8").replace(/--[^\n]*/g, "")).join("\n");
  for (const m of all.matchAll(/CREATE (?:OR REPLACE )?FUNCTION\s+public\.(\w+)\s*\(([\s\S]*?)\$(\w*)\$/gi)) {
    const header = m[2];
    const fn = m[1];
    if (!/SECURITY\s+DEFINER/i.test(header) || !/SET\s+search_path\s*=/i.test(header)) continue;
    if (!new RegExp(`REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+public\\.${fn}\\s*\\([^)]*\\)\\s+FROM\\s+PUBLIC`, "i").test(all)) continue;
    out.add(fn);
  }
  return out;
}

export function forcedRlsModels(root) {
  const models = new Set();
  const dir = path.join(root, "prisma/migrations");
  if (!fs.existsSync(dir)) return models;
  for (const entry of fs.readdirSync(dir)) {
    const f = path.join(dir, entry, "migration.sql");
    if (!fs.existsSync(f)) continue;
    const sql = fs.readFileSync(f, "utf8");
    for (const m of sql.matchAll(/ALTER TABLE\s+(?:"?public"?\.)?"(\w+)"\s+FORCE ROW LEVEL SECURITY/gi)) {
      models.add(m[1].charAt(0).toLowerCase() + m[1].slice(1));
    }
  }
  return models;
}

function controlPlaneAllow(root) {
  // privwrite-guard owns the control-plane import allowlist; reuse its list verbatim so the two cannot drift.
  const f = path.join(root, "scripts/ci/privwrite-guard.sh");
  const out = [/^lib\/services\/control-plane\//];
  if (fs.existsSync(f)) {
    const s = fs.readFileSync(f, "utf8");
    for (const m of s.matchAll(/grep -vE "\(\^\|\/\)([^"]+?)"/g)) {
      try { out.push(new RegExp("^" + m[1].replace(/:$/, "$"))); } catch { /* ignore non-path filters */ }
    }
  }
  return out;
}

/** Resolve a module specifier to a repo-relative path without extension (or null if external). */
function resolveSpec(fromRel, spec) {
  if (spec.startsWith("@/")) return path.posix.normalize(spec.slice(2)).replace(/\.(ts|tsx|js|mjs)$/, "").replace(/\/index$/, "");
  if (spec.startsWith(".")) return path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec)).replace(/\.(ts|tsx|js|mjs)$/, "").replace(/\/index$/, "");
  return null;
}

function enclosingSymbol(node) {
  const names = [];
  for (let n = node.parent; n; n = n.parent) {
    let name = null;
    if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) name = n.name.getText();
    else if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && ts.isVariableDeclaration(n.parent)) name = n.parent.name.getText();
    else if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && ts.isPropertyAssignment(n.parent)) name = n.parent.name.getText();
    else if (ts.isVariableDeclaration(n) && ts.isSourceFile(n.parent?.parent?.parent)) name = n.name.getText();
    if (name) names.unshift(name);
  }
  return names.length ? names.join(".") : "<module>";
}

/** Analyse one file. Returns { violations: [], debt: [] }. */
export function analyseFile(root, file, ctx) {
  const r = rel(root, file);
  const text = fs.readFileSync(file, "utf8");
  const kind = /\.tsx$/.test(file) ? ts.ScriptKind.TSX : /\.(js|mjs|cjs|jsx)$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const violations = [];
  const debt = [];
  const line = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const v = (rule, n, msg) => violations.push({ rule, file: r, line: line(n), msg });
  const d = (rule, n, kindName) => debt.push({ rule, file: r, line: line(n), id: `${r}::${enclosingSymbol(n)}::${kindName}` });

  // ── bindings ────────────────────────────────────────────────────────────────
  const prismaClientNames = new Set(); // local names bound to PrismaClient
  const prismaNamespaces = new Set(); // `import * as P from "@prisma/client"` / require
  const canonicalPrisma = new Set(); // local names bound to the canonical tenant client
  const canonicalNs = new Set(); // namespace / default imports of the canonical client module
  const globalAliases = new Set(["globalThis", "global"]);
  const modulesOf = []; // [spec, node, how]

  const visitBindings = (n) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const spec = n.moduleSpecifier.text;
      modulesOf.push([spec, n, "import"]);
      const c = n.importClause;
      if (c) {
        const target = resolveSpec(r, spec);
        if (spec === "@prisma/client") {
          if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) prismaNamespaces.add(c.namedBindings.name.text);
          if (c.namedBindings && ts.isNamedImports(c.namedBindings))
            for (const el of c.namedBindings.elements) if ((el.propertyName ?? el.name).text === "PrismaClient") prismaClientNames.add(el.name.text);
          if (c.name) prismaNamespaces.add(c.name.text);
        }
        if (target === CANONICAL_PRISMA && c.namedBindings && ts.isNamedImports(c.namedBindings))
          for (const el of c.namedBindings.elements) if ((el.propertyName ?? el.name).text === "prisma") canonicalPrisma.add(el.name.text);
        if (target === CANONICAL_PRISMA && c.namedBindings && ts.isNamespaceImport(c.namedBindings)) { canonicalPrisma.add(`${c.namedBindings.name.text}.prisma`); canonicalNs.add(c.namedBindings.name.text); }
        if (target === CANONICAL_PRISMA && c.name) canonicalNs.add(c.name.text);
      }
    }
    if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) modulesOf.push([n.moduleSpecifier.text, n, "export-from"]);
    if (ts.isCallExpression(n) && n.arguments.length >= 1 && ts.isStringLiteralLike(n.arguments[0])) {
      const spec = n.arguments[0].text;
      if (n.expression.kind === ts.SyntaxKind.ImportKeyword) modulesOf.push([spec, n, "dynamic-import"]);
      else if (ts.isIdentifier(n.expression) && n.expression.text === "require") {
        modulesOf.push([spec, n, "require"]);
        if (spec === "@prisma/client" && ts.isVariableDeclaration(n.parent)) {
          const name = n.parent.name;
          if (ts.isIdentifier(name)) prismaNamespaces.add(name.text);
          else if (ts.isObjectBindingPattern(name))
            for (const el of name.elements) if ((el.propertyName ?? el.name).getText() === "PrismaClient") prismaClientNames.add(el.name.getText());
        }
      }
    }
    ts.forEachChild(n, visitBindings);
  };
  visitBindings(sf);

  // ── AST-4 privileged client reachability ───────────────────────────────────
  for (const [spec, node, how] of modulesOf) {
    const target = resolveSpec(r, spec);
    if (!target || !(target in PRIVILEGED)) continue;
    if (`${target}.ts` === r) continue;
    const allow = target === "lib/prisma-control-plane" ? ctx.controlPlaneAllow : PRIVILEGED[target];
    if (!allow.some((re) => re.test(r))) v("AST-4", node, `${how} of ${target} outside its approved surface`);
  }

  const isCanonical = (e) => {
    if (ts.isIdentifier(e)) return canonicalPrisma.has(e.text);
    if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) return canonicalPrisma.has(`${e.expression.text}.${e.name.text}`);
    return false;
  };
  const unwrap = (e) => {
    while (e && (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression?.(e) || ts.isSatisfiesExpression?.(e))) e = e.expression;
    return e;
  };

  const WRAPPED = (e) => !!e && (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || !!ts.isTypeAssertionExpression?.(e) || !!ts.isSatisfiesExpression?.(e));
  const isDeclName = (n) => {
    const p = n.parent;
    if (!p) return true;
    if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)) return true;
    if ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p) || ts.isFunctionDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertySignature(p)) && p.name === n) return true;
    if (ts.isBindingElement(p) && p.propertyName === n) return true;
    if (ts.isPropertyAccessExpression(p) && p.name === n) return true;
    if (ts.isQualifiedName(p) || ts.isTypeQueryNode(p)) return true;
    return false;
  };
  // A reference to the canonical client VALUE: `prisma` (named import) or `NS.prisma`.
  const isCanonicalRef = (n) => {
    if (ts.isIdentifier(n)) return canonicalPrisma.has(n.text) && !isDeclName(n);
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression)) return canonicalPrisma.has(`${n.expression.text}.${n.name.text}`);
    return false;
  };
  // null = a use another rule already classifies (member access, fallback, alias, arg ...).
  const escapeKind = (ref) => {
    let e = ref;
    while (WRAPPED(e.parent)) e = e.parent;
    const p = e.parent;
    if (!p) return null;
    if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === e) return null;
    if (ts.isBinaryExpression(p) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(p.operatorToken.kind)) return null;
    if (ts.isConditionalExpression(p) && (p.whenTrue === e || p.whenFalse === e)) return null;
    if (ts.isParameter(p) && p.initializer === e) return null;
    if (ts.isVariableDeclaration(p) && p.initializer === e && ts.isIdentifier(p.name)) return null;
    if (ts.isPropertyAssignment(p) && p.initializer === e) return null;
    if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && (p.arguments ?? []).includes(e)) return null;
    if (ts.isExpressionStatement(p) || ts.isVoidExpression(p) || ts.isTypeOfExpression(p)) return null;
    if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.InstanceOfKeyword].includes(p.operatorToken.kind)) return null;
    if (ts.isReturnStatement(p) || ts.isArrowFunction(p)) return "return";
    if (ts.isShorthandPropertyAssignment(p)) return "shorthand";
    if (ts.isArrayLiteralExpression(p) || ts.isSpreadElement(p) || ts.isSpreadAssignment(p)) return "array-or-spread";
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) return "assign";
    if (ts.isVariableDeclaration(p)) return "destructure";
    if (ts.isExportSpecifier(p) || ts.isExportAssignment(p)) return "export";
    if (ts.isPropertyDeclaration(p)) return "class-field";
    return `other-${ts.SyntaxKind[p.kind]}`;
  };
  const isDefinerLookup = (access) => {
    let tag = access; let t = access.parent;
    while (t && (ts.isExpressionWithTypeArguments?.(t) || (ts.isTaggedTemplateExpression(t) === false && WRAPPED(t)))) { tag = t; t = t.parent; }
    if (!t || !ts.isTaggedTemplateExpression(t) || t.tag !== tag) return false;
    const tpl = t.template;
    const text = ts.isNoSubstitutionTemplateLiteral(tpl) ? tpl.text : tpl.head.text + tpl.templateSpans.map((sp) => "$" + sp.literal.text).join("");
    const one = text.replace(/\s+/g, " ").trim();
    const a = /^SELECT public\.(\w+)\((?:\$(?:, ?\$)*)?\)(?: AS "?\w+"?)?$/i.exec(one);
    const b = /^SELECT ([\w" ,]+) FROM public\.(\w+)\((?:\$(?:, ?\$)*)?\)$/i.exec(one);
    const fn = a ? a[1] : b && !/\b(FROM|JOIN|WHERE|UNION|SELECT)\b/i.test(b[1]) ? b[2] : null;
    return !!fn && !!ctx.definerFns && ctx.definerFns.has(fn);
  };
  const isSanctionedNullInsert = (access, model) => {
    if (!ctx.nullInsert || !ctx.nullInsert.has(model)) return false;
    const op = access.parent;
    if (!ts.isPropertyAccessExpression(op) || op.expression !== access || !["create", "createMany"].includes(op.name.text)) return false;
    const call = op.parent;
    if (!ts.isCallExpression(call) || call.expression !== op || call.arguments.length !== 1) return false;
    const arg = call.arguments[0];
    if (!ts.isObjectLiteralExpression(arg) || arg.properties.length !== 1) return false;
    const dp = arg.properties[0];
    if (!ts.isPropertyAssignment(dp) || dp.name.getText(sf) !== "data") return false;
    const rows = ts.isArrayLiteralExpression(dp.initializer) ? [...dp.initializer.elements] : [dp.initializer];
    if (rows.length === 0) return false;
    return rows.every((row) => {
      if (!ts.isObjectLiteralExpression(row)) return false;
      const last = row.properties[row.properties.length - 1];
      return !!last && ts.isPropertyAssignment(last) && last.name.getText(sf) === "businessId" && last.initializer.kind === ts.SyntaxKind.NullKeyword;
    });
  };

  const isOpenRead = (access, model) => {
    if (!ctx.readOpen || !ctx.readOpen.has(model)) return false;
    const op = access.parent;
    if (!ts.isPropertyAccessExpression(op) || op.expression !== access || !READ_OPS.has(op.name.text)) return false;
    return ts.isCallExpression(op.parent) && op.parent.expression === op;
  };

  const visit = (n) => {
    if (r !== "lib/prisma.ts") {
      const loadsClientModule = (spec) => resolveSpec(r, spec) === CANONICAL_PRISMA;
      if (ts.isCallExpression(n) && n.arguments.length >= 1 && ts.isStringLiteralLike(n.arguments[0]) && loadsClientModule(n.arguments[0].text) &&
          (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require")))
        d("AST-2", n, "escape:dynamic-load");
      if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteralLike(n.moduleReference.expression) && loadsClientModule(n.moduleReference.expression.text))
        d("AST-2", n, "escape:dynamic-load");
      if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) && loadsClientModule(n.moduleSpecifier.text) && !n.isTypeOnly)
        d("AST-2", n, "escape:reexport");
      // globalThis.prisma: the singleton cache lib/prisma.ts keeps on the global object.
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        let e = n.initializer; while (WRAPPED(e)) e = e.expression;
        if (ts.isIdentifier(e) && globalAliases.has(e.text)) globalAliases.add(n.name.text);
      }
      if ((ts.isPropertyAccessExpression(n) && n.name.text === "prisma") || (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && n.argumentExpression.text === "prisma")) {
        let e = n.expression; while (WRAPPED(e)) e = e.expression;
        if (ts.isIdentifier(e) && globalAliases.has(e.text)) d("AST-2", n, "escape:global");
      }
    }
    // AST-1
    if (ts.isNewExpression(n)) {
      const e = unwrap(n.expression);
      const hit =
        (ts.isIdentifier(e) && prismaClientNames.has(e.text)) ||
        (ts.isPropertyAccessExpression(e) && e.name.text === "PrismaClient" && ts.isIdentifier(e.expression) && prismaNamespaces.has(e.expression.text)) ||
        (ts.isPropertyAccessExpression(e) && e.name.text === "PrismaClient" && ts.isCallExpression(e.expression) && e.expression.getText().includes("@prisma/client")) ||
        (ts.isIdentifier(e) && e.text === "PrismaClient");
      if (hit && !SANCTIONED_CLIENTS.has(r)) v("AST-1", n, "ad-hoc PrismaClient instantiation outside the sanctioned client modules");
    }
    if (canonicalPrisma.size && r !== "lib/prisma.ts") {
      // AST-2 fallback / alias
      if (ts.isBinaryExpression(n) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(n.operatorToken.kind) && (isCanonical(unwrap(n.right)) || isCanonical(unwrap(n.left))))
        d("AST-2", n, n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ? "fallback??" : "fallback||");
      if (ts.isConditionalExpression(n) && (isCanonical(unwrap(n.whenTrue)) || isCanonical(unwrap(n.whenFalse)))) d("AST-2", n, "fallback?:");
      if (ts.isParameter(n) && n.initializer && isCanonical(unwrap(n.initializer))) d("AST-2", n, "default-param");
      if (ts.isVariableDeclaration(n) && n.initializer && isCanonical(unwrap(n.initializer))) d("AST-2", n, "alias");
      if (ts.isPropertyAssignment(n) && isCanonical(unwrap(n.initializer))) d("AST-2", n, "alias-prop");
      // run(prisma) / fn(prisma) / helper(x ?? prisma): the canonical client handed to a callee
      // runs that callee with NO tenant context (found in customer.service listCustomers).
      if ((ts.isCallExpression(n) || ts.isNewExpression(n)) && (n.arguments ?? []).some((arg) => isCanonical(unwrap(arg)))) d("AST-2", n, "arg");
      // AST-2 escape: every value flow of the client other than `prisma.<member>`
      if (isCanonicalRef(n)) {
        const esc = escapeKind(n);
        if (esc) d("AST-2", n, `escape:${esc}`);
      }
      if (ts.isIdentifier(n) && canonicalNs.has(n.text) && !isDeclName(n)) {
        const p = n.parent;
        const member = ts.isPropertyAccessExpression(p) && p.expression === n;
        if (!member) d("AST-2", n, "escape:namespace");
      }
      // AST-3 bare tenant access
      if (ts.isPropertyAccessExpression(n) && isCanonical(n.expression)) {
        const m = n.name.text;
        if (ctx.models.has(m) && isSanctionedNullInsert(n, m)) { /* DB-restricted untenanted insert (see header) */ }
        else if (ctx.models.has(m) && isOpenRead(n, m)) { /* B4: a read of a read-open model (see readOpenModels) */ }
        else if (ctx.models.has(m)) d("AST-3", n, `bare:${m}`);
        else if (m === "$extends") d("AST-2", n, "escape:extends"); // returns a NEW client carrying no tenant context
        else if (m === "$queryRaw" && isDefinerLookup(n)) { /* DB-scoped definer lookup (see header) */ }
        else if (/^\$(queryRaw|queryRawUnsafe|executeRaw|executeRawUnsafe)$/.test(m)) d("AST-3", n, `raw:${m}`);
      }
      if (ts.isElementAccessExpression(n) && isCanonical(n.expression)) {
        const a = n.argumentExpression;
        const key = ts.isStringLiteralLike(a) ? a.text : null;
        if (key === null || ctx.models.has(key) || /^\$(queryRaw|executeRaw)/.test(key)) d("AST-3", n, `element:${key ?? "<dynamic>"}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);

  // ── AST-5 admin handlers ─────────────────────────────────────────────────────
  if (ADMIN_ROUTE.test(r)) checkAdminHandlers(sf, r, v);
  return { violations, debt };
}

function functionBodies(sf) {
  const fns = new Map();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && st.body) fns.set(st.name.text, st);
    if (ts.isVariableStatement(st))
      for (const dcl of st.declarationList.declarations)
        if (ts.isIdentifier(dcl.name) && dcl.initializer && (ts.isArrowFunction(dcl.initializer) || ts.isFunctionExpression(dcl.initializer))) fns.set(dcl.name.text, dcl.initializer);
  }
  return fns;
}

function isExported(st) {
  return !!st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/** First AwaitExpression in evaluation (source) order, not descending into nested functions. */
function firstAwait(node) {
  let found = null;
  const go = (n) => {
    if (found) return;
    if (n !== node && (ts.isFunctionLike(n))) return;
    if (ts.isAwaitExpression(n)) { found = n; return; }
    ts.forEachChild(n, go);
  };
  go(node);
  return found;
}

function checkAdminHandlers(sf, r, v) {
  const fns = functionBodies(sf);
  const handlers = [];
  for (const st of sf.statements) {
    if (!isExported(st)) continue;
    if (ts.isFunctionDeclaration(st) && st.name && HTTP_METHODS.has(st.name.text)) handlers.push([st.name.text, st]);
    if (ts.isVariableStatement(st))
      for (const dcl of st.declarationList.declarations)
        if (ts.isIdentifier(dcl.name) && HTTP_METHODS.has(dcl.name.text)) {
          if (dcl.initializer && (ts.isArrowFunction(dcl.initializer) || ts.isFunctionExpression(dcl.initializer))) handlers.push([dcl.name.text, dcl.initializer]);
          else v("AST-5", dcl, `exported ${dcl.name.text} is not an analysable function (re-export / wrapper) — the admin guard cannot be verified`);
        }
  }
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause))
      for (const el of st.exportClause.elements) if (HTTP_METHODS.has(el.name.text)) v("AST-5", st, `re-exported ${el.name.text} — the admin guard cannot be verified`);
  }
  for (const [name, fn] of handlers) {
    const res = guardFirst(fn, fns, sf, r, 0);
    if (res !== true) v("AST-5", fn, `${name}: ${res}`);
  }
}

function guardFirst(fn, fns, sf, r, depth) {
  if (!fn.body) return "no body";
  const aw = firstAwait(fn.body);
  // A handler that delegates `return helper(req)` without awaiting anything first.
  if (!aw || depth > 2) {
    const ret = fn.body.statements?.find((s) => ts.isReturnStatement(s));
    if (!aw && ret?.expression && ts.isCallExpression(ret.expression) && ts.isIdentifier(ret.expression.expression) && fns.has(ret.expression.expression.text) && depth < 2) {
      if (ret.expression.arguments.length > 1) return `delegates to ${ret.expression.expression.text} with injected dependencies — not the production guard`;
      return guardFirst(fns.get(ret.expression.expression.text), fns, sf, r, depth + 1);
    }
    return "no await — the platform-admin guard is never awaited";
  }
  const callee = ts.isCallExpression(aw.expression) ? aw.expression.expression : null;
  if (!callee) return `first await is not a guard call: ${aw.getText(sf).slice(0, 60)}`;
  let guard = ts.isIdentifier(callee) ? callee.text : null;
  // Delegate into a same-file helper that is awaited first (`await handle(req)`).
  if (guard && fns.has(guard) && !FULL_GUARDS.has(guard) && !IDENTITY_GUARDS.has(guard) && depth < 2) {
    if (aw.expression.arguments.length > 1) return `delegates to ${guard} with injected dependencies`;
    return guardFirst(fns.get(guard), fns, sf, r, depth + 1);
  }
  // DI seam: `const authorize = deps.authorize ?? requirePlatformAdminOrResponse` — accepted only
  // when this function is reached with the request alone (checked by the caller above).
  if (guard && !FULL_GUARDS.has(guard) && !IDENTITY_GUARDS.has(guard)) {
    const decl = findConst(fn.body, guard);
    const init = decl?.initializer;
    if (init && ts.isBinaryExpression(init) && init.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && ts.isIdentifier(init.right) && (FULL_GUARDS.has(init.right.text) || IDENTITY_GUARDS.has(init.right.text)) && depth > 0)
      guard = init.right.text;
  }
  if (!guard || (!FULL_GUARDS.has(guard) && !IDENTITY_GUARDS.has(guard))) return `first await is ${aw.getText(sf).slice(0, 60)} — the platform-admin guard must come first`;
  if (IDENTITY_GUARDS.has(guard) && !IDENTITY_ONLY_ALLOWLIST.test(r)) return `uses the identity-only guard ${guard} (no MFA elevation) and is not allowlisted`;
  if (/OrResponse$/.test(guard)) {
    // The result must be bound and returned when it is a response, in the very next statement.
    let st = aw;
    while (st && !ts.isVariableStatement(st) && !ts.isExpressionStatement(st)) st = st.parent;
    if (!st || !ts.isVariableStatement(st)) return `${guard} result is not bound to a variable`;
    const varName = st.declarationList.declarations[0].name.getText(sf);
    const block = st.parent;
    const idx = block.statements.indexOf(st);
    const next = block.statements[idx + 1];
    if (!next || !ts.isIfStatement(next) || !next.expression.getText(sf).includes(varName)) return `${guard} result "${varName}" is not checked in the next statement`;
    const returnsIt = (n) => { let ok = false; const go = (x) => { if (ts.isReturnStatement(x) && x.expression?.getText(sf).includes(varName)) ok = true; ts.forEachChild(x, go); }; go(n); return ok; };
    if (!returnsIt(next.thenStatement)) return `${guard} result "${varName}" is checked but not returned`;
  }
  return true;
}

function findConst(body, name) {
  let out = null;
  const go = (n) => { if (out) return; if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) { out = n; return; } if (n !== body && ts.isFunctionLike(n)) return; ts.forEachChild(n, go); };
  go(body);
  return out;
}

export function scan(root) {
  const files = [...SCAN_DIRS.flatMap((d) => walk(path.join(root, d), [])), ...ROOT_FILES.map((f) => path.join(root, f)).filter((f) => fs.existsSync(f))];
  const ctx = { models: forcedRlsModels(root), nullInsert: nullInsertModels(root), readOpen: readOpenModels(root), definerFns: definerLookupFns(root), controlPlaneAllow: controlPlaneAllow(root) };
  const violations = [];
  const debt = new Map();
  for (const f of files) {
    const res = analyseFile(root, f, ctx);
    violations.push(...res.violations);
    for (const x of res.debt) debt.set(x.id, (debt.get(x.id) ?? 0) + 1);
  }
  return { files: files.length, models: ctx.models.size, violations, debt };
}

function readRatchetDoc(root) {
  const f = path.join(root, RATCHET_FILE);
  if (!fs.existsSync(f)) return { sites: {}, sanctioned: {} };
  const doc = JSON.parse(fs.readFileSync(f, "utf8"));
  return { sites: doc.sites ?? {}, sanctioned: doc.sanctioned ?? {} };
}
function readRatchet(root) {
  return readRatchetDoc(root).sites;
}

export function check(root, { log = console.log } = {}) {
  const { files, models, violations, debt } = scan(root);
  const ratchet = readRatchet(root);
  const problems = [...violations.map((x) => `[FAIL] ${x.rule} ${x.file}:${x.line} — ${x.msg}`)];
  // SANCTIONED = deliberate, reasoned exceptions (not debt), e.g. a pre-authentication write
  // that has no tenant by definition. Exact file::symbol::kind + count + reason. An entry may
  // carry pendingPr while the PR that introduces the site is unmerged; once present it is exact.
  const { sanctioned } = readRatchetDoc(root);
  for (const [id, s] of Object.entries(sanctioned)) {
    if (!s || !s.reason || String(s.reason).length < 20) problems.push(`[FAIL] SANCTIONED-NO-REASON ${id}`);
    const got = debt.get(id) ?? 0;
    if (got !== (s.count ?? 1) && !(got === 0 && s.pendingPr)) problems.push(`[FAIL] SANCTIONED-MISMATCH ${id} (sanctioned ${s.count ?? 1}, found ${got})`);
  }
  for (const [id, n] of debt) {
    const allowed = (ratchet[id] ?? 0) + (sanctioned[id]?.count ?? (sanctioned[id] ? 1 : 0));
    if (n > allowed) problems.push(`[FAIL] ${id.includes("::bare:") || id.includes("::raw:") || id.includes("::element:") ? "AST-3" : "AST-2"} NEW-SITE ${id} (found ${n}, ratchet allows ${allowed}) — route it through the tenant transaction instead of the bare client`);
  }
  for (const [id, n] of Object.entries(ratchet)) {
    const got = debt.get(id) ?? 0;
    if (got < n) problems.push(`[FAIL] RATCHET-STALE ${id} (ratchet ${n}, found ${got}) — the debt shrank: lower/delete this entry in ${RATCHET_FILE}`);
  }
  log(`ast-security-guard: ${files} files, ${models} FORCE-RLS models, ${debt.size} debt sites (${[...debt.values()].reduce((a, b) => a + b, 0)} occurrences)`);
  for (const p of problems) log(p);
  log(problems.length ? `AST-SECURITY-GUARD: FAIL (${problems.length})` : "AST-SECURITY-GUARD: PASS");
  return problems.length === 0;
}

function writeRatchet(root) {
  const { violations, debt } = scan(root);
  const sites = Object.fromEntries([...debt.entries()].sort(([a], [b]) => a.localeCompare(b)));
  const { sanctioned } = readRatchetDoc(root);
  for (const id of Object.keys(sanctioned)) delete sites[id];
  const doc = {
    sanctioned,
    note:
      "EXACT-SET ratchet of known tenant-client debt (AST-2 fallback/alias of the canonical prisma, AST-3 bare FORCE-RLS/raw access). " +
      "Every entry is a site that runs WITHOUT tenant context when no transaction is supplied. It may only SHRINK: new sites fail CI, " +
      "removed sites fail until their entry is removed. Regenerate only as a reviewed decision: node scripts/ci/ast-security-guard.mjs --write-ratchet",
    sites,
  };
  fs.writeFileSync(path.join(root, RATCHET_FILE), JSON.stringify(doc, null, 2) + "\n");
  console.log(`wrote ${Object.keys(sites).length} entries; hard violations outstanding: ${violations.length}`);
  for (const x of violations) console.log(`  ${x.rule} ${x.file}:${x.line} ${x.msg}`);
}

function selfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "astguard-"));
  const w = (p, s) => { fs.mkdirSync(path.dirname(path.join(tmp, p)), { recursive: true }); fs.writeFileSync(path.join(tmp, p), s); };
  w("prisma/migrations/1_x/migration.sql", 'ALTER TABLE "Customer" FORCE ROW LEVEL SECURITY;');
  w("lib/prisma.ts", 'import { PrismaClient } from "@prisma/client";\nexport const prisma =\n  new PrismaClient();\n');
  const base = () => { for (const d of ["app", "lib/x", "prisma/migrations/2_n"]) fs.rmSync(path.join(tmp, d), { recursive: true, force: true }); fs.rmSync(path.join(tmp, RATCHET_FILE), { force: true }); };
  const cases = [
    ["clean tree passes", {}, null],
    ["aliased PrismaClient", { "lib/x/a.ts": 'import { PrismaClient as C } from "@prisma/client";\nexport const c = new C();' }, "AST-1"],
    ["newline between new and PrismaClient in a .deps.ts", { "lib/x/p.deps.ts": 'import { PrismaClient } from "@prisma/client";\nexport const c = new\n  PrismaClient();' }, "AST-1"],
    ["namespace PrismaClient", { "lib/x/b.ts": 'import * as P from "@prisma/client";\nexport const c = new P.PrismaClient();' }, "AST-1"],
    ["require PrismaClient", { "lib/x/c.js": 'const { PrismaClient } = require("@prisma/client");\nmodule.exports = new PrismaClient();' }, "AST-1"],
    ["tx ?? prisma fallback", { "lib/x/d.ts": 'import { prisma } from "@/lib/prisma";\nexport function f(o?: { tx?: any }) { const db = o?.tx ?? prisma; return db; }' }, "AST-2"],
    ["run(prisma) — the canonical client passed as an argument", { "lib/x/k.ts": 'import { prisma } from "@/lib/prisma";\nexport function f(o?: { tx?: any }) { const run = (db: any) => db.x.findMany(); return o?.tx ? run(o.tx) : run(prisma); }' }, "AST-2"],
    ["default parameter = prisma", { "lib/x/e.ts": 'import { prisma as p } from "@/lib/prisma";\nexport function f(db = p) { return db; }' }, "AST-2"],
    ["prisma[\"customer\"] element access", { "lib/x/f.ts": 'import { prisma } from "@/lib/prisma";\nexport const f = () => prisma["customer"].findMany();' }, "AST-3"],
    ["bare FORCE-RLS model", { "lib/x/g.ts": 'import { prisma } from "../prisma";\nexport const f = () => prisma\n  .customer\n  .findMany();' }, "AST-3"],
    ["bare $queryRawUnsafe", { "lib/x/h.ts": 'import { prisma } from "@/lib/prisma";\nexport const f = () => prisma.$queryRawUnsafe("select 1");' }, "AST-3"],
    ["dynamic import of prisma-admin", { "lib/x/i.ts": 'export async function f() { const m = await import("@/lib/prisma-admin"); return m; }' }, "AST-4"],
    ["require of prisma-auth", { "lib/x/j.js": 'const a = require("../prisma-auth");\nmodule.exports = a;' }, "AST-4"],
    ["admin route awaits something before the guard", { "app/api/platform-admin/z/route.ts": 'import { requirePlatformAdminOrResponse } from "@/lib/auth/platform-admin";\nimport { NextResponse } from "next/server";\nexport async function GET(req: Request) { const body = await req.json(); const a = await requirePlatformAdminOrResponse(req); if (a instanceof NextResponse) return a; return NextResponse.json(body); }\n// requirePlatformAdminOrResponse' }, "AST-5"],
    ["admin route guard result ignored", { "app/api/platform-admin/z/route.ts": 'import { requirePlatformAdminOrResponse } from "@/lib/auth/platform-admin";\nimport { NextResponse } from "next/server";\nexport async function GET(req: Request) { const a = await requirePlatformAdminOrResponse(req); return NextResponse.json({ a }); }' }, "AST-5"],
    ["admin route with the guard name only in a comment", { "app/api/platform-admin/z/route.ts": '// requirePlatformAdminOrResponse\nexport async function GET() { return new Response("x"); }' }, "AST-5"],
    ["identity-only guard off the allowlist", { "app/api/platform-admin/z/route.ts": 'import { requirePlatformAdminIdentity } from "@/lib/auth/platform-admin";\nexport async function POST(req: Request) { await requirePlatformAdminIdentity(req); return new Response("x"); }' }, "AST-5"],
    ["INT hop: function wrapper returning prisma", { "lib/x/w1.ts": 'import { prisma } from "@/lib/prisma";\nfunction c() { return prisma; }\nexport const f = () => c().customer.findMany();' }, "AST-2"],
    ["INT hop: arrow wrapper () => prisma", { "lib/x/w2.ts": 'import { prisma } from "@/lib/prisma";\nconst c = () => prisma;\nexport const f = () => c().customer.findMany();' }, "AST-2"],
    ["INT hop: re-export from the client module", { "lib/x/w3.ts": 'export { prisma as db } from "@/lib/prisma";' }, "AST-2"],
    ["INT hop: re-export of the imported binding", { "lib/x/w4.ts": 'import { prisma } from "@/lib/prisma";\nexport { prisma as db };' }, "AST-2"],
    ["INT hop: DI object { prisma }", { "lib/x/w5.ts": 'import { prisma } from "@/lib/prisma";\nconst deps = { prisma };\nexport const f = () => deps.prisma.customer.findMany();' }, "AST-2"],
    ["INT hop: array [prisma]", { "lib/x/w6.ts": 'import { prisma } from "@/lib/prisma";\nconst [db] = [prisma];\nexport const f = () => db.customer.findMany();' }, "AST-2"],
    ["INT hop: require of the client module", { "lib/x/w7.ts": 'export const f = () => require("@/lib/prisma").prisma.customer.findMany();' }, "AST-2"],
    ["INT hop: dynamic import of the client module", { "lib/x/w8.ts": 'export const f = async () => (await import("@/lib/prisma")).prisma.customer.findMany();' }, "AST-2"],
    ["INT hop: late assignment db = prisma", { "lib/x/w9.ts": 'import { prisma } from "@/lib/prisma";\nlet db: any; db = prisma;\nexport const f = () => db.customer.findMany();' }, "AST-2"],
    ["INT hop: namespace destructure", { "lib/x/wa.ts": 'import * as P from "@/lib/prisma";\nconst { prisma: db } = P;\nexport const f = () => db.customer.findMany();' }, "AST-2"],
    ["INT hop: getter returning prisma", { "lib/x/wb.ts": 'import { prisma } from "@/lib/prisma";\nconst o = { get db() { return prisma; } };\nexport const f = () => o.db.customer.findMany();' }, "AST-2"],
    ["INT hop: globalThis.prisma", { "lib/x/wc.ts": 'const g = globalThis as any;\nexport const f = () => g.prisma.customer.findMany();' }, "AST-2"],
    ["INT hop: bare site behind a let-bound writer", { "lib/x/wd.ts": 'import { prisma } from "@/lib/prisma";\nconst w = async () => { await prisma.customer.findMany(); };\nlet writer = w;\nexport const f = () => writer();' }, "AST-3"],
    ["INT null-insert: businessId NULL insert on a NULL-only-insert-policy model passes", { "prisma/migrations/2_n/migration.sql": 'ALTER TABLE "Customer" FORCE ROW LEVEL SECURITY;\nCREATE POLICY p ON "Customer" FOR INSERT TO app_runtime WITH CHECK ("businessId" IS NULL OR "businessId" = 1);', "lib/x/we.ts": 'import { prisma } from "@/lib/prisma";\nexport const f = (row: any) => prisma.customer.createMany({ data: [{ ...row, businessId: null }] });' }, null],
    ["INT null-insert: a spread AFTER businessId: null is a site", { "prisma/migrations/2_n/migration.sql": 'CREATE POLICY p ON "Customer" FOR INSERT TO app_runtime WITH CHECK ("businessId" IS NULL);', "lib/x/wf.ts": 'import { prisma } from "@/lib/prisma";\nexport const f = (row: any) => prisma.customer.createMany({ data: [{ businessId: null, ...row }] });' }, "AST-3"],
    ["INT null-insert: non-null businessId is a site", { "prisma/migrations/2_n/migration.sql": 'CREATE POLICY p ON "Customer" FOR INSERT TO app_runtime WITH CHECK ("businessId" IS NULL);', "lib/x/wg.ts": 'import { prisma } from "@/lib/prisma";\nexport const f = (row: any) => prisma.customer.createMany({ data: [{ ...row, businessId: row.businessId }] });' }, "AST-3"],
    ["B4 read-open: a bare read of a USING (true) model passes", { "prisma/migrations/2_n/migration.sql": 'CREATE POLICY r ON "Customer" FOR SELECT USING (true);', "lib/x/ro1.ts": 'import { prisma } from "@/lib/prisma";\nexport const f = (id: number) => prisma.customer.findUnique({ where: { id } });' }, null],
    ["B4 read-open: a bare WRITE of a read-open model is a site", { "prisma/migrations/2_n/migration.sql": 'CREATE POLICY r ON "Customer" FOR SELECT USING (true);', "lib/x/ro2.ts": 'import { prisma } from "@/lib/prisma";\nexport const f = (id: number) => prisma.customer.updateMany({ where: { id }, data: {} });' }, "AST-3"],
    ["B4 read-open: a role-restricted USING (true) does not open reads", { "prisma/migrations/2_n/migration.sql": 'CREATE POLICY r ON "Customer" FOR SELECT TO app_admin USING (true);', "lib/x/ro3.ts": 'import { prisma } from "@/lib/prisma";\nexport const f = (id: number) => prisma.customer.findUnique({ where: { id } });' }, "AST-3"],
    ["B4 read-open: a tenant-scoped SELECT policy does not open reads", { "prisma/migrations/2_n/migration.sql": 'CREATE POLICY r ON "Customer" FOR SELECT USING ("businessId" = 1);', "lib/x/ro4.ts": 'import { prisma } from "@/lib/prisma";\nexport const f = () => prisma.customer.findMany();' }, "AST-3"],
    ["INT null-insert: model WITHOUT a NULL-only insert policy is a site", { "lib/x/wh.ts": 'import { prisma } from "@/lib/prisma";\nexport const f = (row: any) => prisma.customer.createMany({ data: [{ ...row, businessId: null }] });' }, "AST-3"],
    ["INT definer: SELECT cols FROM a DEFINER lookup passes", { "prisma/migrations/2_n/migration.sql": 'CREATE OR REPLACE FUNCTION public.lk(p text) RETURNS int LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $f$ SELECT 1 $f$;\nREVOKE ALL ON FUNCTION public.lk(text) FROM PUBLIC;', "lib/x/wi.ts": 'import { prisma } from "@/lib/prisma";\nexport const f = (k: string) => prisma.$queryRaw`SELECT a, b FROM public.lk(${k})`;' }, null],
    ["INT definer: a function NOT revoked from PUBLIC is a site", { "prisma/migrations/2_n/migration.sql": 'CREATE OR REPLACE FUNCTION public.lk(p text) RETURNS int LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $f$ SELECT 1 $f$;', "lib/x/wj.ts": 'import { prisma } from "@/lib/prisma";\nexport const f = (k: string) => prisma.$queryRaw`SELECT public.lk(${k}) AS b`;' }, "AST-3"],
    ["INT definer: a table read smuggled beside the lookup is a site", { "prisma/migrations/2_n/migration.sql": 'CREATE OR REPLACE FUNCTION public.lk(p text) RETURNS int LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $f$ SELECT 1 $f$;\nREVOKE ALL ON FUNCTION public.lk(text) FROM PUBLIC;', "lib/x/wk.ts": 'import { prisma } from "@/lib/prisma";\nexport const f = (k: string) => prisma.$queryRaw`SELECT x FROM "Customer" c, public.lk(${k})`;' }, "AST-3"],
    ["INT hop: prisma.$extends returns a new bare client", { "lib/x/wl.ts": 'import { prisma } from "@/lib/prisma";\nconst x = prisma.$extends({});\nexport const f = () => x.customer.findMany();' }, "AST-2"],
    ["correct admin route passes", { "app/api/platform-admin/z/route.ts": 'import { requirePlatformAdminOrResponse } from "@/lib/auth/platform-admin";\nimport { NextResponse } from "next/server";\nexport async function GET(req: Request) { try { const a = await requirePlatformAdminOrResponse(req); if (a instanceof NextResponse) { return a; } return NextResponse.json(await Promise.resolve(1)); } catch { return new Response("e", { status: 500 }); } }' }, null],
  ];
  let ok = true;
  for (const [name, filesMap, rule] of cases) {
    base();
    for (const [p, s] of Object.entries(filesMap)) w(p, s);
    const out = [];
    const passed = check(tmp, { log: (l) => out.push(l) });
    const hit = rule ? out.some((l) => l.startsWith(`[FAIL] ${rule}`)) : false;
    const good = rule ? !passed && hit : passed;
    console.log(`${good ? "PASS" : "FAIL"}  self-test: ${name}${good ? "" : `\n${out.join("\n")}`}`);
    ok &&= good;
  }
  // Ratchet semantics: an exact-set entry accepts the site; a new site and a stale entry both fail.
  base();
  w("lib/x/d.ts", 'import { prisma } from "@/lib/prisma";\nexport function f(o?: { tx?: any }) { return o?.tx ?? prisma; }');
  const id = "lib/x/d.ts::f::fallback??";
  w(RATCHET_FILE, JSON.stringify({ sites: { [id]: 1 } }));
  const r1 = check(tmp, { log: () => {} });
  w(RATCHET_FILE, JSON.stringify({ sites: { [id]: 1, "lib/x/gone.ts::g::alias": 1 } }));
  const out2 = []; const r2 = check(tmp, { log: (l) => out2.push(l) });
  const good = r1 === true && r2 === false && out2.some((l) => l.includes("RATCHET-STALE"));
  console.log(`${good ? "PASS" : "FAIL"}  self-test: exact-set ratchet (accepts pinned, rejects stale)`);
  ok &&= good;
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(ok ? `ast-security-guard self-test: ${cases.length + 1} checks passed` : "ast-security-guard self-test: FAILED");
  return ok;
}

const argv = process.argv.slice(2);
if (argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);
else if (argv.includes("--write-ratchet")) writeRatchet(argv.find((a) => !a.startsWith("--")) ?? ".");
else process.exit(check(argv[0] ?? ".") ? 0 : 1);
