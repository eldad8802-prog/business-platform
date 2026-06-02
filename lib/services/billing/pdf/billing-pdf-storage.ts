// Billing PDF storage adapter — StorageService (R2/local) with legacy FS read fallback.
//
// Public surface preserved for billing services:
//   buildStorageKey / existsByKey / writeAtomic / readByKey / unlinkByKeyQuiet
//
// New keys (v1.1): biz/{businessId}/billing/{documentId}/{hash}.pdf
// Legacy keys:     billing/{businessId}/{documentId}/{hash}.pdf  (local FS read-only fallback)

import { promises as fs } from "node:fs";
import path from "node:path";
import { getStorageService } from "@/lib/storage";
import { StorageObjectNotFoundError } from "@/lib/storage/storage.errors";

const STORAGE_ROOT_ENV = "BILLING_PDF_STORAGE_ROOT";
const DEFAULT_STORAGE_ROOT = "./storage/billing-pdf";

const LEGACY_KEY_PATTERN =
  /^billing\/(\d+)\/(\d+)\/([a-f0-9]{64})\.pdf$/i;
const V11_KEY_PATTERN =
  /^biz\/(\d+)\/billing\/(\d+)\/([a-f0-9]{64})\.pdf$/i;

type ParsedBillingStorageKey = {
  businessId: number;
  billingDocumentId: number;
  pdfHash: string;
  v11Key: string;
  legacyKey: string;
  isLegacy: boolean;
};

function getLegacyStorageRootAbsolute(): string {
  const raw = process.env[STORAGE_ROOT_ENV] ?? DEFAULT_STORAGE_ROOT;
  return path.resolve(raw);
}

function parseBillingStorageKey(storageKey: string): ParsedBillingStorageKey | null {
  const v11Match = V11_KEY_PATTERN.exec(storageKey);
  if (v11Match) {
    const businessId = Number(v11Match[1]);
    const billingDocumentId = Number(v11Match[2]);
    const pdfHash = v11Match[3].toLowerCase();
    const legacyKey = `billing/${businessId}/${billingDocumentId}/${pdfHash}.pdf`;
    return {
      businessId,
      billingDocumentId,
      pdfHash,
      v11Key: storageKey,
      legacyKey,
      isLegacy: false,
    };
  }

  const legacyMatch = LEGACY_KEY_PATTERN.exec(storageKey);
  if (legacyMatch) {
    const businessId = Number(legacyMatch[1]);
    const billingDocumentId = Number(legacyMatch[2]);
    const pdfHash = legacyMatch[3].toLowerCase();
    return {
      businessId,
      billingDocumentId,
      pdfHash,
      v11Key: `biz/${businessId}/billing/${billingDocumentId}/${pdfHash}.pdf`,
      legacyKey: storageKey,
      isLegacy: true,
    };
  }

  return null;
}

function resolveLegacyStoragePathStrict(storageKey: string): string {
  if (!storageKey || typeof storageKey !== "string") {
    throw new Error("resolveStoragePath: storageKey is required");
  }
  if (storageKey.includes("\0")) {
    throw new Error("resolveStoragePath: invalid storageKey");
  }

  const root = getLegacyStorageRootAbsolute();
  const normalizedKey = storageKey.split("/").join(path.sep);
  const absolute = path.resolve(root, normalizedKey);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;

  if (absolute !== root && !absolute.startsWith(rootWithSep)) {
    throw new Error("resolveStoragePath: storageKey escapes storage root");
  }

  return absolute;
}

export function buildStorageKey(
  businessId: number,
  billingDocumentId: number,
  pdfHash: string
): string {
  if (!Number.isInteger(businessId) || businessId <= 0) {
    throw new Error("buildStorageKey: invalid businessId");
  }
  if (!Number.isInteger(billingDocumentId) || billingDocumentId <= 0) {
    throw new Error("buildStorageKey: invalid billingDocumentId");
  }
  if (!/^[a-f0-9]{64}$/i.test(pdfHash)) {
    throw new Error("buildStorageKey: pdfHash must be a 64-char hex sha256");
  }

  return `biz/${businessId}/billing/${billingDocumentId}/${pdfHash.toLowerCase()}.pdf`;
}

async function legacyLocalExists(storageKey: string): Promise<boolean> {
  const absolute = resolveLegacyStoragePathStrict(storageKey);
  try {
    const stat = await fs.stat(absolute);
    return stat.isFile() && stat.size > 0;
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw err;
  }
}

async function legacyLocalRead(storageKey: string): Promise<Buffer> {
  const absolute = resolveLegacyStoragePathStrict(storageKey);
  return await fs.readFile(absolute);
}

async function legacyLocalUnlinkQuiet(storageKey: string): Promise<void> {
  try {
    const absolute = resolveLegacyStoragePathStrict(storageKey);
    await fs.unlink(absolute);
  } catch {
    // ignore
  }
}

export async function existsByKey(storageKey: string): Promise<boolean> {
  const parsed = parseBillingStorageKey(storageKey);
  if (!parsed) {
    return false;
  }

  if (!parsed.isLegacy) {
    const head = await getStorageService().headObject(parsed.v11Key);
    return head.exists && (head.metadata?.size ?? 0) > 0;
  }

  // Legacy DB keys: try StorageService v1.1 key first, then local FS fallback.
  const head = await getStorageService().headObject(parsed.v11Key);
  if (head.exists && (head.metadata?.size ?? 0) > 0) {
    return true;
  }

  return legacyLocalExists(parsed.legacyKey);
}

export async function readByKey(storageKey: string): Promise<Buffer> {
  const parsed = parseBillingStorageKey(storageKey);
  if (!parsed) {
    throw new Error("readByKey: unsupported billing pdf storage key");
  }

  if (!parsed.isLegacy) {
    const result = await getStorageService().getObject(parsed.v11Key);
    return result.body;
  }

  try {
    const result = await getStorageService().getObject(parsed.v11Key);
    return result.body;
  } catch (error) {
    if (!(error instanceof StorageObjectNotFoundError)) {
      throw error;
    }
  }

  return legacyLocalRead(parsed.legacyKey);
}

export async function writeAtomic(
  storageKey: string,
  buffer: Buffer
): Promise<void> {
  const parsed = parseBillingStorageKey(storageKey);
  if (!parsed) {
    throw new Error("writeAtomic: unsupported billing pdf storage key");
  }

  await getStorageService().putObject({
    key: parsed.v11Key,
    body: buffer,
    contentType: "application/pdf",
    metadata: {
      businessId: parsed.businessId,
      domain: "billing",
      visibility: "private",
      custom: {
        billingDocumentId: String(parsed.billingDocumentId),
        pdfHash: parsed.pdfHash,
      },
    },
  });
}

export async function unlinkByKeyQuiet(storageKey: string): Promise<void> {
  const parsed = parseBillingStorageKey(storageKey);
  if (!parsed) {
    return;
  }

  try {
    await getStorageService().deleteObject(parsed.v11Key);
  } catch {
    // ignore
  }

  if (parsed.isLegacy) {
    await legacyLocalUnlinkQuiet(parsed.legacyKey);
  }
}
