/**
 * ר1 — the owner's record and the quote fingerprints. Pure (no DB, no network, no clock).
 *   npx tsx lib/services/business-documents/quote-share/quote-share-core.test.ts
 */
import { quoteContentHash, renderInputHash, type QuoteContentRows } from "./quote-share-content";
import {
  closesValidityReminder,
  deriveShareState,
  followUpDue,
  parseShareEventInput,
  ShareEventValidationError,
  type ShareEventRow,
} from "./quote-share-state";
import { canonicalJson, isRequestKey, requestHashOf } from "../requests/business-docs-requests";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    failures.push(name);
    console.log(`  [FAIL] ${name}`);
  }
}
function refuses(name: string, fn: () => unknown, field?: string) {
  try {
    fn();
    ok(name, false);
  } catch (e) {
    ok(name, e instanceof ShareEventValidationError && (!field || e.field === field));
  }
}

const rows = (over: Partial<QuoteContentRows["doc"]> = {}, lines?: QuoteContentRows["lines"]): QuoteContentRows => ({
  doc: { id: 7, documentNumberFormatted: "Q-0007", customerId: 3, customerNameSnapshot: "לקוח", validUntil: new Date("2026-11-20T00:00:00Z"), currency: "ILS", subtotalAmount: "100.00", vatAmount: "18.00", totalAmount: "118.00", ...over },
  lines: lines ?? [{ lineIndex: 0, description: "שירות", quantity: "1", unitPrice: "100", vatRatePercent: "18", lineSubtotal: "100.00", vatAmount: "18.00", lineTotal: "118.00" }],
  customer: { id: 3, name: "לקוח", phone: null, email: null, city: null },
});

console.log("--- fingerprints ---");
const base = quoteContentHash(rows());
ok("content hash is stable for the same rows", base === quoteContentHash(rows()));
ok("line order in input does not matter (sorted by lineIndex)", quoteContentHash(rows({}, [
  { lineIndex: 1, description: "ב", quantity: "1", unitPrice: "1", vatRatePercent: "18", lineSubtotal: "1", vatAmount: "0.18", lineTotal: "1.18" },
  { lineIndex: 0, description: "א", quantity: "1", unitPrice: "1", vatRatePercent: "18", lineSubtotal: "1", vatAmount: "0.18", lineTotal: "1.18" },
])) === quoteContentHash(rows({}, [
  { lineIndex: 0, description: "א", quantity: "1", unitPrice: "1", vatRatePercent: "18", lineSubtotal: "1", vatAmount: "0.18", lineTotal: "1.18" },
  { lineIndex: 1, description: "ב", quantity: "1", unitPrice: "1", vatRatePercent: "18", lineSubtotal: "1", vatAmount: "0.18", lineTotal: "1.18" },
])));
ok("a changed line description changes it", quoteContentHash(rows({}, [{ lineIndex: 0, description: "שירות מעודכן", quantity: "1", unitPrice: "100", vatRatePercent: "18", lineSubtotal: "100.00", vatAmount: "18.00", lineTotal: "118.00" }])) !== base);
ok("a changed total changes it", quoteContentHash(rows({ totalAmount: "119.00" })) !== base);
ok("a changed validity date changes it", quoteContentHash(rows({ validUntil: new Date("2026-11-21T00:00:00Z") })) !== base);
ok("a changed customer name changes it", quoteContentHash(rows({ customerNameSnapshot: "אחר" })) !== base);
const snap = { schemaVersion: 1, issuedAt: "2026-11-07T10:00:00Z", metadata: { actorUserId: 5 }, document: { id: 7 }, lines: [{ d: "x" }] };
ok("render input ignores the render date and the actor", renderInputHash(snap) === renderInputHash({ ...snap, issuedAt: "2027-01-01T00:00:00Z", metadata: { actorUserId: 9 } }));
ok("render input changes with any rendered value", renderInputHash(snap) !== renderInputHash({ ...snap, lines: [{ d: "y" }] }));
ok("canonical JSON sorts keys and drops undefined", canonicalJson({ b: 1, a: undefined, c: [{ z: 1, y: 2 }] }) === '{"b":1,"c":[{"y":2,"z":1}]}');
ok("request hash differs for different bodies", requestHashOf({ op: "X", quoteId: 1 }) !== requestHashOf({ op: "X", quoteId: 2 }));
ok("request keys: a uuid is accepted, anything else is not", isRequestKey("3f2b8c1e-9a4d-4c6b-8e2f-1a2b3c4d5e6f") && !isRequestKey("1") && !isRequestKey("3f2b8c1e-9a4d-4c6b-8e2f-1a2b3c4d5e6f'--"));

