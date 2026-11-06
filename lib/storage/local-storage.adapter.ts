import { randomUUID } from "node:crypto";
import { link, mkdir, readdir, readFile, unlink, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import type {
  GetObjectResult,
  HeadObjectResult,
  ObjectMetadata,
  ListedObject,
  PutIfAbsentResult,
  PutObjectInput,
  PutObjectResult,
  StorageConfig,
  StorageDomain,
  StorageService,
  StorageVisibility,
  SignedDownloadResponse,
} from "./types";
import {
  StorageConfigError,
  StorageObjectNotFoundError,
  StorageVisibilityError,
} from "./storage.errors";
import {
  assertKeyMatchesMetadata,
  assertSafeListPrefix,
  assertSafeStorageKey,
  normalizeStorageKey,
} from "./key-validation";
import { assertUnconditionalPutAllowed, validatePutObjectMetadata } from "./domain-policy";

type StoredSidecarMetadata = {
  businessId: number;
  domain: StorageDomain;
  visibility: StorageVisibility;
  contentType: string;
  size: number;
  createdAt: string;
  custom?: Record<string, string>;
};

const SIDECAR_SUFFIX = ".meta.json";
const TEMP_PREFIX = ".tmp-";

function sidecarPath(absoluteFilePath: string): string {
  return `${absoluteFilePath}${SIDECAR_SUFFIX}`;
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
    assertUnconditionalPutAllowed(input.metadata.domain);
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

  /**
   * Create-once: the body is written to a temporary file first, then hard-linked to the key — link() fails with
   * EEXIST when the key exists, so the object appears complete or not at all, and only one caller can create it.
   */
  async putObjectIfAbsent(input: PutObjectInput): Promise<PutIfAbsentResult> {
    validatePutObjectMetadata(input.metadata);
    const key = assertSafeStorageKey(input.key);
    assertKeyMatchesMetadata(key, input.metadata.businessId, input.metadata.domain);

    const absolute = resolveAbsolutePath(this.root, key);
    await mkdir(path.dirname(absolute), { recursive: true });
    const temp = path.join(path.dirname(absolute), `${TEMP_PREFIX}${randomUUID()}`);
    await writeFile(temp, input.body);
    try {
      await link(temp, absolute);
    } catch (error) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === "EEXIST") {
        return { status: "EXISTS", key };
      }
      throw error;
    } finally {
      await unlink(temp).catch(() => undefined);
    }

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
    await writeFile(sidecarPath(absolute), JSON.stringify(stored), "utf8");
    return { status: "CREATED", key, metadata: toObjectMetadata(stored) };
  }

  async listObjects(prefix: string): Promise<ListedObject[]> {
    const normalized = assertSafeListPrefix(prefix);
    const dirPart = normalized.slice(0, normalized.lastIndexOf("/") + 1);
    const rootAbsolute = path.resolve(this.root);
    const start = path.resolve(rootAbsolute, ...dirPart.split("/").filter(Boolean));
    const out: ListedObject[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        if (isEnoent(error)) return;
        throw error;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        if (entry.name.endsWith(SIDECAR_SUFFIX) || entry.name.startsWith(TEMP_PREFIX)) continue;
        const key = path.relative(rootAbsolute, full).split(path.sep).join("/");
        if (!key.startsWith(normalized)) continue;
        const info = await stat(full);
        out.push({ key, size: info.size, lastModified: info.mtime.toISOString() });
      }
    };
    await walk(start);
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
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

  async getSignedDownloadUrl(_key: string, _ttlSeconds?: number, _response?: SignedDownloadResponse): Promise<string> {
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
