/**
 * Import & Export Center foundation (I-2) — deterministic verifier.
 *
 * NO database, NO network, NO secrets, NO rendering. Two invariants that are
 * cheap to state and expensive to lose:
 *
 *  1. SCOPE — exactly the six ratified domains, no seventh.
 *  2. NO DEAD NAVIGATION — while the feature is unreleased, it must be absent
 *     from Settings AND unreachable by URL. The failure this guards against is
 *     silent: someone adds the row "so it's ready", and a business owner finds
 *     a screen that does nothing.
 *
 * Run: npx tsx lib/data-transfer/import-export-foundation.verify.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  DATA_TRANSFER_DOMAINS,
  DATA_TRANSFER_DOMAIN_IDS,
  getDataTransferDomain,
  type DataTransferDomainId,
} from "@/lib/data-transfer/domains";
import { SETTINGS_CATEGORIES } from "@/components/settings/settings-categories";
import {
  IMPORT_EXPORT_RELEASED,
  IMPORT_EXPORT_ROUTE,
  IMPORT_EXPORT_SETTINGS_CATEGORY,
} from "@/components/settings/import-export/import-export-release";
import { IMPORT_EXPORT_ACTIONS } from "@/components/settings/import-export/import-export-actions";

let passed = 0;

function check(label: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

/* ================================================== 1. approved scope ==== */

const APPROVED_DOMAIN_IDS: DataTransferDomainId[] = [
  "customers",
  "suppliers",
  "leads",
  "inventory",
  "documents",
  "issued-documents",
];

check("exactly the six ratified domains, in order, with no seventh", () => {
  assert.deepEqual([...DATA_TRANSFER_DOMAIN_IDS], APPROVED_DOMAIN_IDS);
  assert.equal(DATA_TRANSFER_DOMAINS.length, 6);
});

check("no domain outside the approved scope has crept in", () => {
  // The scope explicitly excludes learning state, AI internals, system
  // settings, logs, telemetry and notifications. A generic id check would not
  // catch those by name, so the closed set above is the guard; this asserts the
  // shape of every entry so a half-filled row cannot ship either.
  for (const domain of DATA_TRANSFER_DOMAINS) {
    assert.equal(typeof domain.title, "string");
    assert.equal(domain.title.trim().length > 0, true, domain.id);
    assert.equal(domain.description.trim().length > 0, true, domain.id);
    assert.equal(domain.icon.trim().length > 0, true, domain.id);
    assert.equal(
      ["tabular", "files", "fiscal"].includes(domain.kind),
      true,
      domain.id
    );
  }
});

check("domain ids are unique", () => {
  assert.equal(new Set(DATA_TRANSFER_DOMAIN_IDS).size, 6);
});

check("labels are owner-facing, never internal model names", () => {
  // A screen that says "InventoryItem" or "BillingDocument" has failed no
  // matter how correct it is.
  const internalNames = [
    "InventoryItem",
    "BillingDocument",
    "FinancialRecord",
    "Customer",
    "Supplier",
    "Lead",
    "Document",
    "Prisma",
    "CSV",
    "XLSX",
  ];
  for (const domain of DATA_TRANSFER_DOMAINS) {
    for (const name of internalNames) {
      assert.equal(
        `${domain.title} ${domain.description}`.includes(name),
        false,
        `${domain.id} exposes "${name}" to the owner`
      );
    }
  }
});

check("the three kinds carry the domains they must", () => {
  // Documents move as FILES through the existing pipeline; issued documents are
  // FISCAL (export-only, import deferred to I-9). Mislabelling either is how a
  // later increment would start treating an invoice like a spreadsheet row.
  assert.equal(getDataTransferDomain("documents").kind, "files");
  assert.equal(getDataTransferDomain("issued-documents").kind, "fiscal");
  for (const id of ["customers", "suppliers", "leads", "inventory"] as const) {
    assert.equal(getDataTransferDomain(id).kind, "tabular", id);
  }
});

/* ============================================= 2. no dead navigation ===== */

check("the listing matches the release state, whichever state that is", () => {
  const keys = SETTINGS_CATEGORIES.map((c) => c.key);
  const hrefs = SETTINGS_CATEGORIES.map((c) => c.href);

  if (IMPORT_EXPORT_RELEASED) {
    // Released (I-3 onward): the row must be there, or a working capability is
    // invisible to the only person who can use it.
    assert.equal(keys.includes(IMPORT_EXPORT_SETTINGS_CATEGORY.key), true);
    assert.equal(hrefs.includes(IMPORT_EXPORT_ROUTE), true);
  } else {
    assert.equal(keys.includes(IMPORT_EXPORT_SETTINGS_CATEGORY.key), false);
    assert.equal(
      hrefs.some((h) => h.startsWith(IMPORT_EXPORT_ROUTE)),
      false
    );
  }
});

