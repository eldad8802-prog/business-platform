# Production uptime + latency monitor

Workflow: `.github/workflows/prod-uptime-monitor.yml` · scripts: `ops/monitor/` · baseline: `ops/monitor/prod-baseline.json`

## What it does

Every ~15 minutes (`cron: */15 * * * *`; GitHub may delay or skip scheduled runs under load) a GitHub-hosted
runner requests public, unauthenticated pages of `https://promaxgroup.co.il`: `/about`, `/app`, `/collection`,
`/login`, `/home`, plus `/manifest.webmanifest` as the **CDN reference** (a static file served as an
`x-vercel-cache: HIT` from the edge).

- One warm-up request per target (discarded), then 5 samples per target. Rounds are interleaved with ~2 s
  between any two requests (~70 s per run), a low rate so Vercel's Security Checkpoint does not treat it as a burst.
- Per target: median TTFB (`curl %{time_starttransfer}`) of the successful samples.
- **Offsets, not absolute times.** The runner (US) is not where the baseline was measured (Israel), so each
  page is compared as `excess = (page median − reference median) − baseline offset`.
  Baseline offsets (2026-10-23, Israel, flag OFF): `/about` 0, `/app` 0, `/collection` 0, `/login` +118, `/home` +133 ms.
- A target **breaches** when `excess > 250 ms`. A run is **BREACHING** if ≥3 targets breach, or any 5xx, or any
  target is unreachable (timeouts / non-2xx-3xx on a majority of samples).
- A `403` with `x-vercel-mitigated: challenge` is the checkpoint challenging the runner: **INCONCLUSIVE**, never an
  outage. It is reported (warning + summary) and breaks no chain.
- Also recorded (summary only): `x-vercel-cache`, the `x-vercel-id` region path, and whether the HTML is served
  with `lang="he"` without a cookie (Hebrew default).

## How alerts arrive

**Alert only when this run AND the previous scheduled run are both BREACHING (~30 min sustained).** The previous
run's verdict is read from its tiny `prod-monitor-state` artifact (3-day retention); a state older than 75 min
(skipped schedules) is ignored. A single cold start or spike never alerts.

An alert = the job **fails**. GitHub emails the account owner about failed scheduled runs (Settings → Notifications
→ Actions, "failed workflows only"). Every run — healthy or not — writes a job summary table. The monitor changes
nothing: no rollback, no Vercel or Production writes.

Optional (owner choice, not enabled): open a GitHub issue on alert. That would need `issues: write`, so it is
deliberately left out.

## Self-tests

- Every run starts with the evaluator's synthetic self-test (`node ops/monitor/evaluate.mjs --self-test`).
- Every run proves the failure path on its real samples: a forced sustained breach must make the evaluator exit 1.
- Manual red run: Actions → *prod uptime monitor* → Run workflow → `force_breach: true` (the job fails on purpose).

## Permissions, secrets, cost

- Default `GITHUB_TOKEN` only: `contents: read` (checkout) and `actions: read` (download the previous run's state).
- No secrets, no environment, no credentials, no cookies, no signed-in requests. Logs and artifacts hold only
  public URL paths, status codes, timings, cache/region headers and the `lang` attribute — never page bodies.
- Cost: 0 — standard GitHub-hosted runners are free for public repositories (~2 min per run).

## Pause / resume

Actions tab → *prod uptime monitor (scheduled, alert-only)* → `…` → **Disable workflow** (Enable to resume).
GitHub also disables scheduled workflows automatically after 60 days without repository activity.

## Limits

- Detects availability and latency of public pages from one US region; it does not see signed-in flows, APIs or
  regional problems elsewhere.
- Up to ~30–45 min to alert (two scheduled runs, plus GitHub's schedule delays). Scheduled runs are best-effort.
- The baseline was measured from Israel with the flag OFF; if the architecture changes intentionally (e.g. pages
  stop being CDN-cached), update `prod-baseline.json` in a reviewed PR.
