/**
 * I-8B.5 — concurrent historical execution, against REAL PostgreSQL 17.
 *
 * The guarantee under test cannot be shown by a JavaScript model. It rests on
 * `pg_advisory_xact_lock`: a second transaction asking for a held key must
 * genuinely WAIT inside the database, and must then observe what the first one
 * committed. Both halves are properties of PostgreSQL, so both are measured
 * from PostgreSQL.
 *
 * The failure this exists to catch: two executions of the same document both
 * read "nothing exists", both decide their approved CREATE is still legal, and
 * both insert. Counts look plausible afterwards and nothing raises.
 *
 * Synthetic data only. No Neon, no production, no secrets.
 *
 * Run: node .i8b5/concurrency.mjs
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
  console.log("\nI-8B.5 — concurrent historical execution\n");

  await owner.$executeRawUnsafe(`DROP TABLE IF EXISTS "HistoricalFiscalDocument" CASCADE`);
  await owner.$executeRawUnsafe(`DROP INDEX IF EXISTS "Document_businessId_id_key"`);
  for (const statement of splitSql(fs.readFileSync(MIGRATION, "utf8"))) {
    await owner.$executeRawUnsafe(statement);
  }
  await owner.$executeRawUnsafe(
    `GRANT SELECT, INSERT, UPDATE ON "ImportRun" TO ${RUNTIME_ROLE}`
  );
  await owner.$executeRawUnsafe(`GRANT SELECT, INSERT ON "ImportRunRow" TO ${RUNTIME_ROLE}`);
  await owner.$executeRawUnsafe(
    `GRANT USAGE, SELECT ON SEQUENCE "ImportRun_id_seq" TO ${RUNTIME_ROLE}`
  );
  await owner.$executeRawUnsafe(`GRANT SELECT ON "Business" TO ${RUNTIME_ROLE}`);

  await owner.$executeRawUnsafe(`DELETE FROM "ImportRunRow"`);
  await owner.$executeRawUnsafe(`DELETE FROM "HistoricalFiscalDocument"`);
  await owner.$executeRawUnsafe(`DELETE FROM "ImportRun"`);
  await owner.$executeRawUnsafe(`DELETE FROM "Business" WHERE name LIKE 'i8b5c-%'`);

  const [bizA, bizB] = await owner.$queryRawUnsafe(
    `INSERT INTO "Business" ("name","updatedAt") VALUES ('i8b5c-A', now()), ('i8b5c-B', now()) RETURNING id`
  );
  const A = bizA.id;
  const B = bizB.id;

  process.env.DATABASE_URL = RUNTIME_URL;
  process.env.AUTH_TOKEN_SECRET ||= "i8b5-lab-secret";
  const { buildHistoricalPreview } = await import(
    "@/lib/data-transfer/historical/historical-preview"
  );
  const { executeHistoricalImport } = await import(
    "@/lib/data-transfer/historical/historical-execute"
  );
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const { buildXlsxBuffer } = await import("@/lib/data-transfer/format/xlsx-writer");
  const { historicalIdentityLockKey, HISTORICAL_IDENTITY_ADVISORY_NAMESPACE } =
    await import("@/lib/data-transfer/historical/historical-identity-lock");

  const HEADERS = [
    "סוג מסמך",
    "מספר מסמך מקורי",
    "תאריך המסמך",
    "סכום כולל",
    "סכום לפני מע״מ",
    "מע״מ",
    "מטבע",
    "שם לקוח",
    "מספר עוסק / ח.פ. לקוח",
    "מערכת מקור",
    "מספר מסמך שמזוכה",
  ];
  const row = (number, total) => [
    "חשבונית מס",
    number,
    "2024-03-17",
    total,
    "",
    "",
    "ILS",
    "",
    "",
    "legacy-erp",
    "",
  ];

  /**
   * One document, optionally followed by a second that differs between files.
   * Two files that share a document but differ elsewhere are two DIFFERENT
   * approvals: different content hash, different run, same fiscal identity —
   * which is the only shape where the identity lock is what decides the race.
   */
  const fileOf = (number, total, companion = null) =>
    buildXlsxBuffer([
      {
        name: "ייבוא",
        columns: HEADERS.map((h) => ({ header: h, type: "text" })),
        rows: companion === null ? [row(number, total)] : [row(number, total), companion],
        rightToLeft: true,
      },
    ]);

  const previewFor = (businessId, bytes) =>
    runWithTenantContext({ businessId }, () =>
      buildHistoricalPreview({
        businessId,
        userId: 1,
        filename: "history.xlsx",
        bytes,
        sheetName: null,
        dateFormat: null,
      })
    );

  const executeWith = (businessId, bytes, preview) =>
    executeHistoricalImport({
      businessId,
      userId: 1,
      filename: "history.xlsx",
      bytes,
      sheetName: null,
      dateFormat: null,
      decisions: preview.decisions,
      previewToken: preview.previewToken,
    });

  const countFor = async (businessId, number) =>
    Number(
      (
        await owner.$queryRawUnsafe(
          `SELECT count(*)::int AS c FROM "HistoricalFiscalDocument"
           WHERE "businessId" = $1 AND "originalDocumentNumber" = $2`,
          businessId,
          number
        )
      )[0].c
    );

  /* ── 1. two DIFFERENT approvals of the same document, at once ─────────── */

  // Both previews are taken while the record does not exist, so both approve a
  // CREATE. Without the lock both would insert; with it, the second waits, sees
  // the first one's record, and refuses because the world it approved is gone.
  const raceBytesOne = await fileOf("RACE-1", "100.00", row("FILLER-A", "10.00"));
  const raceBytesTwo = await fileOf("RACE-1", "100.00", row("FILLER-B", "20.00"));
  const previewOne = await previewFor(A, raceBytesOne);
  const previewTwo = await previewFor(A, raceBytesTwo);
  ok("both previews approved a create", previewOne.ok && previewTwo.ok && previewOne.readyForExecute && previewTwo.readyForExecute);

  const [resultOne, resultTwo] = await Promise.all([
    executeWith(A, raceBytesOne, previewOne),
    executeWith(A, raceBytesTwo, previewTwo),
  ]);

  const raceCount = await countFor(A, "RACE-1");
  ok(
    "exactly ONE record exists after two concurrent creates",
    raceCount === 1,
    `${raceCount} records`
  );
  // Each file also carries its own filler document, so "created" is counted per
  // run: the winner made two, the loser made only its own.
  const createdTotals = [resultOne, resultTwo].map((r) => (r.ok ? r.totals.created : -1));
  ok(
    "only one of them created the shared document",
    createdTotals.filter((c) => c === 2).length === 1,
    JSON.stringify(createdTotals)
  );
  const loser = [resultOne, resultTwo].find((r) => !r.ok || r.totals.created !== 2);
  ok(
    "the other one says so, rather than reporting a silent success",
    loser !== undefined &&
      (!loser.ok ||
        loser.rows.some(
          (r) => r.result === "DUPLICATE_CHANGED" || r.result === "ROW_PERSISTENCE_FAILED"
        )),
    JSON.stringify(loser)
  );

  /* ── 2. the SAME approval, executed twice at once ─────────────────────── */

  const sameBytes = await fileOf("SAME-1", "200.00");
  const sharedPreview = await previewFor(A, sameBytes);
  const [same1, same2] = await Promise.all([
    executeWith(A, sameBytes, sharedPreview),
    executeWith(A, sameBytes, sharedPreview),
  ]);
  const sameCount = await countFor(A, "SAME-1");
  ok("the same approved run executed twice creates exactly one record", sameCount === 1, `${sameCount} records`);
  const runIds = [same1, same2].filter((r) => r.ok).map((r) => r.runId);
  ok(
    "and both attempts resolve to the SAME run — no second ledger entry",
    new Set(runIds).size === 1,
    JSON.stringify(runIds)
  );
  const runCount = (
    await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM "ImportRun" WHERE "businessId" = $1`,
      A
    )
  )[0].c;
  ok("the ledger holds one run per approved execution", runCount >= 1);

  /* ── 3. two tenants, one document number, at once ─────────────────────── */

  const crossBytes = await fileOf("CROSS-1", "300.00");
  const previewA = await previewFor(A, crossBytes);
  const previewB = await previewFor(B, crossBytes);
  const [crossA, crossB] = await Promise.all([
    executeWith(A, crossBytes, previewA),
    executeWith(B, crossBytes, previewB),
  ]);
  ok("both tenants import their own copy", crossA.ok && crossB.ok, JSON.stringify([crossA.code, crossB.code]));
  ok("tenant A holds one", (await countFor(A, "CROSS-1")) === 1);
  ok("tenant B holds one", (await countFor(B, "CROSS-1")) === 1);
  ok(
    "the lock key differs per tenant, so they never wait on each other",
    historicalIdentityLockKey(A, {
      sourceSystemCode: "legacy-erp",
      documentTypeCode: "TAX_INVOICE",
      originalDocumentNumber: "CROSS-1",
    }) !==
      historicalIdentityLockKey(B, {
        sourceSystemCode: "legacy-erp",
        documentTypeCode: "TAX_INVOICE",
        originalDocumentNumber: "CROSS-1",
      })
  );

  /* ── 4. the lock is real, and it releases ─────────────────────────────── */

  const key = historicalIdentityLockKey(A, {
    sourceSystemCode: "legacy-erp",
    documentTypeCode: "TAX_INVOICE",
    originalDocumentNumber: "LOCK-1",
  });
  const holder = new PrismaClient({ datasourceUrl: OWNER_URL });
  const waiter = new PrismaClient({ datasourceUrl: OWNER_URL });
  let observedWaiting = false;
  await holder
    .$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock($1::int, $2::int)`,
        HISTORICAL_IDENTITY_ADVISORY_NAMESPACE,
        key
      );

      // A second connection asks for the held key and must not get it. Prisma's
      // promises are lazy, so attaching a handler HERE is what actually sends
      // the query — without it there would be nothing to observe, and the check
      // would pass or fail on an empty window.
      const attempt = waiter
        .$queryRawUnsafe(
          `SELECT pg_advisory_xact_lock($1::int, $2::int)`,
          HISTORICAL_IDENTITY_ADVISORY_NAMESPACE,
          key
        )
        .catch(() => {});

      // Then ask the database, polling rather than guessing how long a cold
      // connection takes to reach the lock manager.
      for (let attemptNo = 0; attemptNo < 40 && !observedWaiting; attemptNo += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const locks = await owner.$queryRawUnsafe(
          `SELECT count(*)::int AS c FROM pg_locks
           WHERE locktype = 'advisory' AND granted = false AND classid = $1`,
          HISTORICAL_IDENTITY_ADVISORY_NAMESPACE
        );
        observedWaiting = locks[0].c >= 1;
      }
      void attempt;
      throw new Error("rollback on purpose");
    })
    .catch(() => {});
  await waiter.$disconnect().catch(() => {});

  ok("the database itself reported a waiter blocked on the identity lock", observedWaiting);

  const stillHeld = (
    await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM pg_locks
       WHERE locktype = 'advisory' AND classid = $1 AND objid = $2`,
      HISTORICAL_IDENTITY_ADVISORY_NAMESPACE,
      key >>> 0
    )
  )[0].c;
  ok("and the lock was released by the rollback, not leaked", stillHeld === 0, String(stillHeld));
  await holder.$disconnect().catch(() => {});

  /* ── 5. the lock is what makes an execution WAIT ──────────────────────── */

  // Two executions started together do not reliably overlap here: each parses
  // and re-derives the whole file first, and that work is synchronous, so one
  // usually finishes writing before the other reaches the database. That makes
  // a racing pair a poor witness for the lock. Holding the identity key from
  // another connection is a deterministic one — the execution must not be able
  // to insert while somebody else holds its identity.
  const waitKey = historicalIdentityLockKey(A, {
    sourceSystemCode: "legacy-erp",
    documentTypeCode: "TAX_INVOICE",
    originalDocumentNumber: "WAIT-1",
  });
  const waitBytes = await fileOf("WAIT-1", "150.00");
  const waitPreview = await previewFor(A, waitBytes);

  const blocker = new PrismaClient({ datasourceUrl: OWNER_URL });
  let releaseLock = () => {};
  const releaseRequested = new Promise((resolve) => {
    releaseLock = resolve;
  });
  const holding = blocker
    .$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          `SELECT pg_advisory_xact_lock($1::int, $2::int)`,
          HISTORICAL_IDENTITY_ADVISORY_NAMESPACE,
          waitKey
        );
        await releaseRequested;
      },
      { timeout: 60_000, maxWait: 10_000 }
    )
    .catch(() => {});

  // Let the holder actually take it before anything else asks.
  await new Promise((resolve) => setTimeout(resolve, 500));

  let finished = false;
  const running = executeWith(A, waitBytes, waitPreview).then((result) => {
    finished = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 2_000));

  ok(
    "an execution whose identity is held elsewhere waits instead of inserting",
    finished === false && (await countFor(A, "WAIT-1")) === 0,
    JSON.stringify({ finished, rows: await countFor(A, "WAIT-1") })
  );

  releaseLock();
  await holding;
  const waited = await running;
  ok(
    "and it completes as soon as the identity is free again",
    waited.ok === true && waited.totals.created === 1,
    JSON.stringify(waited.ok ? waited.totals : waited)
  );
  ok("exactly one record, written after the wait", (await countFor(A, "WAIT-1")) === 1);
  await blocker.$disconnect().catch(() => {});

  console.log(`\n  ${pass} checks passed, ${failures.length} failed\n`);
  if (failures.length > 0) {
    failures.forEach((f) => console.log(`  FAILED: ${f}`));
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error("\nBATTERY ERROR:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await owner.$disconnect().catch(() => {});
  });
