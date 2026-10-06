# WhatsApp Embedded Signup v4 — switch runbook

Status: **DRAFT, owner-gated.** This PR changes only the browser launch options of "Connect WhatsApp".
It is safe to merge only **together with** a v4 configuration id in Production (see "Order" below).

## Why

Meta: "Embedded Signup v2 and v3 will be deprecated on **October 15, 2026**, including their public
preview versions. Migrate your integration to v4 before that date to avoid disruption."

- v4 is selected by the **Facebook Login for Business configuration**. Meta: "create a new Facebook Login
  for Business Configuration, and select your desired products. Selecting the products will
  automatically set you to v4."
- In v4, `extras` names no `version`, and session info is "sent back for all flows". `sessionInfoVersion`
  is a v2 requirement ("Partners are required to add a sessionInfoVersion to receive the callback").
- Coexistence (onboarding a WhatsApp Business app number) stays on `featureType:
  "whatsapp_business_app_onboarding"`. v4 lists it as a supported feature type.

Sources:
- https://developers.facebook.com/docs/whatsapp/embedded-signup/versions/
- https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/version-4
- https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/

## What changes

| | Before | After (this PR) |
|---|---|---|
| `FB.login` extras | `{ setup: {}, featureType: "whatsapp_business_app_onboarding", sessionInfoVersion: "3" }` | `{ setup: {}, featureType: "whatsapp_business_app_onboarding" }` |
| Configuration | `NEXT_PUBLIC_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID` = current configuration | the **new v4** configuration id (owner sets it; not in this PR) |
| Server completion (code exchange → number → subscribe → store) | unchanged | unchanged |
| Existing connections | — | untouched. They use their stored token and webhook subscription, not Embedded Signup |

## Order (the coupling)

`NEXT_PUBLIC_*` values are compiled into the browser bundle at build time. Without `sessionInfoVersion`,
a v2 configuration may not return the session info, and the attempt would end as `missing_ids`.
The new id and this code must therefore go live **in the same Production build**:

1. The owner creates the v4 configuration in Meta and sends the public id. This is an owner action in Meta.
2. Review this PR against that configuration (products, token type and expiration, permissions).
3. Run the **before** snapshot: `prod-readonly-evidence` with `ops/evidence/whatsapp-es-v4-switch-evidence.sql`.
4. With owner approval, set the Production value of `NEXT_PUBLIC_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID` to
   the v4 id, then merge this PR. The merge build is the first build that carries both.
5. Verify the Production bundle carries the new id and no `sessionInfoVersion`.
6. **Launch test with no write:** on a business with no WhatsApp connection, the owner opens Connect, sees
   the v4 screens and cancels before the end. Dubiz ends the attempt as `cancelled`, and nothing is stored.
7. Run the **after** snapshot. S1/S2 must be identical to the before snapshot. S3 keeps advancing when
   there is traffic.
8. Full proof (owner-approved, a real Production connection): connect the owner's own business end to
   end. This proves the code exchange, the number lookup, the subscription and the stored connection
   under v4.

## Rollback (until 2026-10-15)

Restore the previous configuration id and revert this PR, in one build. Keep the old configuration in
Meta until the v4 proof (step 8) passes.

## Known v4 difference

v4 lets a user finish "with a verified, unverified, or no phone number". A finish without a number keeps
ending as `no_phone_number`, as before. That is acceptable for now.