console.log("--- the owner's record ---");
const H = "a".repeat(64), OLD = "b".repeat(64);
let t = 0;
const ev = (id: number, kind: ShareEventRow["kind"], extra: Partial<ShareEventRow> = {}): ShareEventRow => ({ id, kind, copyId: null, correctsEventId: null, quoteContentHash: H, createdAt: new Date(Date.UTC(2026, 10, 1, 8, ++t)), ...extra });
ok("nothing recorded → no response, not sent", (() => { const s = deriveShareState([], H); return s.response === null && s.sent === null; })());
ok("a NOTE is never a response and never closes S08", !closesValidityReminder(deriveShareState([ev(1, "NOTE")], H)));
ok("download / share sheet / sent never close S08", !closesValidityReminder(deriveShareState([ev(1, "DOWNLOADED", { copyId: 1 }), ev(2, "SHARE_SHEET_OPENED", { copyId: 1 }), ev(3, "MARKED_SENT", { copyId: 1 })], H)));
ok("an ACCEPTED on the current version closes S08", closesValidityReminder(deriveShareState([ev(1, "RESPONSE_ACCEPTED")], H)));
ok("a DECLINED on the current version closes S08", closesValidityReminder(deriveShareState([ev(1, "RESPONSE_DECLINED")], H)));
ok("a corrected response no longer counts", !closesValidityReminder(deriveShareState([ev(1, "RESPONSE_ACCEPTED"), ev(2, "CORRECTION", { correctsEventId: 1 })], H)));
ok("a response on an older version decides nothing (and is counted as stale)", (() => { const s = deriveShareState([ev(1, "RESPONSE_ACCEPTED", { quoteContentHash: OLD })], H); return s.response === null && s.staleResponses === 1; })());
ok("correct ACCEPTED then record DECLINED → DECLINED", deriveShareState([ev(1, "RESPONSE_ACCEPTED"), ev(2, "CORRECTION", { correctsEventId: 1 }), ev(3, "RESPONSE_DECLINED")], H).response?.kind === "DECLINED");
ok("the latest in-force response wins", deriveShareState([ev(1, "RESPONSE_DECLINED"), ev(2, "RESPONSE_ACCEPTED")], H).response?.kind === "ACCEPTED");
ok("sent = latest in-force MARKED_SENT on the current version", deriveShareState([ev(1, "MARKED_SENT", { copyId: 1 }), ev(2, "MARKED_SENT", { copyId: 2 })], H).sent?.eventId === 2);
ok("a corrected MARKED_SENT is not 'sent'", deriveShareState([ev(1, "MARKED_SENT", { copyId: 1 }), ev(2, "CORRECTION", { correctsEventId: 1 })], H).sent === null);
ok("a MARKED_SENT on an older version is not 'sent' now", deriveShareState([ev(1, "MARKED_SENT", { copyId: 1, quoteContentHash: OLD })], H).sent === null);

console.log("--- S09 ---");
const sent = deriveShareState([ev(1, "MARKED_SENT", { copyId: 1 })], H);
ok("not due before 3 days", !followUpDue(sent, 2));
ok("due at 3 days", followUpDue(sent, 3));
ok("not due once a response is recorded", !followUpDue(deriveShareState([ev(1, "MARKED_SENT", { copyId: 1 }), ev(2, "RESPONSE_ACCEPTED")], H), 10));
ok("a NOTE does not stop it", followUpDue(deriveShareState([ev(1, "MARKED_SENT", { copyId: 1 }), ev(2, "NOTE")], H), 5));
ok("not due when nothing was marked sent", !followUpDue(deriveShareState([ev(1, "DOWNLOADED", { copyId: 1 })], H), 30));

console.log("--- event input ---");
ok("MARKED_SENT with a copy and a channel", parseShareEventInput({ kind: "MARKED_SENT", copyId: 4, channel: "EMAIL" }).channel === "EMAIL");
refuses("MARKED_SENT without a copy", () => parseShareEventInput({ kind: "MARKED_SENT" }), "copyId");
refuses("DOWNLOADED without a copy", () => parseShareEventInput({ kind: "DOWNLOADED" }), "copyId");
refuses("a response that points at a copy", () => parseShareEventInput({ kind: "RESPONSE_ACCEPTED", copyId: 1 }), "copyId");
refuses("a channel on a response", () => parseShareEventInput({ kind: "RESPONSE_DECLINED", channel: "EMAIL" }), "channel");
refuses("an unknown channel", () => parseShareEventInput({ kind: "MARKED_SENT", copyId: 1, channel: "FAX" }), "channel");
refuses("a NOTE without text", () => parseShareEventInput({ kind: "NOTE", note: "   " }), "note");
refuses("a note over 2,000 characters", () => parseShareEventInput({ kind: "NOTE", note: "א".repeat(2001) }), "note");
refuses("a note with control characters", () => parseShareEventInput({ kind: "NOTE", note: "a\u0007b" }), "note");
refuses("a CORRECTION without a target", () => parseShareEventInput({ kind: "CORRECTION" }), "correctsEventId");
refuses("a target on a non-correction", () => parseShareEventInput({ kind: "NOTE", note: "x", correctsEventId: 2 }), "correctsEventId");
refuses("an unknown kind", () => parseShareEventInput({ kind: "DELIVERED" }), "kind");
refuses("a non-integer copy id", () => parseShareEventInput({ kind: "DOWNLOADED", copyId: "1" }), "copyId");
ok("a note keeps line breaks, trims the ends", parseShareEventInput({ kind: "NOTE", note: "  שורה\r\nשנייה  " }).note === "שורה\nשנייה");

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
