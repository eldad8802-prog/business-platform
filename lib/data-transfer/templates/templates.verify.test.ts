/**
 * Import templates (I-4) — deterministic verifier.
 *
 * NO database, NO network, NO tenant context. The template builder is a pure
 * function of a domain id and a date, and this file exists to keep it that way:
 * the moment generation started reading business data, the determinism check
 * below would fail.
 *
 * The load-bearing test here is the DRIFT test. A template's whole job is to
 * teach the owner what the importer will accept. If the two lists are allowed
 * to separate, the template becomes a confident lie — so the columns are
 * derived from the domain field list, and the derivation itself is asserted.
 *
 * Run: npx tsx lib/data-transfer/templates/templates.verify.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  TEMPLATE_DATA_SHEET,
  TEMPLATE_GUIDE_SHEET,
  buildImportTemplate,
  buildTemplateFilename,
  isTemplateDomainId,
} from "@/lib/data-transfer/templates/template-builder";
import {
  exportableFields,
  importableFields,
  requiredImportFields,
} from "@/lib/data-transfer/domain-fields";
import {
  EXPORT_DESCRIPTORS,
  EXPORTABLE_DOMAIN_IDS,
  getExportDescriptor,
} from "@/lib/data-transfer/export/export-registry";
import { readXlsxTable } from "@/lib/data-transfer/format/xlsx-reader";
import type { DataTransferDomainId } from "@/lib/data-transfer/domains";

let passed = 0;

function check(label: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

async function checkAsync(label: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

function readCode(path: string): string {
  const blockComment = new RegExp(String.raw`/\*[\s\S]*?\*/`, "g");
  const lineComment = new RegExp(String.raw`^\s*//`);
  return fs
    .readFileSync(path, "utf8")
    .replace(blockComment, "")
    .split("\n")
    .filter((line) => !lineComment.test(line))
    .join("\n");
}

const AT = new Date(Date.UTC(2026, 8, 2, 21, 30)); // 2026-09-03 Israel time

/**
 * The required-import decision for every domain, transcribed from the canonical
 * create service. Written out HERE as an independent statement of the contract,
 * so a descriptor edit that quietly promotes or demotes a field has to be
 * reconciled against the service evidence rather than just accepted.
 *
 *   Customer  customerService.createCustomer  -> normalizeName throws
 *             ValidationError("name is required")
 *   Supplier  supplierService.createSupplier  -> normalizeName throws
 *             InventoryValidationError("Supplier name is required")
 *   Lead      leadService.createLead          -> normalizeLeadName throws
 *             ValidationError("name is required")
 *   Inventory inventoryService.createItemWithInitialStock -> throws
 *             InventoryValidationError("Item name is required"); unitType is a
 *             NOT NULL column with no default and the route's
 *             parseInventoryUnitType throws "unitType is required"
 */
const REQUIRED_BY_SERVICE: Record<DataTransferDomainId, string[]> = {
  customers: ["שם"],
  suppliers: ["שם ספק"],
  leads: ["שם"],
  inventory: ["שם פריט", "יחידת מידה"],
  documents: [],
  "issued-documents": [],
};

/** Fields the canonical create service accepts, by domain. */
const IMPORTABLE_BY_SERVICE: Record<string, string[]> = {
  customers: ["שם", "טלפון", "אימייל", "עיר", "הערות"],
  leads: ["שם", "טלפון", "אימייל", "מקור הפנייה", "מה ביקשו"],
  inventory: [
    "שם פריט",
    "מק״ט",
    "ברקוד",
    "יחידת מידה",
    "ספק",
    "כמות במלאי",
    "כמות מינימום",
    "נקודת הזמנה",
    "עלות ליחידה",
    "מחיר מכירה",
  ],
};

