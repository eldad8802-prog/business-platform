/**
 * Document source-file storage adapter — StorageService with legacy local FS fallback.
 *
 * DB contract: Document.fileUrl stores basename only (e.g. doc-1717-abc.pdf).
 * Storage key (v1.1): biz/{businessId}/documents/{basename}
 * Legacy local path: storage/documents/{businessId}/{basename}
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { getStorageService } from "@/lib/storage";
import { StorageObjectNotFoundError } from "@/lib/storage/storage.errors";
import {
  STORED_DOCUMENT_FILENAME_REGEX,
  buildStoredDocumentFileName,
  safeExtFromMime,
} from "@/lib/services/documents/document-storage-paths";

export {
  STORED_DOCUMENT_FILENAME_REGEX,
  buildStoredDocumentFileName,
  safeExtFromMime,
};

const LEGACY_DOCUMENTS_ROOT = path.join("storage", "documents");

export type DocumentStorageSource = "file" | "email" | "whatsapp";

export function buildDocumentStorageKey(
  businessId: number,
  basename: string
): string {
  assertValidBasename(basename);
  if (!Number.isInteger(businessId) || businessId <= 0) {
    throw new Error("buildDocumentStorageKey: invalid businessId");
  }
  return `biz/${businessId}/documents/${basename}`;
}

function assertValidBasename(basename: string): void {
  const storedName = String(basename || "").trim();
  if (!STORED_DOCUMENT_FILENAME_REGEX.test(storedName)) {
    throw new Error("document storage: invalid basename");
  }
}

function legacyAbsolutePath(businessId: number, basename: string): string {
  assertValidBasename(basename);
  const storageRoot = path.resolve(process.cwd(), LEGACY_DOCUMENTS_ROOT, String(businessId));
  const filePath = path.resolve(storageRoot, basename);
  const rootWithSep = storageRoot.endsWith(path.sep)
    ? storageRoot
    : storageRoot + path.sep;

  if (filePath !== storageRoot && !filePath.startsWith(rootWithSep)) {
    throw new Error("document storage: basename escapes storage root");
  }

  return filePath;
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function legacyLocalExists(
  businessId: number,
  basename: string
): Promise<boolean> {
  try {
    const stat = await fs.stat(legacyAbsolutePath(businessId, basename));
    return stat.isFile() && stat.size > 0;
  } catch (error) {
    if (isEnoent(error)) {
      return false;
    }
    throw error;
  }
}

async function legacyLocalRead(
  businessId: number,
  basename: string
): Promise<Buffer> {
  return fs.readFile(legacyAbsolutePath(businessId, basename));
}

async function legacyLocalUnlinkQuiet(
  businessId: number,
  basename: string
): Promise<void> {
  try {
    await fs.unlink(legacyAbsolutePath(businessId, basename));
  } catch {
    // ignore
  }
}

async function readFromStorageService(
  businessId: number,
  basename: string
): Promise<Buffer | null> {
  const key = buildDocumentStorageKey(businessId, basename);
  try {
    const result = await getStorageService().getObject(key);
    return result.body;
  } catch (error) {
    if (error instanceof StorageObjectNotFoundError) {
      return null;
    }
    throw error;
  }
}

async function existsInStorageService(
  businessId: number,
  basename: string
): Promise<boolean> {
  const key = buildDocumentStorageKey(businessId, basename);
  const head = await getStorageService().headObject(key);
  return head.exists && (head.metadata?.size ?? 0) > 0;
}

export async function putDocumentObject(input: {
  businessId: number;
  basename: string;
  body: Buffer;
  contentType: string;
  source: DocumentStorageSource;
  custom?: Record<string, string>;
}): Promise<{ key: string; basename: string }> {
  assertValidBasename(input.basename);
  const key = buildDocumentStorageKey(input.businessId, input.basename);

  await getStorageService().putObject({
    key,
    body: input.body,
    contentType: input.contentType,
    metadata: {
      businessId: input.businessId,
      domain: "documents",
      visibility: "private",
      custom: {
        source: input.source,
        ...input.custom,
      },
    },
  });

  return { key, basename: input.basename };
}

export async function readDocumentObject(
  businessId: number,
  basename: string
): Promise<Buffer> {
  assertValidBasename(basename);

  const fromStorage = await readFromStorageService(businessId, basename);
  if (fromStorage) {
    return fromStorage;
  }

  try {
    return await legacyLocalRead(businessId, basename);
  } catch (error) {
    if (isEnoent(error)) {
      throw new StorageObjectNotFoundError(
        buildDocumentStorageKey(businessId, basename)
      );
    }
    throw error;
  }
}

export async function headDocumentObject(
  businessId: number,
  basename: string
): Promise<boolean> {
  if (!STORED_DOCUMENT_FILENAME_REGEX.test(String(basename || "").trim())) {
    return false;
  }

  if (await existsInStorageService(businessId, basename)) {
    return true;
  }

  return legacyLocalExists(businessId, basename);
}

export async function deleteDocumentObjectQuiet(
  businessId: number,
  basename: string
): Promise<void> {
  if (!STORED_DOCUMENT_FILENAME_REGEX.test(String(basename || "").trim())) {
    return;
  }

  const key = buildDocumentStorageKey(businessId, basename);
  try {
    await getStorageService().deleteObject(key);
  } catch {
    // ignore
  }

  await legacyLocalUnlinkQuiet(businessId, basename);
}
