# CASA 3.3.1 — Platform Admin MFA Evidence

**Status:** control implemented, enforced in Production, and evidenced.
**Wave:** CASA Wave B (closed 2026-09-01).
**Scope of this document:** evidence preservation only. It records what was
proven, and — just as deliberately — what was not.

This memo contains no secret material: no TOTP value, recovery code, seed,
provisioning URI, encryption key, elevation token, password or session token
appears anywhere in it, by construction.

---

## Control objective

The asset being protected is **cross-tenant platform-operator access**. A
platform administrator can read and act across every business on the platform:
list and inspect tenants, read the platform audit trail, change per-business
feature access, run diagnostics, and target another tenant in the Tax Authority
OAuth start path. A single stolen or replayed admin session token would
otherwise be sufficient for all of it.

The control is a **two-factor model with separated proofs**:

1. **Identity** — an ordinary authenticated session (stateless bearer token)
   whose subject holds the `PLATFORM_ADMIN` role and appears in the
   `PLATFORM_ADMIN_EMAILS` allowlist. This alone is *not* sufficient.
2. **Elevation** — a short-lived, signed, user-bound proof derived from a
   freshly presented RFC 6238 TOTP code, carried per-request in the
   `x-admin-elevation` header.

Possession of the session token alone does not grant privileged access while
enforcement is on. The two proofs are also stored differently on the client
(see *Enforcement architecture*), so compromising one store does not yield the
other.

---

## Production status

| Fact | Value |
| --- | --- |
| Enforcement flag | `PLATFORM_ADMIN_MFA_REQUIRED=true` |
| Flag scope | Vercel target `production` **only** (absent from preview and development) |
| Flag created | 2026-09-01T20:22:52.883Z, unchanged since |
| Application SHA | `c7f62fd` (`origin/main`) |
| Canonical Production deployment | `dpl_9pJhz4zZRMHTwb91dt6KS4EwcnnV` |
| Deployment state | `READY`, `source=cli`, `action=redeploy` of `dpl_Ge5Vqxzy5Rgp11evsq71bM1a76ho` |
| Redeploy source | verified in real time to be the newest Production deployment **and** `meta.githubCommitSha == origin/main` before the rebuild |
| Domain | `promaxgroup.co.il` aliased to that deployment |
| Env-snapshot proof | build started 2026-09-01T20:23:36.538Z, **after** the flag was written at 20:22:52.883Z |

The env-snapshot check matters and is not ceremonial: on Vercel, environment
variables are captured into the build. A deployment built before the flag
existed would serve unenforced code while the dashboard showed the flag set.
The build-after-env assertion is what rules that out.

Exactly one environment variable was added (project total 38 → 39). No other
variable was created, modified or rotated.

---

## Enrollment control

Implementation: [`lib/auth/admin-mfa.service.ts`](../lib/auth/admin-mfa.service.ts),
[`lib/auth/admin-mfa-crypto.ts`](../lib/auth/admin-mfa-crypto.ts).

- **Algorithm.** RFC 6238 TOTP via `otpauth`, parameters `SHA1 / 6 digits /
  30-second period`, issuer `Dubiz`. These are the interoperable defaults every
  authenticator app expects. TOTP's SHA-1 use is HMAC-based and unaffected by
  SHA-1 collision attacks; deviating would break authenticator compatibility
  without adding strength.
- **Server-generated seed.** 160-bit (`OTPAuth.Secret({ size: 20 })`), generated
  server-side and never accepted from a client.
- **Provisioning URI returned exactly once**, at enrollment start. No route
  re-exposes it. Losing it requires re-enrollment, by design.
- **Enrollment is not complete until a real code is proven.** `enrolledAt`
  remains `NULL` until `POST /api/platform-admin/mfa/confirm` validates a live
  code. MFA cannot become active on an authenticator the admin does not
  actually hold — which is what makes a two-stage rollout safe.
- **Seed encrypted at rest** with AES-256-GCM (authenticated encryption) in the
  envelope `gcm_v1:<b64 iv>.<b64 tag>.<b64 ciphertext>`, with `encryptionKeyId`
  persisted alongside for forward key rotation. IV 12 bytes, tag 16 bytes.
- **Dedicated key separation.** The seed is encrypted under
  `ADMIN_MFA_ENCRYPTION_KEY` — deliberately *not* `AUTH_TOKEN_SECRET` (which
  signs session envelopes and is rotated to invalidate sessions) and *not*
  `GMAIL_TOKEN_ENCRYPTION_KEY` (which protects Google user data). Rotating a
  session secret must never make an enrolled authenticator unreadable.
