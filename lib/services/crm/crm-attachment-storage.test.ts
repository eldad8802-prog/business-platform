/**
 * Unit test — CRM attachment storage helper + storage key validation for the
 * "crm" domain. Run: npx tsx lib/services/crm/crm-attachment-storage.test.ts
 */
import assert from "node:assert/strict";
import {
  buildAttachmentStorageKey,
  validateAttachmentUpload,
  sanitizeDisplayFileName,
  MAX_ATTACHMENT_BYTES,
} from "@/lib/services/crm/crm-attachment-storage";
import { assertSafeStorageKey } from "@/lib/storage/key-validation";
import { ValidationError } from "@/lib/errors";
import { StorageKeyError } from "@/lib/storage/storage.errors";
import { BUCKETS } from "@/lib/security/rate-limiter/buckets";

function main() {
  // ===== rate-limit bucket contract (write path → fail-closed) =====
  const bucket = BUCKETS.CRM_ATTACHMENT_UPLOAD;
  assert.ok(bucket, "CRM_ATTACHMENT_UPLOAD bucket registered");
  assert.equal(bucket.failMode, "closed", "attachment upload is fail-closed");
  assert.ok(bucket.rules.length > 0, "bucket has window rules");
  assert.ok(bucket.rules.some((r) => r.scope === "user") && bucket.rules.some((r) => r.scope === "business"), "per-user AND per-business rules");

  // ===== key building (Customer + Supplier, nested crm domain) =====
  const custKey = buildAttachmentStorageKey({ businessId: 32, subjectType: "CUSTOMER", subjectId: 49, storageExt: "pdf" });
  assert.match(custKey, /^biz\/32\/crm\/CUSTOMER\/49\/att-\d+-[a-f0-9]+\.pdf$/, "customer key shape");
  const suppKey = buildAttachmentStorageKey({ businessId: 7, subjectType: "SUPPLIER", subjectId: 3, storageExt: "xlsx" });
  assert.match(suppKey, /^biz\/7\/crm\/SUPPLIER\/3\/att-\d+-[a-f0-9]+\.xlsx$/, "supplier key shape");
  // nested crm key passes the shared safe-key validation
  assert.equal(assertSafeStorageKey(custKey), custKey, "nested crm key is safe");

  // invalid ids rejected
  assert.throws(() => buildAttachmentStorageKey({ businessId: 0, subjectType: "CUSTOMER", subjectId: 1, storageExt: "pdf" }), ValidationError, "bad businessId");
  assert.throws(() => buildAttachmentStorageKey({ businessId: 1, subjectType: "CUSTOMER", subjectId: -1, storageExt: "pdf" }), ValidationError, "bad subjectId");

  // ===== traversal prevention (shared key validation) =====
  assert.throws(() => assertSafeStorageKey("biz/32/crm/CUSTOMER/../../secret.pdf"), StorageKeyError, "traversal '..' rejected");
  assert.throws(() => assertSafeStorageKey("/etc/passwd"), StorageKeyError, "absolute path rejected");
  assert.throws(() => assertSafeStorageKey("biz/32/unknown/CUSTOMER/1/x.pdf"), StorageKeyError, "unknown domain rejected");

  // ===== MIME → ext + validation =====
  assert.equal(validateAttachmentUpload({ mimeType: "application/pdf", originalFileName: "חוזה.pdf", sizeBytes: 1000 }).storageExt, "pdf", "pdf ext");
  assert.equal(validateAttachmentUpload({ mimeType: "image/jpeg", originalFileName: "photo.jpeg", sizeBytes: 1000 }).storageExt, "jpg", "jpeg→jpg, .jpeg accepted");
  assert.equal(validateAttachmentUpload({ mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", originalFileName: "data.xlsx", sizeBytes: 1000 }).storageExt, "xlsx", "xlsx");
  assert.equal(validateAttachmentUpload({ mimeType: "text/csv", originalFileName: "rows.csv", sizeBytes: 1000 }).storageExt, "csv", "csv");
  // no-extension filename allowed (MIME governs)
  assert.equal(validateAttachmentUpload({ mimeType: "application/pdf", originalFileName: "scan", sizeBytes: 1000 }).storageExt, "pdf", "no-ext ok");

  // rejections
  assert.throws(() => validateAttachmentUpload({ mimeType: "", originalFileName: "x.pdf", sizeBytes: 10 }), ValidationError, "empty MIME");
  assert.throws(() => validateAttachmentUpload({ mimeType: "application/octet-stream", originalFileName: "x.bin", sizeBytes: 10 }), ValidationError, "octet-stream blocked");
  assert.throws(() => validateAttachmentUpload({ mimeType: "image/svg+xml", originalFileName: "x.svg", sizeBytes: 10 }), ValidationError, "svg blocked");
  assert.throws(() => validateAttachmentUpload({ mimeType: "application/zip", originalFileName: "x.zip", sizeBytes: 10 }), ValidationError, "zip blocked");
  assert.throws(() => validateAttachmentUpload({ mimeType: "application/pdf", originalFileName: "report.txt", sizeBytes: 10 }), ValidationError, "extension mismatch rejected");
  assert.throws(() => validateAttachmentUpload({ mimeType: "application/pdf", originalFileName: "x.pdf", sizeBytes: MAX_ATTACHMENT_BYTES + 1 }), ValidationError, "oversize rejected");
  assert.throws(() => validateAttachmentUpload({ mimeType: "application/pdf", originalFileName: "x.pdf", sizeBytes: 0 }), ValidationError, "empty file rejected");

  // ===== display filename sanitation (never affects the key) =====
  assert.equal(sanitizeDisplayFileName("../../etc/passwd"), "passwd", "path stripped from display name");
  assert.equal(sanitizeDisplayFileName("דוח שנתי.pdf"), "דוח שנתי.pdf", "hebrew + spaces kept");
  assert.equal(sanitizeDisplayFileName(""), "file", "empty → file");
  // the storage key is derived from MIME, not the (malicious) filename
  const keyFromEvilName = buildAttachmentStorageKey({ businessId: 5, subjectType: "CUSTOMER", subjectId: 2, storageExt: validateAttachmentUpload({ mimeType: "application/pdf", originalFileName: "../../../evil.pdf", sizeBytes: 10 }).storageExt });
  assert.ok(!keyFromEvilName.includes(".."), "evil filename never reaches storage key");

  console.log("crm-attachment-storage.test.ts: ok");
}

main();
