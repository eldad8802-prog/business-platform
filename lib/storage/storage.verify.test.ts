/**
 * Storage platform verify (run manually):
 *   npx tsx lib/storage/storage.verify.test.ts
 *
 * Optional R2 verify when env is set:
 *   STORAGE_PROVIDER=r2 R2_*=... npx tsx lib/storage/storage.verify.test.ts
 */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  LocalFsStorageService,
  R2StorageService,
  StorageConfigError,
  StorageObjectNotFoundError,
  StorageVisibilityError,
  assertSafeStorageKey,
  loadStorageConfig,
  resetStorageServiceForTests,
} from "./index";

let failed = 0;

function ok(name: string, condition: boolean) {
  if (!condition) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

async function verifyLocalAdapter() {
  const root = await mkdtemp(path.join(os.tmpdir(), "storage-verify-"));
  const service = new LocalFsStorageService({
    provider: "local",
    localRoot: root,
    signedUrlTtlSeconds: 300,
  });

  const key = "biz/42/documents/doc-verify.bin";
  assertSafeStorageKey(key);

  const put = await service.putObject({
    key,
    body: Buffer.from("hello-storage"),
    contentType: "application/octet-stream",
    metadata: {
      businessId: 42,
      domain: "documents",
      visibility: "private",
      custom: { source: "verify" },
    },
  });

  ok("local putObject returns metadata", put.metadata.businessId === 42);
  ok("local metadata.domain", put.metadata.domain === "documents");
  ok("local metadata.visibility", put.metadata.visibility === "private");
  ok("local metadata.size", put.metadata.size === 13);

  const meta = await service.getMetadata(key);
  ok("local getMetadata roundtrip", meta.contentType === "application/octet-stream");

  const got = await service.getObject(key);
  ok("local getObject body", got.body.toString("utf8") === "hello-storage");

  const head = await service.headObject(key);
  ok("local headObject exists", head.exists === true);

  let signedFailed = false;
  try {
    await service.getSignedDownloadUrl(key);
  } catch (error) {
    signedFailed = error instanceof StorageConfigError;
  }
  ok("local signed URL blocked", signedFailed);
  ok("local getPublicUrl null", service.getPublicUrl(key) === null);

  await service.deleteObject(key);
  let missing = false;
  try {
    await service.getMetadata(key);
  } catch (error) {
    missing = error instanceof StorageObjectNotFoundError;
  }
  ok("local deleteObject", missing);

  let policyFailed = false;
  try {
    await service.putObject({
      key: "biz/42/documents/public-attempt.bin",
      body: Buffer.from("x"),
      contentType: "text/plain",
      metadata: {
        businessId: 42,
        domain: "documents",
        visibility: "public",
      },
    });
  } catch {
    policyFailed = true;
  }
  ok("local domain policy rejects public documents", policyFailed);

  await rm(root, { recursive: true, force: true });
}

async function verifyProductionFailClosed() {
  const originalProvider = process.env.STORAGE_PROVIDER;
  const originalNodeEnv = process.env.NODE_ENV;

  process.env.NODE_ENV = "production";
  process.env.STORAGE_PROVIDER = "local";
  resetStorageServiceForTests();

  let blocked = false;
  try {
    loadStorageConfig();
  } catch (error) {
    blocked = error instanceof StorageConfigError;
  }

  ok("production blocks local provider", blocked);

  process.env.NODE_ENV = originalNodeEnv;
  process.env.STORAGE_PROVIDER = originalProvider;
  resetStorageServiceForTests();
}

async function verifyR2AdapterOptional() {
  const hasR2 =
    process.env.STORAGE_PROVIDER === "r2" &&
    Boolean(process.env.R2_ACCOUNT_ID) &&
    Boolean(process.env.R2_ACCESS_KEY_ID) &&
    Boolean(process.env.R2_SECRET_ACCESS_KEY) &&
    Boolean(process.env.R2_BUCKET_NAME);

  if (!hasR2) {
    console.log("SKIP: R2 verify (env not configured)");
    return;
  }

  const config = loadStorageConfig();
  const service = new R2StorageService(config);
  const key = `biz/999/documents/doc-r2-${Date.now()}.bin`;

  await service.putObject({
    key,
    body: Buffer.from("r2-verify"),
    contentType: "application/octet-stream",
    metadata: {
      businessId: 999,
      domain: "documents",
      visibility: "private",
    },
  });

  const metadata = await service.getMetadata(key);
  ok("r2 getMetadata", metadata.size > 0);

  const signed = await service.getSignedDownloadUrl(key, 60);
  ok("r2 signed URL", signed.startsWith("http"));

  let publicSignedFailed = false;
  try {
    const publicKey = `biz/999/inventory/img-r2-${Date.now()}.jpg`;
    await service.putObject({
      key: publicKey,
      body: Buffer.from("public"),
      contentType: "image/jpeg",
      metadata: {
        businessId: 999,
        domain: "inventory",
        visibility: "public",
      },
    });

    await service.getSignedDownloadUrl(publicKey, 60);
  } catch (error) {
    publicSignedFailed = error instanceof StorageVisibilityError;
  }
  ok("r2 signed URL blocked for public", publicSignedFailed);

  await service.deleteObject(key);
}

async function main() {
  await verifyLocalAdapter();
  await verifyProductionFailClosed();
  await verifyR2AdapterOptional();

  if (failed > 0) {
    process.exit(1);
  }

  console.log("storage verify tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
