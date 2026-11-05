/**
 * ר3 — customer documents timeline model (pure: no DB, no network, no clock).
 * Run: npx tsx features/business-documents/customer-documents-model.test.ts
 */
import { buildTimeline, errorText, formatAmount, jerusalemParts, mergePages, toTimelineItem, type BillingListRow } from "./customer-documents-model";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
}

const row = (over: Partial<BillingListRow>): BillingListRow => ({
  id: 1,
  documentType: "TAX_INVOICE",
  status: "ISSUED",
  documentNumberFormatted: "000012",
  customerNameSnapshot: "לקוח",
  totalAmount: "4096.13",
  currency: "ILS",
  issuedAt: "2026-07-15T09:30:00.000Z",
  createdAt: "2026-07-14T08:00:00.000Z",
  ...over,
});

const item = toTimelineItem(row({}));
ok("title = Hebrew type + number", item.title === "חשבונית מס 000012", item.title);
ok("links to the EXISTING document screen", item.href === "/billing/1");
ok("issued status label", item.statusLabel === "הופק" && item.statusTone === "ok");
ok("date in Israel time, dd.mm.yyyy", item.dateLabel === "15.07.2026", item.dateLabel);
ok("amount is the billing total, formatted only", item.amountLabel.includes("4,096.13"), item.amountLabel);

ok("draft has no number → type only", toTimelineItem(row({ documentNumberFormatted: null, status: "DRAFT" })).title === "חשבונית מס");
ok("draft status label", toTimelineItem(row({ status: "DRAFT" })).statusLabel === "טיוטה");
ok("draft placed by creation date", toTimelineItem(row({ status: "DRAFT", issuedAt: null })).dateLabel === "14.07.2026");
ok("every existing type has a Hebrew label", ["TAX_INVOICE", "TAX_INVOICE_RECEIPT", "RECEIPT", "CREDIT_NOTE", "QUOTE"].every((t) => !toTimelineItem(row({ documentType: t })).title.startsWith("מסמך")));
ok("unknown type falls back to 'מסמך'", toTimelineItem(row({ documentType: "SOMETHING", documentNumberFormatted: null })).title === "מסמך");

// Israel midnight boundary: 2026-07-31T21:30Z is already 1 August in Israel.
const p = jerusalemParts("2026-07-31T21:30:00.000Z");
ok("Israel time boundary (UTC+3 in summer)", p.y === 2026 && p.m === 8 && p.d === 1, JSON.stringify(p));

const groups = buildTimeline([
  row({ id: 1, issuedAt: "2026-06-02T10:00:00.000Z" }),
  row({ id: 3, issuedAt: "2026-07-20T10:00:00.000Z" }),
  row({ id: 2, issuedAt: "2026-07-20T10:00:00.000Z" }),
  row({ id: 4, status: "DRAFT", issuedAt: null, createdAt: "2026-07-31T21:30:00.000Z" }),
]);
ok("groups newest month first", groups.map((g) => g.key).join(",") === "2026-08,2026-07,2026-06", groups.map((g) => g.key).join(","));
ok("month label in Hebrew", groups[1].label === "יולי 2026", groups[1].label);
ok("same instant → newer id first", groups[1].items.map((i) => i.id).join(",") === "3,2");
ok("empty input → no groups", buildTimeline([]).length === 0);

const merged = mergePages([row({ id: 5 }), row({ id: 4 })], [row({ id: 4 }), row({ id: 3 })]);
ok("a retried page does not duplicate rows", merged.map((r) => r.id).join(",") === "5,4,3");

ok("401 / 403 / 404 / other error texts", errorText(401).includes("להתחבר") && errorText(403).includes("הרשאה") && errorText(404).includes("לא נמצא") && errorText(null).includes("לנסות שוב"));
ok("non-numeric amount shown as given", formatAmount("abc", "ILS") === "abc");

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`FAIL: ${f}`);
  process.exit(1);
}
