/**
 * PR3 media fetch + validation tests (mocked — no Meta).
 *   npx tsx lib/services/integrations/whatsapp/webhook-pr3.media.test.ts
 */
import assert from "node:assert/strict";
import { resetAllowlistCacheForTests } from "./allowlist.service";
import { resetBusinessResolveCacheForTests } from "./business-resolve.service";
import {
  fetchAndValidateWhatsAppMedia,
  mediaFetchLogFields,
} from "./media-fetch.service";
import {
  isAllowedWhatsAppMediaMime,
  validateWhatsAppMediaContent,
  WHATSAPP_MEDIA_MAX_BYTES,
} from "./media-validation.service";
import { routeInboundWhatsAppMessage } from "./routing-gate.service";
import type { MediaFetchDeps } from "./media-fetch.types";
import type { WhatsAppWebhookMessageSummary } from "./types";

const TOKEN = "test-access-token";
const SMALL_JPEG = Buffer.alloc(1024, 1);
const LARGE_BUFFER = Buffer.alloc(WHATSAPP_MEDIA_MAX_BYTES + 1, 1);

function mockDeps(
  overrides: Partial<MediaFetchDeps> = {}
): MediaFetchDeps {
  return {
    getAccessToken: () => TOKEN,
    getGraphApiVersion: () => "v20.0",
    fetchGraphMetadata: async () => ({
      ok: true,
      metadata: {
        url: "https://example.com/media.bin",
        mimeType: "image/jpeg",
        fileSize: SMALL_JPEG.length,
        filename: null,
      },
    }),
    fetchBinary: async () => ({ ok: true, buffer: SMALL_JPEG }),
    ...overrides,
  };
}

// --- Validation unit ---
assert.equal(isAllowedWhatsAppMediaMime("image/jpeg"), true);
assert.equal(isAllowedWhatsAppMediaMime("application/pdf"), true);
assert.equal(isAllowedWhatsAppMediaMime("audio/ogg"), false);

const tooLarge = validateWhatsAppMediaContent({
  buffer: LARGE_BUFFER,
  mimeType: "image/jpeg",
});
assert.equal(tooLarge.ok, false);
if (!tooLarge.ok) assert.equal(tooLarge.reason, "file_too_large");

const badMime = validateWhatsAppMediaContent({
  buffer: SMALL_JPEG,
  mimeType: "application/zip",
});
assert.equal(badMime.ok, false);
if (!badMime.ok) assert.equal(badMime.reason, "unsupported_mime");

