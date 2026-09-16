/**
 * ERASURE CONTRACT — the mutation driver for the negative proofs.
 *
 * Usage:  npx tsx scripts/ci/erasure-mutate.ts <M1|M2|M3|M4|M5|M6|D1|D2|D3|D4|N2|N3|N4|N5>
 *
 * WHY THIS REPLACED THE REGEXES
 *
 * Each proof used to be a `perl -0pi -e 's/…exact text…/…/'` in the workflow, anchored
 * on how a line happened to be written. That broke three times, and every time for the
 * same reason: a change to the code the proof guards reformatted the line the proof
 * matched. The failure mode is the dangerous one — `MUTATION NOT APPLIED`, a red build
 * that says nothing about the contract, and the temptation each time is to move the
 * anchor and move on.
 *
 * So the anchors are gone. Every mutation below is expressed against the TypeScript
 * AST: "the `data` object of the `notification.updateMany` call", not "the characters
 * `data: { title: "", summary: null },`". Reflowing that call across five lines,
 * reordering its properties, or changing its indentation cannot stop the mutation
 * applying, because none of those changes what the syntax tree says.
 *
 * The one mutation NOT here is N1, which appends a whole new model to
 * `prisma/schema.prisma`. An append depends on nothing about the existing file, so it is
 * already format-independent and stays in the workflow as two lines of `printf`.
 *
 * This script only ever MUTATES. Restoring is the caller's job — the workflow copies the
 * file first and moves it back afterwards, then `git diff --exit-code` proves the tree
 * came back byte-identical.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = path.resolve(__dirname, "../..");
const MANIFEST = path.join(ROOT, "lib/services/account/account-erasure-manifest.ts");
const ADAPTER = path.join(ROOT, "lib/services/account/account-deletion.prisma-store.ts");
const DISPOSITIONS = path.join(ROOT, "lib/services/account/erasure-dispositions.ts");
// Relocated out of lib/ by PR #434, together with the debt registry. This follows
// the canonical path; no compatibility copy is left behind at the old one.
const COVERAGE = path.join(ROOT, "scripts/ci/erasure/erasure-model-coverage.ts");

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    path.basename(file),
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
}

/** Every object literal in the file, in source order. */
function objectLiterals(src: ts.SourceFile): ts.ObjectLiteralExpression[] {
  const out: ts.ObjectLiteralExpression[] = [];
  const walk = (n: ts.Node) => {
    if (ts.isObjectLiteralExpression(n)) out.push(n);
    ts.forEachChild(n, walk);
  };
  walk(src);
  return out;
}

function propertyNamed(obj: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | null {
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    const n = p.name;
    const text = ts.isIdentifier(n) || ts.isStringLiteral(n) ? n.text : null;
    if (text === name) return p;
  }
  return null;
}

