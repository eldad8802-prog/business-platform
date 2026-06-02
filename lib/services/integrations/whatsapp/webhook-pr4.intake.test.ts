/**
 * PR4 documents intake orchestration tests (mocked — no DB, no Meta).
 *   npm run verify:whatsapp-webhook-pr4
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  defaultWhatsAppIntakeDeps,
  processWhatsAppDocumentsIntake,
  type WhatsAppDocumentsIntakeInput,
  type WhatsAppIntakeDeps,
} from "./documents-intake.service";
import type { MediaFetchDeps } from "./media-fetch.types";
import { syntheticContentHashForPreBytesFailure } from "./whatsapp-import-dedup.service";

const BUSINESS_ID = 42;
const WAMID_A = "wamid.HBgNMTIz";
const WAMID_B = "wamid.HBgNNDU2";
const MEDIA_ID = "media-abc";
const SMALL_JPEG = Buffer.alloc(2048, 2);
const SMALL_PDF = Buffer.alloc(4096, 3);

type ImportRow = {
  id: number;
  businessId: number;
  wamid: string;
  contentHashSha256: string;
  status: string;
  error: string | null;
  documentId: number | null;
  mimeType: string;
};

function baseInput(overrides: Partial<WhatsAppDocumentsIntakeInput> = {}): WhatsAppDocumentsIntakeInput {
  return {
    businessId: BUSINESS_ID,
    phoneNumberId: "phone-1",
    sender: "972501234567",
    wamid: WAMID_A,
    mediaType: "image",
    mediaId: MEDIA_ID,
    ...overrides,
  };
}

function mockMediaDeps(buffer: Buffer, mimeType: string): MediaFetchDeps {
  return {
    getAccessToken: () => "token",
    getGraphApiVersion: () => "v20.0",
    fetchGraphMetadata: async () => ({
      ok: true,
      metadata: {
        url: "https://example.com/bin",
        mimeType,
        fileSize: buffer.length,
        filename: null,
      },
    }),
    fetchBinary: async () => ({ ok: true, buffer }),
  };
}

function createMockDeps(options: {
  initialRows?: ImportRow[];
  mediaBuffer?: Buffer;
  mediaMime?: string;
  fetchFail?: boolean;
  ocrText?: string;
  ocrThrow?: boolean;
  storageFail?: boolean;
  createDocumentThrow?: boolean;
  sha256Hex?: (buf: Buffer) => string;
}): { deps: WhatsAppIntakeDeps; rows: ImportRow[]; documents: Array<{ source: string; status: string }> } {
  const rows: ImportRow[] = [...(options.initialRows ?? [])];
  let nextId = rows.length + 1;
  const documents: Array<{ source: string; status: string }> = [];
  const buffer = options.mediaBuffer ?? SMALL_JPEG;
  const mime = options.mediaMime ?? "image/jpeg";

  const deps: WhatsAppIntakeDeps = {
    ...defaultWhatsAppIntakeDeps,
    sha256Hex:
      options.sha256Hex ??
      ((b) => {
        let h = 0;
        for (const byte of b) h = (h * 31 + byte) | 0;
        return `mockhash-${Math.abs(h)}-${b.length}`;
      }),
    checkWamidDedup: async ({ businessId, wamid }) => {
      const hit = rows.some((r) => r.businessId === businessId && r.wamid === wamid);
      return hit ? { ok: false, reason: "wamid" } : { ok: true };
    },
    checkHashDedup: async ({ businessId, contentHashSha256 }) => {
      const hit = rows.some(
        (r) => r.businessId === businessId && r.contentHashSha256 === contentHashSha256
      );
      return hit ? { ok: false, reason: "content_hash" } : { ok: true };
    },
    createFailedImport: async (p) => {
      const row: ImportRow = {
        id: nextId++,
        businessId: p.businessId,
        wamid: p.wamid,
        contentHashSha256:
          p.contentHashSha256 ??
          syntheticContentHashForPreBytesFailure(p.businessId, p.wamid),
        status: "failed",
        error: p.error,
        documentId: null,
        mimeType: p.mimeType ?? mime,
      };
      rows.push(row);
      return { id: row.id };
    },
    claimProcessing: async (p) => {
      if (rows.some((r) => r.businessId === p.businessId && r.wamid === p.wamid)) {
        return { ok: false, reason: "wamid" };
      }
      if (
        rows.some(
          (r) =>
            r.businessId === p.businessId &&
            r.contentHashSha256 === p.contentHashSha256
        )
      ) {
        return { ok: false, reason: "content_hash" };
      }
      const row: ImportRow = {
        id: nextId++,
        businessId: p.businessId,
        wamid: p.wamid,
        contentHashSha256: p.contentHashSha256,
        status: "processing",
        error: null,
        documentId: null,
        mimeType: p.mimeType,
      };
      rows.push(row);
      return { ok: true, importId: row.id };
    },
    markImported: async ({ importId, documentId }) => {
      const row = rows.find((r) => r.id === importId);
      assert.ok(row);
      row.status = "imported";
      row.documentId = documentId;
      row.error = null;
    },
    markFailed: async ({ importId, error }) => {
      const row = rows.find((r) => r.id === importId);
      assert.ok(row);
      row.status = "failed";
      row.error = error;
    },
    fetchMedia: async () => {
      if (options.fetchFail) {
        return { ok: false, reason: "graph_error", mediaId: MEDIA_ID };
      }
      return {
        ok: true,
        mediaId: MEDIA_ID,
        buffer,
        mimeType: mime,
        sizeBytes: buffer.length,
        filename: null,
      };
    },
    writeTempOcrFile: async ({ bytes, mimeType }) => ({
      tempPath: `/tmp/wa-${mimeType}-${bytes.length}`,
      cleanup: async () => {},
    }),
    runOcr: async () => {
      if (options.ocrThrow) throw new Error("ocr down");
      return options.ocrText ?? "invoice total 100";
    },
    mkdir: async () => {
      if (options.storageFail) throw new Error("disk full");
    },
    writeFile: async () => {
      if (options.storageFail) throw new Error("disk full");
    },
    unlink: async () => {},
    createDocument: async (p) => {
      if (options.createDocumentThrow) throw new Error("db down");
      documents.push({ source: p.source, status: "needs_review" });
      return {
        documentId: 9000 + documents.length,
        extractedDataId: 1,
        analysis: {
          documentType: "invoice",
          isFinancial: true,
          guardrailRoute: "financial",
          needsReview: true,
          direction: "expense",
          confidence: 0.9,
        },
      };
    },
    buildStoredFileName: () => "doc-test-pr4.jpg",
  };

  return { deps, rows, documents };
}

async function run(): Promise<void> {
  // --- success image ---
  {
    const { deps, rows, documents } = createMockDeps({});
    const out = await processWhatsAppDocumentsIntake(baseInput(), deps);
    assert.equal(out.status, "imported");
    if (out.status === "imported") {
      assert.ok(out.documentId > 0);
      assert.ok(out.importId > 0);
    }
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "imported");
    assert.equal(documents.length, 1);
    assert.equal(documents[0].source, "whatsapp");
    assert.equal(documents[0].status, "needs_review");
  }

  // --- success PDF ---
  {
    const { deps, documents } = createMockDeps({
      mediaBuffer: SMALL_PDF,
      mediaMime: "application/pdf",
    });
    const out = await processWhatsAppDocumentsIntake(
      baseInput({ wamid: WAMID_B, mediaType: "document" }),
      deps
    );
    assert.equal(out.status, "imported");
    assert.equal(documents[0].source, "whatsapp");
  }

  // --- same wamid duplicate (no second OCR) ---
  {
    const { deps, rows } = createMockDeps({
      initialRows: [
        {
          id: 1,
          businessId: BUSINESS_ID,
          wamid: WAMID_A,
          contentHashSha256: "existing-wamid",
          status: "imported",
          error: null,
          documentId: 1,
          mimeType: "image/jpeg",
        },
      ],
    });
    let ocrCalls = 0;
    const wrapped: WhatsAppIntakeDeps = {
      ...deps,
      runOcr: async (...args) => {
        ocrCalls += 1;
        return deps.runOcr(...args);
      },
    };
    const out = await processWhatsAppDocumentsIntake(baseInput(), wrapped);
    assert.equal(out.status, "skipped_duplicate");
    if (out.status === "skipped_duplicate") assert.equal(out.reason, "wamid");
    assert.equal(ocrCalls, 0);
    assert.equal(rows.length, 1);
  }

  // --- same hash duplicate ---
  {
    const hash = "fixed-hash-dup";
    const { deps, rows } = createMockDeps({
      sha256Hex: () => hash,
      initialRows: [
        {
          id: 1,
          businessId: BUSINESS_ID,
          wamid: "wamid.other",
          contentHashSha256: hash,
          status: "imported",
          error: null,
          documentId: 2,
          mimeType: "image/jpeg",
        },
      ],
    });
    let ocrCalls = 0;
    const wrapped: WhatsAppIntakeDeps = {
      ...deps,
      runOcr: async (...args) => {
        ocrCalls += 1;
        return deps.runOcr(...args);
      },
    };
    const out = await processWhatsAppDocumentsIntake(
      baseInput({ wamid: "wamid.new-hash-dup" }),
      wrapped
    );
    assert.equal(out.status, "skipped_duplicate");
    if (out.status === "skipped_duplicate") assert.equal(out.reason, "content_hash");
    assert.equal(ocrCalls, 0);
    assert.equal(rows.length, 1);
  }

  // --- media fetch fail → failed row with wamid ---
  {
    const { deps, rows } = createMockDeps({ fetchFail: true });
    const out = await processWhatsAppDocumentsIntake(
      baseInput({ wamid: "wamid.media-fail" }),
      deps
    );
    assert.equal(out.status, "failed");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "failed");
    assert.equal(rows[0].wamid, "wamid.media-fail");
    assert.ok(rows[0].error?.includes("media_fetch"));
  }

  // --- OCR fail ---
  {
    const { deps, rows } = createMockDeps({ ocrThrow: true });
    const out = await processWhatsAppDocumentsIntake(
      baseInput({ wamid: "wamid.ocr-fail" }),
      deps
    );
    assert.equal(out.status, "failed");
    if (out.status === "failed") assert.equal(out.reason, "ocr_failed");
    const row = rows.find((r) => r.wamid === "wamid.ocr-fail");
    assert.equal(row?.status, "failed");
  }

  // --- OCR empty ---
  {
    const { deps, rows } = createMockDeps({ ocrText: "   " });
    const out = await processWhatsAppDocumentsIntake(
      baseInput({ wamid: "wamid.ocr-empty" }),
      deps
    );
    assert.equal(out.status, "failed");
    if (out.status === "failed") assert.equal(out.reason, "ocr_empty");
    assert.equal(rows.find((r) => r.wamid === "wamid.ocr-empty")?.status, "failed");
  }

  // --- createDocument fail ---
  {
    const { deps, rows } = createMockDeps({ createDocumentThrow: true });
    const out = await processWhatsAppDocumentsIntake(
      baseInput({ wamid: "wamid.doc-fail" }),
      deps
    );
    assert.equal(out.status, "failed");
    if (out.status === "failed") assert.equal(out.reason, "create_document_failed");
    assert.equal(rows.find((r) => r.wamid === "wamid.doc-fail")?.status, "failed");
  }

  // --- storage fail ---
  {
    const { deps, rows } = createMockDeps({ storageFail: true });
    const out = await processWhatsAppDocumentsIntake(
      baseInput({ wamid: "wamid.storage-fail" }),
      deps
    );
    assert.equal(out.status, "failed");
    if (out.status === "failed") assert.equal(out.reason, "storage_failed");
    assert.equal(rows.find((r) => r.wamid === "wamid.storage-fail")?.status, "failed");
  }

  // --- documents intake service must not couple to Conversation ---
  //
  // The original PR4 invariant — "PR4 surfaces don't touch Conversation" —
  // applied to the webhook route too. Bot-MVP-1 intentionally relaxed
  // the webhook side: the webhook route now coordinates BOTH the
  // documents intake path and the conversation intake path, so it
  // legitimately imports from `conversation-intake.service`. The
  // boundary moves to the documents intake service itself: it MUST
  // remain a pure documents pipeline with no Conversation coupling.
  const intakeSrc = readFileSync(
    path.join(
      process.cwd(),
      "lib/services/integrations/whatsapp/documents-intake.service.ts"
    ),
    "utf8"
  );
  assert.ok(!/\/api\/message/i.test(intakeSrc), "must not call Conversation API");
  assert.ok(!/prisma\.conversation/i.test(intakeSrc), "must not touch Conversation");
  assert.ok(
    !/from\s+["']@\/.*conversation/i.test(intakeSrc),
    "must not import Conversation modules"
  );

  // --- webhook route assertions, narrowed ---
  const webhookSrc = readFileSync(
    path.join(process.cwd(), "app/api/integrations/whatsapp/webhook/route.ts"),
    "utf8"
  );
  // Webhook never calls /api/message directly — all routing goes through
  // the intake services. (Conversation imports ARE allowed: the webhook
  // legitimately imports `conversation-intake.service` as of Bot-MVP-1.)
  assert.ok(!/\/api\/message/i.test(webhookSrc), "webhook must not call /api/message");
  assert.ok(
    !/prisma\.conversation/i.test(webhookSrc),
    "webhook must not touch Conversation directly — use the intake service"
  );

  console.log("PR4 WhatsApp documents intake tests passed.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