- **Fails closed.** A missing or malformed key raises rather than degrading to
  plaintext or a weaker mode; the enroll route returns `503 MFA_NOT_CONFIGURED`
  instead of persisting a seed it cannot protect.
- **No plaintext seed persisted.** The only seed column is `secretEncrypted`.
  Verified read-only in Production: envelope prefix `gcm_v1:`, length 93, whose
  ciphertext component is exactly 32 bytes. AES-GCM preserves plaintext length,
  so the stored plaintext is exactly a 32-character Base32 seed — no second
  copy, no padding, nothing else.
- **Replay state persisted.** The accepted time-step is written to
  `lastUsedStep`; any step at or below it is refused.
- **Recovery material stored as hashes only.** Ten single-use codes, SHA-256
  hex digests, compared in constant time.

---

## Enforcement architecture

Server: [`lib/auth/platform-admin.ts`](../lib/auth/platform-admin.ts),
[`lib/auth/platform-admin-elevation.ts`](../lib/auth/platform-admin-elevation.ts).
Browser: [`lib/platform-admin/fetch-platform-admin.ts`](../lib/platform-admin/fetch-platform-admin.ts),
[`lib/platform-admin/admin-elevation.ts`](../lib/platform-admin/admin-elevation.ts),
[`components/platform-admin/admin-step-up-dialog.tsx`](../components/platform-admin/admin-step-up-dialog.tsx).

- **Guard split.** `requirePlatformAdminIdentity` establishes identity only;
  `requirePlatformAdmin` additionally requires a valid elevation whenever
  `isPlatformAdminMfaRequired()` is true, and otherwise throws
  `ForbiddenError` with code `ADMIN_MFA_REQUIRED`.
- **Signed elevation.** An HMAC envelope keyed by a purpose-derived subkey of
  the canonical server secret. Purpose string `platform-admin-elevation`, so an
  envelope minted for any other purpose cannot be replayed here.
- **User binding.** The envelope carries `sub`, the authenticated user id, and
  verification rejects a mismatch. An elevation minted for one admin cannot
  elevate another.
- **Bounded lifetime.** `ADMIN_ELEVATION_TTL_SECONDS = 15 * 60` — 900 seconds,
  enforced server-side by the envelope's `exp`.
- **Drift and replay.** TOTP acceptance window is ±1 step (±30 s), the standard
  clock-drift allowance; anything wider materially extends how long an observed
  code stays usable. An accepted code's step is persisted, so a code observed
  over the shoulder or in a proxy log cannot be reused even inside its own
  30-second window.
- **Browser step-up flow.** Every privileged call from the console goes through
  one request core. On `403` + `ADMIN_MFA_REQUIRED` it clears whatever elevation
  was refused, raises a focused prompt, exchanges the code at
  `POST /api/platform-admin/mfa/verify`, and retries the original request
  **exactly once**. A second refusal is surfaced, never re-prompted, so a
  persistently refusing server cannot produce a prompt loop.
- **Elevation client storage: process memory only.** Not `localStorage`, not
  `sessionStorage`. The session bearer token lives in `localStorage` because the
  application is a stateless-token architecture — but the elevation is the
  *second* factor. Persisting it in the same store, readable by the same
  scripts, would collapse two factors into one and defeat this control.
- **A full page refresh discards the elevation** and forces a new challenge.
  This is a deliberate consequence of memory-only storage, and it was observed
  in Production (see below).
- **The code itself is never retained**: not logged, not stored, never placed in
  a URL or query string, and dropped from component state immediately after
  submission. A failed verification does **not** route the admin into
  re-enrollment.

---

## Privileged surface inventory

Canonical Wave B classification, re-derived from the merged code at `c7f62fd`:
**16 routes touch the guard = 11 mandatory-elevation + 4 identity-only + 1
signal-only.**

### Mandatory-elevation (11)

