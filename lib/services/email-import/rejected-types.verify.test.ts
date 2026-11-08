/**
 * Gmail scan — refused-by-type breakdown, verify (2026-11-08 B1).
 *
 * Pins:
 *  1. Grouping table, including names built to mislead (".pdf.exe", ".pdf.zip").
 *  2. The breakdown partitions unsupportedType exactly, over every part shape.
 *  3. Counting never changes what the scan keeps: the kept set is still the
 *     Documents allowlist alone, and a PDF-named file Gmail did not declare as
 *     PDF is still NOT offered (only counted).
 *  4. Untrusted counts are normalised to the six fixed keys (unknown keys and
 *     bad numbers never pass through).
 *  5. Logs: the sync route still has one log call, carrying the scan summary
 *     and the normalised counts — numbers under fixed keys only.
 *  6. Scan query, message limits, scoring and import are untouched; the module
 *     is pure (no imports); every group has a Hebrew and an English label.
 *
 *   npx tsx lib/services/email-import/rejected-types.verify.test.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { classifyAttachmentParts } from "@/lib/services/integrations/gmail/gmail-discovery.service";
import { collectAttachmentParts, type GmailMessagePart } from "@/lib/services/integrations/gmail/gmail-message-parts";
import { isAllowedDocumentMime } from "@/lib/services/documents/document-ingestion.service";
import {
  REJECTED_TYPE_GROUPS,
  emptyRejectedTypeCounts,
  parseRejectedTypeCounts,
  rejectedTypeGroup,
} from "@/lib/services/email-import/rejected-types";
import { documentsHe } from "@/lib/i18n/messages/areas/documents";
import { documentsEn } from "@/lib/i18n/messages/areas/documents.en";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`OK  : ${name}`);
}
const read = (p: string) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

// ---------------------------------------------------------------- 1. grouping
check("grouping table", () => {
  const cases: Array<[string | undefined, string | undefined, string]> = [
    ["application/octet-stream", "invoice.pdf", "pdf_mislabeled"],
    ["application/octet-stream", "INVOICE.PDF", "pdf_mislabeled"],
    ["application/x-pdf", "doc", "pdf_mislabeled"],
    ["binary/octet-stream", "קבלה 12.pdf", "pdf_mislabeled"],
    ["application/octet-stream", "report.pdf.exe", "other"],
    ["application/zip", "invoice.pdf.zip", "zip"],
    ["application/msword", "a.doc", "office"],
    ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "", "office"],
    ["application/octet-stream", "Report.XLSX", "office"],
    ["application/vnd.oasis.opendocument.text", undefined, "office"],
    ["application/x-zip-compressed", "files", "zip"],
    ["application/octet-stream", "backup.rar", "zip"],
    ["text/calendar; method=REQUEST", "invite.ics", "calendar"],
    ["application/ics", "", "calendar"],
    ["image/heic", "IMG_1.HEIC", "image_other"],
    ["image/webp", "", "image_other"],
    ["application/octet-stream", "scan.tiff", "image_other"],
    ["text/plain", "notes.txt", "other"],
    ["", "", "other"],
    [undefined, undefined, "other"],
    ["application/octet-stream", ".pdf", "other"],
    ["application/octet-stream", "pdf", "other"],
    ["application/octet-stream", "file.pdfx", "other"],
    ["application/octet-stream", "notpdf", "other"],
  ];
  for (const [mime, name, expected] of cases) {
    assert.equal(rejectedTypeGroup(mime, name), expected, `${mime} / ${name}`);
  }
});

// ---------------------------------------------------------------- 2+3. partition, kept set unchanged
const MIMES = [
  "application/pdf", "image/jpeg", "image/png", "image/heic", "image/webp", "application/octet-stream",
  "application/zip", "text/calendar", "application/msword", "text/plain", "", undefined,
];
const NAMES = ["invoice.pdf", "a.docx", "x.zip", "i.ics", "p.heic", "logo.png", "", undefined];
let shapes = 0;
check("breakdown partitions unsupportedType; kept set = allowlist alone", () => {
  let n = 0;
  for (const a of MIMES) for (const b of MIMES) for (const na of NAMES) for (const nb of NAMES) {
    n += 1;
    const payload = {
      mimeType: "multipart/mixed",
      parts: [
        { partId: "0", mimeType: "text/plain", filename: "", body: { size: 10 } },
        { partId: "1", mimeType: a, filename: na, body: { attachmentId: `a-${n}`, size: 1000 } },
        { mimeType: "multipart/related", parts: [{ partId: "2.1", mimeType: b, filename: nb, body: { attachmentId: `b-${n}`, size: 2000 } }] },
      ],
    } as unknown as GmailMessagePart;
    const parts = collectAttachmentParts(payload);
    const r = classifyAttachmentParts(parts, { messageId: `m-${n}`, fromEmail: null, subject: null, sentAt: null });
    const sum = REJECTED_TYPE_GROUPS.reduce((s, g) => s + r.rejectedByType[g], 0);
    assert.equal(sum, r.unsupportedType, `shape ${n}: groups sum to unsupportedType`);
    const expectedKept = parts
      .filter((p) => p.body?.attachmentId && isAllowedDocumentMime(String(p.mimeType || "application/octet-stream")))
      .map((p) => p.body?.attachmentId);
    assert.deepEqual(r.attachments.map((x) => x.attachmentId), expectedKept, `shape ${n}: kept set`);
    shapes += 1;
  }
  assert.ok(shapes > 5000);
});

check("a PDF-named file Gmail did not declare as PDF is counted, NOT offered", () => {
  const parts = [{ partId: "1", mimeType: "application/octet-stream", filename: "invoice.pdf", body: { attachmentId: "x", size: 90_000 } }];
  const r = classifyAttachmentParts(parts, { messageId: "m", fromEmail: null, subject: null, sentAt: null });
  assert.equal(r.attachments.length, 0);
  assert.equal(r.unsupportedType, 1);
  assert.deepEqual(r.rejectedByType, { ...emptyRejectedTypeCounts(), pdf_mislabeled: 1 });
});

check("the allowlist is still the only keep/drop gate in discovery", () => {
  const src = read("lib/services/integrations/gmail/gmail-discovery.service.ts");
  const fn = src.slice(src.indexOf("export function classifyAttachmentParts"), src.indexOf("export async function discoverGmailAttachments"));
  assert.equal((fn.match(/continue;/g) ?? []).length, 2, "only the no-id skip and the allowlist refusal skip a part");
  assert.match(fn, /if \(!isAllowedDocumentMime\(mimeType\)\) \{\n\s+unsupportedType \+= 1;\n\s+rejectedByType\[rejectedTypeGroup\(p\.mimeType, filename\)\] \+= 1;\n\s+continue;/);
  assert.equal(/rejectedTypeGroup\(/.test(fn.replace(/rejectedByType\[rejectedTypeGroup\(p\.mimeType, filename\)\] \+= 1;/, "")), false, "grouping used for counting only");
});

// ---------------------------------------------------------------- 4. untrusted counts
check("parseRejectedTypeCounts: six fixed keys, bad input refused", () => {
  assert.equal(parseRejectedTypeCounts(undefined), null);
  assert.equal(parseRejectedTypeCounts(null), null);
  assert.equal(parseRejectedTypeCounts([1, 2]), null);
  assert.equal(parseRejectedTypeCounts("3"), null);
  assert.equal(parseRejectedTypeCounts({ office: -1 }), null);
  assert.equal(parseRejectedTypeCounts({ office: 1.5 }), null);
  assert.equal(parseRejectedTypeCounts({ office: "2" }), null);
  const parsed = parseRejectedTypeCounts({ office: 2, zip: 1, "invoice-100.pdf": 1, "owner@example.com": 3 });
  assert.deepEqual(parsed, { ...emptyRejectedTypeCounts(), office: 2, zip: 1 });
  assert.deepEqual(Object.keys(parsed!), [...REJECTED_TYPE_GROUPS]);
  const json = JSON.stringify(parsed);
  assert.equal(/invoice|@/.test(json), false);
});

// ---------------------------------------------------------------- 5. logs
check("sync route: one log call — scan summary + normalised counts only", () => {
  const sync = read("app/api/integrations/gmail/sync/route.ts");
  const logs = sync.match(/console\.info\([\s\S]*?\);/g) ?? [];
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^console\.info\(\n\s+"GMAIL_SYNC_RESULT:",\n\s+JSON\.stringify\(summarizeGmailScan\(summary\)\),\n\s+JSON\.stringify\(rejectedByType\)\n\s+\);$/);
  assert.match(sync, /const rejectedByType = parseRejectedTypeCounts\(summary\.rejectedByType\);/);
  // The response carries the same normalised object, not the raw one.
  assert.match(sync, /\n\s+rejectedByType,\n\s+attachments: summary\.attachments,/);
});

// ---------------------------------------------------------------- 6. untouched surfaces, purity, labels
check("scan query, message limits, scoring and import untouched by this change", () => {
  const disc = read("lib/services/integrations/gmail/gmail-discovery.service.ts");
  assert.ok(disc.includes('const q = params.query || "has:attachment newer_than:30d";'));
  assert.ok(disc.includes("const maxMessages = Math.min(Math.max(params.maxMessages ?? 30, 1), 100);"));
  for (const p of ["lib/services/email-import/scoring.ts", "app/api/integrations/gmail/import/route.ts", "app/api/integrations/gmail/connect/route.ts"]) {
    assert.equal(read(p).includes("rejected-types"), false, `${p} does not use the breakdown`);
  }
});

check("rejected-types module is pure (no imports, no I/O)", () => {
  const src = read("lib/services/email-import/rejected-types.ts");
  assert.equal(/^\s*import\s/m.test(src), false);
  assert.equal(/fetch\(|require\(|process\.|console\./.test(src), false);
});

check("every group has a Hebrew and an English label; screen shows non-zero groups only", () => {
  const he = (documentsHe as unknown as { email: Record<string, string> }).email;
  const en = (documentsEn as unknown as { email: Record<string, string> }).email;
  for (const g of REJECTED_TYPE_GROUPS) {
    assert.ok(he[`rejected_${g}`], `he ${g}`);
    assert.ok(en[`rejected_${g}`], `en ${g}`);
  }
  assert.ok(he.scanRejectedTypes.includes("{groups}") && en.scanRejectedTypes.includes("{groups}"));
  const page = read("app/(shell)/documents/email/page.tsx");
  assert.match(page, /scanDiag\.unsupportedType > 0 && rejectedByType \?/);
  assert.match(page, /REJECTED_TYPE_GROUPS\.filter\(\(group\) => rejectedByType\[group\] > 0\)/);
  assert.match(page, /setRejectedByType\(parseRejectedTypeCounts\(data\.rejectedByType\)\);/);
});

console.log(`GMAIL REJECTED TYPES VERIFY PASS — ${passed} checks green (${shapes} part shapes).`);
