import { signIntake } from "@/lib/services/service-desk/intake.service";
import { ServiceDeskError } from "@/lib/services/service-desk/service-desk-errors";
import { idempotencyKeyOf, json, jsonBody, positiveId, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";

/**
 * POST { signaturePngBase64, expectedVersion } + Idempotency-Key — the customer signs the intake (1.3b). Refused unless
 * the intake data is recorded and approved terms were presented for this case. The intake is frozen once signed.
 */
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return serviceDeskRoute(req, "write", async ({ principal }) => {
    const id = positiveId((await context.params).id);
    const key = idempotencyKeyOf(req);
    const b = await jsonBody(req);
    const raw = typeof b.signaturePngBase64 === "string" ? b.signaturePngBase64.replace(/^data:image\/png;base64,/, "") : "";
    if (raw === "" || raw.length > 800_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new ServiceDeskError("INVALID_INPUT", { field: "signaturePngBase64" });
    return json(await signIntake(principal, id, { signaturePng: new Uint8Array(Buffer.from(raw, "base64")), expectedVersion: b.expectedVersion }, { idempotencyKey: key }));
  });
}
