# Config Registry — Report Format (Phase 4 · Step 2)

> **Status: TEMPLATE.** This document describes the report shape. It is populated by
> [`scripts/build-config-registry.mjs`](scripts/build-config-registry.mjs) from
> **read-only** text dumps. It records **key names + scope + source only** — never
> secret values, `DATABASE_URL`/`DIRECT_URL` values, tokens, passwords, or credentials.

## How it is generated (read-only)

1. Export (read-only) the three inventories to text files:
   - `vercel env ls`     → names + scope (the value column is `Encrypted`)
   - `gh secret list`    → secret names + timestamps
   - `gh variable list`  → variable names (value column is **dropped**, never parsed)
2. Run with the file paths supplied via env vars:
   ```
   VERCEL_ENV_TXT=... GH_SECRET_TXT=... GH_VARIABLE_TXT=... \
     node ops/release/scripts/build-config-registry.mjs
   ```
3. Outputs: `config-registry.json` (machine) + this report.

No provider calls are made by the script itself. If no inputs are supplied, an empty
template is written.

## Scope matrix (populated on generation)

| key | sources | Production | Preview | Development | updated |
| --- | --- | :---: | :---: | :---: | --- |
| _(none — template)_ | | | | | |

## Findings

### Production-only keys missing in Preview
Lists keys present in the Production scope but absent in Preview (the G5 pattern from
Phase 1 — e.g. Google OAuth / WhatsApp / Gmail / Authority keys). Reported only; **not**
remediated in this step.

- _(none — template)_

## Safety contract

- Output is restricted to: `key`, `sources`, `scopes` (boolean per environment),
  `updated` timestamp.
- The `vercel env ls` value column (`Encrypted`) is ignored.
- The `gh variable list` value column is never read.
- Raw input lines are never copied into any output file.
