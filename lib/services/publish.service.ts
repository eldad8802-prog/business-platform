import { copyToClipboard } from "@/lib/actions/content-actions"

type Content = {
  hook?: string
  structure?: string[]
  script?: string
}

export function buildPostText(content: Content) {
  const safeStructure = Array.isArray(content.structure)
    ? content.structure
    : []

  return [
    content.hook,
    ...safeStructure,
    content.script
  ]
    .filter(Boolean)
    .join("\n\n")
}

export function handleInstagramPublish(content: Content, mediaCount: number) {
  const text = buildPostText(content)

  if (!mediaCount) {
    alert("כדאי להעלות תמונה או וידאו לפני פרסום 🙌")
    return
  }

  // 📋 מעתיק טקסט
  copyToClipboard(text)

  // 🚀 פותח אינסטגרם
  window.location.href = "instagram://camera"
}