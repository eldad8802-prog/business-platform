/**
 * ERASURE CONTRACT — the analyzer that turns the manifest from a description into
 * something a build can check.
 *
 * WHY THIS EXISTS
 *
 * `account-erasure-manifest.ts` declares what an account deletion erases. The Prisma
 * adapter separately, and by hand, writes the statements that do the erasing. Nothing
 * connected the two. `assertManifestSafe()` compares the manifest's model lists to each
 * other — it never looks at the schema and never looks at the adapter — so the manifest
 * could name a column that does not exist, or promise an erasure the adapter never
 * performs, and every test in the repository would still pass.
 *
 * That is not hypothetical. The manifest declares `lead.email` is nulled. The adapter
 * nulls `customerName` and `phone`, and not `email`. Both statements shipped, green.
 *
 * This module closes the loop by deriving three facts and comparing them:
 *
 *     prisma/schema.prisma   → which models and scalar columns actually exist
 *     account-erasure-manifest.ts → what we PROMISE happens to them
 *     account-deletion.prisma-store.ts → what the code actually WRITES
 *
 * It is deliberately an analyzer and not an executor. See the design note in
 * `erasure-contract.verify.test.ts` for why the manifest validates the adapter rather
 * than driving it.
 *
 * ON PARSING
 *
 * The adapter is read with the TypeScript compiler's own AST, not with regular
 * expressions. A substring parser that cannot understand an expression has no way to
 * tell "this field is not written" from "I did not understand this line", and would
 * report the second as the first — a PASS built on a parse failure. Everything this
 * module cannot analyse is reported as UNANALYZABLE and fails the guard, so the only
 * way to a green result is a file the analyzer genuinely understood.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

// ─────────────────────────────────────────────────────────────────────────────
// Prisma schema
// ─────────────────────────────────────────────────────────────────────────────

export type SchemaField = {
  name: string;
  type: string;
  isList: boolean;
  isOptional: boolean;
  /** A DB column. Relation fields are NOT columns, whatever they look like. */
  isScalar: boolean;
  /** `@map("...")` — the physical column name when it differs. */
  dbName: string | null;
};

export type SchemaModel = {
  name: string;
  /** `@@map("...")` — the physical table name when it differs. */
  dbName: string | null;
  fields: SchemaField[];
  /** The Prisma Client property for this model: `POSApiKey` → `pOSApiKey`. */
  delegate: string;
};

/** Prisma Client uncapitalizes the FIRST character only, so `POSApiKey` becomes
 *  `pOSApiKey` and not `posApiKey`. Getting this wrong is itself a class of drift. */
