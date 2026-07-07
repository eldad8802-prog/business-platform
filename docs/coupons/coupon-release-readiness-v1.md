# Coupons — Closure & Release Readiness (v1)

**Date:** 2026‑07‑07 · **Feature:** מבצעים וקופונים (entry `/revenue`) · **Scope:** Stages 1–3, closed.
**Purpose:** Single closure report for the whole coupon world before PR / merge / deploy. **No new code. Stage 4 not started. C5 not reopened.**

> **⚠️ Branch note:** all coupon work currently sits **uncommitted** on branch `feat/accessibility-fab-and-turquoise-cta` (modified + untracked), intermixed with unrelated accessibility/turquoise‑CTA work. Isolating it is the first release action — see §11.

---

## 1. What was done, per stage

| Stage | Intent | Result |
|---|---|---|
| **Design** (pre‑1) | Build the full coupon design package from the mockups; one continuous experience. | `/coupon-design` gallery + shared primitives; marketplace‑first consumer journey + owner creation flow. |
| **Stage 1** | Wire the new design to the **existing** backend only — no new backend/DB/API. | `/revenue` renders the real experience: marketplace ← real active coupons; public→personal ← real QR/token; "צור קופון" → real createOffer + issue. Legacy routes redirect to `/revenue`. |
| **Stage 2** | Close data/display gaps that **don't** change the model (categories, address, phone/WhatsApp, search, list expansion). | Exposed existing `BusinessProfile` fields in public DTOs; functional search + category filters; list limit 6→24. No schema. |
| **Stage 3 — C4** | Popularity + "ending soon" using existing data. | "הכי מבוקשים" (derived redemption count per business) + "מסתיימים בקרוב" (by `expiresAt`). No schema. |
| **Stage 3 — C1+C2** | Basic location + hours as expand‑only. | Added `city`, `latitude`, `longitude`, `openingHours` to `BusinessProfile` (nullable). Displayed only when real. |
| **Stage 3 — C3** | Distance / near‑you / city filter on the new infra. | Server‑side Haversine from an opt‑in `near` point; city filter on real `city`; "קרוב אליך" row gated on real data. No schema. |
| **Stage 3 — C5** | Quota / remaining / "אזל". | **Deferred** — ruling in [`coupon-c5-quota-semantics-decision-v1.md`](./coupon-c5-quota-semantics-decision-v1.md) §0. |

---

## 2. Screens actually connected (live at `/revenue`)

| Screen | Data source | Status |
|---|---|---|
| **Marketplace** | `GET /api/revenue/coupons/active?limit=24` | ✅ real cross‑business list; search, category + city filters, opt‑in "קרוב אליי", "הכי מבוקשים" + "מסתיימים בקרוב" rows |
| **Public coupon** | active list item (+ status via `[id]`) | ✅ real business name/city/address/hours/WhatsApp — each shown only when present |
| **Personal coupon** | `GET /api/revenue/coupons/[id]/code` | ✅ real QR (`qrValue`) + backup token |
| **Creation flow** | `POST /api/offers` → `POST /api/offers/[id]/coupon` | ✅ goal → direction (3→6, UI‑only) → builder → terms → published; real publish, new coupon reappears in marketplace |
| **Legacy redirects** | `/offers/create`, `/promotions`, `/promotions/coupons`, `/revenue/issue` | ✅ server‑redirect → `/revenue` |

**Design‑only (not the live product):** `/coupon-design` gallery, `MarketplaceGrid`, `MarketingCenter`/`CouponWorld` components — render demo data for design review.

---

## 3. APIs connected or extended

| Endpoint | Change |
|---|---|
| `GET /api/revenue/coupons/active` | **Extended:** profile fields in DTO (category/sub/model, **city**, **openingHours**, billingAddress→address, billingPhone→phone); limit clamp **6→24**; derived **`redemptionCount`** (`RedemptionEvent.groupBy`); optional **`?lat=&lng=`** → **`distanceKm`/`distanceLabel`** (server‑side Haversine). Raw lat/long **never** returned. |
| `GET /api/revenue/coupons/[id]` | **Extended DTO:** business `city`, `address`, `phone`, `category`, `openingHours`. |
| `GET /api/revenue/coupons/[id]/code` | **Used as‑is** — token + qrValue. |
| `POST /api/offers` | **Used as‑is** — publish (the composed benefit sentence). |
| `POST /api/offers/[id]/coupon` | **Used as‑is** — issue a coupon = "published". |
| `POST /api/offers/image` | **Unchanged / not wired** into the new create flow (text benefit only for now). |

All changes are **additive** — no removed fields, no changed semantics, no removed constraints.

---

## 4. Fields added

