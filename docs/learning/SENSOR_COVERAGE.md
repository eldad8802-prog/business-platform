# Sensor coverage manifest

This is the canonical inventory of every meaningful business action in Dubiz, and of how the
learning architecture knows each one happened. It exists so that this inventory never again lives
only in a conversation.

**Keep it current.** A pull request that adds a meaningful business action adds or updates its row
here (see [`LEARNING_READY_DOD.md`](./LEARNING_READY_DOD.md)). New sensors are defined in
[`lib/sensors/catalogue.ts`](../../lib/sensors/catalogue.ts), and `lib/sensors/sensors.test.ts`
enforces the sensor contract.

Last full audit: **M5.5, 2026-09-25**, against `main` at `0d4ee26`. Six domain audits, all read-only,
every claim cited to file and line at the time. This table is their reconciled result.

## Statuses

| Status | Meaning |
|---|---|
| `COVERED` | A durable, tenant-safe sensor records the action with actor and source. This is a `LearningEvent` written by `recordSensor` or by an enriched `logAuditEvent`. |
| `COVERED_BY_DOMAIN_STATE` | The product's own authoritative records prove the action: a domain ledger (`BillingAuditEvent`, `PaymentAuditEvent`, `PayablesAuditEvent`, `ReviewEvent`, `CollectionAction`, `EntityLinkProposal`) or immutable domain rows. These are deliberately **not** duplicated into a sensor. |
| `PARTIAL` | Evidence exists but misses something a consumer may need. The notes say what. |
| `GAP` | A known blind spot: the action happens and leaves no trustworthy trace. It is documented, deliberately left open, and the reason is given. |
| `BLOCKED_PRODUCT_SEMANTICS` | The product itself cannot distinguish the states truthful evidence would need, or the action does not exist. Inventing the distinction would be fabrication. |
| `NOT_LEARNING_RELEVANT` | UI noise, operational detail, or the learner's own output. Intentionally not a sensor. |

The **Since** column marks the source of the coverage: `pre` means the evidence existed before M5.5;
`M5.5` means this milestone added it or corrected it.

**Actor / source** shorthand: `owner/UI` = `OWNER_USER` + `OWNER_UI`; `owner/IMPORT` = a person via a
file; `integration` = `INTEGRATION` + `INTEGRATION`; `system` = `SYSTEM` + `SYSTEM`. Historical rows
keep `NULL` for both. Nothing backfills them.

---

## Documents

| Action | Authoritative evidence | Sensor | Actor / source | Reversal | Consumer | Status | Since |
|---|---|---|---|---|---|---|---|
| Owner uploads a document | `Document` | `DOCUMENT_INGESTED` {origin UPLOAD} | owner/UI | none in product | DOC-04, DOC-06 by channel | COVERED | M5.5 |
| Owner forces a duplicate in | `Document` (same hash) | `DOCUMENT_INGESTED` {forcedDuplicate} | owner/UI | none | intake hygiene | COVERED | M5.5 |
| Batch document import | `Document` + `ImportRun`/`ImportRunRow` | `DOCUMENT_INGESTED` {origin IMPORT, importRunId, row} | owner/IMPORT | none | channel mix | COVERED | M5.5 |
| Gmail attachment import | `EmailAttachmentImport` (unique per message+attachment) + `Document` | `DOCUMENT_INGESTED` {origin EMAIL} | owner/UI | none | channel mix | COVERED | M5.5 |
| WhatsApp media intake | `WhatsAppAttachmentImport` (unique wamid) + `Document` | `DOCUMENT_INGESTED` {origin WHATSAPP} | integration | none | channel mix | COVERED | M5.5 |
| Extraction completed / failed | `ExtractionSnapshot`, `SliceDecision`, `ExtractionEvidence` | — | system | append-only | DOC-06 | PARTIAL: written best-effort **outside** the state transaction; on the Gmail/WhatsApp paths an empty-OCR document gets no snapshot | pre |
| Owner requests reprocessing | `Document.status` | `DOCUMENT_REPROCESS_REQUESTED` {STARTED / SOURCE_MISSING} | owner/UI | — | extraction reliability | COVERED (the source-missing branch also wrote through the global client and silently did nothing; now fixed) | M5.5 |
| Owner approves a document | `ReviewEvent` (same transaction as approval) | — | `reviewerUserId` | approval cannot be undone | DOC-04, DOC-06 | COVERED_BY_DOMAIN_STATE | pre |
| Owner corrects extracted fields | `ReviewEvent.verdicts` / `delta`; machine belief in `ExtractionSnapshot` | — | reviewer | — | DOC-06 | COVERED_BY_DOMAIN_STATE. On a **re**-approval, `ReviewEvent`'s belief is the previous human value; the machine belief must be read from `ExtractionSnapshot` | pre |
| Financial record created | `FinancialRecord` (created only on approval) | — | reviewer | updates refused (409) | DOC-02/04/05 | COVERED_BY_DOMAIN_STATE | pre |
| Historical fiscal import | `HistoricalFiscalDocument` (append-only, reversal rows) + `ImportRun` | — | run user | reversal rows | — | COVERED_BY_DOMAIN_STATE | pre |
| Data exported (tabular, documents, reports, accountant pack, uniform file) | none before | `DATA_EXPORTED` {kind, format, rowCount} | owner/UI | — | data egress record | COVERED | M5.5 |
| Inbound-email address / sender managed | `InboundEmailAddress` | `INBOUND_EMAIL_*` (existing), now with actor | owner/UI | revoke is logged | — | COVERED | M5.5 (actor) |
| Document vendor ↔ supplier identity | `EntityLinkProposal`, `PartyResolutionClaim` | — | owner decides; tax id binds | retract, not delete | DOC-02/05 | COVERED_BY_DOMAIN_STATE | M5 |
| VendorLearning counters | derived aggregate | — | — | rebuildable from `ReviewEvent` | — | NOT_LEARNING_RELEVANT | — |
| Business Memory claim materialized | `DerivedClaim*` | — | system | — | learner output | NOT_LEARNING_RELEVANT | — |
| Document deleted / rejected / approval undone | — | — | — | — | — | BLOCKED_PRODUCT_SEMANTICS (no such action exists) | — |

