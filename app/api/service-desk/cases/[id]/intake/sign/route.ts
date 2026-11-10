import { signIntake } from "@/lib/services/service-desk/intake.service";
import { ServiceDeskError } from "@/lib/services/service-desk/service-desk-errors";
import { idempotencyKeyOf, json, positiveId, readBodyCapped, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";

const SIGN_BODY_MAX_BYTES = 800_000; // a 512 KB PNG as base64 plus the JSON around it

/**
 * POST { signaturePngBase64, expectedVersion } + Idempotency-Key — the customer signs the intake (1.3b). Refused unless
 * the intake data is recorded and approved terms were presented for this case. The intake is frozen once signed.
 */
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return serviceDeskRoute(req, "write", async ({ principal }) => {
    const id = positiveId((await context.params).id);
    const key = idempotencyKeyOf(req);
    const rawBody = await readBodyCapped(req, SIGN_BODY_MAX_BYTES);
    if (rawBody === null) throw new ServiceDeskError("INVALID_INPUT", { field: "signaturePngBase64" });
    let b: Record<string, unknown>;
    try {
      const parsed = JSON.parse(Buffer.from(rawBody).toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      b = parsed as Record<string, unknown>;
    } catch {
      throw new ServiceDeskError("INVALID_INPUT", { field: "body" });
    }
    const raw = typeof b.signaturePngBase64 === "string" ? b.signaturePngBase64.replace(/^data:image\/png;base64,/, "") : "";
    if (raw === "" || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new ServiceDeskError("INVALID_INPUT", { field: "signaturePngBase64" });
    return json(await signIntake(principal, id, { signaturePng: new Uint8Array(Buffer.from(raw, "base64")), expectedVersion: b.expectedVersion }, { idempotencyKey: key }));
  });
}
