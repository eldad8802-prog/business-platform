# WhatsApp Embedded Signup v4 — switch runbook

Status: **DRAFT. Blocked externally** on Meta approvals (Business Verification and App Review are in
review; Access Verification has not started). This PR changes only the browser launch options of
"Connect WhatsApp". The Production switch is not approved.

## Why

Meta: "Embedded Signup v2 and v3 will be deprecated on **October 15, 2026**, including their public
preview versions. Migrate your integration to v4 before that date to avoid disruption."

## Authority for the launch code

The strongest evidence of Meta's current behaviour is **Meta's own Embedded Signup Builder** (App
Dashboard → WhatsApp → Embedded Signup Builder). For the existing configuration `1955709398385145`, with
**ES Version = v4** and **Feature Type = WhatsApp Business App Onboarding**, it generates:

```js
FB.login(fbLoginCallback, {
  config_id: '1955709398385145',
  response_type: 'code',
  override_default_response_type: true,
  extras: {
    "version": "v4",
    "featureType": "whatsapp_business_app_onboarding"
  }
});
```

This PR's launch options are identical to that. The test asserts the exact `extras` object.

**The documentation is inconsistent, and it is recorded rather than resolved here:**
- The Versions page says "The Embedded Signup version is determined inside of the extras object" and
  shows `version` in extras for the earlier versions.
- The same page and the Version 4 page say v4 needs "a new Facebook Login for Business Configuration
  … Selecting the products will automatically set you to v4" and "The extras object is purposely empty
  for v4".
- The Builder's output (above) is what Meta's tooling emits today. It is the basis for this PR.
- Whether the existing configuration (no Products section) is fully supported for v4 in Production
  is **UNRESOLVED**. Creating a new configuration with Products is not available to us yet. Meta
  states that v4 products need advanced access for their permissions ("You will need advanced access
  for all permissions automatically selected"), which is pending App Review.

Sources:
- https://developers.facebook.com/docs/whatsapp/embedded-signup/versions/
- https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/version-4
- https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview/

## What changes

| | Before | After (this PR) |
|---|---|---|
| `FB.login` extras | `{ setup: {}, featureType: "whatsapp_business_app_onboarding", sessionInfoVersion: "3" }` | `{ version: "v4", featureType: "whatsapp_business_app_onboarding" }` |
| Configuration | `NEXT_PUBLIC_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID` = existing configuration | unchanged (the same existing configuration) |
| Server completion (code exchange → number → subscribe → store) | unchanged | unchanged |
| Existing connections | — | untouched. They use their stored token and webhook subscription, not Embedded Signup |

`setup: {}` (pre-filled data, which we send empty) is dropped to match the Builder exactly.

## Switch (only after it is approved)

1. **Before snapshot:** `prod-readonly-evidence` with `ops/evidence/whatsapp-es-v4-switch-evidence.sql`.
2. With owner approval, merge this PR. No environment change is needed, because the configuration id
   stays the same.
3. Verify the Production bundle launches with `version: "v4"` and no `sessionInfoVersion`.
4. **Launch test with no write:** on a business with no WhatsApp connection, the owner opens Connect,
   sees the v4 screens and cancels before the end. Dubiz ends the attempt as `cancelled`, and nothing
   is stored.
5. **After snapshot:** S1/S2 must be identical to the before snapshot. S3 keeps advancing when there is
   traffic.
6. Full proof (owner-approved, a real Production connection): connect the owner's own business end to
   end. Note Meta's rule: in Live mode, businesses without a role on the app can only be onboarded
   after App Review grants advanced access.

## Rollback

Revert this PR, or promote the previous Production deployment in Vercel. Nothing else changes, so
nothing else is reverted.

## Known v4 difference

v4 lets a user finish "with a verified, unverified, or no phone number". A finish without a number keeps
ending as `no_phone_number`, as before. That is acceptable for now.
