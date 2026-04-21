export async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    alert("הועתק ללוח!")
  } catch (err) {
    console.error("Copy failed", err)
  }
}

export function openInstagram(url?: string) {
  window.location.href = url || "instagram://app"
}

export function shareToWhatsApp(text: string) {
  const url = `https://wa.me/?text=${encodeURIComponent(text)}`
  window.open(url, "_blank")
}

export function openExternalApp(url: string) {
  window.location.href = url
}

export function downloadText(text: string) {
  const blob = new Blob([text], { type: "text/plain" })
  const url = URL.createObjectURL(blob)

  const a = document.createElement("a")
  a.href = url
  a.download = "content.txt"
  a.click()

  URL.revokeObjectURL(url)
}