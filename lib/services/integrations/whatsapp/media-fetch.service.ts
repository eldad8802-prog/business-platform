import {
  validateWhatsAppMediaContent,
} from "./media-validation.service";
import type {
  FetchAndValidateParams,
  GraphMediaMetadata,
  MediaFetchDeps,
  MediaFetchFailureReason,
  MediaFetchResult,
} from "./media-fetch.types";

const DEFAULT_GRAPH_VERSION = "v20.0";

function getAccessTokenFromEnv(): string | null {
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

async function defaultFetchBinary(
  url: string,
  token: string
): Promise<
  | { ok: true; buffer: Buffer }
  | { ok: false; reason: "download_failed" }
> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return { ok: false, reason: "download_failed" };
  }

  if (!res.ok) {
    return { ok: false, reason: "download_failed" };
  }

  try {
    const arrayBuffer = await res.arrayBuffer();
    return { ok: true, buffer: Buffer.from(arrayBuffer) };
  } catch {
    return { ok: false, reason: "download_failed" };
  }
}

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

  const download = await deps.fetchBinary(metadata.url, token);
  if (!download.ok) {
    return fail(mediaId, download.reason);
  }

  const mimeType =
    metadata.mimeType ||
    (params.routingMediaType === "document"
      ? "application/pdf"
      : "image/jpeg");

  const validated = validateWhatsAppMediaContent({
    buffer: download.buffer,
    mimeType,
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
