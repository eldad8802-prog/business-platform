import type { TemperatureBucket } from "./inbox-item.types";

const HOT_THRESHOLD = 0.7;
const WARM_THRESHOLD = 0.4;

/**
 * Bucket a 0..1 temperature score into a coarse band for UI display.
 *
 * Conservative defaults: when the score is missing or NaN we fall back to
 * "cold" so an empty conversation never appears artificially hot.
 */
export function bucketTemperature(
  score: number | null | undefined
): TemperatureBucket {
  if (score === null || score === undefined || Number.isNaN(score)) {
    return "cold";
  }
  if (score >= HOT_THRESHOLD) return "hot";
  if (score >= WARM_THRESHOLD) return "warm";
  return "cold";
}

export function temperatureLabel(bucket: TemperatureBucket): string {
  if (bucket === "hot") return "חם";
  if (bucket === "warm") return "מתחמם";
  return "קריר";
}
