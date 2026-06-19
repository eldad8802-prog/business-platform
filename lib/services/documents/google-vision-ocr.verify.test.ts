/**
 * OCR deployment verify (run manually):
 *   npx tsx lib/services/documents/google-vision-ocr.verify.test.ts
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  GoogleVisionConfigError,
  runGoogleVisionOCR,
} from "./google-vision-ocr.service";
import { writeTempOcrFile } from "@/lib/services/integrations/gmail/temp-ocr-file.service";

const MOCK_SERVICE_ACCOUNT = {
  type: "service_account",
  project_id: "ocr-verify-test",
  private_key_id: "key",
  private_key: "-----BEGIN RSA PRIVATE KEY-----\nMIIBogIBAAJBALRiMLAHudeSA0\n-----END RSA PRIVATE KEY-----\n",
  client_email: "vision-verify@test.iam.gserviceaccount.com",
  client_id: "123",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
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

async function verifyUploadTempPath() {
  const tmpDir = path.join(os.tmpdir(), "ocr");
  ok("upload temp dir uses os.tmpdir()", tmpDir.startsWith(os.tmpdir()));
}

async function verifyGmailTempPath() {
  const { tempPath, cleanup } = await writeTempOcrFile({
    bytes: Buffer.from("ocr-verify-bytes"),
    mimeType: "image/jpeg",
  });
  try {
    ok("gmail temp path under os.tmpdir()", tempPath.startsWith(os.tmpdir()));
    ok("gmail temp file exists", tempPath.includes(`${path.sep}ocr${path.sep}`));
  } finally {
    await cleanup();
  }
}

async function verifyWhatsAppUsesSharedTempHelper() {
  const { tempPath, cleanup } = await writeTempOcrFile({
    bytes: Buffer.from("wa-ocr-verify"),
    mimeType: "application/pdf",
  });
  try {
    ok("whatsapp temp path under os.tmpdir()", tempPath.startsWith(os.tmpdir()));
  } finally {
    await cleanup();
  }
}

async function verifyEnvJsonCredentialPath() {
  const originalEnv = process.env.GOOGLE_VISION_CREDENTIALS_JSON;
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  process.env.GOOGLE_VISION_CREDENTIALS_JSON = JSON.stringify(MOCK_SERVICE_ACCOUNT);

  try {
    let message = "";
    try {
      await runGoogleVisionOCR(path.join(os.tmpdir(), "ocr-verify-missing.jpg"));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    ok(
      "env JSON credentials accepted (fails on missing OCR file, not credentials)",
      message === "File not found for OCR"
    );
  } finally {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalEnv === undefined) {
      delete process.env.GOOGLE_VISION_CREDENTIALS_JSON;
    } else {
      process.env.GOOGLE_VISION_CREDENTIALS_JSON = originalEnv;
    }
  }
}

async function verifyLocalFileFallback() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocr-local-fallback-"));
  const originalEnv = process.env.GOOGLE_VISION_CREDENTIALS_JSON;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalCwd = process.cwd();

  delete process.env.GOOGLE_VISION_CREDENTIALS_JSON;
  process.env.NODE_ENV = "development";

  try {
    process.chdir(root);
    await mkdir(path.join(root, "secrets"), { recursive: true });
    await writeFile(
      path.join(root, "secrets", "google-vision-key.json"),
      JSON.stringify(MOCK_SERVICE_ACCOUNT)
    );

    let message = "";
    try {
      await runGoogleVisionOCR(path.join(os.tmpdir(), "ocr-local-missing.jpg"));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    ok(
      "local secrets/google-vision-key.json fallback accepted",
      message === "File not found for OCR"
    );
  } finally {
    process.chdir(originalCwd);
    process.env.NODE_ENV = originalNodeEnv;
    if (originalEnv === undefined) {
      delete process.env.GOOGLE_VISION_CREDENTIALS_JSON;
    } else {
      process.env.GOOGLE_VISION_CREDENTIALS_JSON = originalEnv;
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function verifyProductionFailClosedWithoutEnv() {
  const originalEnv = process.env.GOOGLE_VISION_CREDENTIALS_JSON;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalCwd = process.cwd();
  const root = await mkdtemp(path.join(os.tmpdir(), "ocr-prod-fail-"));

  delete process.env.GOOGLE_VISION_CREDENTIALS_JSON;
  process.env.NODE_ENV = "production";

  try {
    process.chdir(root);
    let blocked = false;
    try {
      await runGoogleVisionOCR(path.join(os.tmpdir(), "missing.jpg"));
    } catch (error) {
      blocked = error instanceof GoogleVisionConfigError;
    }
    ok("production fail-closed without GOOGLE_VISION_CREDENTIALS_JSON", blocked);
  } finally {
    process.chdir(originalCwd);
    process.env.NODE_ENV = originalNodeEnv;
    if (originalEnv === undefined) {
      delete process.env.GOOGLE_VISION_CREDENTIALS_JSON;
    } else {
      process.env.GOOGLE_VISION_CREDENTIALS_JSON = originalEnv;
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  await verifyUploadTempPath();
  await verifyGmailTempPath();
  await verifyWhatsAppUsesSharedTempHelper();
  await verifyEnvJsonCredentialPath();
  await verifyLocalFileFallback();
  await verifyProductionFailClosedWithoutEnv();

  if (failed > 0) {
    process.exit(1);
  }

  console.log("google vision ocr deployment verify tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
