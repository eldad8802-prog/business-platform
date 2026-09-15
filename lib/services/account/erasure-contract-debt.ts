/**
 * ERASURE CONTRACT — the debt this guard found on the tree the day it was written.
 *
 * A new guard that goes green on its first run has proven nothing. This one does not.
 * Sixteen findings, of which three were already known from the residual-data sweep and
 * thirteen were not. Every entry below is a real disagreement between the schema, the
 * manifest and the adapter, now visible instead of silent.
 *
 * This file is a RATCHET, not a mute:
 *
 *   an entry here that still fails    → known, reported, deferred on purpose
 *   an entry here that now passes     → the build FAILS until it is removed, so an
 *                                       improvement is locked in and cannot regress
 *   a failure NOT listed here         → the contract broke somewhere new. Build FAILS.
 *
 * Nothing is listed because it is inconvenient. Everything here is deferred to a named
 * increment, and deliberately NOT fixed in the increment that built the guard: shipping
 * the guard and the fixes together would leave no way to tell whether the evidence was
 * about the guard working or about the fixes working.
 *
 * `npm run verify:erasure-contract` with no flag ignores this file entirely and shows
 * the real state. That mode is the truth; this one is the schedule.
 */

export type DebtEntry = { code: string; key: string; why: string };

/** Naming drift. Prisma Client uncapitalizes only the FIRST character, so the
 *  delegates are `oAuthToken` and `pOSApiKey`. The manifest guessed `oauthToken` and
 *  `posApiKey`, which are not the client's names for anything. Harmless at runtime
 *  today only because nothing ever resolved these strings against the client.
 *  → deferred to E2, because correcting them changes what `assertManifestSafe` and the
 *    I-8A firewall are comparing, and that deserves its own evidence. */
const NAMING: DebtEntry[] = [
  {
    code: "C1-NO-SUCH-MODEL",
    key: "REVOKE_INTEGRATIONS:oauthToken",
    why: "manifest says `oauthToken`; the Prisma delegate is `oAuthToken`. E2.",
  },
  {
    code: "C1-NO-SUCH-MODEL",
    key: "REVOKE_INTEGRATIONS:posApiKey",
    why: "manifest says `posApiKey`; the Prisma delegate is `pOSApiKey`. E2.",
  },
  {
    code: "C2-NO-SUCH-FIELD",
    key: "Lead.name",
    why:
      "the manifest declares `lead.name`; the column is `customerName`. The adapter " +
      "clears the right column, so this is a wrong name in the contract rather than " +
      "wrong behaviour. E2.",
  },
];

/** The finding the residual sweep was built around. The contract promises the lead's
 *  email address is erased. The code does not erase it. This is the one entry here
 *  that is a live personal-data exposure rather than a naming or coverage gap.
 *  → deferred to E2 ONLY because this increment is forbidden from changing product
 *    behaviour; it is the first thing E2 should close. */
const UNKEPT_PROMISE: DebtEntry[] = [
  {
    code: "C3-DECLARED-NOT-IMPLEMENTED",
    key: "Lead.email",
    why: "the manifest promises it is nulled and the adapter never writes it. E2, first.",
  },
];

/** Erasure the adapter performs that no contract represents. None of these is wrong
 *  behaviour — every one of them is a credential being destroyed, which is exactly what
 *  should happen. What is missing is the declaration, so the manifest under-describes
 *  what the deletion actually does.
 *  → deferred to E2: each needs a manifest entry, and `REVOKE_INTEGRATIONS` needs a
 *    shape that can express "delete the row" as well as "clear these columns". */
const UNDECLARED: DebtEntry[] = [
  {
    code: "C4-UNDECLARED-DELETE",
    key: "OAuthToken.*",
    why:
      "the adapter deletes the rows; the manifest describes clearing `accessToken` and " +
      "`refreshToken` instead. Deleting is stronger, and undeclared. E2.",
  },
  {
    code: "C4-UNDECLARED-DELETE",
    key: "POSApiKey.*",
    why:
      "the adapter deletes the rows because `keyHash` is globally unique and a constant " +
      "would collide across two deletions. Correct, and undeclared. E2.",
  },
  {
    code: "C4-UNDECLARED-MUTATION",
    key: "BusinessPaymentConnection.isActive",
    why: "the adapter deactivates the connection; `set` in the manifest is empty. E2.",
  },
  {
    code: "C4-UNDECLARED-MUTATION",
    key: "WhatsAppConnection.accessTokenEncrypted",
    why: "the token ciphertext IS destroyed; the manifest's `clear` list is empty. E2.",
  },
  {
    code: "C4-UNDECLARED-MUTATION",
    key: "WhatsAppConnection.accessTokenIv",
    why: "as accessTokenEncrypted. E2.",
  },
  {
    code: "C4-UNDECLARED-MUTATION",
    key: "WhatsAppConnection.accessTokenTag",
    why: "as accessTokenEncrypted. E2.",
  },
  {
    code: "C4-UNDECLARED-MUTATION",
    key: "EmailConnection.lastSyncCursor",
    why: "the sync cursor is cleared; the manifest's `clear` list is empty. E2.",
  },
];

/** Columns with an explicit disposition that the adapter does not carry out. These are
 *  the residual-sweep P1 findings for `Lead`, now expressed as contract violations
 *  rather than prose in a report.
 *  → deferred to E2. Listing them as debt is the point: the disposition is the decision,
 *    and the guard now holds us to it. */
const LEAD_RESIDUALS: DebtEntry[] = [
  {
    code: "C6-DISPOSITION-NOT-IMPLEMENTED",
    key: "Lead.customerId",
    why: "dispositioned UNLINK; the pointer to the anonymised customer is left in place. E2.",
  },
  {
    code: "C6-DISPOSITION-NOT-IMPLEMENTED",
    key: "Lead.email",
    why: "dispositioned ERASE; same gap as the C3 entry, seen from the disposition side. E2.",
  },
  {
    code: "C6-DISPOSITION-NOT-IMPLEMENTED",
    key: "Lead.intentSnapshot",
    why: "dispositioned ERASE; free text derived from the exchange survives. E2.",
  },
  {
    code: "C6-DISPOSITION-NOT-IMPLEMENTED",
    key: "Lead.followUpNote",
    why: "dispositioned ERASE; free text about a named person survives. E2.",
  },
  {
    code: "C6-DISPOSITION-NOT-IMPLEMENTED",
    key: "Lead.lostReason",
    why: "dispositioned ERASE; free text that routinely quotes the objection survives. E2.",
  },
];

export const ACCEPTED_DEBT: DebtEntry[] = [
  ...NAMING,
  ...UNKEPT_PROMISE,
  ...UNDECLARED,
  ...LEAD_RESIDUALS,
];

/** Findings and debt entries are matched on code + key, never on the prose detail, so
 *  improving a message never silently re-arms an accepted entry. */
export function debtKey(d: { code: string; key: string }): string {
  return `${d.code}::${d.key}`;
}
