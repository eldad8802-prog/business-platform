/**
 * I-7D — Documents export verifier.
 *
 * NO database and NO network.
 *
 * # Why this opens the archive instead of trusting the builder
 *
 * The promise this increment makes is that the owner receives THEIR ORIGINAL
 * FILES. Asserting that the code appends a buffer proves nothing about what an
 * archive tool will pull out the other end, so every test below builds a real
 * ZIP, parses it back through the central directory, and compares hashes with
 * the bytes that went in. The index is likewise read back through the real XLSX
 * reader rather than inspected as a spec object.
 *
 * The ZIP reader here is deliberately hand-rolled over `node:zlib` rather than
 * pulling in a package: the only zip libraries present are transitive
 * dependencies of ExcelJS, and a verifier that guards an archive format should
 * not itself depend on something nothing declares.
 *
 * Run: npx tsx lib/data-transfer/documents/documents-export.verify.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";

import {
  ARCHIVE_FILES_DIR,
  buildArchiveEntryName,
  buildDocumentsExport,
  CANONICAL_EXPORT_PORTS,
  DOCUMENT_INDEX_COLUMNS,
  DOCUMENT_INDEX_SHEET,
  DOCUMENTS_EXPORT_MAX_FILES,
  DOCUMENTS_EXPORT_MAX_TOTAL_BYTES,
  DocumentsExportTooLargeError,
  extensionForMime,
  fileKindLabel,
  NoDocumentsToExportError,
  sanitizeArchiveBaseName,
  sourceLabel,
  statusLabel,
  type DocumentsExportPorts,
  type ExportRow,
} from "@/lib/data-transfer/documents/documents-export";
import { readXlsxTable } from "@/lib/data-transfer/format/xlsx-reader";
import { readDocumentObject } from "@/lib/services/documents/document-storage.service";

let passed = 0;
function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(fn()).then(() => {
    passed += 1;
    console.log(`  ok  ${label}`);
  });
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/**
 * Read a source file with line endings normalised.
 *
 * `core.autocrlf` rewrites the working tree to CRLF on checkout, so a
 * multi-line assertion written against LF silently stops matching after a
 * rebase — on code that never changed. Normalising here keeps these
 * assertions about the code rather than about the checkout.
 */
function readSource(path: string): string {
  return fs.readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

/* =========================== a real ZIP reader ========================== */

/** Parse the central directory, so the result is what a tool would extract. */
function readZip(zip: Buffer): Map<string, Buffer> {
  // End of central directory: signature 0x06054b50, scanned from the tail.
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip: no end-of-central-directory");

  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();

  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error("bad central header");
    const method = zip.readUInt16LE(p + 10);
    const compressedSize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localOffset = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString("utf8");

    // Local header: the extra field length can differ from the central one.
    const lNameLen = zip.readUInt16LE(localOffset + 26);
    const lExtraLen = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = zip.subarray(dataStart, dataStart + compressedSize);

    out.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/* ============================== fixtures =============================== */

const pdf = (tag: string) =>
  Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from(tag.repeat(40))]);
const jpeg = (tag: string) =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(tag.repeat(40))]);
const png = (tag: string) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(tag.repeat(40)),
  ]);

const BUSINESS = 7;
const OTHER = 8;

function row(over: Partial<ExportRow> & { id: number }): ExportRow {
  return {
    fileUrl: `doc-${over.id}.pdf`,
    mimeType: "application/pdf",
    status: "needs_review",
    source: "file",
    originalFilename: `file-${over.id}.pdf`,
    createdAt: new Date("2026-08-14T09:00:00Z"),
    vendorName: null,
    amount: null,
    documentDate: null,
    category: null,
    ...over,
  };
}

