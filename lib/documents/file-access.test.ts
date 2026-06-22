/**
 * Validation: run with
 *   npx tsx lib/documents/file-access.test.ts
 */
import assert from "node:assert/strict";
import { buildDocumentDownloadName } from "./file-access";

// Extension is derived from mime type.
assert.equal(
  buildDocumentDownloadName({ documentId: 7, vendorName: "פז", mimeType: "application/pdf" }),
  "פז-7.pdf"
);
assert.equal(
  buildDocumentDownloadName({ documentId: 9, vendorName: "Shell", mimeType: "image/jpeg" }),
  "Shell-9.jpg"
);
assert.equal(
  buildDocumentDownloadName({ documentId: 9, vendorName: "Shell", mimeType: "image/png" }),
  "Shell-9.png"
);
assert.equal(
  buildDocumentDownloadName({ documentId: 3, vendorName: "x", mimeType: "image/svg+xml" }),
  "x-3.img"
);
assert.equal(
  buildDocumentDownloadName({ documentId: 3, vendorName: "x", mimeType: null }),
  "x-3.file"
);

// Missing vendor falls back to a stable, readable name.
assert.equal(
  buildDocumentDownloadName({ documentId: 42, vendorName: "", mimeType: "application/pdf" }),
  "מסמך-42.pdf"
);
assert.equal(
  buildDocumentDownloadName({ documentId: 42, vendorName: null, mimeType: "application/pdf" }),
  "מסמך-42.pdf"
);

// Filesystem-unsafe characters in the vendor name are stripped.
assert.equal(
  buildDocumentDownloadName({
    documentId: 5,
    vendorName: 'a/b\\c:d*e?f"g<h>i|j',
    mimeType: "application/pdf",
  }),
  "a b c d e f g h i j-5.pdf"
);

console.log("file-access: all assertions passed");
