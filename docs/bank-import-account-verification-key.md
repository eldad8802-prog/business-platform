# Bank account verification key (`PAYABLES_BANK_FINGERPRINT_KEY`) — ops instructions

Owner-facing runbook. **No secret value appears in this document, and none may ever be added to it, to a PR,
a commit, a log, an issue or a chat.** Status checks are by variable NAME only (`vercel env ls`), never by value.

## What the key does

`PAYABLES_BANK_FINGERPRINT_KEY` is the HMAC-SHA-256 key of the bank-account fingerprint
(`lib/services/payables/payables-bank-crypto.ts`, `fingerprintBankCoordinates`). The fingerprint is a keyed,
one-way identity of one account: `HMAC(key, "payables-bank-fp:v1" | purpose | businessId | bank | branch | account)`,
with the digits in one canonical form (`canonicalizeBankCoordinates`: digits as text, leading zeros kept, bank 2
digits, branch 3, account 4–13; never padded).

It is used in three places:

| Where | What breaks without a valid key |
|---|---|
| Adding a business bank account (`payables-bank-account.service.ts`, `sealBankCoordinates`) — and a payment destination (`payables-destination.service.ts`) | the account cannot be added (fail closed: the add refuses) |
| "Is this account already here?" (unique per business on `fingerprint`) | — |
| Bank file import, full-account verification (`bank-file-import.service.ts`, `fullAccountVerificationAvailable` / `fullAccountMatcher`) | the screen says **"אימות מלא של החשבון אינו זמין כרגע"**; the account is never shown as verified; only the last four digits are compared |

The fingerprint is also part of the AES-GCM AAD of the stored ciphertext (`coordinatesAad`): a stored row is bound
to the fingerprint it was stored under.

It is a separate key from `PAYABLES_BANK_ENCRYPTION_KEY` (AES-256-GCM, exactly 32 bytes): leaking one does not give
the other's capability. Never reuse either value for anything else, and never set both to the same value.

## Generating a key

- At least **32 random bytes** (the code refuses fewer: `MIN_HMAC_KEY_BYTES`). Use 32.
- Encoded as base64 (or hex, 64+ characters). Generate on a trusted machine, straight into the Vercel prompt —
  not into a file, a chat, a ticket or the clipboard history of a shared machine:

  ```
  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  ```

- One key per environment, generated separately. Never derive one environment's key from another's.

## One key per environment — the Production key never leaves Production

| Environment | Rule |
|---|---|
| Production | its own key; set as a **Production-only** Vercel variable (not "Production, Preview") |
| Preview | either NO key (full verification then shows as unavailable, and bank accounts cannot be added on Preview), or its own separate key generated for Preview only. **Never the Production value.** A Preview deployment is built from any branch, so whatever Preview holds is reachable from branch code. |
| Development / local | a throwaway key, or none |
| CI (GitHub Actions) | none. The lab battery (`.bfi/battery.ts`) and the core tests use synthetic keys created in the process. The key must not be added as a GitHub repository or environment secret. |

This follows the Preview / Production isolation track: the 2026-11-03 branch-exposure audit found other variables
(`AUTH_TOKEN_SECRET`, R2, Upstash) stored as one entry for "Production, Preview", so every Preview build holds the
Production value; milestone M1 of that track splits them. That track owns those changes; this document changes
nothing there. Apply the same rule here: a single "Production, Preview" entry for this key is a finding, to be
split into separate values.

### State on 2026-11-03 (read-only, names only)

`vercel env ls` on the `business-platform` project: `PAYABLES_BANK_FINGERPRINT_KEY` — one entry, scoped
**Production** only (created 42 days earlier); same for `PAYABLES_BANK_ENCRYPTION_KEY`. No Preview or Development
entry, so the Production value is **not** shared with Preview. On Preview, full account verification therefore
reports unavailable, and adding a bank account fails closed. Nothing was changed.

To re-check (names and scopes only; never `vercel env pull` or any command that prints values):

```
vercel env ls | grep PAYABLES_BANK_
```

## Who may set or change it

The owner only, in the Vercel project settings (or `vercel env add PAYABLES_BANK_FINGERPRINT_KEY production`).
Agents and automation do not set, change, pull or print it. A change takes effect on the next deployment.

## Rotation — what changes, what breaks

There is **no dual-key support** today (no `_NEXT` key, no key id on the fingerprint). Every fingerprint stored
under the old key stays as it was; every fingerprint computed after the change uses the new key. So, from the
first deployment with a new key until every stored row is re-fingerprinted:

1. **Bank file import:** a file that prints the full account (bank, branch, account) is compared with the stored
   fingerprint and no longer matches, so it is **refused as ACCOUNT_NUMBER_MISMATCH** (basis FULL) — even for the
   right account. Files that print only the last four digits, or no number, still work (never "verified").
2. **Duplicate accounts:** adding an account that already exists is no longer detected (the new fingerprint differs
   from the stored one), so the same account can be added twice.
3. **Decryption keeps working:** decrypt uses the fingerprint stored in the row as AAD, so the owner can still see
   their own account. That is what makes re-fingerprinting possible at all.

Re-fingerprint plan (to be written and reviewed as its own change before any rotation; not part of this PR):

- one maintenance job, owner-approved, per environment: for every `BusinessBankAccount` and `PaymentDestination`
  row, decrypt with the encryption key (AAD = old fingerprint), recompute the fingerprint under the new key, and
  re-encrypt with the new fingerprint in the AAD (the AAD binding means the ciphertext must be re-sealed, not only
  the fingerprint column);
- inside one transaction per business, with the unique index checked (two rows that collide under the new key were
  the same account all along: stop and report, never merge automatically);
- with the old and the new key both available to the job only, never logged;
- while it runs, bank file import refuses full-number files (point 1) — announce the window, or run it when no
  import is expected;
- afterwards: a read-only count of rows whose fingerprint was recomputed, and a synthetic full-account import proof.

Rotate only for cause (suspected exposure of the key). A routine rotation buys little: the key protects an
enumerable input (bank + branch + account), so what matters is that it never leaves Production.

## If the key is missing or malformed in Production

- Bank file import: no import is refused for this reason; the screen says plainly that full verification is
  unavailable, compares the last four digits only, and the owner confirms the account.
- Adding bank accounts and payment destinations: refused until the key is restored.
- Restore the SAME value (from the owner's secret store). Generating a new one is a rotation (above).
