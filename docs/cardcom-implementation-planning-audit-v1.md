# CardCom Implementation Planning Audit (v1)

**Status:** Planning audit only — no code, no migration, no schema, no tests,
no commits, no PRs. A construction blueprint, not construction.
**Branch context:** `feat/payments-foundation` @ `5c341b2` (P1 → P1.3).
**Inputs:** current repository + existing Payments implementation +
`docs/cardcom-integration-design-audit-v1.md` (verdict: MINOR GAPS REMAIN, no
re-architecture).

## Evidence basis & confidence marking

- **Repo facts** are marked **VERIFIED** (with file references).
- **CardCom specifics** are marked **INFERRED / NOT VERIFIED** — there is no
  official CardCom documentation in this repo and no live calls were made.
- Key grounding fact: `getPaymentStatus` appears **only as a type definition**
  (`lib/services/payments/providers/payment-provider.types.ts:98`) with **no
  call-site anywhere** — the verification seam exists but is not wired.

---

## 1. Impact Map

### Existing files that must change
| File | Reason | Category | Marking |
|---|---|---|---|
| `prisma/schema.prisma` (`enum PaymentProvider`, line 2364) | add `CARDCOM` value | enum extension + migration | VERIFIED |
| `lib/services/payments/payments.types.ts` | union `PaymentProvider = "TRANZILA"` → add `"CARDCOM"` | type extension | VERIFIED |
| `lib/services/payments/providers/provider-registry.ts` | register `CARDCOM → cardComProvider` in `REGISTRY` | provider registration | VERIFIED |
| `lib/services/payments/payments.deps.ts` | `resolveWebhookSecret` only handles `TRANZILA`; must also feed credential to getPaymentStatus | webhook orchestration / deps | VERIFIED |
| `lib/services/payments/payment-webhook.service.ts` | inject a verification step (GetLpResult) before moving to PAID (step 6) | webhook orchestration / authority | VERIFIED |
| `lib/services/payments/payment-request.service.ts` | `DEFAULT_PROVIDER="TRANZILA"` — default/provider-selection decision | request creation flow | VERIFIED |
| `components/settings/PaymentConnectionCard.tsx` | hardcodes "Tranzila" + merchantId/secret fields; make provider-aware (CardCom: terminal + ApiName + ApiPassword) | settings UI | VERIFIED |

### New files likely required
| File | Role | Marking |
|---|---|---|
| `providers/cardcom/cardcom.provider.ts` | implement `PaymentProviderAdapter` (createPaymentLink=LowProfile/Create, verifyWebhook, parseWebhook, **getPaymentStatus=GetLpResult**) | INFERRED |
| `app/api/payments/connections/cardcom/route.ts` | CardCom connection (mirrors tranzila) | INFERRED |
| `app/api/payments/webhook/cardcom/route.ts` | public CardCom webhook | INFERRED |
| `providers/cardcom/cardcom.provider.test.ts` | adapter tests (parse/verify/map) | INFERRED |
| (possible) `payment-verification.service.ts` | provider-agnostic webhook→verify→PAID orchestration | INFERRED |

---

## 2. Schema Impact
| Area | Classification | Justification |
|---|---|---|
| `PaymentProvider` enum (+CARDCOM) | **REQUIRED** | union + Prisma enum restrict to TRANZILA — VERIFIED |
| payment records (PaymentRequest) | **NOT REQUIRED** | generic fields (amount/currency/providerRequestId/paymentUrl/status) — VERIFIED |
| transaction identity | **NOT REQUIRED** | `providerTransactionId`/`providerRequestId` are free strings — VERIFIED |
| webhook storage | **NOT REQUIRED** | `payload Json` + `providerEventId` generic; dedup-key choice is code, not schema — VERIFIED |
| credential columns | **OPTIONAL** | CardCom needs ≥2 secrets (ApiName+ApiPassword); can be JSON-encoded into the single credential column without schema change; dedicated columns = OPTIONAL — INFERRED |

The only **REQUIRED** migration is the additive enum extension.

---

## 3. Authority Impact
- **Who owns authority today:** `processPaymentWebhook` in
  `payment-webhook.service.ts` — moves to PAID directly from `parsed.outcome`
  (step 6). **VERIFIED**.
- **Where the change occurs:** same service — between locate-request (step 4)
  and status-transition (step 6), inject `adapter.getPaymentStatus(...)`; only
  its result sets PAID. **VERIFIED**.
- **Seams/abstractions already present:** `getPaymentStatus?`,
  `GetPaymentStatusInput`, `ProviderPaymentStatus` are defined
  (`payment-provider.types.ts:73-101`) but have **no call-site** — **VERIFIED**
  (grep). The store, decrypt, and adapter registry exist.
