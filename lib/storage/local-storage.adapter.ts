import { mkdir, readFile, unlink, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import type {
  GetObjectResult,
  HeadObjectResult,
  ObjectMetadata,
  PutObjectInput,
  PutObjectResult,
  StorageConfig,
  StorageDomain,
  StorageService,
  StorageVisibility,
} from "./types";
import {
  StorageConfigError,
  StorageObjectNotFoundError,
  StorageVisibilityError,
} from "./storage.errors";
import {
  assertKeyMatchesMetadata,
  assertSafeStorageKey,
  normalizeStorageKey,
} from "./key-validation";
import { validatePutObjectMetadata } from "./domain-policy";

type StoredSidecarMetadata = {
  businessId: number;
  domain: StorageDomain;
  visibility: StorageVisibility;
  contentType: string;
  size: number;
  createdAt: string;
  custom?: Record<string, string>;
};

function sidecarPath(absoluteFilePath: string): string {
  return `${absoluteFilePath}.meta.json`;
}

function resolveAbsolutePath(root: string, key: string): string {
  const normalizedKey = assertSafeStorageKey(key);
  const rootAbsolute = path.resolve(root);
  const absolute = path.resolve(rootAbsolute, ...normalizedKey.split("/"));
  const rootWithSep = rootAbsolute.endsWith(path.sep)
    ? rootAbsolute
    : rootAbsolute + path.sep;

  if (absolute !== rootAbsolute && !absolute.startsWith(rootWithSep)) {
    throw new StorageConfigError("Resolved storage path escapes local root");
  }

  return absolute;
}

function toObjectMetadata(stored: StoredSidecarMetadata): ObjectMetadata {
  return {
    businessId: stored.businessId,
    domain: stored.domain,
    visibility: stored.visibility,
    contentType: stored.contentType,
    size: stored.size,
    createdAt: stored.createdAt,
    custom: stored.custom,
  };
}

async function readSidecar(absoluteFilePath: string): Promise<StoredSidecarMetadata> {
  const raw = await readFile(sidecarPath(absoluteFilePath), "utf8");
  return JSON.parse(raw) as StoredSidecarMetadata;
}

export class LocalFsStorageService implements StorageService {
  constructor(private readonly config: StorageConfig) {
    if (!config.localRoot) {
      throw new StorageConfigError("LOCAL_STORAGE_ROOT is not configured");
    }
  }

  private get root(): string {
    return this.config.localRoot!;
  }

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    validatePutObjectMetadata(input.metadata);
    const key = assertSafeStorageKey(input.key);
    assertKeyMatchesMetadata(
      key,
      input.metadata.businessId,
      input.metadata.domain
    );

    const absolute = resolveAbsolutePath(this.root, key);
    await mkdir(path.dirname(absolute), { recursive: true });

    const createdAt = new Date().toISOString();
    const stored: StoredSidecarMetadata = {
      businessId: input.metadata.businessId,
      domain: input.metadata.domain,
      visibility: input.metadata.visibility,
      contentType: input.contentType,
      size: input.body.length,
      createdAt,
      custom: input.metadata.custom,
    };

    await writeFile(absolute, input.body);
    await writeFile(sidecarPath(absolute), JSON.stringify(stored), "utf8");

    return {
      key,
      metadata: toObjectMetadata(stored),
    };
  }

  async getObject(key: string): Promise<GetObjectResult> {
    const normalized = normalizeStorageKey(key);
    const absolute = resolveAbsolutePath(this.root, normalized);

    try {
      const [body, stored] = await Promise.all([
        readFile(absolute),
        readSidecar(absolute),
      ]);

      return {
        body,
        metadata: toObjectMetadata({
          ...stored,
          size: body.length,
          contentType: stored.contentType,
        }),
      };
    } catch (error) {
      if (isEnoent(error)) {
        throw new StorageObjectNotFoundError(normalized);
      }
      throw error;
    }
  }

  async headObject(key: string): Promise<HeadObjectResult> {
    const normalized = normalizeStorageKey(key);
    const absolute = resolveAbsolutePath(this.root, normalized);

    try {
      const [fileStat, stored] = await Promise.all([
        stat(absolute),
        readSidecar(absolute),
      ]);

      if (!fileStat.isFile()) {
        return { exists: false };
      }

      return {
        exists: true,
        metadata: toObjectMetadata({
          ...stored,
          size: fileStat.size,
        }),
      };
    } catch (error) {
      if (isEnoent(error)) {
        return { exists: false };
      }
      throw error;
    }
  }

  async getMetadata(key: string): Promise<ObjectMetadata> {
    const head = await this.headObject(key);
    if (!head.exists || !head.metadata) {
      throw new StorageObjectNotFoundError(normalizeStorageKey(key));
    }
    return head.metadata;
  }

  async deleteObject(key: string): Promise<void> {
    const normalized = normalizeStorageKey(key);
    const absolute = resolveAbsolutePath(this.root, normalized);

    await Promise.all([
      unlink(absolute).catch((error) => {
        if (!isEnoent(error)) throw error;
      }),
      unlink(sidecarPath(absolute)).catch((error) => {
        if (!isEnoent(error)) throw error;
      }),
    ]);
  }

  async getSignedDownloadUrl(_key: string, _ttlSeconds?: number): Promise<string> {
    throw new StorageConfigError(
      "Signed download URLs are not supported by the local storage adapter"
    );
  }

  getPublicUrl(_key: string): string | null {
    return null;
  }
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