async function main(): Promise<void> {

/* ============================================ 1. field-model integrity == */

check("every field declares both capabilities explicitly", () => {
  for (const d of EXPORT_DESCRIPTORS) {
    for (const f of d.columns) {
      assert.equal(typeof f.exportable, "boolean", `${d.id}/${f.header}`);
      assert.equal(typeof f.importable, "boolean", `${d.id}/${f.header}`);
      // `required` is meaningless on a field the importer will never see.
      if (!f.importable) {
        assert.equal(f.required, undefined, `${d.id}/${f.header}`);
      }
    }
  }
});

check("every importable field carries owner-facing guidance", () => {
  // A template column with no explanation is a column the owner has to guess.
  for (const d of EXPORT_DESCRIPTORS) {
    for (const f of importableFields(d.columns)) {
      assert.equal(
        typeof f.help === "string" && f.help.trim().length > 0,
        true,
        `${d.id}/${f.header} has no help text`
      );
      assert.equal(
        typeof f.example === "string" && f.example.trim().length > 0,
        true,
        `${d.id}/${f.header} has no example`
      );
    }
  }
});

check("required fields match the canonical create services", () => {
  for (const id of EXPORTABLE_DOMAIN_IDS) {
    const actual = requiredImportFields(getExportDescriptor(id).columns).map(
      (f) => f.header
    );
    assert.deepEqual(
      actual.sort(),
      [...REQUIRED_BY_SERVICE[id]].sort(),
      `${id}: required set drifted from the service contract`
    );
  }
});

check("importable sets match what each create service accepts", () => {
  for (const [id, expected] of Object.entries(IMPORTABLE_BY_SERVICE)) {
    const actual = importableFields(
      getExportDescriptor(id as DataTransferDomainId).columns
    ).map((f) => f.header);
    assert.deepEqual(
      actual.sort(),
      [...expected].sort(),
      `${id}: importable set drifted from the service contract`
    );
  }
  // Suppliers accept the whole profile, so assert the shape rather than
  // re-listing nineteen labels: everything except lifecycle and history.
  const suppliers = getExportDescriptor("suppliers").columns;
  const notImportable = suppliers
    .filter((f) => !f.importable)
    .map((f) => f.header);
  assert.deepEqual(notImportable, ["פעיל", "נוצר בתאריך"]);
});

check("system-owned fields are exportable but never importable", () => {
  // An owner supplying these would be inventing history or lifecycle.
  for (const d of EXPORT_DESCRIPTORS) {
    for (const f of d.columns) {
      if (f.header === "נוצר בתאריך" || f.header === "פעיל") {
        assert.equal(f.exportable, true, `${d.id}/${f.header}`);
        assert.equal(f.importable, false, `${d.id}/${f.header}`);
      }
    }
  }
});

check("export output is unchanged by the field model (all fields exportable)", () => {
  // I-4 added capabilities; it must not have dropped an export column.
  for (const d of EXPORT_DESCRIPTORS) {
    assert.equal(
      exportableFields(d.columns).length,
      d.columns.length,
      `${d.id}: a column stopped being exportable`
    );
  }
});

/* ================================================ 2. THE DRIFT TEST ===== */

await checkAsync("DRIFT: template headers ARE the importable fields, derived", async () => {
  for (const id of EXPORTABLE_DOMAIN_IDS) {
    const expected = importableFields(getExportDescriptor(id).columns).map(
      (f) => f.header
    );
    const template = await buildImportTemplate(id, AT);

    // What the builder reports...
    assert.deepEqual(template.headers, expected, `${id}: reported headers`);

    // ...and what the FILE actually contains, which is what the owner sees.
    const sheet = await readXlsxTable(template.body, {
      sheetName: TEMPLATE_DATA_SHEET,
    });
    assert.deepEqual(sheet.headers, expected, `${id}: header row in the file`);
  }
});

await checkAsync("DRIFT: no non-importable field leaks into the data sheet", async () => {
  for (const id of EXPORTABLE_DOMAIN_IDS) {
    const forbidden = getExportDescriptor(id)
      .columns.filter((f) => !f.importable)
      .map((f) => f.header);
    const sheet = await readXlsxTable(
      (await buildImportTemplate(id, AT)).body,
      { sheetName: TEMPLATE_DATA_SHEET }
    );
    for (const header of forbidden) {
      assert.equal(
        sheet.headers.includes(header),
        false,
        `${id}: template offers non-importable "${header}"`
      );
    }
  }
});

/* ================================================= 3. workbook shape === */

await checkAsync("two sheets: a data sheet to fill and a guide that explains it", async () => {
  const ExcelJS = (await import("exceljs")).default;
  for (const id of EXPORTABLE_DOMAIN_IDS) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(
      (await buildImportTemplate(id, AT)).body as unknown as ArrayBuffer
    );
    assert.deepEqual(
      wb.worksheets.map((w) => w.name),
      [TEMPLATE_DATA_SHEET, TEMPLATE_GUIDE_SHEET],
      id
    );
    for (const ws of wb.worksheets) {
      assert.equal(ws.views[0].rightToLeft, true, `${id}/${ws.name}`);
    }
    assert.equal(
      wb.getWorksheet(TEMPLATE_DATA_SHEET)?.views[0].state,
      "frozen",
      `${id}: header row must stay visible while filling`
    );
  }
});

