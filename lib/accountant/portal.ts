/**
 * The accountant's portal (R3) — what a delivered package contains, file by file, taken FROM the sealed
 * package and never from live data. SERVER-ONLY. Callers authorize first (the link: lookup → tenant job →
 * delivery checks → feature gate) and pass the sealed package of THAT delivery.
 *
 *   index    the files of the ZIP (source documents, issued documents) with their sha256 and size, each
 *            joined to its row of the package's own workbook (date, party, amount — as the workbook shows
 *            them), plus the rows whose file is NOT in the package (missing / not matching), from the same
 *            workbook. Built once from the ZIP after its sha256 is checked, then cached as a private sibling
 *            of the package, bound to the package's full sha256 and the index layout version.
 *   a file   the ZIP entry, byte for byte (its sha256 must equal the index's), cached as a private sibling
 *            keyed by the package sha256 AND the file's own sha256, handed out by a one-minute signed URL.
 *
 * A file can only be named by its path in the index — never by a storage key — and the index only holds
 * source / issued entries, so _meta, the reports and anything else in the ZIP cannot be reached this way.
 */
import { createHash } from "node:crypto";

import ExcelJS from "exceljs";
import JSZip from "jszip";

import { getStorageService } from "@/lib/storage";

import { AccountantError } from "./http";
import { cellDisplay } from "./package-report-pdf";
import { packageExcelCacheKey, packageReportEntryName, type SealedPackage } from "./package-reports";
import { isPeriodKey } from "./period";

/** Bump when the index shape changes: an older cached index is then rebuilt, never served. */
export const PORTAL_INDEX_VERSION = "p1";

export type PortalFileKind = "source" | "issued";

export type PortalFile = {
  /** The file's path inside the package ZIP — the only way to name it. */
  path: string;
  kind: PortalFileKind;
  /** ASCII download name: `<period>-<basename>`. */
  fileName: string;
  contentType: string;
  /** PDF and images open in the browser; anything else is download-only. */
  viewable: boolean;
  size: number;
  sha256: string;
  /** Source: checked against the hash recorded at ingestion (null = package built before that check). Issued: always true. */
  verified: boolean | null;
  documentId: number | null;
  /** As the package's workbook shows them (never recomputed). */
  title: string;
  date: string;
  party: string;
  amount: string;
  currency: string;
  note: string;
};

export type PortalMissing = { kind: PortalFileKind; title: string; date: string; party: string; amount: string; reason: string };

export type PortalIndex = {
  indexVersion: typeof PORTAL_INDEX_VERSION;
  periodKey: string;
  packageVersion: number;
  packageSha256: string;
  generatedAt: string | null;
  files: PortalFile[];
  missing: PortalMissing[];
  counts: { source: number; issued: number; missing: number; pending: number };
};

const sha256Of = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  tif: "image/tiff",
  tiff: "image/tiff",
  bmp: "image/bmp",
};
/** Rendered by every browser without a plugin; SVG / HTML are never opened inline. */
const VIEWABLE = new Set(["pdf", "jpg", "jpeg", "png", "webp", "gif"]);

const SOURCE_ENTRY = /^(approved|pending)\/doc-(\d+)\.([a-z0-9]{1,5})$/i;
const ISSUED_ENTRY = /^issued\/[a-z-]+-[A-Za-z0-9_-]{1,40}\.pdf$/;

function extOf(path: string): string {
  return (path.split(".").pop() ?? "").toLowerCase();
}

export function portalFileName(periodKey: string, path: string): string {
  const base = path.split("/").pop() ?? "file";
  return `${periodKey}-${base}`.replace(/[^A-Za-z0-9._-]/g, "_");
}

// ── index ───────────────────────────────────────────────────────────────────────────────────────

type Row = { cells: string[] };

function sheetRows(wb: ExcelJS.Workbook, name: string): Row[] {
  const ws = wb.getWorksheet(name);
  if (!ws) return [];
  const out: Row[] = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (n === 1) return;
    const cells: string[] = [];
    for (let c = 1; c <= ws.columnCount; c++) cells.push(cellDisplay(row.getCell(c)).text);
    out.push({ cells });
  });
  return out;
}

/**
 * Pure: the index of one sealed package from its opened ZIP. Exported for the tests; production callers use
 * ensurePortalIndex (which checks the ZIP's sha256 first and caches the result).
 */
