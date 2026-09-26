import {
  validateWhatsAppMediaContent,
  WHATSAPP_MEDIA_MAX_BYTES,
} from "./media-validation.service";
import type {
  FetchAndValidateParams,
  GraphMediaMetadata,
  MediaFetchDeps,
  MediaFetchFailureReason,
  MediaFetchResult,
} from "./media-fetch.types";

const DEFAULT_GRAPH_VERSION = "v20.0";

/**
 * DEV-ONLY fallback token source.
 *
 * In a real Tech Provider model each business holds its own WABA/token, so
 * production media fetches MUST use the per-business token injected by the
 * caller (`documents-intake` → `getAccessTokenForBusiness(businessId)`).
 * This global `WHATSAPP_ACCESS_TOKEN` env is therefore guarded against
 * `NODE_ENV === "production"`: we never silently use a single global token
 * for a tenant's media in production. It remains available for local/dev and
 * tests where no per-business token is wired.
 */
function getAccessTokenFromEnv(): string | null {
  if (process.env.NODE_ENV === "production") return null;
  const v = process.env.WHATSAPP_ACCESS_TOKEN;
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getGraphApiVersionFromEnv(): string {
  const v = process.env.WHATSAPP_GRAPH_API_VERSION;
  if (typeof v === "string" && v.trim().length > 0) {
    return v.trim().replace(/^\/+/, "");
  }
  return DEFAULT_GRAPH_VERSION;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function parseGraphMetadata(json: unknown): GraphMediaMetadata | null {
  const rec = asRecord(json);
  if (!rec) return null;

  const url = typeof rec.url === "string" ? rec.url.trim() : "";
  if (!url) return null;

  const mimeType =
    typeof rec.mime_type === "string" ? rec.mime_type.trim() : null;

  let fileSize: number | null = null;
  if (typeof rec.file_size === "number" && Number.isFinite(rec.file_size)) {
    fileSize = rec.file_size;
  }

  const filename =
    typeof rec.filename === "string" && rec.filename.trim().length > 0
      ? rec.filename.trim()
      : null;

  return { url, mimeType, fileSize, filename };
}

async function defaultFetchGraphMetadata(
  mediaId: string,
  token: string,
  apiVersion: string
): Promise<
  | { ok: true; metadata: GraphMediaMetadata }
  | { ok: false; reason: "graph_error" | "missing_media_url" }
> {
  const version = apiVersion.startsWith("v") ? apiVersion : `v${apiVersion}`;
  const url = `https://graph.facebook.com/${version}/${encodeURIComponent(mediaId)}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return { ok: false, reason: "graph_error" };
  }

  if (!res.ok) {
    return { ok: false, reason: "graph_error" };
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, reason: "graph_error" };
  }

  const metadata = parseGraphMetadata(json);
  if (!metadata) {
    return { ok: false, reason: "missing_media_url" };
  }

  return { ok: true, metadata };
}

/**
 * L-15 — where the Meta access token may be sent.
 *
 * Graph's `GET /{media-id}` returns a download URL that must be fetched WITH
 * the bearer token. Per Meta's Cloud API "Download Media" docs that URL is on
 * `lookaside.fbsbx.com` (…/whatsapp_business/attachments/?mid=…). The token is
 * a tenant's WhatsApp Business credential, so it is sent ONLY there, over
 * https on the default port. Anything else Graph (or a compromised/spoofed
 * response) names is refused before a request is made.
 *
 * Redirects are followed manually: a hop to Meta's CDN (`*.fbcdn.net`,
 * `*.fbsbx.com`, https only) is allowed but WITHOUT the Authorization header
 * (CDN URLs are pre-signed); a hop anywhere else aborts.
 */
export const META_MEDIA_TOKEN_HOSTS: ReadonlySet<string> = new Set([
  "lookaside.fbsbx.com",
]);
const META_MEDIA_REDIRECT_HOST_SUFFIXES = [".fbcdn.net", ".fbsbx.com"] as const;
const MAX_MEDIA_REDIRECTS = 3;

function parseHttpsUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (u.port !== "" && u.port !== "443") return null;
  if (u.username || u.password) return null;
  return u;
}

/** May the bearer token be attached to a request for this URL? */
export function isMetaMediaTokenUrl(raw: string): boolean {
  const u = parseHttpsUrl(raw);
  return u !== null && META_MEDIA_TOKEN_HOSTS.has(u.hostname.toLowerCase());
}

/** May a redirect (without the token) go here? */
export function isMetaMediaRedirectUrl(raw: string): boolean {
  const u = parseHttpsUrl(raw);
  if (!u) return false;
  const host = u.hostname.toLowerCase();
  return (
    META_MEDIA_TOKEN_HOSTS.has(host) ||
    META_MEDIA_REDIRECT_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
  );
}

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

async function readCapped(res: Response, maxBytes: number): Promise<Buffer | null> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      // Stop pulling bytes the moment the cap is crossed.
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * Build the binary downloader over an injectable fetch (tests pass a fake and
 * assert which hosts ever saw the Authorization header).
 */
export function createMetaMediaBinaryFetcher(
  fetchImpl: FetchImpl,
  maxBytes: number = WHATSAPP_MEDIA_MAX_BYTES
): MediaFetchDeps["fetchBinary"] {
  return async (url, token) => {
    if (!isMetaMediaTokenUrl(url)) {
      return { ok: false, reason: "untrusted_media_host" };
    }
    let current = url;
    let sendToken = true;
    for (let hop = 0; hop <= MAX_MEDIA_REDIRECTS; hop++) {
      let res: Response;
      try {
        res = await fetchImpl(current, {
          redirect: "manual",
          headers: sendToken ? { Authorization: `Bearer ${token}` } : {},
        });
      } catch {
        return { ok: false, reason: "download_failed" };
      }

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) return { ok: false, reason: "download_failed" };
        let next: string;
        try {
          next = new URL(location, current).toString();
        } catch {
          return { ok: false, reason: "untrusted_media_host" };
        }
        if (!isMetaMediaRedirectUrl(next)) {
          return { ok: false, reason: "untrusted_media_host" };
        }
        // The token follows only to the token host itself.
        sendToken = sendToken && isMetaMediaTokenUrl(next);
        current = next;
        continue;
      }

      if (!res.ok) {
        return { ok: false, reason: "download_failed" };
      }

      try {
        const buffer = await readCapped(res, maxBytes);
        if (buffer === null) return { ok: false, reason: "file_too_large" };
        return { ok: true, buffer };
      } catch {
        return { ok: false, reason: "download_failed" };
      }
    }
    return { ok: false, reason: "download_failed" };
  };
}

const defaultFetchBinary: MediaFetchDeps["fetchBinary"] = (url, token) =>
  createMetaMediaBinaryFetcher((input, init) => fetch(input, init))(url, token);

function defaultDeps(): MediaFetchDeps {
  return {
    getAccessToken: getAccessTokenFromEnv,
    getGraphApiVersion: getGraphApiVersionFromEnv,
    fetchGraphMetadata: defaultFetchGraphMetadata,
    fetchBinary: defaultFetchBinary,
  };
}

function fail(
  mediaId: string,
  reason: MediaFetchFailureReason
): MediaFetchResult {
  return { ok: false, reason, mediaId };
}

/**
 * Fetches WhatsApp media from Graph API and validates MVP policy (image/*, PDF, ≤15MB).
 * Does not persist bytes or create documents.
 */
export async function fetchAndValidateWhatsAppMedia(
  params: FetchAndValidateParams,
  depsOverride?: Partial<MediaFetchDeps>
): Promise<MediaFetchResult> {
  const mediaId = params.mediaId.trim();
  const deps: MediaFetchDeps = { ...defaultDeps(), ...depsOverride };

  const token = deps.getAccessToken();
  if (!token) {
    return fail(mediaId, "missing_access_token");
  }

  const apiVersion = deps.getGraphApiVersion();

  const metaResult = await deps.fetchGraphMetadata(mediaId, token, apiVersion);
  if (!metaResult.ok) {
    return fail(mediaId, metaResult.reason);
  }

  const { metadata } = metaResult;

  // L-15: never hand the token to a URL outside Meta's media host, whatever
  // fetchBinary implementation is in use; and refuse a declared oversize
  // before any byte is downloaded.
  if (!isMetaMediaTokenUrl(metadata.url)) {
    return fail(mediaId, "untrusted_media_host");
  }
  if (metadata.fileSize !== null && metadata.fileSize > WHATSAPP_MEDIA_MAX_BYTES) {
    return fail(mediaId, "file_too_large");
  }

  const download = await deps.fetchBinary(metadata.url, token);
  if (!download.ok) {
    return fail(mediaId, download.reason);
  }

  // The provider's declared type, or nothing. It is deliberately NOT defaulted
  // from the routing media type: "document" is a statement about how the
  // message was shaped, not about what the file is, and turning it into
  // "application/pdf" made an unknown into a confident and unchecked claim.
  const validated = validateWhatsAppMediaContent({
    buffer: download.buffer,
    mimeType: metadata.mimeType,
  });

  if (!validated.ok) {
    return fail(mediaId, validated.reason);
  }

  return {
    ok: true,
    mediaId,
    buffer: download.buffer,
    mimeType: validated.mimeType,
    sizeBytes: validated.sizeBytes,
    filename: metadata.filename,
  };
}

/** Safe log fields — no buffer, no URLs, no tokens. */
export function mediaFetchLogFields(
  businessId: number,
  routingMediaType: string,
  result: MediaFetchResult
): Record<string, unknown> {
  if (result.ok) {
    return {
      businessId,
      routingMediaType,
      mediaFetch: "success",
      mediaIdPrefix: result.mediaId.slice(0, 12),
      mimeType: result.mimeType,
      sizeBytes: result.sizeBytes,
      hasFilename: Boolean(result.filename),
    };
  }

  return {
    businessId,
    routingMediaType,
    mediaFetch: "failure",
    failureReason: result.reason,
    mediaIdPrefix: result.mediaId.slice(0, 12),
  };
}