await checkAsync("SAFETY: the data sheet holds headers ONLY — zero example rows", async () => {
  // An example row in the sheet the owner uploads is a data-integrity trap.
  for (const id of EXPORTABLE_DOMAIN_IDS) {
    const sheet = await readXlsxTable(
      (await buildImportTemplate(id, AT)).body,
      { sheetName: TEMPLATE_DATA_SHEET }
    );
    assert.equal(sheet.rows.length, 0, `${id}: data sheet is not empty`);
  }
});

await checkAsync("the guide documents every field, its obligation and an example", async () => {
  for (const id of EXPORTABLE_DOMAIN_IDS) {
    const fields = importableFields(getExportDescriptor(id).columns);
    const guide = await readXlsxTable(
      (await buildImportTemplate(id, AT)).body,
      { sheetName: TEMPLATE_GUIDE_SHEET }
    );

    assert.deepEqual(guide.headers, [
      "שדה",
      "חובה?",
      "סוג הנתון",
      "הסבר",
      "דוגמה",
      "ערכים מותרים",
    ]);

    for (const f of fields) {
      const row = guide.rows.find((r) => r[0] === f.header);
      assert.notEqual(row, undefined, `${id}: guide is missing ${f.header}`);
      assert.equal(row?.[1], f.required ? "חובה" : "רשות", `${id}/${f.header}`);
      // Type is stated in Hebrew, never as the internal token.
      assert.equal(
        ["text", "number", "integer", "currency", "date", "datetime"].includes(
          String(row?.[2])
        ),
        false,
        `${id}/${f.header}: guide leaks the internal type token`
      );
      assert.equal(row?.[3], f.help, `${id}/${f.header}: help`);
      assert.equal(row?.[4], f.example, `${id}/${f.header}: example`);
    }
  }
});

await checkAsync("controlled vocabularies are documented in business Hebrew", async () => {
  // No dropdowns were built — ExcelJS data validation is not worth a bespoke
  // system here — so the allowed values must be READABLE in the guide, and
  // they must be the owner's words, not the enum's.
  const guide = await readXlsxTable(
    (await buildImportTemplate("inventory", AT)).body,
    { sheetName: TEMPLATE_GUIDE_SHEET }
  );
  const unitRow = guide.rows.find((r) => r[0] === "יחידת מידה");
  const allowed = String(unitRow?.[5] ?? "");
  for (const value of ["יחידה", "גרם", "ק״ג", "ליטר", "מארז"]) {
    assert.equal(allowed.includes(value), true, `unit "${value}" undocumented`);
  }
  for (const token of ["UNIT", "GRAM", "KG", "LITER", "BOX"]) {
    assert.equal(allowed.includes(token), false, `enum token "${token}" leaked`);
  }

  const supplierGuide = await readXlsxTable(
    (await buildImportTemplate("suppliers", AT)).body,
    { sheetName: TEMPLATE_GUIDE_SHEET }
  );
  const payRow = supplierGuide.rows.find((r) => r[0] === "אמצעי תשלום מועדף");
  assert.equal(String(payRow?.[5]).includes("העברה בנקאית"), true);
  assert.equal(String(payRow?.[5]).includes("BANK_TRANSFER"), false);
});

