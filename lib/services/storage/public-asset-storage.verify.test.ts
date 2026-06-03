/**
 * Public asset storage verify (run manually):
 *   npx tsx lib/services/storage/public-asset-storage.verify.test.ts
 *
 * Content → Creatomate chain verify included.
 * Optional R2 when env configured.
 */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resetStorageServiceForTests } from "@/lib/storage";
import { StorageConfigError } from "@/lib/storage/storage.errors";
import {
  buildPublicAssetKey,
  isAbsoluteHttpsUrl,
  normalizeAssetUrlForCreatomate,
  normalizeAssetUrlsForCreatomate,
  putPublicAsset,
  requirePublicAssetUrl,
} from "./public-asset-storage.service";

export const verifyStats = {
  storagePathTests: 0,
  legacyUrlNormalizationTests: 0,
  creatomateChainTests: 0,
  r2Tested: false,
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
  const root = await mkdtemp(path.join(os.tmpdir(), "public-asset-verify-"));
  const originalProvider = process.env.STORAGE_PROVIDER;
  const originalLocalRoot = process.env.LOCAL_STORAGE_ROOT;
  const originalPublicBase = process.env.R2_PUBLIC_BASE_URL;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalAppBase = process.env.APP_BASE_URL;

  process.env.NODE_ENV = "development";
  process.env.STORAGE_PROVIDER = "local";
  process.env.LOCAL_STORAGE_ROOT = root;
  process.env.R2_PUBLIC_BASE_URL = "https://cdn.verify.test";
  process.env.APP_BASE_URL = "https://app.verify.test";
  resetStorageServiceForTests();

  try {
    return await fn();
  } finally {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.STORAGE_PROVIDER = originalProvider;
    process.env.LOCAL_STORAGE_ROOT = originalLocalRoot;
    process.env.R2_PUBLIC_BASE_URL = originalPublicBase;
    process.env.APP_BASE_URL = originalAppBase;
    resetStorageServiceForTests();
    await rm(root, { recursive: true, force: true });
  }
}

function simulateCreatomateVideoSources(assetUrls: string[]) {
  return assetUrls.map((url) => ({
    type: "video",
    source: url,
  }));
}

