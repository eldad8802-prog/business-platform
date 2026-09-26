/**
 * Minimal, dependency-free ZIP central-directory reader for UNTRUSTED archives
 * (XLSX imports, OOXML attachments). It exists so size / entry-count / ratio
 * limits can be enforced BEFORE a full archive library (JSZip inside ExcelJS)
 * inflates everything into memory — the zip-bomb path of L-5.
 *
 * It reads only what the archive declares, then {@link inflateZipEntry}
 * inflates a single entry with a HARD output cap (zlib `maxOutputLength`) and
 * checks the real size equals the declared one, so a lying header cannot
 * smuggle a larger payload past the declared-size checks.
 *
 * ZIP64 is refused: nothing this platform accepts needs it (imports are capped
 * at 10MB compressed), and its 0xFFFFFFFF sentinels would otherwise hide sizes.
 */

import { inflateRawSync } from "node:zlib";

export type ZipEntryInfo = {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  encrypted: boolean;
};

export type ZipInspectErrorCode =
  | "ZIP_MALFORMED"
  | "ZIP64_UNSUPPORTED"
  | "ZIP_TOO_MANY_ENTRIES"
  | "ZIP_ENCRYPTED"
  | "ZIP_UNSUPPORTED_METHOD"
  | "ZIP_ENTRY_TOO_LARGE"
  | "ZIP_SIZE_MISMATCH";

export class ZipInspectError extends Error {
  constructor(readonly code: ZipInspectErrorCode, message: string) {
    super(message);
    this.name = "ZipInspectError";
  }
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;

export function looksLikeZip(buffer: Buffer): boolean {
  return (
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    buffer[2] === 0x03 &&
    buffer[3] === 0x04
  );
}

function findEocd(buffer: Buffer): number {
  const lowest = Math.max(0, buffer.length - EOCD_MIN - MAX_COMMENT);
  for (let i = buffer.length - EOCD_MIN; i >= lowest; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/** Read the central directory. Throws ZipInspectError; never inflates. */
export function readZipCentralDirectory(
  buffer: Buffer,
  limits: { maxEntries: number }
): ZipEntryInfo[] {
  if (buffer.length < EOCD_MIN) {
    throw new ZipInspectError("ZIP_MALFORMED", "archive too short");
  }
  const eocd = findEocd(buffer);
  if (eocd < 0) throw new ZipInspectError("ZIP_MALFORMED", "no end-of-central-directory");

  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipInspectError("ZIP64_UNSUPPORTED", "ZIP64 archives are not accepted");
  }
  if (totalEntries > limits.maxEntries) {
    throw new ZipInspectError(
      "ZIP_TOO_MANY_ENTRIES",
      `archive declares ${totalEntries} entries (max ${limits.maxEntries})`
    );
  }
  if (cdOffset + cdSize > eocd) {
    throw new ZipInspectError("ZIP_MALFORMED", "central directory out of bounds");
  }

  const entries: ZipEntryInfo[] = [];
  let p = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (p + 46 > eocd || buffer.readUInt32LE(p) !== CEN_SIG) {
      throw new ZipInspectError("ZIP_MALFORMED", "bad central directory entry");
    }
    const flags = buffer.readUInt16LE(p + 8);
    const method = buffer.readUInt16LE(p + 10);
    const compressedSize = buffer.readUInt32LE(p + 20);
    const uncompressedSize = buffer.readUInt32LE(p + 24);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localHeaderOffset = buffer.readUInt32LE(p + 42);
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      throw new ZipInspectError("ZIP64_UNSUPPORTED", "ZIP64 entry");
    }
    const nameEnd = p + 46 + nameLen;
    if (nameEnd > eocd) throw new ZipInspectError("ZIP_MALFORMED", "entry name out of bounds");
    const name = buffer.toString("utf8", p + 46, nameEnd);
    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      encrypted: (flags & 0x1) === 0x1,
    });
    p = nameEnd + extraLen + commentLen;
  }
  return entries;
}

/**
 * Inflate ONE entry with a hard output ceiling. The inflater itself stops at
 * `maxBytes`, so a bomb costs at most `maxBytes` of memory, and the result must
 * equal the declared size (a lying central directory is refused).
 */
export function inflateZipEntry(
  buffer: Buffer,
  entry: ZipEntryInfo,
  maxBytes: number
): Buffer {
  if (entry.encrypted) throw new ZipInspectError("ZIP_ENCRYPTED", "encrypted entry");
  if (entry.uncompressedSize > maxBytes) {
    throw new ZipInspectError("ZIP_ENTRY_TOO_LARGE", `entry ${entry.name} too large`);
  }
  const loc = entry.localHeaderOffset;
  if (loc + 30 > buffer.length || buffer.readUInt32LE(loc) !== LOC_SIG) {
    throw new ZipInspectError("ZIP_MALFORMED", "bad local header");
  }
  const dataStart = loc + 30 + buffer.readUInt16LE(loc + 26) + buffer.readUInt16LE(loc + 28);
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buffer.length) {
    throw new ZipInspectError("ZIP_MALFORMED", "entry data out of bounds");
  }
  const data = buffer.subarray(dataStart, dataEnd);

  let out: Buffer;
  if (entry.method === 0) {
    out = Buffer.from(data);
  } else if (entry.method === 8) {
    try {
      // +1 so "exactly the declared size" is distinguishable from "more".
      out = inflateRawSync(data, { maxOutputLength: Math.max(1, entry.uncompressedSize + 1) });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "ERR_BUFFER_TOO_LARGE" || error instanceof RangeError) {
        throw new ZipInspectError("ZIP_SIZE_MISMATCH", `entry ${entry.name} inflates past its declared size`);
      }
      throw new ZipInspectError("ZIP_MALFORMED", `entry ${entry.name} does not inflate`);
    }
  } else {
    throw new ZipInspectError("ZIP_UNSUPPORTED_METHOD", `compression method ${entry.method}`);
  }
  if (out.length !== entry.uncompressedSize) {
    throw new ZipInspectError("ZIP_SIZE_MISMATCH", `entry ${entry.name} size differs from its header`);
  }
  return out;
}
