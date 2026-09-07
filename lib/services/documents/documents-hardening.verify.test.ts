/**
 * I-7E — Gmail MIME provenance and cross-channel duplicate awareness.
 *
 * NO database and NO network.
 *
 * # The two properties under test
 *
 * A. The media type of a Gmail attachment is resolved from GMAIL, not from the
 *    request body. Changing the browser's claim must not change what is
 *    accepted or how the stored Document is typed.
 *
 * B. A file the business already holds does not become a second Document
 *    because identical bytes later arrive through another door — and that
 *    holds under a race, not merely in sequence.
 *
 * Property B's concurrency claim cannot be shown by reading code, so the world
 * below models the advisory lock the way PostgreSQL does: a second transaction
 * asking for a held key WAITS, and by the time it proceeds it sees what the
 * first one committed.
 *
 * Run: npx tsx lib/services/documents/documents-hardening.verify.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  documentContentLockKey,
  DOCUMENT_CONTENT_ADVISORY_NAMESPACE,
} from "@/lib/services/documents/document-duplicate";
import {
  collectAttachmentParts,
  findAttachmentPart,
  type GmailMessagePart,
} from "@/lib/services/integrations/gmail/gmail-message-parts";
import { isAllowedDocumentMime } from "@/lib/services/documents/document-ingestion.service";
import { verifyFileSignature } from "@/lib/services/documents/file-signature";
import { ADVISORY_NAMESPACE } from "@/lib/tenant/business-lifecycle";

let passed = 0;
function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(fn()).then(() => {
    passed += 1;
    console.log(`  ok  ${label}`);
  });
}

/** Source read with line endings normalised, so assertions are about code. */
function readSource(path: string): string {
  return fs.readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => {
      const i = line.indexOf("//");
      if (i < 0) return line;
      const before = line.slice(0, i);
      return (before.match(/["']/g) ?? []).length % 2 === 0 ? before : line;
    })
    .join("\n");
}

const GMAIL_ROUTE = "app/api/integrations/gmail/import/route.ts";
const WA_INTAKE = "lib/services/integrations/whatsapp/documents-intake.service.ts";
const MATERIALIZER = "lib/services/documents/create-document-from-ocr.service.ts";
const INGEST = "lib/services/documents/document-ingestion.service.ts";
const DUP = "lib/services/documents/document-duplicate.ts";
const META = "lib/services/integrations/gmail/gmail-attachment-metadata.service.ts";
const DISCOVERY = "lib/services/integrations/gmail/gmail-discovery.service.ts";

const gmailSrc = readSource(GMAIL_ROUTE);
const gmailCode = stripComments(gmailSrc);
const waSrc = readSource(WA_INTAKE);
const waCode = stripComments(waSrc);
const matCode = stripComments(readSource(MATERIALIZER));
const ingestCode = stripComments(readSource(INGEST));
const dupCode = stripComments(readSource(DUP));
const metaCode = stripComments(readSource(META));
const discoveryCode = stripComments(readSource(DISCOVERY));

/* ====================== the Gmail message fixtures ===================== */

const pdfPart: GmailMessagePart = {
  mimeType: "application/pdf",
  filename: "invoice.pdf",
  body: { attachmentId: "att-pdf", size: 1000 },
};
const jpegPart: GmailMessagePart = {
  mimeType: "image/jpeg",
  filename: "photo.jpg",
  body: { attachmentId: "att-jpeg", size: 900 },
};
/** Two levels of multipart, with the file at the bottom. */
const nested: GmailMessagePart = {
  mimeType: "multipart/mixed",
  parts: [
    { mimeType: "text/plain", body: { size: 10 } },
    {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/html", body: { size: 20 } },
        {
          mimeType: "image/png",
          filename: "deep.png",
          body: { attachmentId: "att-deep", size: 700 },
        },
      ],
    },
    pdfPart,
  ],
};

/* ============ a world whose lock behaves the way Postgres does ========= */

type Doc = { id: number; businessId: number; hash: string; status: string };

class World {
  documents: Doc[] = [];
  private seq = 1;
  /** Lock keys currently held by an uncommitted transaction. */
  private held = new Set<string>();
  private waiters: Array<() => void> = [];

  /**
   * Run a transaction. Writes are buffered and applied on commit; locks are
   * held until then, and a second caller asking for a held key waits — which
   * is precisely what makes the check under the lock authoritative.
   */
  async transaction<T>(fn: (db: TxLike) => Promise<T>): Promise<T> {
    const staged: Doc[] = [];
    const taken: string[] = [];

    const db: TxLike = {
      lock: async (key: string) => {
        while (this.held.has(key)) {
          await new Promise<void>((resolve) => this.waiters.push(resolve));
        }
        this.held.add(key);
        taken.push(key);
      },
      findDuplicate: async (businessId: number, hash: string) =>
        [...this.documents, ...staged]
          .filter(
            (d) => d.businessId === businessId && d.hash === hash && d.status !== "failed"
          )
          .sort((a, b) => b.id - a.id)[0] ?? null,
      createDocument: async (businessId: number, hash: string) => {
        const row: Doc = { id: this.seq++, businessId, hash, status: "needs_review" };
        staged.push(row);
        return row;
      },
    };

    try {
      const out = await fn(db);
      this.documents.push(...staged);
      return out;
    } finally {
      for (const key of taken) this.held.delete(key);
      const waiting = this.waiters;
      this.waiters = [];
      for (const resume of waiting) resume();
    }
  }
}

type TxLike = {
  lock: (key: string) => Promise<void>;
  findDuplicate: (businessId: number, hash: string) => Promise<Doc | null>;
  createDocument: (businessId: number, hash: string) => Promise<Doc>;
};

/** One intake, shaped exactly like the production sequence. */
async function intake(
  world: World,
  businessId: number,
  hash: string,
  policy: "SKIP_IF_EXISTS" | "ALLOW"
): Promise<"created" | "skipped"> {
  return world.transaction(async (db) => {
    await db.lock(`${DOCUMENT_CONTENT_ADVISORY_NAMESPACE}:${documentContentLockKey(businessId, hash)}`);
    if (policy === "SKIP_IF_EXISTS") {
      const existing = await db.findDuplicate(businessId, hash);
      if (existing) return "skipped";
    }
    await db.createDocument(businessId, hash);
    return "created";
  });
}

async function main() {
  /* ============== 1. Gmail resolves its own attachment types ============ */

  console.log("\n1. The message, not the browser, says what an attachment is");

  await check("an attachment id resolves to the part that carries it", () => {
    const found = findAttachmentPart(nested, "att-pdf");
    assert.equal(found?.mimeType, "application/pdf");
    assert.equal(found?.filename, "invoice.pdf");
  });

  await check("a file nested two levels deep is still found", () => {
    const found = findAttachmentPart(nested, "att-deep");
    assert.equal(found?.mimeType, "image/png");
    assert.equal(found?.filename, "deep.png");
    assert.equal(collectAttachmentParts(nested).length, 2, "both attachments, no text parts");
  });

  await check("an id that is not in this message resolves to nothing", () => {
    assert.equal(findAttachmentPart(nested, "att-from-another-message"), null);
    assert.equal(findAttachmentPart(nested, ""), null);
    assert.equal(findAttachmentPart(undefined, "att-pdf"), null);
  });

  await check("an ambiguous id is refused rather than guessed", () => {
    // Two parts claiming one id means the message does not identify the file.
    // Picking one would risk typing a stored document from the wrong part.
    const ambiguous: GmailMessagePart = {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "application/pdf", filename: "a.pdf", body: { attachmentId: "dup" } },
        { mimeType: "image/png", filename: "b.png", body: { attachmentId: "dup" } },
      ],
    };
    assert.equal(findAttachmentPart(ambiguous, "dup"), null);
  });

  await check("a top-level attachment beside nested ones is found too", () => {
    const flat: GmailMessagePart = { mimeType: "multipart/mixed", parts: [jpegPart] };
    assert.equal(findAttachmentPart(flat, "att-jpeg")?.mimeType, "image/jpeg");
  });

  await check("two parts sharing a FILENAME are still distinct attachments", () => {
    const sameName: GmailMessagePart = {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "application/pdf", filename: "scan.pdf", body: { attachmentId: "one" } },
        { mimeType: "application/pdf", filename: "scan.pdf", body: { attachmentId: "two" } },
      ],
    };
    assert.equal(findAttachmentPart(sameName, "one")?.body?.attachmentId, "one");
    assert.equal(findAttachmentPart(sameName, "two")?.body?.attachmentId, "two");
  });

  await check("an inline part with no attachment id is not an attachment", () => {
    const inline: GmailMessagePart = {
      mimeType: "multipart/mixed",
      parts: [{ mimeType: "image/png", filename: "sig.png", body: { size: 5 } }],
    };
    assert.equal(collectAttachmentParts(inline).length, 0);
  });

  await check("the resolver never invents a type when Gmail omits one", () => {
    assert.equal(metaCode.includes('String(part.mimeType || "")'), true);
    assert.equal(metaCode.includes("application/octet-stream"), false);
    assert.equal(/mimeType.*\|\|.*"application\/pdf"/.test(metaCode), false);
  });

  /* ================ 2. the browser has no MIME authority ================ */

  console.log("\n2. The request body cannot change what is accepted");

  await check("the route reads its type from the Gmail descriptor", () => {
    assert.equal(gmailCode.includes("fetchGmailAttachmentDescriptor("), true);
    assert.equal(gmailCode.includes("const gmailMimeType = lookup.descriptor.mimeType"), true);
  });

  await check("body.mimeType is read NOWHERE in the route's code", () => {
    // The field survives in the request shape for existing clients; it must
    // have no effect. A comment may mention it; code may not use it.
    assert.equal(gmailCode.includes("body.mimeType"), false);
  });

  await check("every downstream use takes the resolved type", () => {
    for (const use of [
      "verifyFileSignature(Buffer.from(bytes), gmailMimeType)",
      "buildStoredDocumentFileName(gmailMimeType)",
      "runGoogleVisionOCR(tmp.tempPath, gmailMimeType)",
      "contentType: gmailMimeType",
      "mimeType: gmailMimeType",
    ]) {
      assert.equal(gmailCode.includes(use), true, use);
    }
  });

  await check("the allowlist and HEIC refusal judge the RESOLVED type", () => {
    assert.equal(gmailCode.includes("isAllowedDocumentMime(gmailMimeType)"), true);
    assert.equal(gmailCode.includes("isHeicMimeType(gmailMimeType)"), true);
    assert.equal(/isAllowedDocumentMime\(body\./.test(gmailCode), false);
  });

  await check("the type is resolved BEFORE the bytes are fetched", () => {
    const resolve = gmailCode.indexOf("fetchGmailAttachmentDescriptor(");
    const fetchBytes = gmailCode.indexOf("fetchGmailAttachmentBytes(");
    assert.equal(resolve < fetchBytes, true, "an unsupported type costs no download");
  });

  await check("Gmail's own claim still has to survive the bytes", () => {
    const verify = gmailCode.indexOf("verifyFileSignature(");
    const store = gmailCode.indexOf("putDocumentObject(");
    const ocr = gmailCode.indexOf("runGoogleVisionOCR(");
    assert.equal(verify < store && verify < ocr, true);
    // Gmail saying PDF over JPEG bytes is a refusal, never a silent re-type.
    assert.equal(verifyFileSignature(Buffer.from([0xff, 0xd8, 0xff]), "application/pdf").ok, false);
    assert.equal(gmailCode.includes("signatureRejectionMessage(signature.reason)"), true);
  });

  await check("an unsupported Gmail type is refused for every non-canonical case", () => {
    for (const m of ["image/webp", "image/gif", "application/zip", "", "image/heic"]) {
      assert.equal(isAllowedDocumentMime(m), false, m);
    }
    for (const m of ["application/pdf", "image/jpeg", "image/png"]) {
      assert.equal(isAllowedDocumentMime(m), true, m);
    }
  });

  await check("discovery offers exactly what import will accept", () => {
    // It used to list "PDF or any image", advertising files import refuses.
    assert.equal(discoveryCode.includes("isAllowedDocumentMime(mimeType)"), true);
    assert.equal(/mimeType\.startsWith\("image\//.test(discoveryCode), false);
  });

  await check("there is ONE part walk, shared by discovery and import", () => {
    assert.equal(discoveryCode.includes("collectAttachmentParts("), true);
    assert.equal(/function collectAttachments\b/.test(discoveryCode), false);
    assert.equal(metaCode.includes("findAttachmentPart("), true);
  });

  /* ============ 3. one document per file, across every door ============= */

  console.log("\n3. Cross-channel duplicate awareness");

  await check("the duplicate rule lives in ONE module, tenant-scoped", () => {
    assert.equal(dupCode.includes("businessId,"), true);
    assert.equal(dupCode.includes('status: { not: "failed" }'), true);
    for (const consumer of [ingestCode, matCode]) {
      assert.equal(consumer.includes("findDuplicateDocumentTx("), true);
    }
    // No channel keeps its own copy of the question.
    assert.equal(/document\.findFirst\(/.test(waCode), false);
    assert.equal(/document\.findFirst\(/.test(stripComments(gmailSrc)), false);
  });

  await check("both integrations ask before spending storage and OCR", () => {
    const gEarly = gmailCode.indexOf("findDuplicateDocumentTx(");
    const gStore = gmailCode.indexOf("putDocumentObject(");
    const gOcr = gmailCode.indexOf("runGoogleVisionOCR(");
    assert.equal(gEarly < gStore && gEarly < gOcr, true, "gmail asks first");

    const wEarly = waCode.indexOf("findDuplicateDocumentTx(");
    const wStore = waCode.indexOf("deps.putDocument(");
    const wOcr = waCode.indexOf("deps.runOcr(");
    assert.equal(wEarly < wStore && wEarly < wOcr, true, "whatsapp asks first");
  });

  await check("both integrations pass SKIP_IF_EXISTS as an explicit policy", () => {
    assert.equal(gmailCode.includes('duplicatePolicy: "SKIP_IF_EXISTS"'), true);
    assert.equal(waCode.includes('duplicatePolicy: "SKIP_IF_EXISTS"'), true);
    // and the materializer owns the mechanism, never the policy
    assert.equal(matCode.includes('source === "email"'), false);
    assert.equal(matCode.includes("wamid"), false);
  });

  await check("a skipped duplicate gets durable terminal channel truth", () => {
    assert.equal(gmailCode.includes('status: "skipped_duplicate"'), true);
    assert.equal(gmailCode.includes("documentId: existingDocument.documentId"), true);
    assert.equal(waCode.includes("markSkippedDuplicate("), true);
    // It is NOT recorded as a failure: nothing went wrong.
    assert.equal(waCode.includes('error: "skipped_existing_document"'), false);
  });

  await check("a skipped duplicate creates no Document and no second copy", () => {
    const g = gmailCode.indexOf('reason: "existing_document"');
    assert.notEqual(g, -1);
    const before = gmailCode.slice(0, g);
    // The early return happens before the materializer is ever called.
    assert.equal(
      before.lastIndexOf("createDocumentFromOcrText(") < before.lastIndexOf("findDuplicateDocumentTx("),
      true
    );
  });

  /* ==================== 4. the race, actually driven ==================== */

  console.log("\n4. Concurrency — the property a pre-check cannot give");

  await check("two channels racing on identical bytes create ONE document", async () => {
    const w = new World();
    const [a, b] = await Promise.all([
      intake(w, 7, "same-hash", "SKIP_IF_EXISTS"),
      intake(w, 7, "same-hash", "SKIP_IF_EXISTS"),
    ]);
    assert.equal(w.documents.length, 1, "exactly one document exists");
    assert.equal([a, b].filter((x) => x === "created").length, 1);
    assert.equal([a, b].filter((x) => x === "skipped").length, 1);
  });

  await check("five concurrent arrivals of the same bytes still create one", async () => {
    const w = new World();
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => intake(w, 7, "h", "SKIP_IF_EXISTS"))
    );
    assert.equal(w.documents.length, 1);
    assert.equal(outcomes.filter((o) => o === "created").length, 1);
  });

  await check("two businesses with the same bytes never block or skip each other", async () => {
    const w = new World();
    const [a, b] = await Promise.all([
      intake(w, 7, "shared", "SKIP_IF_EXISTS"),
      intake(w, 8, "shared", "SKIP_IF_EXISTS"),
    ]);
    assert.equal(a, "created");
    assert.equal(b, "created");
    assert.equal(w.documents.length, 2, "each tenant keeps its own");
    assert.notEqual(
      documentContentLockKey(7, "shared"),
      documentContentLockKey(8, "shared"),
      "and they do not even share a lock key"
    );
  });

  await check("an explicit override still creates its deliberate second copy", async () => {
    const w = new World();
    await intake(w, 7, "h", "SKIP_IF_EXISTS");
    const override = await intake(w, 7, "h", "ALLOW");
    assert.equal(override, "created");
    assert.equal(w.documents.length, 2, "CREATE_ANYWAY is preserved");
  });

  await check("an override races safely too — it waits, then creates once", async () => {
    const w = new World();
    const outcomes = await Promise.all([
      intake(w, 7, "h", "SKIP_IF_EXISTS"),
      intake(w, 7, "h", "ALLOW"),
    ]);
    // Whichever order they serialise in, the ALLOW one creates and the
    // SKIP_IF_EXISTS one creates only if it went first.
    assert.equal(outcomes.filter((o) => o === "created").length >= 1, true);
    assert.equal(w.documents.length <= 2, true);
    assert.equal(w.documents.length >= 1, true);
  });

  /* ================ 5. locking, keys and boundaries ==================== */

  console.log("\n5. The lock itself");

  await check("the content lock has a namespace of its own", () => {
    assert.notEqual(DOCUMENT_CONTENT_ADVISORY_NAMESPACE, ADVISORY_NAMESPACE);
    assert.equal(dupCode.includes("pg_advisory_xact_lock"), true);
    // Transaction-scoped, so it always releases.
    assert.equal(dupCode.includes("pg_advisory_lock("), false);
  });

  await check("the key folds in BOTH the tenant and the content", () => {
    assert.notEqual(documentContentLockKey(1, "a"), documentContentLockKey(2, "a"));
    assert.notEqual(documentContentLockKey(1, "a"), documentContentLockKey(1, "b"));
    assert.equal(documentContentLockKey(1, "a"), documentContentLockKey(1, "a"));
    const k = documentContentLockKey(99, "f".repeat(64));
    assert.equal(Number.isInteger(k) && k >= -(2 ** 31) && k < 2 ** 31, true, "fits int4");
  });

  await check("NO global unique index on document content was introduced", () => {
    // It would be the simplest fix and it would destroy CREATE_ANYWAY.
    const schema = readSource("prisma/schema.prisma");
    // Slice to the model's actual closing brace: a fixed length silently
    // truncates past the block attributes, which is where the answer lives.
    const start = schema.indexOf("model Document ");
    const model = schema.slice(start, schema.indexOf("\n}", start));
    assert.equal(/@@unique\(\[businessId, contentHashSha256\]\)/.test(model), false);
    assert.equal(model.includes("@@index([businessId, contentHashSha256])"), true);
  });

  await check("no migration accompanies this change", () => {
    assert.equal(fs.existsSync("prisma/migrations"), true);
    const schema = readSource("prisma/schema.prisma");
    // skipped_duplicate already existed in both channel enums.
    assert.equal(/enum EmailAttachmentImportStatus \{[^}]*skipped_duplicate/s.test(schema), true);
    assert.equal(/enum WhatsAppAttachmentImportStatus \{[^}]*skipped_duplicate/s.test(schema), true);
  });

  await check("duplicate handling triggers no approval or learning", () => {
    for (const code of [dupCode, matCode]) {
      for (const forbidden of ["financialRecord.", "reviewEvent", "billingDocument", "vendorLearn"]) {
        assert.equal(code.includes(forbidden), false, forbidden);
      }
    }
  });

  /* ============ 6. the guards must ACT, not merely be present ========== */

  console.log("\n6. Every guard is asserted to act, not just to exist");

  await check("a failed Gmail signature check actually stops the import", () => {
    // Ordering proves nothing on its own: the call can sit in the right place
    // with its verdict ignored. Assert the refusal returns, before any write.
    const verify = gmailCode.indexOf("const signature = verifyFileSignature(");
    const guard = gmailCode.indexOf("if (!signature.ok)", verify);
    const store = gmailCode.indexOf("putDocumentObject(", verify);
    assert.notEqual(guard, -1, "the verdict is checked");
    assert.equal(guard < store, true, "and checked before storage");
    const acted = gmailCode.slice(guard, guard + 300);
    assert.equal(acted.includes("return NextResponse.json"), true);
    assert.equal(acted.includes("status: 415"), true);
  });

  await check("the Gmail duplicate guard actually returns", () => {
    const guard = gmailCode.indexOf("if (existingDocument) {");
    assert.notEqual(guard, -1, "the guard exists and is not disabled");
    const body = gmailCode.slice(guard, gmailCode.indexOf("const tmp = await writeTempOcrFile("));
    assert.equal(body.includes('status: "skipped_duplicate"'), true);
    assert.equal(body.includes('skipped: "duplicate"'), true);
    assert.equal(body.includes("return NextResponse.json"), true);
  });

  await check("the WhatsApp duplicate guard actually returns", () => {
    const guard = waCode.indexOf("if (existingDocument) {");
    assert.notEqual(guard, -1, "the guard exists and is not disabled");
    const body = waCode.slice(guard, guard + 400);
    assert.equal(body.includes('status: "skipped_duplicate"'), true);
    assert.equal(body.includes('reason: "existing_document"'), true);
    assert.equal(body.includes("return"), true);
  });

  await check("the early Gmail check is a live statement, not a disabled one", () => {
    assert.equal(
      gmailCode.includes(
        "const existingDocument = await withTenantTransaction((tx) =>"
      ),
      true
    );
    // A disabled short-circuit would read `null && await ...` or `false && ...`.
    assert.equal(/existingDocument = (null|false|undefined) &&/.test(gmailCode), false);
  });

  await check("the duplicate query is scoped by business INSIDE its where clause", () => {
    // `businessId` appears all over the module; what matters is that it is a
    // predicate on this query.
    const fn = dupCode.slice(dupCode.indexOf("export async function findDuplicateDocumentTx"));
    const where = fn.slice(fn.indexOf("where: {"), fn.indexOf("orderBy:"));
    assert.equal(where.includes("businessId,"), true, "tenant is a predicate");
    assert.equal(where.includes("contentHashSha256,"), true);
    assert.equal(where.includes('status: { not: "failed" }'), true);
  });

  await check("the materializer honours the CALLER's policy, not a fixed one", () => {
    assert.equal(
      matCode.includes('if (params.duplicatePolicy === "SKIP_IF_EXISTS") {'),
      true,
      "the skip is conditional on the channel's policy"
    );
    // Hard-coding it either way would silently break one of the two callers:
    // ALLOW is what an owner-confirmed CREATE_ANYWAY relies on.
    assert.equal(/if \(true\) \{[\s\S]{0,200}findDuplicateDocumentTx/.test(matCode), false);
  });

  await check("both create paths take the content lock before creating", () => {
    const mLock = matCode.indexOf("lockDocumentContent(db,");
    const mCreate = matCode.indexOf("db.document.create(");
    assert.notEqual(mLock, -1, "materializer takes the lock");
    assert.equal(mLock < mCreate, true, "before it creates");

    const iLock = ingestCode.indexOf("lockDocumentContent(tx,");
    const iCreate = ingestCode.indexOf("tx.document.create(");
    assert.notEqual(iLock, -1, "ingestion takes the lock");
    assert.equal(iLock < iCreate, true, "before it creates");
  });

  await check("the lock is taken before the duplicate lookup it protects", () => {
    const mLock = matCode.indexOf("lockDocumentContent(db,");
    const mFind = matCode.indexOf("findDuplicateDocumentTx(", mLock);
    assert.equal(mLock < mFind, true, "materializer: lock then look");

    const iLock = ingestCode.indexOf("lockDocumentContent(tx,");
    const iFind = ingestCode.indexOf("findDuplicateDocumentTx(", iLock);
    assert.equal(iLock < iFind, true, "ingestion: lock then look");
  });

  await check("the route never invents a media type Gmail did not give", () => {
    // A fallback here would recreate the exact defect this increment removed,
    // one layer further out than the resolver.
    assert.equal(
      gmailCode.includes("const gmailMimeType = lookup.descriptor.mimeType;"),
      true
    );
    assert.equal(/gmailMimeType = [^;\n]*\|\|/.test(gmailCode), false);
  });


  console.log(`\nI-7E DOCUMENTS HARDENING VERIFY PASS — ${passed} checks green.`);
}

main().catch((error) => {
  console.error("\nFAILED:", error);
  process.exit(1);
});
