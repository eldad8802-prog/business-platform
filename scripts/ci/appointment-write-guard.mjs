#!/usr/bin/env node
/**
 * appointment-write-guard.mjs — no timed Appointment write without the per-business lock (owner P0-2, 2026-11-01).
 *
 * WHY. Two active appointments may not overlap. Inside one lane (a staff member, or the business's own lane) the
 * database enforces it (EXCLUDE Appointment_no_overlap). ACROSS lanes — a business-wide block or a general
 * appointment over a staff member's appointment — the guard is application code (laneOccupants / assertFree, P0-1),
 * and it is sound only because every write that can make an appointment occupy time, or change the time it occupies,
 * first takes pg_advisory_xact_lock(APPOINTMENT_LOCK_NAMESPACE, businessId). A new write path that skips the lock
 * would silently reopen double booking. This guard fails CI when one appears.
 *
 * WHAT IS A TIME WRITE. A Prisma write on the Appointment delegate that:
 *   - creates a row with `startsAt` or `endsAt` set to anything but the literal `null` (an untimed row occupies no
 *     time: laneOccupants and the EXCLUDE both require endsAt), or
 *   - updates / upserts any of startsAt, endsAt, staffMemberId, staffMember, status, bufferBeforeMinutes,
 *     bufferAfterMinutes, or
 *   - cannot be read: `data` that is not an object literal, a spread, a computed key — fail closed.
 * delete / deleteMany are not time writes (they free time; the runtime role holds no DELETE on Appointment anyway).
 *
 * RULES
 *   W1 LOCK      every time write is proven locked, structurally:
 *                  (a) it sits in a function passed to the canonical `ownerWrite` (it takes the lock first), or
 *                  (b) an `await lockBusinessAppointments(...)` statement precedes it in a block that contains it
 *                      (a lock inside an `if`, after the write, or not awaited does not count), or
 *                  (c) its function is a named primitive and EVERY call of it, in every scanned file, is itself
 *                      proven locked by (a)/(b)/(c) — indirect writes through service functions. A primitive with
 *                      no caller, or one used as a value (passed, stored, returned), fails.
 *                The canonical functions are resolved by SYMBOL to their declaration in
 *                lib/services/appointment/appointment-request.ts (an alias import works; a local function that is
 *                merely named lockBusinessAppointments does not), and the lock's own body must still call
 *                pg_advisory_xact_lock, and ownerWrite's must still call the lock.
 *   W2 LIST      the set of time writes is EXACTLY the approved list below (file::function chain::op, with count).
 *                A new writer fails even when locked (a human adds it here, with its proof), a removed or renamed
 *                one fails until its entry is updated — renaming a function cannot slip a writer past the list.
 *   W3 ESCAPE    the Appointment delegate (found by its TYPE, Prisma's AppointmentDelegate — not by a variable
 *                name) may be used only as `<expr>.appointment.<op>(...)`. Aliasing it (`const d = tx.appointment`),
 *                destructuring it, passing / returning / storing it, a dynamic `tx[model]` that can be Appointment,
 *                or pulling a write method off it as a value fails: the guard could not follow the write.
 *   W4 NESTED    a nested relation write into appointments through another model
 *                (`{ appointment(s): { create | createMany | connectOrCreate | update | updateMany | upsert } }`).
 *   W5 RAW SQL   a string or template literal that writes the Appointment table (INSERT INTO / UPDATE / MERGE INTO /
 *                COPY "Appointment", optionally schema-qualified). "AppointmentEvent" and other tables do not match.
 *
 * SCOPE AND LIMITS (this is a CI tripwire, NOT a substitute for a database constraint across lanes):
 *   - scanned: runtime source under app/ lib/ components/ features/ hooks/ and the root proxy/middleware/
 *     instrumentation files, as ast-security-guard scans. Not scanned: *.test.* / *.spec.* files, the lab
 *     batteries (.appt/ .bkg/), scripts/, CI workflows and migrations — they run against throwaway databases or go
 *     through the release-migrate gate, not the application.
 *   - raw SQL assembled at runtime (`$executeRawUnsafe(a + b)`, a table name in a variable, a string split across
 *     pieces) is not seen; nor are database-side functions or triggers that write Appointment.
 *   - the lock proof is structural: it proves the lock is taken in that transaction callback before the write, not
 *     that it was taken for the same business or the same transaction object, nor that the code then calls
 *     assertFree. The approved list (W2) is the human review of those.
 *   - code reached only through `any` (an untyped client) is matched by shape (`.appointment.<write>(`) only, and a
 *     dynamic model key (`tx[k]`) is type-checked only in files that mention "appointment" somewhere.
 *
 * Usage:
 *   node scripts/ci/appointment-write-guard.mjs [ROOT]        check the tree (exit 1 on a violation), print the map
 *   node scripts/ci/appointment-write-guard.mjs --self-test   planted offenders and approved shapes, in memory
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const SCAN_DIRS = ["app", "lib", "components", "features", "hooks"];
const ROOT_FILES = ["proxy.ts", "middleware.ts", "instrumentation.ts"];
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "__tests__", "__mocks__"]);
const SKIP_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|\.d\.ts$/;
const SRC_FILE = /\.(ts|tsx|mts|cts)$/;

export const CANONICAL_FILE = "lib/services/appointment/appointment-request.ts";
const LOCK_FN = "lockBusinessAppointments";
const OWNER_WRITE_FN = "ownerWrite";
const DELEGATE_TYPE = "AppointmentDelegate";

const READ_OPS = new Set(["findFirst", "findFirstOrThrow", "findMany", "findUnique", "findUniqueOrThrow", "count", "aggregate", "groupBy", "fields"]);
const FREE_OPS = new Set(["delete", "deleteMany"]);
const CREATE_OPS = new Set(["create", "createMany", "createManyAndReturn"]);
const UPDATE_OPS = new Set(["update", "updateMany", "updateManyAndReturn"]);
const WRITE_OPS = new Set([...CREATE_OPS, ...UPDATE_OPS, "upsert"]);
const TIME_FIELDS = new Set(["startsAt", "endsAt", "staffMemberId", "staffMember", "status", "bufferBeforeMinutes", "bufferAfterMinutes"]);
const NESTED_WRITE_KEYS = new Set(["create", "createMany", "connectOrCreate", "update", "updateMany", "upsert"]);
const RAW_WRITE = /\b(insert\s+into|update|merge\s+into|copy)\s+(?:"?public"?\s*\.\s*)?"?Appointment"?(?![A-Za-z0-9_])/i;

/**
 * W2 — the approved time writers (file::function chain::op → count). Each is proven locked by W1 as well; this list
 * is the human decision that the write also checks the lane (assertFree / laneOccupants) under that lock.
 */
