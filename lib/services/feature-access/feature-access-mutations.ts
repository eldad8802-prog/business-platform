const ENV_NAME = "FEATURE_ACCESS_MUTATIONS_ENABLED";

export function isFeatureAccessMutationsEnabled(): boolean {
  return process.env[ENV_NAME] === "true";
}