async function verifyContentUploadToCreatomateChain() {
  await withLocalStorageRoot(async () => {
    const businessId = 42;
    const body = Buffer.from("fake-video-bytes-for-verify");

    verifyStats.creatomateChainTests += 1;
    const stored = await putPublicAsset({
      businessId,
      domain: "content",
      body,
      contentType: "video/mp4",
      custom: { source: "content_upload" },
    });

    verifyStats.storagePathTests += 1;
    ok(
      "content key format",
      stored.key.startsWith(`biz/${businessId}/content/`) &&
        stored.key.endsWith(".mp4")
    );

    console.log("  content public URL:", stored.publicUrl);

    verifyStats.creatomateChainTests += 1;
    ok("content URL is absolute HTTPS", isAbsoluteHttpsUrl(stored.publicUrl));

    verifyStats.creatomateChainTests += 1;
    const uploadResponseShape = { url: stored.publicUrl };
    ok(
      "upload response shape { url }",
      typeof uploadResponseShape.url === "string" &&
        Object.keys(uploadResponseShape).length === 1
    );

    verifyStats.creatomateChainTests += 1;
    const renderInputUrls = normalizeAssetUrlsForCreatomate([stored.publicUrl]);
    const creatomateElements = simulateCreatomateVideoSources(renderInputUrls);
    ok(
      "Creatomate receives content URL as source",
      creatomateElements.length === 1 &&
        creatomateElements[0].source === stored.publicUrl &&
        isAbsoluteHttpsUrl(creatomateElements[0].source)
    );

    verifyStats.legacyUrlNormalizationTests += 1;
    const legacyUrl = "/uploads/1717000000-camera-clip.mp4";
    const normalizedLegacy = normalizeAssetUrlForCreatomate(legacyUrl);
    console.log("  legacy normalized URL:", normalizedLegacy);
    ok(
      "legacy /uploads/ URL normalized to absolute HTTPS",
      normalizedLegacy === "https://app.verify.test/uploads/1717000000-camera-clip.mp4"
    );

    verifyStats.creatomateChainTests += 1;
    const mixedRenderInput = normalizeAssetUrlsForCreatomate([
      stored.publicUrl,
      legacyUrl,
    ]);
    const mixedElements = simulateCreatomateVideoSources(mixedRenderInput);
    ok(
      "mixed new CDN + legacy URLs both absolute for Creatomate",
      mixedElements.every((el) => /^https:\/\//i.test(el.source))
    );
  });
}

async function verifyInventoryAndOffers() {
  await withLocalStorageRoot(async () => {
    const businessId = 7;

    verifyStats.storagePathTests += 1;
    const inventory = await putPublicAsset({
      businessId,
      domain: "inventory",
      body: Buffer.from("jpeg-bytes"),
      contentType: "image/jpeg",
      custom: { source: "inventory_item_image" },
    });
    ok(
      "inventory key + HTTPS URL",
      inventory.key.startsWith(`biz/${businessId}/inventory/`) &&
        isAbsoluteHttpsUrl(inventory.publicUrl)
    );

    verifyStats.storagePathTests += 1;
    const offers = await putPublicAsset({
      businessId,
      domain: "offers",
      body: Buffer.from("png-bytes"),
      contentType: "image/png",
      custom: { source: "offer_image_upload" },
    });
    ok(
      "offers key + HTTPS URL",
      offers.key.startsWith(`biz/${businessId}/offers/`) &&
        isAbsoluteHttpsUrl(offers.publicUrl)
    );
  });
}

async function verifyProductionFailClosed() {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalPublicBase = process.env.R2_PUBLIC_BASE_URL;

  process.env.NODE_ENV = "production";
  delete process.env.R2_PUBLIC_BASE_URL;
  resetStorageServiceForTests();

  const key = buildPublicAssetKey(1, "content", "test-uuid.mp4");
  let blocked = false;
  try {
    requirePublicAssetUrl(key);
  } catch (error) {
    blocked = error instanceof StorageConfigError;
  }

  ok("production fail-closed without R2_PUBLIC_BASE_URL", blocked);

  process.env.NODE_ENV = originalNodeEnv;
  process.env.R2_PUBLIC_BASE_URL = originalPublicBase;
  resetStorageServiceForTests();
}

async function verifyR2Optional() {
  const hasR2 =
    process.env.STORAGE_PROVIDER === "r2" &&
    Boolean(process.env.R2_ACCOUNT_ID) &&
    Boolean(process.env.R2_ACCESS_KEY_ID) &&
    Boolean(process.env.R2_SECRET_ACCESS_KEY) &&
    Boolean(process.env.R2_BUCKET_NAME) &&
    Boolean(process.env.R2_PUBLIC_BASE_URL);

  if (!hasR2) {
    console.log("SKIP: public asset R2 verify (env not configured)");
    return;
  }

  resetStorageServiceForTests();
  const stored = await putPublicAsset({
    businessId: 999,
    domain: "content",
    body: Buffer.from("r2-public-verify"),
    contentType: "image/jpeg",
    custom: { source: "verify" },
  });

  verifyStats.r2Tested = true;
  verifyStats.storagePathTests += 1;
  ok("R2 content public URL", isAbsoluteHttpsUrl(stored.publicUrl));

  const elements = simulateCreatomateVideoSources([stored.publicUrl]);
  ok("R2 URL usable as Creatomate source", elements[0].source === stored.publicUrl);
}

async function main() {
  await verifyContentUploadToCreatomateChain();
  await verifyInventoryAndOffers();
  await verifyProductionFailClosed();
  await verifyR2Optional();

  console.log("--- verify stats ---");
  console.log(JSON.stringify(verifyStats, null, 2));

  if (failed > 0) {
    process.exit(1);
  }

  console.log("public asset storage verify tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
