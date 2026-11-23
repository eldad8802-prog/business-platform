# 4a T1 → transition wiring: contract for the legal identity track

**For:** the legal identity session (f3), which owns `business_kind_transition_to_authorized()` and the
"מעבר לעוסק מורשה" API/UI. **From:** 4a (billing / issuer declaration), 2026-11-23.
**Status:** this file approves nothing. The T1/T1a migrations are a Draft; the wiring below needs its own migration,
approval record and release slot.

## 1. What 4a provides (migrations 20261223090000 + 20261223100000)

`public.issuer_declaration_status_change(p_user_id int, p_vat_number text, p_reauth_method text,
p_reauth_at timestamptz, p_statement_version text, p_statement_sha256 text) RETURNS text`

- SECURITY DEFINER, owned by the table owner. **No role has EXECUTE.** Only another definer function owned by the
  same role (the transition) can call it.
- Reads the tenant from `app.current_business_id`. Writes only inside the caller's transaction.
- On success it inserts declaration version+1: `kind STATUS_CHANGE`, `track AUTHORIZED_DEALER_INDIVIDUAL`,
  `vatStatus AUTHORIZED`, `vatRegistrationNumber = p_vat_number`, `effectiveFrom = now()`. Every other issuer field
  is copied from the current record. It returns `DECLARED`.
- Otherwise it returns a status and writes nothing:
  - `NOT_ALLOWED` — no tenant, or the user is not in the business;
  - `REAUTH_REQUIRED` — the method is not PASSWORD/GOOGLE, or the re-auth is more than 10 minutes old or in the future;
  - `STATEMENT_INVALID` — the version ≠ `kind-transition-exempt-to-authorized-v1`, or the digest is not 64 hex;
  - `NO_LIVE_DECLARATION` — none, or the latest is anonymised;
  - `DECLARATION_NOT_EXEMPT`;
  - `NOT_AUTHORIZED_USER` — the user ≠ the current record's `authorizedUserId`;
  - `IDENTITY_MISMATCH` — the profile kind/name/id differs from the record;
  - `VAT_NUMBER_INVALID` — ≠ the id number, or a bad check digit;
  - `DECLARATION_NOT_YET_EFFECTIVE`.
- The `BusinessIssuerDeclaration_status_change_origin` trigger refuses any STATUS_CHANGE insert not made by the
  table owner (DZD33 `ISSUER_STATUS_CHANGE_ONLY_BY_TRANSITION`).
- T1a: `IssuerReauthMethod` gains `GOOGLE`, so a Google re-auth can be recorded on the declaration.

## 2. What the follow-up migration must do (exact shape: `.billing-4a/t1-wiring.proposed.sql`)

In `business_kind_transition_to_authorized`:

1. **Remove** the early `ISSUER_DECLARATION_ACTIVE` refusal.
2. **After** the `STATEMENT_STALE` check, and **before** inserting `BusinessKindTransition` and updating the profile:
   ```sql
   SELECT * INTO d FROM public."BusinessIssuerDeclaration" WHERE "businessId" = v_business ORDER BY "version" DESC LIMIT 1;
   IF d."id" IS NOT NULL AND d."anonymisedAt" IS NULL THEN
     v_decl := public.issuer_declaration_status_change(
                 p_user_id, p_vat_number, p_reauth_method, p_reauth_at, 'kind-transition-exempt-to-authorized-v1', v_sha);
     IF v_decl IS DISTINCT FROM 'DECLARED' THEN RETURN 'ISSUER_DECLARATION_' || coalesce(v_decl, 'UNKNOWN'); END IF;
   END IF;
   ```
3. Keep everything else byte-identical: checks, advisory lock, history row, profile update, DZL07.
4. Pass the transition's own `v_sha` (computed from the profile), never a value from the request.

Invariants the lab proved with this exact shape (`.billing-4a/t1-status-change.battery.mts`, section W, 25/25):

- v2 and the history row carry the same digest, re-auth method and instant.
- v2 `effectiveFrom` = `confirmedAt`.
- v1 is byte-identical.
- The profile and v2 agree, so DZD35 holds.
- A fault after v2 rolls back everything, and the same business can transition afterwards.
- Six parallel requests produce exactly one transition and one v2.
- A Google-only declared owner gets GOOGLE recorded on both rows.

## 3. Application changes the legal identity track owns

- `lib/legal-identity/kind-transition.ts`:
  - `evaluateKindTransitionEligibility` must stop blocking on `hasLiveIssuerDeclaration`.
  - `kindTransitionOutcome` must map the new statuses:
    - `ISSUER_DECLARATION_NOT_AUTHORIZED_USER` → 409;
    - `ISSUER_DECLARATION_IDENTITY_MISMATCH` → 409;
    - `ISSUER_DECLARATION_DECLARATION_NOT_EXEMPT` → 409;
    - `ISSUER_DECLARATION_DECLARATION_NOT_YET_EFFECTIVE` → 409, "try again in a few minutes";
    - the other `ISSUER_DECLARATION_*` statuses → 500. They are unreachable after the transition's own checks.
  - Hebrew texts: owner-approved wording.
- Tests: `lib/legal-identity/kind-transition.test.ts` E6 and `.bkt/battery.ts` K3 expect `ISSUER_DECLARATION_ACTIVE`
  today and must change with the wiring.
- `.bkt/lab.sh` must stage 20261223090000 and 20261223100000 (or run on `.billing-4a/lab.sh --with-t1`).

## 4. Release order (one release at a time; `release-migrate` applies every pending migration)

1. Pending in Production before any of this: 20261216090000 (#1207) and 20261222090000 (#1224), each with its owner.
2. 20261223090000 + 20261223100000 (this PR). Inert: no caller.
3. The legal identity follow-up (wiring), in a later release, then the application changes from §3.
4. Before the flag: an integrated test on the real migration, plus a Preview with a real Google account and a
   physical phone.

## 5. Still 4a's (not part of this contract)

- The issuer-declaration status screen labels `KIND_LABEL` in `app/billing/issuer-declaration/shared.tsx` (A0).
  Without a `STATUS_CHANGE` entry it falls back to showing the raw code; owner approval is needed (G1).
- T2, T3 and T4 are gates.
