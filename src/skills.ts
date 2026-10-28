/**
 * Parser and rewriter for the `<available_skills>` block. OpenCode advertises
 * skills with `<id>`, `<name>` and `<description>`; only the advertised list is
 * pruned, the skill registry and the `skill` tool stay untouched.
 */

export interface SkillEntry {
  id: string
  name: string
  description: string
  start: number
  end: number
  raw: string
}

export interface ParsedSkills {
  text: string
  start: number
  end: number
  entries: SkillEntry[]
}

const OPEN = "<available_skills>"
const CLOSE = "</available_skills>"
const BLOCK_RE = /\n?[ \t]*<skill>[\s\S]*?<\/skill>/g
const ID_RE = /<id>([\s\S]*?)<\/id>/
const NAME_RE = /<name>([\s\S]*?)<\/name>/
const DESCRIPTION_RE = /<description>([\s\S]*?)<\/description>/

export function parseSkills(text: string): ParsedSkills | undefined {
  const start = text.indexOf(OPEN)
  if (start === -1) return undefined
  const close = text.indexOf(CLOSE, start)
  if (close === -1) return undefined

  const innerStart = start + OPEN.length
  const inner = text.slice(innerStart, close)
  const entries: SkillEntry[] = []

  for (const match of inner.matchAll(BLOCK_RE)) {
    const raw = match[0]
    const offset = match.index ?? 0
    const id = ID_RE.exec(raw)?.[1]?.trim()
    if (id === undefined || id === "") continue
    entries.push({
      id,
      name: NAME_RE.exec(raw)?.[1]?.trim() ?? id,
      description: DESCRIPTION_RE.exec(raw)?.[1]?.trim() ?? "",
      start: innerStart + offset,
      end: innerStart + offset + raw.length,
      raw,
    })
  }

  return { text, start, end: close + CLOSE.length, entries }
}

export function pruneSkills(
  text: string,
  shouldKeep: (skill: SkillEntry) => boolean,
): { text: string; removed: SkillEntry[] } {
  const parsed = parseSkills(text)
  if (parsed === undefined || parsed.entries.length === 0) {
    return { text, removed: [] }
  }

  const removed = parsed.entries.filter((entry) => !shouldKeep(entry))
  if (removed.length === 0) return { text, removed }

  const kept = parsed.entries.filter((entry) => shouldKeep(entry))
  if (kept.length === 0) {
    return {
      text:
        text.slice(0, parsed.start) +
        "No skills are currently available." +
        text.slice(parsed.end),
      removed,
    }
  }

  let output = ""
  let cursor = 0
  for (const entry of parsed.entries) {
    output += text.slice(cursor, entry.start)
    if (shouldKeep(entry)) output += entry.raw
    cursor = entry.end
  }
  output += text.slice(cursor)
  return { text: output, removed }
}
