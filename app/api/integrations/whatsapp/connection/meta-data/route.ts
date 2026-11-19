/**
 * DELETE /api/integrations/whatsapp/connection/meta-data
 *
 * Owner-initiated deletion of Meta connection data saved in Dubiz. This removes
 * only the caller business' WhatsAppConnection row: encrypted token parts,
 * phone number id, WABA id, display phone number, and connection error/status
 * metadata. Conversation, message, customer, and business records are not
 * touched.
 */

import { NextResponse } from "next/server";
import { guardFeature } from "@/lib/services/feature-access/feature-guard";
import { PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";
import { getCurrentUser } from "@/lib/auth";
import { deleteMetaDataByBusinessId } from "@/lib/services/integrations/whatsapp/connection.service";

export const runtime = "nodejs";

export async function DELETE(req: Request) {
  const featureDenied = await guardFeature(req, PLATFORM_FEATURE_KEYS.WHATSAPP);
  if (featureDenied) return featureDenied;
  const user = await getCurrentUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await deleteMetaDataByBusinessId(user.businessId);
    return NextResponse.json(
      { deleted: result.deleted, connection: null },
      { status: 200 }
    );
  } catch (err) {
    console.error("[whatsapp-connection-meta-data-delete]", err);
    return NextResponse.json(
      { error: "Failed to delete Meta data" },
      { status: 500 }
    );
  }
}
