/**
 * Public asset acceptance (M-2) — what may be written to a PUBLICLY served
 * storage domain (content / inventory / offers), decided from the BYTES.
 *
 * Public objects are fetched by anyone with the URL, straight from the bucket,
 * with no application code in between. Whatever Content-Type is stored is what
 * a browser is told, so a stored `image/svg+xml` (script-capable) or an HTML
 * payload labelled `image/png` is a stored-XSS / phishing host on our domain.
 * The previous acceptance was "any image/* or video/*" plus the CLIENT's
 * declared Content-Type, and unknown image types were stored as `.img`.
 *
 * The rule here:
 *   1. CLOSED allowlist per domain (raster images; video only where the product
 *      uploads video — the content flow). SVG is rejected by policy: it is an
 *      active document format, not a raster image.
 *   2. The container is DETECTED from magic bytes; the declared type and the
 *      filename extension must both agree with what was detected.
 *   3. Active-content markers anywhere in the bytes (`<script`, `<html`,
 *      `<svg`, ...) reject the file — this catches image/HTML polyglots whose
 *      header is a valid image.
 *   4. Size bounds are checked against the real byte length.
 *   5. The STORED Content-Type is the canonical type of the detected container
 *      (never the client's string), and serving headers are fixed server-side:
 *      `inline` only for verified raster images, `attachment` for video.
 *
 * Nothing here writes. putPublicAsset calls {@link verifyPublicAsset} BEFORE it
 * touches storage, so a rejected file never produces an object.
 *
 * Like the documents signature check, this is NOT malware scanning.
 */

export type PublicAssetDomainPolicy = "content" | "inventory" | "offers";

export type PublicAssetContainer =
  | "png"
  | "jpeg"
  | "gif"
  | "webp"
  | "mp4"
  | "mov"
  | "webm";

type ContainerSpec = {
  mime: string;
  ext: string;
  kind: "raster" | "video";
  /** Filename extensions consistent with this container. */
  extensions: readonly string[];
};

const CONTAINERS: Record<PublicAssetContainer, ContainerSpec> = {
  png: { mime: "image/png", ext: "png", kind: "raster", extensions: ["png"] },
  jpeg: {
    mime: "image/jpeg",
    ext: "jpg",
    kind: "raster",
    extensions: ["jpg", "jpeg", "jfif", "jpe"],
  },
  gif: { mime: "image/gif", ext: "gif", kind: "raster", extensions: ["gif"] },
  webp: { mime: "image/webp", ext: "webp", kind: "raster", extensions: ["webp"] },
  mp4: { mime: "video/mp4", ext: "mp4", kind: "video", extensions: ["mp4", "m4v"] },
  mov: { mime: "video/quicktime", ext: "mov", kind: "video", extensions: ["mov", "qt"] },
  webm: { mime: "video/webm", ext: "webm", kind: "video", extensions: ["webm"] },
};

/** Declared type → container it names. Anything absent is refused. */
const DECLARED: ReadonlyMap<string, PublicAssetContainer> = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpeg"],
  ["image/jpg", "jpeg"],
  ["image/pjpeg", "jpeg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
  ["video/mp4", "mp4"],
  ["video/quicktime", "mov"],
  ["video/webm", "webm"],
]);

const RASTER: readonly PublicAssetContainer[] = ["png", "jpeg", "gif", "webp"];
const VIDEO: readonly PublicAssetContainer[] = ["mp4", "mov", "webm"];

export const PUBLIC_ASSET_POLICIES: Record<
  PublicAssetDomainPolicy,
  { allowed: readonly PublicAssetContainer[]; maxBytes: number }
> = {
  // The content flow (assets-upload page) uploads photos AND videos for
  // Creatomate rendering, so video stays allowed there — and only there.
  content: { allowed: [...RASTER, ...VIDEO], maxBytes: 10 * 1024 * 1024 },
  inventory: { allowed: RASTER, maxBytes: 5 * 1024 * 1024 },
  offers: { allowed: RASTER, maxBytes: 5 * 1024 * 1024 },
};

