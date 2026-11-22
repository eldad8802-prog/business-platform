/** Service Desk UI 1.3 — the case-opening form model. Pure: `npx tsx features/service-desk/open-case-model.test.ts`. */
import { draftHasWork, draftIssues, EMPTY_DRAFT, phoneIssue, offeredTracks, openCaseBody, TRACK_FORMS, warrantySuggestion, type OpenCaseDraft } from "./open-case-model";

let passed = 0, failed = 0;
const ok = (n: string, c: boolean, d = "") => { if (c) passed++; else { failed++; console.log(`  [FAIL] ${n}${d ? " — " + d : ""}`); } };
const NOW = new Date("2026-11-19T12:00:00.000Z");
const ago = (d: number) => new Date(NOW.getTime() - d * 864e5).toISOString();
const dana = { id: 5, name: "דנה כהן", phone: "050-1234567" };

ok("O1 the business's tracks come first, defaults before enabled, the rest behind 'more'", (() => {
  const o = offeredTracks({ defaultTracks: ["T1", "T7"], enabledTracks: ["T3", "T6"] });
  return o.first.join(",") === "T1,T7,T3,T6" && o.more.join(",") === "T2,T4,T5"; })());
ok("O2 no profile → a repair and a service call are offered", offeredTracks(null).first.join(",") === "T1,T5");
ok("O3 a repair form asks for the item; a service form does not", TRACK_FORMS.T1.subject?.kind === "ITEM" && TRACK_FORMS.T5.subject === null && TRACK_FORMS.T6.subject === null);
ok("O4 on-site work asks for the address; a lab does not", TRACK_FORMS.T3.address === "required" && TRACK_FORMS.T4.address === "required" && TRACK_FORMS.T1.address === null);
ok("O5 a held item continues to the intake, a service call to the case", TRACK_FORMS.T1.next === "intake" && TRACK_FORMS.T2.next === "intake" && TRACK_FORMS.T3.next === "case" && TRACK_FORMS.T5.next === "case");

ok("V1 nothing chosen → only 'choose what to open'", draftIssues(EMPTY_DRAFT).join(",") === "track");
const repair: OpenCaseDraft = { ...EMPTY_DRAFT, track: "T1" };
ok("V2 a repair needs customer, item and fault", draftIssues(repair).join(",") === "customer,subject,problem");
ok("V3 a complete repair has no issue", draftIssues({ ...repair, customer: dana, subjectName: "iPhone 13", problem: "מסך סדוק" }).length === 0);
ok("V4 an on-site repair needs the address", draftIssues({ ...EMPTY_DRAFT, track: "T3", customer: dana, subjectName: "מזגן", problem: "מטפטף" }).join(",") === "address");
ok("V5 a general service needs no item and no address", draftIssues({ ...EMPTY_DRAFT, track: "T5", customer: dana, problem: "ניקיון משרד" }).length === 0);
ok("V6 blank-only text is missing; over-long text is refused", draftIssues({ ...repair, customer: dana, subjectName: "  ", problem: "x".repeat(4001) }).join(",") === "subject,problemTooLong");

ok("B1 repair body: track, customer, trimmed problem, the ITEM subject", JSON.stringify(openCaseBody({ ...repair, customer: dana, subjectName: " iPhone 13 ", problem: " מסך " }))
  === JSON.stringify({ track: "T1", customerId: 5, problemDescription: "מסך", subject: { kind: "ITEM", displayName: "iPhone 13" } }));
ok("B2 service body: no subject; the address only when given", JSON.stringify(openCaseBody({ ...EMPTY_DRAFT, track: "T5", customer: dana, problem: "ניקיון", siteAddress: "" }))
  === JSON.stringify({ track: "T5", customerId: 5, problemDescription: "ניקיון" })
  && (openCaseBody({ ...EMPTY_DRAFT, track: "T3", customer: dana, subjectName: "מזגן", problem: "מטפטף", siteAddress: "הרצל 10" }) as { siteAddress?: string }).siteAddress === "הרצל 10");
ok("B3 an accepted link carries parentCaseId; the body never names a requirement", (() => {
  const b = openCaseBody({ ...repair, customer: dana, subjectName: "x", problem: "y", parentCaseId: 77 });
  return b.parentCaseId === 77 && !("requirements" in b) && !("workApproval" in b) && !("qaMode" in b); })());

const past = [
  { id: 1, caseNumber: 1029, status: "DELIVERED", subjectName: "iPhone 13", updatedAt: ago(41) },
  { id: 2, caseNumber: 988, status: "CLOSED", subjectName: "iPad Air", updatedAt: ago(150) },
  { id: 3, caseNumber: 1011, status: "IN_REPAIR", subjectName: "iPhone 13", updatedAt: ago(5) },
];
ok("W1 the same item handed back inside the warranty is suggested", JSON.stringify(warrantySuggestion(past, " iphone 13", { value: 90, unit: "DAYS" }, NOW)) === JSON.stringify({ caseId: 1, caseNumber: 1029, daysAgo: 41, warrantyDays: 90 }));
ok("W2 outside the warranty, an open case, or no warranty → no suggestion", warrantySuggestion(past, "iPhone 13", { value: 30, unit: "DAYS" }, NOW) === null
  && warrantySuggestion(past, "iPad Air", { value: 3, unit: "MONTHS" }, NOW) === null && warrantySuggestion(past, "iPhone 13", null, NOW) === null);


// ── Pilot review 2026-11-21 ──
ok("N1 phone: empty is fine; Israeli mobile / landline / +972 / international pass",
  ["", "050-1234567", "0501234567", "03-1234567", "+972 50 123 4567", "+44 20 7946 0958"].every((p) => phoneIssue(p) === null));
ok("N2 phone: too short / letters / a wrong prefix are refused on the field", ["123", "05012", "abc0501234567", "0101234567", "050-12345678"].every((p) => phoneIssue(p) !== null));
ok("N3 leaving the form warns only when something was typed or chosen (the track alone is not work)",
  !draftHasWork(EMPTY_DRAFT) && !draftHasWork({ ...EMPTY_DRAFT, track: "T1" } as never) && draftHasWork({ ...EMPTY_DRAFT, problem: "x" })
  && draftHasWork(EMPTY_DRAFT, { open: true, name: "דנה", phone: "" }));

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
