# M6 — Website source: live-proof readiness

Status: **READY FOR LIVE PROOF, STILL OFF.** No business has `acquisition_web_forms`; 0 acquisition connections in Production.
The live proof itself needs a separate owner decision (§5).

## 1. End-to-end audit (code read, then proven by the PG17 battery)

| Step | What exists | Status |
|---|---|---|
| Source switched on per business | feature `acquisition_web_forms` (default OFF, global policy OFF); platform-admin override per business | VERIFIED (Prod: OFF, 0 overrides) |
| Connection | `AcquisitionConnection` (FORCE RLS, no DELETE); owner API creates it only while the source is ON for that business | VERIFIED |
| Endpoint + secret | per-connection URL `/api/intake/acquisition/web/<publicId>`; server key shown once, stored as sha256 only; rotate / pause / revoke | VERIFIED |
| Tenant | from the trusted connection ONLY (SECURITY DEFINER lookup); a `businessId` in the body is ignored; resolver and intake must agree | VERIFIED (battery: body names B → lands in A) |
| Site validation | browser mode: exact allowed origin (+ the www / bare twin, new); server mode: key hash | VERIFIED |
| Abuse controls | honeypot (silent 202/200, nothing stored); per-IP 10/min + per-business limits (fail-open on limiter outage: a lead is never dropped for it); 32 KB body cap | VERIFIED |
| Paused / revoked / disabled / inactive business | resolver serves ACTIVE only (paused/revoked → 401/404); feature OFF → 404; deletion-requested business → 404; revoked before retry → receipt IGNORED | VERIFIED (inactive business: new battery check) |
| Durable intake | receipt written before the 2xx; unique (business, source, externalEventId) | VERIFIED |
| Idempotency | provider id when the form sends `submission_id`; otherwise content + **UTC day** (was: server millisecond — fixed) | **GAP FIXED** |
| Parallel duplicates | 3 re-deliveries + 6 parallel → exactly 2 receipts | VERIFIED |
| Normalization | one canonical normalizer (`AcquisitionLeadV1`) | VERIFIED |
| M4 identity | deterministic phone / email evidence; the same person again → one Customer, the Lead gets `intake_attached` | VERIFIED |
| Routing → Lead | M4 rule R4 → core `routeToLead`; never a parallel CRM | VERIFIED |
| M5 lifecycle | `created` (or `intake_attached`) evidenced by the receipt (`evidenceKind = intake_event`) | VERIFIED |
| Secretary | arrivals by source group (`intake:web.form` → "מהאתר") | VERIFIED |
| Learning | `LEAD_LIFECYCLE_STARTED` v2 carries only `origin`, `contactKnown`, `intakeSource` | VERIFIED (no PII) |
| Attribution | provider, UTM (from the page URL and fields), landing page without its query, click ids | VERIFIED |
| Retention | payload purged when the receipt completes; failed payloads after 30 days; contact hints after identity resolves | VERIFIED |
| Observability | allow-listed intake log (no form content); sweep counts only | VERIFIED; sweep health **strengthened** |
| Retry / recovery | per-business catch-up on every inbound (now also on a pure re-delivery — fixed); scheduled sweep | cadence: **owner decision (§4)** |
| Owner path without a developer | plain HTML form → raw JSON page (fixed: Hebrew page); site address optional (now required); no ready-made form (added) | **GAPS FIXED** |

## 2. Changes in this milestone

- **Idempotency:** website receipts without `submission_id` are keyed on content + UTC day, so a double-click, a back + resubmit or a network retry is one receipt and one Lead; the same enquiry tomorrow is new.
- **Plain HTML form:** a browser form post from the owner's site gets a short Hebrew page (thank-you / missing contact / try again) with a link back to the site, `CSP default-src 'none'`, nothing the visitor typed echoed. API clients still get JSON.
- **Origins:** the owner types one site; its `www.` / bare twin is allowed with it.
- **Recovery on inbound:** any inbound for a business drains that business's due retries — also on a pure re-delivery.
- **Sweep health:** a sweep in which any receipt fails (retryable or dead-letter) answers **500** `{ok:false, reasons:["failed_receipts"]}` — the scheduler goes red. "The sweep ran" is no longer "the leads arrived".
- **Owner UX (מקורות לידים → טופס באתר):** the site address is required; the primary result is a **ready-made form to paste** (no secret in it; Wix / WordPress "HTML embed"), always available later; the server key is under "for whoever built the site"; the owner can change the site address; status reads "פעיל — מקבל פניות" / "מושהה — פניות לא מתקבלות".

