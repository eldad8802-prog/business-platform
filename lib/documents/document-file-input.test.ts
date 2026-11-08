/**
 * Unit test — Documents file-input attributes (upload vs camera).
 * Run: npx tsx lib/documents/document-file-input.test.ts
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
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
  const EXT_MIME: Record<string, string> = { ".pdf": "application/pdf", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };
  for (const t of uploadTypes) {
    assert.equal(t, t.trim(), `no whitespace around accept entry "${t}"`);
    const mime = t.startsWith(".") ? EXT_MIME[t] : t;
    assert.ok(mime, `extension ${t} maps to a known type`);
    assert.ok(isAllowedDocumentMime(mime), `upload accept entry ${t} (${mime}) is accepted by the server`);
  }
  assert.equal(uploadTypes[0], "application/pdf", "PDF first → WebView GET_CONTENT type is not an image");
  assert.ok(uploadTypes.includes("image/jpeg") && uploadTypes.includes("image/png"), "images stay selectable");

  // The upload string is the Android shell's signature for this one input: no
  // other screen may carry it, and Settings' documents import must not.
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(tsx|ts)$/.test(name) && !/\.test\.ts$/.test(name)) files.push(full);
    }
  };
  walk(join(process.cwd(), "app"));
  walk(join(process.cwd(), "components"));
  const users = files
    .filter((f) => readFileSync(f, "utf8").includes("DOCUMENT_UPLOAD_ACCEPT"))
    .map((f) => f.slice(process.cwd().length + 1).replace(/\\/g, "/"))
    .sort();
  assert.deepEqual(users, ["app/(shell)/documents/page.tsx", "app/(shell)/documents/upload/page.tsx"], "only the two Documents screens use the upload signature");
  for (const f of files) {
    assert.ok(!readFileSync(f, "utf8").includes(DOCUMENT_UPLOAD_ACCEPT), `${f}: hard-coded copy of the upload signature`);
  }
  // The Android shell keys ACTION_OPEN_DOCUMENT on the same list.
  const javaSrc = readFileSync(
    join(process.cwd(), "android/app/src/main/java/il/co/promaxgroup/dubiz/DocumentUploadChromeClient.java"),
    "utf8"
  );
  const javaList = javaSrc.match(/DOCUMENT_UPLOAD_ACCEPT = Arrays\.asList\(([^)]*)\)/);
  assert.ok(javaList, "DocumentUploadChromeClient declares DOCUMENT_UPLOAD_ACCEPT");
  assert.deepEqual(
    [...javaList[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]),
    uploadTypes,
    "native signature equals DOCUMENT_UPLOAD_ACCEPT"
  );

  const importSrc = readFileSync(join(process.cwd(), "components/settings/import-export/DocumentsImportScreen.tsx"), "utf8");
  assert.ok(importSrc.includes('accept="application/pdf,image/jpeg,image/png"'), "Settings import keeps its own (non-signature) accept");

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
