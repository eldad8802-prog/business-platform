/**
 * Supplier field — option-building and contract guards. Run:
 *   npx tsx components/inventory/supplier-field.test.ts
 *
 * SCOPE, STATED HONESTLY. This repository has no DOM unit stack (Playwright
 * only — no jsdom, no testing-library), and adding one is an infrastructure
 * change this task is not allowed to make. So the split is:
 *
 *   here  — `buildSupplierChoices`, which is where the actual decisions live
 *           (what is offered, in what order, and when "create" appears), plus
 *           the architectural properties that must not silently regress;
 *   there — scripts/qa/ui/inventory-supplier-field-qa.mjs drives the REAL
 *           Create and Edit screens in a browser for everything that needs one:
 *           keyboard, focus, quick-create, duplicates, cancel, API failure.
 *
 * That second instrument is stronger than jsdom would have been, because it
 * exercises the shipped components rather than a simulation of them.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildSupplierChoices, type SupplierChoice } from "./supplier-choices";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

const FIELD = read("components", "inventory", "supplier-field.tsx");
const CREATE = read("app", "(shell)", "inventory", "items", "create", "page.tsx");
const EDIT = read("components", "inventory", "product-detail-view.tsx");
const SCHEMA = read("prisma", "schema.prisma");

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, extra = ""): void {
  total += 1;
  if (!cond) failures += 1;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
}

const names = (cs: SupplierChoice[]) => cs.map((c) => c.name);
const kinds = (cs: SupplierChoice[]) => cs.map((c) => c.kind);

const LONG_HE = "מרכז השיווק והפצת מוצרי הבנייה והתשתיות בע״מ סניף ראשי דרום";
const LONG_EN = "Globex Industries International Trading And Distribution Limited";

/* ── the canonical Supplier is the primary source ─────────────────────────── */
console.log("\nCanonical suppliers");
{
  const cs = buildSupplierChoices({
    entities: [{ id: 7, name: "שטראוס" }],
    orphanNames: [],
    query: "שטר",
  });
  check("an existing supplier is offered", names(cs).includes("שטראוס"));
  check("it is offered as an entity", cs[0].kind === "entity");
  check(
    "the entity carries its canonical id",
    cs[0].kind === "entity" && cs[0].id === 7,
  );
}
{
  // The defect that motivated the whole task: the old datalist was built from
  // supplierName strings on items, so a real supplier nobody had typed yet was
  // invisible. With no orphans at all, the entity must still be offered.
  const cs = buildSupplierChoices({
    entities: [{ id: 3, name: "ספק חדש לגמרי" }],
    orphanNames: [],
    query: "",
  });
  check(
    "a supplier never used on any item is still offered",
    names(cs).includes("ספק חדש לגמרי"),
  );
}
{
  const cs = buildSupplierChoices({
    entities: [
      { id: 1, name: LONG_HE },
      { id: 2, name: LONG_EN },
    ],
    orphanNames: [],
    query: "",
  });
  check("a long Hebrew name is preserved verbatim", names(cs).includes(LONG_HE));
  check("a long English name is preserved verbatim", names(cs).includes(LONG_EN));
}

/* ── orphan snapshots stay reachable ──────────────────────────────────────── */
console.log("\nOrphan snapshot names");
{
  const cs = buildSupplierChoices({
    entities: [],
    orphanNames: ["ספק ישן מהמלאי"],
    query: "ספק",
  });
  check("an orphan snapshot is offered", names(cs).includes("ספק ישן מהמלאי"));
  check("it is marked as an orphan, not an entity", cs[0].kind === "orphan");
}
{
  const cs = buildSupplierChoices({
    entities: [{ id: 1, name: "שטראוס" }],
    orphanNames: ["שטראוס"],
    query: "",
  });
  check(
    "an orphan identical to an entity is not offered twice",
    names(cs).filter((n) => n === "שטראוס").length === 1,
  );
  check("the entity is the one kept", cs[0].kind === "entity");
}
{
  const cs = buildSupplierChoices({
    entities: [{ id: 1, name: "אלפא" }],
    orphanNames: ["בטא"],
    query: "",
  });
  check(
    "entities are listed before orphans",
    kinds(cs).indexOf("entity") < kinds(cs).indexOf("orphan"),
  );
}
{
  const cs = buildSupplierChoices({
    entities: [],
    orphanNames: ["אלפא", "בטא"],
    query: "בט",
  });
  check("orphans are filtered by the typed text", names(cs).includes("בטא") && !names(cs).includes("אלפא"));
}

