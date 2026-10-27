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

export interface StorageService {
  putObject(input: PutObjectInput): Promise<PutObjectResult>;
  getObject(key: string): Promise<GetObjectResult>;
  headObject(key: string): Promise<HeadObjectResult>;
  getMetadata(key: string): Promise<ObjectMetadata>;
  deleteObject(key: string): Promise<void>;
  getSignedDownloadUrl(key: string, ttlSeconds?: number, response?: SignedDownloadResponse): Promise<string>;
  getPublicUrl(key: string): string | null;
}

/**
 * Optional response headers a signed GET asks the storage host to send (S3 response-content-*). Lets a
 * private object open in the browser (inline) or save under a given name (attachment) without changing
 * the object. Absent = the object's own headers, as before.
 */
export type SignedDownloadResponse = { contentDisposition?: string; contentType?: string };
