# Bot LLM Drafts — Shadow Rollout Runbook (v1)

Operational runbook for safely enabling the **LLM reply-draft generator in Shadow
(measurement-only) mode** in production.

**Scope of this doc:** how to turn Shadow on/off via env vars, what each flag does,
the recommended rollout + emergency-off sequences, how to read the metrics, and
the known limits. Shadow **never** shows anything to the business owner, **never**
sends to a customer, and is **off by default**.

Single source of truth in code:
- Flags: `lib/features/conversation/llm-draft/flags.ts`
- Daily counter: `lib/features/conversation/llm-draft/daily-counter.ts`
- Runner (shared by both inbound paths): `lib/services/conversation/bot-llm-draft-runner.service.ts`

---

## 1. Environment variables

| Env var | Type | Default | Purpose |
|---|---|---|---|
| `OPENAI_API_KEY` | string | (none) | Model credential. Required (length > 10) for the master gate. |
| `BOT_LLM_DRAFTS_ENABLED` | `"true"` \| other | off | Master switch. Must be `"true"` **and** a valid key present. |
| `BOT_LLM_DRAFTS_SHADOW` | `"true"` \| other | off | When master is on: `"true"` → **shadow**; otherwise → **visible**. |
| `BOT_LLM_DRAFTS_SAMPLE_RATE` | number `[0,1]` | `0` | Fraction of messages that run the model. Deterministic per `messageId`. |
| `BOT_LLM_DRAFTS_DAILY_CAP` | positive int | `0` | Max **actual** model calls per UTC day (per process). Fail-closed. |
| `BOT_LLM_DRAFTS_LOG_TEXT` | `"true"` \| other | off | When `"true"`: log full draft + prior-draft **text**. PII-sensitive. |

---

## 2. Per-flag: default, off, on

### `OPENAI_API_KEY`
- **Default:** none.
- **Absent / ≤10 chars:** master resolves to **off** → total no-op.
- **Present (>10 chars):** satisfies the credential half of the master gate.

### `BOT_LLM_DRAFTS_ENABLED`
- **Default:** off.
- **Off:** mode = `off`. The runner returns immediately (`FLAG_OFF`) — no prompt, no model call, no record. Behaviour is byte-identical to before the feature existed.
- **On (`"true"` + key):** the generator is eligible to run, subject to work mode, sampling, and daily cap.

### `BOT_LLM_DRAFTS_SHADOW`
- **Default:** off.
- **Off (master on):** mode = **visible** → a `LLM_DRAFT` (status `GENERATED`) is saved for the owner to review. Still draft-only; never auto-sent.
- **On (master on):** mode = **shadow** → the generator runs and a metric is recorded, but **no `LLM_DRAFT` is saved** and nothing is shown to the owner.

### `BOT_LLM_DRAFTS_SAMPLE_RATE`
- **Default:** `0`.
- **`0` / unset / invalid:** no message runs the model (`SAMPLED_OUT` → metric `skipped_sample`).
- **`1`:** every eligible message runs (subject to daily cap).
- **`0<r<1`:** deterministic fraction, keyed on `messageId` (same message → same decision, always).

### `BOT_LLM_DRAFTS_DAILY_CAP`
- **Default:** `0` (**fail-closed** — blocks everything; see §4 in the code notes).
- **`0` / unset / invalid:** every eligible message is blocked (`DAILY_CAP_REACHED` → metric `skipped_daily_cap`).
- **`N>0`:** at most `N` **actual** model calls per UTC day (per process). Pre-guardrail blocks do **not** consume the cap.

### `BOT_LLM_DRAFTS_LOG_TEXT`
- **Default:** off.
- **Off:** metrics are **metadata only** (lengths, types, reason codes) — no message/draft content in logs (PII-safe).
- **On:** additionally logs the LLM draft text and prior-draft texts for qualitative comparison. **Do not enable in production without an explicit privacy decision** (see §9).

---

## 3. Mode resolution & gate order

**Mode** (`resolveBotLlmDraftMode`):
```
off      if NOT (BOT_LLM_DRAFTS_ENABLED === "true" AND OPENAI_API_KEY present)
shadow   else if BOT_LLM_DRAFTS_SHADOW === "true"
visible  else
```

**Runner gate order** (identical on both inbound paths — webhook pipeline and `/api/message`):
```
off  →  MANUAL / not-offered  →  no-settings  →  sampling  →  daily cap
     →  pre-guardrails  →  LLM call  →  post-guardrails  →  save (visible) / record
```
Each gate is fail-closed and independent: master, sample rate, and daily cap **each** stop everything on their own.

---

## 4. Recommended production rollout (metadata-only)

Set, in this order, and observe between steps:

```bash
# 1. Credential (once)
OPENAI_API_KEY=sk-...

# 2. Enable in SHADOW, metadata-only, tiny sample, explicit daily cap
BOT_LLM_DRAFTS_ENABLED=true
BOT_LLM_DRAFTS_SHADOW=true
BOT_LLM_DRAFTS_SAMPLE_RATE=0.01     # start at 1%
BOT_LLM_DRAFTS_DAILY_CAP=200        # explicit ceiling
BOT_LLM_DRAFTS_LOG_TEXT=            # stays OFF (metadata only, PII-safe)
```

