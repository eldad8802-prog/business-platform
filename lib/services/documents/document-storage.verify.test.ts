/**
 * Document storage verify (run manually):
 *   npx tsx lib/services/documents/document-storage.verify.test.ts
 *
 * Optional R2 verify when env is set:
 *   STORAGE_PROVIDER=r2 R2_*=... npx tsx lib/services/documents/document-storage.verify.test.ts
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resetStorageServiceForTests } from "@/lib/storage";
import { StorageObjectNotFoundError } from "@/lib/storage/storage.errors";
import {
  buildDocumentStorageKey,
  deleteDocumentObjectQuiet,
  headDocumentObject,
  putDocumentObject,
  readDocumentObject,
} from "./document-storage.service";

export const verifyStats = {
  storagePathTests: 0,
  legacyPathTests: 0,
  r2Tested: false,
  fsFallbackTested: false,
};

let failed = 0;

function ok(name: string, condition: boolean) {
  if (!condition) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

async function withLocalStorageRoot<T>(fn: () => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "doc-storage-verify-"));
  const originalProvider = process.env.STORAGE_PROVIDER;
  const originalLocalRoot = process.env.LOCAL_STORAGE_ROOT;
  const originalNodeEnv = process.env.NODE_ENV;

  process.env.NODE_ENV = "development";
  process.env.STORAGE_PROVIDER = "local";
  process.env.LOCAL_STORAGE_ROOT = root;
  resetStorageServiceForTests();

  try {
    return await fn();
  } finally {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.STORAGE_PROVIDER = originalProvider;
    process.env.LOCAL_STORAGE_ROOT = originalLocalRoot;
    resetStorageServiceForTests();
    await rm(root, { recursive: true, force: true });
  }
}

async function verifyStoragePathRoundtrip() {
  await withLocalStorageRoot(async () => {
    const businessId = 42;
    const basename = "doc-1717000000000-verify1.pdf";
    const body = Buffer.from("%PDF-document-storage-verify");

    const put = await putDocumentObject({
      businessId,
      basename,
      body,
      contentType: "application/pdf",
      source: "file",
    });

    verifyStats.storagePathTests += 1;
    ok("putDocumentObject key", put.key === buildDocumentStorageKey(businessId, basename));

    verifyStats.storagePathTests += 1;
    ok("headDocumentObject storage", await headDocumentObject(businessId, basename));

    verifyStats.storagePathTests += 1;
    const read = await readDocumentObject(businessId, basename);
    ok("readDocumentObject storage roundtrip", read.equals(body));

    verifyStats.storagePathTests += 1;
    await deleteDocumentObjectQuiet(businessId, basename);
    let missing = false;
    try {
      await readDocumentObject(businessId, basename);
    } catch (error) {
      missing = error instanceof StorageObjectNotFoundError;
    }
    ok("deleteDocumentObjectQuiet storage", missing);
  });
}

async function verifyLegacyFsFallback() {
  const legacyRoot = await mkdtemp(path.join(os.tmpdir(), "doc-legacy-verify-"));
  const originalCwd = process.cwd();

  try {
    process.chdir(legacyRoot);
    const originalProvider = process.env.STORAGE_PROVIDER;
    const originalLocalRoot = process.env.LOCAL_STORAGE_ROOT;
    process.env.STORAGE_PROVIDER = "local";
    process.env.LOCAL_STORAGE_ROOT = path.join(legacyRoot, "storage-svc");
    resetStorageServiceForTests();

    const businessId = 7;
    const basename = "doc-1717000000001-legacy.jpg";
    const body = Buffer.from("legacy-jpeg-bytes");
    const legacyDir = path.join(legacyRoot, "storage", "documents", String(businessId));
    await mkdir(legacyDir, { recursive: true });
    await writeFile(path.join(legacyDir, basename), body);

    verifyStats.legacyPathTests += 1;
    ok("headDocumentObject legacy", await headDocumentObject(businessId, basename));

    verifyStats.legacyPathTests += 1;
    const read = await readDocumentObject(businessId, basename);
    ok("readDocumentObject legacy fallback", read.equals(body));

    verifyStats.fsFallbackTested = true;

    process.env.STORAGE_PROVIDER = originalProvider;
    process.env.LOCAL_STORAGE_ROOT = originalLocalRoot;
    resetStorageServiceForTests();
  } finally {
    process.chdir(originalCwd);
    await rm(legacyRoot, { recursive: true, force: true });
  }
}

async function verifyR2Optional() {
  const hasR2 =
    process.env.STORAGE_PROVIDER === "r2" &&
    Boolean(process.env.R2_ACCOUNT_ID) &&
    Boolean(process.env.R2_ACCESS_KEY_ID) &&
    Boolean(process.env.R2_SECRET_ACCESS_KEY) &&
    Boolean(process.env.R2_BUCKET_NAME);

  if (!hasR2) {
    console.log("SKIP: document R2 verify (env not configured)");
    return;
  }

  resetStorageServiceForTests();
  const businessId = 999;
  const basename = `doc-${Date.now()}-r2verify.pdf`;
  const body = Buffer.from("%PDF-r2-document-verify");

  await putDocumentObject({
    businessId,
    basename,
    body,
    contentType: "application/pdf",
    source: "file",
  });

  verifyStats.storagePathTests += 1;
  verifyStats.r2Tested = true;
  const read = await readDocumentObject(businessId, basename);
  ok("readDocumentObject R2", read.equals(body));

  await deleteDocumentObjectQuiet(businessId, basename);
}

async function main() {
  await verifyStoragePathRoundtrip();
  await verifyLegacyFsFallback();
  await verifyR2Optional();

  console.log("--- verify stats ---");
  console.log(JSON.stringify(verifyStats, null, 2));

  if (failed > 0) {
    process.exit(1);
  }

  console.log("document storage verify tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
