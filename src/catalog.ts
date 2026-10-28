/**
 * Parser and rewriter for the Code Mode catalog that OpenCode injects into the
 * system prompt:
 *
 *   ## Available tools
 *
 *   - <namespace> (<N> tools, <M> shown) // description
 *     - tools.<namespace>.<tool>({...}) // description
 *
 * Only the tools rendered in this catalog are visible to the model. The
 * catalog is a sample (`M shown`), and `search(...)` can discover more, but
 * removing the namespace or its sample entries keeps those tools out of the
 * model's context.
 */

export interface CatalogEntry {
  namespace: string
  toolName: string
  /** Path under `tools`, e.g. `opencode.session_move` or `skill_validate`. */
  path: string
  description: string
  start: number
  end: number
  raw: string
}

export interface CatalogSection {
  namespace: string
  description: string
  total: number
  shown: number
  /** Offset of the `- namespace (...)` line. */
  start: number
  /** Offset where the next section (or the catalog end) starts. */
  end: number
  headerRaw: string
  entries: CatalogEntry[]
}

export interface ParsedCatalog {
  prefix: string
  suffix: string
  sections: CatalogSection[]
}

interface Line {
  text: string
  start: number
  end: number
}

const HEADER_RE = /^- (\S+) \((\d+) tools?(?:, (\d+|none) shown)?\)(?: \/\/ (.*))?$/
const ENTRY_RE = /^ {2}- tools(?:\.|\[)/
const AVAILABLE_MARKER = /^## Available tools\s*$/
/**
 * Column-0 markers that follow the catalog in the assembled system prompt.
 * Signature continuation lines can also start at column 0 (`}): Promise<{`),
 * so this list is intentionally explicit.
 */
const STOP_RE =
  /^(?:<mcp_instructions>|<available_skills>|<env>|<system-reminder>|Skills provide specialized|Today's date:|Here is some useful information|## )/

function splitLines(text: string): Line[] {
  const lines: Line[] = []
  let start = 0
  while (start <= text.length) {
    const newline = text.indexOf("\n", start)
    const end = newline === -1 ? text.length : newline
    lines.push({ text: text.slice(start, end), start, end })
    if (newline === -1) break
    start = newline + 1
  }
  return lines
}

function parseToolPath(head: string): { namespace: string; toolName: string; path: string } | undefined {
  const value = head.replace(/^ {2}- /, "").trim()

  const bracket = /^tools\["([^"]+)"\]\.([^.[(]+)/.exec(value)
  if (bracket?.[1] !== undefined && bracket[2] !== undefined) {
    return { namespace: bracket[1], toolName: bracket[2], path: `${bracket[1]}.${bracket[2]}` }
  }

  const singleQuote = /^tools\['([^']+)'\]\.([^.[(]+)/.exec(value)
  if (singleQuote?.[1] !== undefined && singleQuote[2] !== undefined) {
    return {
      namespace: singleQuote[1],
      toolName: singleQuote[2],
      path: `${singleQuote[1]}.${singleQuote[2]}`,
    }
  }

  const dotted = /^tools\.([^.[(]+)\.([^.[(]+)/.exec(value)
  if (dotted?.[1] !== undefined && dotted[2] !== undefined) {
    return { namespace: dotted[1], toolName: dotted[2], path: `${dotted[1]}.${dotted[2]}` }
  }

  const dottedBracket = /^tools\.([^.[(]+)\["([^"]+)"\]/.exec(value)
  if (dottedBracket?.[1] !== undefined && dottedBracket[2] !== undefined) {
    return {
      namespace: dottedBracket[1],
      toolName: dottedBracket[2],
      path: `${dottedBracket[1]}.${dottedBracket[2]}`,
    }
  }

  const flat = /^tools\.([^.[(]+)(?:\(|$)/.exec(value)
  if (flat?.[1] !== undefined) {
    return { namespace: flat[1], toolName: flat[1], path: flat[1] }
  }

  return undefined
}

function parseDescription(raw: string): string {
  const index = raw.lastIndexOf(" // ")
  if (index === -1) return ""
  const tail = raw.slice(index + 4)
  const newline = tail.indexOf("\n")
  return (newline === -1 ? tail : tail.slice(0, newline)).trim()
}

export function parseCatalog(text: string): ParsedCatalog | undefined {
  const lines = splitLines(text)
  const marker = lines.findIndex((line) => AVAILABLE_MARKER.test(line.text))
  if (marker === -1) return undefined

  const sections: CatalogSection[] = []
  let current: CatalogSection | undefined
  let currentEntry: CatalogEntry | undefined
  let catalogStart = -1
  let catalogEnd = -1

  const closeEntry = (end: number) => {
    if (currentEntry === undefined) return
    currentEntry.end = end
    currentEntry.raw = text.slice(currentEntry.start, end)
    currentEntry.description = parseDescription(currentEntry.raw)
    currentEntry = undefined
  }

  for (let index = marker + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === undefined) break

    const header = HEADER_RE.exec(line.text)
    if (header?.[1] !== undefined) {
      closeEntry(line.start)
      if (current !== undefined) current.end = line.start
      if (catalogStart === -1) catalogStart = line.start

      current = {
        namespace: header[1],
        description: header[4]?.trim() ?? "",
        total: Number(header[2] ?? 0),
        shown:
          header[3] === undefined
            ? Number(header[2] ?? 0)
            : header[3] === "none"
              ? 0
              : Number(header[3]),
        start: line.start,
        end: -1,
        headerRaw: text.slice(line.start, line.end) + "\n",
        entries: [],
      }
      sections.push(current)
      continue
    }

    if (STOP_RE.test(line.text)) {
      catalogEnd = line.start
      break
    }

    if (current === undefined) {
      if (line.text.trim() === "") continue
      break
    }

    if (line.text.trim() === "") continue

    if (ENTRY_RE.test(line.text)) {
      closeEntry(line.start)
      const parsed = parseToolPath(line.text)
      const entry: CatalogEntry = {
        namespace: parsed?.namespace ?? current.namespace,
        toolName: parsed?.toolName ?? "",
        path: parsed?.path ?? "",
        description: "",
        start: line.start,
        end: -1,
        raw: "",
      }
      currentEntry = entry
      current.entries.push(entry)
    }
    // Everything else (including column-0 signature closers such as
    // `}): Promise<{`) belongs to the current entry.
  }

  if (catalogEnd === -1) catalogEnd = text.length
  const trimmedEnd = trimTrailingNewlines(text, catalogEnd)
  catalogEnd = trimmedEnd === catalogEnd ? trimmedEnd : trimmedEnd + 1

  if (current !== undefined) {
    closeEntry(catalogEnd)
    current.end = catalogEnd
  }

  if (catalogStart === -1 || catalogEnd === -1) {
    return { prefix: text, suffix: "", sections: [] }
  }

  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index]
    if (section === undefined) continue
    const next = sections[index + 1]
    section.end = next?.start ?? catalogEnd
    for (const entry of section.entries) {
      if (entry.end === -1) entry.end = section.end
      entry.raw = text.slice(entry.start, entry.end)
      if (entry.description === "") entry.description = parseDescription(entry.raw)
    }
  }

  return {
    prefix: text.slice(0, catalogStart),
    suffix: text.slice(catalogEnd),
    sections,
  }
}

function trimTrailingNewlines(text: string, end: number): number {
  let current = end
  while (current > 0 && (text[current - 1] === "\n" || text[current - 1] === "\r")) current -= 1
  return current
}

function formatHeader(section: CatalogSection, total: number, shown: number): string {
  const noun = total === 1 ? "tool" : "tools"
  const count =
    shown >= total
      ? `${total} ${noun}`
      : shown === 0
        ? `${total} ${noun}, none shown`
        : `${total} ${noun}, ${shown} shown`
  const description = section.description === "" ? "" : ` // ${section.description}`
  return `- ${section.namespace} (${count})${description}\n`
}

export interface CatalogPolicy {
  keepSection(namespace: string): boolean
  keepEntry(namespace: string, toolName: string): boolean
}

export interface PrunedCatalog {
  text: string
  removedSections: string[]
  removedEntries: { namespace: string; toolName: string }[]
}

/**
 * Rewrites the catalog in place. Sections lose their entries individually and
 * are dropped when every rendered entry is pruned. Hidden tools are untouched;
 * OpenCode can still find them through `search`, which is exactly the
 * "context-only" pruning contract.
 */
export function pruneCatalog(text: string, policy: CatalogPolicy): PrunedCatalog {
  const catalog = parseCatalog(text)
  if (catalog === undefined || catalog.sections.length === 0) {
    return { text, removedSections: [], removedEntries: [] }
  }

  const removedSections: string[] = []
  const removedEntries: { namespace: string; toolName: string }[] = []
  let output = catalog.prefix
  let keptSections = 0

  for (const section of catalog.sections) {
    if (!policy.keepSection(section.namespace)) {
      removedSections.push(section.namespace)
      for (const entry of section.entries) {
        removedEntries.push({ namespace: entry.namespace, toolName: entry.toolName })
      }
      continue
    }

    const kept = section.entries.filter((entry) => {
      const keep = policy.keepEntry(entry.namespace, entry.toolName)
      if (!keep) removedEntries.push({ namespace: entry.namespace, toolName: entry.toolName })
      return keep
    })

    if (section.entries.length > 0 && kept.length === 0) {
      removedSections.push(section.namespace)
      continue
    }

    if (kept.length === section.entries.length) {
      output += section.headerRaw
    } else {
      const total = Math.max(kept.length, section.total - (section.entries.length - kept.length))
      output += formatHeader(section, total, kept.length)
    }
    for (const entry of kept) output += entry.raw
    keptSections += 1
  }

  output += catalog.suffix

  if (keptSections === 0) {
    const prefix = catalog.prefix.replace(/\n*$/, "")
    const suffix = catalog.suffix.replace(/^\n+/, "")
    output = `${prefix}\n\nNo Code Mode tools are currently available.\n\n${suffix}`
  }

  return { text: output, removedSections, removedEntries }
}