| Route | Reaches MFA gate in current Production |
| --- | --- |
| `GET /api/platform-admin/overview` | yes |
| `GET /api/platform-admin/attention` | yes |
| `GET /api/platform-admin/audit` | yes |
| `GET /api/platform-admin/businesses` | yes |
| `GET /api/platform-admin/businesses/[id]` | yes |
| `GET /api/platform-admin/businesses/[id]/features` | yes |
| `GET /api/platform-admin/usage/overview` | yes |
| `POST /api/platform-admin/diagnostics/tax-authority-token-probe` | yes |
| `GET /api/dev/learning-center` | yes |
| `PATCH /api/platform-admin/businesses/[id]/features/[featureKey]` | **no — earlier gate** |
| `POST /api/integrations/whatsapp/connection` | **no — earlier gate** |

### The two earlier-gated routes

Two of the eleven are classified mandatory-elevation in code but **cannot be
observed producing an MFA challenge in current Production**, because a gate that
runs *before* the admin guard disables the capability outright:

- `PATCH /api/platform-admin/businesses/[id]/features/[featureKey]` —
  `isFeatureAccessMutationsEnabled()` returns `503` before
  `requirePlatformAdminOrResponse` is called. The BusinessFeatureAccess mutation
  control plane is dormant in Production.
