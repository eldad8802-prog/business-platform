/**
 * Import & Export Center foundation (I-2) — deterministic verifier.
 *
 * NO database, NO network, NO secrets, NO rendering. Two invariants that are
 * cheap to state and expensive to lose:
 *
 *  1. SCOPE — exactly the seven ratified domains, no eighth.
 *  2. NO DEAD NAVIGATION — while the feature is unreleased, it must be absent
 *     from Settings AND unreachable by URL. The failure this guards against is
 *     silent: someone adds the row "so it's ready", and a business owner finds
 *     a screen that does nothing.
 *  3. REGISTRATION IS NOT CAPABILITY — a domain may be named here long before
 *     anything can move through it. The historical domain is registered and has
 *     no writer, no descriptor and no screen, and that must stay measurable
 *     rather than assumed.
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

/**
 * The ratified set. It grew from six to seven in I-8B.0 — a deliberate product
 * decision, recorded here rather than absorbed silently: the owner approved a
 * separate domain for fiscal history that ANOTHER system issued, kept apart
 * from `issued-documents`, which stays exactly what it was.
 *
 * The order is contractual. Every screen that lists domains renders them in
 * registry order, so reordering is a visible product change and not a tidy-up,
 * and `deepEqual` on the array is what makes that true rather than aspirational.
 */
const APPROVED_DOMAIN_IDS: DataTransferDomainId[] = [
  "customers",
  "suppliers",
  "leads",
  "inventory",
  "documents",
  "issued-documents",
  "historical-documents",
];

check("exactly the seven ratified domains, in order, with no eighth", () => {
  assert.deepEqual([...DATA_TRANSFER_DOMAIN_IDS], APPROVED_DOMAIN_IDS);
  assert.equal(DATA_TRANSFER_DOMAINS.length, APPROVED_DOMAIN_IDS.length);
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
      ["tabular", "files", "fiscal", "historical"].includes(domain.kind),
      true,
      domain.id
    );
  }
});

