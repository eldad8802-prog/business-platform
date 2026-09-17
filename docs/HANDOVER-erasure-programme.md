# Dubiz — ACCOUNT DELETION / PERSONAL-DATA ERASURE — FULL HANDOVER

**Source of truth for the erasure programme as of the stopping point.**
Written to stand alone: a new Claude session, or ChatGPT cross-checking an older
handover, should be able to work from this document without reading the chat it came
from.

Read-only document. Nothing in the repository, git, the database or production was
changed to produce it.

**Evidence discipline used throughout.** `PROVEN` means I ran it and saw the result in
this session. `INHERITED` means it came from the owner or from a prior handover and I did
not re-verify it. `UNPROVEN` means nobody has established it. `BLOCKED` means it cannot
proceed until something else happens. A section near the end separates what I personally
verified from what I was told.

---

## 1. CURRENT CANONICAL STATE

```text
CURRENT MAIN                    = fd047f30041be9e4f1defa6db2264fc0d4fffacc
  (moved after the E2 Wave 1 merge; see the movement note below)

ACCOUNT DELETION VERDICT        = D2 TECHNICAL PATH = PASS
E1 STATUS                       = MERGED / CANONICAL  (PR #424, merge d8eda9e7)
E1.1 STATUS                     = MERGED / CANONICAL  (PR #429, merge 9553824e)
E2 STATUS                       = WAVE 1 MERGED / CANONICAL (PR #436, merge 02ab62bf)
                                  WAVE 2 = NOT STARTED

MODEL COUNT                     = 117
CLASSIFIED                      = 117
UNCLASSIFIED                    = 0
STALE                           = 0
CONFLICTING                     = 0

OPEN FINDINGS                   = 55
FINDING BREAKDOWN
  C1-NO-SUCH-MODEL              = 2
  C4-UNDECLARED-DELETE          = 2
  C4-UNDECLARED-MUTATION        = 5
  C12-UNMANAGED-PERSONAL-DATA   = 25
  C13-NEEDS-OWNER-DECISION      = 21

FULL PERSONAL-DATA ERASURE      = FAIL
```

`FULL PERSONAL-DATA ERASURE = FAIL` is correct and must not be flipped. Fifty-five
findings are open, twenty-five of them models holding personal data that nothing erases.

### Movement note on CURRENT MAIN

