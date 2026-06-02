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
  const bucketName = requireNonEmpty("R2_BUCKET_NAME");
  const publicBaseUrl = process.env.R2_PUBLIC_BASE_URL?.trim() || undefined;

  return {
    provider: "r2",
    signedUrlTtlSeconds,
    r2: {
      accountId,
      accessKeyId,
      secretAccessKey,
      bucketName,
      publicBaseUrl,
    },
  };
}
