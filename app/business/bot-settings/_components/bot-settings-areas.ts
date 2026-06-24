export const ACTIVE_BOT_SETTINGS_AREAS = [
  "goal",
  "personality",
  "voice",
  "conversation",
  "approach",
  "knowledge",
  "memory",
  "autonomy",
  "allowed",
  "forbidden",
  "handoff",
  "learning",
] as const;

// Stage 1: personality + approach moved to real persistence (BusinessBotProfile).
// Only memory + learning remain backend-less placeholders.
export const PLACEHOLDER_BOT_SETTINGS_AREAS = ["memory", "learning"] as const;

export type BotSettingsArea = (typeof ACTIVE_BOT_SETTINGS_AREAS)[number];
export type PlaceholderBotSettingsArea =
  (typeof PLACEHOLDER_BOT_SETTINGS_AREAS)[number];
