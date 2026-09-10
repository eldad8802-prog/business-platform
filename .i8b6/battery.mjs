/**
 * I-8B.6 — the historical fiscal READ path, against REAL PostgreSQL 17.
 *
 * # Why this cannot be a mock
 *
 * The failure this exists to catch is a PostgreSQL failure, and it is silent.
 * Under the restricted runtime role a SELECT with no tenant context does not
 * raise — it matches zero rows. "This business has forty documents" becomes
 * "this business has none", and a mocked client would happily report either.
 *
 * So the POSITIVE read matters as much as the denial: a battery that only
 * asserted "another tenant's rows did not come back" would pass on a read path
 * that returns nothing to anybody.
 *
 * Everything here runs through the same NOBYPASSRLS role production runs as —
 * not superuser, not the owner — and through the real service, not a copy of
 * its query.
 *
 * Synthetic data only. No Neon, no production, no secrets.
 *
 * Run: npx tsx .i8b6/battery.mjs
 */
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";

const MIGRATION =
  "prisma/migrations/20260907120000_i8a_historical_fiscal_documents/migration.sql";

const OWNER_URL = process.env.DATABASE_URL;
const RUNTIME_URL = process.env.RUNTIME_DATABASE_URL;
const RUNTIME_ROLE = process.env.RUNTIME_ROLE || "app_runtime";
if (!OWNER_URL || !RUNTIME_URL) {
  console.error("DATABASE_URL and RUNTIME_DATABASE_URL are both required");
  process.exit(1);
}
if (!/localhost|127\.0\.0\.1/.test(OWNER_URL)) {
  console.error("DENY: this battery runs only against a local PG17 lab");
  process.exit(1);
}