export const APPROVED = {
  // ownerWrite (lock) → assertFree on the lane of the new row.
  "lib/services/appointment/appointment-schedule.service.ts::createAppointment::appointment.create": 1,
  // ownerWrite (lock) → assertFree on the new time and the new staff member.
  "lib/services/appointment/appointment-schedule.service.ts::moveAppointment::appointment.update": 1,
  // ownerWrite (lock); title / notes / location / customer only — listed because its data is a spread.
  "lib/services/appointment/appointment-schedule.service.ts::updateDetails::appointment.update": 1,
  // the one lifecycle primitive: its callers are changeStatus (ownerWrite; assertFree when PROPOSED → CONFIRMED),
  // expireDueRequests (public submit and the sweep, both after the lock; → CANCELED only) and cancelByToken (lock).
  "lib/services/appointment/appointment.service.ts::transitionWithinTx::appointment.update": 1,
  // lock → laneSlots (laneOccupants) → the chosen free lane.
  "lib/services/booking/public-booking.service.ts::submitPublicRequest>attempt::appointment.create": 1,
};

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────

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

const isFunctionLike = (n) =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n)
  || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n) || ts.isConstructorDeclaration(n);

function enclosingFunction(n) {
  for (let p = n.parent; p; p = p.parent) if (isFunctionLike(p)) return p;
  return null;
}

/** Skip the wrappers that do not change what an expression is. */
function outer(n) {
  let p = n;
  while (p.parent && (ts.isParenthesizedExpression(p.parent) || ts.isNonNullExpression(p.parent) || ts.isAsExpression(p.parent)
    || ts.isTypeAssertionExpression(p.parent) || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(p.parent)))) p = p.parent;
  return p;
}

function inner(n) {
  let e = n;
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertionExpression(e)
    || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(e))) e = e.expression;
  return e;
}

/** The name a function is known by: its declaration name, or the variable / property it is assigned to. */
function functionName(fn) {
  if (fn.name && (ts.isIdentifier(fn.name) || ts.isStringLiteral(fn.name))) return fn.name.text;
  if (ts.isConstructorDeclaration(fn)) return "constructor";
  const p = outer(fn).parent;
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (p && ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) return p.name.text;
  return null;
}

/** "outer>inner" — the named functions around a node, anonymous callbacks skipped. */
function functionChain(n) {
  const names = [];
  for (let p = n.parent; p; p = p.parent) if (isFunctionLike(p)) { const nm = functionName(p); if (nm) names.unshift(nm); }
  return names.length ? names.join(">") : "<module>";
}

function propName(p) {
  if (!p.name) return null;
  if (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) || ts.isNumericLiteral(p.name)) return p.name.text;
  return null; // computed
}

