/**
 * Gmail import — attachment resolution verify (2026-11-08).
 *
 * Production: every "קלוט" returned 404 ATTACHMENT_NOT_IN_MESSAGE. Import
 * re-fetches the message and required the SAME attachment id discovery saw.
 * The fix keeps that path and adds a verified fallback (partId + filename +
 * size). This suite pins:
 *   1. resolution by id is unchanged; by partId only when name AND/OR size
 *      agree, never by position alone; ambiguity is refused;
 *   2. multiple attachments in one message, nested MIME, duplicate files,
 *      mismatched ids;
 *   3. fetchGmailAttachmentDescriptor returns the id from ITS fetch, and the
 *      route downloads with that id;
 *   4. download failure stores nothing (order: resolve → bytes → verify →
 *      OCR → store → Document); the security checks are all still in place.
 *
 *   npx tsx lib/services/integrations/gmail/gmail-attachment-resolve.verify.test.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import {
  findAttachmentPart,
  resolveAttachmentInMessage,
  type GmailMessagePart,
} from "@/lib/services/integrations/gmail/gmail-message-parts";
import { fetchGmailAttachmentDescriptor } from "@/lib/services/integrations/gmail/gmail-attachment-metadata.service";
import { fetchGmailAttachmentBytes } from "@/lib/services/integrations/gmail/gmail-attachment-fetch.service";

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed += 1;
  console.log(`OK  : ${name}`);
}

const leaf = (partId: string, attachmentId: string, filename: string, size: number, mimeType = "application/pdf"): GmailMessagePart => ({
  partId, mimeType, filename, body: { attachmentId, size },
});

/** A message: text body, two PDFs + an image at the top, a deep PDF two levels down. */
function message(ids: { a: string; b: string; img: string; deep: string }): GmailMessagePart {
  return {
    partId: "",
    mimeType: "multipart/mixed",
    parts: [
      { partId: "0", mimeType: "multipart/alternative", parts: [
        { partId: "0.0", mimeType: "text/plain", filename: "", body: { size: 120 } },
        { partId: "0.1", mimeType: "text/html", filename: "", body: { size: 400 } },
      ] },
      leaf("1", ids.a, "invoice-100.pdf", 200_000),
      leaf("2", ids.b, "receipt-7.pdf", 64_000),
      leaf("3", ids.img, "logo.png", 5_000, "image/png"),
      { partId: "4", mimeType: "multipart/related", parts: [
        { partId: "4.0", mimeType: "multipart/mixed", parts: [leaf("4.0.0", ids.deep, "statement.pdf", 90_000)] },
      ] },
    ],
  };
}
const FIRST = message({ a: "A1", b: "B1", img: "I1", deep: "D1" });   // what discovery saw
const SECOND = message({ a: "A2", b: "B2", img: "I2", deep: "D2" });  // import's fetch: every id differs