check("domain ids are unique", () => {
  assert.equal(new Set(DATA_TRANSFER_DOMAIN_IDS).size, APPROVED_DOMAIN_IDS.length);
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

check("the four kinds carry the domains they must", () => {
  // Documents move as FILES through the existing pipeline; issued documents are
  // FISCAL (export-only). Mislabelling either is how a later increment would
  // start treating an invoice like a spreadsheet row.
  assert.equal(getDataTransferDomain("documents").kind, "files");
  assert.equal(getDataTransferDomain("issued-documents").kind, "fiscal");
  assert.equal(getDataTransferDomain("historical-documents").kind, "historical");
  for (const id of ["customers", "suppliers", "leads", "inventory"] as const) {
    assert.equal(getDataTransferDomain(id).kind, "tabular", id);
  }
});

check("issued and historical documents never collapse into one another", () => {
  // The drift this catches: someone widens `fiscal` to cover both, or points
  // the historical domain at the issued domain's wording. Either would put one
  // word over two opposite claims about who produced the document.
  const issued = getDataTransferDomain("issued-documents");
  const historical = getDataTransferDomain("historical-documents");

  assert.notEqual(issued.kind, historical.kind);
  assert.notEqual(issued.title, historical.title);
  assert.notEqual(issued.icon, historical.icon);

  // Exactly one domain of each fiscal-adjacent kind, so a second `fiscal` entry
  // cannot quietly become a second issuance surface.
  const byKind = (kind: string) => DATA_TRANSFER_DOMAINS.filter((d) => d.kind === kind);
  assert.equal(byKind("fiscal").length, 1);
  assert.equal(byKind("historical").length, 1);
  assert.equal(byKind("fiscal")[0].id, "issued-documents");
  assert.equal(byKind("historical")[0].id, "historical-documents");

  // `issued-documents` still says Dubiz produced these. Its wording is the
  // owner's only signal of that, so it is asserted verbatim.
  assert.equal(issued.title, "מסמכים שהפקת");
  assert.match(issued.description, /בדוביז/);
  // And the historical domain says the opposite, just as plainly.
  assert.match(historical.description, /במערכת אחרת/);
  assert.ok(
    !historical.description.includes("שהפקת"),
    "historical wording must never claim the owner issued these in Dubiz"
  );
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

check("the hub asks direction first, and never shows the six domains", () => {
  // Two DIRECTIONS (in / out), plus the one thing an owner can actually do
  // about importing today: prepare their data. Domain selection belongs to the
  // next step of each flow, where the direction is already known — a six-item
  // grid here would ask the second question first.
  // I-7B added a second way IN. Documents are a different KIND of transfer —
  // files rather than rows — so they are their own row rather than a sixth
  // domain inside the tabular import, which would have asked the owner to pick
  // a "domain" and then handed them a completely different screen.
  assert.deepEqual(
    IMPORT_EXPORT_ACTIONS.map((a) => a.key),
    ["import", "templates", "documents-import", "export"]
  );
  // Templates sits with Import, not after Export: it belongs to that journey,
  // and it serves the TABULAR import specifically — which is why the documents
  // row follows it rather than splitting it from the flow it prepares for.
  assert.equal(IMPORT_EXPORT_ACTIONS[0].key, "import");
  assert.equal(IMPORT_EXPORT_ACTIONS[1].key, "templates");
  // Export stays last: the way out is never in the middle of the ways in.
  assert.equal(
    IMPORT_EXPORT_ACTIONS[IMPORT_EXPORT_ACTIONS.length - 1].key,
    "export"
  );

  // Structural, not a word scan: no hub action IS a domain. (The Export copy
  // legitimately says "והמסמכים שלך" as ordinary Hebrew, so matching domain
  // titles as substrings would fire on approved wording.)
  const domainIds = new Set<string>(DATA_TRANSFER_DOMAINS.map((d) => d.id));
  for (const action of IMPORT_EXPORT_ACTIONS) {
    assert.equal(
      domainIds.has(action.key),
      false,
      `hub exposes the domain "${action.key}" as a top-level action`
    );
  }
});

check("both actions describe what the owner gets, in Hebrew", () => {
  const hebrew = /[֐-׿]/;
  for (const action of IMPORT_EXPORT_ACTIONS) {
    assert.equal(hebrew.test(action.title), true, action.key);
    assert.equal(hebrew.test(action.description), true, action.key);
    assert.equal(action.href.startsWith(`${IMPORT_EXPORT_ROUTE}/`), true, action.key);
  }
  // The Import row's wording tracks what the screen can actually do. I-6 made
  // it a real transfer, so it says so — and it still names the check first,
  // because that is the part that makes confirming safe.
  assert.equal(
    IMPORT_EXPORT_ACTIONS.find((a) => a.key === "import")?.description,
    "העלו קובץ ממערכת אחרת, בדקו, ואשרו קליטה"
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

/* ============================== 5. registration is not capability ======== */

/**
 * A domain in the registry is a name and a set of rules. It is NOT permission
 * to move data.
 *
 * The historical domain is registered by I-8B.0 and has no Analyze, no Preview,
 * no Execute and no writer — those are later increments. What follows proves
 * the owner cannot reach a flow that does not exist yet, and that nothing
 * generic treats "registered" as "runnable". Two existing mechanisms do the
 * work, which is why this increment adds no feature flag:
 *
 *   the screens filter on `kind === "tabular"`
 *   the routes gate on `isExportableDomainId`
 *
 * If either stops being true, this section fails rather than a dead screen
 * shipping.
 */
const DOMAIN_LISTING_PAGES = [
  "app/settings/import-export/import/page.tsx",
  "app/settings/import-export/export/page.tsx",
  "app/settings/import-export/templates/page.tsx",
];

check("no screen lists the historical domain — all three filter on tabular", () => {
  for (const page of DOMAIN_LISTING_PAGES) {
    const src = fs.readFileSync(page, "utf8").replace(/\r\n/g, "\n");
    assert.match(
      src,
      /DATA_TRANSFER_DOMAINS\.filter\(\s*\(domain\) => domain\.kind === "tabular"\s*\)/,
      `${page} must list tabular domains only`
    );
  }
});

check("the hub gained no new action — the owner sees no historical flow", () => {
  assert.deepEqual(
    IMPORT_EXPORT_ACTIONS.map((a) => a.key),
    ["import", "templates", "documents-import", "export"]
  );
});

check("every import and export route refuses the historical domain", () => {
  // All four take a domain from the client and gate it on the SAME predicate,
  // which is built from the export descriptors — a hand-written list the
  // historical domain is deliberately absent from.
  const routes = [
    "app/api/data-transfer/import/analyze/route.ts",
    "app/api/data-transfer/import/preview/route.ts",
    "app/api/data-transfer/import/execute/route.ts",
  ];
  for (const route of routes) {
    const src = fs.readFileSync(route, "utf8").replace(/\r\n/g, "\n");
    assert.match(src, /isExportableDomainId\(domain\)/, `${route} must gate on the domain list`);
  }
  const registry = fs
    .readFileSync("lib/data-transfer/export/export-registry.ts", "utf8")
    .replace(/\r\n/g, "\n");
  assert.ok(
    !registry.includes("historical"),
    "no historical export descriptor may exist yet"
  );
});

check("no writer exists for the historical domain", () => {
  // Read rather than imported, because importing the writers would pull Prisma
  // into a verifier that must stay database-free. `writerFor` throws for any
  // domain absent from this record, so absence IS the refusal.
  const src = fs
    .readFileSync("lib/data-transfer/import/execute/domain-writers.ts", "utf8")
    .replace(/\r\n/g, "\n");
  const record = src.slice(src.indexOf("const WRITERS"), src.indexOf("export function writerFor"));
  assert.match(record, /customers:/);
  assert.ok(!record.includes("historical"), "a historical writer must not exist yet");
  assert.match(src, /No import writer for domain/, "an unknown domain must still throw");
});

console.log(
  `\nIMPORT/EXPORT FOUNDATION VERIFY PASS — ${passed} checks green.`
);