function getProp(obj, name) {
  for (const p of obj.properties) {
    if ((ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && propName(p) === name) return p;
  }
  return null;
}

const isNullLiteral = (e) => e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === "undefined");

/** Is this object-literal row a time write? null = cannot tell (fail closed). */
function rowWritesTime(obj, mode) {
  if (!ts.isObjectLiteralExpression(obj)) return null;
  let hit = false;
  for (const p of obj.properties) {
    if (ts.isSpreadAssignment(p)) return null;
    const name = propName(p);
    if (name === null) return null;
    if (!TIME_FIELDS.has(name)) continue;
    if (mode === "create") {
      if (name !== "startsAt" && name !== "endsAt") continue;
      if (ts.isPropertyAssignment(p) && isNullLiteral(inner(p.initializer))) continue;
      hit = true;
    } else {
      hit = true;
    }
  }
  return hit;
}

/** Is this Prisma write call a time write? Returns { time: boolean, why }. */
function classifyWrite(call, op) {
  const arg = call.arguments[0] && inner(call.arguments[0]);
  if (!arg || !ts.isObjectLiteralExpression(arg)) return { time: true, why: "its argument is not an object literal" };
  const verdicts = [];
  const check = (key, mode) => {
    const p = getProp(arg, key);
    if (!p) { verdicts.push(mode === "create" && key === "data" ? null : false); return; }
    if (ts.isShorthandPropertyAssignment(p)) { verdicts.push(null); return; }
    const v = inner(p.initializer);
    if (op === "createMany" || op === "createManyAndReturn") {
      if (ts.isArrayLiteralExpression(v)) { for (const el of v.elements) verdicts.push(rowWritesTime(inner(el), "create")); return; }
      verdicts.push(rowWritesTime(v, "create"));
      return;
    }
    verdicts.push(rowWritesTime(v, mode));
  };
  if (CREATE_OPS.has(op)) check("data", "create");
  else if (UPDATE_OPS.has(op)) check("data", "update");
  else { check("create", "create"); check("update", "update"); }
  if (verdicts.some((v) => v === null)) return { time: true, why: "its data cannot be read field by field (spread, computed key, or not a literal)" };
  return { time: verdicts.some(Boolean), why: "it writes a time field" };
}

// ── the analysis ──────────────────────────────────────────────────────────────────────────────────

/**
 * @param program  a ts.Program over (at least) the scanned files
 * @param root     the repository root (paths are reported relative to it)
 * @param scanned  absolute paths of the files in scope
 * @param approved the W2 list
 */
