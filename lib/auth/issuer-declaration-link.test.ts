/**
 * Issuer-declaration link — the pure suite (no database, no network):
 *   npx tsx lib/auth/issuer-declaration-link.test.ts
 *
 *   1. the purpose: its own derived secrets (a link of another purpose never passes), its confirmation path;
 *   2. consume refuses before the database: garbage, another purpose's secret, a malformed digest, no account;
 *      and maps only the function's own statuses (anything else → INVALID), passing exactly its arguments;
 *   3. request refuses a malformed digest before the database;
 *   4. the email: the payload is exactly { tokenId, firstName, legalName, legalForm } — an ID, VAT / dealer /
 *      company number, address or phone cannot be carried; the rendered email shows the legal name and form,
 *      the 30-minute limit and the link, escapes the name, and contains none of a fixture's identifiers;
 *   5. the registry: the kind, its 30-minute lifetime (inside the provider's idempotency window).
 * The database rules (binding, business, account, expiry, single use, rollback, privileges) are proved by the
 * migration lab (.aid/battery.ts, .aid/library-battery.ts).
 */

process.env.AUTH_TOKEN_SECRET = "c".repeat(64);

import { randomUUID } from "node:crypto";

import { EMAIL_LINK_PATHS, deriveLinkSecret, isDerivedSecret } from "@/lib/auth/email-link";
import {
  consumeIssuerDeclarationLink,
  isStatementSha256,
  requestIssuerDeclarationLink,
} from "@/lib/auth/issuer-declaration-link";
import { EMAIL_KINDS, ISSUER_DECLARATION_TTL_MS, PROVIDER_IDEMPOTENCY_WINDOW_MS, issuerDeclarationDedupeKey, renderStored } from "@/lib/email/transactional/registry";
import { parseIssuerDeclarationPayload } from "@/lib/email/transactional/templates/issuer-declaration";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) { passed += 1; console.log(`  ok  - ${name}`); }
  else { failed += 1; console.error(`FAIL  - ${name}${detail ? `\n        ${detail}` : ""}`); }
}

/** A fake tenant tx: records each $queryRaw call (its values) and answers with `answer`. */
function fakeTx(answer: string | undefined) {
  const calls: unknown[][] = [];
  return {
    calls,
    tx: {
      $queryRaw: (async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push(values);
        return answer === undefined ? [] : [{ s: answer }];
      }) as never,
    },
  };
}

const DIGEST = "a".repeat(64);
const id = randomUUID();
const token = `${id}.${deriveLinkSecret(id, "ISSUER_DECLARATION")}`;

