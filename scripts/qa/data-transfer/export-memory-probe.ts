/**
 * Export memory probe — measures what the in-memory XLSX/CSV builders actually
 * cost, so `EXPORT_MAX_ROWS_PER_DOMAIN` is a measurement rather than a guess.
 *
 * WHY THIS EXISTS: ExcelJS assembles the whole workbook in memory before a
 * single byte can be written, so an export's peak heap is a function of TOTAL
 * rows, not of page size. A serverless function that exceeds its memory limit
 * is KILLED — the caller sees a truncated connection, not an error. The ceiling
 * has to sit below that cliff, and the only honest way to place it is to
 * measure.
 *
 * Run (an exposed GC gives stable numbers):
 *   NODE_OPTIONS=--expose-gc npx tsx scripts/qa/data-transfer/export-memory-probe.ts
 *
 * READ-ONLY: synthetic rows in memory. No database, no network, no files.
 */
import v8 from "node:v8";
import { buildXlsxBuffer } from "@/lib/data-transfer/format/xlsx-writer";
import { writeCsvBuffer } from "@/lib/data-transfer/format/csv-writer";
import type { SheetCell } from "@/lib/data-transfer/format/table.types";
import type { XlsxColumn } from "@/lib/data-transfer/format/xlsx-writer";

const ROW_COUNTS = [1_000, 5_000, 10_000, 25_000, 50_000, 100_000];

/** Ten columns of realistic Hebrew business data, mixed types. */
const COLUMNS: XlsxColumn[] = [
  { header: "שם", type: "text", width: 28 },
  { header: "טלפון", type: "text", width: 18 },
  { header: "אימייל", type: "text", width: 28 },
  { header: "עיר", type: "text", width: 16 },
  { header: "שם משפטי", type: "text", width: 28 },
  { header: "סוג עוסק", type: "text", width: 16 },
  { header: "מספר עוסק", type: "text", width: 20 },
  { header: "הערות", type: "text", width: 40 },
  { header: "פעיל", type: "text", width: 10 },
  { header: "נוצר בתאריך", type: "date", width: 14 },
];

function makeRows(n: number): SheetCell[][] {
  const rows: SheetCell[][] = new Array(n);
  for (let i = 0; i < n; i++) {
    rows[i] = [
      `לקוח מספר ${i} בע״מ`,
      "050-123-4567",
      `customer${i}@example.co.il`,
      "תל אביב",
      `שם משפטי ארוך יותר ${i}`,
      "עוסק מורשה",
      String(500000000 + i),
      "הערה חופשית באורך סביר על הלקוח הזה",
      "כן",
      new Date(Date.UTC(2026, i % 12, (i % 28) + 1)),
    ];
  }
  return rows;
}

const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;

async function settle(): Promise<void> {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc === "function") gc();
  await new Promise((r) => setTimeout(r, 60));
}

async function main(): Promise<void> {
  const hasGc = typeof (globalThis as { gc?: () => void }).gc === "function";
  console.log(
    `node ${process.version} | heap limit ~${mb(
      v8.getHeapStatistics().heap_size_limit
    )}MB | --expose-gc: ${hasGc ? "yes" : "NO (numbers are noisier)"}\n`
  );

  console.log("rows    | build   | peak heap | artifact | heap/row");
  console.log("--------|---------|-----------|----------|---------");

  for (const count of ROW_COUNTS) {
    await settle();
    const rows = makeRows(count);
    await settle();

    const before = process.memoryUsage().heapUsed;
    let peak = before;
    const sampler = setInterval(() => {
      const used = process.memoryUsage().heapUsed;
      if (used > peak) peak = used;
    }, 15);

    const started = Date.now();
    let buffer: Buffer;
    try {
      buffer = await buildXlsxBuffer({
        name: "לקוחות",
        columns: COLUMNS,
        rows,
        rightToLeft: true,
      });
    } catch (error) {
      clearInterval(sampler);
      console.log(
        `${String(count).padEnd(7)} | FAILED: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      break;
    }
    const elapsed = Date.now() - started;
    clearInterval(sampler);

    const delta = peak - before;
    console.log(
      `${String(count).padEnd(7)} | ${`${elapsed}ms`.padEnd(7)} | ` +
        `${`${mb(delta)}MB`.padEnd(9)} | ${`${mb(buffer.byteLength)}MB`.padEnd(8)} | ` +
        `${Math.round(delta / count)}B`
    );
  }

  console.log("\n--- CSV, same shapes (for comparison) ---");
  console.log("rows    | build   | artifact");
  console.log("--------|---------|---------");
  for (const count of [10_000, 50_000, 100_000]) {
    await settle();
    const rows = makeRows(count);
    const started = Date.now();
    const buffer = writeCsvBuffer(
      COLUMNS.map((c) => c.header),
      rows,
      { delimiter: ";", excelSepDirective: true, eol: "\r\n" }
    );
    console.log(
      `${String(count).padEnd(7)} | ${`${Date.now() - started}ms`.padEnd(7)} | ${mb(
        buffer.byteLength
      )}MB`
    );
  }

  console.log(
    "\nNOTE: peak heap is the DELTA over the already-materialized row array." +
      "\nA real request also holds the source rows, so budget roughly 2x."
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
