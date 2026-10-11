/**
 * The closed-beta cohort's identity, shared by the signup that enrolls a business
 * (lib/auth/signup.ts) and the policy that reads the enrollment (./beta-access-policy.ts).
 * Dependency-free on purpose: the signup plane imports it without the tenant plane.
 */

/** The cohort label every closed-beta signup is enrolled under (CHECK: lowercase, 2–40 chars). */
export const CLOSED_BETA_COHORT = "closed-beta";

/** The one enrollment source today (CHECK, and the only source app_auth may insert). */
export const CLOSED_BETA_SIGNUP_SOURCE = "CLOSED_BETA_SIGNUP";
