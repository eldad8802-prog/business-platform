export type {
  GetObjectResult,
  HeadObjectResult,
  ListedObject,
  ObjectMetadata,
  ParsedStorageKey,
  PutIfAbsentResult,
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
  assertSafeListPrefix,
  assertSafeStorageKey,
  normalizeStorageKey,
  parseStorageKey,
} from "./key-validation";

export {
  assertUnconditionalPutAllowed,
  getDefaultVisibility,
  getRequiredVisibility,
  isConditionalOnlyDomain,
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
