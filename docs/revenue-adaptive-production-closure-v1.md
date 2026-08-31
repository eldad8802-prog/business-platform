# Revenue Adaptive Production Closure

**Date:** 2026-08-31
**Verdict:** **Revenue Adaptive v1 — PASS / SAFE SHIPPED SCOPE**
**Related:** `revenue-adaptive-design-report-v1.md` · `revenue-surface-classification-contract-v1.md`

> **Caveat, stated up front.** Multi-coupon management states remain **NOT
> CURRENTLY RUNTIME PROVEN**: the production business holds a single coupon, and
> no coupon was issued for QA. See §10 for exactly what that does and does not
> cover.

---

## 1. Merge SHAs

| PR | Squash SHA |
|---|---|
| #296 — R0/R1 classification contract + management foundation | **`bd65078`** |
| #298 — coupon public-id / auth contract bugfix | **`2a51e78`** |
| #299 — R2 management composition | **`03ba8fd`** |

Freshness before each merge: three unrelated commits (`#297` Leads, `#300`
Billing tenant isolation, `#301` Leads smoke) landed in between with **zero
Revenue overlap**, and #298 and #299 touch **disjoint file sets** — so no rebase
was needed and no conflict was resolved by widening scope.

## 2. Production deployment

`Production – business-platform` — the project that serves `promaxgroup.co.il`.
Deployment **`6173735887`**, SHA **`03ba8fd`**, state **success**. The `-btrl`
project deploys the same SHAs and was **not** used as evidence.

## 3. #298 runtime result — PASS

| Probe | Status |
|---|---|
| public lookup, malformed id (`999999999`) | **404** (was 500) |
| public lookup, alpha id (`abc`) | **404** (was 500) |
| public lookup, well-formed but missing | **404** |
| **malformed and missing indistinguishable** | 404 vs 404 ✓ |
| secret `/code`, anonymous | **401** — auth still checked before the identifier |
| secret `/code`, authenticated + malformed | **404** (was 500) |
| **`/code` malformed and missing indistinguishable** | 404 vs 404 ✓ |
| redemption, unauthenticated | **401** (was 400) |

Anonymous management APIs, from a clean context with no session:
`mine` 401 · `my-business` 401 · `offers` 401 · `disable` 401 · `enable` 401.

No enumeration signal, no token or `qrValue` in any response, no Revenue
refactor around the fix.

## 4. #299 runtime result — PASS

## 5. MANAGEMENT viewport matrix (production)

| | 390 | 768 | 1024 | 1280 | 1440 | 1920 |
|---|---|---|---|---|---|---|
| `mine` intent | content | content | content | **data** | **data** | **data** |
| `mine` container | 390 | 768 | 776 | 1032 | 1192 | **1280** |
| `mine` grid columns | **1** | **2** | **2** | **3** | **3** | **3** |
| column width | 390 | 384 | 388 | 344 | 397 | 427 |
| `create` | 390 focused | **560** | **560** | **560** | **560** | **560** |
| shell nav (all management) | 0 | 0 | **1** | **1** | **1** | **1** |

The cap is asserted to come from `PageContainer`'s **own inline style**
(`max-width: 1280px` at the data tier), not from a stylesheet override — the
check reads `element.style.maxWidth` directly, because a CSS override would have
silently lost to the primitive's inline style.

Zero horizontal overflow across 36 cells · RTL preserved · no interactive target
under 24px · never two navigation surfaces.

`create` is **not stretched** by a wide shell. `redeem` stays a focused
management task with no artificial workspace.

## 6. Consumer regression — PASS

`?view=browse` keeps its **480 screen cap** and **no management chrome** at every
one of the six widths. The public coupon route carries **no management chrome**
at any width, answers a malformed identifier with a controlled 404, produces no
500, and exposes no token. No management layout leaked into either.

## 7. Preview regression — PASS

`/coupon-design` keeps `PhoneFrame mode="device"` and its **390px device mocks**
at every width, still mounts the real `CouponCreationFlow` and
`PublicCouponContent`, and gained no duplicate implementation.

## 8. Request / refetch parity — PASS

**One request per surface per load, at every viewport.** No remount, no
duplicated effect, no state reset when the viewport crosses a tier.

One measurement correction was made rather than normalised away: the first run
reported a duplicate, and investigation showed the harness had attributed **its
own API probes** to whichever page bucket was last active. Probe traffic is now
bucketed separately; the genuine per-surface tallies were 1 in both runs.

## 9. Security / token boundary — PASS

- `token` / `qrValue` appear in **no** rendered DOM on any surface at any width.
- `publicId` remains the only identity in public URLs and public responses.
- The secret stays behind the authenticated, issuer-authorised `/code` path;
  anonymous access is still 401 and the ownership check that yields 403 is
  untouched.
- Kill-switch semantics unchanged — still `issuingBusinessId`-checked server
  side; the control still sits on the actionable card.
- Anonymous management APIs remain protected.

## 10. State coverage limitations

Production holds **one** coupon for this business, in the **REDEEMED** state.

**RUNTIME PROVEN in production**
- Populated `mine` with a real card, rendered inside the collection grid at 1920.
- The `REDEEMED` state, its pill, and the "הסתיים" section.
- The card's metadata row (פורסם / בתוקף עד / מומש) and its "עמוד הקופון" action.
- Correct **absence** of the kill switch on a redeemed coupon.
- Loading and empty states, the creation wizard's first step, redeem idle.

**NOT CURRENTLY RUNTIME PROVEN** — no coupon was issued to close any of these:
- **Multi-card flow**: the two- and three-column grids hold one card, so the
  column *rule* is proven (probed from the shipped stylesheet in the live
  document) but multi-card reflow is not.
- **Kill switch** (`disable` / `enable`): needs an ACTIVE or DISABLED coupon.
- **ACTIVE and EXPIRED** card states.
- **A real public coupon page**: no safe existing coupon page was opened, so the
  consumer artifact is proven only in its not-found state.

These are coverage limitations, not failures.

## 11. Remaining Revenue adaptive debt

Documented, not actioned:

1. **Populated-state runtime validation** — everything in §10's second list.
2. **`components/revenue/issue/*`** — `LEGACY / DEAD — VERIFIED` (~800 lines
   behind an unconditional redirect). **Not deleted**; cleanup is its own wave.
3. **Remaining API-contract findings** — none open. Both R0.1 findings are fixed
   and verified in production.
4. **Route normalisation** — `?view=mine|browse|create` stays one route by owner
   decision. Classification, not the URL, is the layout authority. Revisit only
   if product or navigation work independently justifies it.

## 12. Final verdict

**Revenue Adaptive v1 — PASS / SAFE SHIPPED SCOPE.**

| Gate | Result |
|---|---|
| #298 Production | **PASS** |
| #299 Production | **PASS** |
| MANAGEMENT composition | **PASS** |
| CONSUMER regression | **PASS** |
| PREVIEW regression | **PASS** |
| Request parity | **PASS** |
| Security regression | **none** |

Production closure smoke: **68/68**.

> Populated coupon-management states remain NOT CURRENTLY RUNTIME PROVEN because
> no safe existing coupon state is available for them and no coupon was issued
> for QA.

R3 was **not** started: consumer isolation, preview isolation and the
Management / Consumer / Preview classification are all proven in production, and
this closure surfaced no concrete adaptive gap that would justify another wave.
