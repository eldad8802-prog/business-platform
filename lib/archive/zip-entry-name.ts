/**
 * Zip entry-name safety (L-6, zip-slip).
 *
 * An entry name is a PATH to whoever extracts the archive. A name containing
 * `..`, an absolute path, a drive letter or a backslash can write outside the
 * extraction directory on the accountant's machine (zip-slip). Names built
 * from request input (e.g. the accountant pack's `month`) must never reach
 * `archive.append` unchecked, so collectArchiveToBuffer runs every name through
 * {@link assertSafeZipEntryName}; a bad name aborts the whole archive.
 */

export class UnsafeZipEntryNameError extends Error {
  constructor(readonly entryName: string, reason: string) {
    super(`Unsafe zip entry name (${reason}): ${JSON.stringify(entryName.slice(0, 120))}`);
    this.name = "UnsafeZipEntryNameError";
  }
}

const MAX_ENTRY_NAME_BYTES = 255;

export function assertSafeZipEntryName(name: unknown): string {
  if (typeof name !== "string" || name.length === 0) {
    throw new UnsafeZipEntryNameError(String(name ?? ""), "empty");
  }
  if (Buffer.byteLength(name, "utf8") > MAX_ENTRY_NAME_BYTES) {
    throw new UnsafeZipEntryNameError(name, "too long");
  }
  for (const ch of name) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) {
      throw new UnsafeZipEntryNameError(name, "control character");
    }
  }
  if (name.includes("\\")) {
    throw new UnsafeZipEntryNameError(name, "backslash");
  }
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
    throw new UnsafeZipEntryNameError(name, "absolute path");
  }
  const segments = name.split("/");
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    // A trailing "/" (directory entry) leaves one empty last segment — allowed.
    if (seg === "" && i === segments.length - 1 && i > 0) continue;
    if (seg === "" || seg === "." || seg === "..") {
      throw new UnsafeZipEntryNameError(name, "path traversal segment");
    }
  }
  return name;
}
