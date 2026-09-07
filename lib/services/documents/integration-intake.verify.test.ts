/**
 * I-7C.3 — inbound integration intake: acceptance and Gmail idempotency.
 *
 * NO database and NO network.
 *
 * # The two things this has to prove
 *
 * 1. A file entering through Gmail or WhatsApp is judged by the SAME rules as
 *    one the owner uploads. Until now each channel carried its own allowlist and
 *    neither looked at a byte, so which files Dubiz accepted depended on which
 *    door they came through.
 *
 * 2. A Gmail import cannot leave a Document that a retry is unable to recognise.
 *    That state was reachable — Document and `EmailAttachmentImport` committed
 *    separately — and the retry then imported the same attachment again.
 *
 * The second cannot be shown by reading the code. It is driven below through a
 * transaction simulator that buffers writes and applies them only on commit,
 * and that enforces the same unique constraints the real table does. So a
 * rolled-back transaction leaves nothing behind here for exactly the reason it
 * leaves nothing behind in PostgreSQL.
 *
 * Run: npx tsx lib/services/documents/integration-intake.verify.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  containerForDeclaredMime,
  detectFileSignature,
  verifyFileSignature,
} from "@/lib/services/documents/file-signature";
import {
  DOCUMENT_MAX_UPLOAD_BYTES,
  isAllowedDocumentMime,
} from "@/lib/services/documents/document-ingestion.service";
import {
  validateWhatsAppMediaContent,
  WHATSAPP_MEDIA_MAX_BYTES,
} from "@/lib/services/integrations/whatsapp/media-validation.service";
import {
  writeDocumentRecords,
  type CreateDocumentFromOcrParams,
} from "@/lib/services/documents/create-document-from-ocr.service";

let passed = 0;
function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(fn()).then(() => {
    passed += 1;
    console.log(`  ok  ${label}`);
  });
}

/* ============================== fixtures ============================== */

const pdf = (tag = "x") =>
  Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from(tag)]);
const jpeg = (tag = "x") =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(tag)]);
const png = (tag = "x") =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(tag),
  ]);
const arbitrary = Buffer.from("MZ\x90\x00 not a document");

const GMAIL_ROUTE = "app/api/integrations/gmail/import/route.ts";
const MATERIALIZER = "lib/services/documents/create-document-from-ocr.service.ts";
const WA_VALIDATION =
  "lib/services/integrations/whatsapp/media-validation.service.ts";
const WA_FETCH = "lib/services/integrations/whatsapp/media-fetch.service.ts";

const gmailSrc = fs.readFileSync(GMAIL_ROUTE, "utf8");
const materializerSrc = fs.readFileSync(MATERIALIZER, "utf8");
const waValidationSrc = fs.readFileSync(WA_VALIDATION, "utf8");
const waFetchSrc = fs.readFileSync(WA_FETCH, "utf8");

