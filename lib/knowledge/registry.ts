/**
 * M4 · The catalogue — every rule Dubiz knows how to run, in one list.
 *
 * This is the whole extension point. A new rule is a descriptor, a pure `derive`, and an entry here;
 * nothing else in the system needs to learn about it. The derivation service reads this list, the
 * observability report enumerates it, and the tests assert its invariants — so a rule that is not
 * here does not exist, and a rule that is here cannot be forgotten.
 *
 * DOC-04 IS IN THE LIST TOO. It shipped in M2 with its own service and its own route call, and it is
 * folded in here rather than left beside the framework: two ways of running a rule would mean two
 * places to fix the next time reconciliation or observability changes. Its pure derivation is
 * untouched — only how it is invoked.
 */
import type { AnyKnowledgeRule, KnowledgeRule, RuleDescriptor } from "./rule.contract";
import {
  makePayablesSource,
  payablesRules,
  PAYABLES_WINDOW_DAYS,
} from "./rules/payables";
import {
  inventoryRules,
  makeAlertSource,
  makeMovementSource,
  INVENTORY_WINDOW_DAYS,
} from "./rules/inventory";
import {
  makeDeliverySource,
  makeOrderSource,
  supplierRules,
  SUPPLIERS_WINDOW_DAYS,
} from "./rules/suppliers";
import {
  documentRules,
  makeReviewSource,
  makeVendorDocumentSource,
  DOCUMENTS_WINDOW_DAYS,
} from "./rules/documents";
import {
  derivePaperworkLag,
  MEASURE_KEY as PAPERWORK_KEY,
  MIN_SUPPORT as PAPERWORK_MIN_SUPPORT,
  WINDOW_DAYS as PAPERWORK_WINDOW_DAYS,
  type PaperworkObservation,
} from "./rules/documents-paperwork-lag";
import * as sources from "./evidence/sources";

/**
 * DOC-04, expressed in the M4 contract.
 *
 * Its policy lineage is its own from this milestone on. It previously borrowed the vendor-category
 * lineage — expedient when it was the only measure in the system, and wrong now that a dozen rules
 * would all be claiming to be versions of the same policy. The first derivation after this ships will
 * therefore write to a new slot and reconcile the old row to SUPERSEDED, which is precisely what that
 * status is for and is worth watching for in Production as the proof it works.
 */
export const DOC04: RuleDescriptor = {
  ruleId: "DOC-04",
  domain: "documents",
  measureKey: PAPERWORK_KEY,
  policyKey: "documents-paperwork-lag",
  versionLabel: "v1",
  entityType: null,
  minSupport: PAPERWORK_MIN_SUPPORT,
  windowDays: PAPERWORK_WINDOW_DAYS,
  valueUnit: "days",
  freshness: ["NEW_EVIDENCE", "WINDOW_ROLLED", "EVIDENCE_REVERSED", "RULE_VERSION_CHANGED"],
  question: "How long does this owner usually take to file a document after its date?",
};

function paperworkRule(): KnowledgeRule<PaperworkObservation> {
  return {
    descriptor: DOC04,
    source: {
      key: "documents.paperwork",
      windowDays: PAPERWORK_WINDOW_DAYS,
      load: (businessId, now) => sources.loadPaperwork(businessId, now, PAPERWORK_WINDOW_DAYS),
    },
    derive: (observations, now) => [derivePaperworkLag(observations, now)],
  };
}

/** Narrow a typed rule into the catalogue's erased shape. Type-level only; no runtime cost. */
function erase<T>(rule: KnowledgeRule<T>): AnyKnowledgeRule {
  return rule as unknown as AnyKnowledgeRule;
}

/**
 * Build the catalogue.
 *
 * A function rather than a constant so the evidence sources can be substituted in tests without a
 * module-level mutable, and so nothing is constructed at import time — a catalogue built during
 * module evaluation would run before the tenant context exists and be impossible to reason about.
 */
export function knowledgeCatalogue(): AnyKnowledgeRule[] {
  // Each source is bounded by its own domain's window, named explicitly rather than read back off
  // the object being constructed: the loader and the rules must agree on the horizon, and the way to
  // guarantee that is for both to import the same constant.
  const settlements = makePayablesSource((b, n) =>
    sources.loadSettlements(b, n, PAYABLES_WINDOW_DAYS),
  );
  const movements = makeMovementSource((b, n) =>
    sources.loadMovements(b, n, INVENTORY_WINDOW_DAYS),
  );
  const alerts = makeAlertSource((b, n) => sources.loadAlerts(b, n, INVENTORY_WINDOW_DAYS));
  const orders = makeOrderSource((b, n) =>
    sources.loadSupplierOrders(b, n, SUPPLIERS_WINDOW_DAYS),
  );
  const deliveries = makeDeliverySource((b, n) =>
    sources.loadSupplierDeliveries(b, n, SUPPLIERS_WINDOW_DAYS),
  );
  const vendorDocs = makeVendorDocumentSource((b, n) =>
    sources.loadVendorDocuments(b, n, DOCUMENTS_WINDOW_DAYS),
  );
  const reviews = makeReviewSource((b, n) => sources.loadReviews(b, n, DOCUMENTS_WINDOW_DAYS));

  const [invMovementRules, invAlertRules] = inventoryRules(movements, alerts);
  const [supOrderRules, supDeliveryRules] = supplierRules(orders, deliveries);
  const [docVendorRules, docReviewRules] = documentRules(vendorDocs, reviews);

  return [
    paperworkRule(),
    ...payablesRules(settlements),
    ...invMovementRules,
    ...invAlertRules,
    ...supOrderRules,
    ...supDeliveryRules,
    ...docVendorRules,
    ...docReviewRules,
  ].map((r) => erase(r as KnowledgeRule<never>));
}

/** Descriptors alone, for reports and tests that must not touch a database. */
export function catalogueDescriptors(): RuleDescriptor[] {
  return knowledgeCatalogue().map((r) => r.descriptor);
}
