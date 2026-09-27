/**
 * sec(D) behavioural battery — external inputs, files and storage.
 *
 *   npx tsx lib/security/sec-d/sec-d-battery.test.ts
 *
 * No database, no network, no secrets: storage is a counting fake installed
 * through setStorageServiceForTests, fetch is a recording fake, R2 uses a fake
 * S3 client. Every check prints exactly one line:
 *
 *   [PASS] <ID> · <claim>
 *   [FAIL] <ID> · <claim> — <detail>
 *
 * The negative proofs in .github/workflows/sec-d-inputs-storage-ci.yml mutate
 * one control, run this file, and require the SPECIFIC [FAIL] line for that
 * control. A crash outside a check prints [CRASH] and exits 2, so a broken
 * setup can never pass for a caught mutation.
 */

process.env.NODE_ENV = "test";
process.env.AUTH_TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET || "sec-d-battery-synthetic-secret-0123456789";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://nobody:none@127.0.0.1:1/none";
const KEY_K0 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const KEY_K1 = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
process.env.GMAIL_TOKEN_ENCRYPTION_KEY = KEY_K0;
delete process.env.GMAIL_TOKEN_ENCRYPTION_KEYS;
delete process.env.GMAIL_TOKEN_ENCRYPTION_ACTIVE_KEY_ID;

import { createCipheriv, randomBytes } from "node:crypto";
import type {
  PutObjectInput,
  StorageService,
} from "@/lib/storage/types";
import * as fx from "./fixtures";

let failed = 0;
let passed = 0;

async function check(id: string, claim: string, fn: () => unknown | Promise<unknown>): Promise<void> {
  try {
    const r = await fn();
    if (r === false) throw new Error("condition false");
    passed += 1;
    console.log(`[PASS] ${id} · ${claim}`);
  } catch (error) {
    failed += 1;
    const detail = error instanceof Error ? error.message : String(error);
    console.log(`[FAIL] ${id} · ${claim} — ${detail.slice(0, 300)}`);
  }
}

function expectEq<T>(actual: T, expected: T, what = "value"): void {
  if (actual !== expected) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ------------------------------------------------------------ fake storage
class CountingStorage implements StorageService {
  puts: PutObjectInput[] = [];
  deletes: string[] = [];
  async putObject(input: PutObjectInput) {
    this.puts.push(input);
    return {
      key: input.key,
      metadata: {
        ...input.metadata,
        contentType: input.contentType,
        size: input.body.length,
        createdAt: new Date().toISOString(),
      },
    };
  }
  async getObject(): Promise<never> {
    throw new Error("not used");
  }
  async headObject() {
    return { exists: false };
  }
  async getMetadata(): Promise<never> {
    throw new Error("not used");
  }
  async deleteObject(key: string) {
    this.deletes.push(key);
  }
  async listByPrefix() {
    return { keys: [], truncated: false };
  }
  async deleteByPrefix() {
    return { deleted: 0 };
  }
  async getSignedDownloadUrl(): Promise<string> {
    throw new Error("not used");
  }
  getPublicUrl(key: string) {
    return `https://cdn.sec-d.test/${key}`;
  }
}

function uploadRequest(body: Buffer, type: string, name: string, extraHeaders: Record<string, string> = {}): Request {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(body)], name, { type }));
  return new Request("http://localhost/api/upload", { method: "POST", body: form, headers: extraHeaders });
}

const allowAll = async () => ({ allowed: true, remaining: 99, resetAt: 0 });

