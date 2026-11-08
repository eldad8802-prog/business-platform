/**
 * Unit test — Documents file-input attributes (upload vs camera).
 * Run: npx tsx lib/documents/document-file-input.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DOCUMENT_CAMERA_ACCEPT,
  DOCUMENT_CAMERA_CAPTURE,
  DOCUMENT_UPLOAD_ACCEPT,
} from "@/lib/documents/document-file-input";
import { isAllowedDocumentMime } from "@/lib/services/documents/document-ingestion.service";

function main() {
  // Mirrors Capacitor's check: acceptTypes (split on ",", untrimmed) must
  // contain the exact token "image/*" or the native shell opens the gallery.
  assert.ok(
    DOCUMENT_CAMERA_ACCEPT.split(",").includes("image/*"),
    "camera accept must contain the literal image/* token"
  );
  assert.equal(DOCUMENT_CAMERA_CAPTURE, "environment", "camera uses the rear camera");

  const uploadTypes = DOCUMENT_UPLOAD_ACCEPT.split(",");
  for (const t of uploadTypes) {
    assert.equal(t, t.trim(), `no whitespace around accept entry "${t}"`);
    assert.ok(isAllowedDocumentMime(t), `upload accept entry ${t} is accepted by the server`);
  }
  assert.equal(uploadTypes[0], "application/pdf", "PDF first → WebView GET_CONTENT type is not an image");
  assert.ok(uploadTypes.includes("image/jpeg") && uploadTypes.includes("image/png"), "images stay selectable");

  // Every Documents screen with an upload + camera pair uses the shared
  // constants — a hard-coded accept list is how the camera regressed.
  const root = process.cwd();
  for (const page of ["app/(shell)/documents/page.tsx", "app/(shell)/documents/upload/page.tsx"]) {
    const src = readFileSync(join(root, page), "utf8");
    assert.ok(!/\baccept="/.test(src), `${page}: no hard-coded accept attribute`);
    assert.ok(!/\bcapture="/.test(src), `${page}: no hard-coded capture attribute`);
    assert.ok(src.includes("accept={DOCUMENT_UPLOAD_ACCEPT}"), `${page}: upload input uses DOCUMENT_UPLOAD_ACCEPT`);
    assert.ok(src.includes("accept={DOCUMENT_CAMERA_ACCEPT}"), `${page}: camera input uses DOCUMENT_CAMERA_ACCEPT`);
    assert.equal(
      src.split("capture={DOCUMENT_CAMERA_CAPTURE}").length - 1,
      1,
      `${page}: only the camera input carries capture`
    );
  }

  console.log("document-file-input: all assertions passed");
}

main();
