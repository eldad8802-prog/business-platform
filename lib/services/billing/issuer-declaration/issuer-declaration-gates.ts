/**
 * Issuer declaration (#1081) — the two gates that run inside OTHER flows: the profile save (identity lock) and
 * issuance (enforcement). Kept apart from the declaration service so the issue path does not import the auth-plane
 * link library.
 */

import type { Prisma } from "@prisma/client";

import { ISSUER_IDENTITY_FIELDS, validateIssuerDetails, type IssuerDetailsInput } from "@/lib/billing/issuer-declaration/details";
import { ISSUER_DECLARATION_REQUIRED_MESSAGE, ISSUER_IDENTITY_LOCKED_MESSAGE } from "@/lib/billing/issuer-declaration/messages";
import { ConflictError, ValidationError } from "@/lib/errors";

type Tx = Prisma.TransactionClient;

/** The fiscal types a declaration governs — the same list as the migration's issuance trigger. */
export const DECLARATION_GOVERNED_DOCUMENT_TYPES = ["TAX_INVOICE", "TAX_INVOICE_RECEIPT", "RECEIPT", "CREDIT_NOTE"] as const;

/**
 * The identity lock, in the application: once a business has a live declaration, a profile save may not change
 * the declared identity fields. The database trigger BusinessProfile_issuer_identity_lock is the backstop.
 * Called inside the profile save's tenant transaction, before the write.
 */
export async function assertIssuerIdentityEditableTx(
  tx: Tx,
  businessId: number,
  before: Partial<Record<(typeof ISSUER_IDENTITY_FIELDS)[number], string | null>> | null,
  write: Partial<Record<string, string | null>>
): Promise<void> {
  const changed = ISSUER_IDENTITY_FIELDS.some(
    (f) => Object.prototype.hasOwnProperty.call(write, f) && (write[f] ?? null) !== (before?.[f] ?? null)
  );
  if (!changed) return;
  const declared = await tx.businessIssuerDeclaration.findFirst({
    where: { businessId, anonymisedAt: null },
    select: { id: true },
  });
  if (declared) throw new ConflictError(ISSUER_IDENTITY_LOCKED_MESSAGE);
}

/**
 * The issuance gate. Acts ONLY when "IssuerDeclarationEnforcement" holds its row (an owner-approved step; never
 * written by the application). Then a governed document is refused — before any number is allocated — unless the
 * issuer details are complete and the business has a live declaration. Without the row: returns, nothing else read.
 */
export async function assertIssuerDeclarationForIssueTx(
  tx: Pick<Tx, "issuerDeclarationEnforcement" | "businessIssuerDeclaration">,
  input: { businessId: number; documentType: string; profile: Partial<IssuerDetailsInput> | null | undefined }
): Promise<void> {
  if (!(DECLARATION_GOVERNED_DOCUMENT_TYPES as readonly string[]).includes(input.documentType)) return;
  const enforced = await tx.issuerDeclarationEnforcement.findFirst({ select: { id: true } });
  if (!enforced) return;
  if (validateIssuerDetails(input.profile).length > 0) throw new ValidationError(ISSUER_DECLARATION_REQUIRED_MESSAGE);
  const declared = await tx.businessIssuerDeclaration.findFirst({
    where: { businessId: input.businessId, anonymisedAt: null },
    select: { id: true },
  });
  if (!declared) throw new ValidationError(ISSUER_DECLARATION_REQUIRED_MESSAGE);
}
