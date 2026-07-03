/**
 * Compliance — Encrypted-Connection Inventory (READ-ONLY).
 *
 * Purpose: produce Production evidence for the G-1B (Cryptographic Key Rotation)
 * product decision — counts of stored, encrypted credentials/tokens per store.
 *
 * SAFETY CONTRACT (auditable — this file is committed for review):
 *   - READ-ONLY: uses ONLY prisma `.count()` / `.groupBy()`. No create/update/
 *     delete/upsert/executeRaw/$executeRaw. It cannot modify data.
 *   - NEVER selects, logs, or prints ciphertext or any secret VALUE. Output is
 *     counts, statuses, non-secret key-version LABELS (e.g. "gcm_v1"), provider
 *     names, and the DB HOST ONLY (no user/password).
 *   - Does NOT read any local `.env` file — the target DB is taken solely from
 *     the DATABASE_URL you pass in, so DEV can never be hit by accident.
 *
 * HOW TO RUN against Production (owner action):
 *   1) In the repo:  npx prisma generate      (if the client isn't built)
 *   2) Run with the PRODUCTION pooled URL explicitly on the command line:
 *
 *      Bash:
 *        DATABASE_URL="postgres://USER:PASS@PROD-HOST/db?sslmode=require" \
 *          node scripts/compliance-encrypted-inventory-readonly.cjs
 *
 *      PowerShell:
 *        $env:DATABASE_URL="postgres://USER:PASS@PROD-HOST/db?sslmode=require"; `
 *          node scripts/compliance-encrypted-inventory-readonly.cjs
 *
 *   3) Confirm the printed "db_host" is the PRODUCTION host, then paste the JSON
 *      block back. It contains only aggregates — safe to share.
 */
"use strict";

const url = process.env.DATABASE_URL;
if (!url || url.trim().length === 0) {
  console.error(
    "Refusing to run: DATABASE_URL is not set. Pass the PRODUCTION URL explicitly, e.g.\n" +
      '  DATABASE_URL="postgres://…prod…" node scripts/compliance-encrypted-inventory-readonly.cjs'
  );
  process.exit(2);
}

const { PrismaClient } = require("@prisma/client");
// Explicit datasource override → the ONLY DB touched is the URL you passed.
const prisma = new PrismaClient({ datasources: { db: { url } } });

async function safe(fn) {
  try {
    return await fn();
  } catch (e) {
    return { __error: `${e.code || e.name || "error"}: ${String(e.message).slice(0, 140)}` };
  }
}

(async () => {
  const out = { read_only: true, purpose: "G-1B production evidence" };

  try {
    const u = new URL(url);
    out.db_host = u.host.replace(/^[^@]*@/, "").replace(/:.*/, ""); // host only
  } catch {
    out.db_host = "unparseable";
  }

  // 1) Payments — PAYMENTS_ENCRYPTION_KEY
  out.payments = await safe(async () => ({
    total: await prisma.businessPaymentConnection.count(),
    active_isActive_true: await prisma.businessPaymentConnection.count({ where: { isActive: true } }),
    with_ciphertext: await prisma.businessPaymentConnection.count({ where: { NOT: { credentialEncrypted: null } } }),
    active_and_ciphertext: await prisma.businessPaymentConnection.count({ where: { isActive: true, NOT: { credentialEncrypted: null } } }),
    by_keyId: await prisma.businessPaymentConnection.groupBy({ by: ["encryptionKeyId"], _count: true }),
    by_provider: await prisma.businessPaymentConnection.groupBy({ by: ["provider"], _count: true }),
  }));

  // 2) Gmail/Email — GMAIL_TOKEN_ENCRYPTION_KEY (tokens live in OAuthToken)
  out.email = await safe(async () => ({
    connections_total: await prisma.emailConnection.count(),
    connections_by_status: await prisma.emailConnection.groupBy({ by: ["status"], _count: true }),
    connections_by_provider: await prisma.emailConnection.groupBy({ by: ["provider"], _count: true }),
    oauth_tokens_total: await prisma.oAuthToken.count(),
    oauth_tokens_with_refresh: await prisma.oAuthToken.count({ where: { NOT: { refreshTokenEncrypted: null } } }),
    oauth_tokens_by_keyId: await prisma.oAuthToken.groupBy({ by: ["encryptionKeyId"], _count: true }),
  }));

  // 3) WhatsApp — WHATSAPP_TOKEN_ENCRYPTION_KEY
  out.whatsapp = await safe(async () => ({
    total: await prisma.whatsAppConnection.count(),
    by_status: await prisma.whatsAppConnection.groupBy({ by: ["status"], _count: true }),
  }));

  // 4) Billing Authority (ITA/SHAAM) — BILLING_AUTHORITY_ENCRYPTION_KEY (5th key)
  out.billing_authority_connection = await safe(async () => ({
    total: await prisma.billingAuthorityConnection.count(),
    by_status: await prisma.billingAuthorityConnection.groupBy({ by: ["status"], _count: true }),
    with_access_token: await prisma.billingAuthorityConnection.count({ where: { NOT: { accessTokenEncrypted: null } } }),
    with_refresh_token: await prisma.billingAuthorityConnection.count({ where: { NOT: { refreshTokenEncrypted: null } } }),
  }));
  out.billing_authority_app = await safe(async () => ({
    total: await prisma.billingAuthorityApp.count(),
    with_client_secret: await prisma.billingAuthorityApp.count({ where: { NOT: { clientSecretEncrypted: null } } }),
    by_status: await prisma.billingAuthorityApp.groupBy({ by: ["status"], _count: true }),
    by_environment: await prisma.billingAuthorityApp.groupBy({ by: ["environment"], _count: true }),
  }));

  console.log("\n===== PROD ENCRYPTED-INVENTORY (read-only, safe to share) =====");
  console.log(JSON.stringify(out, null, 2));
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error("FATAL:", e.code || e.name, String(e.message).slice(0, 200));
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