## 3. Live-proof evidence

`ops/evidence/m6-website-live-proof-evidence.sql` — read-only, counts only (no name, phone, email, answer, message or payload). 17 checks: one live website connection, exactly one business enabled and it owns it, nothing else enabled → receipts in that tenant, none failed or pending → normalized, M4 decided → Leads in that tenant, M5 lifecycle evidenced by the receipt → no duplicate → the Secretary channel → a learning signal with no personal field → attribution kept → payloads purged.

Proven in CI (`m6-acquisition-ci.yml` step 5) on a clean PG17 database through the real routes: before any enquiry it fails exactly the chain checks (4 9 12 13 — not vacuous); after one genuine-shaped enquiry + the same enquiry resubmitted it passes **17/17** with **one** receipt; with a second business enabled it fails exactly check 2.

## 4. Retry cadence — finding and decision

- **Before:** `intake-sweep.yml` is scheduled `*/10`, but GitHub runs this repository's schedules every ~3–6 h (the first natural run, 37251121341, came 2.5 h after the merge; payment recovery shows the same gaps). The sweep itself is correct.
- **Mitigation shipped:** recovery on every inbound for the same business (above) — real, but traffic-driven, not a schedule.
- **Reliable ~10 min needs one owner decision** (no code beyond one config line):
  - **A (recommended): Vercel Pro**, then `vercel.json` cron `/api/intake/sweep` at `*/10 * * * *` (GET; Vercel sends the `CRON_SECRET` bearer itself; the secret never leaves Vercel). On the current Hobby plan this line **fails the deployment**, so it must not be merged before the plan changes. GitHub stays as a backstop.
  - B: an external scheduler (e.g. cron-job.org / Upstash QStash) calling the same endpoint — requires handing a Production secret to a third party (a dedicated sweep-only secret would limit it).
  - Not recommended: a self-re-dispatching long-running GitHub job (holds the Production secret continuously; Actions usage-policy risk).
- Failure observability is in place for any scheduler: an unhealthy sweep is a non-2xx.

## 5. Activation runbook — one business

| # | Step | Writes? | Who |
|---|---|---|---|
| 1 | Owner names the business | — | owner |
| 2 | Explicit approval, in the owner's words, for that business only | — | owner |
| 3 | Set `FEATURE_ACCESS_MUTATIONS_ENABLED=true` in Vercel Production (redeploy) — today absent | Production config | owner |
| 4 | Platform admin: `PATCH /api/platform-admin/businesses/<id>/features/acquisition_web_forms` `{state:"ENABLED", reason:"M6 website live proof — owner approval <link>"}` | one `BusinessFeatureAccess` row (audited) | owner (platform admin) |
| 5 | Unset `FEATURE_ACCESS_MUTATIONS_ENABLED` again (back to read-only) | Production config | owner |
| 6 | Verify every other business stays OFF: `ops/evidence/m6-operational-evidence.sql` → expect exactly check 6 = 1 (that business) and everything else PASS; or the live-proof evidence checks 2–3 | read-only | Claude (gate approval) |
| 7 | Business owner: הגדרות → חיבורים → מקורות לידים → טופס באתר → site address → "חיבור טופס" | one `AcquisitionConnection` | the business owner |
| 8 | Paste the ready-made form into the site's contact page (or the developer uses the key) | the site | the business owner |
| 9 | One GENUINE enquiry arrives from the real site | intake → Lead (the real chain) | a real visitor (or the owner using the public form as a customer would) |
| 10 | The same enquiry resubmitted naturally (back + resubmit) | none expected | the same person |
| 11 | Run `ops/evidence/m6-website-live-proof-evidence.sql` read-only → **17/17** | read-only | Claude (gate approval) |
| 12 | Website = LIVE-PROVEN | — | declared on 17/17 |

Never: a synthetic Production lead, enabling a second business, Google or Meta.
