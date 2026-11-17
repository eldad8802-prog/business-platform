# Legal identity correction — admin approval (owner decision 2026-11-13, final)

**Owner rule:** only an authorized Dubiz admin holding a DEDICATED legal-identity-correction permission may view sensitive correction requests and approve or reject them. No merge, no Production apply, no flag, no Production permission change.

## A. Dedicated permission: built on the existing mechanisms (no parallel system)

**Existing (unchanged):**
- A platform admin is `User.role='PLATFORM_ADMIN'` AND an email in the `PLATFORM_ADMIN_EMAILS` env list (lib/auth/platform-admin.ts).
- Sensitive actions use `freshStepUpRefusal` (a 5-minute MFA step-up).

**New: two layers, both required.**

1. **Server:** env `PLATFORM_ADMIN_LEGAL_IDENTITY_APPROVERS`, a comma-separated email list parsed exactly like `PLATFORM_ADMIN_EMAILS`. It fails closed: empty means nobody.
   - Helper: `isLegalIdentityApprover(user)` in lib/auth/legal-identity-approver.ts.
   - Rule: it requires `assertPlatformAdminAccess` to pass first, then the email in the new list.
2. **Database:** table `LegalIdentityApprover`.
   - Columns: `userId` PK, FK to User ON DELETE CASCADE; `grantedAt timestamptz default now()`; `note text NULL`.
   - Who may write it: no application role. Rows are added only by the table owner (a reviewed manual SQL / migration, an owner decision; not done in Production).
   - `decide` and `request_info` refuse unless the approver has a row here AND `role='PLATFORM_ADMIN'` AND is not the requester AND `User.businessId <> request.businessId`.

## B. Database: folded into #1148's migration 20261128100000_legal_identity_correction (still Draft, unapplied)

1. **New columns on LegalIdentityCorrectionRequest:**
   - `publicNote text NULL` (≤1000): shown to the business.
   - `internalNote text NULL` (≤2000): admin only.
   - `infoRequestedAt timestamptz NULL`, `infoRequestNote text NULL` (≤1000): "returned for more information"; the status stays PENDING.
   - Keep `decisionNote`? Rename → `publicNote` is cleaner; fork A decides; the API contract uses `publicNote` / `internalNote`.
