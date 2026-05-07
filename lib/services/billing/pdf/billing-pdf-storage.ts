// Billing PDF storage adapter — local filesystem.
//
// The only layer that knows where PDF bytes live on disk. Swapping to S3 or
// any other object store should require touching this file alone, preserving
// the public surface (buildStorageKey / existsByKey / writeAtomic / readByKey).
//
// Pure FS concern: must NOT import Prisma, pdfmake, or any Billing service.

import { promises as fs } from "fs";
import * as path from "path";
import { randomBytes } from "crypto";

const STORAGE_ROOT_ENV = "BILLING_PDF_STORAGE_ROOT";
const DEFAULT_STORAGE_ROOT = "./storage/billing-pdf";

function getStorageRootAbsolute(): string {
  const raw = process.env[STORAGE_ROOT_ENV] ?? DEFAULT_STORAGE_ROOT;
  return path.resolve(raw);
}

// Storage key is a stable, POSIX-style relative path. The hash makes each
// rendered version uniquely addressable, so concurrent renders that produce
// the same bytes (deterministic pdfmake output) collapse onto the same file.
export function buildStorageKey(
  businessId: number,
  billingDocumentId: number,
  pdfHash: string
): string {
  if (!Number.isInteger(businessId) || businessId <= 0) {
    throw new Error("buildStorageKey: invalid businessId");
  }
  if (!Number.isInteger(billingDocumentId) || billingDocumentId <= 0) {
    throw new Error("buildStorageKey: invalid billingDocumentId");
  }
  if (!/^[a-f0-9]{64}$/i.test(pdfHash)) {
    throw new Error("buildStorageKey: pdfHash must be a 64-char hex sha256");
  }
  return `billing/${businessId}/${billingDocumentId}/${pdfHash}.pdf`;
}

// Resolve a storage key to an absolute path under the configured root,
// rejecting any traversal attempt that would escape the root.
function resolveStoragePathStrict(storageKey: string): string {
  if (!storageKey || typeof storageKey !== "string") {
    throw new Error("resolveStoragePath: storageKey is required");
  }
  if (storageKey.includes("\0")) {
    throw new Error("resolveStoragePath: invalid storageKey");
  }
  const root = getStorageRootAbsolute();
  // Normalize the key to platform separators for path.resolve.
  const normalizedKey = storageKey.split("/").join(path.sep);
  const absolute = path.resolve(root, normalizedKey);
  // Containment check: the absolute path must be exactly inside the root.
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (absolute !== root && !absolute.startsWith(rootWithSep)) {
    throw new Error("resolveStoragePath: storageKey escapes storage root");
  }
  return absolute;
}

export async function existsByKey(storageKey: string): Promise<boolean> {
  const absolute = resolveStoragePathStrict(storageKey);
  try {
    const stat = await fs.stat(absolute);
    return stat.isFile() && stat.size > 0;
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw err;
  }
}

export async function readByKey(storageKey: string): Promise<Buffer> {
  const absolute = resolveStoragePathStrict(storageKey);
  return await fs.readFile(absolute);
}

// Atomic write: stage to a unique temp file inside the same directory, then
// rename onto the final path. The temp lives next to the destination so the
// rename is a same-volume operation (atomic on POSIX, replace-existing on
// Windows when EEXIST/EPERM is raised).
export async function writeAtomic(
  storageKey: string,
  buffer: Buffer
): Promise<void> {
  const absolute = resolveStoragePathStrict(storageKey);
  const dir = path.dirname(absolute);
  await fs.mkdir(dir, { recursive: true });

  const tmpPath = `${absolute}.tmp.${randomBytes(6).toString("hex")}`;
  try {
    await fs.writeFile(tmpPath, buffer);
    try {
      await fs.rename(tmpPath, absolute);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      // Windows can refuse rename-over-existing with EEXIST or EPERM; clear
      // the destination once and retry. Same-volume so still effectively
      // atomic from any reader's point of view.
      if (code === "EEXIST" || code === "EPERM") {
        try {
          await fs.unlink(absolute);
        } catch {
          // ignore: dest may have been removed by a concurrent writer
        }
        await fs.rename(tmpPath, absolute);
      } else {
        throw err;
      }
    }
  } catch (err) {
    try {
      await fs.unlink(tmpPath);
    } catch {
      // best-effort tmp cleanup
    }
    throw err;
  }
}

// Best-effort cleanup; never throws. Used when render succeeds but the DB
// update fails and we want to avoid leaving orphan files. Safe to call
// when the file does not exist.
export async function unlinkByKeyQuiet(storageKey: string): Promise<void> {
  try {
    const absolute = resolveStoragePathStrict(storageKey);
    await fs.unlink(absolute);
  } catch {
    // ignore
  }
}