- Deploy → confirm `SHADOW_METRIC` lines appear and `LLM_DRAFT` rows are **not** created.
- Watch cost + latency. Raise `SAMPLE_RATE` / `DAILY_CAP` gradually only after review.
- Keep `BOT_LLM_DRAFTS_LOG_TEXT` **off** throughout metadata evaluation.

> Cost only begins when **all three** of `ENABLED`, `SAMPLE_RATE>0`, and `DAILY_CAP>0` are set on purpose.

---

## 5. Emergency off (immediate)

Any **one** of these fully stops the model (pick the fastest to change):

```bash
BOT_LLM_DRAFTS_ENABLED=false     # master kill — total no-op (preferred)
# or
BOT_LLM_DRAFTS_SAMPLE_RATE=0     # nothing sampled in
# or
BOT_LLM_DRAFTS_DAILY_CAP=0       # everything capped out
```

`BOT_LLM_DRAFTS_ENABLED=false` (or unset) is the cleanest: mode → `off`, the runner
returns before any load/model call. No deploy of code required — an env change +
restart/redeploy of the running instances.

---

## 6. Collecting the logs

Metrics are emitted as a structured log line (no schema/DB, PII-safe by default):

```
[bot-llm-draft] SHADOW_METRIC { ...BotLlmShadowRecord }
```

Related lines:
- `[inbound-pipeline] LLM_DRAFT_OUTCOME` / `[message-route] LLM_DRAFT_OUTCOME` — per-run outcome from each inbound path (non-skipped only).
- `[bot-llm-draft] OPENAI_ERROR detail=...` — a model/network error (the run then records `outcome: "no_draft"`).

Collection: grep/scrape the platform logs for `SHADOW_METRIC`, parse the JSON, aggregate by `outcome` / `intent` / day. No endpoint is exposed in this phase (by design).

---

## 7. Metrics to watch (`BotLlmShadowRecord`)

| Field / outcome | What it tells you |
|---|---|
| `outcome: "skipped_sample"` | Message not sampled in (rate control working). |
| `outcome: "skipped_daily_cap"` | Daily cap reached (cost brake engaged). |
| `outcome: "blocked_pre"` | Pre-guardrail handoff — model **not** called. Check `blockedReason`. |
| `outcome: "blocked_post"` | Model output violated a guardrail — draft suppressed. Check `blockedReason`. |
| `outcome: "draft"` | A clean draft passed pre + post guardrails. |
| `outcome: "no_draft"` | Empty/failed model output (incl. model errors → `LLM_EMPTY`). |
| Model errors | `[bot-llm-draft] OPENAI_ERROR` lines + `no_draft` rate. |
| `draftLength` | LLM draft length (compare vs prior). |
| `priorStarterDraft` / `priorAutoSuggestion` | Whether STARTER / AUTO already existed for the message. |
| `priorSuggestionTypes` / `priorDrafts[].length` | Types + lengths of existing drafts (for comparison). |
| `draftText` / `priorTexts` | Full text — **only** when `BOT_LLM_DRAFTS_LOG_TEXT=true`. |

Key ratios: `blocked_pre + blocked_post` rate (safety), `draft` vs `no_draft` (yield), LLM `draftLength` vs STARTER/AUTO lengths, and `skipped_daily_cap` frequency (is the cap too low?).

---

## 8. Known limits

- **Daily cap is per-process, not global.** With N instances the effective ceiling is `cap × N`. It is a soft cost brake, never over-blocks; a precise global cap needs shared storage (out of scope).
- **No auto-send.** No code path sends a bot message to a customer. Every reply requires the owner to press send.
- **No Inbox display in shadow.** Shadow never creates a `LLM_DRAFT` row, so the Inbox shows nothing.
- **No PII in logs by default.** Metadata-only unless `BOT_LLM_DRAFTS_LOG_TEXT=true`.
- **`LOG_TEXT` must not be enabled in production without an explicit privacy decision** (records customer/draft text to logs).
- **MANUAL / SMART_DRAFTS unchanged.** The generator only runs when AUTO would be offered (SMART_DRAFTS, not handoff); MANUAL never runs it.

---

## 9. Future transition: shadow → visible

Consider moving to `visible` (setting `BOT_LLM_DRAFTS_SHADOW=` off) only after:

1. **Quality bar met** — acceptable `draft` yield and low `blocked_post` on a meaningful sample.
2. **Safety verified** — `blocked_pre` / `blocked_post` reason codes reviewed; no leakage of forbidden topics in a `LOG_TEXT`-on sample (time-boxed, privacy-approved env).
3. **Cost/latency acceptable** at the target sample rate.
4. **Inbox UX decided** — whether the LLM draft replaces or joins the AUTO drafts (avoid draft noise).
5. **Stronger output validation** — length/language/format checks beyond the keyword post-guardrail.

Only after `visible` is proven should any discussion of an autonomous send executor (work mode 3) begin — it does not exist and is out of scope here.
