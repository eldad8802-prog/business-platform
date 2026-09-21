/**
 * ERASURE CONTRACT — the mutation driver for the negative proofs.
 *
 * Usage:  npx tsx scripts/ci/erasure-mutate.ts
 *           <M1|M2|M3|M4|M5|M6|D1|D2|D3|D4|N2|N3|N4|N5|R1|R2|R3|R4|E1|E2|E3|E3B|E4|E4P|E5|E5B|E6>
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
// C12-R. The reclassification proofs reach outside the erasure module, because the
// claim they guard is about the whole application: "no code here can write a person".
// A proof of that has to be able to add a writer where a writer would really go.
const SCHEMA = path.join(ROOT, "prisma/schema.prisma");
const BOT_KNOWLEDGE_ROUTE = path.join(ROOT, "app/api/business/bot/knowledge/route.ts");
const DEALS_LIST_ROUTE = path.join(ROOT, "app/api/deals/route.ts");
const INVENTORY_SERVICE = path.join(ROOT, "lib/services/inventory/inventory.service.ts");
// C12-E1. Laboratory fidelity is a RUNTIME property — the lab must reproduce
// Production's RLS and privileges — so E4 and E4P mutate the lab and require the AD-2A
// battery to fail. E3 is deliberately NOT runtime: under FORCE RLS a widened `where`
// clears exactly the same rows, so no battery can see it; C18 holds the shape instead.
const AD2A_CONTRACT = path.join(ROOT, ".ad2a/production-contract.mjs");
const AD2A_BATTERY = path.join(ROOT, ".ad2a/battery.mjs");

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

/** Splice a statement in immediately after an existing one, at its indentation. */
function insertAfterStatement(source: string, src: ts.SourceFile, stmt: ts.Statement, text: string): string {
  const col = ts.getLineAndCharacterOfPosition(src, stmt.getStart(src)).character;
  const nl = source.includes("\r\n") ? "\r\n" : "\n";
  const indent = " ".repeat(col);
  const at = stmt.getEnd();
  return source.slice(0, at) + nl + indent + text + source.slice(at);
}

/** The first argument object of a Prisma call, located by delegate and method. */
function prismaCallArgument(
  src: ts.SourceFile,
  delegate: string,
  method: string
): ts.ObjectLiteralExpression {
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
      if (arg && ts.isObjectLiteralExpression(arg)) found = arg;
    }
    ts.forEachChild(n, walk);
  };
  walk(src);
  if (!found) throw new Error(`no ${delegate}.${method}() with an inline argument object`);
  return found;
}

/** An entry of the AD-2A production contract, located by its `table` value. */
function contractEntry(src: ts.SourceFile, table: string): ts.ObjectLiteralExpression {
  for (const obj of objectLiterals(src)) {
    const t = propertyNamed(obj, "table");
    if (t && ts.isStringLiteral(t.initializer) && t.initializer.text === table) return obj;
  }
  throw new Error(`no contract entry for table "${table}"`);
}

/** Remove one element of an array literal, and the comma that follows it. */
function removeArrayElement(source: string, src: ts.SourceFile, node: ts.Node): string {
  let end = node.getEnd();
  while (end < source.length && /\s/.test(source[end])) end += 1;
  if (source[end] === ",") end += 1;
  return source.slice(0, node.getStart(src)) + source.slice(end);
}

/** Insert a field line into a Prisma model block, right after its opening line.
 *  Prisma has no TypeScript AST to anchor on; a model declaration is structure
 *  rather than formatting, so this is the same class of anchor as N1's append. */