/** A world of documents and stored objects, keyed by tenant. */
function makePorts(
  world: {
    rows: Record<number, ExportRow[]>;
    objects: Record<number, Record<string, Buffer>>;
    throwOn?: string;
  }
): DocumentsExportPorts {
  return {
    readRows: async (businessId) => world.rows[businessId] ?? [],
    readObject: async (businessId, basename) => {
      if (world.throwOn === basename) throw new Error("storage unavailable");
      const bytes = world.objects[businessId]?.[basename];
      if (!bytes) {
        const { StorageObjectNotFoundError } = await import(
          "@/lib/storage/storage.errors"
        );
        throw new StorageObjectNotFoundError(`biz/${businessId}/documents/${basename}`);
      }
      return bytes;
    },
  };
}

async function indexOf(zip: Map<string, Buffer>) {
  const workbook = zip.get("index.xlsx");
  assert.ok(workbook, "the archive carries an index");
  return readXlsxTable(workbook);
}

async function main() {
  /* ========================= 1. what comes out ========================= */

  console.log("\n1. The archive an owner actually opens");

  await check("a mixed batch produces the originals plus one index", async () => {
    const objects = {
      "a.pdf": pdf("a"),
      "b.jpg": jpeg("b"),
      "c.png": png("c"),
    };
    const result = await buildDocumentsExport(
      { businessId: BUSINESS, at: new Date("2026-09-07T10:00:00Z") },
      makePorts({
        rows: {
          [BUSINESS]: [
            row({ id: 1, fileUrl: "a.pdf", originalFilename: "חשבונית ספק.pdf" }),
            row({ id: 2, fileUrl: "b.jpg", mimeType: "image/jpeg", originalFilename: "receipt.jpg" }),
            row({ id: 3, fileUrl: "c.png", mimeType: "image/png", originalFilename: null }),
          ],
        },
        objects: { [BUSINESS]: objects },
      })
    );

    const zip = readZip(result.body);
    const names = [...zip.keys()].sort();
    assert.equal(names.filter((n) => n.startsWith(`${ARCHIVE_FILES_DIR}/`)).length, 3);
    assert.equal(zip.has("index.xlsx"), true);
    assert.equal(zip.has("MISSING-FILES.txt"), false, "nothing was missing");
    assert.equal(result.summary.included, 3);
    assert.equal(result.summary.missing, 0);
    assert.equal(result.filename, "dubiz-documents-2026-09-07.zip");
    assert.equal(result.contentType, "application/zip");
  });

  await check("FIDELITY — every extracted file is byte-identical to what was stored", async () => {
    const stored = {
      "a.pdf": pdf("alpha"),
      "b.jpg": jpeg("beta"),
      "c.png": png("gamma"),
    };
    const result = await buildDocumentsExport(
      { businessId: BUSINESS },
      makePorts({
        rows: {
          [BUSINESS]: [
            row({ id: 1, fileUrl: "a.pdf" }),
            row({ id: 2, fileUrl: "b.jpg", mimeType: "image/jpeg" }),
            row({ id: 3, fileUrl: "c.png", mimeType: "image/png" }),
          ],
        },
        objects: { [BUSINESS]: stored },
      })
    );

    const zip = readZip(result.body);
    const extracted = [...zip.entries()].filter(([n]) =>
      n.startsWith(`${ARCHIVE_FILES_DIR}/`)
    );
    assert.equal(extracted.length, 3);
    const storedHashes = new Set(Object.values(stored).map(sha));
    for (const [name, bytes] of extracted) {
      assert.equal(storedHashes.has(sha(bytes)), true, `${name} is not an original`);
    }
    // and the extension follows the stored type, not the uploader's name
    assert.equal(extracted.some(([n]) => n.endsWith(".pdf")), true);
    assert.equal(extracted.some(([n]) => n.endsWith(".jpg")), true);
    assert.equal(extracted.some(([n]) => n.endsWith(".png")), true);
  });

  await check("an empty selection is refused rather than shipped as an empty archive", async () => {
    await assert.rejects(
      () =>
        buildDocumentsExport(
          { businessId: BUSINESS },
          makePorts({ rows: {}, objects: {} })
        ),
      NoDocumentsToExportError
    );
  });

  /* ========================== 2. the index ============================ */

  console.log("\n2. The index, as a spreadsheet");

  await check("the sheet is Hebrew, right-to-left, and one row per document", async () => {
    const result = await buildDocumentsExport(
      { businessId: BUSINESS },
      makePorts({
        rows: {
          [BUSINESS]: [
            row({
              id: 1,
              fileUrl: "a.pdf",
              originalFilename: "חשבונית.pdf",
              status: "approved",
              source: "email",
              vendorName: "ספק בע\"מ",
              amount: 1234.5,
              documentDate: new Date("2026-07-01T00:00:00Z"),
              category: "ציוד",
            }),
            row({ id: 2, fileUrl: "b.pdf" }),
          ],
        },
        objects: { [BUSINESS]: { "a.pdf": pdf("a"), "b.pdf": pdf("b") } },
      })
    );

    const table = await indexOf(readZip(result.body));
    assert.equal(table.sheetName, DOCUMENT_INDEX_SHEET);
    assert.deepEqual(
      table.headers,
      DOCUMENT_INDEX_COLUMNS.map((c) => c.header)
    );
    assert.equal(table.rows.length, 2, "one row per document");
    const first = table.rows[0];
    assert.equal(String(first[1]), "חשבונית.pdf");
    assert.equal(String(first[5]), 'ספק בע"מ');
    assert.equal(Number(first[6]), 1234.5);
    assert.equal(String(first[8]), "אושר");
    assert.equal(String(first[9]), 'דוא"ל');
    assert.equal(String(first[10]), "כן");
  });

  await check("the index exposes nothing internal", async () => {
    const result = await buildDocumentsExport(
      { businessId: BUSINESS },
      makePorts({
        rows: {
          [BUSINESS]: [
            // The filename deliberately carries NONE of the internal values, so
            // a hit below is a real leak and not the fixture describing itself.
            row({ id: 4242, fileUrl: "secret-object-key.pdf", originalFilename: "invoice.pdf" }),
          ],
        },
        objects: { [BUSINESS]: { "secret-object-key.pdf": pdf("x") } },
      })
    );
    const zip = readZip(result.body);
    const table = await indexOf(zip);
    const text = JSON.stringify([table.headers, table.rows]);
    for (const leak of ["4242", "secret-object-key", "biz/"]) {
      assert.equal(text.includes(leak), false, `index leaks: ${leak}`);
    }
    // and no archive entry name carries the storage basename either
    for (const name of zip.keys()) {
      assert.equal(name.includes("secret-object-key"), false);
    }
  });

  await check("a value that looks like a formula stays text", async () => {
    const result = await buildDocumentsExport(
      { businessId: BUSINESS },
      makePorts({
        rows: {
          [BUSINESS]: [
            row({
              id: 1,
              fileUrl: "a.pdf",
              originalFilename: "=1+1.pdf",
              vendorName: "=SUM(A1:A9)",
              category: "@cmd",
            }),
          ],
        },
        objects: { [BUSINESS]: { "a.pdf": pdf("a") } },
      })
    );
    const table = await indexOf(readZip(result.body));
    const cells = table.rows[0];
    assert.equal(String(cells[5]), "=SUM(A1:A9)", "kept as the literal text");
    assert.equal(String(cells[7]), "@cmd");
    // ExcelJS returns { formula } for a real formula cell; a string is a string.
    for (const cell of cells) {
      assert.equal(
        typeof cell === "object" && cell !== null && "formula" in (cell as object),
        false,
        "no live formula cell"
      );
    }
  });

  /* ======================== 3. entry filenames ======================== */

  console.log("\n3. Archive entry names cannot escape or collide");

  await check("path separators, traversal and absolute names are stripped", () => {
    for (const hostile of [
      "../evil.pdf",
      "../../../../etc/passwd",
      "/absolute/evil.pdf",
      "C:\\Windows\\System32\\evil.pdf",
      "..\\..\\evil.pdf",
      "....//evil.pdf",
    ]) {
      const base = sanitizeArchiveBaseName(hostile);
      assert.equal(base.includes("/"), false, hostile);
      assert.equal(base.includes("\\"), false, hostile);
      assert.equal(base.startsWith("."), false, hostile);
      assert.equal(base.includes(".."), false, hostile);
    }
  });

  await check("control characters and reserved characters never survive", () => {
    const base = sanitizeArchiveBaseName('a\u0000b\u001fc\u007fd<e>f:g"h|i?j*k.pdf');
    for (const ch of ["\u0000", "\u001f", "\u007f", "<", ">", ":", '"', "|", "?", "*"]) {
      assert.equal(base.includes(ch), false, JSON.stringify(ch));
    }
  });

  await check("a Hebrew filename with spaces survives intact", () => {
    const base = sanitizeArchiveBaseName("חשבונית ספק אוגוסט.pdf");
    assert.equal(base, "חשבונית ספק אוגוסט");
  });

  await check("a very long name is truncated, and an empty one still yields a name", () => {
    const long = sanitizeArchiveBaseName("x".repeat(500) + ".pdf");
    assert.equal(long.length <= 60, true);
    const taken = new Set<string>();
    const name = buildArchiveEntryName({
      uploadedAt: new Date("2026-08-14T09:00:00Z"),
      originalFilename: null,
      mimeType: "application/pdf",
      taken,
    });
    assert.equal(name, "2026-08-14.pdf");
  });

  await check("identical names are given distinct entries, never overwritten", () => {
    const taken = new Set<string>();
    const args = {
      uploadedAt: new Date("2026-08-14T09:00:00Z"),
      originalFilename: "חשבונית.pdf",
      mimeType: "application/pdf",
      taken,
    };
    const a = buildArchiveEntryName({ ...args, taken });
    const b = buildArchiveEntryName({ ...args, taken });
    const c = buildArchiveEntryName({ ...args, taken });
    assert.notEqual(a, b);
    assert.notEqual(b, c);
    assert.equal(new Set([a, b, c]).size, 3);
    assert.equal(b.includes("_2."), true);
  });

  await check("duplicate names in a real archive stay separate files", async () => {
    const result = await buildDocumentsExport(
      { businessId: BUSINESS },
      makePorts({
        rows: {
          [BUSINESS]: [
            row({ id: 1, fileUrl: "a.pdf", originalFilename: "חשבונית.pdf" }),
            row({ id: 2, fileUrl: "b.pdf", originalFilename: "חשבונית.pdf" }),
          ],
        },
        objects: { [BUSINESS]: { "a.pdf": pdf("one"), "b.pdf": pdf("two") } },
      })
    );
    const zip = readZip(result.body);
    const files = [...zip.entries()].filter(([n]) => n.startsWith(`${ARCHIVE_FILES_DIR}/`));
    assert.equal(files.length, 2, "both survived");
    assert.notEqual(sha(files[0][1]), sha(files[1][1]), "and they are different files");
  });

  await check("every entry sits under the ASCII directory, with no traversal", async () => {
    const result = await buildDocumentsExport(
      { businessId: BUSINESS },
      makePorts({
        rows: { [BUSINESS]: [row({ id: 1, fileUrl: "a.pdf", originalFilename: "../../evil.pdf" })] },
        objects: { [BUSINESS]: { "a.pdf": pdf("a") } },
      })
    );
    for (const name of readZip(result.body).keys()) {
      assert.equal(name.includes(".."), false, name);
      assert.equal(name.startsWith("/"), false, name);
      assert.equal(name.includes("\\"), false, name);
      assert.equal(/^[\w./\u0590-\u05FF -]+$/.test(name), true, name);
    }
  });

  /* ====================== 4. missing and failing ====================== */

  console.log("\n4. A short archive says so");

  await check("a missing object is reported, never silently dropped", async () => {
    const result = await buildDocumentsExport(
      { businessId: BUSINESS },
      makePorts({
        rows: {
          [BUSINESS]: [
            row({ id: 1, fileUrl: "here.pdf" }),
            row({ id: 2, fileUrl: "gone.pdf", originalFilename: "אבוד.pdf" }),
          ],
        },
        objects: { [BUSINESS]: { "here.pdf": pdf("h") } },
      })
    );

    assert.equal(result.summary.total, 2);
    assert.equal(result.summary.included, 1);
    assert.equal(result.summary.missing, 1);

    const zip = readZip(result.body);
    assert.equal(
      [...zip.keys()].filter((n) => n.startsWith(`${ARCHIVE_FILES_DIR}/`)).length,
      1,
      "no broken entry was written"
    );
    const manifest = zip.get("MISSING-FILES.txt");
    assert.ok(manifest, "a manifest names what is absent");
    assert.equal(manifest!.toString("utf8").includes("אבוד"), true);

    const table = await indexOf(zip);
    const missingRow = table.rows.find((r) => String(r[1]) === "אבוד.pdf");
    assert.ok(missingRow);
    assert.equal(String(missingRow![10]).startsWith("לא"), true, "the index says so too");
    // The writer stores an empty string as an EMPTY cell, which reads back as
    // null — either way the owner sees a blank, which is the point.
    assert.equal(
      missingRow![0] == null || missingRow![0] === "",
      true,
      "and offers no archive name"
    );
  });

  await check("a transient storage failure fails the export instead of shipping it short", async () => {
    await assert.rejects(
      () =>
        buildDocumentsExport(
          { businessId: BUSINESS },
          makePorts({
            rows: { [BUSINESS]: [row({ id: 1, fileUrl: "flaky.pdf" })] },
            objects: { [BUSINESS]: {} },
            throwOn: "flaky.pdf",
          })
        ),
      /storage unavailable/
    );
  });

  /* ============================= 5. limits ============================ */

  console.log("\n5. Limits refuse before an archive is built");

  await check("exactly the file ceiling is allowed", async () => {
    const rows = Array.from({ length: DOCUMENTS_EXPORT_MAX_FILES }, (_, i) =>
      row({ id: i + 1, fileUrl: `f${i}.pdf` })
    );
    const objects: Record<string, Buffer> = {};
    for (let i = 0; i < rows.length; i++) objects[`f${i}.pdf`] = pdf("x");
    const result = await buildDocumentsExport(
      { businessId: BUSINESS },
      makePorts({ rows: { [BUSINESS]: rows }, objects: { [BUSINESS]: objects } })
    );
    assert.equal(result.summary.included, DOCUMENTS_EXPORT_MAX_FILES);
  });

  await check("one over the ceiling is refused, and reads no objects", async () => {
    const rows = Array.from({ length: DOCUMENTS_EXPORT_MAX_FILES + 1 }, (_, i) =>
      row({ id: i + 1, fileUrl: `f${i}.pdf` })
    );
    let reads = 0;
    const ports: DocumentsExportPorts = {
      readRows: async () => rows,
      readObject: async () => {
        reads += 1;
        return pdf("x");
      },
    };
    await assert.rejects(
      () => buildDocumentsExport({ businessId: BUSINESS }, ports),
      DocumentsExportTooLargeError
    );
    assert.equal(reads, 0, "refused before touching storage");
  });

  await check("the cumulative byte ceiling stops a large archive", async () => {
    // Two files that individually pass and together do not.
    const half = Buffer.concat([
      Buffer.from("%PDF-1.7\n"),
      Buffer.alloc(Math.floor(DOCUMENTS_EXPORT_MAX_TOTAL_BYTES * 0.6), 1),
    ]);
    const ports: DocumentsExportPorts = {
      readRows: async () => [
        row({ id: 1, fileUrl: "big1.pdf" }),
        row({ id: 2, fileUrl: "big2.pdf" }),
      ],
      readObject: async () => half,
    };
    await assert.rejects(
      () => buildDocumentsExport({ businessId: BUSINESS }, ports),
      (e: unknown) =>
        e instanceof DocumentsExportTooLargeError && e.reason === "TOO_LARGE"
    );
  });

  /* ============================= 6. tenant ============================ */

  console.log("\n6. One business cannot reach another");

  await check("identical filenames and bytes in two tenants do not cross", async () => {
    const shared = pdf("identical-bytes");
    const world = {
      rows: {
        [BUSINESS]: [row({ id: 1, fileUrl: "same.pdf", originalFilename: "חשבונית.pdf" })],
        [OTHER]: [row({ id: 2, fileUrl: "same.pdf", originalFilename: "חשבונית.pdf" })],
      },
      objects: {
        [BUSINESS]: { "same.pdf": shared },
        [OTHER]: { "same.pdf": Buffer.concat([shared, Buffer.from("OTHER-TENANT")]) },
      },
    };

    const mine = await buildDocumentsExport({ businessId: BUSINESS }, makePorts(world));
    const theirs = await buildDocumentsExport({ businessId: OTHER }, makePorts(world));

    const mineFile = [...readZip(mine.body).entries()].find(([n]) =>
      n.startsWith(`${ARCHIVE_FILES_DIR}/`)
    )![1];
    const theirsFile = [...readZip(theirs.body).entries()].find(([n]) =>
      n.startsWith(`${ARCHIVE_FILES_DIR}/`)
    )![1];

    assert.equal(sha(mineFile), sha(shared), "each tenant got its own bytes");
    assert.notEqual(sha(mineFile), sha(theirsFile));
    assert.equal(mineFile.toString("latin1").includes("OTHER-TENANT"), false);
  });

  await check("the storage read is always scoped by the requesting business", async () => {
    const seen: number[] = [];
    const ports: DocumentsExportPorts = {
      readRows: async () => [row({ id: 1, fileUrl: "a.pdf" })],
      readObject: async (businessId) => {
        seen.push(businessId);
        return pdf("a");
      },
    };
    await buildDocumentsExport({ businessId: BUSINESS }, ports);
    assert.deepEqual(seen, [BUSINESS]);
  });

  /* =========================== 7. structural ========================== */

  console.log("\n7. Wiring, boundaries and mutation");

  const engineSrc = readSource("lib/data-transfer/documents/documents-export.ts");
  const routeSrc = readSource("app/api/data-transfer/documents/export/route.ts");
  function stripComments(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .split("\n")
      .map((line) => {
        const i = line.indexOf("//");
        if (i < 0) return line;
        const before = line.slice(0, i);
        return (before.match(/["']/g) ?? []).length % 2 === 0 ? before : line;
      })
      .join("\n");
  }
  const engineCode = stripComments(engineSrc);
  const routeCode = stripComments(routeSrc);

  await check("the canonical ports ARE the canonical implementations", () => {
    assert.equal(CANONICAL_EXPORT_PORTS.readObject, readDocumentObject);
    assert.equal(typeof CANONICAL_EXPORT_PORTS.readRows, "function");
  });

  await check("MUTATION — the export writes nothing, anywhere", () => {
    // Prisma model writes always take an object literal, so match that shape
    // rather than the bare method name: a hash `.update(buffer)` is not a write,
    // and a scan that cannot tell them apart teaches people to widen it.
    const PRISMA_WRITE =
      /\.(create|update|upsert|delete|createMany|updateMany|deleteMany)\(\s*\{/;
    assert.equal(PRISMA_WRITE.test(engineCode), false, "engine performs a model write");
    assert.equal(PRISMA_WRITE.test(routeCode), false, "route performs a model write");
    for (const forbidden of ["putDocumentObject", "deleteDocumentObject", "$executeRaw"]) {
      assert.equal(engineCode.includes(forbidden), false, `engine: ${forbidden}`);
      assert.equal(routeCode.includes(forbidden), false, `route: ${forbidden}`);
    }
  });

  await check("the export never touches another domain, fiscal least of all", () => {
    for (const forbidden of [
      "billingDocument",
      "BillingDocument",
      "customer.",
      "supplier.",
      "lead.",
      "inventoryItem",
      "reviewEvent",
      "importRun",
      "vendorLearn",
    ]) {
      assert.equal(engineCode.includes(forbidden), false, `engine: ${forbidden}`);
      assert.equal(routeCode.includes(forbidden), false, `route: ${forbidden}`);
    }
  });

  await check("reads are tenant-scoped, paged, and hold no transaction over storage", () => {
    assert.equal(engineCode.includes("runWithTenantContext("), true);
    assert.equal(engineCode.includes("withTenantTransaction("), true);
    assert.equal(engineCode.includes("where: {\n            businessId,"), true);
    assert.equal(engineCode.includes("take: PAGE_SIZE"), true);
    // the storage read must not appear inside the transaction callback
    const txStart = engineCode.indexOf("withTenantTransaction((tx) =>");
    const txEnd = engineCode.indexOf("for (const d of page)");
    assert.equal(
      engineCode.slice(txStart, txEnd).includes("readObject"),
      false,
      "no storage I/O inside a DB transaction"
    );
  });

  await check("the tenant is server-derived and never read from the request", () => {
    assert.equal(routeCode.includes("businessId: user.businessId"), true);
    assert.equal(/body\.businessId/.test(routeCode), false);
    assert.equal(/body\.limit/.test(routeCode), false);
  });

  await check("the HTTP contract is a private, attached zip", () => {
    assert.equal(routeCode.includes('"Content-Type": artifact.contentType'), true);
    assert.equal(routeCode.includes("attachment; filename="), true);
    assert.equal(routeCode.includes('"Cache-Control": "private, no-store"'), true);
    assert.equal(routeCode.includes('export const runtime = "nodejs"'), true);
  });

  await check("the route reuses the shared archive and workbook primitives", () => {
    assert.equal(engineCode.includes("collectArchiveToBuffer"), true);
    assert.equal(engineCode.includes("buildXlsxBuffer"), true);
    assert.equal(engineCode.includes("israelDateStamp"), true);
    // no second zip or xlsx engine
    assert.equal(engineCode.includes("archiver("), false);
    assert.equal(engineCode.includes("ExcelJS"), false);
  });

  await check("the labels are owner-facing, never raw enum values", () => {
    assert.equal(statusLabel("needs_review"), "ממתין לאישור");
    assert.equal(statusLabel("approved"), "אושר");
    assert.equal(statusLabel("processing"), "בעיבוד");
    assert.equal(statusLabel("failed"), "נכשל");
    assert.equal(sourceLabel("file"), "קובץ");
    assert.equal(fileKindLabel("application/pdf"), "PDF");
    assert.equal(extensionForMime("image/jpeg"), "jpg");
  });

  await check("no review state is silently excluded", () => {
    // The read filters on business and date only — never on status.
    const where = engineCode.slice(
      engineCode.indexOf("where: {"),
      engineCode.indexOf("orderBy:")
    );
    assert.equal(where.includes("status"), false, "status must not filter the export");
  });

  await check("the UI offers export beside import, without archive jargon", () => {
    // Comments included, the scan would trip on the docstring that lists the
    // very words the panel must not show an owner.
    const ui = stripComments(
      readSource("components/settings/import-export/DocumentsExportPanel.tsx")
    );
    assert.equal(ui.includes("/api/data-transfer/documents/export"), true);
    assert.equal(ui.includes("קובץ ZIP הכולל את הקבצים המקוריים"), true);
    assert.equal(ui.includes("disabled={working}"), true);
    for (const jargon of ["bucket", "object key", "S3", "archive entry", "blob storage"]) {
      assert.equal(ui.includes(jargon), false, jargon);
    }
    const screen = readSource("components/settings/import-export/DocumentsImportScreen.tsx");
    assert.equal(screen.includes("<DocumentsExportPanel />"), true);
  });

  console.log(`\nI-7D DOCUMENTS EXPORT VERIFY PASS — ${passed} checks green.`);
}

main().catch((error) => {
  console.error("\nFAILED:", error);
  process.exit(1);
});