export function delegateName(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

const SCALAR_TYPES = new Set([
  "String", "Int", "Float", "Boolean", "DateTime", "Json", "Decimal", "BigInt", "Bytes",
]);

export function parsePrismaSchema(schemaPath: string): Map<string, SchemaModel> {
  const src = fs.readFileSync(schemaPath, "utf8");
  const lines = src.split(/\r?\n/);

  const enums = new Set<string>();
  for (const line of lines) {
    const m = /^enum\s+(\w+)\s*\{/.exec(line.trim());
    if (m) enums.add(m[1]);
  }

  // Pass 1 collects model names, because deciding whether a field is a relation
  // requires knowing every model name — including ones declared further down.
  const modelNames = new Set<string>();
  for (const line of lines) {
    const m = /^model\s+(\w+)\s*\{/.exec(line.trim());
    if (m) modelNames.add(m[1]);
  }

  const models = new Map<string, SchemaModel>();
  let current: SchemaModel | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    const open = /^model\s+(\w+)\s*\{/.exec(line);
    if (open) {
      current = { name: open[1], dbName: null, fields: [], delegate: delegateName(open[1]) };
      continue;
    }
    if (!current) continue;
    if (line === "}") {
      models.set(current.name, current);
      current = null;
      continue;
    }
    if (!line || line.startsWith("//")) continue;

    const mapModel = /^@@map\("([^"]+)"\)/.exec(line);
    if (mapModel) {
      current.dbName = mapModel[1];
      continue;
    }
    if (line.startsWith("@@")) continue;

    const field = /^(\w+)\s+(\w+)(\[\])?(\?)?(.*)$/.exec(line);
    if (!field) continue;
    const [, name, type, list, optional, rest] = field;
    const mapField = /@map\("([^"]+)"\)/.exec(rest ?? "");
    // A relation is any field whose type is another model, or that carries
    // `@relation`. It is not a column, so it can never satisfy a field-level
    // erasure requirement — that distinction is the whole of check C5.
    const isRelation = modelNames.has(type) || /@relation\b/.test(rest ?? "");
    current.fields.push({
      name,
      type,
      isList: !!list,
      isOptional: !!optional,
      isScalar: !isRelation && (SCALAR_TYPES.has(type) || enums.has(type)),
      dbName: mapField ? mapField[1] : null,
    });
  }

  return models;
}

// ─────────────────────────────────────────────────────────────────────────────
// The adapter, read as an AST
// ─────────────────────────────────────────────────────────────────────────────

/** How a written value disposes of what was there. Derived from the literal in the
 *  `data` object, which is as much as a static read can honestly claim. */
export type WriteKind = "CLEAR" | "OVERWRITE" | "UNKNOWN";

export type AdapterWrite = {
  /** Prisma Client delegate as written in the source, e.g. `pOSApiKey`. */
  delegate: string;
  field: string;
  kind: WriteKind;
  line: number;
};

export type AdapterDelete = { delegate: string; line: number };

export type AdapterFacts = {
  writes: AdapterWrite[];
  deletes: AdapterDelete[];
  /** Call sites the analyzer could not read. Any entry here fails the guard. */
  unanalyzable: { detail: string; line: number }[];
};

const WRITE_METHODS = new Set(["update", "updateMany", "updateManyAndReturn", "upsert"]);
const DELETE_METHODS = new Set(["delete", "deleteMany"]);
const CREATE_METHODS = new Set(["create", "createMany", "createManyAndReturn"]);

/** Receivers that are a Prisma client in this codebase. An unrecognised receiver is
 *  reported rather than ignored, so a renamed client cannot silently hide writes. */
const CLIENT_RECEIVERS = new Set(["tx", "prisma", "db", "client"]);

export function parseAdapter(adapterPath: string): AdapterFacts {
  const source = ts.createSourceFile(
    path.basename(adapterPath),
    fs.readFileSync(adapterPath, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );

  const facts: AdapterFacts = { writes: [], deletes: [], unanalyzable: [] };
  const lineOf = (node: ts.Node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  const valueKind = (init: ts.Expression): WriteKind => {
    if (init.kind === ts.SyntaxKind.NullKeyword) return "CLEAR";
    if (ts.isStringLiteral(init)) return init.text === "" ? "CLEAR" : "OVERWRITE";
    // `Prisma.DbNull` empties a nullable Json column; a bare `null` there would
    // write the JSON value null instead, which is not the same thing.
    if (ts.isPropertyAccessExpression(init) && init.name.text === "DbNull") return "CLEAR";
    if (ts.isTemplateExpression(init) || ts.isNoSubstitutionTemplateLiteral(init)) return "OVERWRITE";
    if (init.kind === ts.SyntaxKind.FalseKeyword || init.kind === ts.SyntaxKind.TrueKeyword) {
      return "OVERWRITE";
    }
    if (ts.isNumericLiteral(init)) return "OVERWRITE";
    return "UNKNOWN";
  };

  const readDataObject = (obj: ts.ObjectLiteralExpression, delegate: string) => {
    for (const prop of obj.properties) {
      if (ts.isPropertyAssignment(prop) && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) {
        facts.writes.push({
          delegate,
          field: prop.name.text,
          kind: valueKind(prop.initializer),
          line: lineOf(prop),
        });
        continue;
      }
      if (ts.isShorthandPropertyAssignment(prop)) {
        facts.writes.push({ delegate, field: prop.name.text, kind: "UNKNOWN", line: lineOf(prop) });
        continue;
      }
      // A spread hides an unknown set of fields behind one token. Refusing to guess
      // is the point: this is reported, not skipped.
      facts.unanalyzable.push({
        detail: `${delegate}: a \`data\` object uses a spread or computed key the analyzer cannot expand`,
        line: lineOf(prop),
      });
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const target = node.expression.expression;
      const isPrismaCall =
        ts.isPropertyAccessExpression(target) &&
        ts.isIdentifier(target.expression) &&
        CLIENT_RECEIVERS.has(target.expression.text);

      if (isPrismaCall) {
        const delegate = (target as ts.PropertyAccessExpression).name.text;
        const arg = node.arguments[0];

        if (DELETE_METHODS.has(method)) {
          facts.deletes.push({ delegate, line: lineOf(node) });
        } else if (WRITE_METHODS.has(method) || CREATE_METHODS.has(method)) {
          if (!arg || !ts.isObjectLiteralExpression(arg)) {
            facts.unanalyzable.push({
              detail: `${delegate}.${method}() is not called with an inline object literal`,
              line: lineOf(node),
            });
          } else {
            const dataProps = arg.properties.filter(
              (p): p is ts.PropertyAssignment =>
                ts.isPropertyAssignment(p) &&
                (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
                (p.name.text === "data" || p.name.text === "create" || p.name.text === "update")
            );
            if (dataProps.length === 0) {
              facts.unanalyzable.push({
                detail: `${delegate}.${method}() has no readable \`data\` object`,
                line: lineOf(node),
              });
            }
            for (const dp of dataProps) {
              if (ts.isObjectLiteralExpression(dp.initializer)) {
                readDataObject(dp.initializer, delegate);
              } else {
                facts.unanalyzable.push({
                  detail: `${delegate}.${method}(): \`${dp.name.getText(source)}\` is not an inline object literal`,
                  line: lineOf(dp),
                });
              }
            }
          }
        }
      } else if (
        (WRITE_METHODS.has(method) || DELETE_METHODS.has(method)) &&
        ts.isPropertyAccessExpression(target) &&
        !ts.isIdentifier(target.expression)
      ) {
        // A Prisma-shaped call through something that is not a plain identifier —
        // reported rather than dropped, because dropping it is how coverage rots.
        facts.unanalyzable.push({
          detail: `a ${method}() call reached through an unrecognised receiver`,
          line: lineOf(node),
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return facts;
}
