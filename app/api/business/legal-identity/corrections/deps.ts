/** The real dependencies of the correction handlers (handlers.ts). */
import { getAuthContext } from "@/lib/auth";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import {
  cancelCorrection,
  downloadAttachment,
  isLegalIdentityCorrectionEnabled,
  readCorrectionState,
  submitCorrection,
  uploadAttachment,
  verifyRequester,
} from "@/lib/services/account/legal-identity-correction.service";

import type { CorrectionDeps } from "./handlers";

export const correctionDeps: CorrectionDeps = {
  enabled: isLegalIdentityCorrectionEnabled,
  auth: async (req) => {
    const ctx = await getAuthContext(req);
    return ctx ? { user: { id: ctx.user.id, businessId: ctx.user.businessId }, sessionId: ctx.sessionId ?? null } : null;
  },
  // Submits check a password: 5 per hour per user. Attachments: 20 per hour per user.
  rateLimit: (key) =>
    consumeRateLimit({ key, limit: key.startsWith("legal-identity-attachment:") ? 20 : 5, windowMs: 60 * 60_000 }),
  readState: readCorrectionState,
  verify: (userId, sessionId, password) => verifyRequester(userId, sessionId, password),
  submit: submitCorrection,
  cancel: cancelCorrection,
  upload: uploadAttachment,
  download: downloadAttachment,
};
