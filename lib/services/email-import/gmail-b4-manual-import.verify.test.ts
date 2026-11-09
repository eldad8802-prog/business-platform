/**
 * Gmail B4 — manual import of possibly-relevant and low-score files, verify (2026-11-09).
 *
 * The score is the system's suggestion, not the owner's decision: a possibly-relevant (20–44) or
 * low-score (<20) file can now be imported — one at a time, only after an in-place confirmation
 * worded for its group — through the SAME import as every other file. Pins:
 *
 *   K1  the screen: "קלוט בכל זאת" only opens the confirmation; only "קלוט לבדיקה" imports;
 *       cancel imports nothing; recommended files keep their one-tap import;
 *   K2  the warning text per group is the owner's wording, in Hebrew and English;
 *   K3  bulk import stays recommended-only;
 *   K4  one import path: the unchanged importOne → /api/integrations/gmail/import, with the same
 *       request (no score, group or "override" field the server could be asked to trust);
 *   K5  no double import: a repeated tap while a request is in flight sends nothing;
 *   K6  the server keeps every check (session business, account ownership, Gmail type, allowlist,
 *       HEIC, size, byte signature, duplicate, review-queue Document) and knows nothing of scores;
 *   K7  unsupported types never reach the screen (discovery's allowlist), so none can be offered;
 *   K8  a new scan closes any open confirmation.
 *
 *   npx tsx lib/services/email-import/gmail-b4-manual-import.verify.test.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { documentsHe } from "@/lib/i18n/messages/areas/documents";
import { documentsEn } from "@/lib/i18n/messages/areas/documents.en";
import { confirmImportText } from "@/components/documents/email/GmailScanParts";
import { classifyAttachmentParts } from "@/lib/services/integrations/gmail/gmail-discovery.service";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`OK  : ${name}`);
}
const read = (p: string) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const page = read("app/(shell)/documents/email/page.tsx");
const parts = read("components/documents/email/GmailScanParts.tsx");
const route = read("app/api/integrations/gmail/import/route.ts");
const he = (documentsHe as unknown as { email: Record<string, string> }).email;
const en = (documentsEn as unknown as { email: Record<string, string> }).email;

check("K1 card: recommended imports in one tap; the others only open their confirmation; only the confirmation imports", () => {
  const card = parts.slice(parts.indexOf("export function AttachmentCard"));
  assert.match(card, /const needsConfirm = attachment\.bucket !== "recommended";/);
  // Recommended: the existing direct button.
  assert.match(card, /if \(pending && !needsConfirm\) \{\n\s+action = \(\n\s+<button type="button" className="dz-email-card-import" disabled=\{importDisabled\} onClick=\{onImport\}/);
  // Others: "קלוט בכל זאת" → onAskConfirm (never onImport).
  assert.match(card, /className="dz-email-card-import-anyway" disabled=\{importDisabled\} onClick=\{onAskConfirm\}/);
  assert.match(card, /\{t\("documents\.email\.importAnyway"\)\}/);
  // The confirmation: "קלוט לבדיקה" → onImport, "ביטול" → onCancelConfirm.
  assert.match(card, /<ConfirmImportPanel t=\{t\} bucket=\{attachment\.bucket\} disabled=\{importDisabled\} onConfirm=\{onImport\} onCancel=\{onCancelConfirm\} \/>/);
  const panel = parts.slice(parts.indexOf("export function ConfirmImportPanel"), parts.indexOf("export function AttachmentCard"));
  assert.match(panel, /className="dz-email-confirm-one-yes" disabled=\{disabled\} onClick=\{onConfirm\}/);
  assert.match(panel, /className="dz-email-confirm-one-no" onClick=\{onCancel\}/);
  assert.match(panel, /\{t\("documents\.email\.importForReview"\)\}/);
});

check("K1 page: the card and the desktop table wire 'קלוט בכל זאת' to the confirmation only", () => {
  assert.match(page, /const confirmFirst = attachment\.bucket !== "recommended";/);
  assert.match(page, /onImport=\{\(\) => \(confirmFirst \? importConfirmed\(attachment\) : void importOne\(attachment\)\)\}/);
  assert.match(page, /onAskConfirm=\{\(\) => setConfirmKey\(attachment\.key\)\}/);
  assert.match(page, /onCancelConfirm=\{\(\) => setConfirmKey\(null\)\}/);
  // Desktop: the button sets the open confirmation; the confirmation row imports.
  assert.match(page, /className="dz-email-card-import-anyway"\n\s+disabled=\{importing\}\n\s+onClick=\{\(\) => setConfirmKey\(attachment\.key\)\}/);
  assert.match(page, /onConfirm=\{\(\) => importConfirmed\(attachment\)\}\n\s+onCancel=\{\(\) => setConfirmKey\(null\)\}/);
  // importConfirmed closes the confirmation and runs the ordinary import.
  assert.match(page, /const importConfirmed = \(attachment: ScoredAttachment\) => \{\n\s+setConfirmKey\(null\);\n\s+void importOne\(attachment\);\n\s+\};/);
});

check("K2 the warning per group is the owner's wording (Hebrew + English)", () => {
  assert.equal(he.confirmPossible, "המערכת לא זיהתה בוודאות שהקובץ הוא מסמך פיננסי. האם לקלוט אותו לבדיקה?");
  assert.equal(he.confirmLowScore, "המערכת מעריכה שהקובץ כנראה אינו מסמך פיננסי. אם אתה מזהה אותו כמסמך שקשור לעסק, אפשר לקלוט אותו לבדיקה.");
  assert.equal(he.importAnyway, "קלוט בכל זאת");
  assert.equal(he.importForReview, "קלוט לבדיקה");
  assert.equal(he.confirmImportNo, "ביטול");
  for (const k of ["confirmPossible", "confirmLowScore", "importAnyway", "importForReview", "groupPossibleNote", "groupLowNote"]) assert.ok(en[k], `en ${k}`);
  const tHe = ((key: string) => he[key.split(".").pop() as string]) as never;
  assert.equal(confirmImportText(tHe, "possible"), he.confirmPossible);
  assert.equal(confirmImportText(tHe, "hidden"), he.confirmLowScore);
  assert.equal("groupReadOnly" in he, false, "the old 'next stage' note is gone");
});

check("K3 bulk import stays recommended-only", () => {
  assert.match(page, /const importable = useMemo\(\n\s+\(\) => recommended\.filter\(\(a\) => \(statusByKey\[a\.key\] \|\| "pending"\) === "pending"\),/);
  assert.match(page, /async function importAllRecommended\(\) \{\n\s+const queue = importable\.slice\(\);/);
  assert.equal((page.match(/void importAllRecommended\(\)/g) ?? []).length, 1);
});

check("K4 one import path, the same request", () => {
  assert.equal((page.match(/fetch\("\/api\/integrations\/gmail\/import"/g) ?? []).length, 1, "a single import call site");
  const body = page.slice(page.indexOf('fetch("/api/integrations/gmail/import"'), page.indexOf("const data = await response.json().catch(() => ({}));"));
  for (const k of ["messageId", "attachmentId", "filename", "mimeType", "sizeBytes", "fromEmail", "subject", "sentAt"]) assert.match(body, new RegExp(`${k}: attachment\\.${k},`), k);
  assert.match(body, /partId: attachment\.partId \?\? null,/);
  assert.equal(/bucket|score|override|force|confirm/i.test(body), false, "nothing the server could be asked to trust");
});

check("K5 a repeated tap never sends a second request", () => {
  assert.match(page, /const inFlightRef = useRef<Set<string>>\(new Set\(\)\);/);
  const fn = page.slice(page.indexOf("async function importOne"), page.indexOf("async function importAllRecommended"));
  assert.match(fn, /if \(inFlightRef\.current\.has\(attachment\.key\)\) return false;\n\s+inFlightRef\.current\.add\(attachment\.key\);/);
  assert.match(fn, /\} finally \{\n\s+inFlightRef\.current\.delete\(attachment\.key\);\n\s+\}/);
  // The button disappears once the row leaves "pending".
  assert.match(page, /importDisabled=\{importing \|\| status !== "pending"\}/);
});

check("K6 the server keeps every check and knows nothing of scores", () => {
  for (const needle of [
    "await getCurrentUser(req)",
    "runWithTenantContext({ businessId: user.businessId }",
    "isGmailConnectionOwnedByBusiness({",
    "if (isHeicMimeType(gmailMimeType))",
    "if (!isAllowedDocumentMime(gmailMimeType))",
    "body.sizeBytes > MAX_ATTACHMENT_BYTES",
    "effectiveSize > MAX_ATTACHMENT_BYTES",
    "verifyFileSignature(Buffer.from(bytes), gmailMimeType)",
    "findDuplicateDocumentTx(tx, user.businessId, contentHashSha256)",
    'duplicatePolicy: "SKIP_IF_EXISTS"',
  ]) {
    assert.ok(route.includes(needle), needle);
  }
  assert.match(route, /needs_review/);
  assert.equal(/\bbucket\b|\bscore\b|override|importAnyway/i.test(route), false, "no score/group/override in the import route");
});

check("K7 unsupported types never reach the screen, so none can be offered for import", () => {
  const r = classifyAttachmentParts(
    [
      { partId: "1", mimeType: "application/zip", filename: "invoices.zip", body: { attachmentId: "z", size: 90_000 } },
      { partId: "2", mimeType: "application/octet-stream", filename: "invoice.pdf", body: { attachmentId: "o", size: 90_000 } },
      { partId: "3", mimeType: "text/calendar", filename: "invite.ics", body: { attachmentId: "c", size: 2_000 } },
      { partId: "4", mimeType: "image/png", filename: "logo.png", body: { attachmentId: "l", size: 4_000 } },
    ],
    { messageId: "m", fromEmail: null, subject: null, sentAt: null }
  );
  assert.deepEqual(r.attachments.map((a) => a.filename), ["logo.png"], "only allowlisted types are offered (a low-score PNG may be)");
  assert.equal(r.unsupportedType, 3);
});

check("K8 a new scan closes any open confirmation", () => {
  const fn = page.slice(page.indexOf("async function requestScanPage"), page.indexOf("function onScanPress"));
  assert.match(fn, /setLowOpen\(false\);\n\s+setConfirmKey\(null\);/);
});

console.log(`GMAIL B4 MANUAL IMPORT VERIFY PASS — ${passed} checks green.`);