async function main() {
  console.log("1. the purpose");
  ok("its confirmation page is billing's path", EMAIL_LINK_PATHS.ISSUER_DECLARATION === "/billing/issuer-declaration/confirm");
  ok("its secrets are its own: a password-reset secret for the same id is not an issuer-declaration secret",
    deriveLinkSecret(id, "ISSUER_DECLARATION") !== deriveLinkSecret(id, "PASSWORD_RESET") &&
      !isDerivedSecret(id, deriveLinkSecret(id, "PASSWORD_RESET"), "ISSUER_DECLARATION") &&
      isDerivedSecret(id, deriveLinkSecret(id, "ISSUER_DECLARATION"), "ISSUER_DECLARATION"));
  ok("the digest is 64 lowercase hex, nothing else",
    isStatementSha256(DIGEST) && !isStatementSha256("A".repeat(64)) && !isStatementSha256("a".repeat(63)) && !isStatementSha256(null));

  console.log("2. consume");
  for (const [label, input] of [
    ["garbage token", { token: "nope", userId: 7, statementSha256: DIGEST }],
    ["another purpose's secret", { token: `${id}.${deriveLinkSecret(id, "EMAIL_VERIFY")}`, userId: 7, statementSha256: DIGEST }],
    ["a malformed digest", { token, userId: 7, statementSha256: "xyz" }],
    ["no account", { token, userId: Number.NaN, statementSha256: DIGEST }],
  ] as const) {
    const f = fakeTx("CONFIRMED");
    ok(`${label} → INVALID, the database never asked`, (await consumeIssuerDeclarationLink(f.tx, input as never)) === "INVALID" && f.calls.length === 0);
  }
  for (const s of ["CONFIRMED", "USED", "SUPERSEDED", "EXPIRED", "BINDING_MISMATCH", "INVALID"]) {
    const f = fakeTx(s);
    ok(`the function's ${s} is returned as is`, (await consumeIssuerDeclarationLink(f.tx, { token, userId: 7, statementSha256: DIGEST })) === s);
  }
  const odd = fakeTx("SOMETHING_ELSE");
  ok("an unknown answer → INVALID", (await consumeIssuerDeclarationLink(odd.tx, { token, userId: 7, statementSha256: DIGEST })) === "INVALID");
  const none = fakeTx(undefined);
  ok("no row → INVALID", (await consumeIssuerDeclarationLink(none.tx, { token, userId: 7, statementSha256: DIGEST })) === "INVALID");
  const args = fakeTx("CONFIRMED");
  await consumeIssuerDeclarationLink(args.tx, { token, userId: 7, statementSha256: DIGEST });
  ok("exactly the token id, its secret, the account and the digest reach the function",
    JSON.stringify(args.calls[0]) === JSON.stringify([id, deriveLinkSecret(id, "ISSUER_DECLARATION"), 7, DIGEST]), JSON.stringify(args.calls[0]));

  console.log("3. request");
  ok("a malformed digest → NOT_ISSUED before any database call",
    (await requestIssuerDeclarationLink({ userId: 7, businessId: 9, statementSha256: "short", legalName: "x", legalForm: "LTD_COMPANY", now: new Date() })).status === "NOT_ISSUED");

  console.log("4. the email");
  const payload = { tokenId: id, firstName: "דנה", legalName: "מאפיית דנה <b>בע״מ</b>", legalForm: "LTD_COMPANY" };
  ok("the payload parses with exactly its four fields", parseIssuerDeclarationPayload(payload) !== null);
  for (const extra of ["idNumber", "taxId", "vatNumber", "address", "phone", "email"]) {
    ok(`a payload carrying ${extra} is refused`, parseIssuerDeclarationPayload({ ...payload, [extra]: "515123456" }) === null);
  }
  ok("an unknown legal form is refused", parseIssuerDeclarationPayload({ ...payload, legalForm: "OTHER" }) === null);
  ok("an empty or overlong legal name is refused",
    parseIssuerDeclarationPayload({ ...payload, legalName: " " }) === null && parseIssuerDeclarationPayload({ ...payload, legalName: "x".repeat(121) }) === null);
  const r = renderStored("ISSUER_DECLARATION", payload, { appBaseUrl: "https://app.example.test" });
  ok("it renders", r !== null);
  if (r) {
    ok("the subject names the declaration", r.subject.includes("הצהרת המנפיק"));
    ok("it shows the legal name and the legal form's Hebrew name", r.text.includes("מאפיית דנה") && r.text.includes("חברה בע״מ"));
    ok("it states the 30-minute, single-use limit", r.text.includes("30 דקות") && r.text.includes("לשימוש אחד"));
    ok("the link goes to billing's page with the token in the fragment",
      r.text.includes(`https://app.example.test/billing/issuer-declaration/confirm#t=${id}.`) && r.html.includes("/billing/issuer-declaration/confirm#t="));
    ok("the legal name is escaped in the HTML", r.html.includes("&lt;b&gt;") && !r.html.includes("<b>בע״מ</b>"));
    ok("Hebrew, right to left", /<html lang="he" dir="rtl"/.test(r.html));
    const fixtureIds = ["515123456", "039999999", "רחוב הרצל 1", "050-1234567"];
    ok("none of a business's identifiers appear (none can be passed in)", fixtureIds.every((x) => !r.text.includes(x) && !r.html.includes(x)));
  }

  console.log("5. the registry");
  ok("the kind exists with a 30-minute lifetime inside the provider window",
    "ISSUER_DECLARATION" in EMAIL_KINDS && ISSUER_DECLARATION_TTL_MS === 30 * 60_000 && ISSUER_DECLARATION_TTL_MS <= PROVIDER_IDEMPOTENCY_WINDOW_MS);
  ok("one email per issued link (the token id names it)", issuerDeclarationDedupeKey(id) === `issuer_declaration:token:${id}`);

  console.log(`\n[issuer-declaration-link] ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
