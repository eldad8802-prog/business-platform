export type {
  GetObjectResult,
  HeadObjectResult,
  ObjectMetadata,
  ParsedStorageKey,
  PutObjectInput,
  PutObjectMetadataInput,
  PutObjectResult,
  StorageConfig,
  StorageDomain,
  StorageProvider,
  StorageService,
  StorageVisibility,
} from "./types";

export { STORAGE_DOMAINS } from "./types";

export {
  StorageConfigError,
  StorageKeyError,
  StorageObjectNotFoundError,
  StorageVisibilityError,
} from "./storage.errors";

export {
  assertKeyMatchesMetadata,
  assertSafeStorageKey,
  normalizeStorageKey,
  parseStorageKey,
} from "./key-validation";

export {
  getDefaultVisibility,
  getRequiredVisibility,
  isPrivateVisibility,
  isPublicVisibility,
  validatePutObjectMetadata,
} from "./domain-policy";

export { loadStorageConfig } from "./config";

export { LocalFsStorageService } from "./local-storage.adapter";
export { R2StorageService } from "./r2-storage.adapter";

export {
  getStorageService,
  resetStorageServiceForTests,
} from "./storage.factory";