/* ── free typing, and when "create" is offered ────────────────────────────── */
console.log("\nFree text and the create action");
{
  const cs = buildSupplierChoices({ entities: [], orphanNames: [], query: "ספק שלא קיים" });
  const create = cs.find((c) => c.kind === "create");
  check("with no match at all, create is offered", !!create);
  check("create carries exactly what was typed", create?.name === "ספק שלא קיים");
  check("create is the last option", cs[cs.length - 1].kind === "create");
}
{
  const cs = buildSupplierChoices({
    entities: [{ id: 1, name: "שטראוס" }],
    orphanNames: [],
    query: "שטראוס",
  });
  check(
    "an exact canonical match suppresses create",
    !cs.some((c) => c.kind === "create"),
  );
}
{
  const cs = buildSupplierChoices({
    entities: [{ id: 1, name: "שטראוס" }],
    orphanNames: [],
    query: "  שטראוס  ",
  });
  check(
    "exactness ignores surrounding whitespace",
    !cs.some((c) => c.kind === "create"),
  );
}
{
  const cs = buildSupplierChoices({
    entities: [{ id: 1, name: "Strauss" }],
    orphanNames: [],
    query: "strauss",
  });
  check("exactness ignores case", !cs.some((c) => c.kind === "create"));
}
{
  const cs = buildSupplierChoices({
    entities: [],
    orphanNames: ["ספק ישן"],
    query: "ספק ישן",
  });
  check(
    "an exact ORPHAN match also suppresses create",
    !cs.some((c) => c.kind === "create"),
  );
}
{
  // A near match must still offer creation: deciding that "Strauss" and
  // "Strauss Ltd" are one business belongs to the duplicate advisory, after the
  // fact — never to this picker, silently, before it.
  const cs = buildSupplierChoices({
    entities: [{ id: 1, name: "Strauss" }],
    orphanNames: [],
    query: "Strauss Ltd",
  });
  check("a near match still offers create", cs.some((c) => c.kind === "create"));
  check("and still offers the existing supplier", names(cs).includes("Strauss"));
}
{
  const cs = buildSupplierChoices({ entities: [], orphanNames: [], query: "   " });
  check("whitespace alone offers nothing", cs.length === 0);
}
{
  const cs = buildSupplierChoices({
    entities: [{ id: 1, name: "אלפא" }],
    orphanNames: [],
    query: "",
  });
  check("an empty query offers no create action", !cs.some((c) => c.kind === "create"));
}

/* ── Tier 1 stays Tier 1 ──────────────────────────────────────────────────── */
console.log("\nArchitecture: the persisted value is still a snapshot");
{
  // docs/dubiz-party-identity-strategy-v1.md §6.5 — no Entity-FK before an
  // entity-centric read path exists. A picker is representation, not
  // aggregation, so it must not have introduced one.
  const model = /model InventoryItem \{[\s\S]*?\n\}/.exec(SCHEMA)?.[0] ?? "";
  check("InventoryItem still has supplierName", /supplierName\s+String\?/.test(model));
  check(
    "InventoryItem has NO supplierId FK",
    !/supplierId/.test(model),
    "adding one needs the party-identity strategy amended first",
  );
  check(
    "the field never sends a supplier id to the item API",
    !/supplierId/.test(FIELD),
  );
  check(
    "what the field commits is a name",
    /onChange\(normalizeInventoryText\(name\)\)/.test(FIELD),
  );
}

