/**
 * Real-byte fixtures for the sec(D) behavioural battery. Generated in code so
 * no binary blob is committed. The PNG is a complete, CRC-correct 1x1 image;
 * the others carry the real container headers the detectors check.
 */

import { deflateRawSync, deflateSync } from "node:zlib";

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** A valid 1x1 RGBA PNG. `extra` is appended as a tEXt chunk (polyglot tests). */
export function png(extra?: string): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.from([0, 255, 0, 0, 255]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    ...(extra ? [pngChunk("tEXt", Buffer.from(`Comment\0${extra}`, "latin1"))] : []),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** JPEG (SOI + JFIF APP0 header). */
export function jpeg(): Buffer {
  return Buffer.from(
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
    "base64"
  );
}

export function gif(): Buffer {
  return Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
}

export function webp(): Buffer {
  const vp8l = Buffer.from([0x2f, 0x00, 0x00, 0x00, 0x00, 0x88, 0x88, 0x08, 0x08, 0x08, 0x08, 0x00]);
  const chunk = Buffer.concat([Buffer.from("VP8L", "latin1"), u32le(vp8l.length), vp8l]);
  const body = Buffer.concat([Buffer.from("WEBP", "latin1"), chunk]);
  return Buffer.concat([Buffer.from("RIFF", "latin1"), u32le(body.length), body, Buffer.alloc(16)]);
}

/** ISO-BMFF ftyp (isom) + an empty mdat — detected as MP4. */
export function mp4(): Buffer {
  const ftyp = Buffer.concat([
    u32be(24),
    Buffer.from("ftypisom", "latin1"),
    u32be(0x200),
    Buffer.from("isomiso2", "latin1"),
  ]);
  return Buffer.concat([ftyp, u32be(40), Buffer.from("mdat", "latin1"), Buffer.alloc(32)]);
}

export function pdf(): Buffer {
  return Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n", "latin1");
}

export const SVG = Buffer.from(
  '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(document.domain)</script></svg>',
  "utf8"
);

export const HTML = Buffer.from(
  "<!doctype html><html><body><script>fetch('/api/me')</script>padding padding padding</body></html>",
  "utf8"
);

function u32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}
function u32be(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

// ---------------------------------------------------------------- ZIP writer
export type ZipSpec = {
  name: string;
  data: Buffer;
  /** deflate (default) or store */
  method?: 0 | 8;
  /** Override the DECLARED uncompressed size (lying headers). */
  declaredSize?: number;
};

/** Minimal ZIP writer (no ZIP64) for fixtures: OOXML, xlsx, bombs, traversal. */
export function buildZip(entries: ZipSpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const method = e.method ?? 8;
    const comp = method === 8 ? deflateRawSync(e.data) : e.data;
    const crc = crc32(e.data);
    const name = Buffer.from(e.name, "utf8");
    const size = e.declaredSize ?? e.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(size, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    centrals.push(cen, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const CT = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>';

export function docx(extra: ZipSpec[] = []): Buffer {
  return buildZip([
    { name: "[Content_Types].xml", data: Buffer.from(CT) },
    { name: "word/document.xml", data: Buffer.from("<w:document/>") },
    ...extra,
  ]);
}

/** A minimal xlsx whose single sheet XML is `sheetXml`. */
export function xlsxWithSheet(sheetXml: string, opts?: { declaredSize?: number }): Buffer {
  return buildZip([
    { name: "[Content_Types].xml", data: Buffer.from(CT) },
    { name: "xl/workbook.xml", data: Buffer.from("<workbook/>") },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.from(sheetXml), declaredSize: opts?.declaredSize },
  ]);
}