check("the route is gated by the flag, in both directions", () => {
  // The gate itself is permanent: whether it opens depends on the flag, but a
  // page that stopped consulting it could never be closed again.
  for (const page of [
    "app/settings/import-export/page.tsx",
    "app/settings/import-export/export/page.tsx",
  ]) {
    const src = fs.readFileSync(page, "utf8");
    assert.equal(src.includes("IMPORT_EXPORT_RELEASED"), true, page);
    assert.equal(src.includes("notFound()"), true, page);
  }
});

check("RELEASE IS ATOMIC: listing and the flag can only move together", () => {
  // Whichever way a future edit goes, the two halves must agree. Flipping the
  // flag without listing leaves the feature unreachable; listing without the
  // flag creates a Settings row that opens a 404 — the exact dead navigation
  // this increment exists to avoid.
  const listed = SETTINGS_CATEGORIES.some(
    (c) => c.key === IMPORT_EXPORT_SETTINGS_CATEGORY.key
  );
  assert.equal(
    listed,
    IMPORT_EXPORT_RELEASED,
    listed
      ? "the Settings row is listed but the route still 404s"
      : "the route is released but no Settings row lists it"
  );
});

check("while unreleased, no OTHER surface links the route", () => {
  if (IMPORT_EXPORT_RELEASED) {
    // Released: linking it is the point. The atomicity check above is what
    // keeps the listing and the gate in step from here on.
    return;
  }
  // A stray <Link href="/settings/import-export"> anywhere in the app would
  // re-open the hole from a direction this file's other checks cannot see.
  const roots = ["app", "components"];
  const offenders: string[] = [];

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      // The feature's own files legitimately name their own route.
      if (full.includes("/import-export/")) continue;
      const src = fs.readFileSync(full, "utf8");
      if (src.includes(IMPORT_EXPORT_ROUTE)) offenders.push(full);
    }
  };
  roots.forEach(walk);

  assert.deepEqual(
    offenders,
    [],
    `unreleased route is linked from: ${offenders.join(", ")}`
  );
});

/* ================================================= 3. hub composition === */

check("the hub asks direction first — exactly two actions", () => {
  assert.equal(IMPORT_EXPORT_ACTIONS.length, 2);
  assert.deepEqual(
    IMPORT_EXPORT_ACTIONS.map((a) => a.key),
    ["import", "export"]
  );
});

check("both actions describe what the owner gets, in Hebrew", () => {
  const hebrew = /[֐-׿]/;
  for (const action of IMPORT_EXPORT_ACTIONS) {
    assert.equal(hebrew.test(action.title), true, action.key);
    assert.equal(hebrew.test(action.description), true, action.key);
    assert.equal(action.href.startsWith(`${IMPORT_EXPORT_ROUTE}/`), true, action.key);
  }
  assert.equal(
    IMPORT_EXPORT_ACTIONS.find((a) => a.key === "import")?.description,
    "העבר מידע ממערכת אחרת לדוביז"
  );
  assert.equal(
    IMPORT_EXPORT_ACTIONS.find((a) => a.key === "export")?.description,
    "הורד עותק של הנתונים והמסמכים שלך"
  );
});

check("no file-format or developer vocabulary reaches the owner", () => {
  const forbidden = ["CSV", "XLSX", "ZIP", "bulk", "migration", "parse", "API"];
  const surface = IMPORT_EXPORT_ACTIONS.flatMap((a) => [a.title, a.description])
    .concat([
      IMPORT_EXPORT_SETTINGS_CATEGORY.title,
      IMPORT_EXPORT_SETTINGS_CATEGORY.description,
    ])
    .join(" ");
  for (const word of forbidden) {
    assert.equal(surface.includes(word), false, `owner copy contains "${word}"`);
  }
});

check("REUSE: the hub composes existing Settings primitives, not new ones", () => {
  // "Feels like it was always part of Dubiz" is a structural property, not a
  // visual opinion: the screen must own no styling of its own.
  const src = fs.readFileSync(
    "components/settings/import-export/ImportExportHub.tsx",
    "utf8"
  );
  assert.equal(src.includes("@/components/settings/SettingsRow"), true);
  assert.equal(src.includes("@/components/settings/SettingsSection"), true);
  assert.equal(src.includes('aria-label="ייבוא וייצוא"'), true);
});

check("I-2 BOUNDARY: the foundation ships no transfer machinery", () => {
  // I-2 is UI/architecture only. No CSV/XLSX generation, no parsing, no
  // mapping, no preview, no DB write, no templates, no ZIP, no AI.
  const files = [
    "lib/data-transfer/domains.ts",
    "components/settings/import-export/import-export-release.ts",
    "components/settings/import-export/import-export-actions.ts",
    "components/settings/import-export/ImportExportHub.tsx",
    "app/settings/import-export/page.tsx",
  ];
  const forbidden = [
    "@/lib/prisma",
    "@prisma/client",
    "@/lib/tenant/",
    "data-transfer/format/",
    "exceljs",
    "archiver",
  ];
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    for (const needle of forbidden) {
      assert.equal(src.includes(needle), false, `${file} imports ${needle}`);
    }
  }
});

console.log(
  `\nIMPORT/EXPORT FOUNDATION VERIFY PASS — ${passed} checks green.`
);
