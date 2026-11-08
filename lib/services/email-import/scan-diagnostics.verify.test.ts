/**
 * Gmail scan diagnostics — verify (2026-11-08).
 *
 * Pins:
 *  1. classifyAttachmentParts keeps EXACTLY what the pre-diagnostics discovery
 *     loop kept (verbatim copy below), over every combination of part shapes.
 *  2. The counters partition what the scan saw:
 *     attachmentParts = unsupportedType + hidden + possible + recommended.
 *  3. Buckets equal the unchanged screen scoring; scoring results are pinned.
 *  4. Outcome mapping (no messages / no attachments / all filtered / visible).
 *  5. Logs carry numbers and fixed codes only.
 *
 *   npx tsx lib/services/email-import/scan-diagnostics.verify.test.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { classifyAttachmentParts, type GmailAttachmentMetadata } from "@/lib/services/integrations/gmail/gmail-discovery.service";
import { collectAttachmentParts, type GmailMessagePart } from "@/lib/services/integrations/gmail/gmail-message-parts";
import { isAllowedDocumentMime } from "@/lib/services/documents/document-ingestion.service";
import { scoreAttachment, scoreAttachments } from "@/lib/services/email-import/scoring";
import { gmailScanOutcome, summarizeGmailScan } from "@/lib/services/email-import/scan-diagnostics";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
}

// ---------------------------------------------------------------- 1. legacy equivalence
// Verbatim body of the discovery inner loop as on main @ b5cb1bcb (before this change).
function legacyLoop(
  parts: GmailMessagePart[],
  messageId: string,
  fromEmail: string | null,
  subject: string | null,
  sentAt: string | null
): GmailAttachmentMetadata[] {
  const attachments: GmailAttachmentMetadata[] = [];
  for (const p of parts) {
    const attachmentId = p.body?.attachmentId;
    if (!attachmentId) continue;

    const mimeType = String(p.mimeType || "application/octet-stream");
    const filename = p.filename ? String(p.filename) : null;
    const sizeBytes = typeof p.body?.size === "number" ? p.body.size : null;

    if (!isAllowedDocumentMime(mimeType)) continue;

    attachments.push({
      messageId,
      attachmentId,
      filename,
      mimeType,
      sizeBytes,
      fromEmail,
      subject,
      sentAt,
    });
  }
  return attachments;
}

const MIMES = [
  "application/pdf", "APPLICATION/PDF", "image/jpeg", "image/jpg", "image/png", "image/webp",
  "image/gif", "image/heic", "application/octet-stream", "text/plain", "application/zip", "", undefined,
];
const NAMES = ["invoice.pdf", "קבלה.pdf", "logo.png", "", undefined];
const SIZES = [undefined, 0, 5_000, 40_000, 200_000, 9_000_000, 16_000_000];
const IDS = ["att-1", "", undefined];

let fixtureCount = 0;
let n = 0;
for (const mimeType of MIMES) for (const filename of NAMES) for (const size of SIZES) for (const attachmentId of IDS) {
  n += 1;
  const leaf: GmailMessagePart = {
    mimeType: mimeType as string,
    filename: filename as string,
    body: { attachmentId: attachmentId ? `${attachmentId}-${n}` : (attachmentId as string), size: size as number },
  } as GmailMessagePart;
  // A realistic tree: multipart/mixed { text/plain, the leaf, a nested multipart with a PDF }.
  const payload = {
    mimeType: "multipart/mixed",
    parts: [
      { mimeType: "text/plain", filename: "", body: { size: 10 } },
      leaf,
      { mimeType: "multipart/related", parts: [{ mimeType: "application/pdf", filename: "nested.pdf", body: { attachmentId: `nested-${n}`, size: 50_000 } }] },
    ],
  } as unknown as GmailMessagePart;
  const parts = collectAttachmentParts(payload);
  const meta = { messageId: `m-${n}`, fromEmail: n % 2 ? "a@b.example" : null, subject: n % 3 ? "Invoice" : null, sentAt: null };
  const legacy = legacyLoop(parts, meta.messageId, meta.fromEmail, meta.subject, meta.sentAt);
  const now = classifyAttachmentParts(parts, meta);
  assert.deepEqual(now.attachments, legacy, `fixture ${n}: kept set differs`);
  const withId = parts.filter((p) => p.body?.attachmentId).length;
  assert.equal(now.attachmentParts, withId, `fixture ${n}: attachmentParts`);
  assert.equal(now.attachments.length, now.attachmentParts - now.unsupportedType, `fixture ${n}: kept = parts - unsupported`);
  fixtureCount += 1;
}
check(`legacy equivalence over ${fixtureCount} message shapes`, () => assert.ok(fixtureCount > 1000));

// ---------------------------------------------------------------- 2+3. partition + buckets
const SAMPLE = [
  { messageId: "m1", attachmentId: "a1", filename: "invoice-100.pdf", mimeType: "application/pdf", sizeBytes: 200_000, fromEmail: "x@v.example", subject: "Your invoice", sentAt: null },
  { messageId: "m2", attachmentId: "a2", filename: "scan.pdf", mimeType: "application/pdf", sizeBytes: 500_000, fromEmail: null, subject: "Scan", sentAt: null },
  { messageId: "m3", attachmentId: "a3", filename: "INV-1234.pdf", mimeType: "application/pdf", sizeBytes: 40_000, fromEmail: null, subject: "Monthly statement", sentAt: null },
  { messageId: "m4", attachmentId: "a4", filename: "photo.jpg", mimeType: "image/jpeg", sizeBytes: 2_000_000, fromEmail: null, subject: "Photo", sentAt: null },
  { messageId: "m5", attachmentId: "a5", filename: "logo.png", mimeType: "image/png", sizeBytes: 5_000, fromEmail: null, subject: "Newsletter", sentAt: null },
  { messageId: "m6", attachmentId: "a6", filename: "tiny.pdf", mimeType: "application/pdf", sizeBytes: 15_000, fromEmail: null, subject: "Doc", sentAt: null },
];

check("scoring pinned (scoring.ts unchanged): 65, 50, 35, 35, -25, 15", () => {
  assert.deepEqual(SAMPLE.map((a) => scoreAttachment(a).score), [65, 50, 35, 35, -25, 15]);
  assert.deepEqual(SAMPLE.map((a) => scoreAttachment(a).bucket), ["recommended", "recommended", "possible", "possible", "hidden", "hidden"]);
});

check("summary buckets equal screen scoring and partition the parts", () => {
  const d = summarizeGmailScan({ scannedMessages: 6, attachmentParts: 9, unsupportedType: 3, attachments: SAMPLE });
  assert.deepEqual(d, { scannedMessages: 6, attachmentParts: 9, unsupportedType: 3, hidden: 2, possible: 2, recommended: 2 });
  assert.equal(d.attachmentParts, d.unsupportedType + d.hidden + d.possible + d.recommended);
  const visible = scoreAttachments(SAMPLE).filter((a) => a.bucket !== "hidden").length;
  assert.equal(visible, d.possible + d.recommended);
});

// ---------------------------------------------------------------- 4. outcome
check("outcome mapping", () => {
  const base = { scannedMessages: 0, attachmentParts: 0, unsupportedType: 0, hidden: 0, possible: 0, recommended: 0 };
  assert.equal(gmailScanOutcome(base), "no_messages");
  assert.equal(gmailScanOutcome({ ...base, scannedMessages: 7 }), "no_attachments");
  assert.equal(gmailScanOutcome({ ...base, scannedMessages: 7, attachmentParts: 5, unsupportedType: 3, hidden: 2 }), "all_filtered");
  assert.equal(gmailScanOutcome({ ...base, scannedMessages: 7, attachmentParts: 1, possible: 1 }), "has_visible");
});

// ---------------------------------------------------------------- 5. log safety
const read = (p: string) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
check("sync log = summarizeGmailScan only (six numbers, no strings)", () => {
  const d = summarizeGmailScan({ scannedMessages: 1, attachmentParts: 1, unsupportedType: 0, attachments: [SAMPLE[0]] });
  assert.deepEqual(Object.keys(d).sort(), ["attachmentParts", "hidden", "possible", "recommended", "scannedMessages", "unsupportedType"]);
  assert.ok(Object.values(d).every((v) => typeof v === "number"));
  const sync = read("app/api/integrations/gmail/sync/route.ts");
  const logs = sync.match(/console\.info\([\s\S]*?\);/g) ?? [];
  assert.equal(logs.length, 1);
  assert.match(logs[0], /JSON\.stringify\(summarizeGmailScan\(summary\)\)/);
});

check("callback logs carry a fixed code and a fixed detail only", () => {
  const cb = read("app/api/integrations/gmail/callback/route.ts");
  const logs = cb.match(/console\.info\([^)]*\)/g) ?? [];
  assert.deepEqual(logs, [
    'console.info("GMAIL_CALLBACK_RESULT:", "connected")',
    'console.info("GMAIL_CALLBACK_RESULT:", code, detail ?? "")',
  ]);
  const allLogCalls = cb.match(/console\.(info|warn|error|log)\([^;]*\);/g) ?? [];
  assert.ok(allLogCalls.length >= 4);
  assert.equal(allLogCalls.some((l) => /errorParam|userInfo|tokens|state\)|code\b(?!,)/.test(l.replace(/GMAIL_CALLBACK_RESULT:", code, detail/, ""))), false, "no request/user value in any callback log");
});

console.log(`GMAIL SCAN DIAGNOSTICS VERIFY PASS — ${passed} checks green (${fixtureCount} legacy-equivalence shapes).`);