/** Smaller than any real image header+payload; refuses 0-byte and stub files. */
export const PUBLIC_ASSET_MIN_BYTES = 32;

/** Extensions that name an active / document format — always refused. */
const DANGEROUS_EXTENSIONS = new Set([
  "svg",
  "svgz",
  "html",
  "htm",
  "xhtml",
  "xht",
  "xml",
  "xsl",
  "js",
  "mjs",
  "css",
  "php",
  "pdf",
  "swf",
  "exe",
  "bat",
  "cmd",
  "sh",
]);

/**
 * Byte sequences that make a file "active" when a browser is convinced to
 * render it as a document. Checked case-insensitively over the WHOLE file.
 */
const ACTIVE_CONTENT_MARKERS = [
  "<script",
  "<html",
  "<svg",
  "<!doctype",
  "<iframe",
  "<body",
  "<object",
  "<embed",
  "<?xml-stylesheet",
  "javascript:",
] as const;

export type PublicAssetRejectionCode =
  | "EMPTY"
  | "TOO_SMALL"
  | "TOO_LARGE"
  | "UNSUPPORTED_TYPE"
  | "UNRECOGNISED_CONTENT"
  | "CONTENT_TYPE_MISMATCH"
  | "EXTENSION_MISMATCH"
  | "ACTIVE_CONTENT";

export type VerifiedPublicAsset = {
  ok: true;
  container: PublicAssetContainer;
  /** Canonical type of the DETECTED container — what gets stored. */
  contentType: string;
  ext: string;
  kind: "raster" | "video";
  contentDisposition: string;
  cacheControl: string;
};

export type PublicAssetRejection = {
  ok: false;
  code: PublicAssetRejectionCode;
  /** 413 for size, 415 for every content/type refusal. */
  status: 413 | 415;
  message: string;
};

export type PublicAssetVerdict = VerifiedPublicAsset | PublicAssetRejection;

/** Thrown by putPublicAsset when a caller skipped (or failed) verification. */
export class PublicAssetRejectedError extends Error {
  readonly code: PublicAssetRejectionCode;
  readonly status: 413 | 415;
  constructor(rejection: PublicAssetRejection) {
    super(rejection.message);
    this.name = "PublicAssetRejectedError";
    this.code = rejection.code;
    this.status = rejection.status;
  }
}

function ascii(buffer: Buffer, start: number, end: number): string {
  if (buffer.length < end) return "";
  return buffer.toString("latin1", start, end);
}

function startsWith(buffer: Buffer, bytes: readonly number[]): boolean {
  if (buffer.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buffer[i] !== bytes[i]) return false;
  }
  return true;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIG = [0xff, 0xd8, 0xff];
const EBML_SIG = [0x1a, 0x45, 0xdf, 0xa3];

/** ISO-BMFF major brands accepted as MP4 video. HEIF/AVIF/audio brands are not. */
const MP4_BRANDS = new Set([
  "isom",
  "iso2",
  "iso3",
  "iso4",
  "iso5",
  "iso6",
  "mp41",
  "mp42",
  "avc1",
  "M4V ",
  "dash",
  "mmp4",
]);

/** Detect the container from magic bytes; null when it is none we accept. */
export function detectPublicAssetContainer(
  buffer: Buffer
): PublicAssetContainer | null {
  if (startsWith(buffer, PNG_SIG)) {
    // A real PNG's first chunk is IHDR.
    return ascii(buffer, 12, 16) === "IHDR" ? "png" : null;
  }
  if (startsWith(buffer, JPEG_SIG)) return "jpeg";
  const head6 = ascii(buffer, 0, 6);
  if (head6 === "GIF87a" || head6 === "GIF89a") return "gif";
  if (ascii(buffer, 0, 4) === "RIFF" && ascii(buffer, 8, 12) === "WEBP") {
    const chunk = ascii(buffer, 12, 16);
    return chunk === "VP8 " || chunk === "VP8L" || chunk === "VP8X"
      ? "webp"
      : null;
  }
  if (ascii(buffer, 4, 8) === "ftyp") {
    const brand = ascii(buffer, 8, 12);
    if (brand === "qt  ") return "mov";
    if (MP4_BRANDS.has(brand)) return "mp4";
    return null;
  }
  if (startsWith(buffer, EBML_SIG)) {
    // EBML DocType "webm" sits in the first header bytes.
    return buffer.subarray(0, 64).includes(Buffer.from("webm", "latin1"))
      ? "webm"
      : null;
  }
  return null;
}

