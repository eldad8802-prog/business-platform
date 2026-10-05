# Profile + Settings v2 — visual and runtime evidence

Captured from the **real app** (production build, `next start`) against a **local
throwaway PostgreSQL** seeded with synthetic tenants (`seed-local.ts`, which refuses
any non-localhost database). No API is mocked: every number on screen came from
`/api/profile/summary` and `/api/settings/connections-summary`.

| File | What it shows |
|---|---|
| `reference-profile-390.png`, `reference-settings-390.png` | The approved references, rendered at 390 |
| `profile-full-390-before-logo.png` → `-after-logo.png` | The real camera-button upload: initials + 87% → logo + 100% |
| `profile-full-{390,768,1024,1280,1440,1920}.png` | Profile — mobile / tablet / desktop compositions |
| `settings-full-{390,768,1024,1280,1440,1920}.png` | Settings hub — mobile / tablet / desktop compositions |
| `profile-empty-*.png`, `settings-empty-*.png` | A just-signed-up business: zeros, 0%, initials, "אין פעילים" |
| `results.json` | The runtime checks (overflow, links, upload, sign-out) |

Tiers: < 768 mobile · 768–1279 tablet · ≥ 1280 desktop (the approved shell's tiers).
1024 renders the tablet composition beside the current sidebar.

Reproduce:

```
npx tsx qa-evidence/profile-settings-v2/seed-local.ts > tokens.json      # DATABASE_URL=localhost only
QA_BASE=http://localhost:3020 QA_TOKENS="$(cat tokens.json)" REF_DIR=<folder with the two html files> \
  node qa-evidence/profile-settings-v2/shoot.mjs
```
