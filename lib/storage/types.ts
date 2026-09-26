export const STORAGE_DOMAINS = [
  "documents",
  "billing",
  "content",
  "inventory",
  "offers",
  "crm",
] as const;

export type StorageDomain = (typeof STORAGE_DOMAINS)[number];

export type StorageVisibility = "private" | "public";

export type StorageProvider = "local" | "r2";

export type StorageConfig = {
  provider: StorageProvider;
  localRoot?: string;
  signedUrlTtlSeconds: number;
  r2?: R2Config;
};

/**
 * Bucket topology (H-4).
 *
 *   split          PRIVATE domains (documents, billing, crm) live in a bucket
 *                  with NO public access; PUBLIC domains (content, inventory,
 *                  offers) live in a separate bucket that may be exposed through
 *                  R2_PUBLIC_BASE_URL. Access control is then enforced by
 *                  Cloudflare per bucket, not by object metadata.
 *   legacy-single  one bucket (R2_BUCKET_NAME) holds everything. Kept only so the
 *                  current deployment keeps working until the owner migrates.
 *                  Object "visibility" is metadata only here, so ANY public
 *                  exposure of that bucket exposes private documents. Loading
 *                  this topology logs a loud warning.
 */
export type R2BucketTopology = "split" | "legacy-single";

export type R2Config = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  topology: R2BucketTopology;
  /** Bucket for documents / billing / crm. Must never be publicly reachable. */
  privateBucketName: string;
  /** Bucket for content / inventory / offers. Equals privateBucketName only in legacy-single. */
  publicBucketName: string;
  /** Public base URL — bound to the PUBLIC bucket only. */
  publicBaseUrl?: string;
};

export type ObjectMetadata = {
  businessId: number;
  domain: StorageDomain;
  visibility: StorageVisibility;
  contentType: string;
  size: number;
  createdAt: string;
  custom?: Record<string, string>;
};

export type PutObjectMetadataInput = Pick<
  ObjectMetadata,
  "businessId" | "domain" | "visibility"
> & {
  custom?: Record<string, string>;
};

export type PutObjectInput = {
  key: string;
  body: Buffer;
  contentType: string;
  metadata: PutObjectMetadataInput;
  /**
   * Serving headers stored WITH the object (S3/R2 system metadata, returned on
   * every GET — including unauthenticated public-bucket GETs). Writers of
   * publicly served objects set these from the VERIFIED type, never the client.
   */
  contentDisposition?: string;
  cacheControl?: string;
};

export type PutObjectResult = {
  key: string;
  etag?: string;
  metadata: ObjectMetadata;
};

export type GetObjectResult = {
  body: Buffer;
  metadata: ObjectMetadata;
};

export type HeadObjectResult = {
  exists: boolean;
  metadata?: ObjectMetadata;
};

export type ParsedStorageKey = {
  businessId: number;
  domain: StorageDomain;
  relativePath: string;
};

export interface StorageService {
  putObject(input: PutObjectInput): Promise<PutObjectResult>;
  getObject(key: string): Promise<GetObjectResult>;
  headObject(key: string): Promise<HeadObjectResult>;
  getMetadata(key: string): Promise<ObjectMetadata>;
  deleteObject(key: string): Promise<void>;
  /**
   * Keys under a tenant+domain-scoped prefix (see assertSafeStoragePrefix).
   * Bounded by `limit` (default 1000); `truncated` says more exist.
   */
  listByPrefix(
    prefix: string,
    options?: { limit?: number }
  ): Promise<{ keys: string[]; truncated: boolean }>;
  /**
   * Delete every object under a tenant+domain-scoped prefix (erasure).
   * Idempotent. Returns how many objects were deleted.
   */
  deleteByPrefix(prefix: string): Promise<{ deleted: number }>;
  getSignedDownloadUrl(key: string, ttlSeconds?: number): Promise<string>;
  getPublicUrl(key: string): string | null;
}
