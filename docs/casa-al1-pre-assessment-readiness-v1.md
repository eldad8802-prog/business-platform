# CASA AL1 — Pre-Assessment Readiness, Assessor Register and DAST Plan (v1)

**Baseline.** `main` = `cd45af1`; production = `cd45af1`; production migration
ledger 115 applied / 0 in flight / 0 rolled back, newest completion
2026-09-02T23:15:42Z. Main and production are in sync; there is no drift.

**Method.** Every statement below was re-derived at this baseline. Nothing is
carried forward from an earlier report without re-verification. Where a claim
could not be established from this environment, it is written as a gap with the
exact missing evidence, not softened into a pass.

---

## 1. What the evidence base actually covers

Five CASA memos are committed to `main`:

| Document | Requirement addressed |
| --- | --- |
| `casa-2-2-3-session-lifetime-evidence-v1.md` | 2.2.3 |
| `casa-3-3-1-platform-admin-mfa-evidence-v1.md` | 3.3.1 |
| `casa-6-1-1-dependency-evidence-v1.md` | 6.1.1 |
| `casa-7-2-cardcom-webhook-compensating-control-v1.md` | 7.2.1 / 7.2.2 |
| `casa-7-2-dormant-provider-closure-evidence-v1.md` | 7.2.1 / 7.2.2 |

**The CASA Specification and Test Guide are not stored in this repository.**
Consequently this document builds the matrix over requirements that are named
and evidenced in the work to date. The complete enumeration of all test cases
under all requirements cannot be reproduced faithfully from repository sources,
and transcribing it from the official test guide into a version-controlled
checklist is itself an outstanding action, listed in section 8. Any matrix
presented as complete without that transcription would be an invention.

---

## 2. Control status at this baseline

### 2.2.3 — Session lifetime

**PASS — EVIDENCE COMPLETE.** Memo committed. No regression observed at this
baseline.

### 3.3.1 — Administrative multi-factor authentication

**PASS — EVIDENCE COMPLETE.** Step-up elevation is present in
`lib/platform-admin/admin-elevation.ts` with a hard ceiling of
`ADMIN_ELEVATION_MAX_SECONDS = 15 * 60`. Enforcement is live in production and
the memo is committed. Re-verified present at `cd45af1`.

### 4.1.1 / 4.1.2 — Transport security

**PASS — IMPLEMENTATION COMPLETE / EVIDENCE MISSING.** See section 5.

### 6.1.1 — Vulnerable components

**PASS — IMPLEMENTATION COMPLETE / EVIDENCE REFRESH REQUIRED.** The base memo
remains materially correct, but the scan has moved. One new advisory entered the
production graph: `fflate@0.8.2`, published CVSS **7.5**, labelled only
*moderate* by `npm audit`. It is argued not-invoked, with evidence, in
`casa-6-1-1-dependency-evidence-addendum-v1.md`, added alongside this document.
High and critical counts are otherwise unchanged.

### 6.4.1 — DNS / subdomain takeover

**EVIDENCE GAP, NO LONGER BLOCKED.** See section 4.

### 7.2.1 / 7.2.2 — Webhook authentication and integrity

**MIXED — see section 3.** PayPal and Tranzila are closed as capabilities.
CardCom requires an assessor decision. WhatsApp holds HMAC-before-parse.

### 7.2.3 — Webhook replay protection

**REMEDIATION GAP for WhatsApp; ASSESSOR DECISION for CardCom.** See section 3.

---

## 3. Webhook consumers — the 7.2 family

Three webhook surfaces exist. Their situations are genuinely different and must
not be answered with one sentence.

### 3.1 PayPal and Tranzila — closed

Not consumer capabilities any more. The capability gate returns before
`processPaymentWebhook` is entered. Evidence memo committed. **Nothing further
is required for these two.**

### 3.2 WhatsApp Cloud API

**Verified in code at `cd45af1`:**

- `verifyWebhookSignature` runs **before** `JSON.parse(rawBody)` in
  `app/api/integrations/whatsapp/webhook/route.ts`. Confirmed by index
  comparison, not by reading order.
- `SUPPORTED_CHANGE_FIELD = "messages"` is enforced in
  `webhook-parse.service.ts` **before** `change.value` is read.
- Only `text`, `image` and `document` reach a mutating path; `statuses` is
  inert.
- **Zero** occurrences of `timestamp` in any non-test WhatsApp source file. No
  timestamp is extracted; no tolerance window exists.
- Import idempotency exists on `wamid` plus a content hash.

**What Meta officially documents.** Read directly from public developer
documentation; Meta was not contacted.

- Event notification payloads are signed with SHA256, carried in
  `X-Hub-Signature-256`, computed over **the payload**. No timestamp is placed
  in the signature base string, and **no timestamp header, replay-protection
  mechanism or tolerance window is documented**.
