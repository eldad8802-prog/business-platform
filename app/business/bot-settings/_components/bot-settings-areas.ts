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

// All 12 builder areas now have real backends (Stages 1–8). No placeholders left.
export const PLACEHOLDER_BOT_SETTINGS_AREAS = [] as const;

export type BotSettingsArea = (typeof ACTIVE_BOT_SETTINGS_AREAS)[number];
export type PlaceholderBotSettingsArea =
  (typeof PLACEHOLDER_BOT_SETTINGS_AREAS)[number];
