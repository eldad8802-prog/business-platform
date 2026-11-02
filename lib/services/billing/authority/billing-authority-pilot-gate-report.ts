/**
 * Production pilot gate SELF-CHECK (platform-admin, read-only).
 *
 * Answers "with THIS deployment's env, what would the ITA production pilot
 * allow for business B and user U?" — without any call to ITA, any DB access,
 * or any token. Every answer is computed by the SAME exported gate functions
 * the call sites use (billing-authority-production-pilot.ts), including the
 * egress scope check for each scope kind, so it cannot drift from the real
 * enforcement.
 *
 * Never returns raw env values: lists are reported as status + count, the
 * stage switch as stage + value classification, the runtime selector as its
 * NAME + parsed value.
 */

import type { BillingAuthorityEnvironment } from "@prisma/client";
import {
  AUTHORITY_PRODUCTION_PILOT_ENV_VAR,
  AUTHORITY_PRODUCTION_PILOT_NOT_ENABLED,
  AUTHORITY_PRODUCTION_PILOT_OPERATIONS_ENV_VAR,
  AUTHORITY_PRODUCTION_PILOT_USER_ENV_VAR,
  isAuthorityProductionAllowedForActor,
  parseAuthorityProductionPilotOperations,
  parseProductionPilotIdList,
  resolveAuthorityPilotScopeRefusal,
  resolveAuthorityProductionOperationRefusal,
  type AuthorityPilotListStatus,
  type AuthorityPilotOperationsValueStatus,
  type AuthorityProductionPilotRefusalCode,
  type AuthorityProductionPilotStage,
} from "@/lib/services/billing/authority/billing-authority-production-pilot";

type EnvSource = Readonly<Record<string, string | undefined>>;

export const AUTHORITY_RUNTIME_ENVIRONMENT_ENV_VAR = "BILLING_AUTHORITY_RUNTIME_ENVIRONMENT" as const;

export type AuthorityPilotGateOperation =
  | "oauthStart"
  | "oauthCodeExchange"
  | "refresh"
  | "validation"
  | "approval"
  | "decision"
  | "probe";

export type AuthorityPilotGateDecision =
  | { status: "allowed" }
  | { status: "refused"; reason: AuthorityProductionPilotRefusalCode };

export type AuthorityPilotGateReport = {
  /** The report is always about PRODUCTION (SANDBOX is never gated). */
  environment: "PRODUCTION";
  runtimeEnvironment: {
    name: typeof AUTHORITY_RUNTIME_ENVIRONMENT_ENV_VAR;
    status: "unset" | "ok" | "invalid";
    value: BillingAuthorityEnvironment | null;
  };
  businessId: number;
  userId: number;
  businessAdmitted: boolean;
  userAdmitted: boolean;
  lists: {
    business: { name: typeof AUTHORITY_PRODUCTION_PILOT_ENV_VAR; status: AuthorityPilotListStatus; count: number };
    user: { name: typeof AUTHORITY_PRODUCTION_PILOT_USER_ENV_VAR; status: AuthorityPilotListStatus; count: number };
  };
  stage: {
    name: typeof AUTHORITY_PRODUCTION_PILOT_OPERATIONS_ENV_VAR;
    stage: AuthorityProductionPilotStage;
    valueStatus: AuthorityPilotOperationsValueStatus;
  };
  operations: Record<AuthorityPilotGateOperation, AuthorityPilotGateDecision>;
};

function decision(refusal: AuthorityProductionPilotRefusalCode | null): AuthorityPilotGateDecision {
  return refusal ? { status: "refused", reason: refusal } : { status: "allowed" };
}

function parseRuntimeEnvironment(raw: string | undefined): AuthorityPilotGateReport["runtimeEnvironment"] {
  const normalized = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  if (normalized === "") return { name: AUTHORITY_RUNTIME_ENVIRONMENT_ENV_VAR, status: "unset", value: null };
  if (normalized === "SANDBOX" || normalized === "PRODUCTION") {
    return { name: AUTHORITY_RUNTIME_ENVIRONMENT_ENV_VAR, status: "ok", value: normalized };
  }
  return { name: AUTHORITY_RUNTIME_ENVIRONMENT_ENV_VAR, status: "invalid", value: null };
}

export function buildAuthorityPilotGateReport(
  input: { businessId: number; userId: number },
  env: EnvSource = process.env
): AuthorityPilotGateReport {
  const PRODUCTION = "PRODUCTION" as BillingAuthorityEnvironment;
  const { businessId, userId } = input;

  const businessList = parseProductionPilotIdList(env[AUTHORITY_PRODUCTION_PILOT_ENV_VAR]);
  const userList = parseProductionPilotIdList(env[AUTHORITY_PRODUCTION_PILOT_USER_ENV_VAR]);
  const operations = parseAuthorityProductionPilotOperations(env[AUTHORITY_PRODUCTION_PILOT_OPERATIONS_ENV_VAR]);

  // OAuth start: the route's actor gate (business AND user — lists only).
  const actorRefusal = isAuthorityProductionAllowedForActor(businessId, userId, PRODUCTION, env)
    ? null
    : AUTHORITY_PRODUCTION_PILOT_NOT_ENABLED;
  // Code exchange: the callback's actor gate, then the egress "business-oauth" scope.
  const exchangeRefusal =
    actorRefusal ??
    resolveAuthorityPilotScopeRefusal({ kind: "business-oauth", businessId }, PRODUCTION, env);
  // Refresh / validation / Approval / Decision: the service gate, then the egress
  // "business" scope (the same function underneath; both must allow).
  const businessOpRefusal =
    resolveAuthorityProductionOperationRefusal(businessId, PRODUCTION, env) ??
    resolveAuthorityPilotScopeRefusal({ kind: "business", businessId }, PRODUCTION, env);
  // Probe: egress "platform-diagnostic" scope only.
  const probeRefusal = resolveAuthorityPilotScopeRefusal({ kind: "platform-diagnostic" }, PRODUCTION, env);

  return {
    environment: "PRODUCTION",
    runtimeEnvironment: parseRuntimeEnvironment(env[AUTHORITY_RUNTIME_ENVIRONMENT_ENV_VAR]),
    businessId,
    userId,
    businessAdmitted: businessList.ids.has(businessId),
    userAdmitted: userList.ids.has(userId),
    lists: {
      business: { name: AUTHORITY_PRODUCTION_PILOT_ENV_VAR, status: businessList.status, count: businessList.ids.size },
      user: { name: AUTHORITY_PRODUCTION_PILOT_USER_ENV_VAR, status: userList.status, count: userList.ids.size },
    },
    stage: {
      name: AUTHORITY_PRODUCTION_PILOT_OPERATIONS_ENV_VAR,
      stage: operations.stage,
      valueStatus: operations.valueStatus,
    },
    operations: {
      oauthStart: decision(actorRefusal),
      oauthCodeExchange: decision(exchangeRefusal),
      refresh: decision(businessOpRefusal),
      validation: decision(businessOpRefusal),
      approval: decision(businessOpRefusal),
      decision: decision(businessOpRefusal),
      probe: decision(probeRefusal),
    },
  };
}