/** The object that a named property holds, e.g. the `fields` of a manifest entry. */
function objectAt(obj: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralExpression {
  const p = propertyNamed(obj, name);
  if (!p || !ts.isObjectLiteralExpression(p.initializer)) {
    throw new Error(`property "${name}" is not an object literal`);
  }
  return p.initializer;
}

/** A manifest entry located by its `model` value rather than by its text. */
function manifestEntry(src: ts.SourceFile, model: string): ts.ObjectLiteralExpression {
  for (const obj of objectLiterals(src)) {
    const m = propertyNamed(obj, "model");
    if (m && ts.isStringLiteral(m.initializer) && m.initializer.text === model) return obj;
  }
  throw new Error(`no manifest entry for model "${model}"`);
}

/** The `data` object of a Prisma write, located by delegate and method. */
function prismaData(src: ts.SourceFile, delegate: string, method: string): ts.ObjectLiteralExpression {
  let found: ts.ObjectLiteralExpression | null = null;
  const walk = (n: ts.Node) => {
    if (
      !found &&
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === method &&
      ts.isPropertyAccessExpression(n.expression.expression) &&
      n.expression.expression.name.text === delegate
    ) {
      const arg = n.arguments[0];
      if (arg && ts.isObjectLiteralExpression(arg)) found = objectAt(arg, "data");
    }
    ts.forEachChild(n, walk);
  };
  walk(src);
  if (!found) throw new Error(`no ${delegate}.${method}() with an inline data object`);
  return found;
}

/** The whole statement that performs a Prisma call, located by delegate and method.
 *  Used by the row-deletion proofs, which have to remove or replace an entire
 *  `deleteMany` rather than edit a `data` object — `deleteMany` has no `data`. */
function prismaStatement(src: ts.SourceFile, delegate: string, method: string): ts.Statement {
  let found: ts.Statement | null = null;
  const walk = (n: ts.Node) => {
    if (
      !found &&
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === method &&
      ts.isPropertyAccessExpression(n.expression.expression) &&
      n.expression.expression.name.text === delegate
    ) {
      let up: ts.Node = n;
      while (up.parent && !ts.isStatement(up)) up = up.parent;
      if (ts.isStatement(up)) found = up;
    }
    ts.forEachChild(n, walk);
  };
  walk(src);
  if (!found) throw new Error(`no statement containing ${delegate}.${method}()`);
  return found;
}

/** A top-level `const NAME = [ … ]` array, located by declaration name. The
 *  declaration may be wrapped in `as const`, which is an assertion expression. */
function namedArray(src: ts.SourceFile, name: string): ts.ArrayLiteralExpression {
  let found: ts.ArrayLiteralExpression | null = null;
  const walk = (n: ts.Node) => {
    if (!found && ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) {
      let init: ts.Node = n.initializer;
      while (ts.isAsExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression;
      if (ts.isArrayLiteralExpression(init)) found = init;
    }
    ts.forEachChild(n, walk);
  };
  walk(src);
  if (!found) throw new Error(`no array literal declared as "${name}"`);
  return found;
}

/** Replace a node's text in place. */
function replaceNode(source: string, src: ts.SourceFile, node: ts.Node, text: string): string {
  return source.slice(0, node.getStart(src)) + text + source.slice(node.getEnd());
}

/** Remove a whole statement, and the newline it sat on. */
function removeStatement(source: string, src: ts.SourceFile, stmt: ts.Statement): string {
  let end = stmt.getEnd();
  while (end < source.length && (source[end] === "\r" || source[end] === "\n")) end += 1;
  return source.slice(0, stmt.getStart(src)) + source.slice(end);
}

/** A top-level `const NAME = { … }` object, located by declaration name. */
function namedObject(src: ts.SourceFile, name: string): ts.ObjectLiteralExpression {
  let found: ts.ObjectLiteralExpression | null = null;
  const walk = (n: ts.Node) => {
    if (
      !found &&
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === name &&
      n.initializer &&
      ts.isObjectLiteralExpression(n.initializer)
    ) {
      found = n.initializer;
    }
    ts.forEachChild(n, walk);
  };
  walk(src);
  if (!found) throw new Error(`no object literal declared as "${name}"`);
  return found;
}

/** Splice text in immediately after the opening brace or bracket. Arrays are accepted
 *  as well as objects because `REVOKE_INTEGRATIONS` is an array and D3 has to add a
 *  whole entry to it, not a property to one. */
function insertInto(
  source: string,
  node: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
  text: string
): string {
  const at = node.getStart() + 1;
  return `${source.slice(0, at)} ${text}${source.slice(at)}`;
}

/** Remove a property, and the comma that follows it if there is one. */
function removeProperty(source: string, src: ts.SourceFile, prop: ts.Node): string {
  let end = prop.getEnd();
  while (end < source.length && /\s/.test(source[end])) end += 1;
  if (source[end] === ",") end += 1;
  return source.slice(0, prop.getStart(src)) + source.slice(end);
}

type Mutation = { file: string; apply: (src: ts.SourceFile, text: string) => string; what: string };

const MUTATIONS: Record<string, Mutation> = {
  // The manifest names a column that exists on no model at all.
  M1: {
    file: MANIFEST,
    what: "add customer.fakeField to ANONYMIZE_MODELS",
    apply: (src, text) => insertInto(text, objectAt(manifestEntry(src, "customer"), "fields"), `fakeField: "null",`),
  },
  // Right column name, wrong model: `email` is real on User, Customer and Lead;
  // BusinessProfile has `billingEmail`. A global name search would accept this.
  M2: {
    file: MANIFEST,
    what: "add businessProfile.email to ANONYMIZE_MODELS",
    apply: (src, text) => insertInto(text, objectAt(manifestEntry(src, "businessProfile"), "fields"), `email: "null",`),
  },
  // The manifest keeps its promise; the adapter stops keeping it.
  M3: {
    file: ADAPTER,
    what: "drop `phone` from the customer anonymisation",
    apply: (src, text) => {
      const data = prismaData(src, "customer", "updateMany");
      const p = propertyNamed(data, "phone");
      if (!p) throw new Error("customer data has no `phone` property");
      return removeProperty(text, src, p);
    },
  },
  // The adapter erases something no contract declares. `href` is dispositioned
  // RETAIN_BY_DESIGN, so writing it is undeclared erasure.
  M4: {
    file: ADAPTER,
    what: "write Notification.href in the erasure",
    apply: (src, text) => insertInto(text, prismaData(src, "notification", "updateMany"), `href: "",`),
  },
  // A relation offered where a column is required.
  M5: {
    file: MANIFEST,
    what: "add notification.business (a relation) to ANONYMIZE_MODELS",
    apply: (src, text) => insertInto(text, objectAt(manifestEntry(src, "notification"), "fields"), `business: "null",`),
  },
  // A covered column loses its disposition — the same shape as adding a column
  // tomorrow and forgetting to classify it.
  M6: {
    file: DISPOSITIONS,
    what: "remove the Customer.isActive disposition",
    apply: (src, text) => {
      const customer = objectAt(namedObject(src, "DISPOSITIONS"), "Customer");
      const p = propertyNamed(customer, "isActive");
      if (!p) throw new Error("Customer has no `isActive` disposition");
      return removeProperty(text, src, p);
    },
  },
  // ── D1…D4: the DELETE ROW contract ──────────────────────────────────────
  //
  // `deleteRow: true` is a STRONGER claim than `clear`, and a stronger claim needs
  // its own proofs. Without these four, the new shape would be a comment: the guard
  // would read it and nothing would establish that reading it changes any outcome.

  // The adapter stops deleting a model the manifest says is deleted outright.
  D1: {
    file: ADAPTER,
    what: "remove the OAuthToken row deletion from the adapter",
    apply: (src, text) => removeStatement(text, src, prismaStatement(src, "oAuthToken", "deleteMany")),
  },
  // The one that earns the shape. The row deletion is swapped for a column clear
  // that blanks the very column the old manifest named. Under the old contract this
  // was indistinguishable from a delete; it must not be now, because the row —
  // businessId, label, source, lastUsedAt — survives.
  D2: {
    file: ADAPTER,
    what: "downgrade the POSApiKey row deletion to a column clear",
    apply: (src, text) =>
      replaceNode(
        text,
        src,
        prismaStatement(src, "pOSApiKey", "deleteMany"),
        `await tx.pOSApiKey.updateMany({ where: { businessId }, data: { keyHash: "" } });`
      ),
  },
  // A row-deletion declaration for a delegate that does not exist. The C1 path must
  // cover the new shape too, or a typo in a `deleteRow` entry would be inert exactly
  // the way `oauthToken` was inert for months.
  D3: {
    file: MANIFEST,
    what: "declare deleteRow for a delegate that does not exist",
    apply: (src, text) =>
      insertInto(text, namedArray(src, "REVOKE_INTEGRATIONS"), `{ model: "noSuchDelegate", deleteRow: true },`),
  },
  // The regression lock. Rewriting a `deleteRow` entry back into the `clear` shape
  // is precisely the cheaper fix this increment rejected, and the guard has to refuse
  // it rather than merely prefer the other one.
  D4: {
    file: MANIFEST,
    what: "downgrade the OAuthToken deleteRow entry back to a column clear",
    apply: (src, text) =>
      replaceNode(
        text,
        src,
        manifestEntry(src, "oAuthToken"),
        `{ model: "oAuthToken", clear: ["accessTokenEncrypted", "refreshTokenEncrypted"], set: {} }`
      ),
  },
  // A disposition for a model that is not in the schema.
  N2: {
    file: COVERAGE,
    what: "classify a model that does not exist",
    apply: (src, text) =>
      insertInto(text, namedObject(src, "OPERATIONAL"), `ModelThatDoesNotExist: operational("stale entry"),`),
  },
  // One model in two categories at once.
  N3: {
    file: COVERAGE,
    what: "classify Supplier a second time, contradicting its UNMANAGED entry",
    apply: (src, text) =>
      insertInto(text, namedObject(src, "OPERATIONAL"), `Supplier: operational("contradicts the UNMANAGED entry"),`),
  },
  // ERASURE_MANAGED claimed for a model the adapter never erases.
  N4: {
    file: COVERAGE,
    what: "claim ERASURE_MANAGED for Usage",
    apply: (src, text) => {
      const op = namedObject(src, "OPERATIONAL");
      const p = propertyNamed(op, "Usage");
      if (!p) throw new Error("OPERATIONAL has no `Usage` entry");
      const stripped = removeProperty(text, src, p);
      // Re-parse is unnecessary: insert at the same brace, which removal did not move.
      const at = op.getStart() + 1;
      return `${stripped.slice(0, at)} Usage: { disposition: "ERASURE_MANAGED" },${stripped.slice(at)}`;
    },
  },
  // An existing model loses its classification entirely.
  N5: {
    file: COVERAGE,
    what: "remove the Usage classification",
    apply: (src, text) => {
      const op = namedObject(src, "OPERATIONAL");
      const p = propertyNamed(op, "Usage");
      if (!p) throw new Error("OPERATIONAL has no `Usage` entry");
      return removeProperty(text, src, p);
    },
  },
};

/**
 * `--reflow <id>` rewrites the TARGET of a mutation across several lines without
 * changing a single property. It exists so the format-robustness proof cannot be
 * accused of testing a reflow that was hand-written to still match: the new text is
 * generated FROM the syntax tree, so it is a formatting change by construction.
 *
 * Reflowing and then mutating is the exact sequence that silently disabled M4 and M5
 * when they were text anchors.
 */
const REFLOW: Record<string, { file: string; target: (src: ts.SourceFile) => ts.ObjectLiteralExpression }> = {
  M4: { file: ADAPTER, target: (src) => prismaData(src, "notification", "updateMany") },
  M5: { file: MANIFEST, target: (src) => objectAt(manifestEntry(src, "notification"), "fields") },
};

if (process.argv[2] === "--reflow") {
  const id = process.argv[3];
  const r = REFLOW[id];
  if (!r) {
    console.error(`no reflow defined for "${id}"`);
    process.exit(2);
  }
  const text = fs.readFileSync(r.file, "utf8");
  const src = parse(r.file);
  const obj = r.target(src);
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const line = ts.getLineAndCharacterOfPosition(src, obj.getStart());
  const indent = " ".repeat(line.character);
  const body = obj.properties.map((p) => `${indent}  ${p.getText(src)},`).join(nl);
  const rendered = `{${nl}${body}${nl}${indent}}`;
  const out = text.slice(0, obj.getStart()) + rendered + text.slice(obj.getEnd());
  if (out === text) {
    console.error(`${id}: REFLOW CHANGED NOTHING`);
    process.exit(1);
  }
  fs.writeFileSync(r.file, out);
  console.log(`${id} target reflowed across ${obj.properties.length + 2} lines (formatting only)`);
  process.exit(0);
}

const which = process.argv[2];
const m = MUTATIONS[which];
if (!m) {
  console.error(`unknown mutation "${which}" — expected one of ${Object.keys(MUTATIONS).join(", ")}`);
  process.exit(2);
}

const before = fs.readFileSync(m.file, "utf8");
const after = m.apply(parse(m.file), before);
if (after === before) {
  console.error(`${which}: MUTATION NOT APPLIED — the file is unchanged`);
  process.exit(1);
}
fs.writeFileSync(m.file, after);
console.log(`${which} applied to ${path.basename(m.file)} — ${m.what}`);
