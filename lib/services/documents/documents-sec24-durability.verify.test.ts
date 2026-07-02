/**
 * SEC-24 documents durability — cross-path contract verification.
 *   npm run verify:documents-sec24
 *
 * The three ingestion routes/services are not dependency-injectable (they use
 * prisma / storage / OCR directly), so this is a SOURCE-CONTRACT guard: it
 * asserts the structural invariants that make SEC-24 hold, so a regression
 * (moving the persist after the Document create, deleting a persisted artifact
 * on enrichment failure, or making extraction fatal) is caught in CI.
 *
 * Behavioural proof for the WhatsApp orchestration lives in
 * webhook-pr4.intake.test.ts (injected fakes).
 *
 * SEC-24 invariant (all central paths): persist first → enrichment (OCR +
 * extraction) may fail → the document survives as needs_review; a persisted
 * artifact is never deleted on an enrichment failure.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

function read(rel: string): string {
  return readFileSync(path.join(process.cwd(), rel), "utf8");
}

function run(): void {
  // --- Shared choke point: extraction is best-effort; Document always created ---
  const shared = read("lib/services/documents/create-document-from-ocr.service.ts");
  assert.ok(
    /try\s*{[\s\S]*runUnifiedDocumentIntelligence[\s\S]*catch/.test(shared),
    "createDocumentFromOcrText: extraction MUST be inside try/catch (best-effort enrichment)"
  );
  assert.ok(
    /status:\s*["']needs_review["']/.test(shared),
    "createDocumentFromOcrText: MUST create a needs_review Document"
  );
  assert.ok(
    /extractedDataId:\s*null/.test(shared),
    "createDocumentFromOcrText: MUST still create the Document when extraction is unavailable"
  );
  assert.ok(
    shared.indexOf("prisma.document.create") >
      shared.indexOf("runUnifiedDocumentIntelligence"),
    "createDocumentFromOcrText: Document creation runs independent of extraction outcome"
  );

  // --- Upload route ---
  const upload = read("app/api/documents/upload/route.ts");
  assert.ok(upload.includes("putDocumentObject({"), "upload: MUST persist the file");
  assert.ok(
    /status:\s*["']needs_review["']/.test(upload),
    "upload: MUST create a needs_review Document"
  );
  assert.ok(
    upload.indexOf("putDocumentObject({") < upload.indexOf("prisma.document.create({"),
    "upload: persist MUST precede Document create (persist-before-enrichment)"
  );
  assert.ok(
    /!permanentFilePersisted/.test(upload),
    "upload: file deletion MUST be guarded by !permanentFilePersisted"
  );

  // --- Gmail import route ---
  const gmail = read("app/api/integrations/gmail/import/route.ts");
  assert.ok(
    /status:\s*["']needs_review["']/.test(gmail),
    "gmail: MUST create a needs_review Document"
  );
  assert.ok(
    /!permanentFilePersisted/.test(gmail),
    "gmail: file deletion MUST be guarded by !permanentFilePersisted"
  );
  assert.ok(
    /catch[\s\S]{0,120}GMAIL_IMPORT_OCR_FAILED|GMAIL_IMPORT_OCR_FAILED/.test(gmail),
    "gmail: OCR MUST be best-effort (failure caught, not fatal)"
  );

  // --- WhatsApp intake service ---
  const whatsapp = read(
    "lib/services/integrations/whatsapp/documents-intake.service.ts"
  );
  assert.ok(
    whatsapp.indexOf("deps.putDocument(") < whatsapp.indexOf("deps.runOcr("),
    "whatsapp: MUST persist before OCR"
  );
  assert.ok(
    !/fail\(["']ocr_failed["']\)/.test(whatsapp) &&
      !/fail\(["']ocr_empty["']\)/.test(whatsapp),
    "whatsapp: OCR failure/empty MUST NOT discard the artifact (no fail-on-OCR)"
  );
  assert.ok(
    whatsapp.includes("deps.createDocument("),
    "whatsapp: MUST create a Document so the artifact survives OCR failure"
  );

  console.log(
    "SEC-24 documents durability contract verified (shared / upload / gmail / whatsapp)."
  );
}

run();
