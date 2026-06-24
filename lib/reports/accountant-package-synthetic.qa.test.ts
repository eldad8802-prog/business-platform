/**
 * Accountant Package — Phase A synthetic end-to-end QA (no DB, run manually):
 *   npx tsx lib/reports/accountant-package-synthetic.qa.test.ts
 *
 * Drives the REAL Phase A code paths (export ZIP, exceptions report, month
 * close gate, approve guard) against in-memory data: the prisma singleton's
 * delegates are replaced with fakes and source files live in a temp local
 * storage. Nothing touches a real database.
 */

import archiver from "archiver";
import JSZip from "jszip";
import ExcelJS from "exceljs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { prisma } from "@/lib/prisma";
import { resetStorageServiceForTests } from "@/lib/storage";
import { putDocumentObject } from "@/lib/services/documents/document-storage.service";
import { appendAccountantPackToArchive } from "@/lib/reports/accountant-export-zip";
import { computeExceptionsForPeriod } from "@/lib/reports/exceptions-report";
import {
  assertMonthOpen,
  closeMonth,
  computeMonthSnapshotHash,
  getMonthCloseStatus,
  monthRange,
} from "@/lib/services/accounting/month-close.service";
import { ConflictError } from "@/lib/errors";

let failed = 0;
function ok(name: string, condition: boolean, extra?: unknown) {
  if (!condition) {
    console.error("FAIL:", name, extra ?? "");
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

const BUSINESS_ID = 9001;

// ---- in-memory fake state ----
type FakeRecord = {
  id: number;
  amount: number;
  date: Date;
  vendorName: string;
  category: string;
  direction: string;
  document: {
    id: number;
    status: string;
    fileUrl: string | null;
    extractedData: { amountConfidence: string; confidenceScore: number } | null;
  } | null;
};
type FakePending = {
  id: number;
  status: string;
  fileUrl: string | null;
  createdAt: Date;
  extractedData: {
    amount: number | null;
    date: Date | null;
    vendorName: string | null;
    category: string | null;
  } | null;
};

let recordsReturn: FakeRecord[] = [];
let pendingReturn: FakePending[] = [];
const monthCloseStore = new Map<string, Record<string, unknown>>();
const keyOf = (b: number, y: number, m: number) => `${b}-${y}-${m}`;

function installFakePrisma() {
  const p = prisma as unknown as Record<string, unknown>;
  p.financialRecord = { findMany: async () => recordsReturn };
  p.document = { findMany: async () => pendingReturn };
  p.monthClose = {
    findUnique: async ({
      where,
    }: {
      where: { businessId_year_month: { businessId: number; year: number; month: number } };
    }) => {
      const { businessId, year, month } = where.businessId_year_month;
      return monthCloseStore.get(keyOf(businessId, year, month)) ?? null;
    },
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { businessId_year_month: { businessId: number; year: number; month: number } };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => {
      const { businessId, year, month } = where.businessId_year_month;
      const k = keyOf(businessId, year, month);
      const existing = monthCloseStore.get(k);
      const row = existing
        ? { ...existing, ...update }
        : { id: monthCloseStore.size + 1, ...create };
      monthCloseStore.set(k, row);
      return row;
    },
    update: async ({
      where,
      data,
    }: {
      where: { businessId_year_month: { businessId: number; year: number; month: number } };
      data: Record<string, unknown>;
    }) => {
      const { businessId, year, month } = where.businessId_year_month;
      const k = keyOf(businessId, year, month);
      const row = { ...(monthCloseStore.get(k) ?? {}), ...data };
      monthCloseStore.set(k, row);
      return row;
    },
  };
}

function fileName(id: number, ext = "pdf"): string {
  return `doc-${id}-aaaa${String(1000 + id)}.${ext}`;
}

async function putFile(id: number, ext = "pdf") {
  await putDocumentObject({
    businessId: BUSINESS_ID,
    basename: fileName(id, ext),
    body: Buffer.from(`%PDF-synthetic-${id}`),
    contentType: "application/pdf",
    source: "file",
  });
}

function approved(
  id: number,
  amount: number,
  date: Date,
  vendorName: string,
  hasFile: boolean,
  category = "services",
  direction = "expense"
): FakeRecord {
  return {
    id,
    amount,
    date,
    vendorName,
    category,
    direction,
    document: {
      id,
      status: "approved",
      fileUrl: hasFile ? fileName(id) : fileName(id), // path is valid; existence decided by storage
      extractedData: { amountConfidence: "high", confidenceScore: 0.9 },
    },
  };
}

function pending(
  id: number,
  amount: number | null,
  date: Date | null,
  vendorName: string | null
): FakePending {
  return {
    id,
    status: "pending",
    fileUrl: fileName(id),
    createdAt: new Date(2026, 5, 1),
    extractedData: { amount, date, vendorName, category: "services" },
  };
}

async function buildAccountantZip(body: {
  type: "month" | "quarter" | "year";
  month?: string;
  year?: string;
  quarter?: string;
  categories?: string[];
}): Promise<Buffer> {
  const archive = archiver("zip", { zlib: { level: 9 } });
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on("data", (c) => chunks.push(Buffer.from(c)));
  const done = new Promise<void>((resolve, reject) => {
    sink.on("finish", () => resolve());
    sink.on("error", reject);
    archive.on("error", reject);
  });
  archive.pipe(sink);
  await appendAccountantPackToArchive(archive, BUSINESS_ID, body);
  await archive.finalize();
  await done;
  return Buffer.concat(chunks);
}

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), "acct-pkg-qa-"));
  const origProvider = process.env.STORAGE_PROVIDER;
  const origRoot = process.env.LOCAL_STORAGE_ROOT;
  process.env.STORAGE_PROVIDER = "local";
  process.env.LOCAL_STORAGE_ROOT = root;
  resetStorageServiceForTests();
  installFakePrisma();

  try {
    // ---- Scenario A: June 2026 — month WITH Critical exceptions ----
    // Approved: 2 valid, 1 missing-amount, 1 missing-vendor, 1 missing-file.
    // Pending: 1 full (warning), 1 missing amount+vendor, 1 missing date.
    recordsReturn = [
      approved(1001, 117, new Date(2026, 5, 5), "ספק א", true),
      approved(1002, 200, new Date(2026, 5, 8), "ספק ב", true),
      approved(1003, 0, new Date(2026, 5, 10), "ספק ג", true), // missing amount → Critical
      approved(1004, 50, new Date(2026, 5, 12), "   ", true), // missing vendor → Warning
      approved(1005, 80, new Date(2026, 5, 14), "ספק ה", false), // missing source file → Critical
    ];
    pendingReturn = [
      pending(2001, 300, new Date(2026, 5, 20), "ספק pending"), // pending warning only
      pending(2002, null, new Date(2026, 5, 21), null), // pending + missing amount(C) + missing vendor(W)
      pending(2003, 400, null, "ספק"), // pending + missing date(C)
    ];
    // Put files for every doc EXCEPT 1005.
    for (const id of [1001, 1002, 1003, 1004, 2001, 2002, 2003]) await putFile(id);

    const zip = await buildAccountantZip({
      type: "month",
      month: "2026-06",
      categories: [],
    });
    const jszip = await JSZip.loadAsync(zip);
    const names = Object.keys(jszip.files);

    ok("ZIP has 01_Monthly_Summary.xlsx", names.includes("01_Monthly_Summary.xlsx"));
    ok("ZIP has 02_Exceptions_Report.xlsx", names.includes("02_Exceptions_Report.xlsx"));
    ok("ZIP has legacy summary דוח_2026-06.xlsx", names.includes("דוח_2026-06.xlsx"));
    ok("ZIP has manifest", names.includes("_meta/manifest.json"));
    ok("ZIP has missing-files.txt", names.includes("_meta/missing-files.txt"));
    ok("ZIP has סיכום.txt", names.includes("סיכום.txt"));
    ok(
      "ZIP packaged approved source files (1001-1004)",
      ["1001", "1002", "1003", "1004"].every((id) =>
        names.some((n) => n.startsWith("approved/doc-" + id + "."))
      )
    );
    ok(
      "ZIP did NOT package the missing source file (1005)",
      !names.some((n) => n.startsWith("approved/doc-1005."))
    );

    const missingTxt = await jszip.file("_meta/missing-files.txt")!.async("string");
    ok("missing-files.txt mentions document 1005", missingTxt.includes("1005"));

    // ---- Parse 02_Exceptions_Report.xlsx ----
    const exBuf = await jszip.file("02_Exceptions_Report.xlsx")!.async("nodebuffer");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(exBuf);
    const detailsWs = wb.getWorksheet("Details")!;
    const summaryWs = wb.getWorksheet("Summary")!;

    let critical = 0;
    let warning = 0;
    let info = 0;
    const detailLabels: string[] = [];
    const detailIds: number[] = [];
    detailsWs.eachRow((rowItem, rowNumber) => {
      if (rowNumber === 1) return;
      const sev = String(rowItem.getCell(1).value ?? "");
      const typeLabel = String(rowItem.getCell(2).value ?? "");
      const recId = Number(rowItem.getCell(4).value ?? 0);
      if (sev === "קריטי") critical += 1;
      else if (sev === "אזהרה") warning += 1;
      else if (sev === "מידע") info += 1;
      detailLabels.push(typeLabel);
      if (recId) detailIds.push(recId);
    });

    ok("Details Critical count == 4", critical === 4, { critical });
    ok("Details Warning count == 5", warning === 5, { warning });
    ok("Details Info count == 1 (tax id)", info === 1, { info });
    ok(
      "Details shows missing-amount record 1003",
      detailLabels.includes("חסר סכום") && detailIds.includes(1003)
    );
    ok(
      "Details shows missing source file record 1005",
      detailLabels.includes("קובץ מקור חסר") && detailIds.includes(1005)
    );
    ok("Details shows pending docs 2001-2003", [2001, 2002, 2003].every((id) => detailIds.includes(id)));

    // Summary total row.
    let summaryTotals: { total: number; critical: number; warning: number } | null = null;
    summaryWs.eachRow((rowItem) => {
      if (String(rowItem.getCell(1).value ?? "") === "סה״כ") {
        summaryTotals = {
          total: Number(rowItem.getCell(2).value ?? -1),
          critical: Number(rowItem.getCell(3).value ?? -1),
          warning: Number(rowItem.getCell(4).value ?? -1),
        };
      }
    });
    ok("Summary total row present", summaryTotals !== null);
    ok(
      "Summary totals match details (10/4/5)",
      summaryTotals !== null &&
        summaryTotals!.total === 10 &&
        summaryTotals!.critical === 4 &&
        summaryTotals!.warning === 5,
      summaryTotals
    );

    // ---- Month Close gate: June (with criticals) is BLOCKED ----
    const { from: jFrom, to: jTo } = monthRange(2026, 6);
    const juneExceptions = await computeExceptionsForPeriod(prisma, {
      businessId: BUSINESS_ID,
      fromDate: jFrom,
      toDate: jTo,
      categories: undefined,
    });
    ok("June gate: critical > 0 (blocks close)", juneExceptions.totals.critical === 4, juneExceptions.totals);
    // Route logic: critical>0 → do NOT close.
    const juneStatusBefore = await getMonthCloseStatus(prisma, BUSINESS_ID, 2026, 6);
    ok("June stays OPEN (not closed)", juneStatusBefore.status === "OPEN");

    // ---- Scenario B: July 2026 — clean month, close SUCCEEDS ----
    recordsReturn = [
      approved(3001, 500, new Date(2026, 6, 3), "ספק יולי 1", true),
      approved(3002, 600, new Date(2026, 6, 9), "ספק יולי 2", true),
    ];
    pendingReturn = [];
    for (const id of [3001, 3002]) await putFile(id);

    const { from: julyFrom, to: julyTo } = monthRange(2026, 7);
    const julyExceptions = await computeExceptionsForPeriod(prisma, {
      businessId: BUSINESS_ID,
      fromDate: julyFrom,
      toDate: julyTo,
      categories: undefined,
    });
    ok("July gate: critical == 0 (allows close)", julyExceptions.totals.critical === 0, julyExceptions.totals);

    const snapshotHash = computeMonthSnapshotHash(
      recordsReturn.map((r) => ({
        id: r.id,
        amount: r.amount,
        date: r.date,
        vendorName: r.vendorName,
        category: r.category,
        direction: r.direction,
      }))
    );
    await closeMonth(prisma, {
      businessId: BUSINESS_ID,
      year: 2026,
      month: 7,
      userId: 42,
      snapshotHash,
    });
    const julyStatus = await getMonthCloseStatus(prisma, BUSINESS_ID, 2026, 7);
    ok("July is CLOSED after close", julyStatus.status === "CLOSED");
    ok("July close has closedAt", Boolean(julyStatus.closedAt));
    ok("July close has snapshotHash", julyStatus.snapshotHash === snapshotHash);

    // ---- Approve guard: approving into a CLOSED month throws 409 ConflictError ----
    let threw409 = false;
    let code: string | undefined;
    try {
      await assertMonthOpen(prisma, BUSINESS_ID, new Date(2026, 6, 15)); // July (closed)
    } catch (e) {
      if (e instanceof ConflictError) {
        threw409 = true;
        code = e.code;
      }
    }
    ok("approve into CLOSED month → ConflictError(409)", threw409 && code === "MONTH_CLOSED", code);

    // Open month must NOT throw.
    let juneThrew = false;
    try {
      await assertMonthOpen(prisma, BUSINESS_ID, new Date(2026, 5, 15)); // June (open)
    } catch {
      juneThrew = true;
    }
    ok("approve into OPEN month → allowed (no throw)", !juneThrew);
  } finally {
    process.env.STORAGE_PROVIDER = origProvider;
    process.env.LOCAL_STORAGE_ROOT = origRoot;
    resetStorageServiceForTests();
    await rm(root, { recursive: true, force: true });
  }

  if (failed > 0) {
    console.error(`\n${failed} synthetic QA check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll Phase A synthetic QA checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