export function findActiveContentMarker(buffer: Buffer): string | null {
  // latin1 is a 1:1 byte→char map, so this is a byte search, not a decode.
  const haystack = buffer.toString("latin1").toLowerCase();
  for (const marker of ACTIVE_CONTENT_MARKERS) {
    if (haystack.includes(marker)) return marker;
  }
  return null;
}

function extensionOf(fileName: string | null | undefined): string | null {
  const base = String(fileName ?? "").split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return null;
  return base.slice(dot + 1).toLowerCase();
}

function reject(
  code: PublicAssetRejectionCode,
  message: string
): PublicAssetRejection {
  return {
    ok: false,
    code,
    status: code === "TOO_LARGE" ? 413 : 415,
    message,
  };
}

/** Same MIME family: an iPhone .mov declared as video/mp4 (or vice versa). */
function sameVideoFamily(a: PublicAssetContainer, b: PublicAssetContainer): boolean {
  return (a === "mp4" || a === "mov") && (b === "mp4" || b === "mov");
}

export function verifyPublicAsset(input: {
  domain: PublicAssetDomainPolicy;
  body: Buffer;
  declaredContentType: string | null | undefined;
  fileName?: string | null;
}): PublicAssetVerdict {
  const policy = PUBLIC_ASSET_POLICIES[input.domain];
  if (!policy) {
    return reject("UNSUPPORTED_TYPE", "Unsupported asset domain");
  }
  const body = input.body;

  if (!body || body.length === 0) return reject("EMPTY", "Empty file");
  if (body.length > policy.maxBytes) {
    return reject(
      "TOO_LARGE",
      `File too large (max ${Math.round(policy.maxBytes / 1024 / 1024)}MB)`
    );
  }
  if (body.length < PUBLIC_ASSET_MIN_BYTES) {
    return reject("TOO_SMALL", "File is too small to be a valid image");
  }

  const declared = String(input.declaredContentType ?? "").toLowerCase().trim();
  const declaredContainer = DECLARED.get(declared) ?? null;
  if (!declaredContainer || !policy.allowed.includes(declaredContainer)) {
    return reject("UNSUPPORTED_TYPE", "Unsupported file type");
  }

  const ext = extensionOf(input.fileName);
  if (ext && DANGEROUS_EXTENSIONS.has(ext)) {
    return reject("UNSUPPORTED_TYPE", "Unsupported file type");
  }

  const detected = detectPublicAssetContainer(body);
  if (!detected || !policy.allowed.includes(detected)) {
    return reject("UNRECOGNISED_CONTENT", "File content is not a supported image");
  }
  if (detected !== declaredContainer && !sameVideoFamily(detected, declaredContainer)) {
    return reject(
      "CONTENT_TYPE_MISMATCH",
      "File content does not match its declared type"
    );
  }

  const spec = CONTAINERS[detected];
  if (ext) {
    const acceptable =
      spec.extensions.includes(ext) ||
      (sameVideoFamily(detected, declaredContainer) &&
        CONTAINERS[declaredContainer].extensions.includes(ext));
    if (!acceptable) {
      return reject(
        "EXTENSION_MISMATCH",
        "File extension does not match its content"
      );
    }
  }

  if (findActiveContentMarker(body)) {
    return reject("ACTIVE_CONTENT", "File contains active content");
  }

  return {
    ok: true,
    container: detected,
    contentType: spec.mime,
    ext: spec.ext,
    kind: spec.kind,
    // Only a VERIFIED raster may render inline if navigated to directly.
    contentDisposition: spec.kind === "raster" ? "inline" : "attachment",
    // Random (UUID) key per object: the bytes behind a URL never change.
    cacheControl: "public, max-age=31536000, immutable",
  };
}