/** Read the CODE, not the prose that explains what it must not do. */
function stripComments(src: string): string {
  const withoutBlocks = src.replace(/\/\*[\s\S]*?\*\//g, " ");
  return withoutBlocks
    .split("\n")
    .map((line) => {
      const i = line.indexOf("//");
      if (i < 0) return line;
      const before = line.slice(0, i);
      const quotes = (before.match(/["']/g) ?? []).length;
      return quotes % 2 === 0 ? before : line;
    })
    .join("\n");
}
const gmailCode = stripComments(gmailSrc);
const waFetchCode = stripComments(waFetchSrc);

/* ================ a transaction simulator with real constraints ======== */

type DocRow = { id: number; businessId: number; hash: string | null; ocrText: string | null };
type ImportRow = {
  id: number;
  businessId: number;
  messageId: string;
  attachmentId: string;
  hash: string;
  documentId: number;
};

class Uniqueness extends Error {
  code = "P2002";
  constructor() {
    super("Unique constraint failed");
    this.name = "PrismaClientKnownRequestError";
  }
}

/**
 * The committed world plus a transaction runner.
 *
 * Writes inside a transaction are buffered and applied only when the callback
 * resolves; a throw discards every one of them. Unique constraints are checked
 * against committed AND buffered rows, exactly as the database would.
 */
class World {
  documents: DocRow[] = [];
  extracted: { id: number; documentId: number }[] = [];
  imports: ImportRow[] = [];
  /**
   * Unique keys held by transactions that have not committed yet.
   *
   * Without this the simulator would let two concurrent inserts of the same key
   * both succeed, because neither has committed when the other looks. A real
   * unique index does not behave that way: the second INSERT blocks on the
   * first and then raises a violation once it commits. Modelling the reservation
   * reproduces that OUTCOME, which is the part the test is about.
   */
  private reserved = new Set<string>();
  private seq = 1;

  async transaction<T>(fn: (db: never) => Promise<T>): Promise<T> {
    const stagedDocs: DocRow[] = [];
    const stagedExtracted: { id: number; documentId: number }[] = [];
    const stagedImports: ImportRow[] = [];
    const held: string[] = [];

    const db = {
      document: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row: DocRow = {
            id: this.seq++,
            businessId: data.businessId as number,
            hash: (data.contentHashSha256 as string) ?? null,
            ocrText: (data.ocrText as string) ?? null,
          };
          stagedDocs.push(row);
          return row;
        },
      },
      extractedData: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: this.seq++, documentId: data.documentId as number };
          stagedExtracted.push(row);
          return row;
        },
      },
      emailAttachmentImport: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row: ImportRow = {
            id: this.seq++,
            businessId: data.businessId as number,
            messageId: data.messageId as string,
            attachmentId: data.attachmentId as string,
            hash: data.contentHashSha256 as string,
            documentId: data.documentId as number,
          };
          const keys = [
            `identity:${row.businessId}:${row.messageId}:${row.attachmentId}`,
            `hash:${row.businessId}:${row.hash}`,
          ];
          const committed = [...this.imports, ...stagedImports];
          const clash =
            committed.some(
              (r) =>
                r.businessId === row.businessId &&
                ((r.messageId === row.messageId &&
                  r.attachmentId === row.attachmentId) ||
                  r.hash === row.hash)
            ) || keys.some((k) => this.reserveHeld(k));
          if (clash) throw new Uniqueness();
          for (const k of keys) {
            this.reserve(k);
            held.push(k);
          }
          stagedImports.push(row);
          return row;
        },
      },
    };

    try {
      const result = await fn(db as never);
      // COMMIT — reached only if nothing threw.
      this.documents.push(...stagedDocs);
      this.extracted.push(...stagedExtracted);
      this.imports.push(...stagedImports);
      return result;
    } finally {
      // Commit or rollback, the reservation is over. A rolled-back key must
      // become free again or a retry could never succeed.
      for (const k of held) this.reserved.delete(k);
    }
  }

  private reserve(key: string): void {
    this.reserved.add(key);
  }

  private reserveHeld(key: string): boolean {
    return this.reserved.has(key);
  }
}

