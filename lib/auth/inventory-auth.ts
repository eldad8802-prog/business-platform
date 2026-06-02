import { getCurrentUser } from "@/lib/auth";
import { InventoryUnauthorizedError } from "@/lib/services/inventory/inventory.errors";

export type InventoryAuthenticatedUser = {
  id: number;
  businessId: number;
  email: string;
  name: string | null;
};

/**
 * Inventory routes preserve their existing 401 messages while delegating
 * user lookup to the shared bearer helper in lib/auth.ts.
 */
export async function getInventoryAuthenticatedUser(
  request: Request
): Promise<InventoryAuthenticatedUser> {
  const authorizationHeader = request.headers.get("authorization");

  if (!authorizationHeader?.startsWith("Bearer ")) {
    throw new InventoryUnauthorizedError(
      "Missing or invalid authorization header"
    );
  }

  const token = authorizationHeader.replace("Bearer ", "").trim();

  if (!token) {
    throw new InventoryUnauthorizedError("Missing token");
  }

  const user = await getCurrentUser(request);

  if (!user) {
    throw new InventoryUnauthorizedError("User not found");
  }

  return {
    id: user.id,
    businessId: user.businessId,
    email: user.email,
    name: user.name,
  };
}

/** Variant for routes that only need id + businessId (no empty-token guard). */
export async function getInventoryAuthenticatedUserBasic(
  request: Request
): Promise<{ id: number; businessId: number }> {
  const authorizationHeader = request.headers.get("authorization");

  if (!authorizationHeader?.startsWith("Bearer ")) {
    throw new InventoryUnauthorizedError(
      "Missing or invalid authorization header"
    );
  }

  const token = authorizationHeader.replace("Bearer ", "").trim();
  if (!token) {
    throw new InventoryUnauthorizedError("Invalid token");
  }

  const user = await getCurrentUser(request);

  if (!user) {
    throw new InventoryUnauthorizedError("User not found");
  }

  return { id: user.id, businessId: user.businessId };
}
