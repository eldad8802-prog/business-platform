/** The real dependencies of the admin correction handlers (see ./handlers.ts). */
import { isLegalIdentityApprover } from "@/lib/auth/legal-identity-approver";
import { freshStepUpRefusal } from "@/lib/auth/platform-admin";
import {
  decideCorrection,
  requestCorrectionInfo,
} from "@/lib/services/account/legal-identity-correction-admin.service";
// The approver reads the very same private prefix the owner wrote: biz/{businessId}/legal-identity/ only.
import { readCorrectionAttachment } from "@/lib/services/legal-identity/correction-attachment-storage";
import { isLegalIdentityCorrectionEnabled } from "@/lib/services/account/legal-identity-correction.service";
import {
  getCorrectionAttachmentForAdmin,
  getCorrectionForAdmin,
  listCorrectionsForAdmin,
} from "@/lib/services/platform-admin/legal-identity-corrections.service";
import { logPlatformAuditEvent } from "@/lib/services/platform-admin/platform-audit.service";

import type { CorrectionAdminDeps } from "./handlers";

export const correctionAdminDeps: CorrectionAdminDeps = {
  enabled: isLegalIdentityCorrectionEnabled,
  isApprover: (admin) => isLegalIdentityApprover(admin),
  freshStepUp: (req, userId) => freshStepUpRefusal(req, userId),
  list: (filter) => listCorrectionsForAdmin(filter),
  detail: (id) => getCorrectionForAdmin(id),
  attachment: (requestId, attachmentId) => getCorrectionAttachmentForAdmin(requestId, attachmentId),
  readAttachment: (input) => readCorrectionAttachment(input),
  decide: (input) => decideCorrection(input),
  requestInfo: (input) => requestCorrectionInfo(input),
  audit: (input) => logPlatformAuditEvent(input),
};