await checkAsync("the guide states the format contracts that APPLY to the domain", async () => {
  const guideText = async (id: DataTransferDomainId) => {
    const guide = await readXlsxTable(
      (await buildImportTemplate(id, AT)).body,
      { sheetName: TEMPLATE_GUIDE_SHEET }
    );
    return guide.rows.map((r) => r.join(" ")).join("\n");
  };

  const inventory = await guideText("inventory");
  assert.equal(inventory.includes("בלי ₪"), true, "number format undocumented");
  assert.equal(inventory.includes("אפסים מובילים"), true, "SKU/barcode caveat missing");

  const customers = await guideText("customers");
  assert.equal(customers.includes("972501234567"), true, "phone formats undocumented");
  // Customers has no מק״ט / ברקוד column, so that caveat must NOT appear —
  // an instruction about a field the owner cannot see is noise, and noise is
  // how the useful lines get skipped.
  assert.equal(customers.includes("אפסים מובילים"), false, "irrelevant SKU note shown");
  assert.equal(customers.includes("בלי ₪"), false, "irrelevant number note shown");

  // Every domain gets the always-applicable rules.
  for (const id of EXPORTABLE_DOMAIN_IDS) {
    const text = await guideText(id);
    assert.equal(text.includes("הגיליון הזה נועד להסבר בלבד"), true, id);
    assert.equal(text.includes("אל תשנו את שמות העמודות"), true, id);
  }
});

await checkAsync("FINDING: no importable field is a date today — the date rule is dormant", async () => {
  // Recorded as an assertion, not a comment: none of the four domains' create
  // services accept a date, so the date-format note is currently shown nowhere.
  // If a later increment adds a date field, this fails and the note (and I-5's
  // date parsing) must be revisited together.
  for (const id of EXPORTABLE_DOMAIN_IDS) {
    const dateFields = importableFields(getExportDescriptor(id).columns).filter(
      (f) => f.type === "date" || f.type === "datetime"
    );
    assert.deepEqual(dateFields.map((f) => f.header), [], `${id} gained a date field`);
    const guide = await readXlsxTable(
      (await buildImportTemplate(id, AT)).body,
      { sheetName: TEMPLATE_GUIDE_SHEET }
    );
    const text = guide.rows.map((r) => r.join(" ")).join("\n");
    assert.equal(text.includes("יום/חודש/שנה"), false, `${id} shows a dormant date rule`);
  }
});

/* ================================== 4. privacy + determinism + safety === */

check("BUILDER READS NO BUSINESS DATA", () => {
  const src = readCode("lib/data-transfer/templates/template-builder.ts");
  for (const needle of [
    "@/lib/prisma",
    "@prisma/client",
    "@/lib/tenant/",
    "businessId",
    "userId",
    "findMany",
    "TenantTx",
  ]) {
    assert.equal(src.includes(needle), false, `builder references ${needle}`);
  }
});

await checkAsync("DETERMINISTIC: identical bytes for the same domain and day", async () => {
  // Two businesses asking on the same day must get the SAME file. A difference
  // would mean generation had touched something tenant-specific.
  for (const id of EXPORTABLE_DOMAIN_IDS) {
    const a = await buildImportTemplate(id, AT);
    const b = await buildImportTemplate(id, new Date(AT.getTime() + 1000));
    assert.equal(a.filename, b.filename, id);
    const sheetA = await readXlsxTable(a.body, { sheetName: TEMPLATE_GUIDE_SHEET });
    const sheetB = await readXlsxTable(b.body, { sheetName: TEMPLATE_GUIDE_SHEET });
    assert.deepEqual(sheetA.rows, sheetB.rows, `${id}: guide content differs`);
  }
});

await checkAsync("no internal identifier appears anywhere in a template", async () => {
  for (const id of EXPORTABLE_DOMAIN_IDS) {
    const template = await buildImportTemplate(id, AT);
    for (const sheetName of [TEMPLATE_DATA_SHEET, TEMPLATE_GUIDE_SHEET]) {
      const sheet = await readXlsxTable(template.body, { sheetName });
      const text = [sheet.headers.join(" "), ...sheet.rows.map((r) => r.join(" "))]
        .join("\n");
      for (const needle of [
        "businessId",
        "userId",
        "categoryId",
        "customerId",
        "_dubiz_id",
        "Prisma",
      ]) {
        assert.equal(
          text.includes(needle),
          false,
          `${id}/${sheetName} contains ${needle}`
        );
      }
    }
  }
});