async function main(): Promise<void> {
  const storage = await import("@/lib/storage");
  const fake = new CountingStorage();
  storage.setStorageServiceForTests(fake);

  // ======================================================= H-4 bucket topology
  const saved = { ...process.env };
  const resetBucketEnv = () => {
    for (const k of ["R2_BUCKET_NAME", "R2_PRIVATE_BUCKET_NAME", "R2_PUBLIC_BUCKET_NAME", "R2_PUBLIC_BASE_URL"]) delete process.env[k];
    storage.resetStorageTopologyWarningForTests();
  };

  await check("H-4", "split config resolves two distinct buckets", () => {
    resetBucketEnv();
    process.env.R2_PRIVATE_BUCKET_NAME = "dubiz-private";
    process.env.R2_PUBLIC_BUCKET_NAME = "dubiz-public";
    process.env.R2_PUBLIC_BASE_URL = "https://cdn.example";
    const b = storage.resolveR2Buckets();
    expectEq(b.topology, "split", "topology");
    expectEq(b.privateBucketName, "dubiz-private", "private");
    expectEq(b.publicBucketName, "dubiz-public", "public");
  });

  await check("H-4", "half-configured split is refused (StorageConfigError)", () => {
    resetBucketEnv();
    process.env.R2_PRIVATE_BUCKET_NAME = "dubiz-private";
    try {
      storage.resolveR2Buckets();
    } catch (e) {
      return e instanceof storage.StorageConfigError && /half-configured/.test((e as Error).message);
    }
    return false;
  });

  await check("H-4", "split with the SAME bucket twice is refused", () => {
    resetBucketEnv();
    process.env.R2_PRIVATE_BUCKET_NAME = "same";
    process.env.R2_PUBLIC_BUCKET_NAME = "same";
    try {
      storage.resolveR2Buckets();
    } catch (e) {
      return e instanceof storage.StorageConfigError;
    }
    return false;
  });

  await check("H-4", "legacy single bucket keeps working AND logs a loud SECURITY_WARNING", () => {
    resetBucketEnv();
    process.env.R2_BUCKET_NAME = "legacy";
    const logged: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
    try {
      const b = storage.resolveR2Buckets();
      expectEq(b.topology, "legacy-single", "topology");
      expectEq(b.privateBucketName, "legacy", "private");
      expectEq(b.publicBucketName, "legacy", "public");
    } finally {
      console.error = orig;
    }
    return logged.some((l) => l.includes("storage_topology_legacy_single_bucket") && l.includes("SECURITY_WARNING"));
  });

  // R2 adapter with a fake S3 client: which bucket does each command hit?
  const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
  const r2 = new storage.R2StorageService({
    provider: "r2",
    signedUrlTtlSeconds: 60,
    r2: {
      accountId: "acct",
      accessKeyId: "x",
      secretAccessKey: "y",
      topology: "split",
      privateBucketName: "dubiz-private",
      publicBucketName: "dubiz-public",
      publicBaseUrl: "https://cdn.example",
    },
  });
  (r2 as unknown as { client: unknown }).client = {
    send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      sent.push({ name: cmd.constructor.name, input: cmd.input });
      return {};
    },
  };
  const put = (key: string, domain: "documents" | "crm" | "billing" | "content", visibility: "private" | "public") =>
    r2.putObject({ key, body: Buffer.from("x"), contentType: "application/pdf", metadata: { businessId: 5, domain, visibility } });

  for (const [key, domain] of [
    ["biz/5/documents/doc-1-a.pdf", "documents"],
    ["biz/5/crm/CUSTOMER/1/att-1-a.pdf", "crm"],
    ["biz/5/billing/1/x.pdf", "billing"],
  ] as const) {
    await check("H-4", `private-domain key (${domain}) is written to the PRIVATE bucket`, async () => {
      sent.length = 0;
      await put(key, domain, "private");
      expectEq(sent[0]?.input.Bucket as string, "dubiz-private", "Bucket");
    });
  }
  await check("H-4", "public-domain key (content) is written to the PUBLIC bucket", async () => {
    sent.length = 0;
    await put("biz/5/content/a.png", "content", "public");
    expectEq(sent[0]?.input.Bucket as string, "dubiz-public", "Bucket");
  });
  await check("H-4", "reads of a private key go to the PRIVATE bucket", async () => {
    sent.length = 0;
    await r2.deleteObject("biz/5/documents/doc-1-a.pdf");
    expectEq(sent[0]?.input.Bucket as string, "dubiz-private", "Bucket");
  });
  await check("H-4", "a private-domain key never gets a public URL", () =>
    r2.getPublicUrl("biz/5/documents/doc-1-a.pdf") === null &&
    r2.getPublicUrl("biz/5/content/a.png") === "https://cdn.example/biz/5/content/a.png"
  );

  const { buildStoredDocumentFileName, STORED_DOCUMENT_FILENAME_REGEX } = await import(
    "@/lib/services/documents/document-storage-paths"
  );
  const { buildAttachmentStorageKey } = await import("@/lib/services/crm/crm-attachment-storage");
  await check("H-4", "document object names carry 128 CSPRNG bits and still match the reader regex", () => {
    const a = buildStoredDocumentFileName("application/pdf");
    const b = buildStoredDocumentFileName("application/pdf");
    const m = /^doc-\d+-([0-9a-f]{32})\.pdf$/.exec(a);
    return Boolean(m) && a !== b && STORED_DOCUMENT_FILENAME_REGEX.test(a);
  });
  await check("H-4", "CRM attachment keys carry 128 CSPRNG bits", () => {
    const k = buildAttachmentStorageKey({ businessId: 5, subjectType: "CUSTOMER", subjectId: 9, storageExt: "pdf" });
    return /^biz\/5\/crm\/CUSTOMER\/9\/att-\d+-[0-9a-f]{32}\.pdf$/.test(k);
  });

  await check("H-4", "prefix operations are confined to one tenant AND one domain", () => {
    const ok1 = storage.assertSafeStoragePrefix("biz/12/content/").businessId === 12;
    const refused = ["biz/", "biz/12/", "biz/12/content", "biz/12/content/../documents/", "biz/1/content/./", "biz/12/nosuch/", "biz/012/content/"]
      .every((p) => {
        try {
          storage.assertSafeStoragePrefix(p);
          return false;
        } catch (e) {
          return e instanceof storage.StorageKeyError;
        }
      });
    return ok1 && refused;
  });

  await check("H-4", "local deleteByPrefix removes only that tenant+domain (biz/5 ≠ biz/55, content ≠ offers)", async () => {
    const os = await import("node:os");
    const path = await import("node:path");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const root = await mkdtemp(path.join(os.tmpdir(), "secd-prefix-"));
    try {
      const local = new storage.LocalFsStorageService({ provider: "local", localRoot: root, signedUrlTtlSeconds: 60 });
      const putLocal = (key: string, businessId: number, domain: "content" | "offers") =>
        local.putObject({ key, body: Buffer.from("x"), contentType: "image/png", metadata: { businessId, domain, visibility: "public" } });
      await putLocal("biz/5/content/a.png", 5, "content");
      await putLocal("biz/5/content/sub/b.png", 5, "content");
      await putLocal("biz/55/content/c.png", 55, "content");
      await putLocal("biz/5/offers/d.png", 5, "offers");
      const listed = await local.listByPrefix("biz/5/content/");
      expectEq(listed.keys.join(","), "biz/5/content/a.png,biz/5/content/sub/b.png", "listed");
      const del = await local.deleteByPrefix("biz/5/content/");
      expectEq(del.deleted, 2, "deleted");
      return (
        (await local.headObject("biz/55/content/c.png")).exists &&
        (await local.headObject("biz/5/offers/d.png")).exists &&
        !(await local.headObject("biz/5/content/a.png")).exists
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  Object.assign(process.env, saved);

  // ======================================================= M-2 public assets
  const { receivePublicAssetUpload } = await import("@/lib/services/storage/public-asset-upload");
  const user = { id: 3, businessId: 5 };

  async function upload(
    domain: "content" | "offers" | "inventory",
    body: Buffer,
    type: string,
    name: string,
    opts: { limiter?: typeof allowAll; headers?: Record<string, string> } = {}
  ) {
    fake.puts.length = 0;
    const res = await receivePublicAssetUpload({
      req: uploadRequest(body, type, name, opts.headers),
      user,
      domain,
      source: "sec-d",
      rateLimiter: opts.limiter ?? allowAll,
    });
    return { res, puts: fake.puts.length };
  }

  const rejects: Array<[string, "content" | "offers" | "inventory", Buffer, string, string, number, string]> = [
    ["SVG declared image/svg+xml", "offers", fx.SVG, "image/svg+xml", "x.svg", 415, "UNSUPPORTED_TYPE"],
    ["SVG declared image/png", "offers", fx.SVG, "image/png", "x.png", 415, "UNRECOGNISED_CONTENT"],
    ["HTML declared image/png", "content", fx.HTML, "image/png", "x.png", 415, "UNRECOGNISED_CONTENT"],
    ["PNG/HTML polyglot (valid PNG carrying <script>)", "inventory", fx.png("<script>alert(1)</script>"), "image/png", "x.png", 415, "ACTIVE_CONTENT"],
    ["PNG uploaded as x.svg", "offers", fx.png(), "image/png", "x.svg", 415, "UNSUPPORTED_TYPE"],
    ["PNG named .jpg", "offers", fx.png(), "image/png", "x.jpg", 415, "EXTENSION_MISMATCH"],
    ["JPEG declared image/png", "offers", fx.jpeg(), "image/png", "x.png", 415, "CONTENT_TYPE_MISMATCH"],
    ["video on the offers domain", "offers", fx.mp4(), "video/mp4", "x.mp4", 415, "UNSUPPORTED_TYPE"],
    ["unknown image/* (x-icon)", "content", fx.png(), "image/x-icon", "x.ico", 415, "UNSUPPORTED_TYPE"],
    ["oversize (6MB on a 5MB domain)", "offers", Buffer.concat([fx.png(), Buffer.alloc(6 * 1024 * 1024)]), "image/png", "x.png", 413, "TOO_LARGE"],
  ];
  for (const [label, domain, body, type, name, status, code] of rejects) {
    await check("M-2", `${label} refused with ${status} and zero writes`, async () => {
      const { res, puts } = await upload(domain, body, type, name);
      if (res.ok) throw new Error("accepted");
      expectEq(res.status, status, "status");
      expectEq(res.code, code, "code");
      expectEq(puts, 0, "storage writes");
    });
  }

  await check("M-2", "rate-limited upload returns 429 with zero writes", async () => {
    const { res, puts } = await upload("offers", fx.png(), "image/png", "x.png", {
      limiter: async () => ({ allowed: false, remaining: 0, resetAt: 0 }),
    });
    return !res.ok && res.status === 429 && puts === 0;
  });

  await check("M-2", "declared Content-Length over the ceiling is refused before parsing (413, zero writes)", async () => {
    const { res, puts } = await upload("offers", fx.png(), "image/png", "x.png", {
      headers: { "content-length": String(50 * 1024 * 1024) },
    });
    return !res.ok && res.status === 413 && res.code === "BODY_TOO_LARGE" && puts === 0;
  });

  await check("M-2", "valid PNG is stored with the VERIFIED type, inline, nosniff-safe metadata", async () => {
    const { res, puts } = await upload("offers", fx.png(), "IMAGE/PNG ", "photo.png");
    if (!res.ok) throw new Error(`rejected: ${res.code}`);
    expectEq(puts, 1, "writes");
    const p = fake.puts[0];
    expectEq(p.contentType, "image/png", "stored contentType");
    if (!p.contentDisposition?.startsWith("inline")) throw new Error(`disposition ${p.contentDisposition}`);
    if (!/\.png$/.test(p.key) || !p.key.startsWith("biz/5/offers/")) throw new Error(`key ${p.key}`);
    if (!/^[0-9a-f]{64}$/.test(res.stored.sha256)) throw new Error("sha256 missing for the erasure ledger");
    return p.metadata.visibility === "public";
  });

  await check("M-2", "video on the content domain is stored as attachment, never inline", async () => {
    const { res } = await upload("content", fx.mp4(), "video/mp4", "clip.mp4");
    if (!res.ok) throw new Error(`rejected: ${res.code}`);
    return fake.puts[0].contentType === "video/mp4" && fake.puts[0].contentDisposition?.startsWith("attachment") === true;
  });

  await check("M-2", "putPublicAsset itself refuses unverified bytes (no bypass for programmatic callers)", async () => {
    const { putPublicAsset, PublicAssetRejectedError } = await import("@/lib/services/storage/public-asset-storage.service");
    fake.puts.length = 0;
    try {
      await putPublicAsset({ businessId: 5, domain: "inventory", body: fx.SVG, contentType: "image/svg+xml" });
    } catch (e) {
      return e instanceof PublicAssetRejectedError && fake.puts.length === 0;
    }
    return false;
  });

  // ======================================================= L-13 CRM attachments
  const { verifyAttachmentContent } = await import("@/lib/services/crm/crm-attachment-content");
  const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const contentCases: Array<[string, Buffer, string, boolean, string?]> = [
    ["real PDF", fx.pdf(), "application/pdf", true],
    ["HTML declared application/pdf", fx.HTML, "application/pdf", false, "CONTENT_MISMATCH"],
    ["real PNG", fx.png(), "image/png", true],
    ["PDF declared image/png", fx.pdf(), "image/png", false, "CONTENT_MISMATCH"],
    ["real DOCX (zip + [Content_Types].xml + word/document.xml)", fx.docx(), DOCX, true],
    ["plain ZIP declared DOCX", fx.buildZip([{ name: "a.txt", data: Buffer.from("hi") }]), DOCX, false, "OOXML_STRUCTURE"],
    ["DOCX declared XLSX", fx.docx(), XLSX, false, "OOXML_STRUCTURE"],
    ["DOCX carrying vbaProject.bin", fx.docx([{ name: "word/vbaProject.bin", data: Buffer.from("x") }]), DOCX, false, "OOXML_MACROS"],
    ["EXE bytes declared DOCX", Buffer.from("MZ\x90\x00 this is a PE"), DOCX, false, "CONTENT_MISMATCH"],
    ["UTF-8 text", Buffer.from("שלום, a,b,c\n"), "text/csv", true],
    ["text with NUL", Buffer.from("abc\0def"), "text/plain", false, "TEXT_HAS_NUL"],
    ["invalid UTF-8 text", Buffer.from([0x61, 0xff, 0xfe, 0x62]), "text/plain", false, "TEXT_NOT_UTF8"],
  ];
  for (const [label, body, mime, expectOk, reason] of contentCases) {
    await check("L-13", `${label} → ${expectOk ? "accepted" : reason}`, () => {
      const v = verifyAttachmentContent(body, mime);
      if (expectOk) return v.ok;
      return !v.ok && v.reason === reason;
    });
  }

  const { crmAttachmentsService, AttachmentContentError } = await import("@/lib/services/crm/crm-attachments.service");
  const fakeTx = {
    customer: { findFirst: async () => ({ name: "Customer" }) },
    crmAttachment: {
      create: async ({ data }: { data: Record<string, unknown> }) => ({
        id: 77,
        ...data,
        createdAt: new Date(),
        uploadedByUser: null,
      }),
    },
  };
  const uploadCrm = (buffer: Buffer, mimeType: string, name: string, scanner?: unknown) =>
    crmAttachmentsService.uploadAttachment(
      { businessId: 5, subjectType: "CUSTOMER", subjectId: 9, uploadedByUserId: 3, buffer, originalFileName: name, mimeType },
      { tx: fakeTx as never, scanner: scanner as never }
    );

  await check("L-13", "HTML declared as PDF is refused by the service with 415 and zero writes", async () => {
    fake.puts.length = 0;
    try {
      await uploadCrm(fx.HTML, "application/pdf", "invoice.pdf");
    } catch (e) {
      return e instanceof AttachmentContentError && (e as { statusCode: number }).statusCode === 415 && fake.puts.length === 0;
    }
    return false;
  });
  await check("L-13", "a real PDF is stored, labelled scan=not_scanned, served as attachment", async () => {
    fake.puts.length = 0;
    await uploadCrm(fx.pdf(), "application/pdf", "invoice.pdf");
    const p = fake.puts[0];
    return fake.puts.length === 1 && p.metadata.custom?.scan === "not_scanned" && p.metadata.custom?.scanner === "none" && p.contentDisposition === "attachment";
  });
  await check("L-13", "scanner verdict 'infected' blocks storage (zero writes)", async () => {
    fake.puts.length = 0;
    try {
      await uploadCrm(fx.pdf(), "application/pdf", "invoice.pdf", {
        name: "fake",
        scan: async () => ({ verdict: "infected", scanner: "fake", signature: "EICAR" }),
      });
    } catch (e) {
      return e instanceof AttachmentContentError && (e as AttachmentContentErrorLike).reason === "MALWARE" && fake.puts.length === 0;
    }
    return false;
  });
  await check("L-13", "scanner error fails closed (zero writes)", async () => {
    fake.puts.length = 0;
    try {
      await uploadCrm(fx.pdf(), "application/pdf", "invoice.pdf", {
        name: "fake",
        scan: async () => ({ verdict: "error", scanner: "fake" }),
      });
    } catch (e) {
      return (e as AttachmentContentErrorLike).reason === "SCAN_ERROR" && fake.puts.length === 0;
    }
    return false;
  });

  // ======================================================= L-5 XLSX / CSV bounds
  const { readXlsxTable, XlsxLimitError } = await import("@/lib/data-transfer/format/xlsx-reader");
  const { readImportSource } = await import("@/lib/data-transfer/import/import-source");

  async function expectXlsxLimit(buf: Buffer, code: string, maxMs: number): Promise<void> {
    const t0 = Date.now();
    try {
      await readXlsxTable(buf);
    } catch (e) {
      const ms = Date.now() - t0;
      if (!(e instanceof XlsxLimitError)) throw new Error(`wrong error: ${(e as Error).message}`);
      expectEq(e.code, code, "limit code");
      if (ms > maxMs) throw new Error(`took ${ms}ms (budget ${maxMs}ms)`);
      return;
    }
    throw new Error("accepted");
  }

  const bombXml = "<worksheet><sheetData>" + "0".repeat(50 * 1024 * 1024) + "</sheetData></worksheet>";
  const bomb = fx.xlsxWithSheet(bombXml);
  await check("L-5", `compression-ratio bomb (${Math.round(bomb.length / 1024)}KB → 50MB) refused quickly with XLSX_COMPRESSION_RATIO`, () =>
    expectXlsxLimit(bomb, "XLSX_COMPRESSION_RATIO", 3000)
  );
  await check("L-5", "lying central directory (declared tiny, inflates huge) refused with XLSX_UNCOMPRESSED_TOO_LARGE", () =>
    expectXlsxLimit(fx.xlsxWithSheet("<worksheet>" + "A".repeat(2 * 1024 * 1024) + "</worksheet>", { declaredSize: 100 }), "XLSX_UNCOMPRESSED_TOO_LARGE", 3000)
  );
  await check("L-5", "sheet dimension A1:XFD1048576 refused with XLSX_DIMENSION_TOO_LARGE", () =>
    expectXlsxLimit(
      fx.xlsxWithSheet('<worksheet><dimension ref="A1:XFD1048576"/><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>'),
      "XLSX_DIMENSION_TOO_LARGE",
      2000
    )
  );
  await check("L-5", "one cell at XFD1 + one row at 1048576 (the 17-billion-cell loop) refused", () =>
    expectXlsxLimit(
      fx.xlsxWithSheet('<worksheet><sheetData><row r="1"><c r="XFD1"><v>1</v></c></row><row r="1048576"><c r="A1048576"><v>1</v></c></row></sheetData></worksheet>'),
      "XLSX_DIMENSION_TOO_LARGE",
      2000
    )
  );
  await check("L-5", "rows scanned are bounded (blank/filler rows included)", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("s");
    ws.addRow(["h1", "h2"]);
    for (let i = 0; i < 40; i++) ws.addRow(i % 2 === 0 ? [null, null] : [i, "x"]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const normal = await readXlsxTable(buf);
    if (normal.rows.length !== 20) throw new Error(`positive read got ${normal.rows.length} rows`);
    try {
      await readXlsxTable(buf, { limits: { maxRowsScanned: 10 } });
    } catch (e) {
      return e instanceof XlsxLimitError && e.code === "XLSX_TOO_MANY_ROWS_SCANNED";
    }
    return false;
  });
  await check("L-5", "Import Center maps a bomb to FILE_TOO_COMPLEX with its specific limit code", async () => {
    const r = await readImportSource({ filename: "bomb.xlsx", bytes: bomb });
    return !r.ok && r.code === "FILE_TOO_COMPLEX" && r.limitCode === "XLSX_COMPRESSION_RATIO";
  });

  const { readBoundedCsvFile, precheckCsvRequestSize } = await import("@/lib/data-transfer/import/bounded-csv-upload");
  await check("L-5", "supplier CSV over IMPORT_MAX_ROWS refused before parsing (413 TOO_MANY_ROWS)", async () => {
    const csv = "a,b\n" + "1,2\n".repeat(10_001);
    const r = await readBoundedCsvFile(new Blob([csv]));
    return !r.ok && r.status === 413 && r.code === "TOO_MANY_ROWS";
  });
  await check("L-5", "supplier CSV over IMPORT_MAX_FILE_BYTES refused (413 FILE_TOO_LARGE)", async () => {
    const r = await readBoundedCsvFile(new Blob([Buffer.alloc(11 * 1024 * 1024, 0x41)]));
    return !r.ok && r.code === "FILE_TOO_LARGE";
  });
  await check("L-5", "supplier CSV request with an oversize Content-Length refused before multipart parse", () => {
    const r = precheckCsvRequestSize(new Request("http://x/", { method: "POST", headers: { "content-length": String(40 * 1024 * 1024) } }));
    return r !== null && !r.ok && r.code === "BODY_TOO_LARGE";
  });
  await check("L-5", "a normal supplier CSV passes through unchanged", async () => {
    const r = await readBoundedCsvFile(new Blob(["order,sku\n1,A\n"]));
    return r.ok && r.text === "order,sku\n1,A\n";
  });

  // ======================================================= L-6 zip-slip
  const { resolveExportDateRange, AccountantExportInputError } = await import("@/lib/reports/accountant-export-zip");
  const { collectArchiveToBuffer } = await import("@/lib/archive/zip-buffer");
  const { UnsafeZipEntryNameError } = await import("@/lib/archive/zip-entry-name");

  for (const [label, body, code] of [
    ["month '../../evil'", { type: "month", month: "../../evil" }, "INVALID_MONTH"],
    ["month '2026-13'", { type: "month", month: "2026-13" }, "INVALID_MONTH"],
    ["month '2026-1'", { type: "month", month: "2026-1" }, "INVALID_MONTH"],
    ["quarter '5'", { type: "quarter", year: "2026", quarter: "5" }, "INVALID_QUARTER"],
    ["year '../x'", { type: "year", year: "../x" }, "INVALID_YEAR"],
    ["unknown type", { type: "week" }, "INVALID_TYPE"],
  ] as const) {
    await check("L-6", `period ${label} refused with ${code}`, () => {
      try {
        resolveExportDateRange(body as never);
      } catch (e) {
        return e instanceof AccountantExportInputError && e.code === code;
      }
      return false;
    });
  }
  await check("L-6", "valid periods still resolve (month / UI quarter label / numeric quarter / year)", () => {
    const m = resolveExportDateRange({ type: "month", month: "2026-03" });
    const q = resolveExportDateRange({ type: "quarter", quarter: "2026-Q2" });
    const q2 = resolveExportDateRange({ type: "quarter", year: "2026", quarter: "2" });
    const y = resolveExportDateRange({ type: "year", year: "2025" });
    return m.periodLabel === "2026-03" && q.periodLabel === "2026-Q2" && q2.periodLabel === "2026-Q2" && y.periodLabel === "2025" && m.fromDate!.getMonth() === 2;
  });
  for (const name of ["../evil.txt", "a/../../evil.txt", "/etc/passwd", "C:/x.txt", "a\\..\\b.txt", "a//b", "a/./b"]) {
    await check("L-6", `archive entry name ${JSON.stringify(name)} aborts the archive`, async () => {
      try {
        await collectArchiveToBuffer(async (archive) => {
          archive.append(Buffer.from("x"), { name });
        });
      } catch (e) {
        return e instanceof UnsafeZipEntryNameError;
      }
      return false;
    });
  }
  await check("L-6", "safe nested entry names still build a valid zip", async () => {
    const buf = await collectArchiveToBuffer(async (archive) => {
      archive.append(Buffer.from("x"), { name: "approved/doc-1.pdf" });
      archive.append(Buffer.from("y"), { name: "_meta/דוח_2026-03.csv" });
    });
    return buf.subarray(0, 2).toString("latin1") === "PK";
  });

  // ======================================================= L-15 WhatsApp media
  const media = await import("@/lib/services/integrations/whatsapp/media-fetch.service");
  type Seen = { url: string; auth: string | null };
  function fakeFetch(routes: Record<string, () => Response>) {
    const seen: Seen[] = [];
    const impl = async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({ url, auth: headers.get("authorization") });
      if (init?.redirect !== "manual") throw new Error("redirect must be manual");
      const host = new URL(url).hostname;
      const r = routes[host];
      return r ? r() : new Response("nope", { status: 404 });
    };
    return { seen, impl };
  }
  const TOKEN = "EAAG-synthetic-token";
  const jpegResp = () => new Response(new Uint8Array(fx.jpeg()), { status: 200, headers: { "content-length": String(fx.jpeg().length) } });

  await check("L-15", "Graph URL on a non-Meta host: request never made, token never sent", async () => {
    const f = fakeFetch({ "evil.example": jpegResp });
    const r = await media.createMetaMediaBinaryFetcher(f.impl)("https://evil.example/m", TOKEN);
    return !r.ok && r.reason === "untrusted_media_host" && f.seen.length === 0;
  });
  await check("L-15", "http:// (non-TLS) lookaside URL refused before any request", async () => {
    const f = fakeFetch({ "lookaside.fbsbx.com": jpegResp });
    const r = await media.createMetaMediaBinaryFetcher(f.impl)("http://lookaside.fbsbx.com/x", TOKEN);
    return !r.ok && f.seen.length === 0;
  });
  await check("L-15", "lookaside download carries the token and succeeds", async () => {
    const f = fakeFetch({ "lookaside.fbsbx.com": jpegResp });
    const r = await media.createMetaMediaBinaryFetcher(f.impl)("https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1", TOKEN);
    return r.ok && f.seen.length === 1 && f.seen[0].auth === `Bearer ${TOKEN}`;
  });
  await check("L-15", "redirect to a non-Meta host is aborted; that host never sees a request", async () => {
    const f = fakeFetch({
      "lookaside.fbsbx.com": () => new Response(null, { status: 302, headers: { location: "https://attacker.example/steal" } }),
      "attacker.example": jpegResp,
    });
    const r = await media.createMetaMediaBinaryFetcher(f.impl)("https://lookaside.fbsbx.com/x", TOKEN);
    return !r.ok && r.reason === "untrusted_media_host" && !f.seen.some((s) => s.url.includes("attacker.example"));
  });
  await check("L-15", "redirect to Meta CDN is followed WITHOUT the Authorization header", async () => {
    const f = fakeFetch({
      "lookaside.fbsbx.com": () => new Response(null, { status: 302, headers: { location: "https://scontent.xx.fbcdn.net/v/abc" } }),
      "scontent.xx.fbcdn.net": jpegResp,
    });
    const r = await media.createMetaMediaBinaryFetcher(f.impl)("https://lookaside.fbsbx.com/x", TOKEN);
    const cdn = f.seen.find((s) => s.url.includes("fbcdn.net"));
    return r.ok && cdn !== undefined && cdn.auth === null;
  });
  await check("L-15", "declared Content-Length over the cap refused without reading the body", async () => {
    const f = fakeFetch({
      "lookaside.fbsbx.com": () => new Response("x", { status: 200, headers: { "content-length": String(200 * 1024 * 1024) } }),
    });
    const r = await media.createMetaMediaBinaryFetcher(f.impl, 1024)("https://lookaside.fbsbx.com/x", TOKEN);
    return !r.ok && r.reason === "file_too_large";
  });
  await check("L-15", "streamed body over the cap (no Content-Length) aborted with file_too_large", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 1000) return controller.close();
        controller.enqueue(new Uint8Array(512));
      },
    });
    const f = fakeFetch({ "lookaside.fbsbx.com": () => new Response(stream, { status: 200 }) });
    const r = await media.createMetaMediaBinaryFetcher(f.impl, 2048)("https://lookaside.fbsbx.com/x", TOKEN);
    return !r.ok && r.reason === "file_too_large" && pulled < 20;
  });
  await check("L-15", "orchestrator never hands the token to a custom fetchBinary for a non-Meta URL", async () => {
    const calls: string[] = [];
    const r = await media.fetchAndValidateWhatsAppMedia(
      { mediaId: "m1", routingMediaType: "image" },
      {
        getAccessToken: () => TOKEN,
        getGraphApiVersion: () => "v20.0",
        fetchGraphMetadata: async () => ({ ok: true, metadata: { url: "https://169.254.169.254/latest", mimeType: "image/jpeg", fileSize: 10, filename: null } }),
        fetchBinary: async (url) => {
          calls.push(url);
          return { ok: true, buffer: fx.jpeg() };
        },
      }
    );
    return !r.ok && r.reason === "untrusted_media_host" && calls.length === 0;
  });

  // ======================================================= L-17 Gmail token crypto
  const tc = await import("@/lib/services/integrations/gmail/token-crypto.placeholder");
  const ctxA = { businessId: 10, connectionId: 100, field: "refresh" as const };
  const ctxB = { businessId: 11, connectionId: 101, field: "refresh" as const };

  function legacyV1(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", Buffer.from(KEY_K0, "hex"), iv);
    const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return `gcm_v1:${iv.toString("base64")}.${c.getAuthTag().toString("base64")}.${ct.toString("base64")}`;
  }

  await check("L-17", "existing gcm_v1 ciphertext still decrypts (no connection breaks)", () =>
    tc.decryptToken(legacyV1("1//refresh-abc"), ctxA) === "1//refresh-abc"
  );
  const v2 = tc.encryptToken("1//refresh-abc", ctxA)!;
  await check("L-17", "new writes are gcm_v2 with a key id, and decrypt under their own row", () =>
    v2.encrypted.startsWith("gcm_v2:k0:") && v2.keyId === "gcm_v2:k0" && tc.decryptToken(v2.encrypted, ctxA) === "1//refresh-abc"
  );
  await check("L-17", "v2 blob copied to another business's row does not decrypt", () =>
    tc.decryptToken(v2.encrypted, ctxB) === null
  );
  await check("L-17", "v2 blob copied to another connection of the SAME business does not decrypt", () =>
    tc.decryptToken(v2.encrypted, { ...ctxA, connectionId: 999 }) === null
  );
  await check("L-17", "v2 blob swapped between the access and refresh columns does not decrypt", () =>
    tc.decryptToken(v2.encrypted, { ...ctxA, field: "access" }) === null
  );
  await check("L-17", "v2 blob without a row context does not decrypt", () => tc.decryptToken(v2.encrypted) === null);
  const enc0 = "enc_v0:" + Buffer.from("plain-refresh").toString("base64");
  await check("L-17", "enc_v0 plaintext is QUARANTINED: not usable as a credential", () =>
    tc.decryptToken(enc0, ctxA) === null && tc.isQuarantinedLegacyToken(enc0)
  );
  await check("L-17", "enc_v0 is decodable only by the revocation path", () =>
    tc.decryptTokenForRevocation(enc0, ctxA) === "plain-refresh"
  );
  await check("L-17", "enc_v0 is never re-armed by the refresh upgrade", () =>
    Object.keys(tc.refreshTokenUpgrade(enc0, "plain-refresh", ctxA)).length === 0
  );
  await check("L-17", "gcm_v1 is upgraded to row-bound gcm_v2 on refresh", () => {
    const up = tc.refreshTokenUpgrade(legacyV1("r1"), "r1", { businessId: 10, connectionId: 100 });
    return up.refreshTokenEncrypted?.startsWith("gcm_v2:k0:") === true && tc.decryptToken(up.refreshTokenEncrypted, ctxA) === "r1";
  });
  await check("L-17", "key rotation: new writes use the active key id; old-key blobs still decrypt", () => {
    process.env.GMAIL_TOKEN_ENCRYPTION_KEYS = `k1:${KEY_K1}`;
    process.env.GMAIL_TOKEN_ENCRYPTION_ACTIVE_KEY_ID = "k1";
    try {
      const rotated = tc.encryptToken("r2", ctxA)!;
      return (
        rotated.encrypted.startsWith("gcm_v2:k1:") &&
        tc.decryptToken(rotated.encrypted, ctxA) === "r2" &&
        tc.decryptToken(v2.encrypted, ctxA) === "1//refresh-abc" &&
        tc.refreshTokenUpgrade(v2.encrypted, "1//refresh-abc", ctxA).refreshTokenEncrypted?.startsWith("gcm_v2:k1:") === true
      );
    } finally {
      delete process.env.GMAIL_TOKEN_ENCRYPTION_KEYS;
      delete process.env.GMAIL_TOKEN_ENCRYPTION_ACTIVE_KEY_ID;
    }
  });
  await check("L-17", "every production token writer passes a row context (no unbound writes)", async () => {
    const fsSync = await import("node:fs");
    const writers = [
      "app/api/integrations/gmail/callback/route.ts",
      "lib/services/integrations/gmail/gmail-auth.service.ts",
      "lib/services/integrations/gmail/gmail-discovery.service.ts",
    ];
    for (const f of writers) {
      const src = fsSync.readFileSync(f, "utf8");
      const calls = src.match(/encryptToken\([^)]*\)/g) ?? [];
      if (calls.length === 0) throw new Error(`${f}: no encryptToken call found`);
      for (const c of calls) {
        if (!/field: "(access|refresh)"/.test(c)) throw new Error(`${f}: unbound call ${c}`);
      }
    }
    return true;
  });
  await check("L-17", "a blob under an unknown key id does not decrypt", () =>
    tc.decryptToken(v2.encrypted.replace("gcm_v2:k0:", "gcm_v2:k9:"), ctxA) === null
  );

  // ======================================================= L-20 import token binding
  const { issuePreviewToken, sha256Hex } = await import("@/lib/data-transfer/import/preview/preview-token");
  const { executeImport } = await import("@/lib/data-transfer/import/execute/import-executor");
  await check("L-20", "preview token minted for user A is refused for user B with TOKEN_WRONG_USER", async () => {
    const bytes = Buffer.from("name\nx\n");
    const token = issuePreviewToken({
      businessId: 5,
      userId: 3,
      domain: "customers" as never,
      contentHash: sha256Hex(bytes),
      mappingHash: "0".repeat(64),
      decisionsHash: "0".repeat(64),
      sheetName: null,
      rowCount: 1,
    });
    const r = await executeImport({
      businessId: 5,
      userId: 4,
      domainId: "customers" as never,
      filename: "c.csv",
      bytes,
      sheetName: null,
      mapping: {} as never,
      decisions: {} as never,
      previewToken: token,
    });
    return !r.ok && r.code === "TOKEN_WRONG_USER";
  });

  // ======================================================= L-16 WhatsApp sender trust
  const intake = await import("@/lib/services/integrations/whatsapp/documents-intake.service");
  const trust = await import("@/lib/services/integrations/whatsapp/sender-trust");
  function intakeDeps(opts: { quotaAllowed: boolean }) {
    const log = { fetches: 0, docs: [] as string[], quota: 0, failed: [] as string[] };
    const deps = {
      ...intake.defaultWhatsAppIntakeDeps,
      getBusinessAccessToken: async () => "tok",
      consumeUntrustedQuota: async () => {
        log.quota += 1;
        return opts.quotaAllowed ? { allowed: true as const } : { allowed: false as const, scope: "sender" as const };
      },
      checkWamidDedup: async () => ({ ok: true as const }),
      checkHashDedup: async () => ({ ok: true as const }),
      createFailedImport: async (p: { error: string }) => {
        log.failed.push(p.error);
        return { id: 1 };
      },
      claimProcessing: async () => ({ ok: true as const, importId: 2 }),
      markImported: async () => {},
      markFailed: async () => {},
      markSkippedDuplicate: async () => {},
      fetchMedia: async () => {
        log.fetches += 1;
        return { ok: true as const, mediaId: "m", buffer: fx.jpeg(), mimeType: "image/jpeg", sizeBytes: 10, filename: null };
      },
      sha256Hex: () => "h".repeat(64),
      writeTempOcrFile: async () => ({ tempPath: "/tmp/x", cleanup: async () => {} }),
      runOcr: async () => "invoice 100",
      putDocument: async () => {},
      deleteDocument: async () => {},
      buildStoredFileName: () => "doc-1-abc.jpg",
      createDocument: async (p: { source: string }) => {
        log.docs.push(p.source);
        return { ok: true as const, documentId: 50, extractedDataId: 1 } as never;
      },
    };
    return { deps: deps as never, log };
  }
  const baseIntake = { businessId: 5, phoneNumberId: "p", sender: "972500000000", wamid: "wamid.1", mediaType: "image" as const, mediaId: "m" };
  const quietErr = console.error;
  console.error = () => {};
  try {
    await check("L-16", "media from a NON-allowlisted sender is labelled whatsapp_unverified", async () => {
      const { deps, log } = intakeDeps({ quotaAllowed: true });
      await intake.processWhatsAppDocumentsIntake({ ...baseIntake, senderTrust: "conversation" }, deps);
      return log.docs[0] === "whatsapp_unverified" && log.quota === 1;
    });
    await check("L-16", "absent senderTrust is treated as unverified (fail toward the label)", async () => {
      const { deps, log } = intakeDeps({ quotaAllowed: true });
      await intake.processWhatsAppDocumentsIntake(baseIntake, deps);
      return log.docs[0] === "whatsapp_unverified";
    });
    await check("L-16", "an allowlisted sender keeps source 'whatsapp' and spends no untrusted quota", async () => {
      const { deps, log } = intakeDeps({ quotaAllowed: false });
      await intake.processWhatsAppDocumentsIntake({ ...baseIntake, senderTrust: "allowlist" }, deps);
      return log.docs[0] === "whatsapp" && log.quota === 0;
    });
    await check("L-16", "over-quota unverified sender: no media download, no OCR, no document", async () => {
      const { deps, log } = intakeDeps({ quotaAllowed: false });
      const out = await intake.processWhatsAppDocumentsIntake({ ...baseIntake, senderTrust: "conversation" }, deps);
      return out.status === "failed" && log.fetches === 0 && log.docs.length === 0 && log.failed[0] === "untrusted_sender_quota:sender";
    });
  } finally {
    console.error = quietErr;
  }
  await check("L-16", "unverified source is recognised by the inbox quick-approve guard", () =>
    trust.isUntrustedDocumentSource("whatsapp_unverified") && !trust.isUntrustedDocumentSource("whatsapp")
  );

  // ======================================================= L-14 renderer policy (unit)
  const renderer = await import("@/lib/services/billing/pdf/billing-pdf-html-renderer");
  await check("L-14", "renderer request policy admits only data: and about:blank", () =>
    renderer.isAllowedRendererRequestUrl("data:image/png;base64,AAAA") &&
    renderer.isAllowedRendererRequestUrl("about:blank") &&
    !renderer.isAllowedRendererRequestUrl("http://169.254.169.254/latest/meta-data") &&
    !renderer.isAllowedRendererRequestUrl("https://example.com/x.png") &&
    !renderer.isAllowedRendererRequestUrl("file:///etc/passwd")
  );

  // ======================================================= I-2 dead code
  const fs = await import("node:fs");
  for (const p of [
    "app/api/documents/debug-extract/route.ts",
    "app/api/documents/debug-ocr/route.ts",
    "app/api/documents/debug-unified/route.ts",
    "app/api/inventory/supplier-purchases/integrations/mock/route.ts",
    "lib/services/documents/pdf-to-image.service.ts",
  ]) {
    await check("I-2", `${p} removed`, () => !fs.existsSync(p));
  }

  storage.setStorageServiceForTests(null);
  console.log(`\nsec-d battery: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

type AttachmentContentErrorLike = { reason: string };

main().catch((error) => {
  console.log(`[CRASH] sec-d battery setup failed: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(2);
});