function insertPrismaField(source: string, model: string, field: string): string {
  const open = new RegExp("^model[ ]+" + model + "[ ]*\\{[ ]*$", "m");
  const m = open.exec(source);
  if (!m) throw new Error(`no model block for "${model}"`);
  const at = m.index + m[0].length;
  const nl = source.includes("\r\n") ? "\r\n" : "\n";
  return source.slice(0, at) + nl + "  " + field + source.slice(at);
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
  // ── R1…R4: the reclassification contract ────────────────────────────────
  //
  // Four models moved out of UNMANAGED_PERSONAL_DATA because nothing in the
  // product can put a person in them. Each of those four claims rests on a fact
  // about the CODE, not about the schema, and a fact about code expires quietly.
  // These four prove the claims are held rather than recorded.

  // BusinessService is non-personal because the product has no writer for it at
  // all. A writer appearing anywhere is the whole risk, so the proof adds one
  // where one would plausibly go: the route that already counts services.
  R1: {
    file: BOT_KNOWLEDGE_ROUTE,
    what: "give BusinessService an application writer",
    apply: (src, text) =>
      insertAfterStatement(
        text,
        src,
        prismaStatement(src, "businessService", "count"),
        `await db.businessService.update({ where: { id: 1 }, data: { name: "x" } });`
      ),
  },
  // CollaborationDeal is non-personal because its text comes from a fixed rule
  // table and the only route touching it writes `status`. A NEW endpoint writing
  // request text is the realistic way that stops being true.
  R2: {
    file: DEALS_LIST_ROUTE,
    what: "write CollaborationDeal text from a new, undeclared route",
    apply: (src, text) =>
      insertAfterStatement(
        text,
        src,
        prismaStatement(src, "collaborationDeal", "findMany"),
        `await prisma.collaborationDeal.updateMany({ where: { businessId: 1 }, data: { title: "x" } });`
      ),
  },
  // InventoryAlert.message is non-personal because it interpolates product
  // identity and nothing else. This repoints it at a counterparty's free text
  // INSIDE an already-approved file, so only the value rule can catch it.
  R3: {
    file: INVENTORY_SERVICE,
    what: "source InventoryAlert.message from counterparty free text",
    apply: (src, text) => {
      const data = prismaData(src, "inventoryAlert", "create");
      const p = propertyNamed(data, "message");
      if (!p) throw new Error("the inventoryAlert.create data has no `message` property");
      return replaceNode(text, src, p.initializer, "`${customer.notes}`");
    },
  },
  // SupplierPurchaseDraftLine is non-personal because `rawName` is its only text
  // column and it holds a product name. A new text column must not inherit that.
  R4: {
    file: SCHEMA,
    what: "add an unclassified text column to SupplierPurchaseDraftLine",
    apply: (_src, text) => insertPrismaField(text, "SupplierPurchaseDraftLine", "note String?"),
  },

  // ── E1…E5: the C12-E1 assumptions ───────────────────────────────────────
  //
  // Two notes are cleared; three provenance pointers and three product columns are
  // deliberately kept. Each of those is an assumption, and these are the ones that
  // would rot without saying so.

  // The contract promises the note is cleared; the adapter stops doing it.
  E1: {
    file: ADAPTER,
    what: "stop clearing ReceivingSession.note",
    apply: (src, text) => {
      const data = prismaData(src, "receivingSession", "updateMany");
      const p = propertyNamed(data, "note");
      if (!p) throw new Error("the receivingSession data has no `note` property");
      return removeProperty(text, src, p);
    },
  },
  // The same for the line, which also exercises the relation path: there is no
  // other way to reach that row.
  E2: {
    file: ADAPTER,
    what: "stop clearing PurchaseOrderLine.remainingDecisionNote",
    apply: (src, text) => {
      const data = prismaData(src, "purchaseOrderLine", "updateMany");
      const p = propertyNamed(data, "remainingDecisionNote");
      if (!p) throw new Error("the purchaseOrderLine data has no `remainingDecisionNote` property");
      return removeProperty(text, src, p);
    },
  },
  // STATIC (C18). The tenant filter itself. PurchaseOrderLine carries no businessId,
  // so the adapter reaches it through the PurchaseOrder relation. Under FORCE RLS a
  // widened filter clears exactly the same rows — the policy narrows it back — so the
  // battery CANNOT see this; it was tried, and it stays green. The shape is held by
  // the contract instead. E3 removes the filter; E3B keeps the relation and drops the
  // tenant from inside it, which reads as scoped and is not.
  E3: {
    file: ADAPTER,
    what: "widen the PurchaseOrderLine tenant filter to every tenant",
    apply: (src, text) => {
      const arg = prismaCallArgument(src, "purchaseOrderLine", "updateMany");
      const where = propertyNamed(arg, "where");
      if (!where) throw new Error("the purchaseOrderLine updateMany has no `where`");
      return replaceNode(text, src, where.initializer, "{}");
    },
  },
  E3B: {
    file: ADAPTER,
    what: "keep the PurchaseOrder relation but drop businessId from inside it",
    apply: (src, text) => {
      const arg = prismaCallArgument(src, "purchaseOrderLine", "updateMany");
      const where = propertyNamed(arg, "where");
      if (!where) throw new Error("the purchaseOrderLine updateMany has no `where`");
      return replaceNode(text, src, where.initializer, "{ purchaseOrder: {} }");
    },
  },
  // RUNTIME. Laboratory fidelity. A table the fixture does not model is a table the
  // lab leaves without row-level security, and an erasure proved against an
  // unprotected table is proved against a database Production does not have. That is
  // Defect B's shape, so the battery has to refuse to be reassuring without it. What
  // bites is E1-R1: under A's context, B's line named by id must stay invisible.
  E4: {
    file: AD2A_CONTRACT,
    what: "drop PurchaseOrderLine from the AD-2A production contract",
    apply: (src, text) => removeArrayElement(text, src, contractEntry(src, "PurchaseOrderLine")),
  },
  // RUNTIME. Privilege fidelity — the other gate. A `FOR ALL` policy governs DELETE
  // but does not grant it; the table privilege does, and Production's runtime holds
  // none on these three. A lab that granted it would be proving against a capability
  // the product does not have. What bites is E1-P, read from the grants artifact.
  E4P: {
    file: AD2A_BATTERY,
    what: "grant the lab runtime DELETE on the three C12-E1 tables instead of revoking it",
    apply: (src, text) => {
      let found: ts.TemplateExpression | null = null;
      const walk = (n: ts.Node) => {
        if (
          !found &&
          ts.isTemplateExpression(n) &&
          n.head.text.startsWith('REVOKE DELETE ON "ReceivingSession","PurchaseOrderLine","PurchaseOrder"')
        ) {
          found = n;
        }
        ts.forEachChild(n, walk);
      };
      walk(src);
      if (!found) throw new Error("no REVOKE DELETE statement for the C12-E1 tables");
      const node = found as ts.TemplateExpression;
      const next = node
        .getText(src)
        .replace("REVOKE DELETE ON", "GRANT DELETE ON")
        .replace(" FROM ", " TO ");
      return replaceNode(text, src, node, next);
    },
  },
  // The conditional retention. The provenance pointers are kept ONLY because the
  // User row they name is anonymised. Reclassifying that anonymisation away has to
  // make the contract red, rather than leaving three identifying pointers behind a
  // classification nobody rechecked.
  E5: {
    file: DISPOSITIONS,
    what: "reclassify User.email as retained, invalidating the pointer retention",
    apply: (src, text) => {
      const user = objectAt(namedObject(src, "DISPOSITIONS"), "User");
      const p = propertyNamed(user, "email");
      if (!p) throw new Error("User has no `email` disposition");
      return replaceNode(
        text,
        src,
        p.initializer,
        `{ disposition: "RETAIN_BY_DESIGN", purpose: "mutation", basis: "UNPROVEN" }`
      );
    },
  },
  // The other half of the same premise: the classification still says User.email is
  // destroyed, but the adapter has quietly stopped destroying it.
  E5B: {
    file: ADAPTER,
    what: "stop anonymising User.email in the adapter, invalidating the pointer retention",
    apply: (src, text) => {
      const data = prismaData(src, "user", "updateMany");
      const p = propertyNamed(data, "email");
      if (!p) throw new Error("the user updateMany data has no `email` property");
      return removeProperty(text, src, p);
    },
  },
  // The product-identity surface. rawName, sku and barcode were written down as
  // product identity precisely so the classification could not rest on inference —
  // which is only worth something if a NEW text column cannot slip in beside them
  // and inherit it. PurchaseOrderLine joined COVERED_MODELS for exactly that reason:
  // every column must answer for itself. This proves it does.
  E6: {
    file: SCHEMA,
    what: "add an unclassified text column beside the product identity on PurchaseOrderLine",
    apply: (_src, text) => insertPrismaField(text, "PurchaseOrderLine", "supplierContactNote String?"),
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
