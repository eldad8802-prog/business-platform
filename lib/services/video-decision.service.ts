type VideoType = "SHORT" | "MID" | "FULL"

type VideoDecisionInput = {
  goal?: string
  audienceTypes?: string[]
  contentAngle?: string
  contentGoalPrompt?: string
}

type VideoDecision = {
  videoType: VideoType
  duration: number
  structure: string[]
  reasoning: string
}

function includesAny(text: string, keywords: string[]) {
  return keywords.some((k) => text.includes(k))
}

export function decideVideoType(input: VideoDecisionInput): VideoDecision {
  const text = `${input.goal ?? ""} ${input.contentAngle ?? ""} ${input.contentGoalPrompt ?? ""}`.toLowerCase()

  // 🧠 זיהוי FULL (בעיה + שכנוע)
  if (
    includesAny(text, [
      "בעיה",
      "לא מצליח",
      "קשה",
      "למה",
      "טעויות",
      "לא עובד",
      "לא מביא",
      "לקוחות לא מגיעים",
    ])
  ) {
    return {
      videoType: "FULL",
      duration: 40,
      structure: ["hook", "pain", "explanation", "solution", "proof", "cta"],
      reasoning: "Detected pain/problem → requires full persuasive flow",
    }
  }

  // 🧠 זיהוי MID (הסבר / איך לעשות)
  if (
    includesAny(text, [
      "איך",
      "שלבים",
      "טיפים",
      "הסבר",
      "מה לעשות",
      "דרך",
    ])
  ) {
    return {
      videoType: "MID",
      duration: 25,
      structure: ["hook", "context", "solution", "cta"],
      reasoning: "Detected instructional content → mid length",
    }
  }

  // 🧠 ברירת מחדל = SHORT
  return {
    videoType: "SHORT",
    duration: 15,
    structure: ["hook", "value", "cta"],
    reasoning: "Simple idea → short format",
  }
}