# Revenue Surface Classification Contract v1

**Status:** Binding for all Revenue adaptive work (R0 output, owner-approved).
**Established:** 2026-08-31, R0/R1.

Every Revenue surface carries exactly one classification, and that classification —
not its URL — decides its chrome, its width authority and whether a phone frame is
appropriate. This is the contract R2 and everything after it must satisfy.

---

## The four classes

| Class | Meaning |
|---|---|
| **MANAGEMENT** | The business owner is working. Authenticated. |
| **CONSUMER** | The customer sees or uses it. Public. |
| **PREVIEW** | A simulation *hosting the real consumer components*, shown inside the product. |
| **SHARED** | A component consumed by more than one class. |

## Current assignment

| Surface | Class | ShellChrome | Width authority | Phone frame |
|---|---|---|---|---|
| `/revenue?view=mine` | MANAGEMENT | from `LAYOUT.bp.expanded` (1024) | `LAYOUT.width.content` | none |
| `/revenue?view=create` | MANAGEMENT | from 1024 | `LAYOUT.width.focused` | none |
| `/revenue/redeem` | MANAGEMENT | from 1024 | its own focused column | none |
| `/revenue?view=browse` | CONSUMER | **never** | the screen frame | `mode="screen"` (480) |
| `/revenue/coupons/[id]` | CONSUMER | **never** | its own | none |
| `/coupon-design` | PREVIEW | unchanged (inside the shell) | shell content width | `mode="device"` (390 mock) |
| `CouponCreationFlow`, `PublicCouponContent` | SHARED | n/a | n/a | inherits its host |

## Rules

1. **Chrome follows class, not path.** `/revenue/coupons/[id]` shares the `/revenue`
   prefix and therefore the Revenue layout, and still declares
   `useHideShellChrome(true)` — a customer holding a coupon is never handed the
   business's navigation. Below 1024 no Revenue surface shows chrome, so the
   existing mobile management experience is unchanged.

2. **A phone frame describes a phone, never a canvas.** `PhoneFrame` has three
   modes and the choice is a classification statement:
   - `device` (390, rounded, shadow) — PREVIEW of a phone experience.
   - `screen` (480, square, full height) — a CONSUMER experience that genuinely is
     phone-shaped.
   - `app` (no cap) — a real application surface whose width belongs to the layout
     system. **MANAGEMENT surfaces use this and no other.**

   A management surface must never inherit a phone cap from an ancestor.

3. **Management width comes from `LAYOUT`, through `PageContainer`.** Not from a
   local literal, and not from the phone metaphor.

4. **The preview hosts the real components.** `CouponWorld` mounts the production
   `CouponCreationFlow` and `PublicCouponContent`. A second implementation of a
   consumer surface must never be created for preview purposes; the preview is a
   host, and the consumer/creation components are the authority.

5. **`publicId` is public; `token`/`qrValue` are not.** The redemption secret is
   served only by the issuer-only `/code` route and must never be rendered on a
   surface reachable without the issuer session. No composition may co-locate a
   coupon's identity with its code merely because a wider viewport has room.

6. **The kill switch is an action, not information.** It currently lives on the
   management list. Any split of that list must leave it on a surface that reads as
   actionable.

## What this contract does not decide

The desktop management composition (R2). This contract exists so that R2 can be
designed against a stated separation instead of rediscovering it.
