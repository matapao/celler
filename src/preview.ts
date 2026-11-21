import type { ApprovalState, RunStatus, Write } from "./store.js"

// What a reviewer could not see: controls, format characters (bidi, zero-width, tag), private-use, unassigned and
// surrogate code points, and every separator but the plain space. Tab, newline and carriage return stay.
const HIDDEN = /(?![\t\n\r ])[\p{C}\p{Z}]/gu
const HIDDEN_IN_NAME = /(?! )[\p{C}\p{Z}]/gu
// A long run of spaces after text can push the rest of a line out of view.
const LONG_SPACES = /(?<=\S) {16,}/g
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

const activeUrls = new WeakMap<HTMLElement, string[]>()

function escapeChar(ch: string): string {
  const code = ch.codePointAt(0)!
  return code > 0xffff ? `\\u{${code.toString(16)}}` : "\\u" + code.toString(16).padStart(4, "0")
}

/** Text with nothing left to hide: hidden characters escaped and long space runs counted out. */
function reveal(text: string) {
  let marked = 0
  const shown = text
    .replace(HIDDEN, ch => (marked++, escapeChar(ch)))
    .replace(LONG_SPACES, run => (marked++, `⟨${run.length} spaces⟩`))
  return { shown, marked }
}

function sanitizeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? ""
  const cleaned = base.replace(HIDDEN_IN_NAME, "_").replace(/^\.+/, "").trim()
  return cleaned.slice(0, 255) || "attachment"
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  if (!BASE64.test(value)) throw new Error("Invalid base64 attachment payload")
  const binary = atob(value)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function revokeElementUrls(element: HTMLElement) {
  const urls = activeUrls.get(element)
  if (!urls) return
  for (const url of urls) URL.revokeObjectURL(url)
  activeUrls.delete(element)
}

export function showWrite(element: HTMLElement, write: Write) {
  revokeElementUrls(element)
  const { files, ...details } = write
  const { shown, marked } = reveal(JSON.stringify(details, null, 2))
  const text = document.createElement("pre")
  // Wrap instead of scrolling, so no part of a line sits out of view.
  text.style.whiteSpace = "pre-wrap"
  text.style.overflowWrap = "anywhere"
  text.textContent = marked
    ? `⚠ ${marked} hidden or invisible sequence${marked === 1 ? "" : "s"} marked below.\n\n${shown}`
    : shown
  element.replaceChildren(text)

  const createdUrls: string[] = []
  for (const file of files) {
    const bytes = decodeBase64(file.base64)
    const safeName = sanitizeFilename(file.name)
    const link = document.createElement("a")
    link.textContent = `${safeName} (${reveal(file.mediaType).shown}, ${formatBytes(bytes.byteLength)})`
    link.download = safeName
    link.rel = "noopener noreferrer"
    // octet-stream, not the packet's own media type: a blob of HTML would run in this page's origin.
    if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }))
      createdUrls.push(url)
      link.href = url
    } else {
      link.href = "data:application/octet-stream;base64," + file.base64
    }
    const line = document.createElement("p")
    line.append(link)
    element.append(line)
  }
  if (createdUrls.length) activeUrls.set(element, createdUrls)
}

export function showApproval(
  element: HTMLElement,
  item: { id: string; state: ApprovalState; tool?: string; runStatus?: RunStatus; write: Write },
  decide: (id: string, decision: "approve" | "decline") => Promise<void>,
) {
  showWrite(element, item.write)
  const status = document.createElement("p")
  const parts = [item.tool ? `tool: ${reveal(item.tool).shown}` : "", `state: ${item.state}`]
  if (item.runStatus && item.runStatus !== "running") parts.push(`run: ${item.runStatus}`)
  status.textContent = parts.filter(Boolean).join(" | ")
  element.append(status)

  if (item.state !== "pending" || item.runStatus === "cancelled") return
  const controls = document.createElement("fieldset")
  for (const choice of ["approve", "decline"] as const) {
    const button = document.createElement("button")
    button.type = "button"
    button.textContent = choice
    button.onclick = async () => {
      controls.disabled = true
      try {
        await decide(item.id, choice)
        status.textContent = choice === "approve" ? "Submitted" : "Declined"
      } catch {
        // approve() can fail after the send was recorded, so never claim it failed.
        status.textContent = "Refresh to check the recorded decision."
      }
    }
    controls.append(button)
  }
  element.append(controls)
}
