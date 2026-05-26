import type { ContentFlowSnapshot } from "../../types";

export function stockOrientationForFlow(
  flow: ContentFlowSnapshot
): "portrait" | "landscape" | "square" {
  if (flow.selectedPlatform === "facebook") {
    return "square";
  }
  if (flow.selectedFormat === "video") {
    return "landscape";
  }
  return "portrait";
}
