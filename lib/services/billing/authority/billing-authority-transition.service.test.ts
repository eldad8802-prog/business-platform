/**
 * Authority transition runtime C.4.1–C.4.4 (run manually):
 *   npx tsx lib/services/billing/authority/billing-authority-transition.service.test.ts
 */
import {
  BillingAuthoritySubmissionChannel,
  BillingAuthoritySubmissionStatus,
  BillingDocumentStatus,
  BillingDocumentType,
  Prisma,
} from "@prisma/client";
import { ConflictError, ForbiddenError } from "@/lib/errors";
import {
  executeAuthorityTransitionTx,
  recordAuthorityApprovedTx,
  recordAuthorityFailedTx,
  recordAuthorityRejectedTx,
  recordAuthoritySubmissionAttemptTx,
  type AuthoritySubmissionRow,
} from "@/lib/services/billing/authority/billing-authority-transition.service";

let failed = 0;

function ok(name: string, condition: boolean) {
  if (!condition) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

async function expectForbidden(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    console.error("FAIL:", name, "(expected ForbiddenError)");
    failed += 1;
  } catch (error) {
    ok(name, error instanceof ForbiddenError);
  }
}

async function expectConflict(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    console.error("FAIL:", name, "(expected ConflictError)");
    failed += 1;
  } catch (error) {
    ok(name, error instanceof ConflictError);
  }
}

const APPROVED_AT = new Date("2026-06-05T14:30:00.000Z");
const REJECTED_AT = new Date("2026-06-06T09:15:00.000Z");
const FAILED_AT = new Date("2026-06-06T11:20:00.000Z");

function rejectionInput(overrides: {
  billingDocumentId: number;
  rejectedAt?: Date;
  errorCode?: string;
  errorMessage?: string;
  authorityResponseHash?: string | null;
}) {
  return {
    businessId: 1,
    billingDocumentId: overrides.billingDocumentId,
    rejectedAt: overrides.rejectedAt ?? REJECTED_AT,
    errorCode: overrides.errorCode ?? "RJ-001",
    errorMessage: overrides.errorMessage ?? "Legal rejection from authority",
    authorityResponseHash: overrides.authorityResponseHash,
  };
}

function failureInput(overrides: {
  billingDocumentId: number;
  lastAttemptAt?: Date;
  errorCode?: string;
  errorMessage?: string;
  authorityResponseHash?: string | null;
}) {
  return {
    businessId: 1,
    billingDocumentId: overrides.billingDocumentId,
    lastAttemptAt: overrides.lastAttemptAt ?? FAILED_AT,
    errorCode: overrides.errorCode ?? "FL-001",
    errorMessage: overrides.errorMessage ?? "Operational failure from authority",
    authorityResponseHash: overrides.authorityResponseHash,
  };
}

function approvalInput(overrides: {
  billingDocumentId: number;
  allocationNumber?: string;
  approvedAt?: Date;
  authoritySubmissionId?: string | null;
  authorityResponseHash?: string | null;
  isEmergencyAllocation?: boolean;
}) {
  return {
    businessId: 1,
    billingDocumentId: overrides.billingDocumentId,
    allocationNumber: overrides.allocationNumber ?? "123456789",
    approvedAt: overrides.approvedAt ?? APPROVED_AT,
    authoritySubmissionId: overrides.authoritySubmissionId,
    authorityResponseHash: overrides.authorityResponseHash,
    isEmergencyAllocation: overrides.isEmergencyAllocation,
  };
}

type FakeDocument = {
  id: number;
  businessId: number;
  status: BillingDocumentStatus;
  documentType: BillingDocumentType;
  legalSnapshotHash: string | null;
  issuedSnapshot: Record<string, unknown> | null;
  allocationNumber: string | null;
  allocationApprovedAt: Date | null;
  isEmergencyAllocation: boolean;
};

type FakeAuditEvent = {
  eventType: string;
  billingDocumentId: number | null;
  metadata: Record<string, unknown> | null;
};

