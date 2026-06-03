import type { PutObjectMetadataInput, StorageDomain, StorageVisibility } from "./types";
import { StorageKeyError } from "./storage.errors";

const DOMAIN_DEFAULT_VISIBILITY: Record<StorageDomain, StorageVisibility> = {
  documents: "private",
  billing: "private",
  content: "public",
  inventory: "public",
  offers: "public",
};

const DOMAIN_REQUIRED_VISIBILITY: Record<StorageDomain, StorageVisibility> = {
  documents: "private",
  billing: "private",
  content: "public",
  inventory: "public",
  offers: "public",
};

export function getDefaultVisibility(domain: StorageDomain): StorageVisibility {
  return DOMAIN_DEFAULT_VISIBILITY[domain];
}

export function getRequiredVisibility(domain: StorageDomain): StorageVisibility {
  return DOMAIN_REQUIRED_VISIBILITY[domain];
}

export function validatePutObjectMetadata(metadata: PutObjectMetadataInput): void {
  if (!Number.isInteger(metadata.businessId) || metadata.businessId <= 0) {
    throw new StorageKeyError("metadata.businessId must be a positive integer");
  }

  const requiredVisibility = getRequiredVisibility(metadata.domain);
  if (metadata.visibility !== requiredVisibility) {
    throw new StorageKeyError(
      `metadata.visibility for domain "${metadata.domain}" must be "${requiredVisibility}"`
    );
  }
}

export function isPublicVisibility(visibility: StorageVisibility): boolean {
  return visibility === "public";
}

export function isPrivateVisibility(visibility: StorageVisibility): boolean {
  return visibility === "private";
}