/* ── one supplier implementation, not two ─────────────────────────────────── */
console.log("\nReuse: no parallel supplier stack");
{
  check("quick-create posts through the existing createSupplier", /createSupplier\(/.test(FIELD));
  check("it validates with the existing validateSupplierForm", /validateSupplierForm\(/.test(FIELD));
  check("it maps with the existing supplierFormToPayload", /supplierFormToPayload\(/.test(FIELD));
  check("it renders the existing SupplierForm", /<SupplierForm\b/.test(FIELD));
  check("it searches through the existing getSuppliers", /getSuppliers\(/.test(FIELD));
  check(
    "it declares no supplier fields of its own",
    !/EMPTY_SUPPLIER_FORM\s*=/.test(FIELD),
    "the form shape must come from supplier-form-model",
  );
}

/* ── duplicates: reuse the policy, and do not stack dialogs ───────────────── */
console.log("\nDuplicate advisory");
{
  check("the shared advisory body is reused", /<SupplierDuplicateBody\b/.test(FIELD));
  check(
    "exactly one backdrop exists in the field",
    (FIELD.match(/crm-modal__backdrop/g) ?? []).length === 1,
    "a second backdrop would mean a stacked modal",
  );
  check(
    "the advisory replaces the dialog content",
    /duplicates \?[\s\S]{0,200}<SupplierDuplicateBody/.test(FIELD),
  );
  check(
    "keeping the new supplier selects the created name",
    /onKeepNew=\{\(\) => onSelected\(duplicates\.created\.name\)\}/.test(FIELD),
  );
  check(
    "choosing an existing supplier selects THAT supplier's name",
    /onOpenExisting=\{\(id\) =>[\s\S]{0,220}match \? match\.name/.test(FIELD),
  );
  // Looks for CALLS, not prose: the file explains the non-merge policy in
  // comments, and an earlier version of this check matched its own explanation.
  check(
    "nothing here deletes or merges the created supplier",
    !/\b(deleteSupplier|mergeSupplier|removeSupplier)\s*\(/.test(FIELD),
    "the ratified policy never auto-merges",
  );
}

/* ── accessible combobox ──────────────────────────────────────────────────── */
console.log("\nCombobox semantics");
{
  for (const attr of [
    'role="combobox"',
    "aria-expanded",
    "aria-controls",
    'aria-autocomplete="list"',
    "aria-activedescendant",
    'role="listbox"',
    'role="option"',
    "aria-selected",
  ]) {
    check(`the field declares ${attr}`, FIELD.includes(attr));
  }
  check("ArrowDown is handled", /"ArrowDown"/.test(FIELD));
  check("ArrowUp is handled", /"ArrowUp"/.test(FIELD));
  check("Enter is handled", /"Enter"/.test(FIELD));
  check("Escape is handled", /"Escape"/.test(FIELD));
  check("Tab closes the list", /"Tab"/.test(FIELD));
  check(
    "Enter cannot submit the item form from the list",
    /if \(open\) \{\s*e\.preventDefault\(\);\s*close\(\);/.test(FIELD),
  );
  check("focus returns to the input after choosing", /inputRef\.current\?\.focus\(\)/.test(FIELD));
}

/* ── both screens use the one field ───────────────────────────────────────── */
console.log("\nCreate and Edit share the field");
{
  check("Create renders SupplierField", /<SupplierField\b/.test(CREATE));
  check("Edit renders SupplierField", /<SupplierField\b/.test(EDIT));
  check(
    "Create no longer uses a supplier datalist",
    !/list="inv-suppliers"/.test(CREATE),
  );
  check(
    "Create passes the snapshot names as secondary choices",
    /orphanNames=\{supplierOptions\}/.test(CREATE),
  );
  check(
    "Edit keeps the item's own stored name selectable",
    /orphanNames=\{item\?\.supplierName/.test(EDIT),
  );
  check(
    "the item is still created only by its own save action",
    /createInventoryItem\(/.test(CREATE) && !/createInventoryItem/.test(FIELD),
  );
}

console.log(
  `\n${failures === 0 ? "PASS" : "FAIL"} — ${total - failures}/${total} checks passed\n`,
);
if (failures > 0) process.exit(1);