2. **The runtime sees only non-internal columns:**
   - Revoke table-level SELECT from app_runtime.
   - Grant column-level SELECT on every column EXCEPT `internalNote` and `decidedByUserId` (the approver's identity is internal).
   - RLS stays.
3. **`legal_identity_correction_decide(p_request_id, p_approver_user_id, p_approve, p_public_note, p_internal_note)`:**
   - Both notes are required for approve AND reject: public ≥5, internal ≥5 chars.
   - The approver checks are as in A2.
   - Re-checks inside the transaction, under the advisory lock + FOR UPDATE:
     - the request is PENDING;
     - the profile still equals the snapshot (else STALE: nothing applied);
     - the business is not being deleted;
     - same-entity rule: currentKind company ⇔ requestedKind company (else NOT_ALLOWED).
   - Answers: APPLIED | REJECTED | STALE | NOT_PENDING | NOT_FOUND | NOT_ALLOWED | NOTE_REQUIRED.
   - **GRANT EXECUTE to app_runtime.** The admin route runs it inside the target tenant's transaction, like app/api/platform-admin/payments/reversals/resolve.
4. **`legal_identity_correction_request_info(p_request_id, p_approver_user_id, p_note)`:**
   - Same approver checks; PENDING only.
   - Sets `infoRequestedAt` / `infoRequestNote`.
   - Answers: REQUESTED | NOT_PENDING | NOT_FOUND | NOT_ALLOWED | NOTE_REQUIRED.
   - GRANT EXECUTE to app_runtime.
5. **Attachments table `LegalIdentityCorrectionAttachment`:**
   - Columns: id, requestId FK, businessId, storageKey (unique, must start with `biz/{businessId}/legal-identity/`), mimeType ∈ {application/pdf, image/jpeg, image/png}, sizeBytes (1..10485760), sha256 char(64), uploadedByUserId, createdAt, anonymisedAt.
   - RLS on the tenant; append-only guard (only the owner moves rows).
   - `legal_identity_correction_attach(p_user_id, p_request_id, p_storage_key, p_mime, p_size, p_sha256)` RETURNS id:
     - tenant context; the requester only; the request is PENDING;
     - at most 5 attachments per request;
     - the key prefix matches the business.
   - EXECUTE to app_runtime; runtime column SELECT on the attachments (all columns).
6. **Admin read plane:** `p7adm_read FOR SELECT TO app_admin USING (true)` + `GRANT SELECT` on both tables to app_admin, inside a role-guarded DO block, exactly like 20261107092000_accountant_ops_admin_read.
7. **Erase:**
   - `legal_identity_correction_erase()` also anonymises attachments (`storageKey` → NULL needs a nullable column under an anonymisedAt guard; sha256 → NULL).
   - Object deletion in storage is done by the application purge (the prefix `biz/{id}/legal-identity/`), declared in the erasure manifest.
8. **The lab covers all of the above**, including:
   - the approver table enforcement;
   - a non-approver admin → NOT_ALLOWED;
   - the runtime cannot SELECT `internalNote` / `decidedByUserId`;
   - attachment limits and prefix;
   - app_admin read.

## C. Owner side (#1152, extend; no admin code)
- **Upload:** attachments while the request is PENDING. Reuse lib/services/trust/trust-document-storage.ts's approach: PDF/JPEG/PNG, ≤10MB, magic bytes via file-signature, a server-random key under `biz/{id}/legal-identity/{requestId}/`, sha256. Then `attach()`; delete the object if the DB step fails.
- **Owner download:** their own files only (tenant check + key prefix), `Content-Disposition: attachment` + `nosniff`.
- **Request page:**
  - list and upload attachments;
  - show "התבקש מידע נוסף" with `infoRequestNote` when set;
  - show the decision status + `publicNote` only. Never `internalNote` or the approver.
- **Statuses in Hebrew:** ממתין לבדיקה / התבקש מידע נוסף / אושר ובוצע / נדחה / בוטל / לא בוצע — הפרטים השתנו.
- **Erasure manifest:** the storage prefix for the new domain, deleted in the account purge (pattern: service-storage-erasure.ts / BusinessDocumentErasure); no new debt if avoidable.

## D. Admin side: NEW PR (branch feat/legal-identity-correction-admin, stacked on #1152)

**Routes** under app/api/platform-admin/legal-identity-corrections/:
- `GET /` — list (approver only):
  - business name, request kind, status, createdAt, infoRequested;
  - tax ids masked (last 3 digits) and legal names truncated in the list.
- `GET /[id]` — detail (approver only):
  - full current vs requested values, reason, attachments metadata, the requester (id, name, email, emailVerifiedAt), verification method/time, all notes;
  - writes PlatformAuditEvent `LEGAL_IDENTITY_CORRECTION_VIEWED`.
- `GET /[id]/attachments/[attachmentId]` — streams the file (approver only), audited `LEGAL_IDENTITY_CORRECTION_ATTACHMENT_VIEWED`.
- `POST /[id]/decision` — body `{ approve: boolean, publicNote, internalNote }`:
  - requires `freshStepUpRefusal`;
  - runs decide in the target tenant's transaction;
  - audit `LEGAL_IDENTITY_CORRECTION_APPROVED|REJECTED|STALE`.
- `POST /[id]/request-info` — body `{ note }`; fresh step-up; audit `LEGAL_IDENTITY_CORRECTION_INFO_REQUESTED`.

**Every route:**
- `requirePlatformAdminOrResponse` as the FIRST await, returning on refusal in the next statement (AST-5);
- then `isLegalIdentityApprover` → 403 `LEGAL_IDENTITY_APPROVER_REQUIRED`;
- reads via the app_admin plane (lib/prisma-admin) for list/detail;
- the decide/request_info service lives OUTSIDE lib/services/platform-admin (CI-4), e.g. lib/services/account/legal-identity-correction-admin.service.ts.

**Feature flag:** `LEGAL_IDENTITY_CORRECTION_ENABLED` (the same flag as the owner side). When off, all admin routes return 404 and the NAV entry is hidden.

**UI:**
- app/(platform-admin)/admin/legal-identity-corrections/page.tsx (list) and /[id]/page.tsx (detail with side-by-side current/requested, reason, attachments, requester, approve/reject/request-info with the required notes);
- a TOOLS entry in admin-console.tsx;
- fetch functions in lib/platform-admin/fetch-platform-admin.ts;
- existing console components; Hebrew RTL.
- Wording: never "verified against an authority". Say "נבדק מבנה המספר בלבד".

**Ambiguous cases:** the UI makes "request more information" the default; approval needs an explicit checkbox "בדקתי את זהות המבקש ואת המסמכים, וזו אותה ישות משפטית".

**Notifications:** none sent in this scope (no real messages). The owner sees the status on the page.

**Tests:** route tests with injected deps (guard order, non-approver 403, flag-off 404, step-up required), service tests, AST/CI guards pass locally.

## E. Issuer declaration (#1117, f7, coordination only)
- After APPLIED, the profile ≠ the live declaration. f7's issuance gate must detect that by value comparison and require a new declaration. No new column is needed; the lock guarantees values change only through a correction.
- **Account-deletion conflict:** #1152 adds `legal_identity_correction_erase()` right after `business_documents_erase()`; #1117 adds `issuer_declaration_erase()` at the same spot. Resolution: keep both calls, the issuer one first, then legal-identity; independent; each refuses unless the business is deleting.
