export const STORAGE_DOMAINS = [
  "documents",
  "billing",
  "content",
  "inventory",
  "offers",
  "crm",
  /** P3-A — private supporting documents of owner trust claims (licence / certificate scans). */
  "trust",
  /** Monthly accountant packages — PRIVATE generated ZIPs, keyed biz/{id}/exports/accountant/{YYYY-MM}/… */
  "exports",
  /**
   * Business documents (ר1 / letters) — PRIVATE. Conditional writes only (putObjectIfAbsent): a plain putObject is
   * refused, so no write in this domain can ever overwrite an object or land after a deletion fence.
   */
  "business-docs",
  /**
   * Service Desk (1.3-0) — PRIVATE. Keys biz/{id}/service/… (CHECK-limited in every Service table: intake photos,
   * signatures, the intake slip, the sent quote copy). Conditional writes only, like business-docs: no write here can
   * overwrite an object. Account erasure deletes the whole prefix after commit (service-storage-erasure.ts).
   */
  "service",
] as const;

export type StorageDomain = (typeof STORAGE_DOMAINS)[number];

export type StorageVisibility = "private" | "public";

export type StorageProvider = "local" | "r2";

export type StorageConfig = {
  provider: StorageProvider;
  localRoot?: string;
  signedUrlTtlSeconds: number;
  r2?: {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucketName: string;
    publicBaseUrl?: string;
  };
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

/** putObjectIfAbsent: CREATED = this call created the object; EXISTS = an object already had that key (nothing written). */
export type PutIfAbsentResult =
  | { status: "CREATED"; key: string; etag?: string; metadata: ObjectMetadata }
  | { status: "EXISTS"; key: string };

export type ListedObject = { key: string; size: number; lastModified?: string };

export interface StorageService {
  putObject(input: PutObjectInput): Promise<PutObjectResult>;
  getObject(key: string): Promise<GetObjectResult>;
  headObject(key: string): Promise<HeadObjectResult>;
  getMetadata(key: string): Promise<ObjectMetadata>;
  deleteObject(key: string): Promise<void>;
  getSignedDownloadUrl(key: string, ttlSeconds?: number, response?: SignedDownloadResponse): Promise<string>;
  getPublicUrl(key: string): string | null;
  /**
   * Create-once write (S3/R2 `If-None-Match: *`; local: exclusive create). Atomic: of concurrent calls for one key at
   * most one returns CREATED. The only write the "business-docs" domain accepts.
   */
  putObjectIfAbsent(input: PutObjectInput): Promise<PutIfAbsentResult>;
  /** Every object under a key prefix of the form biz/{businessId}/{domain}/… (paginated to the end). */
  listObjects(prefix: string): Promise<ListedObject[]>;
}

/**
 * Optional response headers a signed GET asks the storage host to send (S3 response-content-*). Lets a
 * private object open in the browser (inline) or save under a given name (attachment) without changing
 * the object. Absent = the object's own headers, as before.
 */
export type SignedDownloadResponse = { contentDisposition?: string; contentType?: string };