function makeSubmission(
  overrides: Partial<AuthoritySubmissionRow> & {
    billingDocumentId: number;
    businessId: number;
    status: BillingAuthoritySubmissionStatus;
  }
): AuthoritySubmissionRow {
  const now = new Date("2026-06-01T12:00:00.000Z");
  return {
    id: overrides.id ?? 1,
    businessId: overrides.businessId,
    billingDocumentId: overrides.billingDocumentId,
    status: overrides.status,
    submissionChannel:
      overrides.submissionChannel ?? BillingAuthoritySubmissionChannel.STANDARD,
    legalSnapshotHash: overrides.legalSnapshotHash ?? "hash-abc",
    allocationNumber: overrides.allocationNumber ?? null,
    isEmergencyAllocation: overrides.isEmergencyAllocation ?? false,
    authoritySubmissionId: overrides.authoritySubmissionId ?? null,
    authorityPayloadHash: overrides.authorityPayloadHash ?? null,
    authorityResponseHash: overrides.authorityResponseHash ?? null,
    submittedAt: overrides.submittedAt ?? null,
    approvedAt: overrides.approvedAt ?? null,
    rejectedAt: overrides.rejectedAt ?? null,
    lastAttemptAt: overrides.lastAttemptAt ?? null,
    errorCode: overrides.errorCode ?? null,
    errorMessage: overrides.errorMessage ?? null,
    retryCount: overrides.retryCount ?? 0,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

function applySubmissionUpdate(
  current: AuthoritySubmissionRow,
  data: Prisma.BillingAuthoritySubmissionUpdateInput
): AuthoritySubmissionRow {
  return {
    ...current,
    status: (data.status as BillingAuthoritySubmissionStatus | undefined) ?? current.status,
    submittedAt:
      (data.submittedAt as Date | null | undefined) ?? current.submittedAt,
    lastAttemptAt:
      (data.lastAttemptAt as Date | null | undefined) ?? current.lastAttemptAt,
    retryCount: (data.retryCount as number | undefined) ?? current.retryCount,
    allocationNumber:
      data.allocationNumber === undefined
        ? current.allocationNumber
        : (data.allocationNumber as string | null),
    approvedAt:
      data.approvedAt === undefined
        ? current.approvedAt
        : (data.approvedAt as Date | null),
    rejectedAt:
      data.rejectedAt === undefined
        ? current.rejectedAt
        : (data.rejectedAt as Date | null),
    errorCode:
      data.errorCode === undefined
        ? current.errorCode
        : (data.errorCode as string | null),
    errorMessage:
      data.errorMessage === undefined
        ? current.errorMessage
        : (data.errorMessage as string | null),
    isEmergencyAllocation:
      data.isEmergencyAllocation === undefined
        ? current.isEmergencyAllocation
        : (data.isEmergencyAllocation as boolean),
    authorityPayloadHash:
      data.authorityPayloadHash === undefined
        ? current.authorityPayloadHash
        : (data.authorityPayloadHash as string | null),
    authoritySubmissionId:
      data.authoritySubmissionId === undefined
        ? current.authoritySubmissionId
        : (data.authoritySubmissionId as string | null),
    authorityResponseHash:
      data.authorityResponseHash === undefined
        ? current.authorityResponseHash
        : (data.authorityResponseHash as string | null),
    updatedAt: new Date("2026-06-01T12:05:00.000Z"),
  };
}

function makeFakeAuthorityDb(options: {
  submission: AuthoritySubmissionRow;
  document?: Partial<FakeDocument>;
  failAudit?: boolean;
  missConditionalUpdateOnce?: boolean;
}) {
  const document: FakeDocument = {
    id: options.submission.billingDocumentId,
    businessId: options.submission.businessId,
    status: BillingDocumentStatus.ISSUED,
    documentType: BillingDocumentType.TAX_INVOICE,
    legalSnapshotHash: options.submission.legalSnapshotHash,
    issuedSnapshot: {
      document: { allocationNumber: null },
    },
    allocationNumber: null,
    allocationApprovedAt: null,
    isEmergencyAllocation: false,
    ...options.document,
  };

  let submission = { ...options.submission };
  const auditEvents: FakeAuditEvent[] = [];
  let documentUpdateCalled = false;
  let conditionalMissPending = options.missConditionalUpdateOnce ?? false;

  const tx = {
    billingAuthoritySubmission: {
      async findFirst(args: {
        where: { billingDocumentId: number; businessId: number };
        select?: Record<string, boolean>;
      }) {
        if (
          submission.billingDocumentId !== args.where.billingDocumentId ||
          submission.businessId !== args.where.businessId
        ) {
          return null;
        }

        if (!args.select) {
          return submission;
        }

        const selectKeys = Object.keys(args.select).filter(
          (key) => args.select?.[key] === true
        );
        const isAttemptPrefetchSelect =
          selectKeys.length === 3 &&
          selectKeys.includes("status") &&
          selectKeys.includes("submittedAt") &&
          selectKeys.includes("retryCount");

        if (isAttemptPrefetchSelect) {
          return {
            status: submission.status,
            submittedAt: submission.submittedAt,
            retryCount: submission.retryCount,
          };
        }

        return submission;
      },
      async update(args: {
        where: { id: number };
        data: Prisma.BillingAuthoritySubmissionUpdateInput;
        select: typeof submission;
      }) {
        if (args.where.id !== submission.id) {
          throw new Error("submission not found");
        }
        submission = applySubmissionUpdate(submission, args.data);
        return submission;
      },
      async updateMany(args: {
        where: {
          id?: number;
          businessId?: number;
          status?: BillingAuthoritySubmissionStatus;
        };
        data: Prisma.BillingAuthoritySubmissionUpdateInput;
      }) {
        if (conditionalMissPending) {
          conditionalMissPending = false;
          submission = applySubmissionUpdate(submission, args.data);
          if (args.data.allocationNumber !== undefined) {
            document.allocationNumber = args.data.allocationNumber as string | null;
          }
          if (args.data.approvedAt !== undefined) {
            document.allocationApprovedAt = args.data.approvedAt as Date | null;
          }
          if (args.data.isEmergencyAllocation !== undefined) {
            document.isEmergencyAllocation = args.data.isEmergencyAllocation as boolean;
          }
          return { count: 0 };
        }

        if (args.where.id !== undefined && args.where.id !== submission.id) {
          return { count: 0 };
        }
        if (
          args.where.businessId !== undefined &&
          args.where.businessId !== submission.businessId
        ) {
          return { count: 0 };
        }
        if (
          args.where.status !== undefined &&
          args.where.status !== submission.status
        ) {
          return { count: 0 };
        }

        submission = applySubmissionUpdate(submission, args.data);
        return { count: 1 };
      },
    },
    billingDocument: {
      async findFirst(args: {
        where: { id: number; businessId: number };
      }) {
        if (
          document.id === args.where.id &&
          document.businessId === args.where.businessId
        ) {
          return document;
        }
        return null;
      },
      async update(args: {
        where: { id: number; businessId: number };
        data: Prisma.BillingDocumentUpdateInput;
      }) {
        if (
          args.where.id !== document.id ||
          args.where.businessId !== document.businessId
        ) {
          throw new Error("document not found");
        }
        documentUpdateCalled = true;
        if (args.data.allocationNumber !== undefined) {
          document.allocationNumber = args.data.allocationNumber as string | null;
        }
        if (args.data.allocationApprovedAt !== undefined) {
          document.allocationApprovedAt = args.data.allocationApprovedAt as Date | null;
        }
        if (args.data.isEmergencyAllocation !== undefined) {
          document.isEmergencyAllocation = args.data.isEmergencyAllocation as boolean;
        }
        if (args.data.legalSnapshotHash !== undefined) {
          document.legalSnapshotHash = args.data.legalSnapshotHash as string | null;
        }
        return document;
      },
    },
    billingAuditEvent: {
      async create(args: {
        data: {
          eventType: string;
          billingDocumentId: number | null;
          metadata: Prisma.InputJsonValue;
        };
      }) {
        if (options.failAudit) {
          throw new Error("audit write failed");
        }
        auditEvents.push({
          eventType: args.data.eventType,
          billingDocumentId: args.data.billingDocumentId,
          metadata: args.data.metadata as Record<string, unknown>,
        });
        return { id: auditEvents.length };
      },
    },
  };

  async function runInTransaction<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>
  ): Promise<T> {
    const submissionSnapshot = { ...submission };
    const auditSnapshot = [...auditEvents];
    const documentUpdateSnapshot = documentUpdateCalled;
    try {
      const result = await fn(tx as unknown as Prisma.TransactionClient);
      return result;
    } catch (error) {
      submission = submissionSnapshot;
      auditEvents.length = 0;
      auditEvents.push(...auditSnapshot);
      documentUpdateCalled = documentUpdateSnapshot;
      throw error;
    }
  }

  return {
    tx: tx as unknown as Prisma.TransactionClient,
    runInTransaction,
    getSubmission: () => submission,
    getDocument: () => document,
    auditEvents,
    documentUpdateCalled: () => documentUpdateCalled,
  };
}

async function runTests() {
  {
    const submission = makeSubmission({
      businessId: 1,
      billingDocumentId: 10,
      status: BillingAuthoritySubmissionStatus.READY,
    });
    const fake = makeFakeAuthorityDb({ submission });

    const result = await recordAuthoritySubmissionAttemptTx(fake.tx, {
      businessId: 1,
      billingDocumentId: 10,
      actorUserId: 5,
      authorityPayloadHash: "payload-hash-1",
      authoritySubmissionId: "ita-ref-1",
      occurredAt: new Date("2026-06-02T10:00:00.000Z"),
    });

    ok("READY → SUBMITTED succeeds", result.toStatus === "SUBMITTED");
    ok(
      "READY → SUBMITTED sets submittedAt",
      fake.getSubmission().submittedAt?.toISOString() ===
        "2026-06-02T10:00:00.000Z"
    );
    ok(
      "READY → SUBMITTED sets authorityPayloadHash",
      fake.getSubmission().authorityPayloadHash === "payload-hash-1"
    );
    ok(
      "READY → SUBMITTED audit event written",
      fake.auditEvents.length === 1 &&
        fake.auditEvents[0]?.eventType === "BILLING_AUTHORITY_SUBMISSION_ATTEMPTED"
    );
    ok(
      "READY → SUBMITTED does not update BillingDocument",
      fake.documentUpdateCalled() === false
    );
    ok(
      "READY → SUBMITTED leaves document allocation null",
      fake.getDocument().allocationNumber === null &&
        fake.getDocument().allocationApprovedAt === null
    );
  }

  {
    const submission = makeSubmission({
      businessId: 1,
      billingDocumentId: 11,
      status: BillingAuthoritySubmissionStatus.FAILED,
      retryCount: 2,
      submittedAt: new Date("2026-06-01T08:00:00.000Z"),
    });
    const fake = makeFakeAuthorityDb({ submission });

    const result = await recordAuthoritySubmissionAttemptTx(fake.tx, {
      businessId: 1,
      billingDocumentId: 11,
      occurredAt: new Date("2026-06-03T10:00:00.000Z"),
    });

    ok("FAILED → SUBMITTED succeeds", result.toStatus === "SUBMITTED");
    ok(
      "FAILED → SUBMITTED increments retryCount",
      fake.getSubmission().retryCount === 3
    );
    ok(
      "FAILED → SUBMITTED preserves first submittedAt",
      fake.getSubmission().submittedAt?.toISOString() ===
        "2026-06-01T08:00:00.000Z"
    );
  }

  {
    const submission = makeSubmission({
      businessId: 1,
      billingDocumentId: 12,
      status: BillingAuthoritySubmissionStatus.NOT_REQUIRED,
    });
    const fake = makeFakeAuthorityDb({ submission });

    await expectForbidden("NOT_REQUIRED → SUBMITTED fails", () =>
      recordAuthoritySubmissionAttemptTx(fake.tx, {
        businessId: 1,
        billingDocumentId: 12,
      })
    );
    ok(
      "NOT_REQUIRED → SUBMITTED leaves status unchanged",
      fake.getSubmission().status === BillingAuthoritySubmissionStatus.NOT_REQUIRED
    );
    ok(
      "NOT_REQUIRED → SUBMITTED writes no audit",
      fake.auditEvents.length === 0
    );
  }

  {
    const submission = makeSubmission({
      businessId: 1,
      billingDocumentId: 13,
      status: BillingAuthoritySubmissionStatus.APPROVED,
      allocationNumber: "999",
      approvedAt: new Date("2026-06-01T12:00:00.000Z"),
    });
    const fake = makeFakeAuthorityDb({ submission });

    await expectForbidden("APPROVED → SUBMITTED fails", () =>
      recordAuthoritySubmissionAttemptTx(fake.tx, {
        businessId: 1,
        billingDocumentId: 13,
      })
    );
    ok(
      "APPROVED → SUBMITTED leaves status unchanged",
      fake.getSubmission().status === BillingAuthoritySubmissionStatus.APPROVED
    );
  }

  {
    const submission = makeSubmission({
      businessId: 1,
      billingDocumentId: 14,
      status: BillingAuthoritySubmissionStatus.READY,
    });
    const fake = makeFakeAuthorityDb({ submission, failAudit: true });

    try {
      await fake.runInTransaction((tx) =>
        recordAuthoritySubmissionAttemptTx(tx, {
          businessId: 1,
          billingDocumentId: 14,
        })
      );
      console.error("FAIL: audit failure should throw");
      failed += 1;
    } catch (error) {
      ok("audit failure throws", error instanceof Error);
    }
    ok(
      "audit failure leaves submission READY when outer tx rolls back",
      fake.getSubmission().status === BillingAuthoritySubmissionStatus.READY
    );
    ok(
      "audit failure writes no audit event",
      fake.auditEvents.length === 0
    );
  }

  {
    const submission = makeSubmission({
      businessId: 1,
      billingDocumentId: 15,
      status: BillingAuthoritySubmissionStatus.PENDING,
    });
    const fake = makeFakeAuthorityDb({ submission });

    const result = await executeAuthorityTransitionTx(fake.tx, {
      businessId: 1,
      billingDocumentId: 15,
      kind: "SUBMIT_ATTEMPT",
      to: BillingAuthoritySubmissionStatus.SUBMITTED,
      summary: "Pending submission attempt",
      submissionUpdate: {
        status: BillingAuthoritySubmissionStatus.SUBMITTED,
        submittedAt: new Date("2026-06-04T10:00:00.000Z"),
        lastAttemptAt: new Date("2026-06-04T10:00:00.000Z"),
      },
    });

    ok("PENDING → SUBMITTED via executeAuthorityTransitionTx", result.toStatus === "SUBMITTED");
    ok(
      "PENDING → SUBMITTED audit event",
      fake.auditEvents[0]?.eventType === "BILLING_AUTHORITY_SUBMISSION_ATTEMPTED"
    );
  }

  {
    const submission = makeSubmission({
      businessId: 1,
      billingDocumentId: 20,
      status: BillingAuthoritySubmissionStatus.SUBMITTED,
      authoritySubmissionId: "ita-sub-20",
    });
    const fake = makeFakeAuthorityDb({ submission });
    const legalSnapshotBefore = fake.getDocument().legalSnapshotHash;
    const issuedSnapshotBefore = fake.getDocument().issuedSnapshot;

    const result = await recordAuthorityApprovedTx(
      fake.tx,
      approvalInput({
        billingDocumentId: 20,
        authorityResponseHash: "resp-hash-20",
      })
    );

    ok("SUBMITTED → APPROVED is APPLIED", result.outcome === "APPLIED");
    ok(
      "APPLIED sets submission APPROVED",
      fake.getSubmission().status === BillingAuthoritySubmissionStatus.APPROVED
    );
    ok(
      "APPLIED sets submission allocationNumber",
      fake.getSubmission().allocationNumber === "123456789"
    );
    ok(
      "APPLIED projects document allocationNumber",
      fake.getDocument().allocationNumber === "123456789"
    );
    ok(
      "APPLIED projects document allocationApprovedAt",
      fake.getDocument().allocationApprovedAt?.toISOString() ===
        APPROVED_AT.toISOString()
    );
    ok(
      "APPLIED writes one BILLING_AUTHORITY_APPROVED audit",
      fake.auditEvents.length === 1 &&
        fake.auditEvents[0]?.eventType === "BILLING_AUTHORITY_APPROVED"
    );
    ok(
      "APPLIED leaves legalSnapshotHash unchanged",
      fake.getDocument().legalSnapshotHash === legalSnapshotBefore
    );
    ok(
      "APPLIED leaves issuedSnapshot unchanged",
      fake.getDocument().issuedSnapshot === issuedSnapshotBefore
    );
  }

  {
    const submission = makeSubmission({
      businessId: 1,
      billingDocumentId: 21,
      status: BillingAuthoritySubmissionStatus.APPROVED,
      allocationNumber: "123456789",
      approvedAt: APPROVED_AT,
      authorityResponseHash: "resp-hash-21",
      authoritySubmissionId: "ita-sub-21",
    });
    const fake = makeFakeAuthorityDb({
      submission,
      document: {
        allocationNumber: "123456789",
        allocationApprovedAt: APPROVED_AT,
      },
    });

    const result = await recordAuthorityApprovedTx(
      fake.tx,
      approvalInput({
        billingDocumentId: 21,
        authorityResponseHash: "resp-hash-21",
        authoritySubmissionId: "ita-sub-21",
      })
    );

    ok("identical replay returns NOOP", result.outcome === "NOOP");
    ok("NOOP writes no additional audit", fake.auditEvents.length === 0);
    ok("NOOP does not update document again", fake.documentUpdateCalled() === false);
  }

  {
    const submission = makeSubmission({
      businessId: 1,
      billingDocumentId: 22,
      status: BillingAuthoritySubmissionStatus.APPROVED,
      allocationNumber: "123456789",
      approvedAt: APPROVED_AT,
    });
    const fake = makeFakeAuthorityDb({ submission });

    await expectConflict("different allocation replay returns CONFLICT", () =>
      recordAuthorityApprovedTx(
        fake.tx,
        approvalInput({
          billingDocumentId: 22,
          allocationNumber: "987654321",
        })
      )
    );
    ok("CONFLICT leaves submission allocation unchanged", fake.getSubmission().allocationNumber === "123456789");
    ok("CONFLICT writes no audit", fake.auditEvents.length === 0);
  }

  {
    const submission = makeSubmission({
      businessId: 1,
      billingDocumentId: 23,
      status: BillingAuthoritySubmissionStatus.APPROVED,
      allocationNumber: "123456789",
      approvedAt: APPROVED_AT,
      authoritySubmissionId: "ita-sub-23",
    });
    const fake = makeFakeAuthorityDb({
      submission,
      document: {
        allocationNumber: "123456789",
        allocationApprovedAt: APPROVED_AT,
      },
    });

    await expectConflict("different authoritySubmissionId replay returns CONFLICT", () =>
      recordAuthorityApprovedTx(
        fake.tx,
        approvalInput({
          billingDocumentId: 23,
          authoritySubmissionId: "ita-sub-other",
        })
      )
    );
  }

  {
    const submission = makeSubmission({
      businessId: 1,
      billingDocumentId: 24,
      status: BillingAuthoritySubmissionStatus.APPROVED,
      allocationNumber: "123456789",
      approvedAt: APPROVED_AT,
      authorityResponseHash: "resp-hash-24",
    });
    const fake = makeFakeAuthorityDb({ submission });

    const result = await recordAuthorityApprovedTx(
      fake.tx,
      approvalInput({
        billingDocumentId: 24,
        authorityResponseHash: "resp-hash-24",
      })
    );

    ok("missing projection is REPAIRED", result.outcome === "REPAIRED");
    ok(
      "REPAIRED projects document allocationNumber",
      fake.getDocument().allocationNumber === "123456789"
    );
    ok(
      "REPAIRED writes no BILLING_AUTHORITY_APPROVED audit",
      fake.auditEvents.length === 0
    );
  }

  {
    const submission = makeSubmission({
      businessId: 1,
      billingDocumentId: 25,
      status: BillingAuthoritySubmissionStatus.SUBMITTED,
    });
    const fake = makeFakeAuthorityDb({
      submission,
      missConditionalUpdateOnce: true,
    });

    const result = await recordAuthorityApprovedTx(
      fake.tx,
      approvalInput({ billingDocumentId: 25 })
    );

    ok(
      "conditional race after re-read returns NOOP",
      result.outcome === "NOOP"
    );
    ok(
      "conditional race leaves submission APPROVED",
      fake.getSubmission().status === BillingAuthoritySubmissionStatus.APPROVED
    );
    ok(
      "conditional race writes no audit on replay",
      fake.auditEvents.length === 0
    );
  }

  {
    const blockedStatuses = [
      BillingAuthoritySubmissionStatus.READY,
      BillingAuthoritySubmissionStatus.FAILED,
      BillingAuthoritySubmissionStatus.NOT_REQUIRED,
      BillingAuthoritySubmissionStatus.REJECTED,
    ] as const;

    for (const [index, status] of blockedStatuses.entries()) {
      const billingDocumentId = 26 + index;
      const submission = makeSubmission({
        businessId: 1,
        billingDocumentId,
        status,
      });
      const fake = makeFakeAuthorityDb({ submission });
      await expectForbidden(`${status} → APPROVED fails`, () =>
        recordAuthorityApprovedTx(
          fake.tx,
          approvalInput({ billingDocumentId })
        )
      );
    }
  }

  {
    const submission = makeSubmission({
      businessId: 1,
      billingDocumentId: 30,
      status: BillingAuthoritySubmissionStatus.SUBMITTED,
    });
    const fake = makeFakeAuthorityDb({ submission });

    const result = await recordAuthorityRejectedTx(
      fake.tx,
      rejectionInput({
        billingDocumentId: 30,
        authorityResponseHash: "rej-hash-30",
      })
    );

    ok("SUBMITTED → REJECTED is APPLIED", result.outcome === "APPLIED");
    ok(
      "REJECTED APPLIED sets status",
      fake.getSubmission().status === BillingAuthoritySubmissionStatus.REJECTED
    );
    ok(
      "REJECTED APPLIED sets rejectedAt",
      fake.getSubmission().rejectedAt?.toISOString() === REJECTED_AT.toISOString()
    );
    ok("REJECTED APPLIED sets errorCode", fake.getSubmission().errorCode === "RJ-001");
    ok(
      "REJECTED APPLIED writes one BILLING_AUTHORITY_REJECTED audit",
      fake.auditEvents.length === 1 &&
        fake.auditEvents[0]?.eventType === "BILLING_AUTHORITY_REJECTED"
    );
    ok(
      "REJECTED APPLIED does not update BillingDocument",
      fake.documentUpdateCalled() === false
    );
  }

  {
    const submission = makeSubmission({
      businessId: 1,
      billingDocumentId: 31,
      status: BillingAuthoritySubmissionStatus.REJECTED,
      rejectedAt: REJECTED_AT,
      errorCode: "RJ-001",
      errorMessage: "Stored rejection message",
      authorityResponseHash: "rej-hash-31",
    });
    const fake = makeFakeAuthorityDb({ submission });

    const result = await recordAuthorityRejectedTx(
      fake.tx,
      rejectionInput({
        billingDocumentId: 31,
        authorityResponseHash: "rej-hash-31",
      })
    );

    ok("REJECTED identical replay returns NOOP", result.outcome === "NOOP");
    ok("REJECTED NOOP writes no audit", fake.auditEvents.length === 0);
  }

  {
    const submission = makeSubmission({
      businessId: 1,
      billingDocumentId: 32,
      status: BillingAuthoritySubmissionStatus.REJECTED,
      rejectedAt: REJECTED_AT,
      errorCode: "RJ-001",
      errorMessage: "Stored rejection message",
      authorityResponseHash: "rej-hash-32",
    });
    const fake = makeFakeAuthorityDb({ submission });

    const result = await recordAuthorityRejectedTx(
      fake.tx,
      rejectionInput({
        billingDocumentId: 32,
        authorityResponseHash: "rej-hash-32",
        errorMessage: "Different presentation text only",
      })
    );

    ok(
      "REJECTED replay with different errorMessage only returns NOOP",
      result.outcome === "NOOP"
    );
    ok(
      "REJECTED NOOP preserves stored errorMessage",
      fake.getSubmission().errorMessage === "Stored rejection message"
    );
  }

  {
    const submission = makeSubmission({
      businessId: 1,
      billingDocumentId: 33,
      status: BillingAuthoritySubmissionStatus.REJECTED,
      rejectedAt: REJECTED_AT,
      errorCode: "RJ-001",
      authorityResponseHash: "rej-hash-33",
    });
    const fake = makeFakeAuthorityDb({ submission });

    await expectConflict("REJECTED different errorCode returns CONFLICT", () =>
      recordAuthorityRejectedTx(
        fake.tx,
        rejectionInput({
          billingDocumentId: 33,
          errorCode: "RJ-999",
          authorityResponseHash: "rej-hash-33",
        })
      )
    );
    ok("REJECTED CONFLICT writes no audit", fake.auditEvents.length === 0);
  }

  {
    const submission = makeSubmission({
      businessId: 1,
      billingDocumentId: 34,
      status: BillingAuthoritySubmissionStatus.SUBMITTED,
    });
    const fake = makeFakeAuthorityDb({
      submission,
      missConditionalUpdateOnce: true,
    });

    const result = await recordAuthorityRejectedTx(
      fake.tx,
      rejectionInput({
        billingDocumentId: 34,
        authorityResponseHash: "rej-hash-34",
      })
    );

    ok("REJECTED conditional race returns NOOP", result.outcome === "NOOP");
    ok(
      "REJECTED conditional race writes no audit",
      fake.auditEvents.length === 0
    );
  }

  {
    const submission = makeSubmission({
      businessId: 1,
      billingDocumentId: 35,
      status: BillingAuthoritySubmissionStatus.SUBMITTED,
    });
    const fake = makeFakeAuthorityDb({ submission });

    const result = await recordAuthorityFailedTx(
      fake.tx,
      failureInput({
        billingDocumentId: 35,
        authorityResponseHash: "fail-hash-35",
      })
    );

    ok("SUBMITTED → FAILED is APPLIED", result.outcome === "APPLIED");
    ok(
      "FAILED APPLIED sets status",
      fake.getSubmission().status === BillingAuthoritySubmissionStatus.FAILED
    );
    ok(
      "FAILED APPLIED sets lastAttemptAt",
      fake.getSubmission().lastAttemptAt?.toISOString() === FAILED_AT.toISOString()
    );
    ok(
      "FAILED APPLIED writes one BILLING_AUTHORITY_FAILED audit",
      fake.auditEvents.length === 1 &&
        fake.auditEvents[0]?.eventType === "BILLING_AUTHORITY_FAILED"
    );
    ok(
      "FAILED APPLIED does not update BillingDocument",
      fake.documentUpdateCalled() === false
    );
    ok(
      "FAILED APPLIED leaves retryCount unchanged",
      fake.getSubmission().retryCount === 0
    );
  }

  {
    const submission = makeSubmission({
      businessId: 1,
      billingDocumentId: 36,
      status: BillingAuthoritySubmissionStatus.PENDING,
    });
    const fake = makeFakeAuthorityDb({ submission });

    const result = await recordAuthorityFailedTx(
      fake.tx,
      failureInput({ billingDocumentId: 36 })
    );

    ok("PENDING → FAILED is APPLIED", result.outcome === "APPLIED");
    ok(
      "PENDING → FAILED audit event",
      fake.auditEvents[0]?.eventType === "BILLING_AUTHORITY_FAILED"
    );
  }

  {
    const submission = makeSubmission({
      businessId: 1,
      billingDocumentId: 37,
      status: BillingAuthoritySubmissionStatus.FAILED,
      lastAttemptAt: FAILED_AT,
      errorCode: "FL-001",
      errorMessage: "Stored failure message",
      authorityResponseHash: "fail-hash-37",
    });
    const fake = makeFakeAuthorityDb({ submission });

    const result = await recordAuthorityFailedTx(
      fake.tx,
      failureInput({
        billingDocumentId: 37,
        authorityResponseHash: "fail-hash-37",
        errorMessage: "Reformatted presentation only",
      })
    );

    ok("FAILED identical replay returns NOOP", result.outcome === "NOOP");
    ok(
      "FAILED NOOP preserves stored errorMessage",
      fake.getSubmission().errorMessage === "Stored failure message"
    );
    ok("FAILED NOOP writes no audit", fake.auditEvents.length === 0);
  }

  {
    const submission = makeSubmission({
      businessId: 1,
      billingDocumentId: 38,
      status: BillingAuthoritySubmissionStatus.FAILED,
      lastAttemptAt: FAILED_AT,
      errorCode: "FL-001",
      authorityResponseHash: "fail-hash-38",
    });
    const fake = makeFakeAuthorityDb({ submission });

    await expectConflict("FAILED different errorCode returns CONFLICT", () =>
      recordAuthorityFailedTx(
        fake.tx,
        failureInput({
          billingDocumentId: 38,
          errorCode: "FL-999",
          authorityResponseHash: "fail-hash-38",
        })
      )
    );
  }

  {
    const blockedStatuses = [
      BillingAuthoritySubmissionStatus.READY,
      BillingAuthoritySubmissionStatus.APPROVED,
      BillingAuthoritySubmissionStatus.REJECTED,
    ] as const;

    for (const [index, status] of blockedStatuses.entries()) {
      const billingDocumentId = 39 + index;
      const submission = makeSubmission({
        businessId: 1,
        billingDocumentId,
        status,
      });
      const fake = makeFakeAuthorityDb({ submission });
      await expectForbidden(`${status} → FAILED fails`, () =>
        recordAuthorityFailedTx(fake.tx, failureInput({ billingDocumentId }))
      );
    }
  }

  {
    const blockedStatuses = [
      BillingAuthoritySubmissionStatus.READY,
      BillingAuthoritySubmissionStatus.APPROVED,
      BillingAuthoritySubmissionStatus.FAILED,
    ] as const;

    for (const [index, status] of blockedStatuses.entries()) {
      const billingDocumentId = 42 + index;
      const submission = makeSubmission({
        businessId: 1,
        billingDocumentId,
        status,
      });
      const fake = makeFakeAuthorityDb({ submission });
      await expectForbidden(`${status} → REJECTED fails`, () =>
        recordAuthorityRejectedTx(fake.tx, rejectionInput({ billingDocumentId }))
      );
    }
  }
}

runTests()
  .then(() => {
    if (failed > 0) {
      console.error(`\n${failed} test(s) failed`);
      process.exit(1);
    }
    console.log("\nAll billing authority transition C.4.1–C.4.4 checks passed.");
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
