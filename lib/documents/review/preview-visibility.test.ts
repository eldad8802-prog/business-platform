/**
 * Validation: run with
 *   npx tsx lib/documents/review/preview-visibility.test.ts
 */
import assert from "node:assert/strict";
import {
  resolvePreviewView,
  shouldLoadDocumentPreview,
  type PreviewFileStatus,
} from "./preview-visibility";

// --- shouldLoadDocumentPreview -------------------------------------------
// Regression guard for the original bug: the file MUST load during "decision"
// (the only interactive state the Review page actually reaches).
assert.equal(shouldLoadDocumentPreview("decision"), true);
assert.equal(shouldLoadDocumentPreview("summary"), true);
assert.equal(shouldLoadDocumentPreview("edit-field"), true);
// "done" is the terminal screen — no preview surface, so do not fetch.
assert.equal(shouldLoadDocumentPreview("done"), false);

// --- resolvePreviewView ---------------------------------------------------
const base = {
  previewKind: "pdf" as const,
  fileBlobUrl: "blob:doc-1" as string | null,
  previewFailed: false,
};

// While fetching (idle before the effect runs, then loading) → show the attempt.
assert.equal(resolvePreviewView({ ...base, fileStatus: "idle" }), "loading");
assert.equal(resolvePreviewView({ ...base, fileStatus: "loading" }), "loading");

// Loaded successfully → render by kind.
assert.equal(resolvePreviewView({ ...base, fileStatus: "ready" }), "pdf");
assert.equal(
  resolvePreviewView({ ...base, fileStatus: "ready", previewKind: "image" }),
  "image"
);

// Genuine miss / error / unsupported / no blob → fallback (only then).
assert.equal(resolvePreviewView({ ...base, fileStatus: "missing" }), "fallback");
assert.equal(
  resolvePreviewView({ ...base, fileStatus: "ready", previewFailed: true }),
  "fallback"
);
assert.equal(
  resolvePreviewView({ ...base, fileStatus: "ready", previewKind: "unsupported" }),
  "fallback"
);
assert.equal(
  resolvePreviewView({ ...base, fileStatus: "ready", fileBlobUrl: null }),
  "fallback"
);

// A failed render always wins, even mid-load.
const failedDuringLoad: { fileStatus: PreviewFileStatus } = { fileStatus: "loading" };
assert.equal(
  resolvePreviewView({ ...base, ...failedDuringLoad, previewFailed: true }),
  "fallback"
);

console.log("preview-visibility: all assertions passed");
