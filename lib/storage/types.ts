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
  getSignedDownloadUrl(key: string, ttlSeconds?: number): Promise<string>;
  getPublicUrl(key: string): string | null;
}
