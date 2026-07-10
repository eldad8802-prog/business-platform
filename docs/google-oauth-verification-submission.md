# Google OAuth Verification Submission Package (Reconstructed from Verified Implementation)

_This document was reconstructed from the verified implementation, production validation, published privacy policy, Google Cloud configuration, and approved design decisions. It is not presented as a verbatim recovery of a previously stored document. Following final approval, this document will become the canonical source of truth for the Google OAuth Verification submission._

## 1. Scope Justification (gmail.readonly)

Dubiz requests `gmail.readonly` to enable users to import invoices and receipts that arrive as email attachments into their expense records. This requires access to attachment content within the user's mailbox, which only `gmail.readonly` (or a broader Gmail scope) provides. Narrower scopes such as `gmail.metadata` expose only message headers and labels, not attachment content, and therefore cannot support this functionality, per Google's OAuth scope documentation.

## 2. Intended Data Use

Discovery and Import are two distinct steps. Discovery identifies messages that may contain attachments resembling invoices or receipts; this identification step does not persist message or attachment content. Import occurs only after a user-initiated action, clicking Import on a specific attachment. Only the document the user selects is processed via OCR. Only the information needed for that document record (for example vendor, amount, date, and source) is stored. No other message content, and no attachments the user did not choose to import, are stored. The Gmail OAuth token itself is stored encrypted and is used only to perform the Discovery and Import actions described above, consistent with the published Privacy Policy's Gmail section.

## 3. Demo Video Script

The script follows the sequence verified end-to-end in Production, and will explicitly show: the Google consent screen displaying the requested scope, a reference to the Privacy Policy, the resulting Connected state, the Discovery step, importing one attachment and the resulting document record, and finally clicking Disconnect and showing the resulting Disconnected state. The video is recorded against the live production environment. Every claim made in the Scope Justification and Intended Data Use sections will be visibly demonstrated on screen.

## 4. FAQ

**Why `gmail.readonly` rather than a narrower scope?** Covered in Scope Justification above, per Google's scope documentation.

**What data is accessed and retained?** Only attachments the user explicitly imports are processed into document records; the OAuth token is stored encrypted. See Intended Data Use.

**What happens on disconnect?** The app attempts token revocation and stops all Gmail access, verified in the Production E2E test.

**Who performs the OCR?** Google Cloud Vision is used solely for OCR processing of the imported attachment. The extracted financial information is processed within Dubiz.

**Where is this documented for end users?** In the published Privacy Policy's Gmail-specific section.

## 5. Checklist

Branding fields (app name, homepage, privacy link, terms link, authorized domain): verified matching in the Google Cloud read-only audit.

Support email / developer contact: to be set to support@promaxgroup.co.il for both fields.

Logo: to be uploaded directly at edit time.

Scope Justification, Intended Data Use, Demo Video: content finalized in this document; video recording pending.

Privacy Policy: confirmed live and Gmail-specific.

Production E2E evidence: completed successfully, full 11-step trace on 7/10/2026.

## 6. Evidence Matrix

| Requirement | Claim | Evidence Type |
| --- | --- | --- |
| Scope necessity | gmail.readonly required; narrower scopes insufficient | Google Documentation |
| Read-only behavior | No writes, sends, or label changes occur | Production E2E |
| Discovery vs. Import distinction | Only explicitly imported attachments are processed/stored | Repository Implementation |
| OCR processing | Google Cloud Vision used solely for OCR | Published Privacy Policy |
| Token storage and disconnect | Token encrypted; best-effort revoke on disconnect | Repository Implementation |
| Branding/config accuracy | App name, homepage, privacy/terms links, authorized domain all match | Google Cloud Configuration |
| End-to-end functionality | Full flow verified Connect through Disconnect | Production E2E |
