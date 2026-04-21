export type ContentAction = {
  id: string
  label: string
  type: "open_app" | "share" | "download"
  payload?: any
}

type Content = {
  hook?: string
  idea?: string
  structure?: string[]
  script?: string
  shots?: string[]
  instructions?: string[]
}

export function resolveActions(content: Content, mode: "ai" | "director"): ContentAction[] {
  const actions: ContentAction[] = []

  const safeStructure = Array.isArray(content.structure)
    ? content.structure
    : []

  const fullText = [
    content.hook,
    ...safeStructure,
    content.script
  ]
    .filter(Boolean)
    .join("\n\n")

  const isReel = !!content.script
  const isPost = safeStructure.length > 0

  // 🎯 INSTAGRAM
  actions.push({
    id: "open_instagram",
    label: isReel
      ? "פתח אינסטגרם ליצירת רילס"
      : "פתח אינסטגרם לפוסט",
    type: "open_app",
    payload: isReel ? "instagram://camera" : "instagram://"
  })

  // 🎯 FACEBOOK
  actions.push({
    id: "share_facebook",
    label: "פרסם בפייסבוק",
    type: "open_app",
    payload: "fb://"
  })

  // 🎯 TIKTOK
  actions.push({
    id: "share_tiktok",
    label: "פרסם בטיקטוק",
    type: "open_app",
    payload: "tiktok://"
  })

  // 🎯 WHATSAPP
  if (fullText) {
    actions.push({
      id: "share_whatsapp",
      label: "שלח לעצמי בוואטסאפ",
      type: "share",
      payload: fullText
    })
  }

  // 🎯 DOWNLOAD
  if (fullText) {
    actions.push({
      id: "download_content",
      label: "הורד תוכן",
      type: "download",
      payload: fullText
    })
  }

  return actions
}