/**
 * The terms text an owner accepts at signup, identified by the "last updated"
 * dates printed on the two public pages. Recorded on the account as
 * `User.termsVersion` next to `termsAcceptedAt`.
 *
 * `consent-version.test.ts` reads both pages and fails when either date moves
 * without this constant moving with it — otherwise accounts would be recorded
 * as accepting a text they never saw.
 */
export const TERMS_LAST_UPDATED = "2026-06-04";
export const PRIVACY_LAST_UPDATED = "2026-09-06";

export const CURRENT_TERMS_VERSION = `terms:${TERMS_LAST_UPDATED}+privacy:${PRIVACY_LAST_UPDATED}`;
