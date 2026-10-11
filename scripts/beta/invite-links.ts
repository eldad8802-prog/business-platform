/**
 * Closed beta — print each tester's personal registration link. OPERATOR-RUN, local only.
 *
 *   SIGNUP_INVITE_SECRET=<the Production secret> SIGNUP_ALLOWED_EMAILS=<the same list as Production> \
 *   APP_BASE_URL=https://promaxgroup.co.il npx tsx scripts/beta/invite-links.ts
 *
 * Reads exactly what the server reads (lib/auth/signup-allowlist.ts, lib/auth/signup-invite.ts) and
 * refuses to print anything when either would be refused there — so a link printed here is a link the
 * server will accept. Each link works for its own address only; send it to that tester alone.
 * Nothing is written, sent or logged anywhere but this terminal. Rotating the secret voids every link.
 */

import { CLOSED_BETA_ACCESS, readSignupAllowlist, parseSignupAllowlist } from "@/lib/auth/signup-allowlist";
import { inviteCodeFor, readSignupInvite, SIGNUP_INVITE_SECRET_ENV, MIN_INVITE_SECRET_LENGTH } from "@/lib/auth/signup-invite";
import { normalizeEmail } from "@/lib/auth/signup-identity";

function main(): number {
  const invite = readSignupInvite();
  if (!invite.configured) {
    console.error(`${SIGNUP_INVITE_SECRET_ENV} is missing or shorter than ${MIN_INVITE_SECRET_LENGTH} characters — the server would admit no one.`);
    return 1;
  }
  const allowlist = readSignupAllowlist();
  if (!allowlist.configured) {
    console.error(`SIGNUP_ALLOWED_EMAILS is missing or invalid (${allowlist.error ?? "empty"}) — the server would admit no one.`);
    return 1;
  }
  const base = (process.env.APP_BASE_URL ?? "").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) {
    console.error("APP_BASE_URL must be the site's origin, e.g. https://promaxgroup.co.il");
    return 1;
  }
  const secret = (process.env[SIGNUP_INVITE_SECRET_ENV] ?? "").trim();
  const emails = (process.env.SIGNUP_ALLOWED_EMAILS ?? "")
    .split(/[,\n\r]/)
    .map((e) => normalizeEmail(e.trim()))
    .filter((e) => e.length > 0);
  // The same parse the server does, so the printed set is exactly the admitted set.
  const parsed = parseSignupAllowlist(emails.join(","));
  for (const email of [...new Set(emails)]) {
    if (!parsed.has(email)) continue;
    const code = inviteCodeFor(email, secret);
    if (!invite.verify(email, code)) throw new Error("self-check failed");
    console.log(`${email}\t${base}/register?access=${CLOSED_BETA_ACCESS}&invite=${code}`);
  }
  return 0;
}

process.exit(main());