export async function buildPortalIndex(
  archive: JSZip,
  pkg: Pick<SealedPackage, "periodKey" | "version" | "sha256">
): Promise<PortalIndex> {
  const xlsxEntry = archive.file(packageReportEntryName(pkg.periodKey));
  if (!xlsxEntry) throw new AccountantError(404, "REPORT_NOT_IN_PACKAGE");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await xlsxEntry.async("nodebuffer")) as unknown as ArrayBuffer);

  let manifest: { generatedAt?: unknown; files?: { path?: unknown; verified?: unknown }[] } = {};
  try {
    manifest = JSON.parse((await archive.file("_meta/manifest.json")?.async("string")) ?? "{}");
  } catch {
    manifest = {};
  }
  const verifiedByPath = new Map<string, boolean>();
  for (const f of Array.isArray(manifest.files) ? manifest.files : []) {
    if (typeof f?.path === "string" && typeof f.verified === "boolean") verifiedByPath.set(f.path, f.verified);
  }

  // דוח: date, vendor, category, amount, direction, status, confidence, source file, notes.
  const scanned = sheetRows(wb, "דוח");
  const scannedByPath = new Map(scanned.map((r) => [r.cells[7], r]));
  // מסמכים שהופקו: number, type, date, customer, before VAT, VAT, total, currency, reference, file.
  const issued = sheetRows(wb, "מסמכים שהופקו");
  const issuedByPath = new Map(issued.map((r) => [r.cells[9], r]));

  const files: PortalFile[] = [];
  for (const entry of Object.values(archive.files)) {
    if (entry.dir) continue;
    const path = entry.name;
    const source = SOURCE_ENTRY.exec(path);
    const kind: PortalFileKind | null = source ? "source" : ISSUED_ENTRY.test(path) ? "issued" : null;
    if (!kind) continue;
    const body = await entry.async("nodebuffer");
    const ext = extOf(path);
    const base = {
      path,
      kind,
      fileName: portalFileName(pkg.periodKey, path),
      contentType: CONTENT_TYPES[ext] ?? "application/octet-stream",
      viewable: VIEWABLE.has(ext),
      size: body.byteLength,
      sha256: sha256Of(body),
    };
    if (kind === "source") {
      const row = scannedByPath.get(path)?.cells ?? [];
      files.push({
        ...base,
        verified: verifiedByPath.has(path) ? verifiedByPath.get(path)! : null,
        documentId: Number(source![2]),
        title: row[2] || "מסמך סרוק",
        date: row[0] ?? "",
        party: row[1] ?? "",
        amount: row[3] ?? "",
        currency: "",
        note: [row[4], source![1] === "pending" ? "טרם אושר" : ""].filter(Boolean).join(" · "),
      });
    } else {
      const row = issuedByPath.get(path)?.cells ?? [];
      files.push({
        ...base,
        verified: true,
        documentId: null,
        title: [row[1], row[0]].filter(Boolean).join(" ") || "מסמך שהופק",
        date: row[2] ?? "",
        party: row[3] ?? "",
        amount: row[6] ?? "",
        currency: row[7] ?? "",
        note: row[8] ? `מתייחס ל־${row[8]}` : "",
      });
    }
  }
  files.sort((a, b) => (a.kind === b.kind ? a.path.localeCompare(b.path, "en", { numeric: true }) : a.kind === "source" ? -1 : 1));

  const inZip = new Set(files.map((f) => f.path));
  const missing: PortalMissing[] = [
    ...scanned
      .filter((r) => r.cells[7] && !inZip.has(r.cells[7]))
      .map((r) => ({ kind: "source" as const, title: r.cells[2] || "מסמך סרוק", date: r.cells[0], party: r.cells[1], amount: r.cells[3], reason: r.cells[7] })),
    ...issued
      .filter((r) => r.cells[9] && !inZip.has(r.cells[9]))
      .map((r) => ({ kind: "issued" as const, title: [r.cells[1], r.cells[0]].filter(Boolean).join(" "), date: r.cells[2], party: r.cells[3], amount: r.cells[6], reason: r.cells[9] })),
  ];

  return {
    indexVersion: PORTAL_INDEX_VERSION,
    periodKey: pkg.periodKey,
    packageVersion: pkg.version,
    packageSha256: pkg.sha256,
    generatedAt: typeof manifest.generatedAt === "string" ? manifest.generatedAt : null,
    files,
    missing,
    counts: {
      source: files.filter((f) => f.kind === "source").length,
      issued: files.filter((f) => f.kind === "issued").length,
      missing: missing.length,
      pending: sheetRows(wb, "ממתינים").length,
    },
  };
}

// ── storage ─────────────────────────────────────────────────────────────────────────────────────

/** `…/2026-09/v1-<sha64>.portal-p1.json` — next to the package, bound to its full sha256 and the layout. */
export function portalIndexCacheKey(pkg: SealedPackage): string {
  return packageExcelCacheKey(pkg.storageKey, pkg.version, pkg.sha256).replace(/\.report\.xlsx$/, `.portal-${PORTAL_INDEX_VERSION}.json`);
}

