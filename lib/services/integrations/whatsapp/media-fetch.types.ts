import type { DocumentsIntakeMediaType } from "./routing.types";

export type MediaFetchFailureReason =
  | "missing_access_token"
  | "graph_error"
  | "missing_media_url"
  | "download_failed"
  | "unsupported_mime"
  | "file_too_large";

export type MediaFetchSuccess = {
  ok: true;
  mediaId: string;
  buffer: Buffer;
  mimeType: string;
  sizeBytes: number;
  filename: string | null;
};

export type MediaFetchFailure = {
  ok: false;
  reason: MediaFetchFailureReason;
  mediaId: string;
};

export type MediaFetchResult = MediaFetchSuccess | MediaFetchFailure;

export type GraphMediaMetadata = {
  url: string;
  mimeType: string | null;
  fileSize: number | null;
  filename: string | null;
};

/** Injectable deps for tests (no real Meta calls). */
export type MediaFetchDeps = {
  getAccessToken: () => string | null;
  getGraphApiVersion: () => string;
  fetchGraphMetadata: (
    mediaId: string,
    token: string,
    apiVersion: string
  ) => Promise<
    | { ok: true; metadata: GraphMediaMetadata }
    | { ok: false; reason: "graph_error" | "missing_media_url" }
  >;
  fetchBinary: (url: string, token: string) => Promise<
    | { ok: true; buffer: Buffer }
    | { ok: false; reason: "download_failed" }
  >;
};

export type FetchAndValidateParams = {
  mediaId: string;
  routingMediaType: DocumentsIntakeMediaType;
};
