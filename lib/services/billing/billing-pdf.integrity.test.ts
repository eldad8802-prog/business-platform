/**
 * H2a billing PDF cache integrity verify (run manually):
 *   npx tsx lib/services/billing/billing-pdf.integrity.test.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  PDF_INTEGRITY_CHECK_FAILED_ERROR,
  PdfIntegrityCheckFailedError,
} from "@/lib/errors";
import {
  rethrowRenderFailure,
  verifyCachedPdfBytes,
} from "@/lib/services/billing/billing-pdf.service";

let failed = 0;

function ok(name: string, condition: boolean) {
  if (!condition) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function testStoredBytesMatchHash() {
  const bytes = Buffer.from("%PDF-1.4 verified-cache-hit");
  const pdfHash = sha256Hex(bytes);
  ok(
    "A: stored bytes match hash → verify passes",
    verifyCachedPdfBytes(bytes, pdfHash) === true
  );
  ok(
    "A: uppercase stored hash still matches",
    verifyCachedPdfBytes(bytes, pdfHash.toUpperCase()) === true
  );
}

function testStoredBytesDoNotMatchHash() {
  const bytes = Buffer.from("%PDF-1.4 corrupted");
  const storedHash = sha256Hex(Buffer.from("%PDF-1.4 original"));
  ok(
    "B: stored bytes do not match hash → verify fails (cache invalid)",
    verifyCachedPdfBytes(bytes, storedHash) === false
  );
}

function testIntegrityErrorShape() {
  const err = new PdfIntegrityCheckFailedError();
  ok(
    "C: PdfIntegrityCheckFailedError message",
    err.message === PDF_INTEGRITY_CHECK_FAILED_ERROR
  );
  ok(
    "C: PdfIntegrityCheckFailedError code",
    err.code === PDF_INTEGRITY_CHECK_FAILED_ERROR
  );
  ok("C: PdfIntegrityCheckFailedError status", err.statusCode === 503);
}

function testMismatchPlusRenderFailureThrowsIntegrityError() {
  try {
    rethrowRenderFailure(true, new Error("Renderer produced empty buffer"));
    ok("C: mismatch + render failure throws integrity error", false);
  } catch (error) {
    ok(
      "C: mismatch + render failure throws integrity error",
      error instanceof PdfIntegrityCheckFailedError
    );
  }

  try {
    rethrowRenderFailure(false, new Error("plain render failure"));
    ok("C: render failure without mismatch rethrows original error", false);
  } catch (error) {
    ok(
      "C: render failure without mismatch rethrows original error",
      error instanceof Error &&
        error.message === "plain render failure" &&
        !(error instanceof PdfIntegrityCheckFailedError)
    );
  }
}

testStoredBytesMatchHash();
testStoredBytesDoNotMatchHash();
testIntegrityErrorShape();
testMismatchPlusRenderFailureThrowsIntegrityError();

if (failed > 0) {
  console.error(`billing-pdf.integrity.test: ${failed} failed`);
  process.exitCode = 1;
} else {
  console.log("billing-pdf.integrity.test: all assertions passed");
}