- The Graph API webhooks documentation defines `entry[].time` as *"A UNIX
  timestamp indicating when the Event Notification was sent (not when the change
  that triggered the notification occurred)."*
- The WhatsApp Cloud API payload reference shows `messages[].timestamp` in
  examples as a numeric string, but publishes **no field table** stating its
  units, its semantics, or whether it is guaranteed present.

**Classification: ASSESSOR DECISION, with a remediation option.**

Not "blocked on external contract evidence", and not "remediation possible now"
as CASA words it. The reasoning:

1. CASA 7.2.3 asks for a timestamp **inside the signature base string**. Meta
   puts no timestamp there. However, because the HMAC covers the entire raw
   body, any timestamp **within** the body is inside the signed material and
   cannot be modified without invalidating the signature. Rejection-on-
   modification is therefore already satisfied by signature verification.
2. `entry[].time` is officially documented with the exact semantics a tolerance
   window needs. `messages[].timestamp` is not formally documented and should
   not be relied on for a security decision.
3. What is genuinely absent is the **tolerance window**. Dubiz enforces none.

A narrow remediation is therefore technically available: read `entry[].time`
after signature verification, require it to be present and integral, and reject
the delivery when it falls outside a bounded window, before any mutation. It
would preserve HMAC-before-parse, preserve the event-class boundary, need no
schema change, and fail closed.

**It is not implemented in this change, deliberately.** Meta documents no
delivery-latency or retry-window expectation, so any specific tolerance value
would be chosen by us rather than derived from the provider contract, and a
window chosen too tightly would silently discard legitimate retried deliveries.
That is a product-risk decision for the owner, not an implementation detail.

**Scope note that materially reduces urgency.** Production holds **zero**
`WhatsAppConnection` rows and **zero** `WhatsAppAttachmentImport` rows. The
WhatsApp webhook has never processed a real message in production. It is
implemented but unactivated.

### 3.3 CardCom

**What the requirements ask literally.**

- **7.2.1** — the consumer authenticates the webhook sender.
- **7.2.2** — the consumer verifies message integrity, conventionally by a
  signature over the payload.
- **7.2.3** — the consumer resists replay, conventionally by a timestamp inside
  the signature base string plus a tolerance window.

**What CardCom provides.** Nothing at this layer. CardCom publishes **no webhook
signing mechanism**: no HMAC header, no signing secret, no signature. Its
documented model is an `IndicatorUrl` / `WebHookUrl` notification carrying
`LowProfileId` and `ReturnValue`, with authenticity obtained **out of band** by
the merchant calling `LowProfile/GetLpResult` with its own API credentials.

**What Dubiz implements.** `verifyWebhook` performs a fail-closed structural
gate only: the body must carry a `LowProfileId` matching the canonical GUID
pattern, or the delivery is rejected as `malformed_lowprofileid`. It is
synchronous and has no database access, so it cannot do more. Authenticity is
established downstream and is not optional:

1. `LowProfileId` must resolve to a `PaymentRequest` this system created;
2. `ReturnValue` must independently match that request id;
3. the settlement outcome comes **only** from an authenticated server-to-server
   `GetLpResult` call — never from the callback payload. `parseWebhook`
   deliberately never returns `PAID`.

An earlier implementation invented an `x-cardcom-secret` header and failed
**open** when no secret was configured. That was removed rather than papered
over; the invented header is one CardCom never sends.

**Replay resistance actually present.** Persistence is idempotent on
`(provider, providerEventId)`, with a second idempotency layer on the
authoritative transaction id. A replayed callback yields `duplicate_event` or
`duplicate_transaction` and produces no second transaction and no second
financial effect.

**Verdict per requirement.**

| Requirement | Claim |
| --- | --- |
| 7.2.1 | **Compensating control.** Sender is not authenticated; the *event* is authenticated out of band before it can affect state. |
| 7.2.2 | **Compensating control.** Payload integrity is not verifiable; payload content is never trusted, so its integrity is not load-bearing. |
| 7.2.3 | **Impossible to claim literally.** No timestamp and no signature base string exist to place one in. Idempotency plus out-of-band authority is offered in its place. |

---

## 4. CASA 6.4.1 — DNS and subdomain takeover

**Moved from BLOCKED to EVIDENCE GAP with exact missing evidence.**

**In-scope hostnames.** Enumerated from the Vercel projects and cross-checked
against every hostname referenced in application source. The scope is small.

