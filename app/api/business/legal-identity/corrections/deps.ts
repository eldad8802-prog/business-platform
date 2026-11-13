/** The real dependencies of the correction handlers (handlers.ts). */
import { getAuthContext } from "@/lib/auth";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import {
  cancelCorrection,
  isLegalIdentityCorrectionEnabled,
  readCorrectionState,
  submitCorrection,
  verifyRequester,
} from "@/lib/services/account/legal-identity-correction.service";

import type { CorrectionDeps } from "./handlers";

export const correctionDeps: CorrectionDeps = {
  enabled: isLegalIdentityCorrectionEnabled,
  auth: async (req) => {
    const ctx = await getAuthContext(req);
    return ctx ? { user: { id: ctx.user.id, businessId: ctx.user.businessId }, sessionId: ctx.sessionId ?? null } : null;
  },
  rateLimit: (key) => consumeRateLimit({ key, limit: 5, windowMs: 60 * 60_000 }),
  readState: readCorrectionState,
  verify: (userId, sessionId, password) => verifyRequester(userId, sessionId, password),
  submit: submitCorrection,
  cancel: cancelCorrection,
};
