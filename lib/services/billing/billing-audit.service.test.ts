/**
 * Authority Runtime C.1 — billing audit event types (run manually):
 *   npx tsx lib/services/billing/billing-audit.service.test.ts
 */
import { ValidationError } from "@/lib/errors";
import {
  BILLING_AUDIT_EVENT_TYPES,
  BILLING_AUTHORITY_AUDIT_EVENT_TYPES,
  BILLING_AUTHORITY_CONNECTION_AUDIT_EVENT_TYPES,
  BILLING_AUTHORITY_DOCUMENT_AUDIT_EVENT_TYPES,
  billingAuthorityAuditEventRequiresDocument,
  validateBillingAuditEventInput,
} from "@/lib/services/billing/billing-audit.service";
import {
  BILLING_AUDIT_EVENT_LABELS_HE,
  formatBillingAuditEventLabel,
} from "@/lib/services/billing/billing-audit-labels";

let failed = 0;

function ok(name: string, condition: boolean) {
  if (!condition) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

function expectValidationError(name: string, fn: () => void) {
  try {
    fn();
    console.error("FAIL:", name, "(expected ValidationError)");
    failed += 1;
  } catch (error) {
    ok(name, error instanceof ValidationError);
  }
}

const coreTypeSet = new Set<string>(BILLING_AUDIT_EVENT_TYPES);

ok(
  "all authority event types are registered in BILLING_AUDIT_EVENT_TYPES",
  BILLING_AUTHORITY_AUDIT_EVENT_TYPES.every((type) => coreTypeSet.has(type))
);

ok(
  "authority document and connection lists do not overlap",
  BILLING_AUTHORITY_DOCUMENT_AUDIT_EVENT_TYPES.every(
    (type) =>
      !(BILLING_AUTHORITY_CONNECTION_AUDIT_EVENT_TYPES as readonly string[]).includes(
        type
      )
  )
);

for (const eventType of BILLING_AUTHORITY_AUDIT_EVENT_TYPES) {
  ok(
    `Hebrew label exists for ${eventType}`,
    typeof BILLING_AUDIT_EVENT_LABELS_HE[eventType] === "string" &&
      BILLING_AUDIT_EVENT_LABELS_HE[eventType].length > 0
  );
  ok(
    `formatBillingAuditEventLabel returns Hebrew for ${eventType}`,
    formatBillingAuditEventLabel(eventType) ===
      BILLING_AUDIT_EVENT_LABELS_HE[eventType]
  );
}

for (const eventType of BILLING_AUTHORITY_DOCUMENT_AUDIT_EVENT_TYPES) {
  ok(
    `${eventType} requires billingDocumentId`,
    billingAuthorityAuditEventRequiresDocument(eventType)
  );
}

for (const eventType of BILLING_AUTHORITY_CONNECTION_AUDIT_EVENT_TYPES) {
  ok(
    `${eventType} does not require billingDocumentId`,
    !billingAuthorityAuditEventRequiresDocument(eventType)
  );
}

validateBillingAuditEventInput({
  businessId: 1,
  billingDocumentId: 10,
  actorUserId: 2,
  eventType: "BILLING_AUTHORITY_APPROVED",
  summary: "הקצאה אושרה",
  metadata: { allocationNumber: "123456789" },
});
ok("BILLING_AUTHORITY_APPROVED validates with billingDocumentId", true);

validateBillingAuditEventInput({
  businessId: 1,
  actorUserId: 2,
  eventType: "BILLING_AUTHORITY_OAUTH_COMPLETED",
  summary: "התחברות הושלמה",
});
ok("BILLING_AUTHORITY_OAUTH_COMPLETED validates without billingDocumentId", true);

expectValidationError(
  "BILLING_AUTHORITY_APPROVED rejects missing billingDocumentId",
  () =>
    validateBillingAuditEventInput({
      businessId: 1,
      actorUserId: 2,
      eventType: "BILLING_AUTHORITY_APPROVED",
      summary: "הקצאה אושרה",
    })
);

expectValidationError("unknown authority-like type is rejected", () =>
  validateBillingAuditEventInput({
    businessId: 1,
    billingDocumentId: 10,
    actorUserId: 2,
    eventType: "BILLING_AUTHORITY_UNKNOWN" as "BILLING_AUTHORITY_APPROVED",
    summary: "test",
  })
);

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}

console.log("\nAll billing audit C.1 checks passed.");
