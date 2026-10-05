# /business/identity redesign + /tools retirement — evidence

Captured from the **real app** (production build) against a **local throwaway PostgreSQL** seeded
with synthetic tenants (`seed-local.ts` refuses any non-localhost database; every value is marked
"סינתטי"). No API is mocked.

| File | What it shows |
|---|---|
| `identity-partial-{390,768,1024,1440,1920}.png` | A business part-way through: 3 of 4 chapters, approved-only preview, real learned signals |
| `identity-partial-390-step.png` | Mobile step flow after "לפרק הבא" |
| `identity-empty-{390,768,1440}.png` | A business that has told Dubiz nothing: 0 of 4, honest empty learned state |
| `results.json` | Runtime checks: overflow, RTL, preview contents, adoption, `/tools` redirect, back targets |

Reproduce: `npx tsx qa-evidence/identity-landing/seed-local.ts > tokens.json` (localhost DB only), then
`QA_BASE=http://localhost:3030 QA_TOKENS="$(cat tokens.json)" node qa-evidence/identity-landing/shoot.mjs`.
