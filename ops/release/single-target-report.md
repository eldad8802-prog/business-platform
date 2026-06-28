# Single Target Detection — Report (Phase 4 · Step 5)

> **Status: TEMPLATE.** This document describes the report shape. It is populated by
> [`scripts/detect-targets.mjs`](scripts/detect-targets.mjs) from **read-only** captures
> of `vercel projects ls`, `vercel ls <project> --prod`, and `vercel inspect <url>`.
> It is **report-only** — it never deploys, removes, promotes, links, or changes any
> project setting, and includes no tokens, secrets, or env values (deployment URLs are public).

## How it is generated (read-only)

1. Capture (read-only) to text files:
   - `vercel projects ls`              → project names + production domains
   - `vercel ls <project> --prod`      → Production deployment URLs
   - `vercel inspect <url>`            → aliases incl. `*-git-<branch>-*` evidence
2. Run with the file paths supplied via env vars:
   ```
   VERCEL_PROJECTS_TXT=... VERCEL_PROD_TXT=... VERCEL_INSPECT_TXT=... \
     node ops/release/scripts/detect-targets.mjs
   ```
3. Output: this report, regenerated.

No provider calls are made by the script. If no inputs are supplied, this template is written.

## Projects observed

| project | production URL / domain |
| --- | --- |
| _(none — template)_ | |

## Production-from-main targets

| project | branch | canonical? | alias evidence |
| --- | --- | :---: | --- |
| _(none — template)_ | | | |

## Finding

Reports whether more than one Vercel project deploys Production from `main` (the **E1**
finding from Phase 1: `business-platform` **and** `business-platform-btrl`). The canonical
project is the one carrying the canonical custom domain (`promaxgroup.co.il`); any other
Production-from-main project is flagged **NON-CANONICAL (duplicate)**.

- _Pending capture._

> **Report only.** No project is changed or neutralized. The Single Production Target
> *Gate* (enforcement / neutralizing the duplicate) is out of scope for this step.

## Safety contract

- Output limited to: project name, deployment url/id, target, branch/alias evidence,
  canonical/non-canonical finding.
- No tokens, secrets, raw env values.
- No provider mutation: no deploy / remove / promote / link / settings change.
