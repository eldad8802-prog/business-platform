/**
 * Closed beta E2E seed (local lab only): one REGULAR account (no enrollment — what every existing
 * Production business is), created through the real createAccount. Prints its id as JSON.
 * env: DATABASE_URL (lab), AUTH_TOKEN_SECRET.
 */
import bcrypt from "bcrypt";
import { createAccount } from "@/lib/auth/signup";

async function main() {
  const email = process.argv[2];
  const account = await createAccount({
    email,
    passwordHash: await bcrypt.hash("E2e-Password-123", 10),
    name: "בעל עסק קיים",
    businessName: "עסק קיים",
    now: new Date(),
  });
  console.log(JSON.stringify({ businessId: account.businessId, userId: account.userId }));
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
