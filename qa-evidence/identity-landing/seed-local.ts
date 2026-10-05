/**
 * Synthetic tenants for the identity / landing-knowledge visual evidence.
 *
 * LOCAL THROWAWAY DATABASE ONLY — refuses any DATABASE_URL that is not localhost. Every value is
 * synthetic and labelled as such; nothing here may be pointed at a shared, preview or Production DB.
 *
 *   "partial" — a business part-way through: description (approved), a category, two audiences,
 *               a tone, an approved phone + name, CALL as the primary action, an internal and an
 *               approved trust claim, and services whose fulfillment gives Dubiz real signals.
 *   "empty"   — a business that has told Dubiz nothing.
 *
 * Prints {"partial": {token}, "empty": {token}}.
 *   npx tsx qa-evidence/identity-landing/seed-local.ts
 */
import { PrismaClient, type Prisma } from "@prisma/client";

import { signAuthToken } from "../../lib/auth-token";
import { factValueHash, FACT_SOURCES } from "../../lib/services/identity/identity-fact-authority.service";
import { normalizeTrustClaim, wordingHash } from "../../lib/services/trust/trust-claim-catalogue";

const url = process.env.DATABASE_URL ?? "";
if (!/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) {
  console.error("seed-local: refusing — DATABASE_URL is not a localhost database");
  process.exit(1);
}

const prisma = new PrismaClient();
const tag = Date.now().toString(36);

async function main() {
  const now = new Date();
  const business = await prisma.business.create({ data: { name: "סטודיו לדוגמה (סינתטי)" } });
  const user = await prisma.user.create({ data: { email: `identity-${tag}@example.test`, password: "x", name: "QA", businessId: business.id } });
  const phone = "03-0000000";
  await prisma.businessProfile.create({
    data: { businessId: business.id, category: "Home Services", subCategory: "Cleaning", billingPhone: phone, billingEmail: "studio@example.test", billingAddress: "רחוב לדוגמה 1, חיפה" },
  });

  const stmt = (dimension: string, v: { code?: string; text?: string; publicUseApproved?: boolean }) =>
    prisma.businessIdentityStatement.create({
      data: {
        businessId: business.id,
        dimension: dimension as Prisma.BusinessIdentityStatementCreateInput["dimension"],
        code: v.code ?? null,
        text: v.text ?? null,
        source: "OWNER_INPUT",
        sourceRef: "settings",
        status: "ACTIVE",
        confirmedByUserId: user.id,
        publicUseApproved: !!v.publicUseApproved,
        publicUseApprovedAt: v.publicUseApproved ? now : null,
        publicUseApprovedByUserId: v.publicUseApproved ? user.id : null,
      },
    });
  await stmt("DESCRIPTION", { text: "שירותי ניקיון לבתים ולמשרדים באזור הצפון (טקסט סינתטי)", publicUseApproved: true });
  await stmt("SPECIALIZATION", { text: "ניקיון אחרי שיפוץ" });
  await stmt("TARGET_AUDIENCE", { code: "INDIVIDUALS" });
  await stmt("TARGET_AUDIENCE", { code: "LOCAL_CUSTOMERS" });
  await stmt("TONE", { code: "WARM" });
  await stmt("PRIMARY_OBJECTIVE", { code: "CALL" });

  const authority = (fact: "BUSINESS_NAME" | "PUBLIC_PHONE", value: string, publicUse: boolean) =>
    prisma.businessIdentityFactAuthority.create({
      data: {
        businessId: business.id,
        fact,
        sourceField: FACT_SOURCES[fact].sourceField,
        valueHash: factValueHash(value),
        status: "ACTIVE",
        confirmedByUserId: user.id,
        confirmedAt: now,
        publicUseApproved: publicUse,
        publicUseApprovedAt: publicUse ? now : null,
        publicUseApprovedByUserId: publicUse ? user.id : null,
      },
    });
  await authority("BUSINESS_NAME", business.name, true);
  await authority("PUBLIC_PHONE", phone, true);

  const claim = async (kind: string, params: Record<string, unknown>, publicUse: boolean) => {
    const n = normalizeTrustClaim(kind, params, { now, servedCustomers: null });
    await prisma.businessTrustClaim.create({
      data: {
        businessId: business.id,
        claimKind: n.kind,
        claimClass: n.claimClass,
        scopeKey: n.scopeKey,
        params: n.params as Prisma.InputJsonValue,
        wording: n.wording,
        wordingHash: wordingHash(n.wording),
        confirmedByUserId: user.id,
        confirmedAt: now,
        validUntil: n.validUntil,
        publicUseApproved: publicUse,
        publicUseApprovedAt: publicUse ? now : null,
        publicUseApprovedByUserId: publicUse ? user.id : null,
        status: "ACTIVE",
      },
    });
  };
  await claim("FOUNDED_YEAR", { foundedYear: 2015 }, true);
  await claim("GUARANTEE", { coverage: "ניקיון חוזר", duration: "7 ימים", conditions: "אם משהו לא נוקה כראוי" }, false);

  for (const [name, fulfillment] of [["ניקיון דירה", "AT_CUSTOMER"], ["ניקיון משרד", "AT_CUSTOMER"], ["ייעוץ אונליין", "ONLINE"]] as const) {
    await prisma.businessService.create({ data: { businessId: business.id, name: `${name} (סינתטי)`, type: "SERVICE", active: true, fulfillment, categoryLabel: "ניקיון" } });
  }

  const empty = await prisma.business.create({ data: { name: "עסק חדש (סינתטי)" } });
  const emptyUser = await prisma.user.create({ data: { email: `identity-new-${tag}@example.test`, password: "x", businessId: empty.id } });

  console.log(JSON.stringify({ partial: { token: signAuthToken(user.id, 0) }, empty: { token: signAuthToken(emptyUser.id, 0) } }));
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
