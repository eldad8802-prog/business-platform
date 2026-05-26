import {
  BillingDocumentStatus,
  Prisma,
  type PrismaClient,
} from "@prisma/client";
import { ForbiddenError } from "@/lib/errors";
import {
  assertIssueTransitionFields,
  assertIssuedMutationIsOperationalOnly,
  assertPreIssueEditFields,
  assertQuoteConversionFields,
  assertQuoteNumberFields,
  getUpdateDataFieldKeys,
} from "@/lib/services/billing/domain/billing-immutability.guard";

export type BillingDocumentUpdateIntent =
  | "pre_issue_edit"
  | "issue_to_issued"
  | "issued_operational"
  | "quote_operational"
  | "quote_allocate_number"
  | "quote_mark_converted";

type MutationClient = PrismaClient | Prisma.TransactionClient;

function assertIntentAllowsUpdateData(
  intent: BillingDocumentUpdateIntent,
  data: Prisma.BillingDocumentUncheckedUpdateManyInput
): void {
  const keys = getUpdateDataFieldKeys(
    data as unknown as Record<string, unknown>
  );
  if (keys.length === 0) {
    return;
  }

  switch (intent) {
    case "issued_operational":
    case "quote_operational":
      assertIssuedMutationIsOperationalOnly(keys);
      return;
    case "issue_to_issued":
      assertIssueTransitionFields(keys);
      return;
    case "pre_issue_edit":
      assertPreIssueEditFields(keys);
      return;
    case "quote_allocate_number":
      assertQuoteNumberFields(keys);
      return;
    case "quote_mark_converted":
      assertQuoteConversionFields(keys);
      return;
    default: {
      const _exhaustive: never = intent;
      throw new ForbiddenError(`Unknown billing document update intent: ${_exhaustive}`);
    }
  }
}

function mergeWhereForIntent(
  intent: BillingDocumentUpdateIntent,
  where: Prisma.BillingDocumentWhereInput
): Prisma.BillingDocumentWhereInput {
  if (intent === "issued_operational") {
    return {
      ...where,
      status: BillingDocumentStatus.ISSUED,
    };
  }
  if (intent === "quote_operational") {
    return where;
  }
  if (intent === "pre_issue_edit" || intent === "issue_to_issued") {
    const statusFilter = where.status;
    if (statusFilter !== undefined) {
      return where;
    }
    return {
      ...where,
      status: {
        in: [
          BillingDocumentStatus.DRAFT,
          BillingDocumentStatus.PENDING_REVIEW,
        ],
      },
    };
  }
  return where;
}

/**
 * Central gateway for BillingDocument updates.
 * All billing services must use this instead of calling updateMany directly.
 */
export async function updateBillingDocuments(
  client: MutationClient,
  args: {
    where: Prisma.BillingDocumentWhereInput;
    data: Prisma.BillingDocumentUncheckedUpdateManyInput;
    intent: BillingDocumentUpdateIntent;
  }
): Promise<Prisma.BatchPayload> {
  assertIntentAllowsUpdateData(args.intent, args.data);
  const where = mergeWhereForIntent(args.intent, args.where);
  return client.billingDocument.updateMany({
    where,
    data: args.data,
  });
}
