# M6 — QStash as the intake-sweep scheduler

Status: **code ready, NOT active.** No schedule exists and no QStash key is configured in Production. Activation needs the owner's go (§3).

## 1. Why

GitHub runs this repository's `*/10` schedules every ~3–6 h (first natural intake sweep: run 37251121341, 2.5 h after the merge). Vercel Hobby crons run at most daily. Upstash is already Dubiz's vendor (Production rate limiting); QStash is part of the same account and its free tier (1,000 messages/day, 10 schedules) covers a 10-minute sweep (144/day) at **$0**.

Recovery paths after activation: **QStash** (primary, ~10 min) · **inbound catch-up** (every acquisition delivery drains its business's due retries) · **GitHub scheduled sweep** (backstop) · **daily Vercel cron** (backstop, kept).

## 2. Authentication (`lib/intake/sweep-auth.ts`)

- A request with `Upstash-Signature` is accepted only when the official SDK `Receiver` (`@upstash/qstash` 2.12.0) verifies it with `QSTASH_CURRENT_SIGNING_KEY` or `QSTASH_NEXT_SIGNING_KEY`: issuer `Upstash`, `exp` / `nbf` (5 s tolerance), subject = **exactly** `https://promaxgroup.co.il/api/intake/sweep`, body hash = the raw body.
- Both keys must be configured; `devMode: false` (development keys never accepted); keys are never inferred from region headers.
- **No fallback**: a request carrying a signature is judged by it alone — an invalid signature is refused even with a valid `CRON_SECRET` bearer.
- No signature → the existing `CRON_SECRET` check (GitHub workflow POST, Vercel daily GET), unchanged.
- `CRON_SECRET` is never given to Upstash. A leaked signing key can only produce requests this route accepts, and this route only sweeps (idempotent, leased, counts-only answer).
- Nothing about a signature or a key is logged.

## 3. Activation (owner)

1. Upstash console → QStash (same account as the Production Redis) → **Signing Keys**: copy the current and the next key.
2. Vercel → project `business-platform` → Settings → Environment Variables → **Production**:
   - `QSTASH_CURRENT_SIGNING_KEY` = the current signing key
   - `QSTASH_NEXT_SIGNING_KEY` = the next signing key
   Redeploy (or the next deploy picks them up). Never `NEXT_PUBLIC_`, never a preview environment unless intended.
3. Upstash console → QStash → **Schedules → Create**:
   - Destination: `https://promaxgroup.co.il/api/intake/sweep` (exactly — the signature is bound to it)
   - Method: `POST`, body: empty
   - Cron: `*/10 * * * *` (UTC; irrelevant for a 10-minute cadence)
   - Retries: `1`, retry delay: `60000` ms (a transient platform error is retried once a minute later; a persistent failure goes to the DLQ instead of burning the quota — receipts keep their own backoff, the next tick is 10 min away anyway). Worst case 288 messages/day, within the free 1,000.
4. Nothing else changes: GitHub and the daily Vercel cron stay as backstops.

Key rotation: Upstash "Roll keys" makes next → current; set both Vercel values again. Until then requests signed with either key verify.

## 4. Proof after activation (natural, no manual trigger, no poison receipt)

- Several consecutive scheduled deliveries in the Upstash logs, ~10 min apart.
- Each answered 200 with `via: "qstash"` in the response (Upstash logs) — authentication by signature.
- With no acquisition connections: report counts 0 and `ops/evidence/m6-operational-evidence.sql` stays 7/7.
- Failure, retry and DLQ behaviour is proven in the lab only: `.m6/qstash-lab.ts` against the official local QStash server (CI job `qstash-lab`): a real schedule delivers every 60 s with signatures the production `Receiver` configuration verifies; 500 → retried until 200; always-500 → DLQ after its retries; a real QStash signature for another URL is refused by the actual sweep route (401).