- `POST /api/integrations/whatsapp/connection` —
  `WHATSAPP_MANUAL_SEED_ENABLED !== "1"` returns `404` ("pretend the route does
  not exist when disabled") before the admin guard.

These are **not** runtime-observed MFA challenges and are not presented as such.
The protected capabilities themselves are disabled before the MFA guard is
reached, so there is currently no privileged action there for MFA to protect.
If either capability is enabled in future, the guard behind it applies
unchanged and the route becomes observable.

### Identity-only by design (4)

`GET /api/platform-admin/session`, `POST /api/platform-admin/mfa/enroll`,
`POST /api/platform-admin/mfa/confirm`, `POST /api/platform-admin/mfa/verify`.

Elevation cannot be a precondition for *obtaining* elevation, so these four
require identity only. They remain gated on an authenticated, allowlisted
`PLATFORM_ADMIN`: an ordinary business user cannot reach them, and in
particular cannot bootstrap platform-admin MFA for themselves. The exemption is
pinned in CI by `CI3_IDENTITY_ONLY_ALLOWLIST` in
[`scripts/ci/admin-boundary-guard.sh`](../scripts/ci/admin-boundary-guard.sh),
so a fifth route cannot quietly join the identity-only set.

### Signal-only (1)

`GET /api/taxes/oauth/connect` consumes `hasAdminElevation()` as an input rather
than as a gate. It gates **cross-tenant targeting only**: connecting on behalf
of a business other than the caller's requires `PLATFORM_ADMIN` *and* a proven
second factor. The self-service path (no `businessId` requested) is unaffected
by enforcement.

---

## Production evidence

Sequence, as it actually occurred:

1. **Enrollment.** Owner (user id 9) enrolled 2026-09-01T09:26:08.059Z. The
   provisioning material was transferred to the authenticator by QR rendered
   locally on the operator's machine; the entered code was validated offline
   against the freshly issued seed *before* the server was contacted, so a
   mismatched authenticator entry could not silently produce an opaque failure.
2. **Enforcement enabled** 2026-09-01T20:22:52.883Z and deployed as recorded
   under *Production status*.
3. **Privileged navigation without elevation.** The owner opened
   `/admin/businesses/3`. This surface was chosen because it depends only on
   `fetchPlatformAdminBusinessDetail`, whose service reads through the canonical
   client — it is unaffected by the separate admin-data-plane finding, so a
   success there is attributable to MFA and nothing else.
4. **Challenge raised.** The MFA step-up dialog opened. Owner-reported: PASS.
5. **Code entered directly in the browser.** The value was never transmitted to,
   requested by, or visible to anyone but the owner and the server.
   Owner-reported: PASS.
6. **Privileged page then loaded** with business detail rendered.
   Owner-reported: PASS.
7. **Refresh re-challenged.** After a full page reload MFA was requested again.
   Owner-reported: PASS. This is the empirical confirmation that the elevation
   is not persisted in durable browser storage.
8. **No rollback was required.**

### Server-side corroboration (no secret exchanged)

The owner's interactive claim is independently corroborated by read-only
database state, which advanced exactly as a genuine TOTP verification would:

| Field | Before step-up | After step-up |
| --- | --- | --- |
| `lastVerifiedAt` | 2026-09-01T09:27:29.478Z | **2026-09-01T21:10:57.010Z** |
| `lastUsedStep` | 59608494 | **59609901** |
| `recovery_count` | 10 | **10** |
| `recoveryCodesGeneratedAt` | 2026-09-01T09:26:08.059Z | unchanged |
| `enrolledAt` | 2026-09-01T09:26:08.059Z | unchanged |

`lastUsedStep` equals `floor(epoch(lastVerifiedAt) / 30)` exactly, i.e. the
accepted code came from the *current* time step with zero drift — not a stale or
replayed one. `lastVerifiedAt` falls after the enforcement flag was written, so
the verification happened under enforcement. `recoveryCodesGeneratedAt` and the
count are unchanged, which establishes that **the step-up used TOTP and not a
recovery code**.

### Health

Production smoke after enforcement: 15 routes across public, application and
admin surfaces — **0 × 5xx**. Ordinary business authentication and ordinary
application surfaces are unaffected by the control.

---

## Negative / security evidence

Verified in Production against the deployed build, using only the pre-existing
synthetic QA account and non-destructive requests:

- **Non-admin remains denied.** An authenticated ordinary business user is
  refused on all 11 mandatory-elevation routes while its own resource
  (`GET /api/auth/me`) returns 200 — the denial is authorization, not a broken
  session.
- **A non-admin cannot bootstrap platform-admin MFA.**
  `POST /api/platform-admin/mfa/enroll` is refused for that user.
- **Malformed or absent elevation does not grant access.** The same non-admin
  session was replayed against a mandatory route with (a) no elevation header,
  (b) an empty header, (c) a malformed header, and (d) a structurally
  well-shaped but unsigned envelope. All four were refused. This establishes
  that a *stolen elevation does not elevate a non-admin*; see the boundary note
  below for what it does not establish.
- **Unauthenticated callers** receive 401 on every privileged route.
- **TOTP replay rejected.** During Wave B pre-enforcement proof, re-submitting
  an already-accepted code returned `401 replayed_code`.
- **A failed or cancelled step-up does not replay the privileged operation.**
  The original request is surfaced as an error rather than retried.
- **The step-up retry is bounded** to one attempt per request; a server that
  keeps refusing cannot produce a prompt loop.
- **No durable browser elevation storage.** The deployed JavaScript chunks for
  `/admin`, `/admin/businesses/[id]` and `/dev/learning-center` were fetched
  from Production and scanned: no chunk writes an elevation to `localStorage` or
  `sessionStorage`.
- **The code is never logged, persisted, or placed in a URL.** Asserted by test
  rather than by inspection alone: the matrix checks that the submitted value
  reaches exactly one endpoint, in a POST body, and appears in no URL, no
  privileged request, no console output and no client-side store.

---

## Automated evidence

All of the following run in the **blocking** job `ci-1-guard`
([`.github/workflows/ci-1-prisma-centralization.yml`](../.github/workflows/ci-1-prisma-centralization.yml)),
required on pull requests to `main`. They are deterministic and offline: no
database, no network, no real secret.

| Suite | File | Local script | Result |
| --- | --- | --- | --- |
| Platform-admin MFA matrix | `lib/auth/platform-admin-mfa.test.ts` | `npm run verify:admin-mfa` | **18/18 pass** |
| Admin step-up client matrix | `lib/platform-admin/admin-step-up.test.ts` | `npm run verify:admin-step-up` | **13/13 pass** |
| Platform-admin auth fail-closed matrix | `lib/auth/platform-admin.test.ts` | `npm run verify:platform-admin-auth` | **10/10 pass** |
| Admin boundary guard (CI-2/CI-3/CI-3b/CI-4) | `scripts/ci/admin-boundary-guard.sh` | `npm run verify:admin-boundary` | pass |

CI step names, as they appear in the workflow:

- `Platform-admin MFA matrix (elevation, binding, expiry, seed storage)`
- `Wave B negative proof (unbinding the elevation from the user must be caught)`
- `Platform-admin MFA step-up client (challenge, single retry, no code retention)`
- `Wave B negative proof (retrying a cancelled challenge must be caught)`

**Negative proofs.** Two mutation tests run in CI and must fail the suite:
removing the `sub` binding check in the elevation verifier, and removing the
cancel guard so a cancelled challenge would still retry the privileged request.
Both were confirmed to bite — a suite that cannot detect its own removal is not
evidence.

The MFA matrix additionally pins the *provisioning contract*: it takes the URI
that enrollment actually returns, parses it the way an authenticator app does,
generates a token from it, and validates that token through the verifier
(synthetic seed only). An earlier version of the suite built its own TOTP object
and validated its own token, which proved the library worked and nothing about
this system's contract.

---

## Recovery

- **10 hashed recovery entries are present** for the enrolled administrator, all
  SHA-256 hex digests, generated at enrollment.
- **None were consumed during Wave B.** `recoveryCodesGeneratedAt` still equals
  `enrolledAt`, and the count is still 10.
- **Recovery values are not part of this artifact** and were never captured,
  transmitted or displayed outside the operator's own terminal at enrollment.
- **Disabling the enforcement flag does not delete MFA enrollment.**
  `PLATFORM_ADMIN_MFA_REQUIRED` is read at request time by the guard; the
  `PlatformAdminMfa` record is untouched by it. Rollback therefore restores
  access without destroying the second factor.
- Documented break-glass, if an authenticator is lost and recovery codes are
  exhausted: an operator deletes the enrollment row directly and the admin
  re-enrolls. Even then MFA does not become active again until a live code is
  proven. There is deliberately **no unauthenticated "disable MFA" endpoint**.

---

## Known limitations / evidence boundaries

These are stated openly. They are boundaries of the evidence, not hidden facts.

1. **No isolated Production cross-admin `sub` binding test.** Production
   currently has exactly one `PLATFORM_ADMIN` user, and any request from a
   non-admin is refused by the role/allowlist check *before* the elevation is
   evaluated. A cross-admin experiment is therefore not constructible in this
   environment. User binding is enforced in the implementation
   (`verifyAdminElevation` rejects a `sub` mismatch) and is covered by the
   blocking CI matrix together with the negative proof that removing the check
   fails the suite. The Production probes described above establish only that a
   foreign or forged elevation does not elevate a non-admin.
2. **No live Production expiry observation.** The server-side elevation TTL is
   bounded to 900 seconds by `ADMIN_ELEVATION_TTL_SECONDS` and by the envelope's
   `exp`, and expiry behaviour — self-clearing on expiry, and clamping of an
   over-long lifetime to the server maximum — is covered deterministically by
   the blocking test matrix. A live >900-second boundary crossing was **not**
   observed in Production and is not claimed.
3. **No recovery-code consumption test.** Recovery authentication was not
   exercised. Its correctness rests on implementation and the test matrix, not
   on a Production observation.
4. **Two mandatory-elevation routes are blocked before the MFA gate** in current
   Production, as detailed above. Nine of eleven are observable.
5. **`project_admin_data_plane_gap` is a separate, pre-existing finding.**
   `ADMIN_DATABASE_URL` is configured for `preview` only and `app_admin` cannot
   log in to the Production database, so
   `GET /api/platform-admin/overview`, `GET /api/platform-admin/audit` and the
   business-features read fail independently of MFA and did so before Wave B.
   Their failure is **not** evidence of an MFA regression, and the Production
   proof above deliberately avoided those surfaces so that success could be
   attributed to the MFA control alone.
6. **Owner-reported steps are labelled as such.** Steps 4–7 of the Production
   sequence are the administrator's own observations in their browser; they are
   corroborated by the independent database deltas recorded above, which is the
   strongest verification obtainable without handling the administrator's
   credentials or codes.

---

## CASA conclusion

The evidence collected supports the following, and only the following:

- Privileged platform-administrator access in Production requires **two
  independent proofs**: an authenticated allowlisted `PLATFORM_ADMIN` identity,
  and a separate, freshly presented RFC 6238 TOTP factor exchanged for a signed,
  user-bound, 900-second elevation.
- Enforcement is **active in Production** on the deployment recorded above, and
  was demonstrated end to end by a live administrator step-up whose effect is
  independently visible in server-side state.
- The TOTP seed is generated server-side, stored only under authenticated
  encryption with a dedicated key, and never returned after enrollment.
- Replay, unbound elevation, malformed elevation, cancelled challenges and
  prompt loops are each refused, with automated coverage in a blocking CI job
  including negative proofs.
- Recovery material exists in hashed, single-use form and remains unconsumed.

This document makes **no claim** that an external CASA assessor has reviewed or
accepted the control, no claim of a Letter of Validation, and no claim that
Google OAuth verification is complete. It records the implementer's evidence for
CASA requirement 3.3.1 as of 2026-09-02, for submission and assessor review.

---

## Change history

| Date | Change |
| --- | --- |
| 2026-09-02 | v1 — initial evidence record covering CASA Wave B (enrollment, enforcement, Production proof, CI coverage, evidence boundaries). |