let pass = 0;
const failures = [];
function ok(label, condition, detail) {
  if (condition) {
    pass += 1;
    console.log(`  ok  ${label}`);
  } else {
    failures.push(label);
    console.log(`FAIL  ${label}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

const owner = new PrismaClient({ datasourceUrl: OWNER_URL });

/** Split a migration into statements, respecting dollar-quoted bodies. */
function splitSql(sql) {
  const lines = sql.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let current = "";
  let tag = null;
  for (const raw of lines) {
    const line = tag === null && /^\s*--/.test(raw) ? "" : raw;
    if (tag === null && line.trim() === "" && current.trim() === "") continue;
    current += line + "\n";
    let rest = line;
    while (rest.length > 0) {
      if (tag === null) {
        const open = rest.match(/\$[A-Za-z_]*\$/);
        if (!open) break;
        tag = open[0];
        rest = rest.slice(open.index + tag.length);
      } else {
        const close = rest.indexOf(tag);
        if (close < 0) break;
        rest = rest.slice(close + tag.length);
        tag = null;
      }
    }
    if (tag === null && line.trimEnd().endsWith(";")) {
      if (current.trim() !== "") out.push(current.trim());
      current = "";
    }
  }
  if (current.trim() !== "") out.push(current.trim());
  return out;
}

async function main() {
  console.log("\nI-8B.6 — historical fiscal records read path, on real PostgreSQL\n");

  const version = await owner.$queryRawUnsafe("SELECT version() AS v");
  console.log(`  server: ${String(version[0].v).split(",")[0]}`);
  console.log(`  process TZ: ${process.env.TZ ?? "(host default)"}\n`);

  const role = (
    await owner.$queryRawUnsafe(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1`,
      RUNTIME_ROLE
    )
  )[0];
  ok("the runtime role is NOT superuser", role?.rolsuper === false);
  ok("the runtime role is NOBYPASSRLS", role?.rolbypassrls === false);

  /* ── the real migration, so RLS and the grants are the real ones ──────── */

  await owner.$executeRawUnsafe(
    `DROP TABLE IF EXISTS "HistoricalFiscalDocument" CASCADE`
  );
  await owner.$executeRawUnsafe(`DROP INDEX IF EXISTS "Document_businessId_id_key"`);
  for (const statement of splitSql(fs.readFileSync(MIGRATION, "utf8"))) {
    await owner.$executeRawUnsafe(statement);
  }
  await owner.$executeRawUnsafe(`GRANT SELECT ON "Business" TO ${RUNTIME_ROLE}`);

  const forced = (
    await owner.$queryRawUnsafe(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'HistoricalFiscalDocument'`
    )
  )[0];
  ok("row-level security is enabled on the table", forced?.relrowsecurity === true);
  ok("row-level security is FORCED, so even the owner obeys it", forced?.relforcerowsecurity === true);

  const grants = await owner.$queryRawUnsafe(
    `SELECT privilege_type FROM information_schema.role_table_grants
      WHERE grantee = $1 AND table_name = 'HistoricalFiscalDocument'
      ORDER BY privilege_type`,
    RUNTIME_ROLE
  );
  const held = grants.map((g) => g.privilege_type);
  ok("the runtime may SELECT", held.includes("SELECT"), held.join(","));
  ok(
    "the runtime may NOT UPDATE — a historical record is written once",
    !held.includes("UPDATE"),
    held.join(",")
  );
  ok("the runtime may NOT DELETE", !held.includes("DELETE"), held.join(","));

  /* ── two tenants, and a history for each ─────────────────────────────── */

  await owner.$executeRawUnsafe(`DELETE FROM "HistoricalFiscalDocument"`);
  await owner.$executeRawUnsafe(`DELETE FROM "Business" WHERE name LIKE 'i8b6-%'`);

  const [bizA, bizB, bizC, bizD] = await owner.$queryRawUnsafe(
    `INSERT INTO "Business" ("name","updatedAt")
     VALUES ('i8b6-A', now()), ('i8b6-B', now()), ('i8b6-C', now()), ('i8b6-D', now())
     RETURNING id`
  );
  const A = bizA.id;
  const B = bizB.id;
  const C = bizC.id;
  // D exists only to make paging real: one page proves nothing about page two.
  const D = bizD.id;

  /** Seed one historical record and return its id. */
  const seed = async (businessId, fields) => {
    const rows = await owner.$queryRawUnsafe(
      `INSERT INTO "HistoricalFiscalDocument"
         ("businessId","documentTypeCode","sourceSystemCode","sourceSystemNameRaw",
          "originalDocumentNumber","originalIssueDate","subtotalAmount","vatAmount",
          "totalAmount","currency","customerNameSnapshot","customerTaxIdSnapshot",
          "reversesHistoricalDocumentId","reversesOriginalNumberRaw","updatedAt")
       VALUES ($1,$2,$3,$4,$5,
               CASE WHEN $6::text IS NULL THEN NULL ELSE ($6::text)::timestamp END,
               $7::numeric,$8::numeric,$9::numeric,$10,$11,$12,$13::int,$14, now())
       RETURNING id`,
      businessId,
      fields.type ?? "TAX_INVOICE",
      fields.source ?? "legacy-erp",
      fields.sourceRaw ?? null,
      fields.number ?? null,
      fields.date ?? null,
      fields.subtotal ?? null,
      fields.vat ?? null,
      fields.total ?? null,
      fields.currency ?? "ILS",
      fields.customer ?? null,
      fields.taxId ?? null,
      fields.reverses ?? null,
      fields.reversesRaw ?? null
    );
    return rows[0].id;
  };

  // Business A: a readable history with dates that collide, a null date, an
  // exotic amount, a second source system that appears exactly once, and a
  // credit that points at one of its own invoices.
  const aInvoice = await seed(A, {
    number: "2024/0001",
    date: "2024-03-17",
    subtotal: "1000.00",
    vat: "170.00",
    total: "1170.00",
    customer: "חברת דוגמה בע״מ",
    taxId: "512345678",
    sourceRaw: "Legacy ERP 7",
  });
  const aSameDay = await seed(A, {
    number: "2024/0002",
    date: "2024-03-17",
    total: "58.00",
  });
  const aEarliest = await seed(A, {
    number: "2024/0000",
    date: "2024-01-01",
    total: "1.00",
  });
  const aLatest = await seed(A, {
    number: "2024/0999",
    date: "2024-12-31",
    total: "99.99",
  });
  const aUndated = await seed(A, { number: "NO-DATE-1", total: "5.00" });
  const aBigAmount = await seed(A, {
    number: "BIG-1",
    date: "2024-06-01",
    total: "1234567890123456.78",
  });
  const aRareSource = await seed(A, {
    number: "RARE-1",
    date: "2024-06-02",
    total: "2.00",
    source: "zzz-rare-system",
  });
  const aCredit = await seed(A, {
    type: "CREDIT_NOTE",
    number: "CN-1",
    date: "2024-04-01",
    total: "-1170.00",
    reverses: aInvoice,
    reversesRaw: "2024/0001",
  });
  const aOrphanCredit = await seed(A, {
    type: "CREDIT_NOTE",
    number: "CN-2",
    date: "2024-04-02",
    total: "-58.00",
    reversesRaw: "NEVER-IMPORTED-9",
  });

  // Business B: a history that must never be visible from A, including a record
  // whose number would match A's filter.
  const bInvoice = await seed(B, {
    number: "2024/0001",
    date: "2024-03-17",
    total: "9999.00",
    source: "other-erp",
    customer: "לקוח של עסק אחר",
  });
  await seed(B, { number: "B-ONLY", date: "2024-05-05", total: "10.00" });

  // Business C holds nothing. It is the empty-state fixture.

  // Business D: a history long enough to need several pages, deliberately full
  // of the shapes that break a partial ordering — many records sharing one
  // date, and undated records that must not float to the top.
  const dIds = [];
  for (let i = 0; i < 47; i += 1) {
    // Every third record shares a date with its neighbours; every eleventh has
    // no date at all.
    const date =
      i % 11 === 10 ? null : `2023-0${1 + (i % 9)}-${String(1 + (i % 3)).padStart(2, "0")}`;
    dIds.push(
      await seed(D, { number: `D-${String(i).padStart(3, "0")}`, date, total: "3.00" })
    );
  }

  const aIds = [
    aInvoice,
    aSameDay,
    aEarliest,
    aLatest,
    aUndated,
    aBigAmount,
    aRareSource,
    aCredit,
    aOrphanCredit,
  ];

  /* ── the real service, through the restricted role ───────────────────── */

  process.env.DATABASE_URL = RUNTIME_URL;
  const { listHistoricalRecords, getHistoricalRecord } = await import(
    "@/lib/data-transfer/historical/historical-records"
  );
  const { runWithTenantContext } = await import("@/lib/tenant/context");

  const list = (businessId, input) =>
    runWithTenantContext({ businessId }, () =>
      listHistoricalRecords(businessId, input)
    );
  const detail = (businessId, id) =>
    runWithTenantContext({ businessId }, () => getHistoricalRecord(businessId, id));

  /* ============================ 1. the positive read ==================== */

  const pageA = await list(A, { page: 1 });
  ok(
    "POSITIVE: the tenant's own history is returned, and it is complete",
    pageA.total === aIds.length,
    `total=${pageA.total} expected=${aIds.length}`
  );
  ok(
    "POSITIVE: the first page actually carries rows",
    pageA.items.length === aIds.length,
    `items=${pageA.items.length}`
  );
  ok(
    "POSITIVE: every returned id belongs to this tenant",
    pageA.items.every((i) => aIds.includes(i.id))
  );

  /* ============================ 2. cross-tenant denial ================== */

  ok(
    "another tenant's records never appear in this tenant's list",
    !pageA.items.some((i) => i.id === bInvoice),
    "a foreign record was listed"
  );
  ok(
    "another tenant's record is invisible even when its id is known",
    (await detail(A, bInvoice)) === null
  );
  ok(
    "the reverse direction is denied too",
    (await detail(B, aInvoice)) === null
  );

  const bPage = await list(B, { page: 1 });
  ok(
    "the other tenant sees its OWN history, and only that",
    bPage.total === 2 && bPage.items.every((i) => i.id !== aInvoice),
    `total=${bPage.total}`
  );

  // A number that exists in BOTH tenants. The filter must not leak the other.
  const shared = await list(A, { filters: { originalDocumentNumber: "2024/0001" } });
  ok(
    "a number held by both tenants returns only this tenant's record",
    shared.total === 1 && shared.items[0].id === aInvoice,
    `total=${shared.total}`
  );

  /* ============================ 3. RLS, not the where clause ============ */

  // The application clause is defence in depth. This asserts the POLICY: raw
  // SQL with no businessId predicate, run as the restricted role with the GUC
  // set, must still see one tenant only.
  const runtime = new PrismaClient({ datasourceUrl: RUNTIME_URL });
  try {
    const scoped = await runtime.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        `SELECT set_config('app.current_business_id', $1, true)`,
        String(A)
      );
      return tx.$queryRawUnsafe(
        `SELECT DISTINCT "businessId" FROM "HistoricalFiscalDocument"`
      );
    });
    ok(
      "RLS ALONE scopes an unfiltered query to one tenant",
      scoped.length === 1 && scoped[0].businessId === A,
      JSON.stringify(scoped)
    );

    const unscoped = await runtime.$transaction(async (tx) =>
      tx.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "HistoricalFiscalDocument"`)
    );
    ok(
      "with NO tenant context the policy matches nothing — silently",
      Number(unscoped[0].c) === 0,
      `rows=${unscoped[0].c}`
    );

    // And the write side is closed, so "read-only" is not a convention.
    let updateRefused = false;
    try {
      await runtime.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(
          `SELECT set_config('app.current_business_id', $1, true)`,
          String(A)
        );
        await tx.$executeRawUnsafe(
          `UPDATE "HistoricalFiscalDocument" SET "totalAmount" = 1 WHERE id = ${aInvoice}`
        );
      });
    } catch {
      updateRefused = true;
    }
    ok("the runtime cannot UPDATE a historical record at all", updateRefused);

    let deleteRefused = false;
    try {
      await runtime.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(
          `SELECT set_config('app.current_business_id', $1, true)`,
          String(A)
        );
        await tx.$executeRawUnsafe(
          `DELETE FROM "HistoricalFiscalDocument" WHERE id = ${aInvoice}`
        );
      });
    } catch {
      deleteRefused = true;
    }
    ok("the runtime cannot DELETE a historical record at all", deleteRefused);
  } finally {
    await runtime.$disconnect();
  }

  /* ============================ 4. fail-closed ========================== */

  let threwWithoutTenant = false;
  try {
    await listHistoricalRecords(A, { page: 1 });
  } catch {
    threwWithoutTenant = true;
  }
  ok(
    "the service REFUSES to read with no tenant context, rather than returning nothing",
    threwWithoutTenant
  );

  let detailThrew = false;
  try {
    await getHistoricalRecord(A, aInvoice);
  } catch {
    detailThrew = true;
  }
  ok("the detail read is fail-closed the same way", detailThrew);

  /* ============================ 5. ordering and paging ================= */

  const ordered = pageA.items;
  const dated = ordered.filter((i) => i.originalIssueDate !== null);
  ok(
    "the newest dated record comes first",
    dated[0]?.id === aLatest,
    `first=${dated[0]?.id} expected=${aLatest}`
  );
  ok(
    "undated records sort LAST, not first",
    ordered[ordered.length - 1].id === aUndated,
    `last=${ordered[ordered.length - 1].id}`
  );
  ok(
    "dates descend",
    dated.every(
      (item, i) => i === 0 || dated[i - 1].originalIssueDate >= item.originalIssueDate
    )
  );
  // Two records share 2024-03-17. Without the primary-key tie-break their order
  // is whatever PostgreSQL felt like, and paging stops being stable.
  const sameDay = ordered.filter((i) => i.originalIssueDate === "2024-03-17");
  ok(
    "records sharing a date are ordered by the primary key, descending",
    sameDay.length === 2 && sameDay[0].id > sameDay[1].id,
    JSON.stringify(sameDay.map((i) => i.id))
  );

  // Paging is walked on the LONG history, because one page proves nothing about
  // page two: a partial ordering repeats and drops rows precisely at a boundary.
  const dFirst = await list(D, { page: 1 });
  ok(
    "the long history reports every record and more than one page",
    dFirst.total === dIds.length && dFirst.totalPages > 1 && dFirst.hasMore === true,
    `total=${dFirst.total} pages=${dFirst.totalPages}`
  );
  ok(
    "a full page is exactly the page size",
    dFirst.items.length === dFirst.pageSize,
    `items=${dFirst.items.length} pageSize=${dFirst.pageSize}`
  );

  const pages = [dFirst];
  for (let p = 2; p <= dFirst.totalPages; p += 1) {
    pages.push(await list(D, { page: p }));
  }
  const seen = pages.flatMap((p) => p.items.map((i) => i.id));
  ok(
    "paging visits every record exactly once — nothing repeated, nothing dropped",
    seen.length === dIds.length && new Set(seen).size === dIds.length,
    `seen=${seen.length} distinct=${new Set(seen).size} expected=${dIds.length}`
  );
  ok(
    "every record of the long history was reached",
    dIds.every((id) => seen.includes(id))
  );
  ok(
    "hasMore is false on the last page, and true on every earlier one",
    pages[pages.length - 1].hasMore === false &&
      pages.slice(0, -1).every((p) => p.hasMore === true)
  );

  // The same walk, twice: an unstable ordering gives a different sequence.
  const again = [];
  for (let p = 1; p <= dFirst.totalPages; p += 1) {
    const repeat = await list(D, { page: p });
    again.push(...repeat.items.map((i) => i.id));
  }
  ok(
    "walking the same history twice yields the SAME sequence",
    JSON.stringify(again) === JSON.stringify(seen)
  );

  const beyond = await list(A, { page: 9_999_999 });
  ok(
    "a page past the end is empty rather than an error",
    beyond.items.length === 0 && beyond.total === aIds.length
  );
  const negative = await list(A, { page: -5 });
  ok(
    "a nonsense page resolves to the first page",
    negative.page === 1 && negative.items.length > 0
  );

  /* ============================ 6. filters ============================== */

  const credits = await list(A, { filters: { documentTypeCode: "CREDIT_NOTE" } });
  ok(
    "filtering by document type returns only that type",
    credits.total === 2 && credits.items.every((i) => i.documentTypeCode === "CREDIT_NOTE"),
    `total=${credits.total}`
  );

  const rare = await list(A, { filters: { sourceSystemCode: "zzz-rare-system" } });
  ok(
    "filtering by source system works",
    rare.total === 1 && rare.items[0].id === aRareSource
  );

  const substring = await list(A, { filters: { originalDocumentNumber: "0999" } });
  ok(
    "a partial document number matches",
    substring.total === 1 && substring.items[0].id === aLatest
  );
  const insensitive = await list(A, { filters: { originalDocumentNumber: "no-date" } });
  ok(
    "the number match is case-insensitive",
    insensitive.total === 1 && insensitive.items[0].id === aUndated,
    `total=${insensitive.total}`
  );

  const from = await list(A, { filters: { issuedFrom: "2024-12-31" } });
  ok(
    "the FROM boundary is inclusive — the day itself is in range",
    from.total === 1 && from.items[0].id === aLatest,
    `total=${from.total}`
  );
  const to = await list(A, { filters: { issuedTo: "2024-01-01" } });
  ok(
    "the TO boundary is inclusive — the day itself is in range",
    to.total === 1 && to.items[0].id === aEarliest,
    `total=${to.total}`
  );
  const range = await list(A, {
    filters: { issuedFrom: "2024-03-17", issuedTo: "2024-04-01" },
  });
  ok(
    "a range returns exactly the days inside it, both ends included",
    range.total === 3,
    `total=${range.total}`
  );

  const bad = await list(A, { filters: { issuedFrom: "2024-02-31" } });
  ok(
    "an impossible date is ignored rather than silently shifting the range",
    bad.total === aIds.length,
    `total=${bad.total}`
  );

  const combined = await list(A, {
    filters: { documentTypeCode: "CREDIT_NOTE", issuedTo: "2024-04-01" },
  });
  ok(
    "filters combine rather than replacing one another",
    combined.total === 1 && combined.items[0].id === aCredit,
    `total=${combined.total}`
  );

  /* ============================ 7. facets and empty states ============= */

  ok(
    "the source-system facet lists every system, including the rare one",
    pageA.sourceSystems.includes("legacy-erp") &&
      pageA.sourceSystems.includes("zzz-rare-system"),
    JSON.stringify(pageA.sourceSystems)
  );
  ok(
    "the facet is this tenant's only",
    !pageA.sourceSystems.includes("other-erp"),
    JSON.stringify(pageA.sourceSystems)
  );
  ok("the facet is sorted", [...pageA.sourceSystems].sort().join() === pageA.sourceSystems.join());

  const emptyBiz = await list(C, { page: 1 });
  ok(
    "a business with no history reports an EMPTY HISTORY",
    emptyBiz.emptyHistory === true && emptyBiz.total === 0 && emptyBiz.items.length === 0
  );

  const emptyFilter = await list(A, {
    filters: { originalDocumentNumber: "NOTHING-MATCHES-THIS" },
  });
  ok(
    "no match under a filter is NOT the same as an empty history",
    emptyFilter.emptyHistory === false && emptyFilter.total === 0,
    `emptyHistory=${emptyFilter.emptyHistory}`
  );

  /* ============================ 8. the values themselves =============== */

  const one = await detail(A, aInvoice);
  ok("the detail read returns the record", one !== null);
  ok(
    "a calendar day survives the round trip, whatever the process timezone",
    one?.originalIssueDate === "2024-03-17",
    String(one?.originalIssueDate)
  );
  ok(
    "money comes back as an exact string, two decimals, never a float",
    one?.totalAmount === "1170.00" &&
      one?.subtotalAmount === "1000.00" &&
      one?.vatAmount === "170.00",
    `${one?.totalAmount}/${one?.subtotalAmount}/${one?.vatAmount}`
  );
  ok(
    "the customer snapshot is returned as it was written",
    one?.customerNameSnapshot === "חברת דוגמה בע״מ" &&
      one?.customerTaxIdSnapshot === "512345678"
  );
  ok(
    "the source system keeps both its code and its own words",
    one?.sourceSystemCode === "legacy-erp" && one?.sourceSystemNameRaw === "Legacy ERP 7"
  );

  const big = await detail(A, aBigAmount);
  ok(
    "a sixteen-digit amount does not lose a digit",
    big?.totalAmount === "1234567890123456.78",
    String(big?.totalAmount)
  );

  const first = ordered.find((i) => i.id === aEarliest);
  ok(
    "the first day of the year does not shift to the previous year",
    first?.originalIssueDate === "2024-01-01",
    String(first?.originalIssueDate)
  );
  const last = ordered.find((i) => i.id === aLatest);
  ok(
    "the last day of the year does not shift to the next year",
    last?.originalIssueDate === "2024-12-31",
    String(last?.originalIssueDate)
  );

  ok(
    "no internal handle reaches the owner-facing shape",
    one !== null &&
      !("businessId" in one) &&
      !("documentId" in one) &&
      !("importRunId" in one) &&
      !("reversesHistoricalDocumentId" in one),
    JSON.stringify(Object.keys(one ?? {}))
  );

  /* ============================ 9. reversal relationships ============== */

  const credit = await detail(A, aCredit);
  ok(
    "a resolved credit names the document it reverses",
    credit?.reverses?.id === aInvoice &&
      credit?.reverses?.originalDocumentNumber === "2024/0001",
    JSON.stringify(credit?.reverses)
  );
  ok("a resolved credit is reported as linked", credit?.reversesLinked === true);

  const orphan = await detail(A, aOrphanCredit);
  ok(
    "an unresolved credit keeps the number the source wrote",
    orphan?.reverses === null &&
      orphan?.reversesLinked === false &&
      orphan?.reversesOriginalNumberRaw === "NEVER-IMPORTED-9",
    JSON.stringify({
      reverses: orphan?.reverses,
      raw: orphan?.reversesOriginalNumberRaw,
    })
  );

  const reversed = await detail(A, aInvoice);
  ok(
    "the reversed document lists the credits that reverse it",
    reversed?.reversedBy.length === 1 && reversed?.reversedBy[0].id === aCredit,
    JSON.stringify(reversed?.reversedBy)
  );

  /* ============================ 10. nothing was written =============== */

  const after = await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS c FROM "HistoricalFiscalDocument"`
  );
  const seeded = aIds.length + dIds.length + 2;
  ok(
    "the whole battery wrote nothing: the row count is exactly what was seeded",
    Number(after[0].c) === seeded,
    `rows=${after[0].c} seeded=${seeded}`
  );
  const untouched = await owner.$queryRawUnsafe(
    `SELECT "totalAmount"::text AS t FROM "HistoricalFiscalDocument" WHERE id = ${aInvoice}`
  );
  ok(
    "and it changed nothing: the amount is exactly as seeded",
    untouched[0].t === "1170.00",
    untouched[0].t
  );

  console.log(`\n  ${pass} checks passed, ${failures.length} failed\n`);
  if (failures.length > 0) {
    failures.forEach((f) => console.log(`  FAILED: ${f}`));
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => owner.$disconnect());