export function analyze(program, root, scanned, approved) {
  const checker = program.getTypeChecker();
  const violations = [];
  const sites = []; // time writes: { key, where, proof }
  const scannedSet = new Set(scanned.map((f) => path.resolve(f)));
  const files = program.getSourceFiles().filter((sf) => scannedSet.has(path.resolve(sf.fileName)));
  const where = (n) => {
    const sf = n.getSourceFile();
    return `${rel(root, sf.fileName)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
  };
  const fail = (rule, n, msg) => violations.push({ rule, where: where(n), msg });

  const resolve = (sym) => (sym && sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym);
  const declaredIn = (sym, file, name) => {
    const s = resolve(sym);
    if (!s || s.getName() !== name) return false;
    return (s.declarations ?? []).some((d) => rel(root, d.getSourceFile().fileName) === file);
  };
  const calleeIs = (call, name) => {
    let c = inner(call.expression);
    if (ts.isPropertyAccessExpression(c)) c = c.name;
    return declaredIn(checker.getSymbolAtLocation(c), CANONICAL_FILE, name);
  };

  // The canonical lock must still be a lock.
  const canonical = program.getSourceFiles().find((sf) => rel(root, sf.fileName) === CANONICAL_FILE);
  const decl = (name) => canonical && canonical.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === name);
  const lockDecl = decl(LOCK_FN);
  const ownerDecl = decl(OWNER_WRITE_FN);
  if (!lockDecl || !/pg_advisory_xact_lock\s*\(/.test(lockDecl.getText())) {
    violations.push({ rule: "W1", where: CANONICAL_FILE, msg: `${LOCK_FN} is missing or no longer calls pg_advisory_xact_lock — the lock every proof relies on is gone` });
  }
  if (!ownerDecl || !new RegExp(`\\b${LOCK_FN}\\s*\\(`).test(ownerDecl.getText())) {
    violations.push({ rule: "W1", where: CANONICAL_FILE, msg: `${OWNER_WRITE_FN} is missing or no longer calls ${LOCK_FN}` });
  }

  const isDelegateType = (t) => {
    if (!t) return false;
    if (t.isUnion()) return t.types.some(isDelegateType);
    return t.getSymbol()?.getName() === DELEGATE_TYPE || t.aliasSymbol?.getName() === DELEGATE_TYPE;
  };

  /** Is the node `n` (a write, or a call of a primitive) proven to run under the lock? */
  const memo = new Map(); // function node -> { ok, proof } (null while in progress)
  function lockedAt(n) {
    const fn = enclosingFunction(n);
    if (!fn) return { ok: false, proof: "module level" };
    // (a) inside a callback handed to ownerWrite
    const o = outer(fn);
    if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && o.parent && ts.isCallExpression(o.parent)
      && o.parent.arguments.includes(o) && calleeIs(o.parent, OWNER_WRITE_FN)) {
      return { ok: true, proof: OWNER_WRITE_FN };
    }
    // (b) an awaited lock statement before it, in a block that contains it, inside the same function
    for (let child = n, p = n.parent; p && p !== fn; child = p, p = p.parent) {
      if (!ts.isBlock(p)) continue;
      const idx = p.statements.indexOf(child);
      for (let i = 0; i < idx; i++) {
        const s = p.statements[i];
        if (!ts.isExpressionStatement(s)) continue;
        const e = inner(s.expression);
        if (ts.isAwaitExpression(e) && ts.isCallExpression(inner(e.expression)) && calleeIs(inner(e.expression), LOCK_FN)) {
          return { ok: true, proof: LOCK_FN };
        }
      }
    }
    // (c) a named primitive whose every caller is locked
    return primitiveLocked(fn);
  }

  function primitiveLocked(fn) {
    if (memo.has(fn)) return memo.get(fn) ?? { ok: false, proof: "a recursive call cycle" };
    memo.set(fn, null);
    const result = (() => {
      const nameNode = fn.name ?? (ts.isVariableDeclaration(outer(fn).parent) ? outer(fn).parent.name : null);
      if (!nameNode || !ts.isIdentifier(nameNode)) return { ok: false, proof: "an anonymous function that takes no lock" };
      const sym = resolve(checker.getSymbolAtLocation(nameNode));
      if (!sym) return { ok: false, proof: "an unresolvable function" };
      const refs = references(sym, nameNode);
      if (refs.length === 0) return { ok: false, proof: `${nameNode.text}() takes no lock and no scanned code calls it under one` };
      for (const r of refs) {
        let callee = r;
        if (ts.isPropertyAccessExpression(r.parent) && r.parent.name === r) callee = r.parent;
        const c = outer(callee).parent;
        if (!c || !ts.isCallExpression(c) || inner(c.expression) !== callee) {
          return { ok: false, proof: `${nameNode.text} is used as a value at ${where(r)} (passed, stored or returned) — its calls cannot be followed` };
        }
        const up = lockedAt(c);
        if (!up.ok) return { ok: false, proof: `${nameNode.text}() is called without the lock at ${where(c)} (${up.proof})` };
      }
      return { ok: true, proof: `every call of ${nameNode.text}() is locked` };
    })();
    memo.set(fn, result);
    return result;
  }

  /** One pass over the scanned files: identifiers by name, and import / export renames (local name → imported name). */
  let index = null;
  function ensureIndex() {
    if (index) return index;
    index = { byName: new Map(), renames: [] };
    for (const sf of files) {
      const visit = (node) => {
        if (ts.isIdentifier(node)) {
          const list = index.byName.get(node.text);
          if (list) list.push(node); else index.byName.set(node.text, [node]);
        }
        if ((ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) && node.propertyName) {
          index.renames.push([node.propertyName.text, node.name.text]);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    return index;
  }

  /** Every reference to `sym` in the scanned files, followed through import / export aliases. */
  function references(sym, declName) {
    const { byName, renames } = ensureIndex();
    const names = new Set([sym.getName()]);
    for (let grew = true; grew;) {
      grew = false;
      for (const [from, to] of renames) if (names.has(from) && !names.has(to)) { names.add(to); grew = true; }
    }
    const out = [];
    for (const name of names) {
      for (const node of byName.get(name) ?? []) {
        if (node === declName || ts.isImportSpecifier(node.parent) || ts.isExportSpecifier(node.parent) || ts.isImportClause(node.parent)) continue;
        const s = resolve(ts.isShorthandPropertyAssignment(node.parent) ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node));
        if (s === sym) out.push(node);
      }
    }
    return out;
  }

  // ── walk the scanned files ──
  for (const sf of files) {
    // A dynamic model key is type-checked only where the file names appointments at all (scope note in the header).
    const mentions = /appointment/i.test(sf.text);
    const visit = (node) => {
      // W5 raw SQL
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)
        || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
        if (RAW_WRITE.test(node.text)) fail("W5", node, "raw SQL writes the Appointment table — route the write through the locked service (ownerWrite / lockBusinessAppointments)");
      }
      // W4 nested relation write
      if (ts.isPropertyAssignment(node) && /^appointments?$/.test(propName(node) ?? "") && ts.isObjectLiteralExpression(inner(node.initializer))) {
        const keys = inner(node.initializer).properties.map(propName);
        if (keys.some((k) => NESTED_WRITE_KEYS.has(k))) fail("W4", node, "a nested relation write into Appointment through another model — write appointments only through the locked service");
      }
      // W3 destructured delegate
      if (ts.isBindingElement(node) && ((node.propertyName ?? node.name).getText() === "appointment")
        && isDelegateType(checker.getTypeAtLocation(node.name))) {
        fail("W3", node, "the Appointment delegate is destructured — use <client>.appointment.<op>(...) directly so the write can be followed");
      }
      // the delegate itself
      let isAccess = false;
      if (ts.isPropertyAccessExpression(node) && node.name.text === "appointment") isAccess = true;
      if (ts.isElementAccessExpression(node) && mentions && !ts.isNumericLiteral(node.argumentExpression)
        && !(ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text !== "appointment")) isAccess = true;
      if (isAccess) {
        const typed = isDelegateType(checker.getTypeAtLocation(node));
        const o = outer(node);
        const p = o.parent;
        let op = null;
        if (p && ts.isPropertyAccessExpression(p) && p.expression === o) op = p.name.text;
        else if (p && ts.isElementAccessExpression(p) && p.expression === o) op = ts.isStringLiteralLike(p.argumentExpression) ? p.argumentExpression.text : "<dynamic>";
        const shapeWrite = ts.isPropertyAccessExpression(node) && op !== null && WRITE_OPS.has(op);
        if (typed || shapeWrite) {
          if (ts.isElementAccessExpression(node) && !ts.isStringLiteralLike(node.argumentExpression)) {
            fail("W3", node, "a dynamic model access that can reach the Appointment delegate — name the model so the write can be followed");
          } else if (op === null) {
            fail("W3", node, "the Appointment delegate escapes (aliased, passed, returned or stored) — use <client>.appointment.<op>(...) directly");
          } else if (READ_OPS.has(op) || FREE_OPS.has(op)) {
            // a read, or a delete (frees time)
          } else if (WRITE_OPS.has(op)) {
            const m = outer(p);
            const call = m.parent;
            if (!call || !ts.isCallExpression(call) || inner(call.expression) !== p) {
              fail("W3", p, `appointment.${op} is taken as a value — call it in place so the write can be followed`);
            } else {
              const c = classifyWrite(call, op);
              if (c.time) {
                const key = `${rel(root, sf.fileName)}::${functionChain(call)}::appointment.${op}`;
                const lk = lockedAt(call);
                sites.push({ key, where: where(call), proof: lk.ok ? lk.proof : null });
                if (!lk.ok) fail("W1", call, `appointment.${op} is a time write (${c.why}) without the per-business lock: ${lk.proof}. Take it through ownerWrite, or await lockBusinessAppointments(tx, businessId) first and check the lane (assertFree / laneOccupants)`);
              }
            }
          } else {
            fail("W3", p, `unknown Appointment delegate member "${op}" — the guard cannot tell whether it writes`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  // W2 — exact list
  const counts = new Map();
  for (const s of sites) counts.set(s.key, (counts.get(s.key) ?? 0) + 1);
  for (const [key, n] of counts) {
    if (!(key in approved)) {
      const at = sites.filter((s) => s.key === key).map((s) => s.where).join(", ");
      violations.push({ rule: "W2", where: at, msg: `a time write that is not on the approved list: ${key}. A new (or renamed) writer needs review — add it to APPROVED in scripts/ci/appointment-write-guard.mjs with its lane check` });
    } else if (approved[key] !== n) {
      violations.push({ rule: "W2", where: key, msg: `approved ${approved[key]} time write(s) here, found ${n}` });
    }
  }
  for (const key of Object.keys(approved)) {
    if (!counts.has(key)) violations.push({ rule: "W2", where: key, msg: "an approved time writer no longer exists (removed or renamed) — update APPROVED" });
  }
  return { violations, sites };
}

// ── the real tree ─────────────────────────────────────────────────────────────────────────────────

function check(root) {
  const scanned = [];
  for (const d of SCAN_DIRS) walk(path.join(root, d), scanned);
  for (const f of ROOT_FILES) if (fs.existsSync(path.join(root, f))) scanned.push(path.join(root, f));
  const cfgPath = path.join(root, "tsconfig.json");
  const cfg = ts.parseJsonConfigFileContent(ts.readConfigFile(cfgPath, ts.sys.readFile).config, ts.sys, root);
  const options = { ...cfg.options, noEmit: true, incremental: false, plugins: [] };
  const program = ts.createProgram(scanned, options);
  const { violations, sites } = analyze(program, root, scanned, APPROVED);
  console.log(`appointment-write-guard: ${scanned.length} files scanned, ${sites.length} time write(s)`);
  for (const s of sites.sort((a, b) => a.key.localeCompare(b.key))) console.log(`  ${s.proof ? "locked" : "UNLOCKED"}  ${s.key}  (${s.where}${s.proof ? `; ${s.proof}` : ""})`);
  if (violations.length) {
    console.error(`\nappointment-write-guard: ${violations.length} violation(s)`);
    for (const v of violations) console.error(`  [${v.rule}] ${v.where}: ${v.msg}`);
    return false;
  }
  console.log("appointment-write-guard: PASS");
  return true;
}

// ── self-test: planted offenders (must fail) and approved shapes (must pass), in memory ───────────

const FAKE_PRISMA = `
export interface AppointmentDelegate {
  create(a: any): Promise<any>; createMany(a: any): Promise<any>; update(a: any): Promise<any>; updateMany(a: any): Promise<any>;
  upsert(a: any): Promise<any>; delete(a: any): Promise<any>; deleteMany(a: any): Promise<any>;
  findFirst(a: any): Promise<any>; findMany(a: any): Promise<any>; count(a: any): Promise<number>;
}
export interface CustomerDelegate { update(a: any): Promise<any> }
export type Tx = { appointment: AppointmentDelegate; customer: CustomerDelegate; $executeRaw(s: TemplateStringsArray, ...v: any[]): Promise<number>; $executeRawUnsafe(s: string): Promise<number> };
export declare function tenantTx<T>(id: number, fn: (tx: Tx) => Promise<T>): Promise<T>;
`;
const CANON_OK = `
import type { Tx } from "../../../prisma-fake";
export async function lockBusinessAppointments(tx: Tx, businessId: number): Promise<void> {
  await tx.$executeRaw\`SELECT pg_advisory_xact_lock(1, \${businessId})\`;
}
export async function ownerWrite<T>(businessId: number, fn: (ctx: { tx: Tx }) => Promise<T>): Promise<T> {
  return (null as any as (f: any) => Promise<T>)(async (tx: Tx) => { await lockBusinessAppointments(tx, businessId); return fn({ tx }); });
}
`;
const CANON_HOLLOW = CANON_OK.replace("SELECT pg_advisory_xact_lock(1, ${businessId})", "SELECT 1");
const HEAD = `import { tenantTx, type Tx } from "../prisma-fake";\nimport { lockBusinessAppointments, ownerWrite } from "./services/appointment/appointment-request";\n`;
const W = "lib/w.ts"; // the case file (scanned)

const CASES = [
  // must FAIL
  { name: "N1 unlocked update of startsAt", rule: "W1", src: `export async function moveIt(tx: Tx) { await tx.appointment.update({ where: { id: 1 }, data: { startsAt: new Date() } }); }` },
  { name: "N2 unlocked timed create", rule: "W1", src: `export async function make(tx: Tx) { await tx.appointment.create({ data: { businessId: 1, startsAt: new Date(), endsAt: new Date() } }); }` },
  { name: "N3 delegate aliased to a variable", rule: "W3", src: `export async function f(tx: Tx) { await lockBusinessAppointments(tx, 1); const d = tx.appointment; await d.update({ where: { id: 1 }, data: { status: "CONFIRMED" } }); }` },
  { name: "N4 delegate destructured", rule: "W3", src: `export async function f(tx: Tx) { const { appointment } = tx; await appointment.update({ where: { id: 1 }, data: { endsAt: null } }); }` },
  { name: "N5 delegate passed to a helper", rule: "W3", src: `const h = (d: any) => d.update({ data: { startsAt: new Date() } });\nexport async function f(tx: Tx) { await h(tx.appointment); }` },
  { name: "N6 a local function merely named lockBusinessAppointments", rule: "W1", head: `import { tenantTx, type Tx } from "../prisma-fake";\n`, src: `async function lockBusinessAppointments(_tx: Tx, _b: number) {}\nexport async function f(tx: Tx) { await lockBusinessAppointments(tx, 1); await tx.appointment.update({ where: { id: 1 }, data: { startsAt: new Date() } }); }` },
  { name: "N7 lock only inside an if", rule: "W1", src: `export async function f(tx: Tx, x: boolean) { if (x) { await lockBusinessAppointments(tx, 1); } await tx.appointment.update({ where: { id: 1 }, data: { startsAt: new Date() } }); }` },
  { name: "N8 lock after the write", rule: "W1", src: `export async function f(tx: Tx) { await tx.appointment.update({ where: { id: 1 }, data: { staffMemberId: 2 } }); await lockBusinessAppointments(tx, 1); }` },
  { name: "N9 lock not awaited", rule: "W1", src: `export async function f(tx: Tx) { lockBusinessAppointments(tx, 1); await tx.appointment.update({ where: { id: 1 }, data: { startsAt: new Date() } }); }` },
  { name: "N10 indirect: a primitive with one unlocked caller", rule: "W1", approved: { "lib/w.ts::prim::appointment.update": 1 }, src: `async function prim(tx: Tx) { await tx.appointment.update({ where: { id: 1 }, data: { status: "CONFIRMED" } }); }\nexport async function good(tx: Tx) { await lockBusinessAppointments(tx, 1); await prim(tx); }\nexport async function bad(id: number) { return tenantTx(id, async (tx) => prim(tx)); }` },
  { name: "N11 a primitive nobody calls", rule: "W1", src: `export async function prim(tx: Tx) { await tx.appointment.update({ where: { id: 1 }, data: { bufferAfterMinutes: 30 } }); }` },
  { name: "N12 a primitive used as a value", rule: "W1", src: `async function prim(tx: Tx) { await tx.appointment.update({ where: { id: 1 }, data: { startsAt: new Date() } }); }\nexport const table = { prim };` },
  { name: "N13 nested relation write through another model", rule: "W4", src: `export async function f(tx: Tx) { await tx.customer.update({ where: { id: 1 }, data: { appointments: { create: { startsAt: new Date() } } } }); }` },
  { name: "N14 raw SQL UPDATE Appointment (tagged template)", rule: "W5", src: `export async function f(tx: Tx) { await tx.$executeRaw\`UPDATE "Appointment" SET "startsAt" = now() WHERE id = \${1}\`; }` },
  { name: "N15 raw SQL INSERT INTO public.Appointment (unsafe string)", rule: "W5", src: `export async function f(tx: Tx) { await tx.$executeRawUnsafe('insert into public."Appointment" ("businessId") values (1)'); }` },
  { name: "N16 a locked writer that is not on the list", rule: "W2", approved: {}, src: `export async function f(tx: Tx) { await lockBusinessAppointments(tx, 1); await tx.appointment.update({ where: { id: 1 }, data: { startsAt: new Date() } }); }` },
  { name: "N17 an approved writer renamed", rule: "W2", approved: { "lib/w.ts::approvedName::appointment.update": 1 }, src: `export async function renamedWriter(tx: Tx) { await lockBusinessAppointments(tx, 1); await tx.appointment.update({ where: { id: 1 }, data: { startsAt: new Date() } }); }` },
  { name: "N18 a second write added inside an approved function", rule: "W2", approved: { "lib/w.ts::f::appointment.update": 1 }, src: `export async function f(tx: Tx) { await lockBusinessAppointments(tx, 1); await tx.appointment.update({ where: { id: 1 }, data: { startsAt: new Date() } }); await tx.appointment.update({ where: { id: 2 }, data: { status: "CONFIRMED" } }); }` },
  { name: "N19 spread data without the lock", rule: "W1", src: `export async function f(tx: Tx, data: any) { await tx.appointment.update({ where: { id: 1 }, data: { ...data } }); }` },
  { name: "N20 a write method taken as a value", rule: "W3", src: `export async function f(tx: Tx) { const u = tx.appointment.update; await u({ where: { id: 1 }, data: { startsAt: new Date() } }); }` },
  { name: "N21 dynamic model access", rule: "W3", src: `export async function f(tx: Tx, k: "appointment" | "customer") { await (tx[k] as any).update({ where: { id: 1 }, data: { startsAt: new Date() } }); }` },
  { name: "N22 the canonical lock hollowed out", rule: "W1", canon: CANON_HOLLOW, approved: { "lib/w.ts::f::appointment.update": 1 }, src: `export async function f(tx: Tx) { await lockBusinessAppointments(tx, 1); await tx.appointment.update({ where: { id: 1 }, data: { startsAt: new Date() } }); }` },
  { name: "N23 an approved entry with no writer left", rule: "W2", approved: { "lib/w.ts::gone::appointment.update": 1 }, src: `export const nothing = 1;` },
  { name: "N24 untyped client, write by shape", rule: "W1", src: `export async function f(db: any) { await db.appointment.update({ where: { id: 1 }, data: { startsAt: new Date() } }); }` },
  // must PASS
  { name: "P1 a write inside an ownerWrite callback", approved: { "lib/w.ts::make::appointment.create": 1 }, src: `export async function make() { return ownerWrite(1, async ({ tx }) => tx.appointment.create({ data: { startsAt: new Date(), endsAt: new Date() } })); }` },
  { name: "P2 an awaited lock first, then the write", approved: { "lib/w.ts::submit>attempt::appointment.create": 1 }, src: `export async function submit(id: number) { const attempt = () => tenantTx(id, async (tx) => { await lockBusinessAppointments(tx, id); for (const x of [1]) { await tx.appointment.create({ data: { startsAt: new Date(), endsAt: new Date(), status: "CONFIRMED" } }); } }); return attempt(); }` },
  { name: "P3 the lock imported under another name", head: `import { tenantTx, type Tx } from "../prisma-fake";\nimport { lockBusinessAppointments as lk } from "./services/appointment/appointment-request";\n`, approved: { "lib/w.ts::f::appointment.update": 1 }, src: `export async function f(tx: Tx) { await lk(tx, 1); await tx.appointment.update({ where: { id: 1 }, data: { startsAt: new Date() } }); }` },
  { name: "P4 a primitive whose every caller is locked, two levels", approved: { "lib/w.ts::prim::appointment.update": 1 }, src: `async function prim(tx: Tx) { await tx.appointment.update({ where: { id: 1 }, data: { status: "CANCELED" } }); }\nexport async function mid(tx: Tx) { await prim(tx); }\nexport async function top(id: number) { return tenantTx(id, async (tx) => { await lockBusinessAppointments(tx, id); await mid(tx); }); }\nexport async function other() { return ownerWrite(1, async ({ tx }) => { await prim(tx); }); }` },
  { name: "P5 an untimed create needs no lock", src: `export async function f(tx: Tx) { await tx.appointment.create({ data: { businessId: 1, status: "PROPOSED", startsAt: null, title: "x" } }); await tx.appointment.create({ data: { businessId: 1, status: "PROPOSED" } }); }` },
  { name: "P6 non-time updates need no lock", src: `export async function f(tx: Tx) { await tx.appointment.update({ where: { id: 1 }, data: { customerId: 2, version: { increment: 1 } } }); await tx.appointment.updateMany({ where: { businessId: 1 }, data: { title: null, notes: null } }); }` },
  { name: "P7 reads, deletes, other tables' raw SQL, a result's .appointment", src: `export async function f(tx: Tx, r: { appointment: { id: number } }) { await tx.appointment.findMany({}); await tx.appointment.count({}); await tx.appointment.deleteMany({}); await tx.$executeRaw\`INSERT INTO "AppointmentEvent" ("x") VALUES (1)\`; const s = "SELECT * FROM \\"Appointment\\""; return r.appointment.id + s.length; }` },
];

function selfTest() {
  const root = path.resolve("/__appt_guard_selftest__");
  const options = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es2022.d.ts"], types: [], strict: false, noEmit: true, skipLibCheck: true,
  };
  const defaultHost = ts.createCompilerHost(options);
  const libCache = new Map();
  let failed = 0;
  for (const c of CASES) {
    const vfs = new Map([
      [path.join(root, "prisma-fake.ts"), FAKE_PRISMA],
      [path.join(root, CANONICAL_FILE), c.canon ?? CANON_OK],
      [path.join(root, W), (c.head ?? HEAD) + c.src],
    ]);
    const norm = (f) => path.resolve(f);
    const inVfsDir = (d) => { const p = norm(d) + path.sep; return [...vfs.keys()].some((k) => k.startsWith(p)); };
    const host = {
      ...defaultHost,
      fileExists: (f) => vfs.has(norm(f)) || (!norm(f).startsWith(root) && defaultHost.fileExists(f)),
      directoryExists: (d) => inVfsDir(d) || (!norm(d).startsWith(root) && (defaultHost.directoryExists?.(d) ?? true)),
      readFile: (f) => (vfs.has(norm(f)) ? vfs.get(norm(f)) : defaultHost.readFile(f)),
      getSourceFile: (f, lang) => {
        if (vfs.has(norm(f))) return ts.createSourceFile(f, vfs.get(norm(f)), lang, true);
        if (!libCache.has(f)) libCache.set(f, defaultHost.getSourceFile(f, lang));
        return libCache.get(f);
      },
      writeFile: () => {},
    };
    const program = ts.createProgram([path.join(root, W), path.join(root, CANONICAL_FILE)], options, host);
    const { violations } = analyze(program, root, [path.join(root, W), path.join(root, CANONICAL_FILE)], c.approved ?? {});
    const expectFail = !!c.rule;
    const ok = expectFail ? violations.some((v) => v.rule === c.rule) : violations.length === 0;
    if (!ok) failed++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${c.name}${ok ? "" : ` — got ${JSON.stringify(violations.map((v) => `${v.rule} ${v.msg}`))}`}`);
  }
  console.log(`appointment-write-guard self-test: ${CASES.length - failed} passed, ${failed} failed`);
  return failed === 0;
}

const argv = process.argv.slice(2);
if (argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);
process.exit(check(path.resolve(argv.find((a) => !a.startsWith("--")) ?? ".")) ? 0 : 1);
