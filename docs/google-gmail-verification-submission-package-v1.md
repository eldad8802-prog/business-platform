# Google Verification Submission Package — Gmail `gmail.readonly` — v1.0

**Status: DRAFT FOR REVIEW (updated to reflect PR #100 — Gmail Disconnect + best-effort Revoke, merged to `main`). Do NOT submit yet.**
Prepared from the actual Dubiz codebase. Do not touch Google Cloud Console, fill forms, or click Submit until this package is approved.

**Legend for every claim:**
- ✅ **CODE-FACT** — verifiable in the current code.
- 📋 **POLICY** — business/operational commitment; not enforced by code alone.

---

## 0. Disconnect / Revoke — implemented (PR #100)

✅ **CODE-FACT.** Dubiz has an owner-initiated, in-app Gmail disconnect (`app/api/integrations/gmail/disconnect/route.ts` → `disconnectGmailConnection`, `lib/services/integrations/gmail/gmail-connection.service.ts`), covered by tests. On disconnect it:
1. **Attempts a best-effort revoke** with Google — `POST https://oauth2.googleapis.com/revoke` (`gmail-token-revoke.service.ts`), preferring the refresh token (revokes the whole grant), falling back to the access token. **Any failure is swallowed and never blocks the local disconnect.**
2. **Deletes the stored OAuthToken locally** (access + refresh), so the tokens can no longer be used.
3. Flips the connection status to `revoked`.
The `EmailConnection` row and its import history are **intentionally preserved** — disconnect is a *revocation*, not a data deletion.

Additionally (✅ CODE-FACT): a user can also revoke Dubiz from their Google Account (`myaccount.google.com/permissions`), and Dubiz detects a revoked/expired token on next use (`invalid_grant` → `GmailReauthRequiredError`) and prompts to reconnect.

There is **no development blocker** to submission.

---

## 1. Scope Justification (final, ≤1000 chars)

> Dubiz helps a business collect its OWN financial documents (invoices, receipts) that arrive as EMAIL ATTACHMENTS, OCR them, and file them for bookkeeping. During discovery Dubiz queries messages matching its criteria (e.g. has:attachment newer_than:30d) and RETRIEVES the full message (format=full) to locate its attachment parts; it then presents the user only attachment metadata and downloads the actual file only for the attachment the user chooses to import. Both steps — reading message structure to find attachments, and fetching attachment bytes — need read access to message content, which only gmail.readonly provides. gmail.metadata returns headers and labels ONLY and cannot read bodies, parts, or attachments, so it cannot locate or retrieve the files the feature depends on. gmail.readonly is the least-privileged scope that works. Access is strictly READ-ONLY: Dubiz requests no send, insert, modify, delete, or label scope and performs no such action in code.

✅ CODE-FACT: scopes requested are exactly `openid`, `email`, `profile`, `https://www.googleapis.com/auth/gmail.readonly`; the Gmail calls in code are `messages.list`, `messages.get` (`format=full`, during discovery, to locate attachments), and `messages.attachments.get`; no write/modify/send/label/delete calls exist. (~979 characters — under the 1000 limit.)

---

## 2. Intended Data Use (final, Limited Use)

**What Gmail data Dubiz accesses** (✅ CODE-FACT):
- During discovery, Dubiz **retrieves the full message** (`format=full`) of the messages that match its document-discovery criteria — **solely to locate their attachment parts**.
- From each such message Dubiz then **surfaces and stores only attachment metadata** (filename, MIME type, size, message/attachment ids). The message **body is not stored, is not shown to the user as part of the feature, and is not used for any general analysis of the mailbox**.
- Only after the user selects a file are the **bytes of that specific attachment** downloaded (and OCR'd).

**Dubiz does NOT read the whole mailbox for general analysis** (✅ CODE-FACT): discovery is scoped by the default Gmail filter `has:attachment newer_than:30d` (`gmail-discovery.service.ts`). It does retrieve the full message to find attachments, but it **keeps only the attachment parts** (a part with an `attachmentId` and a filename/MIME type) and discards the rest — it never profiles or analyzes the user's general email content.

**Sole purpose** (✅ CODE-FACT + 📋 POLICY): to extract and file the user's OWN financial documents for the user's OWN bookkeeping, inside the user-facing Documents feature. Import is user-initiated per attachment.

**How it is processed** (✅ CODE-FACT):
- The imported attachment is sent to **Google Cloud Vision solely for OCR processing** (image/PDF → text) and for no other purpose. This is the only third party that receives document content.
- Structured financial fields (amount, vendor, date, category) are extracted **locally on Dubiz infrastructure** by an internal engine — no external LLM/AI service receives the data. (`OPENAI_API_KEY` is used only by unrelated content-generation features, never in the Gmail/OCR path.)
- The temporary OCR file is **deleted in a `finally` block when the import request completes** — whether it succeeded or failed — so it never persists beyond the request. (Evidence: `import/route.ts` sets `cleanup` after `writeTempOcrFile` and calls it in the request's `finally`.)
- OAuth tokens (access + refresh) are stored **encrypted at rest with AES-256-GCM**; encryption fails closed if the key is missing.

**Limited Use commitments:**
- 📋 Data is used **only** to provide and improve the user-facing document-import feature.
- 📋 Data is **never used for advertising**.
- 📋 Data is **never sold**.
- ✅/📋 Data is **not transferred to any third party except Google Cloud Vision**, used strictly as an OCR **sub-processor** to provide the feature.
- 📋 No Dubiz personnel access user email content in the ordinary course of providing the service; extraction is automated and the results are shown back to the user for their own review.

**Disconnect / revoke wording** — ✅ **CODE-FACT** (matches the PR #100 implementation):

> When a user disconnects Gmail, Dubiz promptly stops local access, deletes the stored token locally, and attempts to revoke the Google authorization using Google's OAuth revocation endpoint on a best-effort basis.

Precision to preserve: do **not** say "immediately revokes." Revocation is **best-effort** — if the Google revoke call fails, the local disconnect (token deletion) still completes, so access is stopped locally regardless. Do not claim revocation is always guaranteed.

---

## 3. Feature / Scope Selection (what to check, and what NOT to)

Dubiz requests exactly four scopes. On the OAuth consent-screen scope list:

**Select / add:**
- `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile` — ✅ non-sensitive; used only to identify the connecting account.
- `.../auth/gmail.readonly` — ✅ the restricted scope; the **only** scope that exposes attachment content (Section 1).

**Do NOT select** (least privilege — Dubiz neither needs nor uses these; the code performs no such operations):
- `gmail.metadata` — insufficient (no bodies/attachments), so not used.
- `gmail.modify`, `gmail.labels` — Dubiz never changes labels/state.
- `gmail.send`, `gmail.insert`, `gmail.compose` — Dubiz never sends or writes mail.
- `https://mail.google.com/` (full access) — far broader than needed.
- `gmail.settings.*` — never touches settings.

📋 **Use-case category note:** Google's restricted-scope form may also ask you to pick a *use-case category*. The exact labels change over time — verify against the live form — but the correct framing is **"the app imports/extracts the user's own data for the user's own use"** (a document/records importer), **NOT** an "email client / mailbox replacement." Describe Dubiz as a bookkeeping document importer, not a mail client.

---

## 4. Demo Video Script (shot-by-shot)

Record at 1080p, ~2–4 min, English captions. Show a **real, working** app on your production domain.

**Shot 1 — App context (10–15s).**
Show the Dubiz app, signed in, on the Documents area. Caption: *"Dubiz — a bookkeeping app that files a business's financial documents."*

**Shot 2 — Start Gmail connect (10s).**
Click "Connect Gmail" in Documents. Caption: *"The user chooses to connect their own Gmail to import invoices/receipts."*

**Shot 3 — Google OAuth consent screen (15–20s) — REQUIRED.**
Show the **actual Google consent screen**, clearly displaying the requested scopes including "Read your email messages and settings" (gmail.readonly). Caption: *"Read-only access. Dubiz never sends, deletes, or modifies email."* Complete consent.

**Shot 4 — Connected + Gmail sync (15–20s).**
Return to Dubiz; show the imported email list (messages with attachments). Caption: *"Dubiz lists messages and their attachments so the user can pick documents to import."*

**Shot 5 — Import + OCR (20–30s).**
Select one attachment → import. Show the extracted document open for review (amount/vendor/date). Caption: *"The selected attachment is OCR'd (Google Cloud Vision) and filed for the user's bookkeeping. Extraction runs on Dubiz's own servers."*

**Shot 6 — Disconnect + Revoke (20–30s) — ✅ EXISTING CAPABILITY.**
In Dubiz's connected-accounts UI, click "Disconnect" on the Gmail account. Show the account moving to a disconnected/revoked state. Caption: *"The user can disconnect at any time; Dubiz stops local access, deletes the stored token, and attempts to revoke the Google authorization (best-effort)."*
- Do not imply guaranteed revocation. If you want to also demonstrate it end-to-end, after disconnect show `myaccount.google.com/permissions` no longer listing Dubiz — but keep the caption "best-effort," since a failed Google revoke would not block the local disconnect.

**Shot 7 — Close (5–10s).**
Caption: *"Gmail data is used only to import the user's own documents — never for ads, never sold, not shared beyond the OCR processor."*

---

## 5. Pre-Submit Checklist

- [x] ✅ **In-app Gmail Disconnect + best-effort token Revoke** — shipped (PR #100). Confirm it is live in the deployed environment and demonstrable for Shot 6.
- [ ] OAuth consent screen **Published to Production** (out of "Testing").
- [ ] **Homepage URL** live, describing Dubiz accurately.
- [ ] **Privacy Policy URL** live and covering each of the following sub-topics explicitly (so nothing is omitted):
  - [ ] **Gmail Data** — exactly what is accessed (attachment-bearing message context + the attachments the user imports) and that the mailbox is not scanned for general analysis.
  - [ ] **OCR Provider** — that imported documents are sent to **Google Cloud Vision solely for OCR**, and to no other third party.
  - [ ] **Local Extraction** — financial-field extraction happens on Dubiz's own infrastructure; no AI/LLM third party receives the data.
  - [ ] **Encryption** — OAuth tokens encrypted at rest (AES-256-GCM), fails closed without the key.
  - [ ] **Disconnect / Revoke** — user can disconnect; Dubiz deletes the local token and attempts a best-effort Google revoke.
  - [ ] **Limited Use** — no advertising, no sale, no transfer beyond the OCR sub-processor; used only for the feature.
  - [ ] **Retention** — temporary OCR file deleted when the request completes; imported documents/records retained as the user's own data; token deleted on disconnect.
  - [ ] **User Rights / Deletion** — how a user requests deletion of stored data.
- [ ] **Authorized redirect URI** registered exactly: `https://promaxgroup.co.il/api/integrations/gmail/callback` (https, no trailing slash).
- [ ] Consent-screen **scopes = exactly** `openid`, `email`, `profile`, `gmail.readonly` — nothing broader.
- [ ] **Demo video** recorded incl. the real consent screen (Shot 3) and disconnect (Shot 6).
- [ ] **Production env vars** set: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_BASE_URL`, `GMAIL_TOKEN_ENCRYPTION_KEY`, and `GOOGLE_VISION_CREDENTIALS_JSON`.
- [ ] 📋 **CASA security assessment** — this is an **external requirement imposed by Google** for Restricted Scopes (not an internal Dubiz checklist item): under Google's **current** requirements, `gmail.readonly` requires a Tier-2 CASA assessment through a Google-authorized third-party assessor before/for production verification. Budget time and cost, and re-confirm the exact tier/requirement against Google's live verification instructions (these can change over time).
- [ ] App name / logo / support email on the consent screen match the verified domain.
- [ ] Privacy Policy and video are consistent with this package (no claim beyond what the code does).

---

## 6. FAQ — ready answers for Google

**Q: Why does Dubiz need `gmail.readonly`?**
✅ To download the **attachment bytes** of the user's financial documents (invoices/receipts) and read the identifying message context. Attachment content is only reachable via a read scope; `gmail.metadata` returns headers/labels only and cannot read attachments. It is the least-privileged scope that works.

**Q: How are OAuth tokens stored?**
✅ Access and refresh tokens are encrypted at rest with **AES-256-GCM**; the key comes from `GMAIL_TOKEN_ENCRYPTION_KEY` and encryption **fails closed** if the key is missing/invalid. Tokens are stored in the `EmailConnection` record, never in logs.

**Q: How does a user disconnect Gmail?**
✅ **Code Verified.** From Dubiz's connected-accounts UI the user clicks Disconnect. Dubiz promptly stops local access, **deletes the stored token locally**, and **attempts to revoke** the Google authorization via Google's OAuth revocation endpoint (`https://oauth2.googleapis.com/revoke`) on a **best-effort basis** — if that call fails, the local disconnect still completes, so access is stopped locally regardless. The connection record and import history are preserved (revocation, not deletion). ✅ Users may also revoke Dubiz directly at `myaccount.google.com/permissions`; Dubiz then detects the revoked token (`invalid_grant`) and prompts to reconnect.

**Q: Is there human access to the email data?**
📋 No Dubiz personnel access user email content in the ordinary course of the service. ✅ Processing is automated (Google Cloud Vision OCR + local extraction); the extracted document is shown back to the **owning user** for review.

**Q: Is Gmail data used for advertising?**
📋 No. Never used for advertising or ad targeting.

**Q: Is data transferred/sold to third parties?**
✅/📋 Not sold. The only third-party recipient of document content is **Google Cloud Vision** (OCR sub-processor) — necessary to provide the feature. ✅ Financial extraction is local; no data goes to OpenAI or any other AI/third party (the OpenAI key is used only by unrelated content features).

**Q: How does Dubiz comply with the Limited Use requirements?**
📋/✅ Gmail data is used **only** to provide the user-facing document-import feature; **not** for ads; **not** sold; **not** transferred except to the Google Cloud Vision OCR sub-processor; ✅ transient OCR files are deleted when the import request completes (in a `finally`) and tokens are encrypted at rest. Human access is not part of the ordinary service.

**Q: What data is retained, and for how long?**
✅ The temporary OCR file is deleted in a `finally` block when the import request completes (success or failure), so it does not persist beyond the request. ✅ On disconnect, the stored OAuth token is deleted. The imported document + its extracted fields are stored as the user's own records in Dubiz (the product's purpose). 📋 Define an explicit retention/deletion policy for those records (and any user-requested deletion) in the Privacy Policy.

---

## 7. Claims explicitly flagged as NOT code-facts (do not present as such)
- 📋 "No human access to data" — operational policy, not code-enforced.
- 📋 "Never used for advertising / never sold" — policy commitment.
- ✅ In-app disconnect + best-effort Google token revocation — **implemented (PR #100)**; note the revocation is best-effort (not guaranteed), while the local token deletion always completes.
- 📋 CASA assessment, retention windows, use-case category labels — depend on Google's current process/forms; verify against the live flow.

---

## 8. Evidence Matrix (internal — claim → proof in code)

For our own use, not for Google. Every code-fact claim in this package maps to the file that proves it, so a follow-up question months from now can be answered from the source without re-auditing. Paths are on `main` (post-PR #100).

| # | Claim (✅ CODE-FACT) | Proof in code |
|---|---|---|
| 1 | Requested scopes = `openid`, `email`, `profile`, `gmail.readonly` (read-only; no send/modify/delete/label) | `lib/services/integrations/gmail/oauth-url.service.ts` (`GMAIL_OAUTH_SCOPES`) |
| 2 | OAuth authorize URL is built from exactly those scopes | `lib/services/integrations/gmail/oauth-url.service.ts` |
| 3 | Discovery is scoped to attachment-bearing messages (`has:attachment newer_than:30d`), not whole-mailbox analysis; only attachment parts collected | `lib/services/integrations/gmail/gmail-discovery.service.ts` (`discoverGmailAttachments`, `collectAttachments`, default `q`) |
| 4 | Sync surfaces discovered attachments to the user | `app/api/integrations/gmail/sync/route.ts` |
| 5 | Only user-chosen attachment bytes are downloaded (`users.messages.attachments.get`) | `lib/services/integrations/gmail/gmail-attachment-fetch.service.ts`; called from `app/api/integrations/gmail/import/route.ts` |
| 6 | Import is user-initiated per (messageId, attachmentId) | `app/api/integrations/gmail/import/route.ts` (POST) |
| 7 | OCR is Google Cloud Vision, solely for OCR | `lib/services/documents/google-vision-ocr.service.ts` (`runGoogleVisionOCR`); called from `import/route.ts` |
| 8 | Financial-field extraction runs locally; no external LLM/AI receives the data | `lib/services/documents/unified-extraction-engine.service.ts` (via `lib/services/documents/create-document-from-ocr.service.ts`) — no external HTTP/OpenAI calls |
| 9 | `OPENAI_API_KEY` is used only by unrelated content/conversation features, never in the Gmail/OCR path | `lib/features/content/**`, `lib/features/conversation/llm-draft/**`, `lib/services/ai-content.service.ts` (grep: absent from `lib/services/documents/**` OCR path) |
| 10 | Temporary OCR file deleted in a `finally` when the import request ends | `app/api/integrations/gmail/import/route.ts` (`cleanup` in `finally`); `lib/services/integrations/gmail/temp-ocr-file.service.ts` (`unlink`) |
| 11 | OAuth tokens encrypted at rest (AES-256-GCM), fails closed without key | `lib/services/integrations/gmail/token-crypto.placeholder.ts` |
| 12 | In-app Disconnect deletes local token + flips status to `revoked`, preserves connection/import history | `lib/services/integrations/gmail/gmail-connection.service.ts` (`disconnectGmailConnection`); `app/api/integrations/gmail/disconnect/route.ts` |
| 13 | Best-effort Google revoke via `POST https://oauth2.googleapis.com/revoke`; failure swallowed (never throws). The **prefer-refresh-token** choice is made by the **caller** | **Google call:** `lib/services/integrations/gmail/gmail-token-revoke.service.ts` (`revokeGoogleGmailToken`, `REVOKE_ENDPOINT`). **Prefer-refresh logic:** `lib/services/integrations/gmail/gmail-connection.service.ts` (`disconnectGmailConnection`: `refresh ?? access`) |
| 14 | Revoked/expired token → reconnect prompt. Detection is based on an **HTTP 400** response from the token-refresh call (which in practice corresponds to `invalid_grant`), **not** on parsing the error string | `lib/services/integrations/gmail/oauth-refresh.service.ts` (`res.status === 400` → `GmailReauthRequiredError`); `gmail-errors.ts` |

**Policy / external items (not code-facts) — no code proof by design:** no human access to data; never used for advertising; never sold; CASA assessment; retention windows; use-case category label. These are business/operational commitments or Google-process items, tracked in Sections 2, 5, and 7.