async function main() {
  // ---------------------------------------------------------------- 1. resolution
  await check("same id → matched by attachment id (unchanged path), even with a stale partId", () => {
    const r = resolveAttachmentInMessage(FIRST, { attachmentId: "B1", partId: "9", filename: "x", sizeBytes: 1 });
    assert.ok(r.ok);
    assert.equal(r.matchedBy, "attachment_id");
    assert.equal(r.attachmentId, "B1");
  });

  await check("ids changed → partId + filename + size find the right part, with the FRESH id", () => {
    const r = resolveAttachmentInMessage(SECOND, { attachmentId: "B1", partId: "2", filename: "receipt-7.pdf", sizeBytes: 64_000 });
    assert.ok(r.ok);
    assert.equal(r.matchedBy, "part_id");
    assert.equal(r.attachmentId, "B2");
    assert.equal(r.part.filename, "receipt-7.pdf");
  });

  await check("multiple attachments in one message: each resolves to its own part", () => {
    for (const [old, partId, filename, size, fresh] of [
      ["A1", "1", "invoice-100.pdf", 200_000, "A2"],
      ["B1", "2", "receipt-7.pdf", 64_000, "B2"],
      ["I1", "3", "logo.png", 5_000, "I2"],
    ] as const) {
      const r = resolveAttachmentInMessage(SECOND, { attachmentId: old, partId, filename, sizeBytes: size });
      assert.ok(r.ok, partId);
      assert.equal(r.attachmentId, fresh);
    }
  });

  await check("nested MIME: a part two multiparts deep resolves by its dotted partId", () => {
    const r = resolveAttachmentInMessage(SECOND, { attachmentId: "D1", partId: "4.0.0", filename: "statement.pdf", sizeBytes: 90_000 });
    assert.ok(r.ok);
    assert.equal(r.attachmentId, "D2");
  });

  await check("partId alone is never enough: name or size must be supplied", () => {
    assert.deepEqual(resolveAttachmentInMessage(SECOND, { attachmentId: "B1", partId: "2" }), { ok: false, reason: "part_unverifiable" });
    assert.deepEqual(resolveAttachmentInMessage(SECOND, { attachmentId: "B1", partId: "2", filename: "", sizeBytes: null }), { ok: false, reason: "part_unverifiable" });
  });

  await check("partId pointing at a different file (name or size disagree) is refused", () => {
    assert.deepEqual(resolveAttachmentInMessage(SECOND, { attachmentId: "B1", partId: "1", filename: "receipt-7.pdf", sizeBytes: 64_000 }), { ok: false, reason: "part_mismatch" });
    assert.deepEqual(resolveAttachmentInMessage(SECOND, { attachmentId: "B1", partId: "2", filename: "receipt-7.pdf", sizeBytes: 64_001 }), { ok: false, reason: "part_mismatch" });
    assert.deepEqual(resolveAttachmentInMessage(SECOND, { attachmentId: "B1", partId: "2", filename: "other.pdf", sizeBytes: 64_000 }), { ok: false, reason: "part_mismatch" });
  });

  await check("partId of a non-attachment part, an unknown partId, or none at all is refused", () => {
    assert.deepEqual(resolveAttachmentInMessage(SECOND, { attachmentId: "X", partId: "0.0", filename: "", sizeBytes: 120 }), { ok: false, reason: "part_not_found" });
    assert.deepEqual(resolveAttachmentInMessage(SECOND, { attachmentId: "X", partId: "77", filename: "a.pdf", sizeBytes: 1 }), { ok: false, reason: "part_not_found" });
    assert.deepEqual(resolveAttachmentInMessage(SECOND, { attachmentId: "X", filename: "a.pdf", sizeBytes: 1 }), { ok: false, reason: "no_part_id" });
    assert.deepEqual(resolveAttachmentInMessage(undefined, { attachmentId: "X", partId: "1", filename: "a.pdf", sizeBytes: 1 }), { ok: false, reason: "part_not_found" });
  });

  await check("a partId that repeats in a malformed message is refused (no guessing)", () => {
    const dup: GmailMessagePart = { mimeType: "multipart/mixed", parts: [leaf("1", "x1", "a.pdf", 10), leaf("1", "x2", "a.pdf", 10)] };
    assert.deepEqual(resolveAttachmentInMessage(dup, { attachmentId: "old", partId: "1", filename: "a.pdf", sizeBytes: 10 }), { ok: false, reason: "part_not_found" });
  });

  await check("duplicate files (same name and size twice): partId tells them apart", () => {
    const twins: GmailMessagePart = { mimeType: "multipart/mixed", parts: [leaf("1", "n1", "scan.pdf", 50_000), leaf("2", "n2", "scan.pdf", 50_000)] };
    const r1 = resolveAttachmentInMessage(twins, { attachmentId: "old1", partId: "1", filename: "scan.pdf", sizeBytes: 50_000 });
    const r2 = resolveAttachmentInMessage(twins, { attachmentId: "old2", partId: "2", filename: "scan.pdf", sizeBytes: 50_000 });
    assert.ok(r1.ok && r2.ok);
    assert.equal(r1.attachmentId, "n1");
    assert.equal(r2.attachmentId, "n2");
  });

  await check("findAttachmentPart itself is unchanged (duplicate ids still ambiguous → null)", () => {
    const amb: GmailMessagePart = { mimeType: "multipart/mixed", parts: [leaf("1", "dup", "a.pdf", 1), leaf("2", "dup", "b.pdf", 2)] };
    assert.equal(findAttachmentPart(amb, "dup"), null);
    assert.equal(findAttachmentPart(FIRST, "A1")?.filename, "invoice-100.pdf");
  });

  // ---------------------------------------------------------------- 3. descriptor (Gmail mocked)
  const realFetch = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = (async (url: string | URL) => {
      calls += 1;
      assert.match(String(url), /\/messages\/msg-1\?format=full$/);
      return new Response(JSON.stringify({ id: "msg-1", payload: SECOND }), { status: 200 });
    }) as typeof fetch;

    await check("descriptor: changed id → resolved by part, type/filename/size/id all from Gmail's fetch", async () => {
      const r = await fetchGmailAttachmentDescriptor({ accessToken: "t", messageId: "msg-1", attachmentId: "B1", partId: "2", filename: "receipt-7.pdf", sizeBytes: 64_000 });
      assert.ok(r.ok);
      assert.deepEqual(r.descriptor, { attachmentId: "B2", matchedBy: "part_id", mimeType: "application/pdf", filename: "receipt-7.pdf", sizeBytes: 64_000 });
    });

    await check("descriptor: old client without partId still gets the 404 reason (detail no_part_id)", async () => {
      const r = await fetchGmailAttachmentDescriptor({ accessToken: "t", messageId: "msg-1", attachmentId: "B1" });
      assert.deepEqual(r, { ok: false, reason: "ATTACHMENT_NOT_IN_MESSAGE", detail: "no_part_id" });
    });
    assert.ok(calls >= 2);

    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    await check("Gmail failure while resolving throws (route → 500), it is not reported as 'not found'", async () => {
      await assert.rejects(fetchGmailAttachmentDescriptor({ accessToken: "t", messageId: "msg-1", attachmentId: "B1", partId: "2", filename: "receipt-7.pdf", sizeBytes: 64_000 }));
    });
    await check("download failure throws (nothing is returned to store)", async () => {
      await assert.rejects(fetchGmailAttachmentBytes({ accessToken: "t", messageId: "msg-1", attachmentId: "B2" }));
    });
  } finally {
    globalThis.fetch = realFetch;
  }

  // ---------------------------------------------------------------- 4. route wiring + unchanged checks
  const strip = (s: string) => s.replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const route = strip(fs.readFileSync("app/api/integrations/gmail/import/route.ts", "utf8"));

  await check("route: partId + reported filename/size are passed to the lookup", () => {
    assert.match(route, /fetchGmailAttachmentDescriptor\(\{[\s\S]*?partId: body\.partId,[\s\S]*?filename: body\.filename,[\s\S]*?sizeBytes: body\.sizeBytes,[\s\S]*?\}\)/);
  });

  await check("route: download uses the id resolved from Gmail, not the client's", () => {
    assert.match(route, /fetchGmailAttachmentBytes\(\{[\s\S]*?attachmentId: lookup\.descriptor\.attachmentId,[\s\S]*?\}\)/);
    assert.equal(/fetchGmailAttachmentBytes\(\{[^}]*attachmentId: body\.attachmentId/.test(route), false);
  });

  await check("route: order resolve → bytes → signature → OCR → store → Document (download failure stores nothing)", () => {
    const at = (s: string) => { const i = route.indexOf(s); assert.ok(i >= 0, s); return i; };
    const order = [
      "isGmailConnectionOwnedByBusiness(",
      "getGmailAccessTokenForBusiness(",
      "fetchGmailAttachmentDescriptor(",
      "fetchGmailAttachmentBytes(",
      "verifyFileSignature(",
      "runGoogleVisionOCR(",
      "putDocumentObject(",
      "createDocumentFromOcrText(",
    ].map(at);
    for (let i = 1; i < order.length; i += 1) assert.ok(order[i - 1] < order[i], `step ${i} out of order`);
  });

  await check("route: security checks untouched (type from Gmail, allowlist, HEIC, signature, dedup, ownership)", () => {
    for (const s of [
      "const gmailMimeType = lookup.descriptor.mimeType;",
      "if (!isAllowedDocumentMime(gmailMimeType)) {",
      "isHeicMimeType(gmailMimeType)",
      "if (!signature.ok) {",
      "checkEmailImportDedup(",
      "findDuplicateDocumentTx(",
      'duplicatePolicy: "SKIP_IF_EXISTS"',
      "withinTransaction: async (tx, documentId) => {",
      "isGmailConnectionOwnedByBusiness({",
    ]) assert.ok(route.includes(s), s);
    assert.equal(route.includes("body.mimeType"), false, "the browser's type is still never read");
  });

  await check("route: the new log line carries fixed codes only", () => {
    const logs = route.match(/console\.info\([\s\S]*?\);/g) ?? [];
    assert.equal(logs.length, 1);
    assert.match(logs[0], /"GMAIL_IMPORT_LOOKUP:",\s*lookup\.ok \? lookup\.descriptor\.matchedBy : `not_found \$\{lookup\.detail\}`/);
  });

  console.log(`GMAIL ATTACHMENT RESOLVE VERIFY PASS — ${passed} checks green.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
