/**
 * Accountant ZIP document read verify (run manually):
 *   npx tsx lib/reports/accountant-export-zip.verify.test.ts
 */

import archiver from "archiver";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { resetStorageServiceForTests } from "@/lib/storage";
import {
  putDocumentObject,
  readDocumentObject,
  STORED_DOCUMENT_FILENAME_REGEX,
} from "@/lib/services/documents/document-storage.service";

let failed = 0;

function ok(name: string, condition: boolean) {
  if (!condition) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

async function collectZipEntries(zipBuffer: Buffer): Promise<Map<string, Buffer>> {
  // Minimal ZIP parse: scan for local file headers (PK\x03\x04).
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 30 <= zipBuffer.length) {
    if (
      zipBuffer[offset] !== 0x50 ||
      zipBuffer[offset + 1] !== 0x4b ||
      zipBuffer[offset + 2] !== 0x03 ||
      zipBuffer[offset + 3] !== 0x04
    ) {
      break;
    }
    const nameLen = zipBuffer.readUInt16LE(offset + 26);
    const extraLen = zipBuffer.readUInt16LE(offset + 28);
    const compSize = zipBuffer.readUInt32LE(offset + 18);
    const nameStart = offset + 30;
    const name = zipBuffer.subarray(nameStart, nameStart + nameLen).toString("utf8");
    const dataStart = nameStart + nameLen + extraLen;
    const dataEnd = dataStart + compSize;
    entries.set(name, zipBuffer.subarray(dataStart, dataEnd));
    offset = dataEnd;
  }
  return entries;
}

async function buildZipWithDocumentFile(
  folder: "approved" | "pending",
  docId: number,
  basename: string,
  buffer: Buffer
): Promise<Buffer> {
  const archive = archiver("zip", { zlib: { level: 9 } });
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on("data", (chunk) => chunks.push(Buffer.from(chunk)));

  const done = new Promise<void>((resolve, reject) => {
    sink.on("finish", () => resolve());
    sink.on("error", reject);
    archive.on("error", reject);
  });

  archive.pipe(sink);
  const ext = basename.split(".").pop() || "file";
  archive.append(buffer, { name: `${folder}/doc-${docId}.${ext}`, store: true });
  await archive.finalize();
  await done;
  return Buffer.concat(chunks);
}

async function verifyStorageBackedZipEntry() {
  const root = await mkdtemp(path.join(os.tmpdir(), "acct-zip-storage-"));
  const originalProvider = process.env.STORAGE_PROVIDER;
  const originalLocalRoot = process.env.LOCAL_STORAGE_ROOT;

  process.env.STORAGE_PROVIDER = "local";
  process.env.LOCAL_STORAGE_ROOT = root;
  resetStorageServiceForTests();

  try {
    const businessId = 55;
    const basename = "doc-1717000000100-acctzip.pdf";
    const body = Buffer.from("%PDF-accountant-zip-storage");

    await putDocumentObject({
      businessId,
      basename,
      body,
      contentType: "application/pdf",
      source: "file",
    });

    ok("basename valid for export", STORED_DOCUMENT_FILENAME_REGEX.test(basename));
    const read = await readDocumentObject(businessId, basename);
    ok("accountant read via StorageService", read.equals(body));

    const zip = await buildZipWithDocumentFile("approved", 100, basename, read);
    const entries = await collectZipEntries(zip);
    ok("ZIP contains approved/doc-100.pdf", entries.has("approved/doc-100.pdf"));
    ok(
      "ZIP entry bytes match",
      entries.get("approved/doc-100.pdf")?.equals(body) === true
    );
  } finally {
    process.env.STORAGE_PROVIDER = originalProvider;
    process.env.LOCAL_STORAGE_ROOT = originalLocalRoot;
    resetStorageServiceForTests();
    await rm(root, { recursive: true, force: true });
  }
}

async function verifyLegacyBackedZipEntry() {
  const legacyRoot = await mkdtemp(path.join(os.tmpdir(), "acct-zip-legacy-"));
  const originalCwd = process.cwd();

  try {
    process.chdir(legacyRoot);
    process.env.STORAGE_PROVIDER = "local";
    process.env.LOCAL_STORAGE_ROOT = path.join(legacyRoot, "storage-svc");
    resetStorageServiceForTests();

    const businessId = 56;
    const basename = "doc-1717000000101-legacyzip.jpg";
    const body = Buffer.from("legacy-jpeg-for-accountant-zip");
    const legacyDir = path.join(legacyRoot, "storage", "documents", String(businessId));
    await mkdir(legacyDir, { recursive: true });
    await writeFile(path.join(legacyDir, basename), body);

    const read = await readDocumentObject(businessId, basename);
    ok("accountant read via legacy FS fallback", read.equals(body));

    const zip = await buildZipWithDocumentFile("pending", 101, basename, read);
    const entries = await collectZipEntries(zip);
    ok("ZIP contains pending/doc-101.jpg", entries.has("pending/doc-101.jpg"));
  } finally {
    process.chdir(originalCwd);
    await rm(legacyRoot, { recursive: true, force: true });
  }
}

async function main() {
  await verifyStorageBackedZipEntry();
  await verifyLegacyBackedZipEntry();

  if (failed > 0) {
    process.exit(1);
  }

  console.log("accountant export zip verify tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