**Schema (migration) — `BusinessProfile`, all nullable/additive:**
- `city TEXT`
- `latitude DOUBLE PRECISION` — **stored‑only, never exposed in any DTO**
- `longitude DOUBLE PRECISION` — **stored‑only, never exposed**
- `openingHours TEXT`

**DTO‑level derived (NOT schema):** `redemptionCount`, `distanceKm`, `distanceLabel`.

---

## 5. Migrations

| Migration | Content | Applied |
|---|---|---|
| `prisma/migrations/20260707120000_add_business_location_hours` | 4× `ALTER TABLE "BusinessProfile" ADD COLUMN` (nullable) | **DEV:** applied via `prisma db execute` (dev `_prisma_migrations` history is out of sync — `migrate deploy` was **not** used there). **PROD:** pending, via gated `release-migrate` workflow. |

Expand‑only, backward‑compatible. Feature works with **all four columns NULL** (verified).

---

## 6. What remains demo / future

- **`/coupon-design` gallery** — demo data (`ROW_NEAR`/`ROW_POPULAR`/`ROW_SOON`, `MY_ACTIVE`/`MY_ENDED`). Internal design showcase, not product.
- **"קרוב אליך" row & distance chips** — real, but appear only when a business has geo **and** the user opts into location. Hidden until real data exists.
- **City filter** — real, but chips render only for cities present in the data.
- **`remaining` / "נותרו X מתוך N" / "אזל" / qty bar / sold‑out** — exist only in demo model data; **not** surfaced as a working product (deferred, see §7).
- **Offer image** in the create flow — API exists, not wired.

---

## 7. Explicitly deferred

- **C5 — quota / remaining / "אזל" / limited issuance.** Ruling: enters **only** with the **per‑user issuance generation** (Claim/issuance + holder identity + personal coupon + issuance limit + per‑holder double‑redemption prevention). Owner kept `RedemptionEvent.couponId @unique`. See C5 decision §0.
- **Consumer identity / auth, per‑user claim** — Stage 4.
- **City‑centroid distance / aggressive geolocation** — not built by design.

---

## 8. What must NOT change right now

- **`RedemptionEvent.couponId @unique`** — the anchor "one coupon = one redemption". Do not relax.
- **No real `remaining` / sold‑out / "אזל"** as a working product.
- **Never expose `latitude`/`longitude`** in any public DTO.
- **Offer/Coupon immutability & numbering** — per Billing compliance discipline; issuing must not mutate issued records.
- **Migrations expand‑only**; production DDL **only** via gated `release-migrate` with `DIRECT_URL`.

---

## 9. tsc / build status

- **tsc:** ✅ `npx tsc --noEmit` → **0 errors** (whole project).
- **Production build:** _(pending — filled below on completion)_

---

## 10. Tests performed (server smokes, dev DB)

- `GET /api/revenue/coupons/active` → **200 JSON**; returned a real persisted coupon ("Test Business · 20% הנחה על כל העסק") — proves create→persist loop.
- **C4:** response carries derived `redemptionCount`.
- **C1+C2:** seeded `city`/`openingHours` → surfaced in DTO → reverted to NULL.
- **C3:** with `?lat&lng` → `distanceKm`/`distanceLabel` present; **leak check** for `latitude|longitude` in raw body = **false**; `businessKeys` = `[city,id,name,openingHours]`; **without** near → no distance; **invalid** near (`999,999`) → sanitized → no distance.
- Control: `GET /api/offers` → **401** (auth guard); legacy routes → **307** redirects.
- All seeds reverted to NULL — **no fake data left** in the DB.

---

## 11. Before PR / merge / deploy — checklist

1. **Isolate the branch.** Coupon work is uncommitted on `feat/accessibility-fab-and-turquoise-cta`, mixed with unrelated work. Move it to a dedicated coupon branch and commit with a clear scope before opening a PR.
2. **Migration before code (prod).** Deploy order is **migrate → then deploy code**: apply `20260707120000` via the gated `release-migrate` workflow **first** (the active/details services now `select` the new columns; deploying code first would 500 on column‑not‑found). Expand‑only, so this ordering is safe.
3. **Verify prod migration state.** Confirm the production `_prisma_migrations` history is clean so `migrate deploy` applies **only** `20260707120000` (the dev history was out of sync — do not assume prod matches dev).
4. **Green production build** — see §9.
5. **Decide on `/coupon-design`** — internal design gallery. Harmless but internal; confirm it's acceptable to ship or gate it.
6. **No secrets / no destructive ops** in the diff.
7. **Sanity:** feature renders with all new columns NULL (verified) — no business needs to fill city/geo/hours for the marketplace to work.

---

**Bottom line:** Stages 1–3 are functionally complete and additive; tsc clean; the only model change is one expand‑only nullable migration; C5 is deferred by ruling. Remaining work before release is **packaging** (branch isolation, migration ordering, build verification) — **not** feature work.
