# WhatsApp Documents Intake MVP Spec (Owner-only)

**Status:** Planning spec only (no implementation).  
**Goal:** Turn WhatsApp into an *intake channel for documents* that enter the existing Documents review flow.

---

## 0) MVP Summary

- Only **owner / authorized** phone numbers can send documents into the system.
- WhatsApp messages are treated as **intake media only** (no chatbot / no conversation AI).
- Accepted `image/*` and `application/pdf` (max `15MB`) are converted into a `Document` in **needs_review**.
- Review happens in the existing Documents UI. Eligibility (INCLUDE/EXCLUDE/REQUIRES_REVIEW) is governed by:
  - `docs/accountant-eligibility-decision-spec-v1.md`
- Accountant Pack export remains unchanged and only includes *financial approvals* from Documents review.

---

## 1) Product Flow (end-to-end)

1. Owner sends a receipt image (or PDF) to the business WhatsApp number.
2. Meta sends a webhook event to the backend (Cloud API / webhook).
3. Webhook handler:
   - verifies webhook signature
   - resolves sender identity to business
   - allows only allowlisted senders
4. For `image/document` messages:
   - extract `media_id` from the webhook payload
   - download media bytes from Graph API (temporary URL semantics)
   - validate mime type + size (MVP cap: 15MB)
   - dedup using an idempotency key (webhook message id + content hash)
5. Create `Document`:
   - persist original file to `storage/documents/<businessId>/...`
   - run OCR + unified document intelligence (same as upload/Gmail pipeline)
   - set `status = needs_review`
   - set `source = "whatsapp"`
   - compute/attach outputProfile (for review defaults)
6. User gets feedback:
   - WhatsApp static reply: “המסמך התקבל” or “לא נתמך / גדול מדי”
7. User reviews inside:
   - Documents Inbox -> `/documents/inbox`
   - Documents review -> `/documents/review/[id]`
8. If user approves as financial, document contributes to:
   - reports
   - Accountant Pack export (ZIP)

---

## 2) Routing Policy (single strict boundary)

Inbound WhatsApp event is routed as follows:

### A) Authorized media => Documents intake ONLY
If `sender ∈ allowlist` AND message contains `image` or `document` media:
- Create Document (needs_review)
- Never call Conversation Inbox/Bot pipeline for this message

### B) Everything else => no document created (MVP)
- If sender NOT allowlisted: do not create documents; optionally static reply.
- If message is text/audio/video/sticker or unsupported mime: do not create documents; optionally static reply.

**No AI routing. No suggestions. No analysis of conversational text for documents.**

---

## 3) Integration Architecture (fit with existing system)

### New integration layer (separate from Conversation Inbox)
- `WhatsApp webhook receiver` (Meta -> your backend)
- `Media fetch + validate` (Graph API -> download bytes -> temp/OCR)
- `WhatsApp import tracking` (dedup/idempotency)

### Reuse existing Documents pipeline
- OCR: `runGoogleVisionOCR`
- Unified extraction: `runUnifiedDocumentIntelligence`
- Create/prepare Document: same “create Document + extractedData” pattern as upload/Gmail
- Review UI and Accountant Pack export remain unchanged

### Channel separation guarantee
The WhatsApp integration must not write into:
- `POST /api/message`
- any conversation analysis/suggestion flows

Only the Documents pipeline is used for accepted media.

---

## 4) Allowed Media (MVP constraints)

- **Allowed:** `image/*`, `application/pdf`
- **Max size:** `15MB` (MVP limit aligned with existing Documents upload + Gmail intake)
- **Unsupported:** audio, video, sticker, office formats (DOCX/XLSX), zip, or any other mime

If unsupported/oversize:
- do not create Document
- return static WhatsApp message indicating the allowed types

---

## 5) Technical Flow (high-level, no implementation)

1. Meta webhook `POST` -> verify signature
2. Parse message(s), extract:
   - business mapping (phone number id / sender identity -> businessId)
   - `media_id` for image/document
   - dedup key candidates
3. Fetch media:
   - Graph API `GET` media endpoint -> obtain temporary URL / bytes authorization
4. Download bytes -> validate -> persist to `storage/documents/<businessId>/`
5. Run OCR + unified extraction -> create Document -> `needs_review`
6. Optional: send static WhatsApp reply (template or free-form depending on channel rules)

**Important timing:** Meta media references expire; download promptly and persist bytes before long OCR/queue steps.

---

## 6) Meta / WhatsApp Constraints (what we must plan for)

MVP must account for:
- Meta media size limits (we cap at 15MB anyway)
- temporary download URL semantics (short-lived)
- idempotency and webhook retries (duplicates happen)
- rate limits on download + processing cost
- privacy: only business-authorized users can view resulting documents

---

## 7) UX Flow (simple mental model)

Owner sees:
1. “שלח קבלה לוואטסאפ”
2. WhatsApp reply: “המסמך התקבל. הוא ממתין לבדיקה במרכז המסמכים.”
3. In-app:
   - `/documents/inbox` shows it as “ממתין לבדיקה”
4. After user approves as financial:
   - “מוכן לרו״ח” (existing Review done state language)

No separate “WhatsApp inbox for documents”. Documents Inbox is the only place documents appear.

---

## 8) Security / Abuse Protections (MVP must-have)

- Allowlist enforcement (owner/authorized phones only)
- Rate limiting per business + per sender (cost protection for OCR)
- Deduplication (idempotency keys + optional content hash)
- File validation (mime + size whitelist)
- Webhook signature verification
- Tenant isolation via `businessId` mapping

---

## 9) Reuse Map

Reused (no behavior change):
- Documents storage and file serving
- OCR and unified extraction
- Document review UI
- Eligibility layer defaults and user decision in review
- Accountant Pack export

New (integration-only):
- Meta webhook receiver (signature validation)
- WhatsApp media fetch + validation
- WhatsApp import tracking + dedup keys
- Allowlist enforcement for senders

---

## 10) MVP Boundaries (explicit non-goals)

Not in MVP:
- conversation AI for documents
- customer-initiated public uploads
- auto-approval
- audio/video/zip intake
- mixed routing into Conversation Inbox

---

## PR readiness (what the first real implementation PR should include)

Even though this spec is not code, the first PR should implement an end-to-end “skeleton”:
1. Meta webhook receiver endpoint (signature verify + event parsing)
2. Allowlist gate + strict media validation (image/PDF only, <= 15MB)
3. Create a `Document` with `source="whatsapp"` and `status="needs_review"` (using existing OCR + extraction services)
4. Dedup/idempotency + basic error handling