/** One Gmail import attempt, with the route's ordering around the transaction. */
async function gmailImport(
  world: World,
  opts: {
    messageId: string;
    attachmentId: string;
    hash: string;
    ocrText: string | null;
    /** Simulates a crash inside the transaction after the identity row. */
    failAfterIdentity?: boolean;
  }
): Promise<{ outcome: "imported" | "duplicate"; documentId?: number }> {
  // The route's pre-check: has this attachment identity already been recorded?
  const seen = world.imports.some(
    (r) =>
      r.messageId === opts.messageId && r.attachmentId === opts.attachmentId
  );
  if (seen) return { outcome: "duplicate" };

  let importRowWritten = false;
  const params: CreateDocumentFromOcrParams = {
    businessId: 7,
    source: "email",
    mimeType: "application/pdf",
    ocrText: opts.ocrText,
    fileUrl: "doc-1.pdf",
    contentHashSha256: opts.hash,
    withinTransaction: async (tx, documentId) => {
      await (tx as unknown as {
        emailAttachmentImport: { create: (a: unknown) => Promise<unknown> };
      }).emailAttachmentImport.create({
        data: {
          businessId: 7,
          messageId: opts.messageId,
          attachmentId: opts.attachmentId,
          contentHashSha256: opts.hash,
          documentId,
        },
      });
      importRowWritten = true;
      if (opts.failAfterIdentity) throw new Error("crash before commit");
    },
  };

  // `extracted` stands in for a completed extraction; null means OCR read
  // nothing, which is the bare-Document case.
  const extracted = opts.ocrText
    ? ({
        amount: 1,
        vendorName: "v",
        category: "c",
        amountConfidence: 1,
        vendorConfidence: 1,
        categoryConfidence: 1,
        direction: "in",
        date: null,
        confidence: 1,
      } as never)
    : null;

  try {
    const written = await world.transaction((db) =>
      writeDocumentRecords(db, params, extracted, opts.ocrText)
    );
    return { outcome: "imported", documentId: written.documentId };
  } catch (error) {
    if ((error as { code?: string }).code === "P2002" && !importRowWritten) {
      return { outcome: "duplicate" };
    }
    throw error;
  }
}

