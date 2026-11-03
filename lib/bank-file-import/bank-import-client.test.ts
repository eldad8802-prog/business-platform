/**
 * Bank file import (B1) — the browser client, without a browser. A browser walkthrough found that the screen
 * called its routes WITHOUT the session's Bearer token (the app keeps it in localStorage, there is no auth
 * cookie): every call answered 401, the screen said "not open" for a business that had it. This proves every
 * request now carries the token, sends a real multipart body (no forced Content-Type), and keys decisions by
 * row number exactly as the server parses them.
 *
 * Run: npx tsx lib/bank-file-import/bank-import-client.test.ts
 */
let total = 0;
let failures = 0;
function check(name: string, cond: boolean, extra = ""): void {
  total += 1;
  if (!cond) failures += 1;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra && !cond ? " — " + extra : ""}`);
}

type Call = { url: string; init: RequestInit };
const calls: Call[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };
const store = new Map<string, string>();

(globalThis as unknown as { window: unknown }).window = globalThis;
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
  calls.push({ url: String(url), init });
  const { status, body } = nextResponse;
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const headerOf = (init: RequestInit, name: string): string | null => new Headers(init.headers ?? {}).get(name);

(async () => {
  const client = await import("./bank-import-client");
  store.set("token", "synthetic-token");

  console.log("Every request carries the session's Bearer token");
  nextResponse = { status: 200, body: { enabled: true } };
  check("status: open when the route answers 200", (await client.fetchBankImportOpen()) === true);
  check("status: sent with Authorization: Bearer <token>", headerOf(calls[0].init, "authorization") === "Bearer synthetic-token", JSON.stringify(calls[0].init.headers));
  nextResponse = { status: 404, body: { error: "Not found" } };
  check("status: closed when the flag is OFF (404)", (await client.fetchBankImportOpen()) === false);

  const file = new File([new Uint8Array([0xff, 0xfe, 0x41, 0x00])], "statement.csv");
  const form = client.buildBankImportForm({ file, accountId: 7, mapping: { amount: 3, balance: null }, token: "tok", decisions: { 12: "IMPORT", 4: "SKIP" } });
  nextResponse = { status: 200, body: { status: "READY", token: "t" } };
  const ok = await client.postBankImport<{ status: string }>("analyze", form);
  const post = calls[calls.length - 1];
  check("analyze: the JSON body comes back", ok.status === "READY");
  check("analyze: posted to /api/payables/bank-import/analyze", post.url === "/api/payables/bank-import/analyze" && post.init.method === "POST");
  check("analyze: sent with the Bearer token", headerOf(post.init, "authorization") === "Bearer synthetic-token");
  check("analyze: no Content-Type forced (the browser sets the multipart boundary)", headerOf(post.init, "content-type") === null);
  check("analyze: the body is the FormData itself", post.init.body instanceof FormData);

  console.log("The multipart body");
  check("file, account, mapping and token are set", form.get("file") instanceof File && form.get("accountId") === "7" && form.get("mapping") === JSON.stringify({ amount: 3, balance: null }) && form.get("token") === "tok");
  const decisions = JSON.parse(String(form.get("decisions")));
  check("decisions are keyed by row number (digits), valued IMPORT / SKIP", JSON.stringify(Object.keys(decisions).sort()) === JSON.stringify(["12", "4"]) && decisions["12"] === "IMPORT" && decisions["4"] === "SKIP");
  const bare = client.buildBankImportForm({ file, accountId: 7 });
  check("nothing optional is sent when there is nothing to send", bare.get("mapping") === null && bare.get("token") === null && bare.get("decisions") === null && bare.get("confirmAccountId") === null);
  const confirmed = client.buildBankImportForm({ file, accountId: 7, token: "tok", confirmAccountId: 7 });
  check("commit: the confirmed account is sent", confirmed.get("confirmAccountId") === "7");
  check("commit: there is no cross-account confirmation any more (such lines are refused, never confirmed)", confirmed.get("confirmCrossAccount") === null);

  console.log("Errors keep the status and the server's code");
  nextResponse = { status: 409, body: { error: "DECISIONS_REQUIRED" } };
  const e1 = await client.postBankImport("commit", bare).catch((e) => e);
  check("409 DECISIONS_REQUIRED surfaces as such", e1 instanceof client.BankImportRequestError && e1.status === 409 && e1.code === "DECISIONS_REQUIRED");
  nextResponse = { status: 409, body: { error: "ACCOUNT_NUMBER_MISMATCH", details: { fileLast4: "8999", accountLast4: "8901" } } };
  const e3 = await client.postBankImport("analyze", bare).catch((e) => e);
  check("409 ACCOUNT_NUMBER_MISMATCH keeps its details (the screen names both last-four digits)", e3 instanceof client.BankImportRequestError && e3.code === "ACCOUNT_NUMBER_MISMATCH" && e3.details.fileLast4 === "8999" && e3.details.accountLast4 === "8901");
  nextResponse = { status: 400, body: { error: "FOREIGN_CURRENCY", details: { signal: "CURRENCY_COLUMN", currency: "USD" } } };
  const e4 = await client.postBankImport("analyze", bare).catch((e) => e);
  check("400 FOREIGN_CURRENCY surfaces as such", e4 instanceof client.BankImportRequestError && e4.code === "FOREIGN_CURRENCY" && e4.details.currency === "USD");
  nextResponse = { status: 401, body: { error: "Unauthorized" } };
  const e2 = await client.postBankImport("commit", bare).catch((e) => e);
  check("401 surfaces as 401 (the screen says the session expired)", e2 instanceof client.BankImportRequestError && e2.status === 401);

  console.log("The target-account sentence on the preview");
  const verified = client.accountCheckText("VERIFIED_FULL");
  const partial = client.accountCheckText("PARTIAL_MATCH");
  const none = client.accountCheckText("NOT_IN_FILE");
  check("VERIFIED_FULL is the only outcome that says the account was verified (אומת)", verified.includes("החשבון אומת") && verified.includes("המלא"));
  check("PARTIAL_MATCH says plainly it is NOT verified, only the last four digits match, and asks the owner to make sure",
    partial.includes("לא אומת") && partial.includes("4 הספרות האחרונות") && !partial.includes("החשבון אומת") && partial.includes("ודאו"));
  check("NOT_IN_FILE says the file does not identify the account, never verified", none.includes("לא מאפשר לזהות את החשבון") && !none.includes("אומת") && none.includes("ודאו"));

  console.log("The fingerprint key missing or malformed: full verification is unavailable, never 'verified'");
  const unavailable = (["VERIFIED_FULL", "PARTIAL_MATCH", "NOT_IN_FILE"] as const).map((c) => client.accountCheckText(c, "UNAVAILABLE"));
  check("every outcome says plainly: אימות מלא של החשבון אינו זמין כרגע", unavailable.every((t) => t.startsWith("אימות מלא של החשבון אינו זמין כרגע")), JSON.stringify(unavailable));
  check("…and none of them says the account was verified (החשבון אומת), even a VERIFIED_FULL that could not be", unavailable.every((t) => !t.includes("החשבון אומת")));
  check("…and each still asks the owner to make sure", unavailable.every((t) => t.includes("ודאו")));
  check("available is the default and unchanged", client.accountCheckText("VERIFIED_FULL", "AVAILABLE") === verified && !verified.includes("אינו זמין"));

  console.log("Refusal texts (Hebrew): never 'save as CSV' or 'change the Excel format'; ask for the original export");
  const codes = ["FILE_UNREADABLE", "HEADER_NOT_FOUND", "MAPPING_INVALID", "TOO_MANY_LINES", "NO_LINES", "FOREIGN_CURRENCY", "CURRENCY_UNVERIFIABLE", "ACCOUNT_NUMBER_MISMATCH", "MULTIPLE_ACCOUNTS_IN_FILE", "CROSS_ACCOUNT_LINES", "ACCOUNT_CONFIRMATION_REQUIRED", "ACCOUNT_CONFIRMATION_MISMATCH"];
  const texts = [
    ...codes.map((c) => client.bankImportErrorText(c)),
    client.bankImportErrorText("CURRENCY_UNVERIFIABLE", { signal: "NO_ILS_EVIDENCE", currency: "UNKNOWN" }),
    client.bankImportErrorText("CURRENCY_UNVERIFIABLE", { signal: "NUMBER_FORMAT", currency: "UNKNOWN" }),
    client.bankImportErrorText("CROSS_ACCOUNT_LINES", { lines: 3, accounts: 1, otherAccounts: "••••8901" }),
    client.bankImportErrorText("ACCOUNT_NUMBER_MISMATCH", { fileLast4: "8999", accountLast4: "8901", basis: "FULL" }),
    client.ACCOUNT_FIX_TEXT,
  ];
  // "שמרו" as a word (an imperative: save it), not inside "נשמרו" (were saved).
  const advisesResave = (t: string) => /(?<![֐-׿])שמרו|לשמור (אותו )?מחדש|פורמט מספר|פורמט רגיל|מחדש כ-?CSV|General/.test(t);
  check("no refusal advises re-saving the file, as CSV or otherwise, or changing a number format", texts.every((t) => !advisesResave(t)), JSON.stringify(texts.filter(advisesResave)));
  check("every text is Hebrew, and no bank is named", texts.every((t) => /[֐-׿]/.test(t) && !/דיסקונט|לאומי|הפועלים|מזרחי|Discount|Leumi|Hapoalim/i.test(t)));
  const noEvidence = client.bankImportErrorText("CURRENCY_UNVERIFIABLE", { signal: "NO_ILS_EVIDENCE" });
  check("CURRENCY_UNVERIFIABLE (no evidence): says no shekel mark was found and asks for the bank's ORIGINAL export, unedited",
    noEvidence.includes("לא מצאנו בקובץ סימון") && noEvidence.includes("ייצוא מקורי מהבנק של דף החשבון, ללא עריכה"), noEvidence);
  check("CURRENCY_UNVERIFIABLE (other signals) asks for the original export too", client.bankImportErrorText("CURRENCY_UNVERIFIABLE").includes("ייצוא מקורי מהבנק"));
  const multi = client.bankImportErrorText("MULTIPLE_ACCOUNTS_IN_FILE");
  check("MULTIPLE_ACCOUNTS_IN_FILE: blocked, one file per account", multi.includes("קובץ נפרד לכל חשבון") && multi.includes("לא נקלט"));
  const cross = client.bankImportErrorText("CROSS_ACCOUNT_LINES", { lines: 3, accounts: 1, otherAccounts: "••••8901" });
  check("CROSS_ACCOUNT_LINES: the count, the other account's masked number, blocked, one file per account — and no confirmation offered",
    cross.startsWith("3 ") && cross.includes("••••8901") && cross.includes("לא נקלט") && cross.includes("קובץ נפרד לכל חשבון") && !cross.includes("אשרו"), cross);
  check("the account fix path is offered after a mismatch, several accounts or cross-account lines — and only then",
    ["ACCOUNT_NUMBER_MISMATCH", "MULTIPLE_ACCOUNTS_IN_FILE", "CROSS_ACCOUNT_LINES"].every(client.needsAccountFix) && !["FOREIGN_CURRENCY", "CURRENCY_UNVERIFIABLE", "TOKEN_INVALID"].some(client.needsAccountFix));
  check("…it points to the bank accounts screen that exists (/payables/cheques) and explains: add again with the exact digits, leading zeros kept, archive the wrong one",
    client.BANK_ACCOUNTS_SCREEN === "/payables/cheques" && client.ACCOUNT_FIX_TEXT.includes("כולל אפסים בתחילת המספר") && client.ACCOUNT_FIX_TEXT.includes("לארכיון"));

  store.delete("token");
  nextResponse = { status: 401, body: {} };
  await client.fetchBankImportOpen();
  check("signed out: no Authorization header is invented", headerOf(calls[calls.length - 1].init, "authorization") === null);

  console.log(`\n${total - failures}/${total} passed`);
  if (failures) process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
