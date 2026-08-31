# CASA 2.2.3 — application session lifetime: evidence

**Status:** assessor-facing evidence memo · v1 · 2026-09-01
**Applies to:** CASA Specification v2.1.1 (2026-06-03), test case **2.2.3**
**Contains no secret values.**

---

## 1. The requirement

> **2.2.3** — *"Non-revocable stateless authentication tokens shall have an expiration time within 24 hours of being issued."*
> Verification is identical at AL1 and AL2. AL1 evidence: *"Provide code snippets, screenshot, or documentation that shows the time period for which stateless tokens are valid (if utilized)."*

## 2. The session mechanism

Dubiz issues a single application session credential:

| | |
|---|---|
| Format | `v1.<base64url(payload)>.<base64url(HMAC-SHA256)>`, payload `{ sub, iat, exp }` |
| Signing | HMAC-SHA256 over `"v1." + payloadB64`, so the version is bound into the MAC |
| Key | server-side secret, environment-provided, fail-closed when absent |
| Transport | `Authorization: Bearer` only — no session cookie |
| Issued by | `POST /api/auth/login` — the **only** production issuance site |
| Verified by | `getCurrentUser` — the **only** verification site |
| Server-side state | **none** — no session table, no `jti`, no revocation list |

The token is therefore **stateless and non-revocable**, which is precisely the class 2.2.3 governs. There is no session store to fall back on: **its lifetime is the control.**

## 3. Maximum lifetime: 86,400 seconds

Enforced in code, in `lib/auth-token.ts`:

```ts
const MAX_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_TTL_SECONDS = MAX_TTL_SECONDS;

export function resolveAuthTokenTtlSeconds(
  raw: string | undefined = process.env.AUTH_TOKEN_TTL_SECONDS
): number {
  if (typeof raw !== "string" || raw.trim().length === 0) return DEFAULT_TTL_SECONDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TTL_SECONDS;
  return Math.min(Math.floor(parsed), MAX_TTL_SECONDS);   // clamp — can only lower
}
```

`signAuthToken` calls this single authority for every token it issues.

**Configuration cannot weaken it.** `AUTH_TOKEN_TTL_SECONDS` may *lower* the lifetime; it can never raise it. Values above the ceiling are clamped; unparseable, zero and negative values fall back to the compliant default. The ceiling deliberately lives in code rather than in configuration, so the guarantee does not depend on an environment variable being present and correct in every environment — and in production that variable is **absent**, so the code path is the operative one.

## 4. Tests

`lib/auth-token.test.ts` — 10 scenarios, deterministic and offline, running in the repository's **blocking** CI job (`ci-1-guard`) with a negative proof that re-plants the previous 30-day ceiling and requires the suite to catch it.

| # | Asserts |
|---|---|
| 0 | the ceiling constant is 86,400 |
| 1 | a default-issued token's lifetime is exactly 86,400 s, measured both from its own `iat` and from wall-clock issuance |
| 2 | an override **below** the ceiling is honoured |
| 3 | overrides **above** the ceiling are clamped — including the old 30-day value, `86401`, exponent notation and padded input |
| 4 | malformed overrides (`""`, `abc`, `-1`, `0`, `NaN`, `Infinity`, `1_000`) cannot produce an overlong token |
| 5 | verification rejects an expired token |
| 6 | a fresh token round-trips (login path intact) |
| 7 | a token issued under one signing secret is rejected under another |
| 8 | editing `exp` to buy back 30 days fails signature verification |
| 9 | the Gmail and ITA OAuth **state** envelopes keep their own independent 10-minute TTLs |
| 10 | Gmail token encryption depends on a **separate** key and never on the session secret or session TTL |

## 5. Cutover: invalidating previously issued sessions

Before this change the lifetime was **2,592,000 seconds (30 days)** — 30× the permitted maximum. Because `exp` is embedded in each already-issued token, lowering the ceiling governs new tokens only; outstanding 30-day tokens would have remained valid for up to 30 more days.

A controlled rotation of the signing secret was therefore performed, which invalidates every previously issued token by signature.