await checkAsync("SECURITY: a formula-looking example stays text in XLSX", async () => {
  // The examples are authored, but this pins the guarantee for whoever edits
  // them next: this writer never emits a formula cell.
  const guide = await readXlsxTable(
    (await buildImportTemplate("customers", AT)).body,
    { sheetName: TEMPLATE_GUIDE_SHEET }
  );
  for (const row of guide.rows) {
    for (const cell of row) {
      if (typeof cell === "string" && cell.startsWith("=")) {
        assert.equal(typeof cell, "string", "formula-looking cell must be text");
      }
    }
  }
  assert.equal(guide.rows.length > 0, true);
});

/* ================================================= 5. route contract === */

check("unknown and missing domains are rejected", () => {
  for (const bad of [
    "documents",
    "issued-documents",
    "Customer",
    "../../etc/passwd",
    "",
    null,
    undefined,
    7,
  ]) {
    assert.equal(isTemplateDomainId(bad), false, String(bad));
  }
  for (const good of EXPORTABLE_DOMAIN_IDS) {
    assert.equal(isTemplateDomainId(good), true, good);
  }
});

check("file names are business-readable, ASCII, and carry no tenant name", () => {
  assert.equal(
    buildTemplateFilename("customers", AT),
    "dubiz-customers-template-2026-09-03.xlsx"
  );
  for (const d of EXPORT_DESCRIPTORS) {
    const name = buildTemplateFilename(d.fileSlug, AT);
    assert.equal(/^[\x20-\x7e]+$/.test(name), true, name);
    assert.equal(/["\\/;\r\n]/.test(name), false, name);
  }
});

check("the template route is a read-only GET that touches no tenant data", () => {
  const src = readCode("app/api/data-transfer/template/route.ts");
  assert.equal(src.includes("export async function GET"), true);
  assert.equal(src.includes("export async function POST"), false);
  assert.equal(src.includes("getCurrentUser"), true, "must stay authenticated");
  // Authenticated, but never tenant-scoped: no query, no context, no id.
  for (const needle of [
    "runWithTenantContext",
    "withTenantTransaction",
    "user.businessId",
    "prisma",
  ]) {
    assert.equal(src.includes(needle), false, `route references ${needle}`);
  }
  assert.equal(src.includes("private, no-store"), true);
});

/* ======================================== 6. the hub does not mislead == */

check("every hub row that is a link points at a screen that exists", () => {
  const src = readCode(
    "components/settings/import-export/import-export-actions.ts"
  );
  assert.equal(/key: "templates",[\s\S]*?available: true/.test(src), true);
  assert.equal(/key: "export",[\s\S]*?available: true/.test(src), true);
  // I-6 made Import a real transfer. The row must say so — and must still
  // promise the check, because an owner who clicks it is trusting that nothing
  // lands before they see it.
  assert.equal(/key: "import",[\s\S]*?available: true/.test(src), true);
  assert.equal(
    /key: "import",[\s\S]*?description: "העלו קובץ ממערכת אחרת, בדקו, ואשרו קליטה"/.test(src),
    true,
    "the Import row must describe the transfer AND the check before it"
  );
});

check("the templates screen still says preparation, not importing", () => {
  const src = fs.readFileSync(
    "components/settings/import-export/TemplatesScreen.tsx",
    "utf8"
  );
  assert.equal(src.includes("הכינו את המידע"), true);
  // I-5's "you cannot upload it yet" was true then and is false now. A screen
  // that still said it would send owners away from a feature that works.
  assert.equal(
    src.includes("אפשרות הייבוא עצמה תתווסף בהמשך"),
    false,
    "the templates screen must not still say importing is unavailable"
  );
  assert.equal(src.includes("במסך הייבוא"), true);
});

console.log(`\nIMPORT TEMPLATES VERIFY PASS — ${passed} checks green.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