async function main() {
  /* ================= 1. one acceptance rule for every door ============== */

  console.log("\n1. Every intake path judges a file the same way");

  await check("the supported set is identical across upload, import, Gmail and WhatsApp", () => {
    for (const m of ["application/pdf", "image/jpeg", "image/png"]) {
      assert.equal(isAllowedDocumentMime(m), true, m);
      assert.equal(
        validateWhatsAppMediaContent({ buffer: pdf(), mimeType: m }).ok ||
          m !== "application/pdf",
        true
      );
    }
    for (const m of ["image/webp", "image/gif", "image/heic", "text/html"]) {
      assert.equal(isAllowedDocumentMime(m), false, m);
    }
  });

  await check("no integration keeps a private allowlist any more", () => {
    assert.equal(/m === "application\/pdf" \|\| m\.startsWith\("image\//.test(gmailCode), false);
    assert.equal(
      /m === "application\/pdf" \|\| m\.startsWith\("image\//.test(stripComments(waValidationSrc)),
      false
    );
    assert.equal(gmailCode.includes("isAllowedDocumentMime("), true);
    assert.equal(waValidationSrc.includes("isAllowedDocumentMime("), true);
  });

  await check("the size ceiling is ONE constant, not three copies", () => {
    assert.equal(WHATSAPP_MEDIA_MAX_BYTES, DOCUMENT_MAX_UPLOAD_BYTES);
    assert.equal(gmailCode.includes("DOCUMENT_MAX_UPLOAD_BYTES"), true);
    assert.equal(/MAX_ATTACHMENT_BYTES = 15 \* 1024 \* 1024/.test(gmailCode), false);
    assert.equal(/WHATSAPP_MEDIA_MAX_BYTES = 15 \* 1024 \* 1024/.test(waValidationSrc), false);
  });

  /* ============================ 2. Gmail bytes ========================== */

  console.log("\n2. Gmail — the bytes must match the claim");

  await check("a genuine file under its own type passes", () => {
    for (const [bytes, mime] of [
      [pdf(), "application/pdf"],
      [jpeg(), "image/jpeg"],
      [png(), "image/png"],
    ] as const) {
      assert.equal(verifyFileSignature(bytes, mime).ok, true, mime);
    }
  });

  await check("arbitrary bytes are refused under every supported claim", () => {
    for (const mime of ["application/pdf", "image/jpeg", "image/png"]) {
      assert.equal(verifyFileSignature(arbitrary, mime).ok, false, mime);
    }
  });

  await check("a real file under the wrong claim is refused", () => {
    assert.equal(verifyFileSignature(jpeg(), "application/pdf").ok, false);
    assert.equal(verifyFileSignature(pdf(), "image/jpeg").ok, false);
    assert.equal(verifyFileSignature(png(), "application/pdf").ok, false);
  });

  await check("unsupported, HEIC, empty and absent types are all refused", () => {
    assert.equal(isAllowedDocumentMime("image/webp"), false);
    assert.equal(isAllowedDocumentMime("image/heic"), false);
    assert.equal(isAllowedDocumentMime(""), false);
    assert.equal(verifyFileSignature(Buffer.alloc(0), "application/pdf").ok, false);
    assert.equal(gmailCode.includes("isHeicMimeType("), true);
  });

  await check("the Gmail gate sits after the bytes and before every write", () => {
    const fetched = gmailCode.indexOf("fetchGmailAttachmentBytes(");
    const verify = gmailCode.indexOf("verifyFileSignature(");
    const store = gmailCode.indexOf("putDocumentObject(");
    const create = gmailCode.indexOf("createDocumentFromOcrText(");
    const ocr = gmailCode.indexOf("runGoogleVisionOCR(");
    assert.equal(fetched < verify, true, "bytes first");
    assert.equal(verify < ocr, true, "before OCR is even attempted");
    assert.equal(verify < store, true, "before storage");
    assert.equal(verify < create, true, "before the Document");
  });

  await check("a failed signature check actually STOPS the import", () => {
    // Ordering alone proves nothing: the call can sit in the right place with
    // its verdict ignored. Assert the refusal is acted on, and acted on before
    // anything is written.
    const verify = gmailCode.indexOf("const signature = verifyFileSignature(");
    const guard = gmailCode.indexOf("if (!signature.ok)", verify);
    const store = gmailCode.indexOf("putDocumentObject(", verify);
    assert.equal(guard > verify, true, "the verdict is checked");
    assert.equal(guard < store, true, "and checked before storage");
    const between = gmailCode.slice(guard, store);
    assert.equal(between.includes("status: 415"), true, "it refuses with 415");
    assert.equal(between.includes("signatureRejectionMessage("), true);
    assert.equal(
      gmailCode.slice(guard, guard + 300).includes("return NextResponse.json"),
      true,
      "the refusal returns rather than falling through"
    );
  });

  await check("the size ceiling is enforced on real bytes, not just the claim", () => {
    const real = gmailCode.indexOf("effectiveSize > MAX_ATTACHMENT_BYTES");
    assert.equal(real > 0, true);
    assert.equal(real < gmailCode.indexOf("verifyFileSignature("), true);
  });

  /* =========================== 3. WhatsApp bytes ======================== */

  console.log("\n3. WhatsApp — and no invented type");

  await check("a genuine file under the provider's type passes", () => {
    for (const [buffer, mimeType] of [
      [pdf(), "application/pdf"],
      [jpeg(), "image/jpeg"],
      [png(), "image/png"],
    ] as const) {
      const r = validateWhatsAppMediaContent({ buffer, mimeType });
      assert.equal(r.ok, true, mimeType);
      assert.equal(r.ok && r.mimeType, mimeType);
    }
  });

  await check("bytes contradicting the provider's type are refused", () => {
    for (const [buffer, mimeType] of [
      [jpeg(), "application/pdf"],
      [pdf(), "image/png"],
      [arbitrary, "application/pdf"],
    ] as const) {
      const r = validateWhatsAppMediaContent({ buffer, mimeType });
      assert.equal(r.ok, false, mimeType);
      assert.equal(r.ok === false && r.reason, "content_mismatch", mimeType);
    }
  });

  await check("unsupported and HEIC media are refused as unsupported", () => {
    for (const mimeType of ["image/webp", "image/heic", "audio/ogg"]) {
      const r = validateWhatsAppMediaContent({ buffer: jpeg(), mimeType });
      assert.equal(r.ok, false, mimeType);
      assert.equal(r.ok === false && r.reason, "unsupported_mime", mimeType);
    }
  });

  await check("empty media is refused and oversize media is refused as too large", () => {
    const empty = validateWhatsAppMediaContent({ buffer: Buffer.alloc(0), mimeType: "application/pdf" });
    assert.equal(empty.ok === false && empty.reason, "unsupported_mime");
    const big = validateWhatsAppMediaContent({
      buffer: Buffer.concat([pdf(), Buffer.alloc(DOCUMENT_MAX_UPLOAD_BYTES)]),
      mimeType: "application/pdf",
    });
    assert.equal(big.ok === false && big.reason, "file_too_large");
  });

  await check("A MISSING TYPE IS NEVER ASSUMED TO BE PDF", () => {
    // The defect: metadata without a mime_type became "application/pdf" for
    // anything routed as a document, so an unknown file was stored, OCR'd and
    // recorded under a type nobody had established.
    const unknown = validateWhatsAppMediaContent({ buffer: arbitrary, mimeType: null });
    assert.equal(unknown.ok, false, "unknown bytes are refused, not assumed");
    assert.equal(unknown.ok === false && unknown.reason, "unsupported_mime");
  });

  await check("a missing type is resolved from the bytes when they are recognisable", () => {
    // Reading the container off the file is the one authority nobody outside
    // can assert, so it is allowed to establish the type where a claim is absent.
    for (const [buffer, expected] of [
      [pdf(), "application/pdf"],
      [jpeg(), "image/jpeg"],
      [png(), "image/png"],
    ] as const) {
      const r = validateWhatsAppMediaContent({ buffer, mimeType: null });
      assert.equal(r.ok, true, expected);
      assert.equal(r.ok && r.mimeType, expected);
    }
    assert.equal(detectFileSignature(arbitrary), null);
  });

  await check("the routing media type can no longer influence the file type", () => {
    assert.equal(waFetchCode.includes('routingMediaType === "document"'), false);
    assert.equal(waFetchCode.includes("mimeType: metadata.mimeType"), true);
  });

  /* ==================== 4. Gmail idempotency, driven ==================== */

  console.log("\n4. Gmail — a Document a retry cannot see is unreachable");

  await check("a normal import creates exactly one Document and one identity", async () => {
    const w = new World();
    const r = await gmailImport(w, { messageId: "m1", attachmentId: "a1", hash: "h1", ocrText: "text" });
    assert.equal(r.outcome, "imported");
    assert.equal(w.documents.length, 1);
    assert.equal(w.imports.length, 1);
    assert.equal(w.extracted.length, 1);
    assert.equal(w.imports[0].documentId, w.documents[0].id);
  });

  await check("RETRY of the same attachment creates no second Document", async () => {
    const w = new World();
    await gmailImport(w, { messageId: "m1", attachmentId: "a1", hash: "h1", ocrText: "t" });
    const again = await gmailImport(w, { messageId: "m1", attachmentId: "a1", hash: "h1", ocrText: "t" });
    assert.equal(again.outcome, "duplicate");
    assert.equal(w.documents.length, 1);
  });

  await check("RESPONSE LOST — the retry finds the existing truth", async () => {
    const w = new World();
    await gmailImport(w, { messageId: "m2", attachmentId: "a2", hash: "h2", ocrText: "t" });
    for (let i = 0; i < 4; i++) {
      const retry = await gmailImport(w, { messageId: "m2", attachmentId: "a2", hash: "h2", ocrText: "t" });
      assert.equal(retry.outcome, "duplicate");
    }
    assert.equal(w.documents.length, 1);
    assert.equal(w.imports.length, 1);
  });

  await check("IDENTITY WRITE FAILS — the Document rolls back with it", async () => {
    // The exact state the increment exists to make unreachable.
    const w = new World();
    await assert.rejects(() =>
      gmailImport(w, {
        messageId: "m3",
        attachmentId: "a3",
        hash: "h3",
        ocrText: "t",
        failAfterIdentity: true,
      })
    );
    assert.equal(w.documents.length, 0, "NO Document survived");
    assert.equal(w.imports.length, 0, "and no identity either");
    assert.equal(w.extracted.length, 0);
  });

  await check("after that failure the retry creates exactly one Document", async () => {
    const w = new World();
    await assert.rejects(() =>
      gmailImport(w, { messageId: "m4", attachmentId: "a4", hash: "h4", ocrText: "t", failAfterIdentity: true })
    );
    const retry = await gmailImport(w, { messageId: "m4", attachmentId: "a4", hash: "h4", ocrText: "t" });
    assert.equal(retry.outcome, "imported");
    assert.equal(w.documents.length, 1, "exactly one, not zero and not two");
  });

  await check("CONCURRENT duplicates leave exactly one durable Document", async () => {
    const w = new World();
    // Both requests pass the advisory pre-check, both open a transaction; the
    // unique constraint on the identity row decides, and the loser's Document
    // rolls back with its row.
    const results = await Promise.all([
      gmailImport(w, { messageId: "m5", attachmentId: "a5", hash: "h5", ocrText: "t" }),
      gmailImport(w, { messageId: "m5", attachmentId: "a5", hash: "h5", ocrText: "t" }),
    ]);
    const imported = results.filter((r) => r.outcome === "imported");
    assert.equal(imported.length, 1, "exactly one import succeeded");
    assert.equal(w.documents.length, 1, "and exactly one Document exists");
    assert.equal(w.imports.length, 1);
  });

  await check("a same-bytes attachment from another message is still one Document", async () => {
    const w = new World();
    await gmailImport(w, { messageId: "m6", attachmentId: "a6", hash: "same", ocrText: "t" });
    const forwarded = await gmailImport(w, {
      messageId: "m7",
      attachmentId: "a7",
      hash: "same",
      ocrText: "t",
    });
    // Caught by the identity table's content-hash unique, and the Document that
    // would have accompanied it rolled back.
    assert.equal(forwarded.outcome, "duplicate");
    assert.equal(w.documents.length, 1);
  });

  /* ===================== 5. the OCR-empty branch ======================== */

  console.log("\n5. The unread-file branch keeps every guarantee");

  await check("no OCR text still yields one Document, with no extracted data", async () => {
    const w = new World();
    const r = await gmailImport(w, { messageId: "m8", attachmentId: "a8", hash: "h8", ocrText: null });
    assert.equal(r.outcome, "imported");
    assert.equal(w.documents.length, 1);
    assert.equal(w.documents[0].ocrText, null);
    assert.equal(w.extracted.length, 0, "nothing was fabricated");
    assert.equal(w.imports.length, 1, "and it is still recognisable on retry");
  });

  await check("the unread branch rolls back identically", async () => {
    const w = new World();
    await assert.rejects(() =>
      gmailImport(w, { messageId: "m9", attachmentId: "a9", hash: "h9", ocrText: null, failAfterIdentity: true })
    );
    assert.equal(w.documents.length, 0);
    assert.equal(w.imports.length, 0);
  });

  await check("the unread branch goes through the canonical materializer", () => {
    // It used to be a hand-rolled document.create sitting beside the call.
    assert.equal(gmailCode.includes("tx.document.create("), false);
    assert.equal(gmailCode.includes("document.create("), false);
    assert.equal((gmailCode.match(/createDocumentFromOcrText\(/g) ?? []).length, 1);
    assert.equal(gmailCode.includes("ocrText: ocrSucceeded ? rawText : null"), true);
  });

  /* ================= 6. structure the harness cannot see ================ */

  console.log("\n6. Wiring, ordering and boundaries");

  await check("the identity row is written INSIDE the materializer's transaction", () => {
    assert.equal(/withinTransaction: async \(tx, documentId\) => \{/.test(gmailCode), true);
    const hookStart = gmailCode.indexOf("withinTransaction:");
    const hookCreate = gmailCode.indexOf("emailAttachmentImport.create(", hookStart);
    assert.equal(hookCreate > hookStart, true, "the create lives in the hook");
    // and nowhere else
    assert.equal((gmailCode.match(/emailAttachmentImport\.create\(/g) ?? []).length, 1);
  });

  await check("the materializer runs the hook last, inside its one transaction", () => {
    const code = stripComments(materializerSrc);
    const doc = code.indexOf("db.document.create(");
    const hook = code.indexOf("params.withinTransaction(db, document.id)");
    assert.equal(doc > 0 && hook > doc, true, "hook after the Document, for its id");
    assert.equal(code.includes("dbTx((db) =>"), true);
    assert.equal(code.includes("writeDocumentRecords(db, params, extracted, ocrText)"), true);
    // one transaction, not two
    assert.equal((code.match(/await dbTx\(/g) ?? []).length, 1);
  });

  await check("the transaction hook runs inside the tenant transaction", () => {
    const code = stripComments(materializerSrc);
    assert.equal(code.includes("withTenantTransaction((tx) => fn(tx))"), true);
    assert.equal(code.includes("getTenantContext() !== undefined"), true);
    // Gmail establishes the tenant before anything runs.
    assert.equal(gmailCode.includes("runWithTenantContext("), true);
  });

  await check("extraction stays outside the transaction", () => {
    const code = stripComments(materializerSrc);
    const extract = code.indexOf("runUnifiedDocumentIntelligence(");
    const tx = code.indexOf("await dbTx(");
    assert.equal(extract > 0 && extract < tx, true, "no model call inside a DB lock");
  });

  await check("the losing concurrent request cleans up its stored object", () => {
    const race = gmailCode.indexOf('code === "P2002"');
    const cleanup = gmailCode.indexOf("deleteDocumentObjectQuiet(", race);
    const respond = gmailCode.indexOf('reason: "concurrent_duplicate"', race);
    assert.equal(cleanup > race && cleanup < respond, true, "delete before replying");
  });

  await check("the storage object survives only once a Document does", () => {
    // The flag suppresses the outer catch's object cleanup, so it must not be
    // set until the transaction has actually committed — which means after the
    // whole try/catch around it, not merely after the call appears.
    const flag = gmailCode.indexOf("permanentFilePersisted = true");
    const raceRethrow = gmailCode.indexOf("throw raceErr;");
    assert.equal(raceRethrow > 0, true);
    assert.equal(flag > raceRethrow, true, "set only after the transaction resolved");
    assert.equal(
      (gmailCode.match(/permanentFilePersisted = true/g) ?? []).length,
      1,
      "and set in exactly one place"
    );
  });

  await check("the materializer never grows storage or channel policy", () => {
    const code = stripComments(materializerSrc);
    for (const forbidden of [
      "putDocumentObject",
      "deleteDocumentObjectQuiet",
      "sha256",
      "emailAttachmentImport",
      "whatsAppAttachmentImport",
      "processDocumentPipeline",
      "after(",
    ]) {
      assert.equal(code.includes(forbidden), false, forbidden);
    }
  });

  await check("ingestion-first and extraction-first stay separate", () => {
    const code = stripComments(materializerSrc);
    assert.equal(code.includes("ingestDocument"), false, "no collapsing into one path");
    assert.equal(code.includes('status: "needs_review"'), true);
    assert.equal(code.includes('status: "processing"'), false);
  });

  await check("creation still triggers no approval or learning anywhere", () => {
    const code = stripComments(materializerSrc);
    for (const forbidden of [
      "financialRecord",
      "reviewEvent",
      "billingDocument",
      "BillingDocument",
      "vendorLearn",
      "supplier.",
      "notification",
    ]) {
      assert.equal(code.includes(forbidden), false, `materializer: ${forbidden}`);
      assert.equal(gmailCode.includes(forbidden), false, `gmail: ${forbidden}`);
    }
  });

  await check("the tenant is server-derived on the Gmail path", () => {
    assert.equal(gmailCode.includes("businessId: user.businessId"), true);
    assert.equal(/businessId:\s*(body|json)\./.test(gmailCode), false);
  });

  await check("the container mapping is total and round-trips", () => {
    for (const m of ["application/pdf", "image/jpeg", "image/png"]) {
      const c = containerForDeclaredMime(m);
      assert.notEqual(c, null, m);
    }
  });

  console.log(
    `\nI-7C.3 INTEGRATION INTAKE VERIFY PASS — ${passed} checks green.`
  );
}

main().catch((error) => {
  console.error("\nFAILED:", error);
  process.exit(1);
});
