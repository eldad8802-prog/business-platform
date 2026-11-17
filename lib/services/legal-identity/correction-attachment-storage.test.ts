/**
 * Correction request attachments (./correction-attachment-storage.ts) with an in-memory storage double. No DB, no
 * network.   node_modules/.bin/tsx lib/services/legal-identity/correction-attachment-storage.test.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  AttachmentInputError,
  MAX_CORRECTION_ATTACHMENT_BYTES,
  prepareCorrectionAttachment,
  readCorrectionAttachment,
  storeCorrectionAttachment,
  type CorrectionAttachmentStorage,
} from "./correction-attachment-storage";

let n = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); n++; } catch (e) { console.error(`FAIL - ${name}`); throw e; }
}
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 2)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 3)]);

function memory() {
  const objects = new Map<string, { body: Buffer; contentType: string; domain: string }>();
  const storage: CorrectionAttachmentStorage = {
    async putObjectIfAbsent(input) {
      if (objects.has(input.key)) return { status: "EXISTS", key: input.key };
      objects.set(input.key, { body: input.body, contentType: input.contentType, domain: input.metadata.domain });
      return { status: "CREATED", key: input.key, metadata: { contentType: input.contentType } as never };
    },
    async getObject(key) {
      const o = objects.get(key);
      if (!o) throw new Error("missing");
      return { key, body: o.body, metadata: { contentType: o.contentType } } as never;
    },
    async deleteObject(key) { objects.delete(key); },
  };
  return { objects, storage };
}
const refuses = (code: AttachmentInputError["code"], input: Parameters<typeof prepareCorrectionAttachment>[0]) =>
  assert.throws(() => prepareCorrectionAttachment(input), (e: unknown) => e instanceof AttachmentInputError && e.code === code);

async function main() {
  await check("PDF / PNG / JPEG accepted; the key is server-built under the business and request prefix", () => {
    for (const [mime, body, ext] of [["application/pdf", PDF, "pdf"], ["image/png", PNG, "png"], ["image/jpeg", JPG, "jpg"]] as const) {
      const d = prepareCorrectionAttachment({ businessId: 12, requestId: 34, mimeType: mime, body });
      assert.match(d.storageKey, new RegExp(`^biz/12/legal-identity/34/doc-\\d+-[0-9a-f]{16}\\.${ext}$`));
      assert.equal(d.sizeBytes, body.length);
      assert.equal(d.sha256, createHash("sha256").update(body).digest("hex"));
      assert.ok(d.storageKey.length <= 300);
    }
  });
  await check("two uploads never share a key", () => {
    const a = prepareCorrectionAttachment({ businessId: 1, requestId: 2, mimeType: "application/pdf", body: PDF });
    const b = prepareCorrectionAttachment({ businessId: 1, requestId: 2, mimeType: "application/pdf", body: PDF });
    assert.notEqual(a.storageKey, b.storageKey);
  });
  await check("refused: other types (webp, html, octet), empty, over 10 MB, renamed content, bad ids", () => {
    refuses("UNSUPPORTED_TYPE", { businessId: 1, requestId: 2, mimeType: "image/webp", body: PNG });
    refuses("UNSUPPORTED_TYPE", { businessId: 1, requestId: 2, mimeType: "text/html", body: Buffer.from("<html>") });
    refuses("UNSUPPORTED_TYPE", { businessId: 1, requestId: 2, mimeType: "application/octet-stream", body: PDF });
    refuses("EMPTY", { businessId: 1, requestId: 2, mimeType: "application/pdf", body: Buffer.alloc(0) });
    refuses("TOO_LARGE", { businessId: 1, requestId: 2, mimeType: "application/pdf", body: Buffer.concat([PDF, Buffer.alloc(MAX_CORRECTION_ATTACHMENT_BYTES)]) });
    refuses("CONTENT_MISMATCH", { businessId: 1, requestId: 2, mimeType: "application/pdf", body: PNG });
    refuses("CONTENT_MISMATCH", { businessId: 1, requestId: 2, mimeType: "image/png", body: Buffer.from("not an image at all") });
    refuses("UNSUPPORTED_TYPE", { businessId: 1, requestId: 0, mimeType: "application/pdf", body: PDF });
    refuses("UNSUPPORTED_TYPE", { businessId: -1, requestId: 2, mimeType: "application/pdf", body: PDF });
  });
  await check("exactly 10 MB is accepted", () => {
    const body = Buffer.concat([PDF, Buffer.alloc(MAX_CORRECTION_ATTACHMENT_BYTES - PDF.length)]);
    assert.equal(prepareCorrectionAttachment({ businessId: 1, requestId: 2, mimeType: "application/pdf", body }).sizeBytes, MAX_CORRECTION_ATTACHMENT_BYTES);
  });
  await check("store: create-once in the private legal-identity domain, then the database records it", async () => {
    const { objects, storage } = memory();
    let recorded: { storageKey: string; sha256: string } | null = null;
    const id = await storeCorrectionAttachment({ businessId: 5, requestId: 9, mimeType: "application/pdf", body: PDF },
      { storage, attach: async (doc) => { recorded = doc; return 77; } });
    assert.equal(id, 77);
    assert.equal(objects.size, 1);
    const [key, o] = [...objects.entries()][0];
    assert.equal(o.domain, "legal-identity");
    assert.equal(recorded!.storageKey, key);
  });
  await check("store: the database refuses → the object is deleted and the DATABASE error is rethrown", async () => {
    const { objects, storage } = memory();
    const refusal = new Error("DZC08 limit");
    await assert.rejects(storeCorrectionAttachment({ businessId: 5, requestId: 9, mimeType: "image/png", body: PNG },
      { storage, attach: async () => { throw refusal; } }), (e) => e === refusal);
    assert.equal(objects.size, 0);
  });
  await check("store: a failed cleanup is reported (no key in the report) and the database error still wins", async () => {
    const { storage } = memory();
    const leaks: unknown[] = [];
    const broken: CorrectionAttachmentStorage = { ...storage, deleteObject: async () => { throw new Error("storage down biz/5/legal-identity/9/x.pdf"); } };
    const refusal = new Error("DZC09 not pending");
    await assert.rejects(storeCorrectionAttachment({ businessId: 5, requestId: 9, mimeType: "application/pdf", body: PDF },
      { storage: broken, attach: async () => { throw refusal; }, onLeak: (l) => leaks.push(l) }), (e) => e === refusal);
    assert.equal(leaks.length, 1);
    assert.ok(!JSON.stringify(leaks[0]).includes("biz/"), "the leak report carries no key or path");
  });
  await check("store: invalid content never reaches storage or the database", async () => {
    const { objects, storage } = memory();
    let attached = false;
    await assert.rejects(storeCorrectionAttachment({ businessId: 5, requestId: 9, mimeType: "application/pdf", body: PNG },
      { storage, attach: async () => { attached = true; return 1; } }), AttachmentInputError);
    assert.equal(objects.size, 0);
    assert.equal(attached, false);
  });
  await check("read: only a key under the business's own prefix", async () => {
    const { storage } = memory();
    await storeCorrectionAttachment({ businessId: 5, requestId: 9, mimeType: "application/pdf", body: PDF },
      { storage, attach: async (doc) => doc.storageKey }).then(async (key) => {
      const r = await readCorrectionAttachment({ businessId: 5, storageKey: key as string }, storage);
      assert.ok(r.body.equals(PDF));
      assert.equal(r.contentType, "application/pdf");
      await assert.rejects(readCorrectionAttachment({ businessId: 6, storageKey: key as string }, storage), AttachmentInputError);
      await assert.rejects(readCorrectionAttachment({ businessId: 5, storageKey: "biz/5/trust/x.pdf" }, storage), AttachmentInputError);
      await assert.rejects(readCorrectionAttachment({ businessId: 5, storageKey: "biz/5/legal-identity/../../6/x.pdf" }, storage));
    });
  });
  console.log(`correction-attachment-storage.test.ts: ok (${n} checks)`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
