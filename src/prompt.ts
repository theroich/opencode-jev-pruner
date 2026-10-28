export interface PromptMessage {
  role: string
  content: unknown
}

/** Concatenates the text parts of the most recent user message. */
export function extractUserPrompt(messages: readonly PromptMessage[], maxChars: number): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined || message.role !== "user") continue

    const text = messageText(message.content).trim()
    if (text === "") continue
    return text.length > maxChars ? text.slice(0, maxChars) : text
  }
  return ""
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""

  const parts: string[] = []
  for (const part of content) {
    if (part === null || typeof part !== "object") continue
    const record = part as { type?: unknown; text?: unknown }
    if (record.type === "text" && typeof record.text === "string") {
      parts.push(record.text)
    }
  }
  return parts.join("\n")
}
