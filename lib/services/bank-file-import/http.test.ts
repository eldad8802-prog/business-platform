/**
 * Bank file import (B1) — the HTTP form, as the routes read it, with real Request / FormData objects. A browser
 * walkthrough found that the decisions parser refused every row number (its pattern had lost a backslash:
 * /^d+$/), so no file with a suspected duplicate could be committed. The service-level battery never saw it —
 * it calls the service directly. This covers the layer in between.
 *
 * Run: npx tsx lib/services/bank-file-import/http.test.ts
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://unused@localhost:1/unused";

let total = 0;
let failures = 0;
function check(name: string, cond: boolean, extra = ""): void {
  total += 1;
  if (!cond) failures += 1;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra && !cond ? " — " + extra : ""}`);
}

const actor = { businessId: 41, userId: 7 };
function request(fields: Record<string, string | Blob>): Request {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return new Request("http://localhost/api/payables/bank-import/commit", { method: "POST", body: fd });
}
const file = () => new File([new Uint8Array([0x61, 0x62])], "statement.csv");

(async () => {
  const { readImportForm } = await import("./http");
  const codeOf = async (p: Promise<unknown>) => p.then(() => "").catch((e: { code?: string }) => e.code ?? String(e));

  console.log("Decisions on suspected duplicates");
  const ok = await readImportForm(request({ file: file(), accountId: "9", token: "t", decisions: JSON.stringify({ 3: "IMPORT", 12: "SKIP" }) }), actor);
  check("row-number keys are accepted (the lost-backslash bug)", ok.decisions?.[3] === "IMPORT" && ok.decisions?.[12] === "SKIP", JSON.stringify(ok.decisions));
  check("they are numbers after parsing", JSON.stringify(Object.keys(ok.decisions ?? {})) === JSON.stringify(["3", "12"]));
  check("a key that is not a row number is refused", (await codeOf(readImportForm(request({ file: file(), accountId: "9", decisions: JSON.stringify({ d: "IMPORT" }) }), actor))) === "DECISIONS_INVALID");
  check("a negative or fractional row is refused", (await codeOf(readImportForm(request({ file: file(), accountId: "9", decisions: JSON.stringify({ "-1": "SKIP", "2.5": "SKIP" }) }), actor))) === "DECISIONS_INVALID");
  check("a value other than IMPORT / SKIP is refused", (await codeOf(readImportForm(request({ file: file(), accountId: "9", decisions: JSON.stringify({ 3: "MAYBE" }) }), actor))) === "DECISIONS_INVALID");
  check("malformed JSON is refused", (await codeOf(readImportForm(request({ file: file(), accountId: "9", decisions: "{3:" }), actor))) === "DECISIONS_INVALID");
  const none = await readImportForm(request({ file: file(), accountId: "9" }), actor);
  check("no decisions field ⇒ null (the server then demands them if anything is suspected)", none.decisions === null);

  console.log("The rest of the form");
  check("the business and user come from the session actor, never the form", ok.input.businessId === 41 && ok.input.userId === 7);
  check("account and token are read", ok.input.accountId === 9 && ok.token === "t");
  const mapped = await readImportForm(request({ file: file(), accountId: "9", mapping: JSON.stringify({ amount: 3, balance: null }) }), actor);
  check("mapping: a column index, or null to unset a field", mapped.input.mapping?.amount === 3 && "balance" in (mapped.input.mapping ?? {}) && mapped.input.mapping?.balance === undefined);
  check("mapping: a non-integer column is refused", (await codeOf(readImportForm(request({ file: file(), accountId: "9", mapping: JSON.stringify({ amount: "3" }) }), actor))) === "MAPPING_INVALID");
  check("no file ⇒ refused", (await codeOf(readImportForm(request({ accountId: "9" }), actor))) === "FILE_UNREADABLE");
  check("a non-numeric account is read as no account (the service then refuses ACCOUNT_REQUIRED)", (await readImportForm(request({ file: file(), accountId: "abc" }), actor)).input.accountId === null);

  console.log("The owner's confirmation (target account); no cross-account confirmation any more");
  const conf = await readImportForm(request({ file: file(), accountId: "9", token: "t", confirmAccountId: "9", confirmCrossAccount: "4" }), actor);
  check("confirmAccountId is read as a number", conf.confirmedAccountId === 9, JSON.stringify(conf));
  check("a confirmCrossAccount field is IGNORED (lines held under another account are refused; nothing can confirm them)",
    !Object.keys(conf).some((k) => /cross/i.test(k)), JSON.stringify(Object.keys(conf)));
  check("absent ⇒ null (the service then refuses ACCOUNT_CONFIRMATION_REQUIRED)", none.confirmedAccountId === null);
  const junk = await readImportForm(request({ file: file(), accountId: "9", confirmAccountId: "9; 10" }), actor);
  check("anything but digits ⇒ null, never a guess", junk.confirmedAccountId === null);

  console.log("Errors never carry or log an account number, a fingerprint or a key");
  const { bankImportError } = await import("./http");
  const { BankImportError } = await import("./bank-file-import.service");
  const logged: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.map((x) => (x instanceof Error ? x.name + ":" + x.message : String(x))).join(" "));
  try {
    const mismatch = await bankImportError(new BankImportError("ACCOUNT_NUMBER_MISMATCH", 409, { fileLast4: "8999", accountLast4: "8901", basis: "FULL" })).json();
    check("ACCOUNT_NUMBER_MISMATCH answers its code and the two last-four digits only",
      JSON.stringify(mismatch) === JSON.stringify({ error: "ACCOUNT_NUMBER_MISMATCH", details: { fileLast4: "8999", accountLast4: "8901", basis: "FULL" } }), JSON.stringify(mismatch));
    const multi = await bankImportError(new BankImportError("MULTIPLE_ACCOUNTS_IN_FILE", 409, { accounts: 2 })).json();
    check("MULTIPLE_ACCOUNTS_IN_FILE answers how many accounts, never which", JSON.stringify(multi) === JSON.stringify({ error: "MULTIPLE_ACCOUNTS_IN_FILE", details: { accounts: 2 } }), JSON.stringify(multi));
    // An unexpected error whose message holds a full account, a fingerprint and a key (e.g. thrown by a lower layer).
    const key = Buffer.alloc(32, 5).toString("base64");
    const res = bankImportError(new Error("12-345-678901 fp=" + "ab".repeat(32) + " key=" + key));
    const body = await res.json();
    check("an unexpected error answers 500 INTERNAL with no detail", res.status === 500 && JSON.stringify(body) === JSON.stringify({ error: "INTERNAL" }), JSON.stringify(body));
    check("…and its log line holds the error's name only: no account number, no fingerprint, no key",
      logged.length === 1 && !logged[0].includes("678901") && !logged[0].includes("abab") && !logged[0].includes(key), JSON.stringify(logged));
  } finally {
    console.error = realError;
  }

  console.log(`\n${total - failures}/${total} passed`);
  if (failures) process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
