# C5 — Quota Semantics Decision (v1)

**Status:** ✅ **RULED — C5 DEFERRED.** Owner ruling recorded 2026‑07‑07 (see §0). No code, no migration, no constraint change. Stage 3 closes **without** C5.
**Scope:** Define what a coupon "מכסה / נותרו X מתוך N / אזל" *means* before any implementation.
**Context:** Stage 3 location + ranking layer (C1–C4) is closed. C5 is the first item that is a **real model change**, so it was gated on this ruling.

---

## 0. Ruling (canonical) — 2026‑07‑07

**C5 is NOT implemented now.** The owner declined to relax `RedemptionEvent.couponId @unique`. The existing anchor — **one coupon = one redemption** — is kept intact.

Rejected path: a shared redemption quota (Option 1). Reasons given:
- Weakens the audit anchor.
- Does not actually prevent the *same person* from redeeming twice.
- Requires a semantic change in redemption.
- Enters a grey zone **before consumer identity exists**.

**Canonical decision:** real quota / `remaining` / `אזל` / limited issuance enter **only** as part of the **per‑user issuance generation**. Concretely, for now:
- Do **not** change any constraint.
- Do **not** relax `couponId @unique`.
- Do **not** add real `remaining`.
- Do **not** ship "נותרו X מתוך N" as a working product.
- Do **not** build real sold‑out (`אזל`) now.

C5 moves to a future stage, bundled with: **Claim / issuance · holder identity · personal coupon · issuance limit · per‑holder double‑redemption prevention.**

**Kept (already closed in C1–C4, unaffected):** "מסתיימים בקרוב" (by expiry) · popularity (by redemptions) · location / distance · city / hours.

Rationale, options, and analysis that led here are preserved below for the future generation's review.

---

## 1. The current model (ground truth)

| Object | Reality today |
|---|---|
| `Offer` → `Coupon[]` | One-to-many **already exists** in schema. |
| `Coupon` | Has `token`/`qrValue`/`publicId`. In practice publish issues **one** coupon per Offer, shown publicly to everyone. |
| `RedemptionEvent` | `couponId @unique` → **one coupon = at most one redemption**. Relation is `RedemptionEvent?` (singular). |
| Redeemer identity | `redeemingBusinessId` — the redeemer is a **Business** (B2B). There is **no consumer / holder / person** entity anywhere. |

Two facts drive everything below:
- **A**: "one coupon = one redemption" is an integrity anchor (`couponId @unique`).
- **B**: the system has **no per-person identity** — it cannot today tell whether the same human redeemed twice.

---

## 2. The two options

### Option 1 — Shared redemption quota (a pool on one asset)
"N redemptions are available against the same coupon/Offer." `נותרו X מתוך N` = `N − redeemedCount`. `אזל` = pool exhausted.

**Model implications**
- Add a declared `redemptionLimit` (on `Offer`, or on the shared `Coupon`).
- To let one shared coupon be redeemed N times, **`RedemptionEvent.couponId @unique` must be relaxed** (a coupon gains *many* redemption events). This **removes integrity anchor A**.
- `remaining` is **derivable** (exactly like the C4 redemption-count we already compute) — but only *meaningful* if redemption is actually **capped**, which needs a **transactional guard** at redeem time (avoid the over-redemption race).

**Risks**
- Loses the one-coupon-one-redemption audit guarantee (a real invariant, sibling to the Billing immutability discipline).
- Because of fact **B**, a shared pool **cannot stop the same person redeeming twice** — "50 redemptions" can be drained by one actor. Honest scarcity requires a holder the model doesn't have.
- Concurrency: N must be enforced inside a transaction, not read-then-write.

### Option 2 — Unique issuance per user (each person gets their own coupon)
Each consumer who "gets" the coupon receives **their own `Coupon` row** (own token/QR), each still redeemable once. Quota = number of instances that may be issued. `נותרו X` = slots left to claim.

**Model implications**
- Uses the existing `Offer → Coupon[]` structure directly; **keeps anchor A intact** (every coupon still one redemption).
- Requires a **holder / recipient identity** (who claimed each coupon) and a **claim/issue-on-demand** path — today the public "קבל קופון" only *reads* the one shared coupon's code, it does **not** mint a per-person coupon.
- This is a **new domain**: consumer identity + per-user issuance + holder ledger.

**Risks**
- Large blast radius: introduces consumer identity/auth — a generational addition, not a Stage-3 increment.
- Changes the meaning of today's single shared public coupon.
- If rushed, forecloses future ontology choices; deserves its own constitution-level review.

---

## 3. Fit against the locked design

| Design signal | Reads as |
|---|---|
| `נותרו 12 מתוך 50` (scarcity pool depleting) | **Option 1** (a shared pool). |
| `אזל` (sold out) | **Option 1** (pool exhausted). |
| `PersonalCouponScreen` — a personal QR | Looks like Option 2, but is today satisfied by the shared coupon's QR shown to all. Not decisive. |

**The design's scarcity language (remaining / אזל) is Option 1.** The personal-QR is presentation and does not *require* Option 2.

---

## 4. Fit against gradual implementation

| | Option 1 | Option 2 |
|---|---|---|
| Reuses existing objects | Yes (add a limit + derive count) | Yes (Offer→Coupon[]) |
| New domain needed | No | **Yes** (consumer identity) |
| Invariant change | **Relax `couponId @unique`** | None |
| Enforcement work | Transactional cap | Claim endpoint + identity |
| Blast radius | Contained | Large / generational |

Option 1 is a **contained increment**; Option 2 is a **new generation**.

---

## 5. Recommendation (pre‑ruling analysis — SUPERSEDED by §0)

> The recommendation below argued for Option 1. The owner **did not adopt it** — see §0. It is retained only as the reasoning trail for the future per‑user generation.

**Adopt Option 1 semantics for C5 — a shared redemption quota — and explicitly scope per-user identity (Option 2) out as the next generation.** Rationale:
1. It is the meaning the **locked design already speaks** (remaining / אזל = shared pool).
2. It is **gradual and additive** in spirit (declared limit + derived remaining, reusing C4's count machinery).
3. It does **not** drag in consumer identity now.

But adopt it **honestly and in two gated steps**, because a "remaining" number that isn't enforced is fake scarcity:

- **C5a — declared limit + honest cap.** Add `redemptionLimit`; enforce the cap **transactionally** at redeem time; surface `remaining` (derived) and `אזל`. The one deliberate, **documented** invariant change here is relaxing `RedemptionEvent.couponId @unique` on the shared coupon — treated like a Billing-grade change: written into this doc first, reviewed, then built.
- **C5b — per-person integrity (deferred).** Preventing the *same human* from draining the pool needs a holder identity → that is Option 2 / the next-gen issuance domain. Do **not** attempt it inside C5.

**Net:** C5 = Option 1 (shared quota), enforced for real, with the couponId-uniqueness relaxation as its single, reviewed model change; Option 2 (per-user issuance + consumer identity) is acknowledged as the future and left untouched.

**Open question for the owner:** do you accept relaxing `couponId @unique` (integrity anchor A) as the price of a shared, enforced quota — or do you prefer to wait and do quota *only* as part of the per-user generation (Option 2), keeping A intact? Everything downstream depends on this one answer.
