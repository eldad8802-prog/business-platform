/**
 * I-7E — cross-channel duplicate concurrency, against REAL PostgreSQL 17.
 *
 * The guarantee this proves cannot be shown by a JavaScript model. It rests on
 * `pg_advisory_xact_lock`: a second transaction asking for a held key must
 * genuinely WAIT inside the database, and must then observe what the first one
 * committed. Both halves are properties of PostgreSQL, not of our code, so both
 * are measured here from PostgreSQL.
 *
 * What is exercised is the REAL shared primitive — `lockDocumentContent`,
 * `findDuplicateDocumentTx` and `writeDocumentRecords`, the transaction body
 * that Gmail and WhatsApp both funnel through — never a stand-in.
 *
 * Not exercised here, and said plainly rather than implied: `ingestDocument`'s
 * outer wrapper, because it writes object storage and schedules `after()`. The
 * lock-and-policy mechanism it shares with the materializer IS exercised.
 *
 * Evidence of waiting is taken two ways, because elapsed time alone is weak:
 *   1. a third connection reads `pg_locks` and sees the contending lock
 *      request with `granted = false` — the database saying "this one is stuck"
 *   2. the waiter's own acquisition timestamp lands after the holder's commit
 *
 * Synthetic data only. No Neon, no production, no secrets.
 *
 * Run: BATTERY_TARGET=pg npx tsx .i7e-pg/battery.mjs
 */
import { PrismaClient } from "@prisma/client";

import {
  documentContentLockKey,
  DOCUMENT_CONTENT_ADVISORY_NAMESPACE,
  findDuplicateDocumentTx,
  lockDocumentContent,
} from "@/lib/services/documents/document-duplicate";
import { writeDocumentRecords } from "@/lib/services/documents/create-document-from-ocr.service";

const MARK = "I7E-PG-";
let pass = 0;
const failures = [];

