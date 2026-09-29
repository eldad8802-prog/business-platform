import type { StorageConfig, StorageProvider } from "./types";
import { StorageConfigError } from "./storage.errors";

const DEFAULT_LOCAL_ROOT = "./storage/platform";
const DEFAULT_SIGNED_URL_TTL_SECONDS = 300;

function readProvider(): StorageProvider {
  const raw = process.env.STORAGE_PROVIDER?.trim().toLowerCase();
  if (!raw || raw === "local") {
    return "local";
  }
  if (raw === "r2") {
    return "r2";
  }
  throw new StorageConfigError(
    `Invalid STORAGE_PROVIDER "${raw}". Expected "local" or "r2".`
  );
}

function requireNonEmpty(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new StorageConfigError(`${name} is not configured`);
  }
  return value;
}

function readSignedUrlTtlSeconds(): number {
  const raw = process.env.STORAGE_SIGNED_URL_TTL_SECONDS?.trim();
  if (!raw) {
    return DEFAULT_SIGNED_URL_TTL_SECONDS;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new StorageConfigError(
      "STORAGE_SIGNED_URL_TTL_SECONDS must be a positive number"
    );
  }

  return Math.floor(parsed);
}

export function loadStorageConfig(): StorageConfig {
  const provider = readProvider();
  const signedUrlTtlSeconds = readSignedUrlTtlSeconds();
  const isProduction = process.env.NODE_ENV === "production";

  if (isProduction && provider === "local") {
    throw new StorageConfigError(
      "STORAGE_PROVIDER=local is not allowed in production"
    );
  }

  if (provider === "local") {
    const localRoot =
      process.env.LOCAL_STORAGE_ROOT?.trim() || DEFAULT_LOCAL_ROOT;

    return {
      provider,
      localRoot,
      signedUrlTtlSeconds,
    };
  }

  const accountId = requireNonEmpty("R2_ACCOUNT_ID");
  const accessKeyId = requireNonEmpty("R2_ACCESS_KEY_ID");
  const secretAccessKey = requireNonEmpty("R2_SECRET_ACCESS_KEY");
  const buckets = resolveR2Buckets();

  return {
    provider: "r2",
    signedUrlTtlSeconds,
    r2: {
      accountId,
      accessKeyId,
      secretAccessKey,
      ...buckets,
    },
  };
}

function optionalEnv(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

let legacyTopologyWarned = false;

/** Test-only: allow a test to observe the warning again. */
export function resetStorageTopologyWarningForTests(): void {
  legacyTopologyWarned = false;
}

/**
 * H-4 bucket topology resolution. Pure over process.env.
 *
 *   R2_PRIVATE_BUCKET_NAME + R2_PUBLIC_BUCKET_NAME  -> "split"
 *       (must differ; R2_PUBLIC_BASE_URL binds to the PUBLIC bucket only)
 *   only R2_BUCKET_NAME                             -> "legacy-single" + loud warning
 *   exactly one of the split pair                   -> StorageConfigError (a half
 *       split would silently route one class of objects to the wrong place)
 */
export function resolveR2Buckets(): Pick<
  NonNullable<StorageConfig["r2"]>,
  "topology" | "privateBucketName" | "publicBucketName" | "publicBaseUrl"
> {
  const privateBucket = optionalEnv("R2_PRIVATE_BUCKET_NAME");
  const publicBucket = optionalEnv("R2_PUBLIC_BUCKET_NAME");
  const legacyBucket = optionalEnv("R2_BUCKET_NAME");
  const publicBaseUrl = optionalEnv("R2_PUBLIC_BASE_URL");

  if (privateBucket || publicBucket) {
    if (!privateBucket || !publicBucket) {
      throw new StorageConfigError(
        "R2 bucket split is half-configured: set BOTH R2_PRIVATE_BUCKET_NAME and R2_PUBLIC_BUCKET_NAME (or neither)"
      );
    }
    if (privateBucket === publicBucket) {
      throw new StorageConfigError(
        "R2_PRIVATE_BUCKET_NAME and R2_PUBLIC_BUCKET_NAME must name different buckets"
      );
    }
    if (legacyBucket && legacyBucket !== privateBucket && !legacyTopologyWarned) {
      legacyTopologyWarned = true;
      console.warn(
        JSON.stringify({
          event: "storage_topology_legacy_bucket_ignored",
          message:
            "R2_BUCKET_NAME is set alongside the private/public split and is ignored.",
        })
      );
    }
    return {
      topology: "split",
      privateBucketName: privateBucket,
      publicBucketName: publicBucket,
      publicBaseUrl,
    };
  }

  if (!legacyBucket) {
    throw new StorageConfigError(
      "R2 bucket is not configured: set R2_PRIVATE_BUCKET_NAME and R2_PUBLIC_BUCKET_NAME"
    );
  }

  if (!legacyTopologyWarned) {
    legacyTopologyWarned = true;
    // Loud on purpose: this topology relies on object metadata for privacy,
    // which R2 does not enforce. Any public exposure of the bucket (r2.dev or a
    // custom domain) serves private documents to anyone who has a key.
    console.error(
      JSON.stringify({
        event: "storage_topology_legacy_single_bucket",
        severity: "SECURITY_WARNING",
        publicBaseUrlConfigured: Boolean(publicBaseUrl),
        message:
          "Private documents and public assets share ONE R2 bucket. Migrate to R2_PRIVATE_BUCKET_NAME + R2_PUBLIC_BUCKET_NAME (see docs/security/r2-bucket-split.md).",
      })
    );
  }

  return {
    topology: "legacy-single",
    privateBucketName: legacyBucket,
    publicBucketName: legacyBucket,
    publicBaseUrl,
  };
}