| Cutover record | |
|---|---|
| Code deployed (issuance ≤24 h) | merge commit `eaa6e8da79adf308baecdeddefc68a5483d5ca1b` |
| Signing-secret rotation applied | **2026-08-31T23:02:58Z** |
| Cutover deployment | `dpl_AdVYVUWuNYANTQaQ5tRjcbkDmxGw`, same SHA, state READY |
| Deployment created | 2026-08-31T23:03:22Z, aliased to the production domain |
| Rotation method | 32 cryptographically random bytes, base64 — the project's documented generation method |
| Secret store | Vercel environment (single store; confirmed **not** present in the CI secret store) |

Rotation was performed in a low-traffic window. Per the project's own rotation runbook, signing-secret rotation signs every user out and requires re-login: *"This is expected behavior, not a fault… session invalidation is the point."*

## 6. Pre/post-rotation evidence

Verified against **production**, using a purpose-created disposable account. No secret, password or token value appears in any artefact.

**Before rotation** — a real login was performed and its token retained:

| Observation | Value |
|---|---|
| Issued | 2026-08-31T23:00:54Z |
| Expires | 2026-09-01T23:00:54Z |
| **Lifetime** | **86,400 s (24.00 h)** — compliant |
| Authenticated APIs (`/api/auth/me`, `/api/documents/inbox`, `/api/integrations/gmail/status`, `/api/payments/requests`, `/api/business/profile`) | all `200` |
| `/api/platform-admin/session` with a non-admin session | `403` — privilege boundary intact |
| Same endpoints without the token | `401` |

**After rotation** — the retained token was replayed:

| Check | Result |
|---|---|
| Retained pre-rotation token → `/api/auth/me`, `/api/documents/inbox`, `/api/integrations/gmail/status` | **`401` on all three** |
| Was that token expired? | **No — 85,989 seconds still to live.** The rejection is therefore signature rejection caused by the rotation, not expiry |
| Fresh login after rotation | **succeeds** |
| Newly issued token lifetime | **86,400 s (24.00 h)** — compliant |
| New token differs from the pre-rotation token | yes |
| Authenticated APIs with the new token | all `200`, `0 × 5xx` |
| Site smoke (9 routes) | all `200`, `0 × 5xx`; all four security response headers intact |

**Conclusion: every session issued under the previous 30-day policy is now invalid, and every session issuable today expires within 24 hours.**

## 7. Separation from Google OAuth token storage

Rotating the session signing secret is **provably unrelated** to stored Google credentials.

- Gmail OAuth access/refresh tokens are **provider-issued**; their expiry comes from Google's `expires_in`, never from the application session TTL.
- They are encrypted at rest with **AES-256-GCM under `GMAIL_TOKEN_ENCRYPTION_KEY`** — a separate environment record, production-scoped, **not modified** by this cutover.
- The session signing secret has exactly three consumers, all HMAC signing of **transient** envelopes: the session token, and the Gmail and ITA OAuth *state* envelopes (10-minute TTL each). None of them encrypts or signs anything persisted. Rotation therefore cannot render stored data unreadable.
- Payment, WhatsApp and Billing-Authority credentials each use their own separate encryption keys.

**Measured immediately after the cutover:**

| | Value |
|---|---|
| Connected Gmail connections | **5** — unchanged |
| Stored OAuth token rows | **5** — unchanged |
| Rows in the strong `gcm_v1` format | **5** |
| Rows in the legacy plaintext format | **0** |
| Most recent stored-token update | **2026-08-30T19:10:15Z** — over a day *before* the rotation, i.e. the cutover touched no stored Google token |
| Gmail attachment imports | **5** — unchanged |
| Database migrations applied | **109** — unchanged; **no migration was run** |
| Payment requests / transactions / webhook events / active provider connections | **3 / 1 / 2 / 1** — all unchanged |

No Gmail connection was disconnected or re-connected at any point.

## 8. One-way compliance boundary

Restoring the previous signing secret would revalidate the outstanding 30-day tokens and reintroduce the non-compliant sessions. **The old secret is therefore not a rollback path.** If a regression were to appear, the correct responses are to keep the new secret and either fix forward, or roll the code back only to a revision that still honours the 24-hour ceiling.
