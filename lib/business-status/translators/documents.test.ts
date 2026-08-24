/**
 * Documents needs-review translator — trust contract (Wave 3 · F-22A). Run:
 *   npx tsx lib/business-status/translators/documents.test.ts
 *
 * Guards the presentation fix: an unverified (needs_review) extraction must not
 * leak the raw internal aggregate confidence, nor present extracted fields
 * (ספק/סכום) as facts, on the /attention card. The review CTA must remain.
 */
import { translateDocumentsNeedsReview } from "./documents";
import type { DocumentNeedsReviewRaw } from "../loaders";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else { failed += 1; console.error(`FAIL: ${name}`, extra ?? ""); }
}

// The reproduced case: a document-type string wrongly in vendorName, aggregate
// confidence 0.07, an amount — all unverified.
const reproduced: DocumentNeedsReviewRaw = {
  id: 42,
  createdAt: new Date("2026-05-15T09:00:00Z"),
  source: "email",
  vendorName: "אישור מס להצהרת הון",
  amount: 1234.5,
  confidenceScore: 0.07,
};

const empty: DocumentNeedsReviewRaw = {
  id: 43,
  createdAt: new Date("2026-05-16T09:00:00Z"),
  source: "file",
  vendorName: null,
  amount: null,
  confidenceScore: null,
};

const items = translateDocumentsNeedsReview([reproduced, empty]);
const [a, b] = items;

// --- state framing, not unverified values ---
ok("summary is the 'needs verification' framing", a.summary === "חילוץ ראשוני — דורש אימות", a.summary);
ok("same framing even with null fields (no crash)", b.summary === "חילוץ ראשוני — דורש אימות", b.summary);

// --- no raw internal confidence leaks ---
for (const it of items) {
  const s = it.summary ?? "";
  ok(`no 'ביטחון חילוץ' label (#${it.entityRef?.id})`, !/ביטחון חילוץ/.test(s), s);
  ok(`no raw confidence number (#${it.entityRef?.id})`, !/\d\.\d|0\.07|\b7\b/.test(s), s);
}

// --- extracted fields not presented as facts ---
ok("no 'ספק:' fact label", !/ספק\s*:/.test(a.summary ?? ""), a.summary);
ok("no 'סכום:' fact label", !/סכום\s*:/.test(a.summary ?? ""), a.summary);
ok("wrong vendor value not surfaced on the card", !(a.summary ?? "").includes("אישור מס להצהרת הון"), a.summary);
ok("amount value not surfaced on the card", !(a.summary ?? "").includes("1234"), a.summary);

// --- pending frame + review CTA preserved ---
ok("title still frames it as pending review", a.title === "מסמך ממתין לביקורת", a.title);
ok("review CTA preserved", a.primaryAction?.kind === "navigate" && a.primaryAction?.href === "/documents/review/42", a.primaryAction);
ok("CTA label unchanged", a.primaryAction?.label === "ביקורת מסמך", a.primaryAction);

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll documents-translator (F-22A) assertions passed");