- **What the orchestration lacks:** webhook deps currently **do not load the
  connection and do not decrypt the credential**; calling GetLpResult requires
  loading the business connection + decrypt + passing it to getPaymentStatus.
  This is a real, provider-agnostic addition that must not regress the TRANZILA
  path. **VERIFIED**.

---

## 4. Credential Impact
- **Exists (VERIFIED):** `PaymentConnection` with `merchantId` + single
  encrypted credential (`credentialEncrypted/Iv/Tag` + `encryptionKeyId`), AAD
  bound to `businessId:provider`, decrypt→null on failure.
- **Likely needs extension (INFERRED):** CardCom = TerminalNumber (→
  `merchantId`) + ApiName + ApiPassword. Encrypting **two secrets** requires
  JSON-encoding inside the single credential (no schema change) or dedicated
  columns (OPTIONAL). The UI needs ≥2 fields (provider-aware).
- **No change needed (VERIFIED):** the crypto mechanism, the AAD, the column
  layout, and the registry resolve.

---

## 5. Testing Impact
| Suite | Classification | Note |
|---|---|---|
| provider tests (new `cardcom.provider.test.ts`) | **REQUIRED** | parse/verify/map/GetLpResult mock |
| webhook tests (`payment-webhook.test.ts`) | **REQUIRED** | new authority path (verify→PAID) + TRANZILA regression |
| routes tests (`payment-routes.test.ts`) | **REQUIRED** | CardCom connection/webhook |
| request tests (`payment-request.test.ts`) | **OPTIONAL** | only if DEFAULT_PROVIDER/provider-selection changes |
| crypto tests | **OPTIONAL** | only if credential encoding (multi-secret) changes |
| integration (live sandbox) | **REQUIRED** (outside tsx harness; manual) | no integration harness in repo — VERIFIED |

---

## 6. Risk Analysis
- **Low:** union/enum extension (additive), new `cardcom.provider.ts`
  (isolated), new routes (additive), provider-aware settings UI, added tests. —
  VERIFIED
- **Medium:** migration (`ALTER TYPE ADD VALUE` — additive but a prod
  operation; PG transactional caveats — INFERRED), multi-secret credential
  encoding, `resolveWebhookSecret` branch.
- **High:** the **authority transition** in `payment-webhook.service` — touches
  orchestration **shared by all providers**: risk of wrongly marking PAID,
  duplicate processing/charges, and regression of the TRANZILA path. This is the
  single high-risk change. — VERIFIED
- **Migration risk:** adding an enum value is additive (existing data
  unaffected), low-medium risk. — INFERRED

---

## 7. Safe Execution Order (dependency ordering only)
1. **Schema** — add `CARDCOM` to the enum + migration (dev/sandbox only).
   *(foundation for everything else)*
2. **Types** — extend the `PaymentProvider` union.
3. **Provider** — `cardcom.provider.ts` + register in registry (incl.
   getPaymentStatus). *(isolated, low-risk)*
4. **Credential/deps** — multi-secret encoding + `resolveWebhookSecret`/config
   for CardCom.
5. **Authority** — wire verify→PAID in the webhook service, provider-agnostic,
   **with TRANZILA regression**. *(high-risk — isolated and tested separately)*
6. **Routes** — CardCom connection + webhook.
7. **Settings UI** — provider-aware card.
8. **Tests** — at every step; integration (sandbox) last.

Rationale: enum→types→provider→registry are structural dependencies; authority
can be built in parallel but **must precede live** and be tested alone; UI and
routes last; tests throughout.

---

## 8. Final Verdict

### **IMPLEMENTATION PLAN REQUIRES CLARIFICATION**

**Why:** the architecture fits (no re-architecture), but before implementation
starts, decisions and verifications are required:
1. **Authority approach (decision needed):** verify-on-every-webhook vs
   verify-then-PAID; how to load connection/credential inside the webhook flow;
   how to avoid regressing the existing TRANZILA "webhook→PAID" path. This is the
   high-risk item and needs a decision — **VERIFIED**.
2. **Credential shape:** JSON-encoded single column vs dedicated columns —
   **INFERRED**, decision needed.
3. **CardCom specifics still NOT VERIFIED** (LowProfile/GetLpResult field names,
   success codes, event-dedup id, ReturnValue limits, lifecycle/expiry) — block
   a clean build until confirmed against official CardCom documentation (not in
   repo).

**Why not READY:** open decisions + unverified provider facts. **Why not
blanket HIGH-RISK:** the high risk is concentrated in a single change
(authority) and can be isolated; the rest is low/medium and additive.