| Hostname | Record | Target | Service | Resolves | Dangling evidence | Takeover risk |
| --- | --- | --- | --- | --- | --- | --- |
| `promaxgroup.co.il` | A | `76.76.21.21` | Vercel apex, attached and verified on the production project | yes | none | not applicable |
| `business-platform-khaki.vercel.app` | A | `216.198.79.67`, `64.29.17.67` | Vercel production alias | yes | none | not applicable, vendor-owned namespace |
| `business-platform-btrl.vercel.app` | A | `216.198.79.195`, `64.29.17.195` | Vercel alias of the duplicate project | yes | none | not applicable, vendor-owned namespace |
| `www.promaxgroup.co.il` | none | — | none | **no** | not applicable, nothing points anywhere | none |

`promaxgroup.co.il` is the only custom domain on the team, its `serviceType` is
`external`, and its authoritative nameservers are `ns1`, `ns2` and `ns3` at
`box.co.il`. Mail is delegated to Google Workspace. Every hostname that resolves
points at a live, claimed service. **No dangling record was found in the
observable scope, and no takeover-eligible binding was identified.**

**Why this is a gap and not a pass.** The zone is hosted at an external
registrar. From this environment the zone can only be probed record by record;
it cannot be **enumerated**. Absence of evidence of a dangling subdomain is not
evidence of absence when the record list itself is unavailable.

**Exact missing evidence, one item.** A full authoritative zone export for
`promaxgroup.co.il` from the DNS provider at `box.co.il`, listing every A, AAAA,
CNAME, ALIAS and NS record. With that export, each record is checked against
this table and 6.4.1 closes as **PASS WITH EVIDENCE**. Owner action; Claude has
no access to that registrar.

---

## 5. CASA 4.1.1 / 4.1.2 — TLS

**Measured at this baseline against the three live hostnames.**

| Observation | Result |
| --- | --- |
| TLS 1.3 | negotiated on all three hosts |
| TLS 1.2 | negotiated on all three hosts |
| HTTP on port 80 | `308 Permanent Redirect` to the `https` origin |
| HSTS | `max-age=63072000; includeSubDomains` on all three; no `preload` |
| Certificate | `CN=promaxgroup.co.il`, Let's Encrypt, SAN matches, valid 2026-08-05 to 2026-11-03 |

**What could not be established here, stated plainly.** Local `curl` and local
OpenSSL 3.5.6 both **refuse to offer** TLS 1.0 and TLS 1.1. The failures are
client-side (`SEC_E_UNSUPPORTED_FUNCTION`, "no protocols available"), not server
rejections. **Server-side refusal of TLS 1.0 and 1.1 is therefore unproven from
this environment**, and so is the cipher-suite inventory. Reporting these as
passes would misattribute a client limitation to the server.

**Exact external evidence required.** A Qualys SSL Labs report, grade **B or
better**, saved as PDF, for:

1. `promaxgroup.co.il`
2. `business-platform-khaki.vercel.app`

`business-platform-btrl.vercel.app` is a non-canonical duplicate project and is
listed here only so its exclusion is deliberate rather than accidental.

**Timing note.** The current certificate expires **2026-11-03**, before the
assessment deadline of 2026-11-28. Vercel renews automatically, but the SSL Labs
capture should be taken against a certificate that will still be valid when the
assessor reads it.

No TLS configuration change is proposed. Nothing in the measured posture
suggests one is needed.

---

## 6. DAST pre-assessment plan

**The blocker comes first, because it gates every case.**

`ssoProtection` on the production project is `all_except_custom_domains`, and
there are **zero** protection-bypass keys configured. Every Preview deployment
and the `vercel.app` production alias sit behind Vercel SSO. **The only
scanner-reachable surface today is `promaxgroup.co.il`, which is production.**

**Least invasive resolution.** Create a Protection Bypass for Automation secret
on the project and point the scanner at a dedicated Preview deployment,
supplying the bypass header. This keeps the scan off production, needs no change
to `ssoProtection` for human users, and is revocable in one action. Creating
that secret is an **owner action** — it is a credential, and it is not created
here.

**Until that exists, no DAST case can execute anywhere except production**, and
production scanning is not authorised.

**Per-case plan.** The 18 DAST-backed cases fall into four groups that share a
setup, so they are planned by group rather than repeated eighteen times.

| Group | Cases | Auth state | Data needed | Destructive | Isolation required | Evidence artifact | Pass criterion |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Authentication and session | 2.1.1, 2.3.1, 2.3.2, 2.3.4 | unauthenticated, then authenticated as the retained synthetic account | one synthetic tenant | no | none beyond tenant scoping | scanner report plus request and response pairs | no credential accepted over a weakened path; session fixation and reuse rejected |
| Access control | 3.1.5, 3.1.6 | authenticated as a **second** synthetic tenant | two synthetic tenants | no | cross-tenant probes must target synthetic data only | scanner report plus the denied cross-tenant responses | no cross-tenant read or write succeeds |
| Input validation and output encoding | 5.1.1 through 5.1.10 | authenticated | one synthetic tenant with seeded records | **yes**, injection probes write | dedicated Preview database branch; never the production branch | scanner report per case | no injection, traversal or unsafe deserialisation succeeds |
| Configuration and error handling | 6.2.1, 6.3.1 | both | none | no | none | scanner report plus captured error responses | no stack trace, version banner or debug output leaks |

