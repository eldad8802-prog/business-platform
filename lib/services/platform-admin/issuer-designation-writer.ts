/**
 * Issuer declaration (#1081) — the platform-admin binding of the designation writer. The ONLY place the designation
 * reaches the platform-admin database client (approved admin surface: lib/services/platform-admin/**). The write
 * itself is the migration's SECURITY DEFINER function (issuer_designate_initial / issuer_designate_authorized_user),
 * EXECUTE-granted to the platform-admin role by 20261126100000 for exactly this call.
 */
import { getPrismaAdmin } from "@/lib/prisma-admin";
import {
  designationWriterFor,
  type DesignationWriter,
} from "@/lib/services/billing/issuer-declaration/issuer-designation.service";

export const writeDesignationAsPlatformAdmin: DesignationWriter = designationWriterFor(getPrismaAdmin);