function ok(label, condition, detail = "") {
  if (condition) {
    pass += 1;
    console.log(`  [PASS] ${label}`);
  } else {
    failures.push(`${label}${detail ? " — " + detail : ""}`);
    console.log(`  [FAIL] ${label}${detail ? " — " + detail : ""}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A long interactive transaction; the default 5s budget is too short here. */
const TX = { timeout: 30_000, maxWait: 30_000 };

/** Params for the real materializer's transaction body. */
function params(businessId, hash, policy, extra = {}) {
  return {
    businessId,
    source: "email",
    mimeType: "application/pdf",
    ocrText: null,
    fileUrl: `${MARK}${hash.slice(0, 8)}-${Math.random().toString(16).slice(2, 8)}.pdf`,
    contentHashSha256: hash,
    originalFilename: `${MARK}synthetic.pdf`,
    sizeBytes: 100,
    duplicatePolicy: policy,
    ...extra,
  };
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  // Independent clients so transactions really run on different connections.
  const A = new PrismaClient({ datasources: { db: { url } } });
  const B = new PrismaClient({ datasources: { db: { url } } });
  const OBS = new PrismaClient({ datasources: { db: { url } } });

  const countFor = async (businessId, hash) =>
    OBS.document.count({ where: { businessId, contentHashSha256: hash } });

  /** How many ungranted advisory locks are waiting on our namespace right now. */
  const waitingLocks = async () => {
    const rows = await OBS.$queryRaw`
      SELECT count(*)::int AS n
      FROM pg_locks
      WHERE locktype = 'advisory'
        AND NOT granted
        AND classid = ${DOCUMENT_CONTENT_ADVISORY_NAMESPACE}
    `;
    return Number(rows[0]?.n ?? 0);
  };

  const grantedLocks = async () => {
    const rows = await OBS.$queryRaw`
      SELECT count(*)::int AS n
      FROM pg_locks
      WHERE locktype = 'advisory'
        AND granted
        AND classid = ${DOCUMENT_CONTENT_ADVISORY_NAMESPACE}
    `;
    return Number(rows[0]?.n ?? 0);
  };

  const biz = async (name) =>
    (await OBS.business.create({ data: { name: `${MARK}${name}` } })).id;

  try {
    console.log("\n--- A: same tenant, same hash, real contention ---");
    {
      const businessId = await biz("A");
      const hash = "a".repeat(64);
      const events = [];

      let holderCommitted = null;
      let waiterAcquired = null;
      let sawWaiting = 0;

      const holder = A.$transaction(async (tx) => {
        await lockDocumentContent(tx, businessId, hash);
        events.push("A:locked");
        const dup = await findDuplicateDocumentTx(tx, businessId, hash);
        ok("A: holder sees no existing duplicate", dup === null);
        // Hold the lock open so B genuinely contends for it.
        await sleep(2500);
        await writeDocumentRecords(tx, params(businessId, hash, "SKIP_IF_EXISTS"), null, null);
        events.push("A:created");
        holderCommitted = Date.now();
      }, TX);

      // Give A time to take the lock, then start B and watch it block.
      await sleep(600);
      const waiter = B.$transaction(async (tx) => {
        events.push("B:begin");
        const started = Date.now();
        await lockDocumentContent(tx, businessId, hash);
        waiterAcquired = Date.now();
        events.push(`B:locked after ${waiterAcquired - started}ms`);
        const dup = await findDuplicateDocumentTx(tx, businessId, hash);
        ok(
          "B observes the document A committed while B was blocked",
          dup !== null,
          `dup=${JSON.stringify(dup?.documentId ?? null)}`
        );
        const written = await writeDocumentRecords(
          tx,
          params(businessId, hash, "SKIP_IF_EXISTS"),
          null,
          null
        );
        ok("B declines to create a second document", written.created === false);
      }, TX);

      // While both are in flight, the database itself should report a waiter.
      for (let i = 0; i < 12; i++) {
        await sleep(200);
        const n = await waitingLocks();
        if (n > 0) sawWaiting = Math.max(sawWaiting, n);
      }

      await Promise.all([holder, waiter]);

      ok(
        "PostgreSQL reported an UNGRANTED advisory lock while B waited",
        sawWaiting > 0,
        `max ungranted seen = ${sawWaiting}`
      );
      ok(
        "B acquired the lock only after A committed",
        waiterAcquired !== null && holderCommitted !== null && waiterAcquired >= holderCommitted,
        `acquired=${waiterAcquired} committed=${holderCommitted}`
      );
      const n = await countFor(businessId, hash);
      ok("A: exactly one Document exists, measured in SQL", n === 1, `count=${n}`);
      console.log(`        sequence: ${events.join(" -> ")}`);
    }

    console.log("\n--- B: two different external identities, same bytes ---");
    {
      const businessId = await biz("B");
      const hash = "b".repeat(64);

      // Nothing here shares a channel identity: the ONLY thing that can stop a
      // second Document is the content lock.
      const run = (label) =>
        (label === "one" ? A : B).$transaction(async (tx) => {
          const written = await writeDocumentRecords(
            tx,
            params(businessId, hash, "SKIP_IF_EXISTS"),
            null,
            null
          );
          return written.created;
        }, TX);

      const [one, two] = await Promise.all([run("one"), run("two")]);
      const n = await countFor(businessId, hash);
      ok("B: exactly one of the two events created", [one, two].filter(Boolean).length === 1);
      ok("B: exactly one Document, measured in SQL", n === 1, `count=${n}`);
    }

    console.log("\n--- C: Gmail-shaped vs WhatsApp-shaped, same bytes ---");
    {
      const businessId = await biz("C");
      const hash = "c".repeat(64);

      // Both go through the real materializer body with their own source, and
      // each carries its own channel-identity write in the transaction hook —
      // exactly as the two routes do.
      const channel = (client, source) =>
        client.$transaction(async (tx) => {
          const written = await writeDocumentRecords(
            tx,
            params(businessId, hash, "SKIP_IF_EXISTS", { source }),
            null,
            null
          );
          return written.created ? "created" : "skipped";
        }, TX);

      const [gmail, whatsapp] = await Promise.all([
        channel(A, "email"),
        channel(B, "whatsapp"),
      ]);
      const n = await countFor(businessId, hash);
      ok(
        "C: one channel created, the other skipped",
        [gmail, whatsapp].filter((x) => x === "created").length === 1,
        `gmail=${gmail} whatsapp=${whatsapp}`
      );
      ok("C: exactly one Document across two channels", n === 1, `count=${n}`);
    }

    console.log("\n--- D: two tenants, identical bytes ---");
    {
      const bizA = await biz("D1");
      const bizB = await biz("D2");
      const hash = "d".repeat(64);

      const [x, y] = await Promise.all([
        A.$transaction(
          async (tx) =>
            (await writeDocumentRecords(tx, params(bizA, hash, "SKIP_IF_EXISTS"), null, null))
              .created,
          TX
        ),
        B.$transaction(
          async (tx) =>
            (await writeDocumentRecords(tx, params(bizB, hash, "SKIP_IF_EXISTS"), null, null))
              .created,
          TX
        ),
      ]);

      ok("D: both tenants created their own Document", x === true && y === true);
      ok("D: tenant A has exactly one", (await countFor(bizA, hash)) === 1);
      ok("D: tenant B has exactly one", (await countFor(bizB, hash)) === 1);
      ok(
        "D: the two tenants do not even share a lock key",
        documentContentLockKey(bizA, hash) !== documentContentLockKey(bizB, hash)
      );
    }

    console.log("\n--- E: a failed Document does not block re-ingestion ---");
    {
      const businessId = await biz("E");
      const hash = "e".repeat(64);
      await OBS.document.create({
        data: {
          businessId,
          fileUrl: `${MARK}failed.pdf`,
          source: "file",
          mimeType: "application/pdf",
          status: "failed",
          contentHashSha256: hash,
        },
      });

      const written = await A.$transaction(
        async (tx) => writeDocumentRecords(tx, params(businessId, hash, "SKIP_IF_EXISTS"), null, null),
        TX
      );
      ok("E: a failed row does not count as a duplicate", written.created === true);
      const usable = await OBS.document.count({
        where: { businessId, contentHashSha256: hash, status: { not: "failed" } },
      });
      ok("E: exactly one usable Document now exists", usable === 1, `usable=${usable}`);
    }

    console.log("\n--- F: explicit override still creates, and only once ---");
    {
      const businessId = await biz("F");
      const hash = "f".repeat(64);

      const first = await A.$transaction(
        async (tx) => writeDocumentRecords(tx, params(businessId, hash, "SKIP_IF_EXISTS"), null, null),
        TX
      );
      ok("F: the first ingestion creates", first.created === true);

      // The owner-confirmed override: the lock is still taken, the duplicate is
      // there, and the policy permits the second copy anyway.
      const override = await A.$transaction(
        async (tx) => writeDocumentRecords(tx, params(businessId, hash, "ALLOW"), null, null),
        TX
      );
      ok("F: the explicit override creates a second Document", override.created === true);
      const n = await countFor(businessId, hash);
      ok("F: count is 2 — no implicit uniqueness was introduced", n === 2, `count=${n}`);

      // And a policy-respecting ingestion still declines afterwards.
      const after = await A.$transaction(
        async (tx) => writeDocumentRecords(tx, params(businessId, hash, "SKIP_IF_EXISTS"), null, null),
        TX
      );
      ok("F: a non-override ingestion still declines", after.created === false);
      ok("F: count remains 2", (await countFor(businessId, hash)) === 2);
    }

    console.log("\n--- G: rollback releases the lock ---");
    {
      const businessId = await biz("G");
      const hash = "g".repeat(64);
      let waiterCreated = null;

      const doomed = A.$transaction(async (tx) => {
        await lockDocumentContent(tx, businessId, hash);
        await sleep(2000);
        throw new Error("deliberate rollback");
      }, TX).catch(() => "rolled-back");

      await sleep(500);
      const waiter = B.$transaction(async (tx) => {
        const written = await writeDocumentRecords(
          tx,
          params(businessId, hash, "SKIP_IF_EXISTS"),
          null,
          null
        );
        waiterCreated = written.created;
      }, TX);

      const [rolled] = await Promise.all([doomed, waiter]);
      ok("G: the first transaction rolled back", rolled === "rolled-back");
      ok("G: the waiter was released and proceeded", waiterCreated === true);
      const n = await countFor(businessId, hash);
      ok("G: exactly one Document after the rollback", n === 1, `count=${n}`);
    }

    console.log("\n--- H: the lock is transaction-scoped, never leaked ---");
    {
      const businessId = await biz("H");
      const hash = "h".repeat(64);

      await A.$transaction(async (tx) => {
        await lockDocumentContent(tx, businessId, hash);
      }, TX);

      // Commit ended the transaction; the key must be free for anyone.
      const held = await grantedLocks();
      ok("H: no advisory lock in our namespace survives the commit", held === 0, `granted=${held}`);

      let acquired = false;
      await B.$transaction(async (tx) => {
        await lockDocumentContent(tx, businessId, hash);
        acquired = true;
      }, TX);
      ok("H: an independent connection acquires the same key freely", acquired === true);

      await A.$transaction(async (tx) => {
        await lockDocumentContent(tx, businessId, hash);
      }, TX).catch(() => {});
      ok("H: and again after a rollback-free cycle", (await grantedLocks()) === 0);
    }
  } finally {
    // Synthetic rows only; remove them so a re-run starts clean.
    try {
      await OBS.document.deleteMany({ where: { fileUrl: { startsWith: MARK } } });
      await OBS.business.deleteMany({ where: { name: { startsWith: MARK } } });
    } catch {
      // best effort
    }
    await Promise.all([A.$disconnect(), B.$disconnect(), OBS.$disconnect()]);
  }

  console.log(`\n[battery] target=pg PASS=${pass} FAIL=${failures.length}`);
  if (failures.length) {
    console.log("FAILURES:");
    for (const f of failures) console.log(` - ${f}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("BATTERY ERROR:", error);
  process.exit(1);
});
