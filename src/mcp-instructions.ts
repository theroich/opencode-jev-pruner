/**
 * Removes `<server name="...">` entries from the `<mcp_instructions>` block for
 * MCP servers whose tools were pruned. Server instructions are frequently long
 * and only make sense while that server's tools are visible.
 */

const OPEN = "<mcp_instructions>"
const CLOSE = "</mcp_instructions>"
const SERVER_RE = /<server name="([^"]+)">[\s\S]*?<\/server>/g

export function pruneMcpInstructions(text: string, removedServers: ReadonlySet<string>): string {
  if (removedServers.size === 0) return text

  const start = text.indexOf(OPEN)
  const close = text.indexOf(CLOSE, start === -1 ? 0 : start)
  if (start === -1 || close === -1) return text

  const innerStart = start + OPEN.length
  const inner = text.slice(innerStart, close)
  const kept: string[] = []
  let removed = 0

  for (const match of inner.matchAll(SERVER_RE)) {
    const name = match[1]
    if (name !== undefined && removedServers.has(name)) {
      removed += 1
      continue
    }
    kept.push(match[0].trimEnd())
  }

  if (removed === 0) return text

  if (kept.length === 0) {
    return `${text.slice(0, start)}${text.slice(close + CLOSE.length)}`.replace(/\n{3,}/g, "\n\n")
  }

  const nextInner = `\n${kept.map((block) => `  ${block.trimStart()}`).join("\n")}\n`
  return `${text.slice(0, innerStart)}${nextInner}${text.slice(close)}`
}
