-- Subscriptions stage C — rollback of 20261228090000_subscriptions_stage_c. Drops exactly what the migration created
-- (seven tables, their policies and grants, fourteen functions) and the admin read policies it added to the two stage B
-- tables. Additive migration: nothing outside it depends on these objects; the stage C code treats a missing table or
-- function as "measure nothing, refuse nothing" (logged). Run in one transaction as the migration owner; then delete the
-- ledger row 20261228090000_subscriptions_stage_c.
\set ON_ERROR_STOP 1
DROP FUNCTION public.trial_claim_admin_record(integer, integer, text, text, integer, text);
DROP FUNCTION public.subscription_request_resolve(integer, bigint, text, text);
DROP FUNCTION public.quota_adjustment_revoke(integer, bigint, text);
DROP FUNCTION public.quota_adjustment_add(integer, integer, text, text, bigint, timestamp, text);
DROP FUNCTION public.quota_policy_set(integer, text, text, bigint, text);
DROP FUNCTION public.subscriptions_require_platform_admin(integer);
DROP FUNCTION public.usage_mark_alert(text, text, integer);
DROP FUNCTION public.usage_settle(text, text, text);
DROP FUNCTION public.usage_consume(text, text, bigint, text, boolean, boolean);
DROP FUNCTION public.usage_quota_snapshot(text);
DROP FUNCTION public.usage_quota_context(integer, text);
DROP FUNCTION public.subscription_expire_due_trials(integer);
DROP FUNCTION public.subscription_signup_open(integer, jsonb, integer, integer, text);
DROP TABLE "BusinessUsageEvent";
DROP TABLE "BusinessUsageCounter";
DROP TABLE "BusinessQuotaAdjustment";
DROP TABLE "PlatformQuotaPolicyEvent";
DROP TABLE "PlatformQuotaPolicy";
DROP TABLE "PlatformSubscriptionRequest";
DROP TABLE "PlatformTrialClaim";
DROP FUNCTION public.subscriptions_stage_c_append_only();
DROP POLICY p7adm_read ON "PlatformSubscription";
DROP POLICY p7adm_read ON "PlatformSubscriptionEvent";
REVOKE SELECT ON "PlatformSubscription", "PlatformSubscriptionEvent" FROM app_admin;
SELECT 'ROLLBACK_OK' AS result;
