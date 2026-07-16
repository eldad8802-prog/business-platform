import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  STORAGE_DOMAINS,
  type GetObjectResult,
  type HeadObjectResult,
  type ObjectMetadata,
  type PutObjectInput,
  type PutObjectResult,
  type StorageConfig,
  type StorageDomain,
  type StorageService,
  type StorageVisibility,
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
  parseStorageKey,
} from "./key-validation";
import { isPrivateVisibility, validatePutObjectMetadata } from "./domain-policy";

const META_BUSINESS_ID = "businessid";
const META_DOMAIN = "domain";
const META_VISIBILITY = "visibility";
const META_CREATED_AT = "createdat";
const META_CUSTOM = "custom";

function requireR2Config(config: StorageConfig) {
  if (!config.r2) {
    throw new StorageConfigError("R2 configuration is missing");
  }
  return config.r2;
}

function createR2Client(config: StorageConfig): S3Client {
  const r2 = requireR2Config(config);
  return new S3Client({
    region: "auto",
    endpoint: `https://${r2.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: r2.accessKeyId,
      secretAccessKey: r2.secretAccessKey,
    },
  });
}

function buildPutMetadata(
  input: PutObjectInput,
  createdAt: string
): Record<string, string> {
  return {
    [META_BUSINESS_ID]: String(input.metadata.businessId),
    [META_DOMAIN]: input.metadata.domain,
    [META_VISIBILITY]: input.metadata.visibility,
    [META_CREATED_AT]: createdAt,
    ...(input.metadata.custom
      ? { [META_CUSTOM]: JSON.stringify(input.metadata.custom) }
      : {}),
  };
}

function parseDomain(value: string | undefined): StorageDomain {
  // Derived from STORAGE_DOMAINS (single source of truth) — includes "crm".
  if (value && (STORAGE_DOMAINS as readonly string[]).includes(value)) {
    return value as StorageDomain;
  }
  throw new StorageConfigError("Stored object metadata is missing a valid domain");
}

function parseVisibility(value: string | undefined): StorageVisibility {
  if (value === "private" || value === "public") {
    return value;
  }
  throw new StorageConfigError(
    "Stored object metadata is missing a valid visibility"
  );
}

function decodeObjectMetadata(input: {
  metadata?: Record<string, string>;
  contentType?: string;
  contentLength?: number;
  lastModified?: Date;
}): ObjectMetadata {
  const raw = input.metadata ?? {};
  const businessId = Number(raw[META_BUSINESS_ID]);
  if (!Number.isInteger(businessId) || businessId <= 0) {
    throw new StorageConfigError("Stored object metadata is missing businessId");
  }

  let custom: Record<string, string> | undefined;
  if (raw[META_CUSTOM]) {
    try {
      custom = JSON.parse(raw[META_CUSTOM]) as Record<string, string>;
    } catch {
      custom = undefined;
    }
  }

  const createdAt =
    raw[META_CREATED_AT] ||
    input.lastModified?.toISOString() ||
    new Date().toISOString();

  return {
    businessId,
    domain: parseDomain(raw[META_DOMAIN]),
    visibility: parseVisibility(raw[META_VISIBILITY]),
    contentType: input.contentType || "application/octet-stream",
    size: input.contentLength ?? 0,
    createdAt,
    custom,
  };
}

async function streamToBuffer(body: unknown): Promise<Buffer> {
  if (!body) {
    return Buffer.alloc(0);
  }

  if (Buffer.isBuffer(body)) {
    return body;
  }

  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }

  if (
    typeof body === "object" &&
    body !== null &&
    Symbol.asyncIterator in body
  ) {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  throw new StorageConfigError("Unsupported object body stream type");
}

export class R2StorageService implements StorageService {
  private readonly client: S3Client;

  constructor(private readonly config: StorageConfig) {
    this.client = createR2Client(config);
  }

  private get bucket(): string {
    return requireR2Config(this.config).bucketName;
  }

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    validatePutObjectMetadata(input.metadata);
    const key = assertSafeStorageKey(input.key);
    assertKeyMatchesMetadata(
      key,
      input.metadata.businessId,
      input.metadata.domain
    );

    const createdAt = new Date().toISOString();
    const metadata = buildPutMetadata(input, createdAt);

    const result = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: input.body,
        ContentType: input.contentType,
        ContentLength: input.body.length,
        Metadata: metadata,
      })
    );

    return {
      key,
      etag: result.ETag ?? undefined,
      metadata: {
        businessId: input.metadata.businessId,
        domain: input.metadata.domain,
        visibility: input.metadata.visibility,
        contentType: input.contentType,
        size: input.body.length,
        createdAt,
        custom: input.metadata.custom,
      },
    };
  }

  async getObject(key: string): Promise<GetObjectResult> {
    const normalized = normalizeStorageKey(key);

    try {
      const result = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: normalized,
        })
      );

      const body = await streamToBuffer(result.Body);
      const metadata = decodeObjectMetadata({
        metadata: result.Metadata,
        contentType: result.ContentType,
        contentLength: body.length,
        lastModified: result.LastModified,
      });

      return { body, metadata };
    } catch (error) {
      if (isNotFound(error)) {
        throw new StorageObjectNotFoundError(normalized);
      }
      throw error;
    }
  }

  async headObject(key: string): Promise<HeadObjectResult> {
    const normalized = normalizeStorageKey(key);

    try {
      const result = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: normalized,
        })
      );

      return {
        exists: true,
        metadata: decodeObjectMetadata({
          metadata: result.Metadata,
          contentType: result.ContentType,
          contentLength: result.ContentLength,
          lastModified: result.LastModified,
        }),
      };
    } catch (error) {
      if (isNotFound(error)) {
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
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: normalized,
      })
    );
  }

  async getSignedDownloadUrl(key: string, ttlSeconds?: number): Promise<string> {
    const normalized = normalizeStorageKey(key);
    const metadata = await this.getMetadata(normalized);

    if (!isPrivateVisibility(metadata.visibility)) {
      throw new StorageVisibilityError(
        "Signed download URLs are only available for private objects"
      );
    }

    const ttl = ttlSeconds ?? this.config.signedUrlTtlSeconds;
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: normalized,
      }),
      { expiresIn: ttl }
    );
  }

  getPublicUrl(key: string): string | null {
    const normalized = normalizeStorageKey(key);
    const parsed = parseStorageKey(normalized);
    const publicBaseUrl = requireR2Config(this.config).publicBaseUrl;

    if (!publicBaseUrl) {
      return null;
    }

    if (
      parsed.domain !== "content" &&
      parsed.domain !== "inventory" &&
      parsed.domain !== "offers"
    ) {
      return null;
    }

    const base = publicBaseUrl.replace(/\/+$/, "");
    return `${base}/${normalized}`;
  }
}

function isNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error.name === "NotFound" || error.name === "NoSuchKey") {
    return true;
  }

  if ("$metadata" in error) {
    const httpStatusCode = (
      error as { $metadata?: { httpStatusCode?: number } }
    ).$metadata?.httpStatusCode;
    return httpStatusCode === 404;
  }

  return false;
}