## Billing, payment requests and collections

| Action | Authoritative evidence | Sensor | Actor / source | Reversal | Consumer | Status | Since |
|---|---|---|---|---|---|---|---|
| Draft created / header / lines edited | `BillingDocument` | `BILLING_DRAFT_*` (existing) with actor; customer name removed from payload | owner/UI | lines replaced wholesale | — | COVERED | M5.5 (actor, privacy) |
| Submitted for review / reverted | `BillingDocument.status` | `BILLING_DOC_SUBMITTED_FOR_REVIEW` / `…_REVERTED_TO_DRAFT` with actor | owner/UI | revert is its own event | — | COVERED | M5.5 (actor) |
| Invoice / receipt issued by owner | `BillingDocument` (frozen snapshot, number) + `BillingAuditEvent` in transaction | `BILLING_DOC_ISSUED` with actor | owner | credit note | planned AR rules | COVERED_BY_DOMAIN_STATE | pre |
| Receipt auto-issued by payment settlement | `BillingDocument.sourcePaymentTransactionId` (unique) + `BillingAuditEvent` `PAYMENT_SETTLEMENT` + `PaymentAuditEvent` | — | system (no user, correct) | — | — | COVERED_BY_DOMAIN_STATE. It can't tell whether the webhook, the cron job or an owner retry triggered it. | pre |
| Credit note drafted / issued | `BillingDocument.referenceDocumentId` + `BillingAuditEvent` | existing, with actor | owner | — | — | COVERED_BY_DOMAIN_STATE. It creates no negative `FinancialEvent` (see blind spots). | pre |
| Quote converted to invoice | `convertedToInvoiceId` (unique) + `BillingAuditEvent` | existing, with actor | owner | — | — | COVERED_BY_DOMAIN_STATE | pre |
| Tax-authority allocation number / approval | `BillingAuthoritySubmission` + `BillingAuditEvent` | — | owner or authority | — | — | PARTIAL: `source` is hard-coded `SYSTEM` even when a human `actorUserId` is present | pre |
| Manual receipt payment lines / allocations (draft stage) | overwritten in place; frozen into the issued snapshot | — | not recorded | overwrite | — | PARTIAL: only the issued state is authoritative | pre |
| Payment request created / cancelled | `PaymentRequest` + `PaymentAuditEvent` | — | owner | cancel keeps previous status | collection timing | COVERED_BY_DOMAIN_STATE | pre |
| Provider verified a payment | `PaymentTransaction` (unique provider id) + `PaymentAuditEvent` PROVIDER | — | provider | refund rows | AR timing | COVERED_BY_DOMAIN_STATE. Note: `paidAt` is processing time, not the provider's payment time. | pre |
| Settlement paused / retried / requeued | `PaymentAccountingSettlement` + `PaymentAuditEvent` | — | system | — | — | PARTIAL: `requeueSettlement` and the manual-retry actor leave no event | pre |
| Refund / void executed | negative `PaymentTransaction` (`reversesTransactionId`) + `PaymentAuditEvent` REQUESTED→SETTLED/FAILED | — | owner requests, provider settles | this is the reversal | — | COVERED_BY_DOMAIN_STATE for the money. There is no accounting counterpart (see blind spots). | pre |
| Payment connection changed | `BusinessPaymentConnection` + `PaymentAuditEvent` | — | owner | — | — | PARTIAL: no previous value | pre |
| Owner initiated a collection reminder | `CollectionAction` (append-only by privilege, #515) | — | owner (session) | none (append-only) | reminder effectiveness | COVERED_BY_DOMAIN_STATE | M5 |
| Reminder delivered / read | — | — | — | — | — | BLOCKED_PRODUCT_SEMANTICS: share, copy and wa.me happen on the device; nothing is observed | — |
| Payment request expired | `EXPIRED` status has no writer | — | — | — | — | BLOCKED_PRODUCT_SEMANTICS | — |
| Customer / business payment terms changed | columns exist; **no write path** | — | — | — | AR lateness | BLOCKED_PRODUCT_SEMANTICS: no UI, route or import writes either field. A UI was not invented just to produce data. | — |
| Awaiting-payment list / inbox views | read model | — | — | — | — | NOT_LEARNING_RELEVANT | — |
| PDF rendered / failed | `pdfRenderStatus` | existing, error text removed from payload | owner | — | — | NOT_LEARNING_RELEVANT (operational) | — |

## Payables and obligations

| Action | Authoritative evidence | Sensor | Actor / source | Reversal | Consumer | Status | Since |
|---|---|---|---|---|---|---|---|
| Payee created | `Payee` | `PayablesAuditEvent` `PAYEE_CREATED` (same transaction) | owner | — | AP-04 subjects | COVERED | M5.5 |
| Commitment + installments created | `Commitment`, `Installment` + `PayablesAuditEvent` | — | owner | — | AP-01/03/04 | COVERED_BY_DOMAIN_STATE | pre |
| Commitment edited (title / note / category / payee) | overwritten + `COMMITMENT_UPDATED` | — | owner | — | — | PARTIAL: before-values only for title and payee | pre |
| Installment cancelled | `Installment.cancelledAt` + audit | — | owner | final | AP-* exclusion | COVERED_BY_DOMAIN_STATE | pre |
| Manual payment recorded | `Payment` + `PaymentEvidence{MANUAL}` + `PaymentAllocation` + audit | — | owner (owner-asserted) | void / reverse | AP-01/03/04/06 | COVERED_BY_DOMAIN_STATE | pre |
| Payment voided | `Payment.voided*` + audit | — | owner | this is the reversal | AP-* excludes VOID | COVERED_BY_DOMAIN_STATE. A void does not cascade to the cheque, preparation or evidence (see blind spots). | pre |
| Allocation reversed | `PaymentAllocation.reversed*` + audit | — | owner | this is the reversal | AP-* excludes reversed | COVERED_BY_DOMAIN_STATE | pre |
| Cheque created / advanced / cancelled / replaced | `Cheque` + audit (from→to) | — | owner | replace chain | — | COVERED_BY_DOMAIN_STATE (the timeline lives in the audit only) | pre |
| Cheque cleared | `Cheque.clearedSource = OWNER_ASSERTED` + `Payment` + `Evidence{CHEQUE}` | — | owner-asserted | bounce | AP-06 **v2 counts it as NOT backed** | COVERED_BY_DOMAIN_STATE | pre (rule corrected M5.5) |
| Cheque bounced | `Cheque.status` + payment void + audit | — | owner | this is the reversal | — | COVERED_BY_DOMAIN_STATE (no bounce columns; audit only) | pre |
| Bank account / payment destination lifecycle | rows + audit | — | owner | archive, replace chain | — | COVERED_BY_DOMAIN_STATE (bank-account update keeps field names only) | pre |
| Payment prepared / approved / cancelled / completed | `PaymentPreparation` (+ `completionSource` OWNER_REPORTED / BANK_OBSERVED / PROVIDER_SETTLED) + audit | — | owner | cancel | authority distinction | COVERED_BY_DOMAIN_STATE | pre |
| Bank line entered / uploaded | `ExternalTransaction` (immutable by trigger; source OWNER_ENTRY / OWNER_UPLOAD) | — | owner | — | — | COVERED_BY_DOMAIN_STATE | pre |
| Bank line reconciled / rejected / dismissed | `PaymentEvidence{BANK_TRANSACTION}`, rejection rows + audit | — | owner | revoke | AP-06 | COVERED_BY_DOMAIN_STATE | pre |
| Evidence revoked | `PaymentEvidence.revoked*` + audit | the event type now matches the evidence kind (`EVIDENCE_REVOKED` + kind) | owner | this is the reversal | AP-06 | COVERED | M5.5 (it was always logged as a DOCUMENT revocation) |
| Payment recorded from a document | MANUAL + DOCUMENT evidence | — | owner | revoke | AP-06 | PARTIAL: 3–4 separate transactions, so a payment can exist without its DOCUMENT evidence | pre |
| Legacy obligation created / edited / snoozed / completed / released / oriented | `BusinessObligation` (overwritten in place) | `OBLIGATION_CHANGED` {action, fields, amountChanged, dueAtChanged} | owner/UI; series continuation = system | edits are events | legacy obligation handling | COVERED | M5.5 |
| Commitment closed / released | statuses exist; nothing sets them | — | — | — | — | BLOCKED_PRODUCT_SEMANTICS | — |
| Outbound provider execution | only a test adapter is registered | — | — | — | — | BLOCKED_PRODUCT_SEMANTICS (not live) | — |

## Customers

| Action | Authoritative evidence | Sensor | Actor / source | Reversal | Consumer | Status | Since |
|---|---|---|---|---|---|---|---|
| Customer created in the customers UI | `Customer` | `CUSTOMER_CREATED` {origin UI} | owner/UI | archive | acquisition mix | COVERED | M5.5 |
| Customer created from billing | `Customer` | `CUSTOMER_CREATED` {origin BILLING} | owner/UI | archive | acquisition mix | COVERED | M5.5 |
| Customer created as a side effect of a lead | `Customer` | `CUSTOMER_CREATED` {origin LEAD, leadId}, only on real creation | the lead's actor | archive | acquisition mix | COVERED | M5.5 |
| Customer auto-created from a WhatsApp message | `Customer` (name = phone) | `CUSTOMER_CREATED` {origin WHATSAPP, conversationId} | integration | archive | acquisition mix | COVERED | M5.5 |
| Customer imported | `Customer` + `ImportRun` | `CUSTOMER_CREATED` {origin IMPORT, importRunId, row}, key `import:run:row:customer` | owner/IMPORT | archive | acquisition mix | COVERED | M5.5 |
| Customer details / contact changed | `Customer` (overwritten) | `CUSTOMER_UPDATED` {fields} (names only) | owner/UI | — | — | COVERED | M5.5 |
| Customer archived / reactivated | `Customer.isActive` | `CUSTOMER_ARCHIVED` / `CUSTOMER_REACTIVATED` (real transitions only) | owner/UI | each direction is an event | churn | COVERED | M5.5 |
| Customer tax identity changed | `Customer` legal fields | `CUSTOMER_TAX_IDENTITY_CHANGED` {fields} | owner/UI | — | — | COVERED | M5.5 |
| Customer payment terms changed | `Customer.paymentTermsDays` | — | — | — | AR lateness | BLOCKED_PRODUCT_SEMANTICS (no write path) | — |
| Customer merged / deleted | — | — | — | — | — | BLOCKED_PRODUCT_SEMANTICS (no such action; erasure anonymizes) | — |

## Leads, CRM, deals and appointments

| Action | Authoritative evidence | Sensor | Actor / source | Reversal | Consumer | Status | Since |
|---|---|---|---|---|---|---|---|
| Lead created by the owner | `Lead` (`sourceChannel`) | `LEAD_CREATED`, now with actor | owner/UI | status change | source quality | COVERED | M5.5 (actor) |
| Lead imported | `Lead` + `ImportRun` | `LEAD_CREATED` | owner/IMPORT | status change | source quality (import ≠ typed) | COVERED | M5.5 |
| Lead created from a conversation by the owner | `Lead`, `Conversation.leadId` | `LEAD_CREATED_FROM_CONVERSATION` | owner/UI | — | channel effectiveness | COVERED | M5.5 (actor) |
| Lead auto-captured from an inbound message | same | `LEAD_CREATED_FROM_CONVERSATION` | **system** | — | auto-capture precision | COVERED (previously identical to an owner-created lead) | M5.5 |
| Lead status changed / reopened / dropped | `Lead.status` | `LEAD_STATUS_CHANGED` {from, to} | owner/UI | reopen is from→to | conversion, time-to-close | COVERED | M5.5 (actor) |
| Lead marked WON | `status = WON`, `closedAt` | `LEAD_WON` | owner/UI | reopen | win rate | COVERED | M5.5 (actor) |
| Lead marked LOST | `status = LOST`, `lostReason` on the row | `LEAD_LOST` {reasonGiven}; the reason text stays on `Lead` only | owner/UI | reopen | loss reasons (read from `Lead`) | COVERED | M5.5 (actor, privacy) |
| Follow-up set / rescheduled / completed | `Lead.nextFollowUpAt` | `LEAD_FOLLOWUP_*` | owner/UI | — | follow-up discipline | COVERED. Closing a lead silently clears the follow-up (noted). | M5.5 (actor) |
| Lead edited (including source channel) | `Lead` | `LEAD_UPDATED` {fields, from/toSourceChannel} | owner/UI | — | attribution integrity | COVERED | M5.5 |
| First meaningful response to a lead | `Message` rows; `CONVERSATION_BUSINESS_RESPONDED` now carries an actor | — | owner when `senderType = BUSINESS_USER` | — | response latency | PARTIAL: `firstResponseLatencySec` has no writer, and `senderType` is client-asserted | M5.5 (actor) |
| Lead converted into a paying customer | — | — | — | — | conversion to revenue | BLOCKED_PRODUCT_SEMANTICS: `customerId` is bound at lead creation; nothing links a lead to an invoice or payment | — |
| Lead assigned | — | — | — | — | — | BLOCKED_PRODUCT_SEMANTICS (no assignee field) | — |
| Lead from external ad / social / e-commerce integrations | — | the seam exists: source `INTEGRATION` | — | — | channel effectiveness | BLOCKED_PRODUCT_SEMANTICS (no such integration is live; no fake evidence was created) | — |
| Collaboration deal generated | `CollaborationDeal` | `DEAL_CREATED` (system) | system | — | — | PARTIAL: `entityId` is null (the uuid is in the payload), and every generate run creates new rows | pre |
| Collaboration deal accepted / dismissed | `CollaborationDeal.status` | `DEAL_ACCEPTED/DISMISSED` | owner/UI | re-toggle | — | PARTIAL: no from-state; repeats emit duplicates | pre |
| Appointment created | `Appointment` (`createdByActor`, `sourceChannel`, `createdByUserId`) | — | on the row | — | — | COVERED_BY_DOMAIN_STATE | pre |
| Appointment status changed (confirmed / completed / cancelled / no-show) | `Appointment.status` | `APPOINTMENT_STATUS_CHANGED` {from, to} | from the service's server-built actor | terminal states are final | no-show rate | COVERED | M5.5 |
| Appointment rescheduled | `startsAt` (overwritten) | `APPOINTMENT_RESCHEDULED` {previous, new} | same | — | reschedule rate | COVERED | M5.5 |

## Suppliers and purchasing

| Action | Authoritative evidence | Sensor | Actor / source | Reversal | Consumer | Status | Since |
|---|---|---|---|---|---|---|---|
| Supplier created (UI) | `Supplier` | `SUPPLIER_CREATED` {origin UI, hasTaxId} | owner/UI | deactivate | identity subjects | COVERED | M5.5 |
| Supplier imported | `Supplier` + `ImportRun` | `SUPPLIER_CREATED` {origin IMPORT, importRunId, row} | owner/IMPORT | deactivate | identity subjects | COVERED | M5.5 |
| Supplier edited | `Supplier` (overwritten) | `SUPPLIER_UPDATED` {fields, taxIdChanged} | owner/UI | — | identity (a changed tax id changes what may bind) | COVERED | M5.5 |
| Supplier deactivated / reactivated | `Supplier.isActive` | `SUPPLIER_DEACTIVATED/REACTIVATED` | owner/UI | each direction | SUPP-01 freshness | COVERED | M5.5 |
| Identity proposed / confirmed / rejected; tax-id binding | `EntityLinkProposal`, `PartyResolutionClaim` | — | owner decides; valid tax id binds | retract, not delete | cross-domain joins | COVERED_BY_DOMAIN_STATE | M5 |
| Purchase order created by the owner | `PurchaseOrder.createdByUserId` | — | owner | — | SUPP-01 | PARTIAL: `PurchaseOrder.source` is client-supplied | pre |
| Purchase order created by approving a draft | `PurchaseOrder.sourceSupplierPurchaseDraftId` | — | approver | — | SUPP-01 (SUPP-02/03 **v2 exclude it**) | COVERED_BY_DOMAIN_STATE | pre (rules corrected M5.5) |
| Purchase order sent / cancelled / edited | — | — | — | — | — | BLOCKED_PRODUCT_SEMANTICS: "send" is client-side share only; SENT and CANCELLED are unreachable; lines are immutable | — |
| Ordered vs received on draft approval | one transaction does both | — | — | — | — | BLOCKED_PRODUCT_SEMANTICS (one click means ordered **and** received) | — |
| Receiving session created | `ReceivingSession` | — | `createdByUserId` | — | — | COVERED_BY_DOMAIN_STATE | pre |
| Receiving posted | `ReceivingSession.postedAt/By` + `InventoryMovement` | `INVENTORY_RECEIVING_POSTED` {purchaseOrderId, movementIds} | owner | none (no void) | SUPP-02, INV-02 (structured movement ↔ receipt link; it was free text before) | COVERED | M5.5 |
| Purchase order settled (e.g. CLOSED) | `PurchaseOrder.status` (overwritten, no closedAt) | `PURCHASE_ORDER_STATUS_SETTLED` {from, to} | system | — | SUPP-02 closure time | COVERED | M5.5 |
| Undelivered remainder decided (backorder / close short) | single overwritten slot | `PURCHASE_ORDER_REMAINDER_DECIDED` {from, to} | owner | each decision is an event | SUPP-03 | COVERED | M5.5 |
| Supplier purchase draft created (UI / CSV) | `SupplierPurchaseDraft` | — | `createdByUserId` | — | intake precision | PARTIAL: `source` comes from the client / the CSV itself | pre |
| Machine line suggestion vs owner's final choice | `suggestedItemId/Score/Decision` written once; `matchedItemId/decision` = owner's | — | — | — | intake precision | COVERED_BY_DOMAIN_STATE | M5 |
| Supplier purchase draft rejected | `status = REJECTED` (no actor on the row) | `SUPPLIER_PURCHASE_DRAFT_REJECTED` | owner/UI | — | intake precision | COVERED | M5.5 |

## Inventory and POS

| Action | Authoritative evidence | Sensor | Actor / source | Reversal | Consumer | Status | Since |
|---|---|---|---|---|---|---|---|
| Item created (UI, photo draft, supplier draft, POS match, insight, import) | `InventoryItem` (no actor column) | `INVENTORY_ITEM_CREATED` {origin, …ids} | per path | deactivate | INV-* population | COVERED | M5.5 |
| Item edited (price, cost, thresholds, SKU/barcode, active) | overwritten in place | `INVENTORY_ITEM_UPDATED` {fields, identityChanged, thresholdsChanged, …} | owner/UI | — | INV-05 (a moved threshold changes what "pressure" means) | COVERED | M5.5 |
| Quantity changed / manual correction | `InventoryMovement` (before, after, reason, `createdByUserId`) | — | owner | compensating movement | INV-02, INV-04 | COVERED_BY_DOMAIN_STATE. The reason is chosen by the owner and not verified. | pre |
| Manual sale recorded | `InventoryMovement` SALE | — | owner | — | — | COVERED_BY_DOMAIN_STATE (no idempotency key) | pre |
| POS sale ingested (applied or held) | `InventoryExternalSale` (unique external id) + movements | `POS_SALE_INGESTED` {externalSaleId, movementIds, outcome} | integration | — | sales velocity (POS only) | COVERED | M5.5 |
| Unmatched POS product held | `InventoryPendingMatch` + alert | — | integration | — | — | COVERED_BY_DOMAIN_STATE | pre |
| Held POS sale resolved (link / create / reject) | `InventoryPendingMatch` RESOLVED/REJECTED, `POSProductMapping` (overwritten) | `POS_PENDING_MATCH_RESOLVED` {mode, movementIds, mappingReplaced} | owner/UI | — | mapping precision | COVERED. **The stock effect is wrong** (see blind spots), and the sensor records the one movement actually written. | M5.5 |
| POS line matched by SKU/barcode fallback (no mapping) | none | — | — | — | — | PARTIAL: `POS_SALE_INGESTED` does not say whether a mapping or the fallback matched | M5.5 |
| Stock alert raised | `InventoryAlert` (one open per type) | — | system | — | INV-05 | COVERED_BY_DOMAIN_STATE | pre |
| Stock alert resolved | `isResolved` + **`resolvedAt` now written** (only on the open → resolved transition) | — | — | — | alert duration | COVERED_BY_DOMAIN_STATE | M5.5 (resolvedAt was never written before) |
| Photo inventory draft approved / merged / rejected | `InventoryDraft.status` (no decider on the row) | `INVENTORY_DRAFT_DECIDED` | owner/UI | — | detection precision | COVERED | M5.5 |
| Suspicious-correction alert | enum value with no producer | — | — | — | — | BLOCKED_PRODUCT_SEMANTICS | — |

## Conversations and WhatsApp

| Action | Authoritative evidence | Sensor | Actor / source | Reversal | Consumer | Status | Since |
|---|---|---|---|---|---|---|---|
| Inbound WhatsApp message | `Message` (unique provider id) | `CONVERSATION_INBOUND_RECEIVED` (ids only) | **integration** | — | response latency | COVERED | M5.5 (actor) |
| Message posted as "inbound" through the app route | `Message` (direction from the body) | same event, UNKNOWN | unknown | — | — | BLOCKED_PRODUCT_SEMANTICS: only `providerMessageId IS NULL` separates a simulated message from a real one | — |
| Owner sends a message | `Message` (`senderType` from the client) | `CONVERSATION_BUSINESS_RESPONDED` {senderType} | owner/UI **only when** `senderType = BUSINESS_USER`, otherwise UNKNOWN | — | response latency | PARTIAL: `Message` has no user id, and `senderType` is client-asserted | M5.5 |
| Bot / template message sent | no autonomous send exists | — | — | — | — | BLOCKED_PRODUCT_SEMANTICS | — |
| Delivery / read receipts | status webhooks are dropped at parse | — | — | — | — | GAP: needs provider status-webhook handling, which is an integration change and out of scope | — |
| Conversation opened by hand | `Conversation` | `CONVERSATION_OPENED_MANUALLY` | owner/UI | close | — | COVERED (the linked customer and lead are now verified to belong to the business) | M5.5 |
| Conversation opened by an inbound message | `Conversation` | — | integration | close | — | COVERED_BY_DOMAIN_STATE | pre |
| Conversation linked to a lead | `Conversation.leadId` | `LEAD_CONVERSATION_LINKED` | owner or system | — | — | COVERED | M5.5 (actor) |
| Conversation closed | `status`, `closedAt` (overwritten) | `CONVERSATION_CLOSED` {previousStatus} | owner/UI | reopen is possible | resolution time | COVERED | M5.5 |
| Owner takes over from the bot | drafts DISMISSED | `CONVERSATION_HUMAN_TAKEOVER` {draftsDismissed} | owner/UI | — | handoff rate | COVERED | M5.5 |
| Reply suggestion generated | `ReplySuggestion` | — | system | — | — | COVERED_BY_DOMAIN_STATE | pre |
| Reply suggestion shown / selected / edited / sent / ignored | client-asserted, non-atomic; `sentMessageId` never written | — | — | — | suggestion adoption | GAP: truthful evidence needs the send path to bind the suggestion server-side. This is a product change to the send contract, left for its own change. | — |
| WhatsApp connected / disconnected | `WhatsAppConnection.status` (overwritten) | — | — | — | — | GAP: low learning value, left open | — |

## Settings and business profile

| Action | Authoritative evidence | Sensor | Actor / source | Reversal | Consumer | Status | Since |
|---|---|---|---|---|---|---|---|
| Business model / category changed | `BusinessProfile` (overwritten) | `BUSINESS_PROFILE_CHANGED` {fields, from/toBusinessModel}; category by name only (it is free text) | owner/UI | — | every interpretation; M6 baselines reset on a model change | COVERED | M5.5 |
| Billing identity changed (VAT status, tax id, VAT number, legal name) | `BusinessProfile` billing fields (overwritten) | `BILLING_IDENTITY_CHANGED` {fields, from/toBusinessKind, taxIdChanged, vatNumberChanged}; identifiers as flags only | owner/UI | — | billing interpretation | COVERED | M5.5 |
| Billing presentation (logo, footer, template, note) | same | listed by name only when it changes together with an identity field | — | — | — | NOT_LEARNING_RELEVANT | — |
| Assistant settings changed (on/off, mode, …) | `BusinessBotSettings` (overwritten) | `BOT_SETTINGS_CHANGED` {fields, from/toEnabled, from/toMode} | owner/UI | — | response latency (a bot being on changes what "replied" means) | COVERED | M5.5 |
| Feature access override (platform) | `BusinessFeatureAccess` + `PlatformAuditEvent` (old/new) | — | platform admin | — | — | COVERED_BY_DOMAIN_STATE | pre |
| Tax authority connected / revoked | `BillingAuthorityConnection` + `BillingAuditEvent` | — | owner | revoke | — | COVERED_BY_DOMAIN_STATE | pre |
| Assistant learning suggestion adopted / dismissed | status + timestamps (no actor) | — | — | — | — | GAP: bot-domain feedback loop, left for the M8/M9 assistant work | — |
| Default payment terms, opening hours, currency, notification preferences | no writer exists | — | — | — | — | BLOCKED_PRODUCT_SEMANTICS | — |
| Notification read | `readAt` | — | — | — | — | NOT_LEARNING_RELEVANT | — |

## Insights and owner feedback

| Action | Authoritative evidence | Sensor | Actor / source | Reversal | Consumer | Status | Since |
|---|---|---|---|---|---|---|---|
| Insight generated / refreshed | `BusinessInsight` (a refresh overwrites the wording) | — | system | — | — | PARTIAL: the wording the owner saw is not snapshotted; `INSIGHT_DECIDED` carries `composerVersion` | pre |
| Owner decided (adopted / dismissed), including changing their mind | `BusinessInsight.status` (overwritten) | `INSIGHT_DECIDED` {from, to, insightKind, composerVersion, noteGiven} (same transaction, no key, so every decision is kept) | owner/UI | each change is its own event | M9 outcome learning | COVERED | M5.5 |
| Owner **ignored** an insight | — | nothing, on purpose | — | — | — | NOT_LEARNING_RELEVANT: silence is not rejection | — |
| Owner "acted on" an insight | no such state | — | — | — | — | BLOCKED_PRODUCT_SEMANTICS | — |

## Revenue, content and account

| Action | Authoritative evidence | Sensor | Actor / source | Reversal | Consumer | Status | Since |
|---|---|---|---|---|---|---|---|
| Coupon created / published / disabled / enabled | `Coupon`, `Offer` | `REVENUE_COUPON_*` with actor; bearer token / QR / free text removed | owner/UI | disable/enable | — | COVERED | M5.5 (actor, privacy) |
| Coupon redeemed | `RedemptionEvent` (unique coupon) | `REVENUE_COUPON_REDEEMED`; actor UNKNOWN when another business's user redeemed it | — | — | — | COVERED_BY_DOMAIN_STATE | pre |
| Content post linked / performance reported | `LearningEvent` (owner, direct) | existing | owner/UI | — | — | COVERED (the metrics are owner-reported, and are labelled so) | pre |
| Content generation runs | `ContentRun` etc. | — | — | — | — | NOT_LEARNING_RELEVANT (marketing tool internals) | — |
| Account deleted | `Business.deletedAt` + `ACCOUNT_DELETED` | now with actor | owner/UI | irreversible | — | COVERED | M5.5 (actor) |

---

## Known blind spots (open, on purpose)

These were found by the audit and deliberately **not** fixed in M5.5, because fixing them changes
product, accounting or integration behavior rather than evidence:

1. **POS pending-match resolution corrupts stock.** On resolution, only the summed quantity of the
   *unmatched* lines is deducted, and all of it from a single item. The sale's *matched* lines are
   never deducted, and the sale is then marked processed (`lib/services/inventory/pending-match.service.ts`,
   `app/api/inventory/pos/sale/route.ts`). This is a product defect. Until it is fixed, stock-level
   learning must not trust quantities on items that received POS-resolution movements.
   `POS_PENDING_MATCH_RESOLVED` identifies exactly those movements.
2. **Refunds and credit notes have no accounting counterpart.** No negative `FinancialEvent` is
   posted, and the invoice still reads as paid. This is accounting authority, which is out of scope.
3. **A voided payment does not cascade.** Its cheque stays CLEARED, its preparation stays COMPLETED,
   and its evidence stays active.
4. **Delivery and read receipts, reply-suggestion adoption, and WhatsApp connection changes** are
   `GAP`s (see the Conversations section).
5. **Several timestamps record processing time, not business time.** Provider payment time and
   inbound message time are examples. `LearningEvent.occurredAt` exists for sensors that know better.
6. **`PayablesAuditEvent`, `BillingAuditEvent` and `PaymentAuditEvent` are not append-only by
   privilege** (unlike `CollectionAction`). The app never mutates them. `LearningEvent`'s erasure
   disposition is an open owner decision, so it too is not revoked.

## How failure works (deliberately)

- **A sensor inside a business transaction** (`{ tx }`) is atomic with the action: it commits or
  rolls back with it. It is written behind a **SAVEPOINT**, so a failure of the sensor alone (a lock
  wait, a timeout, a bad value) rolls back to the savepoint, is logged by sensor name and error
  code, and leaves the business transaction healthy. A retried action is `ON CONFLICT DO NOTHING`.
  The battery proves both.
- **A known race.** Two concurrent identical transitions (for example two "archive" clicks) can
  each write a transition sensor, because the before-read precedes the row lock. This duplicates a
  sensor row, never business data.
- **A sensor outside a transaction** is fail-open. The action is already recorded in its own table.
- **Validation refusals** (an unknown sensor, a forbidden key, an actor/source contradiction) write
  nothing and never throw. They are logged by sensor name and reason, never by content.
- **Deployment order is enforced by the migration-first rule.** The `LearningEvent` columns ship
  (PR-1) and are applied before the code that writes them (PR-2) is merged.