async function run(): Promise<void> {
// --- Fetch: success ---
const success = await fetchAndValidateWhatsAppMedia(
  { mediaId: "media-123", routingMediaType: "image" },
  mockDeps()
);
assert.equal(success.ok, true);
if (success.ok) {
  assert.equal(success.mimeType, "image/jpeg");
  assert.equal(success.sizeBytes, SMALL_JPEG.length);
  assert.equal(success.mediaId, "media-123");
}

// --- Fetch: missing token ---
const noToken = await fetchAndValidateWhatsAppMedia(
  { mediaId: "media-123", routingMediaType: "image" },
  mockDeps({ getAccessToken: () => null })
);
assert.equal(noToken.ok, false);
if (!noToken.ok) assert.equal(noToken.reason, "missing_access_token");

// --- Fetch: graph error ---
const graphErr = await fetchAndValidateWhatsAppMedia(
  { mediaId: "media-123", routingMediaType: "image" },
  mockDeps({
    fetchGraphMetadata: async () => ({ ok: false, reason: "graph_error" }),
  })
);
assert.equal(graphErr.ok, false);
if (!graphErr.ok) assert.equal(graphErr.reason, "graph_error");

// --- Fetch: missing media url ---
const noUrl = await fetchAndValidateWhatsAppMedia(
  { mediaId: "media-123", routingMediaType: "image" },
  mockDeps({
    fetchGraphMetadata: async () => ({ ok: false, reason: "missing_media_url" }),
  })
);
assert.equal(noUrl.ok, false);
if (!noUrl.ok) assert.equal(noUrl.reason, "missing_media_url");

// --- Fetch: download failed ---
const dlFail = await fetchAndValidateWhatsAppMedia(
  { mediaId: "media-123", routingMediaType: "image" },
  mockDeps({
    fetchBinary: async () => ({ ok: false, reason: "download_failed" }),
  })
);
assert.equal(dlFail.ok, false);
if (!dlFail.ok) assert.equal(dlFail.reason, "download_failed");

// --- Fetch: unsupported mime from bytes ---
const zipMime = await fetchAndValidateWhatsAppMedia(
  { mediaId: "media-123", routingMediaType: "document" },
  mockDeps({
    fetchGraphMetadata: async () => ({
      ok: true,
      metadata: {
        url: "https://example.com/f",
        mimeType: "application/zip",
        fileSize: 100,
        filename: "x.zip",
      },
    }),
    fetchBinary: async () => ({ ok: true, buffer: SMALL_JPEG }),
  })
);
assert.equal(zipMime.ok, false);
if (!zipMime.ok) assert.equal(zipMime.reason, "unsupported_mime");

// --- Fetch: too large ---
const big = await fetchAndValidateWhatsAppMedia(
  { mediaId: "media-123", routingMediaType: "image" },
  mockDeps({
    fetchBinary: async () => ({ ok: true, buffer: LARGE_BUFFER }),
  })
);
assert.equal(big.ok, false);
if (!big.ok) assert.equal(big.reason, "file_too_large");

// --- Log fields (no secrets) ---
const logOk = mediaFetchLogFields(1, "image", success);
assert.equal(logOk.mediaFetch, "success");
assert.equal((logOk as { buffer?: unknown }).buffer, undefined);

// --- Webhook integration pattern: routing → fetch only on DOCUMENTS_INTAKE ---
process.env.WHATSAPP_ALLOW_ENV_FALLBACK = "1";
process.env.WHATSAPP_PHONE_NUMBER_BUSINESS_MAP = JSON.stringify({ "123456789": 1 });
process.env.WHATSAPP_ALLOWLIST_BY_BUSINESS = JSON.stringify({ "1": ["972501234567"] });
resetBusinessResolveCacheForTests();
resetAllowlistCacheForTests();

let fetchCallCount = 0;
const trackingDeps = mockDeps({
  fetchGraphMetadata: async (mediaId) => {
    fetchCallCount += 1;
    return {
      ok: true,
      metadata: {
        url: "https://example.com/m",
        mimeType: "image/jpeg",
        fileSize: SMALL_JPEG.length,
        filename: null,
      },
    };
  },
});

function baseMessage(
  overrides: Partial<WhatsAppWebhookMessageSummary> = {}
): WhatsAppWebhookMessageSummary {
  return {
    phoneNumberId: "123456789",
    from: "972501234567",
    wamid: "wamid.pr3.test",
    type: "image",
    mediaId: "media-pr3",
    textBody: null,
    ...overrides,
  };
}

async function simulateWebhookMessage(
  message: WhatsAppWebhookMessageSummary,
  deps: MediaFetchDeps
): Promise<void> {
  // routeInboundWhatsAppMessage is async in Bot-MVP-1 (DB-backed routing).
  const decision = await routeInboundWhatsAppMessage(message);
  if (decision.kind === "DOCUMENTS_INTAKE") {
    await fetchAndValidateWhatsAppMedia(
      {
        mediaId: decision.mediaId,
        routingMediaType: decision.mediaType,
      },
      deps
    );
  }
}

fetchCallCount = 0;
await simulateWebhookMessage(baseMessage(), trackingDeps);
assert.equal(fetchCallCount, 1, "authorized image should fetch media");

fetchCallCount = 0;
await simulateWebhookMessage(baseMessage({ from: "972000000000" }), trackingDeps);
assert.equal(
  fetchCallCount,
  1,
  "non-allowlisted sender with media + identified business should fetch (conversation-origin intake)"
);

fetchCallCount = 0;
await simulateWebhookMessage(
  baseMessage({ from: "972000000000", mediaId: null }),
  trackingDeps
);
assert.equal(
  fetchCallCount,
  0,
  "media without mediaId should not fetch"
);

fetchCallCount = 0;
await simulateWebhookMessage(
  baseMessage({ type: "text", mediaId: null }),
  trackingDeps
);
assert.equal(fetchCallCount, 0, "text message should not fetch");

console.log("whatsapp webhook PR3 media tests: OK");
}

void run().catch((err) => {
  console.error(err);
  process.exit(1);
});