/** `…/2026-09/v1-<sha64>.files/<file sha64>.<ext>` — bound to the package AND the file's own bytes. */
export function portalFileCacheKey(pkg: SealedPackage, file: Pick<PortalFile, "sha256" | "path">): string {
  if (!/^[0-9a-f]{64}$/.test(file.sha256)) throw new AccountantError(500, "PORTAL_FILE_KEY");
  const ext = extOf(file.path).replace(/[^a-z0-9]/g, "") || "bin";
  return packageExcelCacheKey(pkg.storageKey, pkg.version, pkg.sha256).replace(/\.report\.xlsx$/, `.files/${file.sha256}.${ext}`);
}

async function openVerifiedArchive(pkg: SealedPackage): Promise<JSZip> {
  const zip = await getStorageService().getObject(pkg.storageKey);
  if (zip.metadata.businessId !== pkg.businessId || sha256Of(zip.body) !== pkg.sha256) {
    throw new AccountantError(409, "PACKAGE_INTEGRITY");
  }
  return JSZip.loadAsync(zip.body);
}

function isIndex(v: unknown, pkg: SealedPackage): v is PortalIndex {
  const i = v as PortalIndex;
  return !!i && i.indexVersion === PORTAL_INDEX_VERSION && i.packageSha256 === pkg.sha256 && i.packageVersion === pkg.version && Array.isArray(i.files);
}

/**
 * The index of a sealed package: from the private cache when it is bound to this package (business, full
 * sha256, layout), otherwise built from the ZIP after its sha256 was checked, then cached. Refuses (409
 * PACKAGE_INTEGRITY) a ZIP that does not hash to the sealed sha256. Writes nothing but the cached index.
 */
export async function ensurePortalIndex(pkg: SealedPackage): Promise<PortalIndex> {
  if (!isPeriodKey(pkg.periodKey)) throw new AccountantError(500, "PACKAGE_REPORT_KEY");
  const storage = getStorageService();
  const key = portalIndexCacheKey(pkg);
  const head = await storage.headObject(key);
  if (head.exists && head.metadata?.businessId === pkg.businessId && head.metadata.custom?.sourceSha256 === pkg.sha256) {
    try {
      const cached = await storage.getObject(key);
      const parsed = JSON.parse(cached.body.toString("utf8"));
      if (cached.metadata.custom?.sha256 === sha256Of(cached.body) && isIndex(parsed, pkg)) return parsed;
    } catch {
      // unreadable or foreign → rebuilt below
    }
  }
  const index = await buildPortalIndex(await openVerifiedArchive(pkg), pkg);
  const body = Buffer.from(JSON.stringify(index), "utf8");
  await storage.putObject({
    key,
    body,
    contentType: "application/json",
    metadata: {
      businessId: pkg.businessId,
      domain: "exports",
      visibility: "private",
      custom: { sourceSha256: pkg.sha256, sha256: sha256Of(body), template: PORTAL_INDEX_VERSION, kind: "accountant-portal-index" },
    },
  });
  return index;
}

/**
 * One file of a sealed package, as a private object whose bytes are exactly the ZIP entry's: from the
 * cache when it is bound to this package and records the file's sha256, otherwise extracted from the
 * verified ZIP (its sha256 must equal the index's — 409 PORTAL_FILE_INTEGRITY otherwise), then cached.
 */
export async function ensurePortalFile(pkg: SealedPackage, file: PortalFile): Promise<{ key: string; cached: boolean }> {
  const storage = getStorageService();
  const key = portalFileCacheKey(pkg, file);
  const head = await storage.headObject(key);
  if (
    head.exists &&
    head.metadata?.businessId === pkg.businessId &&
    head.metadata.custom?.sourceSha256 === pkg.sha256 &&
    head.metadata.custom?.sha256 === file.sha256
  ) {
    return { key, cached: true };
  }
  const entry = (await openVerifiedArchive(pkg)).file(file.path);
  if (!entry) throw new AccountantError(404, "FILE_NOT_IN_PACKAGE");
  const body = await entry.async("nodebuffer");
  if (sha256Of(body) !== file.sha256) throw new AccountantError(409, "PORTAL_FILE_INTEGRITY");
  await storage.putObject({
    key,
    body,
    contentType: file.contentType,
    metadata: {
      businessId: pkg.businessId,
      domain: "exports",
      visibility: "private",
      custom: { sourceSha256: pkg.sha256, sha256: file.sha256, kind: `accountant-portal-${file.kind}` },
    },
  });
  return { key, cached: false };
}

/** The index entry for a requested path — the only way a file is named. */
export function findPortalFile(index: PortalIndex, path: unknown): PortalFile | null {
  if (typeof path !== "string" || path.length > 200) return null;
  return index.files.find((f) => f.path === path) ?? null;
}
