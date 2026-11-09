/**
 * Gmail extended scan screen — B3-b verify (2026-11-09).
 *
 * Pins (pure logic + the page's wiring; the browser checks are in
 * scripts/qa/documents/gmail-extended-scan-qa.mjs):
 *   P. parsing untrusted /scan answers — every shape, nothing unknown passes;
 *   M. merging pages by the stable key — no duplicate, ever, across retries and repeats;
 *   S. the scan state — results kept on every error, honest completion, the next request;
 *   A. what is allowed when — nothing that changes the list during an import;
 *   N. sender display name, date and reason helpers;
 *   W. the page: manual scan only, recommended-only bulk import behind a confirmation,
 *      import unchanged, the phone bar above the shell navigation.
 *
 *   npx tsx lib/services/email-import/extended-scan-state.verify.test.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { gmailAttachmentKey } from "@/lib/services/email-import/attachment-key";
import { parseScanAnswer, parseScanAttachment, type ScanAnswer } from "@/lib/services/email-import/scan-response";
import {
  CONFIRM_CLEAR_ABOVE,
  applyBasicScan,
  applyNetworkFailure,
  applyScanAnswer,
  initialScanState,
  isScanFinished,
  mergeAttachments,
  needsClearConfirmation,
  resultsAreStale,
  scanActions,
  startScan,
  type ExtendedScanState,
} from "@/lib/services/email-import/extended-scan-state";
import { scoreAttachments, type GmailDiscoveryAttachment } from "@/lib/services/email-import/scoring";
import { extractDisplayName } from "@/lib/services/integrations/gmail/gmail-discovery.service";
import { displayDate, fileTypeLabel, scoreReasonText } from "@/components/documents/email/GmailScanParts";
import { documentsHe } from "@/lib/i18n/messages/areas/documents";
import { documentsEn } from "@/lib/i18n/messages/areas/documents.en";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`OK  : ${name}`);
}
const read = (p: string) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const att = (messageId: string, partId: string | null, attachmentId = `a-${messageId}-${partId}`, extra: Partial<GmailDiscoveryAttachment> = {}): GmailDiscoveryAttachment => ({
  messageId,
  attachmentId,
  partId,
  filename: `${messageId}-${partId}.pdf`,
  mimeType: "application/pdf",
  sizeBytes: 200_000,
  fromEmail: "billing@vendor.example",
  fromName: "Vendor",
  subject: "Invoice",
  sentAt: "2026-11-01T09:00:00.000Z",
  ...extra,
});

const page = (over: Record<string, unknown> = {}) => ({
  success: true,
  status: "complete",
  window: 90,
  pageComplete: true,
  scannedMessages: 25,
  scannedTotal: 25,
  failedMessages: 0,
  capReached: false,
  hasMore: true,
  nextCursor: "gsc1.NEXT",
  retryCursor: null,
  foundAttachments: 2,
  attachmentParts: 3,
  unsupportedType: 1,
  rejectedByType: { pdf_mislabeled: 0, office: 0, zip: 1, calendar: 0, image_other: 0, other: 0 },
  attachments: [att("m1", "1"), att("m2", "root")],
  ...over,
});

// ================================================================ P. parsing
check("P1 a complete page with more to come", () => {
  const a = parseScanAnswer(200, page());
  assert.equal(a.kind, "page");
  if (a.kind !== "page") return;
  assert.equal(a.status, "complete");
  assert.equal(a.nextCursor, "gsc1.NEXT");
  assert.equal(a.retryCursor, null);
  assert.equal(a.hasMore, true);
  assert.equal(a.attachments.length, 2);
  assert.equal(a.attachments[1].partId, "root");
  assert.equal(a.attachments[0].fromName, "Vendor");
  assert.deepEqual(a.rejectedByType, { pdf_mislabeled: 0, office: 0, zip: 1, calendar: 0, image_other: 0, other: 0 });
});

check("P2 a partial page: no next cursor, a retry cursor, 'more' forced true", () => {
  const a = parseScanAnswer(200, page({ success: false, status: "incomplete", pageComplete: false, nextCursor: "gsc1.SNEAKY", retryCursor: "gsc1.SAME", hasMore: false }));
  assert.ok(a.kind === "page" && a.status === "incomplete");
  if (a.kind !== "page") return;
  assert.equal(a.nextCursor, null, "a partial page can never advance");
  assert.equal(a.retryCursor, "gsc1.SAME");
  assert.equal(a.hasMore, true, "a partial page never claims there is nothing more");
  const s = parseScanAnswer(200, page({ success: false, status: "stopped_unfinished", pageComplete: false, retryCursor: "gsc1.X" }));
  assert.ok(s.kind === "page" && s.status === "stopped_unfinished" && s.retryCursor === null && s.nextCursor === null);
});

check("P3 every refusal shape", () => {
  assert.deepEqual(parseScanAnswer(429, { code: "scan_budget_exhausted", retryCursor: "gsc1.R", error: "x" }), { kind: "budget", retryAfterSeconds: 60, retryCursor: "gsc1.R", message: "x" });
  assert.deepEqual(parseScanAnswer(429, { code: "rate_limited", retryAfterSeconds: 17.2 }), { kind: "budget", retryAfterSeconds: 18, retryCursor: null, message: null });
  assert.deepEqual(parseScanAnswer(503, { code: "scan_unavailable", retryCursor: "gsc1.U" }), { kind: "unavailable", retryCursor: "gsc1.U", message: null });
  assert.deepEqual(parseScanAnswer(400, { code: "scan_cursor_invalid" }), { kind: "cursor_invalid", message: null });
  assert.equal(parseScanAnswer(409, { needsReconnect: true }).kind, "reconnect");
  assert.deepEqual(parseScanAnswer(503, { code: "gmail_throttled", status: "incomplete", retryCursor: "gsc1.T" }), { kind: "list_failed", status: "incomplete", retryCursor: "gsc1.T", message: null });
  assert.deepEqual(parseScanAnswer(502, { code: "gmail_unavailable", status: "stopped_unfinished", retryCursor: "gsc1.T" }), { kind: "list_failed", status: "stopped_unfinished", retryCursor: null, message: null });
});

check("P4 garbage never becomes a page", () => {
  for (const [s, b] of [[200, null], [200, "x"], [200, []], [200, { attachments: [] }], [500, page()], [200, { ...page(), status: "weird", pageComplete: undefined }], [404, {}]] as const) {
    const a = parseScanAnswer(s, b);
    assert.equal(a.kind, "error", `${s} ${JSON.stringify(b)?.slice(0, 40)}`);
  }
  // Oversized / empty cursors are dropped.
  const a = parseScanAnswer(200, page({ nextCursor: "x".repeat(5000) }));
  assert.ok(a.kind === "page" && a.nextCursor === null);
});

check("P5 attachments: incomplete ones dropped, unknown fields never pass through", () => {
  assert.equal(parseScanAttachment({ attachmentId: "a", mimeType: "application/pdf" }), null);
  assert.equal(parseScanAttachment({ messageId: "m", mimeType: "application/pdf" }), null);
  assert.equal(parseScanAttachment(null), null);
  const a = parseScanAttachment({ ...att("m", "1"), evil: "<script>", sizeBytes: -5 });
  assert.ok(a);
  assert.equal("evil" in (a as object), false);
  assert.equal(a?.sizeBytes, null);
});

// ================================================================ M. merging
check("M1 the same attachment (stable key) is listed once, even when its attachment id changed", () => {
  const first = [att("m1", "1", "A1"), att("m1", "2", "B1")];
  const again = [att("m1", "1", "A2"), att("m1", "2", "B2"), att("m3", "root")];
  const merged = mergeAttachments(first, again);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].attachmentId, "A1", "the row already listed keeps its place and data");
  assert.deepEqual(new Set(merged.map(gmailAttachmentKey)).size, 3);
  // Same filename, different parts → two rows.
  const twins = mergeAttachments([], [att("m9", "1", "x", { filename: "invoice.pdf" }), att("m9", "4", "y", { filename: "invoice.pdf" })]);
  assert.equal(twins.length, 2);
});

check("M2 the screen's keys (scoring) are the same stable keys", () => {
  const list = [att("m1", "1"), att("m2", "root"), att("m3", null, "legacy-id")];
  assert.deepEqual(scoreAttachments(list).map((a) => a.key), list.map(gmailAttachmentKey));
});

// ================================================================ S. state
const after = (s: ExtendedScanState, status: number, body: unknown) => applyScanAnswer(s, parseScanAnswer(status, body));

check("S1 first page: results, counts, has_more, the next cursor", () => {
  const s = after(startScan(90, 7), 200, page());
  assert.equal(s.items.length, 2);
  assert.equal(s.completion, "has_more");
  assert.equal(s.continueCursor, "gsc1.NEXT");
  assert.equal(s.continueIsRetry, false);
  assert.equal(s.pagesComplete, 1);
  assert.equal(s.attachmentParts, 3);
  assert.equal(s.unsupportedType, 1);
  assert.equal(s.rejectedByType.zip, 1);
  assert.equal(isScanFinished(s), false);
});

check("S2 the end of the window: 'complete' only when the server says nothing follows", () => {
  const s = after(startScan(30, 7), 200, page({ hasMore: false, nextCursor: null }));
  assert.equal(s.completion, "complete");
  assert.equal(s.continueCursor, null);
  assert.equal(isScanFinished(s), true);
  // "more" but no way to continue → never shown as finished.
  const odd = after(startScan(30, 7), 200, page({ hasMore: true, nextCursor: null }));
  assert.equal(odd.completion, "error");
  assert.equal(isScanFinished(odd), false);
});

check("S3 the 500 cap: stopped, more may exist, never 'finished'", () => {
  const s = after(startScan(365, 7), 200, page({ capReached: true, hasMore: true, nextCursor: null, scannedTotal: 500 }));
  assert.equal(s.completion, "cap_reached");
  assert.equal(s.continueCursor, null);
  assert.equal(isScanFinished(s), false);
});

check("S4 a partial page keeps what arrived, counts nothing, retries the SAME page — and the retry adds no duplicate", () => {
  const p1 = after(startScan(90, 7), 200, page());
  const partial = after(p1, 200, page({ status: "incomplete", pageComplete: false, success: false, scannedTotal: 25, retryCursor: "gsc1.SAME", nextCursor: null, attachments: [att("m4", "1")], attachmentParts: 1, unsupportedType: 0 }));
  assert.equal(partial.items.length, 3, "kept");
  assert.equal(partial.completion, "incomplete");
  assert.equal(partial.continueCursor, "gsc1.SAME");
  assert.equal(partial.continueIsRetry, true);
  assert.equal(partial.pagesComplete, 1, "not counted");
  assert.equal(partial.attachmentParts, 3, "not counted");
  const retried = after(partial, 200, page({ scannedTotal: 50, nextCursor: "gsc1.N3", attachments: [att("m4", "1"), att("m5", "2")], attachmentParts: 2, unsupportedType: 0 }));
  assert.equal(retried.items.length, 4, "m4 once");
  assert.equal(retried.pagesComplete, 2);
  assert.equal(retried.attachmentParts, 5, "the retried page counted exactly once");
  assert.equal(retried.scannedTotal, 50);
});

check("S5 stopped / budget / unavailable / expired / error / reconnect / network: results never removed", () => {
  const base = after(startScan(90, 7), 200, page());
  const cases: Array<[string, (s: ExtendedScanState) => ExtendedScanState, string, string | null]> = [
    ["stopped", (s) => after(s, 200, page({ status: "stopped_unfinished", pageComplete: false, success: false, attachments: [] })), "stopped", null],
    ["list stopped", (s) => after(s, 502, { code: "gmail_unavailable", status: "stopped_unfinished" }), "stopped", null],
    ["list retry", (s) => after(s, 503, { code: "gmail_throttled", status: "incomplete", retryCursor: "gsc1.L" }), "incomplete", "gsc1.L"],
    ["budget", (s) => after(s, 429, { code: "scan_budget_exhausted", retryCursor: "gsc1.B" }), "budget", "gsc1.B"],
    ["budget, no cursor", (s) => after(s, 429, { code: "rate_limited", retryAfterSeconds: 20 }), "budget", "gsc1.NEXT"],
    ["unavailable", (s) => after(s, 503, { code: "scan_unavailable", retryCursor: "gsc1.U" }), "unavailable", "gsc1.U"],
    ["expired", (s) => after(s, 400, { code: "scan_cursor_invalid" }), "expired", null],
    ["error", (s) => after(s, 500, {}), "error", "gsc1.NEXT"],
    ["reconnect", (s) => after(s, 409, { needsReconnect: true }), "reconnect", null],
    ["network", (s) => applyNetworkFailure(s), "error", "gsc1.NEXT"],
  ];
  for (const [label, step, completion, cursor] of cases) {
    const s = step(base);
    assert.equal(s.items.length, 2, `${label}: results kept`);
    assert.deepEqual(s.items, base.items, `${label}: same results`);
    assert.equal(s.completion, completion, label);
    assert.equal(s.continueCursor, cursor, `${label}: cursor`);
    assert.equal(isScanFinished(s), false, `${label}: never "finished"`);
  }
  const b = after(base, 429, { code: "rate_limited", retryAfterSeconds: 20 });
  assert.equal(b.retryAfterSeconds, 20);
});

check("S6 a new scan starts empty for the selected window/account; statuses live outside the state", () => {
  const s = startScan(365, 9);
  assert.equal(s.items.length, 0);
  assert.equal(s.window, 365);
  assert.equal(s.connectionId, 9);
  assert.equal("statusByKey" in s, false);
  assert.deepEqual(initialScanState().completion, "none");
});

check("S7 basic scan (fallback): merged without duplicates, never 'finished', no continuation", () => {
  const base = after(after(startScan(90, 7), 200, page()), 503, { code: "scan_unavailable" });
  const s = applyBasicScan(base, { scannedMessages: 30, attachmentParts: 4, unsupportedType: 0, attachments: [att("m1", "1", "fresh-id"), att("m8", "1")] });
  assert.equal(s.items.length, 3);
  assert.equal(s.completion, "basic");
  assert.equal(s.continueCursor, null);
  assert.equal(isScanFinished(s), false);
});

// ================================================================ A. allowed actions
check("A1 nothing that changes the list during an import", () => {
  const more = after(startScan(90, 7), 200, page());
  assert.deepEqual(scanActions(more, false), { canLoadMore: true, canRetrySamePage: false, canStartNew: true, canOfferBasicScan: false });
  assert.deepEqual(scanActions(more, true), { canLoadMore: false, canRetrySamePage: false, canStartNew: false, canOfferBasicScan: false });
  const partial = after(more, 200, page({ status: "incomplete", pageComplete: false, retryCursor: "gsc1.S", attachments: [] }));
  assert.equal(scanActions(partial, false).canRetrySamePage, true);
  assert.equal(scanActions(partial, false).canLoadMore, false, "never the next page while this one is unfinished");
  assert.equal(scanActions(partial, true).canRetrySamePage, false);
  const down = after(more, 503, { code: "scan_unavailable" });
  assert.equal(scanActions(down, false).canOfferBasicScan, true);
  assert.equal(scanActions(down, true).canOfferBasicScan, false);
  const finished = after(startScan(30, 7), 200, page({ hasMore: false, nextCursor: null }));
  assert.equal(scanActions(finished, false).canLoadMore, false);
});

check("A2 clearing a long list asks first; stale results are recognised", () => {
  let s = startScan(30, 7);
  s = { ...s, items: Array.from({ length: CONFIRM_CLEAR_ABOVE }, (_, i) => att(`m${i}`, "1")) };
  assert.equal(needsClearConfirmation(s), false, "exactly 50: no question");
  s = { ...s, items: [...s.items, att("m-extra", "1")] };
  assert.equal(needsClearConfirmation(s), true);
  assert.equal(resultsAreStale(initialScanState(), { window: 90, connectionId: 7 }), false);
  assert.equal(resultsAreStale(startScan(30, 7), { window: 30, connectionId: 7 }), false);
  assert.equal(resultsAreStale(startScan(30, 7), { window: 90, connectionId: 7 }), true);
  assert.equal(resultsAreStale(startScan(30, 7), { window: 30, connectionId: 8 }), true);
});

// ================================================================ N. helpers
check("N1 sender display name from the From header", () => {
  const cases: Array<[string | null, string | null]> = [
    ['"Vercel Inc." <invoice@vercel.com>', "Vercel Inc."],
    ["Kamatera <billing@kamatera.com>", "Kamatera"],
    ['"Smith, John" <j@x.example>', "Smith, John"],
    ["חשבונית ירוקה <noreply@greeninvoice.co.il>", "חשבונית ירוקה"],
    ['"He said \\"hi\\"" <a@b.example>', 'He said "hi"'],
    ["billing@vendor.example", null],
    ["<billing@vendor.example>", null],
    ['"" <billing@vendor.example>', null],
    ["=?utf-8?B?15fXqdeR15XXoNeZ16o=?= <a@b.example>", null],
    ["billing@vendor.example <billing@vendor.example>", null],
    [null, null],
    ["", null],
  ];
  for (const [header, expected] of cases) assert.equal(extractDisplayName(header), expected, String(header));
  assert.equal(extractDisplayName(`${"N".repeat(120)} <a@b.example>`)?.length, 80);
});

const tHe = (key: string, vars?: Record<string, string | number>) => {
  const node = key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], { documents: documentsHe });
  let s = String(node ?? key);
  for (const [k, v] of Object.entries(vars ?? {})) s = s.replace(`{${k}}`, String(v));
  return s;
};

check("N2 dates, type labels and the human part of the scoring reason", () => {
  const now = new Date(2026, 10, 9, 15, 0, 0);
  const t = tHe as never;
  assert.equal(displayDate(t, new Date(2026, 10, 9, 8, 0).toISOString(), "he", now), "היום");
  assert.equal(displayDate(t, new Date(2026, 10, 8, 23, 0).toISOString(), "he", now), "אתמול");
  assert.match(displayDate(t, new Date(2025, 2, 3).toISOString(), "he", now), /2025/);
  assert.doesNotMatch(displayDate(t, new Date(2026, 2, 3).toISOString(), "he", now), /2026/);
  assert.equal(displayDate(t, null, "he", now), "");
  assert.equal(displayDate(t, "not a date", "he", now), "");
  assert.equal(fileTypeLabel(t, "application/pdf"), "PDF");
  assert.equal(fileTypeLabel(t, "image/jpeg"), "תמונה");
  assert.equal(fileTypeLabel(t, "application/octet-stream"), "קובץ");
  assert.equal(scoreReasonText("אולי רלוונטי (30) • PDF, קטן מאוד"), "PDF, קטן מאוד");
  assert.equal(scoreReasonText("מוסתר (5)"), "");
});

check("N3 every new label exists in Hebrew and English", () => {
  const he = (documentsHe as unknown as { email: Record<string, string> }).email;
  const en = (documentsEn as unknown as { email: Record<string, string> }).email;
  const keys = ["scanButton", "period30", "period90", "period365", "periodName30", "periodName90", "periodName365", "loadMore", "stateComplete", "stateHasMore", "stateCap", "stateIncomplete", "stateStopped", "stateBudget", "stateBudgetWait", "stateUnavailable", "stateExpired", "stateError", "basicScan", "groupRecommended", "groupPossible", "groupLow", "groupPossibleNote", "groupLowNote", "importAnyway", "importForReview", "confirmPossible", "confirmLowScore", "confirmImportTitle", "stopImport", "importAllRecommended", "staleResults", "confirmClearTitle", "busyImporting"];
  for (const k of keys) {
    assert.ok(he[k], `he ${k}`);
    assert.ok(en[k], `en ${k}`);
  }
  assert.equal(he.scanButton, "סרוק מסמכים");
  assert.equal(he.loadMore, "טען עוד");
  // Owner fix 4: the cap message suggests nothing the screen cannot do.
  assert.equal(/מוקדמת|earlier/.test(he.stateCap + en.stateCap), false);
  assert.equal(/סורק מיילים אחרונים|Scanning recent/.test(he.connectedNotice + en.connectedNotice), false, "no promise of an automatic scan");
});

// ================================================================ W. the page
const src = read("app/(shell)/documents/email/page.tsx");

check("W1 manual scan only: no effect requests a scan; scan / load more / basic only from taps", () => {
  const effects = src.match(/useEffect\(\(\) => \{[\s\S]*?\n {2}\}, \[[^\]]*\]\);/g) ?? [];
  assert.ok(effects.length >= 4);
  for (const e of effects) assert.equal(/requestScanPage|runBasicScan|onScanPress|gmail\/(scan|sync)/.test(e), false);
  // Picking a period only updates state; it never requests anything.
  assert.match(src, /<PeriodPicker t=\{t\} value=\{selectedWindow\} disabled=\{loading \|\| busy\} onChange=\{setSelectedWindow\} \/>/);
  // Picking an account only selects it (it used to scan at once).
  assert.match(src, /onClick=\{\(\) => setSelectedConnectionId\(c\.id\)\}/);
  assert.equal((src.match(/fetch\(`\/api\/integrations\/gmail\/scan\?/g) ?? []).length, 1, "one request site");
  assert.match(src, /onClick=\{onScanPress\}/);
  assert.match(src, /onClick=\{\(\) => void requestScanPage\("continue"\)\}/);
  assert.match(src, /onClick=\{\(\) => void runBasicScan\(\)\}/);
  // Continuations always use the CURRENT results' window and account.
  assert.match(src, /const windowForRequest = mode === "new" \? selectedWindow : \(scan\.window \?\? selectedWindow\);/);
  assert.match(src, /const connectionForRequest = mode === "new" \? selectedConnectionId : scan\.connectionId;/);
});

check("W2 bulk import: recommended only, behind a confirmation, stoppable", () => {
  assert.match(src, /const importable = useMemo\(\n\s+\(\) => recommended\.filter\(\(a\) => \(statusByKey\[a\.key\] \|\| "pending"\) === "pending"\),/);
  assert.match(src, /onClick=\{\(\) => setConfirmImport\(true\)\}/, "the bulk button only opens the confirmation");
  assert.match(src, /onClick=\{\(\) => void importAllRecommended\(\)\}/, "the import runs from the confirmation");
  assert.equal((src.match(/\bimportAllRecommended\(\)/g) ?? []).length, 2, "declared once, called once");
  assert.equal((src.match(/void importAllRecommended\(\)/g) ?? []).length, 1, "called only from the confirmation");
  assert.match(src, /if \(stopImportRef\.current\) break;/);
  // B4 (2026-11-09): possibly-relevant and low-score rows import one at a time, only from their
  // own confirmation (pinned in gmail-b4-manual-import.verify.test.ts); never in bulk (above).
  assert.match(src, /const confirmFirst = attachment\.bucket !== "recommended";/);
});

check("W3 during an import nothing that changes the list can start", () => {
  assert.match(src, /const busy = importing \|\| rowImporting;/);
  assert.match(src, /if \(!authHeader \|\| loading \|\| busy\) return;\n\s+const windowForRequest/);
  assert.match(src, /const actions = scanActions\(scan, busy \|\| loading\);/);
  assert.match(src, /disabled=\{loading \|\| busy\}\n\s+onClick=\{\(\) => setSelectedConnectionId/);
  assert.match(src, /className="dz-email-scan-button"\n\s+disabled=\{loading \|\| busy\}/);
});

check("W4 import itself is unchanged; it uses the account the results came from", () => {
  assert.match(src, /fetch\("\/api\/integrations\/gmail\/import", \{\n\s+method: "POST",/);
  for (const field of ["messageId", "attachmentId", "filename", "mimeType", "sizeBytes", "fromEmail", "subject", "sentAt"]) {
    assert.match(src, new RegExp(`${field}: attachment\\.${field},`), field);
  }
  assert.match(src, /partId: attachment\.partId \?\? null,/);
  assert.match(src, /const importConnectionId = scan\.connectionId \?\? selectedConnectionId;/);
  assert.equal(/fromName: attachment/.test(src), false, "the display name is never sent to import");
});

check("W5 the phone bar sits above the shell's bottom navigation, and the page leaves room under the last card", () => {
  const bar = read("components/navigation/bottom-bar.tsx");
  const h = Number(bar.match(/const BAR_HEIGHT = (\d+);/)?.[1]);
  assert.ok(h > 0);
  const layout = read("app/(shell)/documents/layout.tsx");
  assert.ok(layout.includes(`.dz-email-bottom { bottom: calc(${h}px + env(safe-area-inset-bottom, 0px)); }`), "offset = the shell bar height");
  assert.match(layout, /@media \(max-width: 767px\) \{\n\s+\.dz-email-bottom/);
  assert.ok(layout.includes(`.dz-email-page { padding-bottom: calc(${h}px + 150px + env(safe-area-inset-bottom, 0px)); }`));
  assert.match(src, /className="dz-email-bottom" style=\{bottomBarStyle\}/);
  assert.equal(/bottom: 0,/.test(src.slice(src.indexOf("const bottomBarStyle"))), false, "no inline bottom: 0 overriding the CSS");
});

check("W6 B1 diagnostics still shown (counts only)", () => {
  assert.match(src, /scanDiag\.unsupportedType > 0 && rejectedByType \?/);
  assert.match(src, /REJECTED_TYPE_GROUPS\.filter\(\(group\) => rejectedByType\[group\] > 0\)/);
});

console.log(`GMAIL EXTENDED SCAN (B3-B) VERIFY PASS — ${passed} checks green.`);
