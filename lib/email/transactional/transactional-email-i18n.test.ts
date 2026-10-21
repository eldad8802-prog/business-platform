/**
 * Transactional email in the interface language (i18n B-4, area `system.email`). Pure: no database, no
 * network, nothing is sent.
 *
 *   Hebrew is byte-identical: WELCOME / EMAIL_VERIFY / PASSWORD_RESET rendered for representative payloads
 *   (Hebrew name, no name, a name that needs escaping) — with no locale, "he", and unknown / junk locales —
 *   hash to the SHA-256 of the pre-i18n renderer's output for the same inputs.
 *   "en" renders English: subject + text + HTML, <html lang="en" dir="ltr">, left-aligned, no Hebrew letters,
 *   the same link / CTA target.
 *   Delivery renders in the row's stored locale (delivery.ts passes `locale` from the row).
 *
 * Run: npx tsx lib/email/transactional/transactional-email-i18n.test.ts
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { renderStored } from "./registry";
import { EMAIL_VERIFY_COPY, PASSWORD_RESET_COPY } from "./templates/account-links";
import { WELCOME_CTA_LABEL, WELCOME_LINES, WELCOME_SUBJECT } from "./templates/welcome";

process.env.AUTH_TOKEN_SECRET = "a".repeat(64);

let failed = 0;
let checks = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  checks += 1;
  if (cond) console.log(`  [PASS] ${name}`);
  else {
    failed += 1;
    console.log(`  [FAIL] ${name}`, extra ?? "");
  }
}
const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

const UUID = "0b9d6f3e-2c4a-4f1e-9a7b-3d5c8e1f2a4b";
const CASES: [string, unknown][] = [
  ["WELCOME", { firstName: "דנה" }],
  ["WELCOME", { firstName: null }],
  ["WELCOME", { firstName: `<b>"O'Neil"&` }],
  ["EMAIL_VERIFY", { tokenId: UUID, firstName: "דנה" }],
  ["EMAIL_VERIFY", { tokenId: UUID, firstName: null }],
  ["PASSWORD_RESET", { tokenId: UUID, firstName: "A&B" }],
  ["PASSWORD_RESET", { tokenId: UUID }],
];
const render = (locale?: string | null) =>
  CASES.map(([kind, payload]) => renderStored(kind, payload, { appBaseUrl: "https://app.example.test", ...(locale === undefined ? {} : { locale }) }));

/** The pre-i18n templates' output for CASES (AUTH_TOKEN_SECRET = "a" × 64), as SHA-256 of its JSON. */
const LEGACY_HEBREW_SHA = "b018afa9d2599235d2218abcceeee9d5da94f2b4f2017b7bdf3a384e5d0c8b57";

console.log("Hebrew is byte-identical to the pre-i18n templates");
for (const locale of [undefined, null, "he", "", "fr", "EN", "toString"]) {
  ok(`locale ${JSON.stringify(locale)} → the legacy Hebrew output`, sha(render(locale)) === LEGACY_HEBREW_SHA, sha(render(locale)));
}
ok("exported Hebrew constants are the approved copy",
  WELCOME_SUBJECT === "ברוכים הבאים ל־Dubiz 👋" && WELCOME_CTA_LABEL === "כניסה ל־Dubiz" && WELCOME_LINES.signature === "צוות Dubiz" &&
  EMAIL_VERIFY_COPY.subject === "אימות כתובת האימייל שלך ב־Dubiz" && PASSWORD_RESET_COPY.subject === "בחירת סיסמה חדשה ל־Dubiz");

console.log("English");
{
  const he = render("he");
  const en = render("en");
  en.forEach((r, i) => {
    const kind = CASES[i][0];
    ok(`${kind}#${i}: renders`, r !== null);
    if (!r || !he[i]) return;
    ok(`${kind}#${i}: no Hebrew letters except the owner's own name`,
      ![r.subject, r.text, r.html].some((s) => /[֐-׿]/.test(s.replace(/דנה/g, ""))), r.subject);
    ok(`${kind}#${i}: <html lang="en" dir="ltr">, body and card LTR, left-aligned`,
      r.html.includes('<html lang="en" dir="ltr">') && /<body[^>]*dir="ltr"/.test(r.html) && !r.html.includes('dir="rtl"') && !r.html.includes("text-align:right"));
    const link = (s: string) => s.match(/https:\/\/app\.example\.test\/[^\s"]*/)?.[0];
    ok(`${kind}#${i}: the same link as the Hebrew email`, link(r.text) === link(he[i]!.text) && link(r.html) === link(he[i]!.html));
  });
  ok("WELCOME subject", en[0]?.subject === "Welcome to Dubiz 👋");
  ok("WELCOME greeting with a name", en[0]?.text.startsWith("Hi דנה,"));
  ok("WELCOME greeting without a name", en[1]?.text.startsWith("Hi,"));
  ok("the name is escaped in English too", en[5]?.html.includes("Hi A&amp;B,") === true);
  ok("EMAIL_VERIFY subject", en[3]?.subject === "Verify your email address on Dubiz");
  ok("PASSWORD_RESET subject", en[5]?.subject === "Choose a new password for Dubiz");
  ok("signature", en.every((r) => r?.text.includes("The Dubiz team")));
}

console.log("delivery passes the stored locale");
{
  const src = readFileSync(path.join(process.cwd(), "lib/email/transactional/delivery.ts"), "utf8");
  ok("delivery selects the row's locale", /select: \{[^}]*locale: true/.test(src));
  ok("delivery renders with locale: row.locale", /renderStored\(row\.kind, row\.payload, \{ appBaseUrl: state\.config\.appBaseUrl, locale: row\.locale \}\)/.test(src));
}

console.log(`\n${checks - failed}/${checks} passed`);
if (failed) process.exit(1);