Main was `02ab62bf` at the moment E2 Wave 1 merged. It has since advanced to
`fd047f30` by one pull request, **#440** (`feat(payments): a generic reversal seam, and
the provider that can use it`). I classified it read-only:

| Check | Result |
|---|---|
| Prisma models added / removed | 0 / 0 |
| `lib/services/account/**` | 0 files |
| anything matching `erasure` | 0 files |
| `.ad2a/**` | 0 files |
| `scripts/ci/erasure/**` | 0 files |

Classification: **SAFE ADDITIVE / NON-SEMANTIC**. The canonical figures in this section
were measured **on `fd047f30` itself**, not extrapolated.

```text
PRODUCTION-RELATED UNPROVEN ITEMS
  #437 inbound-email migration applied to Production            = UNPROVEN
  Production DELETE capability on the two inbound sender tables = UNPROVEN
  Whether any repository migration is applied in Production     = UNPROVEN from this session
  Production runtime privilege state generally                  = INHERITED, not re-verified

OPEN OWNER DECISIONS = 21 models in C13, plus the retention questions in §11

NEXT INCREMENT = E2 WAVE 2 SELECTION AUDIT (read-only), NOT STARTED
```

---

## 2. BUSINESS AND TECHNICAL GOAL

A Dubiz business owner can delete their account. The product tells them, in the ratified
UX statement in `docs/privacy-account-deletion-erasure-design-v1.md`:

> "החשבון והמידע התפעולי יימחקו/יעברו אנונימיזציה; מסמכים ורשומות שהחוק מחייב לשמור (כגון
> חשבוניות ומסמכי הנהלת חשבונות) עשויים להישמר לתקופת השמירה החוקית, ולא ישמשו להפעלת
> חשבון פעיל."

Operational data erased or anonymised; legally-required records retained. The programme's
whole purpose is to make that sentence true, and to make it *checkable* rather than
asserted.

The model is **anonymise-and-retain**, ratified, not hard delete. Twelve `Restrict`
foreign keys make a hard delete of a business impossible, and deleting issued fiscal
documents would be unlawful. So rows survive; what must not survive is anything that
identifies a person or reconstructs their communications.

---

## 3. BACKGROUND THAT LED HERE

Three concepts were being conflated, and the design document separates them explicitly:

- **A. User account shutdown** — the authentication identity dies.
- **B. Business operational-data erasure** — counterparty PII, communications, CRM,
  integration credentials.
- **C. Legally-retained records** — issued fiscal documents and their evidence.

"The account was deleted" had been used as if all three were the same thing. They are not,
and most of the defects in this programme live in the gap between B as promised and B as
implemented.

---

## 4. THE D2 ARCHITECTURE, AND WHY IT DOMINATES EVERYTHING HERE

`INHERITED` as background; the consequences below were `PROVEN` in this session.

Production runs as a restricted PostgreSQL role. The tenant runtime is `app_runtime_prod`,
`NOBYPASSRLS`, non-owner. Tenant tables carry `ENABLE` **and** `FORCE ROW LEVEL SECURITY`.

Tenant context is a transaction-local GUC:

```text
runTenantJob({ businessId }, fn, { quarantinePolicy })
  → runWithTenantContext (AsyncLocalStorage)
    → withTenantTransaction
      → set_config('app.current_business_id', …, true)
```

`assertTenantContextIs(tx, businessId)` is the silent-zero backstop.

Three consequences that shape every decision in this programme:

1. **A statement with no tenant context matches zero rows and raises nothing.** Under
   `FORCE` RLS, a correct-looking `updateMany` with `where: { businessId }` silently
   affects nothing if the GUC is unset.
2. **A missing DELETE policy is silent.** Policies are per-command. A policy written
   `FOR SELECT` / `FOR INSERT` / `FOR UPDATE` does not cover DELETE, so `deleteMany`
   returns 0 and raises nothing. A policy with **no** `FOR` clause is `FOR ALL` and does
   include DELETE.
3. **Privilege and policy are different gates.** A table can have a permissive `FOR ALL`
   policy and still be unreachable because the role holds no `DELETE` grant. Both must be
   checked. This is why the lab fixtures must mirror production grants exactly.

A fourth, from an earlier outage and still load-bearing: **Prisma appends an implicit
`RETURNING` over every scalar column when a write has no `select`**, which requires SELECT
privilege on those columns. This caused a production login outage on 2026-09-08.

---

## 5. THE THREE ORIGINAL DEFECTS (A, B, C) — ALL CLOSED BEFORE THIS SESSION'S E-WORK

`INHERITED` in origin, `PROVEN` closed by the battery in this session.

| Defect | What was wrong | Closure |
|---|---|---|
| **A** | Stage 1 credential destruction ran with no tenant context. Four FORCE-RLS'd tables matched zero rows silently; Gmail, SHAAM and payment credentials survived a deletion that reported success. | Stage 1 split: the lifecycle transition stays bare, credential destruction moved inside `runTenantJob` + `withTenantTransaction` + `assertTenantContextIs`. |
| **B** | `Conversation` has SELECT/INSERT/UPDATE policies and deliberately **no DELETE policy**. `conversation.deleteMany` returned 0, raised nothing, the cascade to `Message` never fired, and every customer message body survived. | Owner chose **anonymise in place**, not a new DELETE policy. The graph is rewritten deepest-first: `MessageAnalysis` → `ReplySuggestion` → `Message` → `Conversation`. |
| **C** | Stage 3's `LearningEvent` INSERT ran without context, raised 42501, rolled back, and stranded the business in `DELETION_REQUESTED` with no in-product retry, because the session gate kills the only retry path. | Evidence written first, under tenant context, before the terminal transition. |

Attribution was proven in SQL with one variable each: `A: UPDATE 0 → UPDATE 1`,
`B: DELETE 0 → DELETE 2`, `C: 42501 → INSERT 0 1`.

**The lesson that recurs**: all three failures were *correct-looking*. Every statement had
`where: { businessId }`, the ordering read sensibly, the API returned success. This is why
every claim in this programme is backed by a runtime proof and a mutation proof.

---

## 6. THE STRUCTURAL DEFECT THAT E1 EXISTS FOR

`PROVEN` in this session.

`account-erasure-manifest.ts` declares what a deletion erases. The Prisma adapter
separately, and by hand, writes the statements. **Nothing connected them.**
`assertManifestSafe()` compares the manifest's model lists to each other; it never reads
the schema and never reads the adapter.

The live consequence, on the tree at the time:

- the manifest declared `lead.email` is nulled;
- the adapter nulled `customerName` and `phone`, and not `email`;
- every test in the repository passed.

I proved the false-green three ways, two of which needed no mutation because they were the
live state:

```text
NONEXISTENT FIELD FALSE GREEN   = PROVEN (added `fakeField`; all four existing checks green)
MANIFEST/ADAPTER FALSE GREEN    = PROVEN (the unmutated tree)
IMPLEMENTATION/CONTRACT DRIFT   = PROVEN (the unmutated tree)
```

Other drift found in the same manifest: it named `lead.name` (the column is
`customerName`), `posApiKey.hashedKey` (the column is `keyHash`), `oauthToken` and
`posApiKey` as delegates when Prisma's are `oAuthToken` and `pOSApiKey`, and it listed
`conversation` in `DELETE_MODELS` after PR #421 stopped deleting it.

---

## 7. INCREMENTS, IN ORDER, WITH PULL REQUESTS

All SHAs below were read from git or the GitHub API in this session.

### Defect A + B + C closure — PR #421

```text
PR      = #421  test(erasure): make the account-deletion battery reproduce Production
BRANCH  = test/account-deletion-faithful-harness
HEAD    = 367fae9e7b597b13c87d7927f2f2137c5c715729
MERGE   = d9d20b4dbf4b1c3b5d99ec5b4f68eb64b782a0d4   MERGED
ROLE    = production-faithful harness + defects A, B and C
```

Contents: `.ad2a/production-contract.mjs` (the production RLS contract as data, copied
from migrations), `.ad2a/known-defects.mjs` (the ratchet), the A/B/C fixes, and the
conversation-graph anonymisation. `KNOWN_DEFECTS` ended empty.

Four mutation proofs (B1 raw content, B2 derived content, B3 provider identifier, B4
tenant context) each turned the battery red and restored byte-identically. B4 reproduced
the silent-zero signature exactly, which is the strongest evidence that tenant context is
load-bearing there.

### E1 — erasure contract enforcement — PR #424

```text
PR      = #424  test(erasure): enforce manifest-to-adapter contract
BRANCH  = chore/erasure-contract-enforcement
HEAD    = ee588da97467531cca9391b26b4d140892e255e4
MERGE   = d8eda9e7ef45b7480ad405abd5fed5237d2830be   MERGED (merge commit, 2 parents)
ROLE    = make the manifest machine-enforced
```

Design chosen: **the manifest VALIDATES the adapter**; it does not drive it. A generic
executor was considered and rejected, because the erasure encodes at least six decisions a
data-driven loop would have to reproduce and then hide (deepest-first ordering, the
relation filter that also satisfies RLS on `MessageAnalysis`, `Prisma.DbNull` for Json,
deleting `POSApiKey` rows because `keyHash` is globally unique, anonymising `Customer`
because invoices reference it, and the three-stage transaction split that IS the security
property).

The adapter is read through the **TypeScript compiler's AST**, not regular expressions.
Anything the analyzer cannot read is a finding, never a skip.

Checks: `C0-UNREADABLE`, `C1-NO-SUCH-MODEL`, `C2-NO-SUCH-FIELD`,
`C3-DECLARED-NOT-IMPLEMENTED`, `C4-UNDECLARED-MUTATION` / `C4-UNDECLARED-DELETE`,
`C5-NOT-A-COLUMN`, `C6-*`, `C7-WRONG-WRITE-KIND`.

Result on main at the time: **16 findings**, three known, thirteen new.

### E1.1 — model-level coverage gate — PR #429

```text
PR      = #429  test(erasure): require disposition for every Prisma model
BRANCH  = chore/erasure-model-coverage-gate
HEAD    = 2a9a8ab0dfd12e61d2fd1958595cbfadbf030888
MERGE   = 9553824e4f5cdf5ab2098176540468ca99a8f7c6   MERGED (merge commit, 2 parents)
ROLE    = every Prisma model must carry exactly one explicit disposition
```

Trigger: PR #423 added three inbound-email models carrying `fromEmail`, `subject` and a
raw MIME object key, and every check stayed green. `NEW MODEL FALSE GREEN = PROVEN` on the
real models, no synthetic case.

The rule is **coverage, not detection**: a new model with no entry fails whether or not a
guard could have guessed its contents. A name-based detector would fail in the direction
that produces a green build.

Six categories; two of them (`UNMANAGED_PERSONAL_DATA`, `NEEDS_OWNER_DECISION`) are
*themselves findings*, permanently, so a complete registry is never mistaken for a complete
erasure. Checks `C8`–`C13` bridge to E1 inside the **same guard and the same debt file**,
so the two layers cannot drift apart.

The gate caught a model I had missed while writing it: `PaymentWebhookEvent`.

Result: 115 models, 115 classified, findings 16 → 63.

### E2 Wave 1 — deterministic personal-data erasure — PR #436 (PR #432 superseded)

```text
PR      = #436  fix(erasure): close deterministic personal-data residuals
BRANCH  = feat/erasure-e2-wave1-deterministic-v2
HEAD    = 2793f20e65c3209f22bc38b2246dec6377bc4e41
MERGE   = 02ab62bf977f1b94ebfdd24608ba305b17ebdae7   MERGED (merge commit, 2 parents)

SUPERSEDED PR = #432, branch feat/erasure-e2-wave1-deterministic, head 5f866a5b
                CLOSED as superseded. Branch PRESERVED on the remote.
                Never deleted, never rewritten, never force-pushed.
```

Scope, chosen from the ratified design rather than from a list of names:

- **`Lead`** — `email`, `intentSnapshot`, `followUpNote`, `lostReason` cleared;
  `customerId` unlinked. Named in the ratified design as counterparty PII.
- **`Notification`** — `title` and `summary` cleared. Not an original surface: `title` is
  built as `` `${whom} ממתין למענה` `` with `whom` the raw `customerName`, and `summary`
  is assembled from the last message snippet, the generated reply and the lead's follow-up
  note. A readable copy of three things already required to be anonymised.

`Notification` is **anonymised, not deleted**, and not by preference: the runtime holds
`SELECT, INSERT, UPDATE` and no `DELETE`. A `deleteMany` would match zero rows in
production and raise nothing — the silent-zero shape of Defect B.

Two assertions exist specifically to stop the fix going too far: `W1-C` requires the lead's
non-personal analytics to survive, `W1-F` requires the notification's route, policy reason
and entity id to survive.

---

## 8. WHAT WAS DELIBERATELY EXCLUDED FROM WAVE 1, AND WHY

| Surface | Reason for exclusion |
|---|---|
| **`Deal`** | Named in the ratified design, untouched by the erasure — but **the tenant runtime holds no privilege on the table at all**. The wave-1 RLS migration says so: *"zero live runtime consumers — protected and deliberately ungranted"*. Reaching it needs a new GRANT, which was outside Wave 1. |
| **`Supplier`** | Not named anywhere in the ratified design. Whether a supplier's `legalName`, `taxId` and address are a business record is an owner and legal decision. I did establish it is **not** a fiscal-evidence surface: `FinancialRecord.vendorName` and `ExtractedData.vendorName` come from OCR of the document, not from this table. A contact-fields-only fix was considered and rejected because it would make the model look handled. |
| **`Appointment`** | Original free text, not a copy of anything ratified, not named in the design. |
| **`EmailAttachmentImport`** | Classified `RETAINED_BY_DESIGN`; clearing `fromEmail`/`subject` would destroy data on a retained model, and the retention basis is `UNPROVEN`. |
| **`InboundEmailAddress`, `InboundEmailMessage`, `InboundEmailAttachmentImport`** | `rawObjectKey` points at a raw MIME object outside Postgres. Clearing the other columns would leave a partially erased row that reads as erased. |

---

## 9. PULL REQUESTS BY OTHERS THAT INTERACTED WITH THIS WORK

| PR | Role | Effect on this programme |
|---|---|---|
| **#423** | inbound email foundation, migration + schema | Added three models; triggered E1.1 |
| **#425** | F-01 import retry identity, migration only | Irrelevant; classified safe |
| **#426** | billing invoice-profile GET readonly | Irrelevant |
| **#428** | SUMIT provider | Safe additive; merged into the branch |
| **#430** | BusinessProfile runtime grants | Grants only; irrelevant to Wave 1 |
| **#431** | F-01 retry identity | Added `ImportRun.retryKey` column, no model |
| **#433** | I-8A firewall repair | **Canonical**; superseded my duplicate fix |
| **#434** | relocate erasure CI registries out of `lib/` | Pure R100 rename, zero content change |
| **#437** | inbound email authorised senders, migration + schema | **Contains the production DELETE GRANT** |
| **#439** | T1-ERASURE, actually delete the sender authorisation list | Changed the adapter, manifest, registries and battery |
| **#440** | payments reversal seam | Safe additive; landed after the Wave 1 merge |

### Two incidents worth carrying forward

**I broke the I-8A firewall and it reached main.** `erasure-model-coverage.ts` (added by
E1.1) names `HistoricalFiscalDocument` in a `RETAINED_BY_DESIGN` entry, and the firewall's
allowlist was not updated. It did not fail in CI because that workflow triggers on a
`paths:` filter and none of #429's four files matched it; #424 happened to touch a file
that *was* in the filter, so the same suite ran there and passed. **The difference between
the two merges was which files they touched, not whether they were safe.** PR #433 fixed
it canonically and better than my own fix did — it widened the filter to
`lib/services/account/**` and added a check that every file the contract names must be
covered by the path filters of every workflow that runs it. I dropped my duplicate.

**#439 shipped an assertion that pinned the global debt total.**
`assert.equal(ACCEPTED_DEBT.length, 63)` was true the day it was written and failed on the
first unrelated increment that legitimately resolved anything. The owner's decision was
**not** to bump 63 to 55 but to replace the count with a semantic delta: two named keys
leave the ledger, no third leaves because of that increment, and none arrives. That repair
is in the merged Wave 1.

---

## 10. TESTS, HARNESSES AND PROOFS

### `.ad2a/battery.mjs` — the runtime-faithful battery

Real PostgreSQL, production RLS contract applied from `.ad2a/production-contract.mjs`,
restricted `NOBYPASSRLS` role, lab grants mirroring production exactly. Two tenants: A is
deleted, B is the control.

```text
AD-2A on current main = PASS=107 FAIL=0 SKIP=0        (PROVEN this session)
  Wave-1 assertions W1-A … W1-G = 7/7
  #439 inbound-email assertions = 4/4
  tenant-B cross-tenant controls = 12
```

Wave 1 assertions:

```text
W1-A  no lead contact identifier or free text survives
W1-B  no participant linkage survives on the lead skeleton
W1-C  non-personal lead analytics are PRESERVED          ← anti-over-deletion
W1-D  the notification skeleton survives (no DELETE grant)
W1-E  no copied counterparty name or conversation content survives
W1-F  notification route and policy fields PRESERVED     ← anti-over-deletion
W1-G  the W1 sentinel is unrecoverable in ANY column
```

The Wave-1 sentinel is `ERASURE_W1_7c41af-`, deliberately distinct from the graph's
`ad2a-` marker so a Wave-1 assertion cannot pass because some other model happened to be
clean.

### The contract guard

```text
npm run verify:erasure-contract                       honest mode, red while debt exists
npm run verify:erasure-contract -- --baseline-check   ratchet, red only on NEW debt
```

The ratchet is the alternative to switching a permanently-red required check off. It fails
on new debt **and** on recorded debt that quietly starts passing, so an improvement must be
written down.

### Eleven independent negative proofs

```text
M1  manifest names a column that exists nowhere        → C2-NO-SUCH-FIELD
M2  right column name, wrong model                     → C2-NO-SUCH-FIELD
M3  the adapter stops keeping a declared promise       → C3-DECLARED-NOT-IMPLEMENTED
M4  the adapter erases something undeclared            → C4-UNDECLARED-MUTATION
M5  a relation offered where a column is required      → C5-NOT-A-COLUMN
M6  a covered column with no disposition               → C6-NO-DISPOSITION
N1  a new Prisma model with no disposition             → C8-UNCLASSIFIED-MODEL
N2  a disposition for a model that does not exist      → C9-STALE-CLASSIFICATION
N3  one model in two categories                        → C10-CONFLICTING-CLASSIFICATION
N4  ERASURE_MANAGED without any erasure                → C11-MANAGED-BUT-UNTOUCHED
N5  an existing model loses its classification         → C8-UNCLASSIFIED-MODEL
```

**There are eleven, not twelve.** `N6` is not independent: it is the same mutation as `M6`.
I counted it twice in earlier reports and the owner corrected it. Do not re-inflate.

**M2 is the load-bearing one.** It is the exact shape of the bug that started the
programme: a column name that is real elsewhere in the schema, declared on a model that
does not have it. A guard that passes M1 but fails M2 would have shipped `Lead.email`
again.

### The mutations are AST-based, and that mattered

Text anchors broke **three separate times**, each time because a change to the code a proof
guards reformatted the line the proof matched. The symptom was always
`MUTATION NOT APPLIED` — a red build saying nothing about the contract — and the available
fix was always to move the anchor, which buys one release and rebuilds the trap.

`scripts/ci/erasure-mutate.ts` now expresses every mutation against the TypeScript syntax
tree. A twelfth workflow step proves the property rather than asserting it: `--reflow`
re-emits a target object across more lines, **generated from the tree** so it cannot be
hand-tuned to keep matching, and then requires M4 and M5 to still apply and the guard to
still go red. I confirmed the old regex fails that same reflow.

### Other suites verified green on the final tree

`TSC`, `I-8A structural firewall`, `migration-first-guard`, `account-deletion-guard.sh`
plus its `--self-test`, prisma-centralization, admin-boundary, W4-context, privwrite,
`account-deletion.test.ts`, `context.test.ts`, `job.test.ts`,
`inbound-email-t1-db.verify.test.ts`, and `inbound-email-erasure.verify.test.ts`
(17 passed, 0 failed).

### CI on the merged Wave 1 head

```text
15 / 15 SUCCESS, 0 pending, 0 in progress, 0 failed, 0 cancelled
MERGEABLE = MERGEABLE, MERGE_STATE = CLEAN at the moment of merge
```

---

## 11. OPEN DEBT — ALL 55 FINDING KEYS

Measured on `fd047f30` in this session.

### C1 — the manifest names things that are not Prisma delegates (2)

```text
C1-NO-SUCH-MODEL::REVOKE_INTEGRATIONS:oauthToken     (delegate is oAuthToken)
C1-NO-SUCH-MODEL::REVOKE_INTEGRATIONS:posApiKey      (delegate is pOSApiKey)
```

Because neither name ever resolved, the fields declared under them were never checked
either — which is how `posApiKey.hashedKey` survived when the column is `keyHash`. Fixing
the model names will surface that one.

### C4 — erasure the adapter performs that no contract declares (7)

```text
C4-UNDECLARED-DELETE::OAuthToken.*
C4-UNDECLARED-DELETE::POSApiKey.*
C4-UNDECLARED-MUTATION::BusinessPaymentConnection.isActive
C4-UNDECLARED-MUTATION::EmailConnection.lastSyncCursor
C4-UNDECLARED-MUTATION::WhatsAppConnection.accessTokenEncrypted
C4-UNDECLARED-MUTATION::WhatsAppConnection.accessTokenIv
C4-UNDECLARED-MUTATION::WhatsAppConnection.accessTokenTag
```

**None of these is wrong behaviour.** Every one is a credential actually being destroyed.
What is missing is the declaration — the manifest under-describes the erasure, including
on the WhatsApp token ciphertext where it claims to clear nothing at all.

### C12 — models holding personal data that nothing erases (25)

```text
Appointment                     AuthSession                  AuthSessionSecret
BusinessBotKnowledge            BusinessObligation           BusinessService
CollaborationDeal               Deal                         InboundEmailAddress
InboundEmailAttachmentImport    InboundEmailMessage          InventoryAlert
InventoryDraft                  InventoryItem                InventoryMovement
PurchaseOrder                   PurchaseOrderLine            ReceivingSession
Recommendation                  RecommendationOutcome        Supplier
SupplierPurchaseDraft           SupplierPurchaseDraftLine    Task
VendorLearning
```

All keyed `C12-UNMANAGED-PERSONAL-DATA::<Model>`.

### C13 — models needing an owner or design decision (21)

```text
Business                        BusinessBot                  BusinessBotLearningSuggestion
BusinessBotMemoryPolicy         BusinessBotRecommendation    BusinessBotSettings
BusinessBotSetupDraft           ContentEvent                 ContentRender
ContentRun                      ContentVariant               DerivedClaimProjection
ExtractionEvidence              ExtractionSnapshot           ImportRun
LearningEvent                   Offer                        PartyResolutionClaim
PaymentWebhookEvent             ReviewEvent                  SliceDecision
```

All keyed `C13-NEEDS-OWNER-DECISION::<Model>`.

### Full disposition census on current main

```text
ERASURE_MANAGED (19)
  BillingAuthorityConnection, BusinessPaymentConnection, BusinessProfile, Conversation,
  CrmAttachment, CrmNote, Customer, EmailConnection, InboundEmailAuthorizedSender,
  InboundEmailSenderChallenge, Lead, Message, MessageAnalysis, Notification, OAuthToken,
  POSApiKey, ReplySuggestion, User, WhatsAppConnection

RETAINED_BY_DESIGN (20)
  BillingAuditEvent, BillingAuthoritySubmission, BillingDocument, BillingDocumentLine,
  BillingDocumentNumberSequence, BillingPaymentAllocation, BillingReceiptPayment, Document,
  EmailAttachmentImport, ExtractedData, FinancialDocument, FinancialEvent, FinancialRecord,
  HistoricalFiscalDocument, PaymentAuditEvent, PaymentRequest, PaymentTransaction,
  RiaCanonicalReferent, RiaPolicyLineage, WhatsAppAttachmentImport

NON_PERSONAL_OPERATIONAL (25)
  BotGoalSelection, BusinessBotProfile, BusinessFeatureAccess, BusinessObligationOrientation,
  ContentFeedback, Coupon, DerivedClaimCandidate, DerivedClaimEvidenceLink, ImportRunRow,
  InventoryCategory, InventoryExternalSale, InventoryPendingMatch, LearningSignal,
  NotificationDelivery, POSProductMapping, Party, PaymentProviderRouting, PricingCalculation,
  PricingProfile, PricingRecommendation, ProductUsageEvent, ReceivingLine, RedemptionEvent,
  ServiceCostProfile, Usage

SYSTEM_INTERNAL (7)
  BillingAuthorityApp, DerivationPolicy, DerivationPolicyVersion, PlatformAdminMfa,
  PlatformAuditEvent, PlatformFeatureDefinition, PlatformFeaturePolicy

UNMANAGED_PERSONAL_DATA (25) and NEEDS_OWNER_DECISION (21) as listed above.
```

---

## 12. SPECIFIC UNRESOLVED SURFACES

### `PaymentWebhookEvent` — historical business attribution

```text
HISTORICAL BUSINESS ATTRIBUTION = UNPROVEN
```

The handler **does** derive a business securely at ingest:
`findPaymentRequestByProviderRequestId(provider, providerRequestId)` resolves a **stored**
`PaymentRequest` through `PaymentProviderRouting` and its consistency gate. The code's own
comment says the tenant comes "from the STORED PaymentRequest — never from the payload".

But `insertWebhookEventIfNew` writes only `provider`, `eventType`, `providerEventId`,
`payload` and a status. **The derived businessId is never written back onto the row.** The
model has no `businessId`, no relation field, and nothing points at it.

A retrospective attribution would have to re-parse `payload` and repeat that lookup — the
payload-driven correlation the architecture refuses at ingest, and incomplete besides: rows
that failed before the tenant boundary never matched a request at all.

**Do not implement parse-old-payload → guess request → guess business → erase.**

Future rows *could* persist the attribution; it would need an expand-only nullable column
and a decision about the ordering, since the row is currently created before the lookup.

### External MIME objects — inbound email

```text
DATABASE POINTER ERASURE != EXTERNAL OBJECT ERASURE
DATABASE ERASURE        = NOT IMPLEMENTED for the three older inbound models
EXTERNAL OBJECT ERASURE = NOT IMPLEMENTED
```

Traced repo-wide, `PROVEN` this session at the time of the sweep:

- `rawObjectKey` is written **nowhere** in product code.
- `rawDeletedAt` has **zero** references anywhere.
- There is no storage integration in `lib/inbound-email/` at all — though the repository
  *does* have a storage abstraction with working delete APIs (`deleteDocumentObjectQuiet`,
  `deleteAttachmentObject`) used elsewhere.

Nulling `rawObjectKey` would erase the pointer, not the email. A raw MIME object is the
complete message. **Never report a pointer reset as an object deletion.**

### `Supplier`

Largest single residual personal-data set: `name`, `phone`, `email`, `contactName`,
`contactRole`, `contactPhone`, `contactEmail`, `legalName`, `taxId`, `addressStreet`,
`addressCity`, `addressPostalCode`, `website`, `notes`. Israeli suppliers are frequently
sole traders, so the supplier IS often a natural person. Denormalised copies of the name
live in `InventoryItem.supplierName`, `PurchaseOrder.supplierName` and
`SupplierPurchaseDraft.supplierName` — anonymising `Supplier` alone would be cosmetic.

### `Notification` — closed, but note the mechanism

Closed by Wave 1. The general lesson stands: generated text is a denormalised copy of
counterparty identity, and copies must be hunted, not assumed absent.

### Retention, still open

`docs/privacy-account-deletion-erasure-design-v1.md` states the statutory rule is "seven
years from the end of the tax year, **or** six years from the date the annual return was
filed, whichever is later" and that the second half is **not computable**: no
annual-report-filed timestamp exists anywhere in the schema. There is no purge job.
Therefore `RETAINED_BY_DESIGN` currently means **retained indefinitely**. This is an
acknowledged open gap (`privacy-constitution` P-11 / G-3 / G-5), scoped as **E3**, not
started.

Minimisable retained fields identified but not acted on: `EmailAttachmentImport.fromEmail`
and `.subject`, `WhatsAppAttachmentImport.fromPhone`, and
`HistoricalFiscalDocument.customerEmailSnapshot` / `customerPhoneSnapshot` /
`customerAddressSnapshot` — none of which is required content of a fiscal record, unlike
name and tax id. All recorded as `UNPROVEN` basis, not as "may be deleted".

---

## 13. MIGRATIONS AND PRODUCTION STATE

**The repository contains 130 migrations. This session verified the existence of migration
files only. It did NOT verify that any of them is applied in Production.**

Erasure-relevant migrations present in the repo:

```text
20260824210000_d2_p7_wave1_tenant_rls           RLS + policies on Lead, Deal, others
20260825150000_d2_p7_wave2_tenant_rls           LearningEvent
20260826150000_d2_p7_w4b_whatsapp_tenant_rls    Message, ReplySuggestion, MessageAnalysis
20260826200000_d2_p7_w4c_gmail_tenant_rls       EmailConnection, OAuthToken
20260830120000_d2_p7_w4ea_payments_tenant_rls   BusinessPaymentConnection
20260831120000_d2_p7_w4eb2_billing_tenant_rls   BillingAuthorityConnection
20260902120000_d2_cutover2b_pilot_tenant_rls    the five pilots — NO DELETE POLICY
20260903200000_notification_persistence         Notification + NotificationDelivery RLS
20260907120000_i8a_historical_fiscal_documents  HistoricalFiscalDocument
20260914120000_inbound_email_foundation         three inbound models (#423)
20260915120000_businessprofile_runtime_grants   BusinessProfile INSERT/UPDATE (#430)
20260916090000_inbound_email_authorized_senders two sender models + RLS + GRANTS (#437)
```

### The #437 distinction — carry this verbatim

```text
#439 PRODUCTION PRIVILEGE CHANGE    = NO   (#439 adds no migration at all)
#437 CONTAINS RUNTIME DELETE GRANT  = YES  (GRANT SELECT, INSERT, UPDATE, DELETE
                                            ON the two sender tables TO app_runtime)
#437 MIGRATION APPLIED TO PRODUCTION = UNPROVEN
PRODUCTION DELETE CAPABILITY PROVEN  = NO
```

Do **not** infer production capability from the AD-2A lab grant. The lab mirrors the
migration; it does not prove the migration ran.

### Known production facts

```text
INHERITED, not re-verified in this session:
  Production runtime runs as app_runtime_prod, NOBYPASSRLS, since the 2026-09-05 cutover
  Production applies migrations through a gated release-migrate workflow, never automatically
  Production database is Neon, neondb@ep-flat-brook
  Local .env points at a DEV database, not Production

PROVEN in this session: nothing about Production. No production action of any kind was taken.
```

---

## 14. RULES THAT MUST CARRY FORWARD

### Production

```text
NO Production DB mutation
NO Production migration execution
NO manual Vercel deployment or Vercel CLI bypass
NO BTRL action of any kind
```

### Release and merge

```text
Merge only through the canonical GitHub PR flow
MERGE COMMIT ONLY — never squash, never rebase-merge
NO direct push to main, NO force push to main, NO branch-protection or admin bypass
Use --match-head-commit so a merge fails if the PR head moved
Merge requires an explicit, current owner authorization naming BOTH the main SHA
  and the PR head SHA. An authorization is void the moment either moves.
```

Why merge-commit only: a squash breaks stacked-PR ancestry. When #424 and #429 were
stacked, a squash of #424 would have made #429's diff re-show all of E1 and forced a
history rewrite.

### Moving main

Main moves here every few hours. Every gate must be re-checked immediately before acting.

```text
SAFE ADDITIVE / NON-SEMANTIC — may reconcile without re-asking, if ALL hold:
   1. no overlap with the account-deletion adapter
   2. no change to erasure manifest semantics
   3. no change to existing model dispositions
   4. no change to AD-2A / E1 / E1.1 harness semantics
   5. no RLS or GRANT change affecting a model in scope
   6. no removal or semantic change of an already-classified Prisma model
   7. any newly added Prisma model is explicitly classified by main,
      with no unclassified / stale / conflicting result
   8. any new finding is additive debt only, and the PR does not resolve or suppress it
   9. the exact resolved finding keys of the in-flight increment are unchanged
  10. no in-flight product behaviour must change to accommodate the new main

STOP-CLASS — stop and report, decide nothing alone:
  account-deletion adapter change · manifest semantic change · existing disposition change
  mutation-harness semantic change · AD-2A semantic change · RLS or GRANT touching scope
  removal or change of one of the increment's exact findings · conflicting classification
  unclassified Prisma model · a manual semantic merge conflict
  the in-flight PR itself needing new product behaviour
```

Counters are derived, never assumed:

```text
EXPECTED MODEL COUNT = previous canonical + newly added - legitimately removed
EXPECTED FINDINGS    = current main findings - exactly the keys this PR resolves
```

### Finding-key ownership

```text
A = findings resolved by main / another increment
B = findings resolved by the in-flight PR
C = findings remaining after both
A ∩ B must be EMPTY.
```

If the same finding is attributed to two increments, **STOP — OWNERSHIP COLLISION**. Never
let a PR take credit for something main already closed.

### Why a global finding count is never a proof

This is the most important methodological rule in the programme, and it was learned twice.

A total measures the whole programme, not one increment. `ACCEPTED_DEBT.length === 63` was
true the day #439 wrote it and failed on the first unrelated increment that legitimately
resolved anything — Wave 1, which removed eight Lead and Notification findings that file
has no opinion about. The message read "the ledger should hold exactly 63" while nothing
#439 promises had changed.

Bumping the number is the obvious repair and the wrong one: it buys one release and
rebuilds the trap for the next wave. **Assert the delta by key**: these named keys leave,
no other leaves because of me, none arrives. That stays true forever.

Correspondingly: when reporting that an increment resolved N findings, prove it by
asserting each key is absent, not by subtracting totals. A coincidental count can look like
success.

### Git, worktree and session safety

```text
Never touch another session's worktree. Enumerate worktrees before starting.
Never delete or rewrite a published branch. A superseded PR's branch is evidence.
When a published branch must absorb main, MERGE — never rebase a published branch.
Rebase is acceptable only before a branch is published.
For measurement, use a disposable worktree and delete it afterwards.
Before any mutation-based proof: copy the file, mutate, measure, restore, and verify
  byte-identical with git hash-object. Never leave a mutation committed.
```

### Harness discipline

```text
Harness-first: commit the failing test BEFORE the product fix, and prove it fails for the
  intended reason — not for a fixture, privilege, FK or unrelated RLS reason.
Lab grants must mirror production grants EXACTLY. A lab privilege the product does not
  hold turns a broken fix green. This is how Defect B hid.
Replace assertions, never delete them. When a property changes, the new assertion must be
  stronger than the one it replaces.
Every guard needs mutation proofs. A script that prints PASS when it cannot parse its
  input prints PASS forever.
Never anchor a proof on source formatting. Use the AST.
```

---

## 15. WHAT I PERSONALLY VERIFIED IN THIS CHAT

### Verified by running it and reading the output

```text
PROVEN  The E1 false-green: a nonexistent manifest column left all four existing checks green
PROVEN  The live manifest/adapter drift on the unmutated tree (Lead.email)
PROVEN  NEW MODEL FALSE GREEN, on the real #423 models, not a synthetic case
PROVEN  115 → 117 models; 115/115 then 117/117 classified; 0 unclassified/stale/conflicting
PROVEN  Findings 16 → 63 (E1.1) → 55 (after Wave 1 and #439), measured on main itself
PROVEN  All 55 current finding keys, listed in §11, read from the merged main fd047f30
PROVEN  The Wave-1 baseline: PASS=99 FAIL=4 before the fix, PASS=103 FAIL=0 after
PROVEN  AD-2A on the merged tree: PASS=107 FAIL=0 SKIP=0
PROVEN  11/11 mutations red with their expected finding code, 11/11 byte-identical restore
PROVEN  M4/M5 format robustness, including that the OLD regex fails the same reflow
PROVEN  The three sensitivity mutations on the repaired #439 assertion, 3/3 red
PROVEN  Supplier is NOT a fiscal-evidence surface (vendorName comes from OCR, not Supplier)
PROVEN  Notification.title embeds the raw customerName via customerLabel()
PROVEN  Notification summary embeds message snippet, generated reply and followUpNote
PROVEN  The runtime holds no DELETE on Lead or Notification (grants read from scripts/security)
PROVEN  Deal has NO runtime grant at all
PROVEN  rawObjectKey written nowhere; rawDeletedAt referenced nowhere
PROVEN  PaymentWebhookEvent has no businessId, no relation, nothing references it
PROVEN  The exact point where the webhook handler derives businessId
PROVEN  I-8A was red on main after #429, and the paths: filter is why it was unseen
PROVEN  #436 merged: merge commit 02ab62bf with parents 1c7c0af7 + 2793f20e, two parents
PROVEN  #436 head is an ancestor of main; #432 closed with its branch preserved at 5f866a5b
PROVEN  CI 15/15 SUCCESS on the merged head, re-listed by name after a transient API error
PROVEN  #440 is safe-additive: 0 models added/removed, 0 files in any erasure surface
```

### Inherited, and NOT re-verified by me

```text
INHERITED  Defects A, B and C as historical findings, and their SQL attribution
INHERITED  The D2 production cutover on 2026-09-05 and the app_runtime_prod identity
INHERITED  The 2026-09-08 login outage and the Prisma implicit-RETURNING root cause
INHERITED  That the twelve Restrict FKs make hard delete impossible and unlawful
INHERITED  The ratified anonymise-and-retain decision and the UX statement
INHERITED  Every statement about Production database state, roles and applied migrations
INHERITED  PR #433's and #434's internal correctness beyond reading their diffs
INHERITED  The owner's classification decisions for models I flagged as needing one
```

### Contradiction between an inherited figure and what I measured

```text
INHERITED STATE        The Wave-1 authorization named TOTAL MODELS = 115 and
                       TOTAL FINDINGS AFTER WAVE 1 = 55, then later 117 / 57.
CURRENT OBSERVED STATE 117 models, 55 findings.
DIFFERENCE             Both earlier figures were right when written and both went stale.
                       115 → 117 because #423 and #437 each added models.
                       57 → 55 because #439 later resolved its own two C12 findings
                       BEFORE Wave 1 merged, so main's own baseline dropped 65 → 63.
EVIDENCE               Measured main alone at 1c7c0af7 = 63 findings, with
                       InboundEmailAuthorizedSender and InboundEmailSenderChallenge
                       already ERASURE_MANAGED and their debt entries gone.
                       Combined with Wave 1's exactly-eight: 63 - 8 = 55.
                       Re-measured on fd047f30 after the merge: 55. Ratchet exit 0.
```

This is exactly why the programme moved to key-set comparison. Any handover figure older
than the current main SHA should be treated as stale until re-measured.

---

## 16. OPEN RISKS AND UNKNOWN UNKNOWNS

**False-green risks**

- A lab fixture more permissive than production turns a broken fix green. This already
  happened once with a `FOR ALL` lab policy hiding Defect B. Any new table added to the
  battery must get production's exact grants, with the extra privileges explicitly
  revoked.
- A `paths:` filter can silently prevent a guard from running. #433 added a check for this
  class, but only for the I-8A workflow's own consumers. Other workflows with path filters
  have not been audited for the same hole.
- A guard that cannot parse its input must fail, never skip. The AST analyzer reports
  `C0-UNREADABLE`; anything new must keep that property.

**Privilege and RLS**

- `Deal` has no grant at all. Any attempt to erase it will silently do nothing, or fail
  with 42501, depending on the operation. Check the grant before writing the code.
- The `C4-UNDECLARED-*` findings mean the manifest currently under-describes what the
  erasure does. Someone reading the manifest to answer "what happens to my data" would get
  an incomplete answer, in the *safe* direction, but incomplete.
- A default ACL issue was noted in inherited context: production may auto-grant
  `app_runtime` broad privileges on newly created tables. `UNPROVEN` here, but if true it
  silently undermines least-privilege reasoning for every new table.

**Prisma behaviour**

- Implicit `RETURNING` on writes without `select` requires SELECT on every scalar column.
  This broke production login once.
- `Prisma.DbNull` versus `null` on a nullable Json column are different operations. A plain
  `null` writes JSON null rather than emptying the column.
- Delegate names uncapitalize only the first character: `POSApiKey` → `pOSApiKey`. Two live
  findings exist because someone guessed otherwise.
- Composite unique constraints tolerate multiple NULLs, which is what makes nulling
  `providerMessageId` and `clientRequestId` safe. Do not assume that for every unique.

**External data and attribution**

- Raw MIME objects live outside Postgres. No database erasure reaches them and none of the
  tests can see them.
- `PaymentWebhookEvent` rows cannot be attributed to a business without payload parsing.
- Denormalised copies are the recurring trap: `Notification.title`, the three
  `supplierName` columns, `LearningEvent.payload.customerNameSnapshot` written by
  `billing-draft.service.ts`. Assume more exist and hunt for them per surface.

**Testing gaps**

- `verify:leads-w3-closure` fails and is **pre-existing and unrelated**. Root cause:
  `Lead_open_phone_key` is a partial unique index created by raw SQL in a migration and not
  expressible in `schema.prisma`, so a lab built with `prisma db push` lacks it. It is run
  by no CI workflow. Do not try to fix it inside an erasure increment.
- The lab uses `prisma db push`, not migration replay. It therefore cannot catch anything
  that only a real migration sequence would produce. A full replay from empty was reported
  impossible in this repo.
- `prisma db push` can fail silently in a script if its output is swallowed; new unique
  constraints make it demand `--accept-data-loss`. I hit this once and the battery failed
  with `P2022` for an unrelated-looking reason.

**Process**

- Main moves every few hours. Any authorization tied to a SHA is likely to be stale by the
  time work completes. Expect to re-gate.
- `gh` authentication was absent for much of this programme and then appeared. Do not
  assume either state; check, and never hunt for tokens.

---

## 17. EXACT NEXT ACTION

The correct next increment is **E2 Wave 2 Selection Audit**, and it is **read-only until
the owner approves a scope**.

### Step 1 — freshness, before anything

```bash
git fetch origin
```

Record the full `origin/main` SHA. Enumerate every commit since `fd047f30`. For each,
classify against the SAFE-ADDITIVE / STOP-CLASS lists in §14. Report before editing
anything.

### Step 2 — re-measure the canonical state from code, not from this document

Run the contract guard in both modes and the model-coverage arithmetic. Confirm or correct:
117 models, 117 classified, 0 unclassified, 0 stale, 0 conflicting, 55 findings with the
breakdown in §1. **If the numbers differ, that is information, not an error — report the
difference with the exact keys responsible before proceeding.**

### Step 3 — read-only candidate analysis

For each candidate surface produce, from code and not from memory:

```text
MODEL / FIELD
WHY PERSONAL DATA
CURRENT ACCOUNT-DELETION BEHAVIOUR
TENANT ATTRIBUTION (businessId? relation? none?)
RUNTIME PRIVILEGE (read scripts/security/*.sql and the migrations — SELECT/INSERT/UPDATE/DELETE)
RLS POLICY SHAPE (FOR ALL, or per-command with no DELETE?)
DOWNSTREAM REFERENCES and denormalised copies
RETENTION REQUIREMENT, and what proves it
IS IT NAMED IN docs/privacy-account-deletion-erasure-design-v1.md?
DETERMINISTIC TARGET (ERASE / ANONYMISE / UNLINK / RETAIN)
WAVE-2 ELIGIBLE = YES/NO
```

### Acceptance criteria for Wave 2 eligibility

All seven must hold. Any one missing means `WAVE-2 ELIGIBLE = NO`.

1. The surface can be attributed to the deleting business.
2. The specific personal field is concretely identified.
3. Current deletion behaviour is proven insufficient — at runtime, not by reading.
4. The desired transformation is derivable from ratified product or security semantics,
   not invented.
5. No unresolved legal or retention decision is required.
6. The change cannot destroy anything classified `RETAINED_BY_DESIGN`.
7. **The tenant runtime already holds the privilege the change needs.** If it does not, the
   increment is a grant increment, which is a different gate.

### Strong candidates on the current evidence

```text
Supplier + the three denormalised supplierName copies   — needs the owner's legal decision
                                                           on legalName / taxId / address
Appointment.notes and .title                            — needs a scope decision
The seven C4 manifest-truth findings                    — no product change at all, pure
                                                           declaration; probably the safest
                                                           and most valuable Wave 2
The two C1 delegate-name findings + posApiKey.hashedKey — same category
Task, BusinessObligation, ReceivingSession, InventoryMovement notes — free text, low risk
```

The C1 and C4 group deserves serious consideration as Wave 2 precisely because it changes
no behaviour: it makes the manifest describe what the code already does, and it will
surface `posApiKey.hashedKey` once the delegate names resolve.

### What must make the next session STOP

```text
Any STOP-class main movement
Model count changes for a reason not explained by a specific landed PR
Any candidate needing a GRANT, an RLS policy, or a migration
Any candidate whose retention basis is unproven
Any finding that appears to be resolved by two increments at once
A manual semantic merge conflict in the adapter, manifest, dispositions or harness
The owner has not approved the selected Wave 2 scope
```

### Do not, under any circumstances

```text
Start writing product code before the owner approves the Wave 2 scope
Touch PaymentWebhookEvent, rawObjectKey, rawDeletedAt or external MIME lifecycle
Start E3 retention or purge work
Change any RETAINED_BY_DESIGN disposition to make a counter move
Flip FULL PERSONAL-DATA ERASURE to PASS
Re-introduce any absolute-count assertion
Count N6 as a twelfth independent mutation
Run a migration, touch Production, or touch BTRL
```

---

## 18. NEW CLAUDE STARTING INSTRUCTIONS

> You are continuing a tightly-gated security programme on the Dubiz `business-platform`
> repository: account deletion and personal-data erasure. Read `HANDOVER-erasure-programme.md`
> in the repository root in full before doing anything. It is the source of truth and it
> stands alone — do not assume any context beyond it.
>
> Current state at handover: main was `fd047f30041be9e4f1defa6db2264fc0d4fffacc`,
> 117 Prisma models all classified, 55 open findings, E1 and E1.1 and E2 Wave 1 all merged
> and canonical, and `FULL PERSONAL-DATA ERASURE = FAIL`. That verdict is correct; do not
> change it.
>
> Your first action is **read-only**: `git fetch origin`, record the full current main SHA,
> enumerate every commit since `fd047f30`, and classify each against the SAFE-ADDITIVE and
> STOP-CLASS lists in §14 of the handover. Then re-measure the canonical state by running
> the contract guard yourself rather than trusting the numbers in the document. If anything
> differs, report the difference with the exact finding keys responsible.
>
> The next increment is the **E2 Wave 2 Selection Audit**, and it is read-only until the
> owner approves a scope. Do not write product code before that approval.
>
> Binding rules, all detailed in the handover: no production database action, no migration
> execution, no BTRL, no direct or force push to main, no squash or rebase merge, no merge
> without a current explicit owner authorization naming both SHAs. Never touch another
> session's worktree. Never rebase a published branch — merge into it. Harness first: the
> failing test is committed before the fix and must fail for the intended reason. Lab grants
> must mirror production exactly. Never anchor a proof on source formatting; use the AST
> driver at `scripts/ci/erasure-mutate.ts`. There are **eleven** independent negative proofs,
> not twelve — `N6` is the same mutation as `M6`.
>
> Above all: never prove an increment by a global finding count. Assert the delta by exact
> finding key — these named keys leave the ledger, no other leaves because of you, and none
> arrives. A count that happens to match is not evidence.
>
> Write `PROVEN` only for something you ran and observed. Use `UNPROVEN`, `UNKNOWN`,
> `INFERRED` or `BLOCKED` otherwise, and say plainly when you are relying on inherited
> context rather than your own verification. When a gate condition fails, stop and report
> — do not reconcile your way around it.