**Blockers before any scanner runs, in order:**

1. The protection-bypass secret does not exist. *(owner)*
2. No isolated database branch is designated for the destructive 5.1.x group.
   Pointing those at the production branch is not acceptable. *(owner decision
   on which branch)*
3. The second synthetic tenant required by the access-control group is not
   confirmed to exist. Four candidate synthetic accounts exist in production;
   which are usable, and whether a second tenant exists, is unconfirmed.
4. The scanner itself is not chosen or licensed.

---

## 7. Assessor-decision register

Entries are written to be handed to an assessor unchanged. No assessor has been
contacted.

**AD-1 — CardCom sender authentication (7.2.1).**
CardCom publishes no webhook signing mechanism. Dubiz never trusts the callback
payload: the outcome is obtained only from an authenticated server-to-server
`GetLpResult` call, after `LowProfileId` resolves to a request this system
created and `ReturnValue` independently matches it. *Question:* does out-of-band
authentication of the event satisfy 7.2.1 where the provider offers no sender
authentication?

**AD-2 — CardCom payload integrity (7.2.2).**
No signature exists to verify. Payload content is never used to make a
settlement decision. *Question:* is integrity verification satisfied by making
the payload non-load-bearing, rather than by verifying it?

**AD-3 — CardCom replay protection (7.2.3).**
No timestamp and no signature base string exist. Replay is absorbed by
idempotency on `(provider, providerEventId)` and again on the authoritative
transaction id; a replayed callback produces no second financial effect.
*Question:* is idempotency plus out-of-band authority accepted in place of a
timestamp tolerance window?

**AD-4 — WhatsApp replay protection (7.2.3).**
Meta signs the raw body only and documents no timestamp header, replay mechanism
or tolerance window. `entry[].time` is documented and, being inside the body, is
covered by the HMAC. Dubiz enforces no window. The integration has never
processed a production message. *Question:* is a bounded window over
`entry[].time` the expected remediation, and what tolerance is acceptable given
Meta publishes no retry-window contract?

**AD-5 — Non-invoked vulnerable components (6.1.1).**
Two production-graph components carry published CVSS 7.5 — `uuid@8.3.2` via
`exceljs`, and `fflate@0.8.2` via `jspdf` — and both are argued under the
non-invocation exemption with source-level searches. *Question:* is the
non-invocation exemption accepted on this evidence?

---

## 8. Outstanding actions, in execution order

1. Export the authoritative DNS zone for `promaxgroup.co.il` from the provider
   at `box.co.il`. Closes 6.4.1.
2. Capture Qualys SSL Labs PDF reports for `promaxgroup.co.il` and
   `business-platform-khaki.vercel.app`. Closes 4.1.1 and 4.1.2.
3. Create a Vercel Protection Bypass for Automation secret and designate an
   isolated database branch for the destructive DAST group. Unblocks all 18
   DAST cases.
4. Decide the WhatsApp 7.2.3 position: implement a bounded window over
   `entry[].time`, or carry AD-4 to the assessor as written.
5. Transcribe the CASA Test Guide case enumeration into a version-controlled
   checklist, so completeness can be asserted from a source of truth rather than
   from memory.

---

## 9. Separate production-security debt

Tracked here because it was verified in the same pass, and deliberately **not**
counted as a CASA blocker without an official mapping.

**Runtime database identity.** Production application traffic connects as
`neondb_owner`, which has `rolbypassrls = true`. 87 of 106 public tables have
row-level security enabled and 109 policies exist, so the policy surface is
built — but it is **inert at runtime**, because the connecting role bypasses it.
The intended restricted role `app_runtime` exists with `rolbypassrls = false`
but has `rolcanlogin = false`, so it cannot yet be used. **STILL PRESENT.**

**Admin data plane.** `app_admin` exists with `rolcanlogin = false`, and
`ADMIN_DATABASE_URL` is configured for **Preview only** and is absent from
Production. **STILL PRESENT, unchanged.**

Neither is claimed as a CASA control failure here. Both are production-security
debt of real severity and are tracked separately.

---

## 10. Explicitly not claimed

No assessor acceptance. No Google verification outcome. No claim that DAST has
run. No claim that TLS 1.0 or 1.1 is refused by the server. No claim that the
DNS zone contains no dangling record. No claim that the case matrix is complete
against the official test guide.
