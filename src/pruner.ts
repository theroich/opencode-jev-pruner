import { parseCatalog, pruneCatalog } from "./catalog.ts"
import type { PrunerConfig } from "./config.ts"
import type { JevClient, NoulQuestion } from "./jev.ts"
import { matchesAny, matchesPattern } from "./match.ts"
import { pruneMcpInstructions } from "./mcp-instructions.ts"
import { extractUserPrompt, type PromptMessage } from "./prompt.ts"
import { parseSkills, pruneSkills, type SkillEntry } from "./skills.ts"

export interface PrunerToolInfo {
  id: string
  name: string
  description: string
  namespace?: string
  codemode: boolean
}

export interface PrunerServerInfo {
  name: string
  connected: boolean
}

export interface SystemPartLike {
  type: string
  text: string
  [key: string]: unknown
}

export interface ToolDefinitionLike {
  description: string
  input: unknown
  [key: string]: unknown
}

export interface PrunerEventLike {
  sessionID: string
  system: SystemPartLike[]
  tools: Record<string, ToolDefinitionLike>
  messages: PromptMessage[]
}

export interface PrunerDeps {
  config: PrunerConfig
  client: Pick<JevClient, "ask">
  listTools: () => Promise<readonly PrunerToolInfo[]>
  listServers: () => Promise<readonly PrunerServerInfo[]>
  now?: () => number
}

interface ToolCandidate {
  key: string
  server: string
  serverName: string
  toolName: string
  toolId?: string
  description: string
  visible: boolean
  inRequest: boolean
  codemode: boolean
  always: boolean
}

export interface PruningReport {
  prompt: string
  durationMs: number
  jevCalls: number
  cached: boolean
  stats: {
    catalogSections: number
    registeredTools: number
    candidates: number
    skills: number
    catalogNamespaces: string[]
    serverNamespaces: string[]
    toolNamespaces: string[]
  }
  servers: { name: string; score?: number; kept: boolean; reason: string }[]
  tools: {
    server: string
    name: string
    score?: number
    kept: boolean
    visible: boolean
    always: boolean
  }[]
  skills: { id: string; score?: number; kept: boolean }[]
  removed: {
    servers: string[]
    tools: string[]
    skills: string[]
    mcpInstructions: string[]
  }
}

export interface PruningResult {
  system: SystemPartLike[]
  tools: Record<string, ToolDefinitionLike>
  applied: boolean
  report: PruningReport
}

const CACHE_LIMIT = 100
const scoreCache = new Map<string, { expires: number; scores: Record<string, number> }>()

export async function planPruning(event: PrunerEventLike, deps: PrunerDeps): Promise<PruningResult> {
  const now = deps.now ?? Date.now
  const startedAt = now()
  const config = deps.config

  const prompt = extractUserPrompt(event.messages, config.maxPromptChars)
  const baseReport: PruningReport = {
    prompt,
    durationMs: 0,
    jevCalls: 0,
    cached: false,
    stats: {
      catalogSections: 0,
      registeredTools: 0,
      candidates: 0,
      skills: 0,
      catalogNamespaces: [],
      serverNamespaces: [],
      toolNamespaces: [],
    },
    servers: [],
    tools: [],
    skills: [],
    removed: { servers: [], tools: [], skills: [], mcpInstructions: [] },
  }

  if (prompt.trim() === "" || (!config.pruneMcpTools && !config.pruneSkills)) {
    return { system: event.system, tools: event.tools, applied: false, report: baseReport }
  }

  const [registeredTools, servers] = await Promise.all([deps.listTools(), deps.listServers()])

  const serverByNamespace = new Map<string, string>()
  for (const server of servers) {
    if (!server.connected) continue
    serverByNamespace.set(normalizeName(server.name), server.name)
  }

  const catalogText = findPartText(event.system, "## Available tools")
  const catalog = catalogText === undefined ? undefined : parseCatalog(catalogText)
  const catalogSections = catalog?.sections ?? []

  const candidates = collectToolCandidates({
    registeredTools,
    eventTools: event.tools,
    catalogSections,
    serverByNamespace,
    config,
  })

  const skillText = config.pruneSkills
    ? findPartText(event.system, "<available_skills>")
    : undefined
  const skills = skillText === undefined ? [] : (parseSkills(skillText)?.entries ?? [])

  const alwaysSkillIds = new Set(
    skills.filter((skill) => isAlwaysSkill(skill, config)).map((skill) => skill.id),
  )
  const alwaysNamespaces = new Set<string>()
  for (const namespace of serverByNamespace.keys()) {
    if (isAlwaysServer(namespace, config)) alwaysNamespaces.add(namespace)
  }
  for (const candidate of candidates) {
    if (candidate.always) alwaysNamespaces.add(candidate.server)
  }

  const gatedNamespaces = new Set<string>()
  const serverQuestions: Record<string, NoulQuestion> = {}
  const questionServers = new Map<string, string>()
  if (config.pruneMcpTools && config.twoPhase) {
    const namespaces = [...serverByNamespace.keys()].filter(
      (namespace) =>
        !alwaysNamespaces.has(namespace) &&
        candidates.some((candidate) => candidate.server === namespace),
    )
    if (namespaces.length > 1) {
      for (const namespace of namespaces) {
        const key = `m${Object.keys(serverQuestions).length}`
        const serverName = serverByNamespace.get(namespace) ?? namespace
        const toolNames = candidates
          .filter((candidate) => candidate.server === namespace)
          .slice(0, 6)
          .map((candidate) => candidate.toolName)
        serverQuestions[key] = {
          type: "noul",
          instructions: serverInstruction(
            serverName,
            descriptionForServer(namespace, catalogSections),
            toolNames,
          ),
        }
        questionServers.set(key, namespace)
        gatedNamespaces.add(namespace)
      }
    }
  }

  const askCached = async (key: string, questions: Record<string, NoulQuestion>) => {
    if (Object.keys(questions).length === 0) {
      return { scores: {} as Record<string, number>, calls: 0, cached: false }
    }
    const entry = config.cacheTtlMs > 0 ? scoreCache.get(key) : undefined
    if (entry !== undefined && entry.expires > now()) {
      return { scores: entry.scores, calls: 0, cached: true }
    }

    let calls = 0
    const results = await Promise.all(
      chunkQuestions(questions, config.maxQuestionsPerRequest).map(async (batch) => {
        calls += 1
        return deps.client.ask(prompt, batch)
      }),
    )
    const scores: Record<string, number> = {}
    for (const result of results) Object.assign(scores, result)

    if (config.cacheTtlMs > 0) {
      scoreCache.set(key, { expires: now() + config.cacheTtlMs, scores: { ...scores } })
      if (scoreCache.size > CACHE_LIMIT) {
        const oldest = scoreCache.keys().next().value
        if (oldest !== undefined) scoreCache.delete(oldest)
      }
    }
    return { scores, calls, cached: false }
  }

  // Phase 1: which MCP servers are worth exposing at all?
  const phase1 = await askCached(
    `${event.sessionID}:p1:${hash(prompt)}:${hash(questionsSignature(serverQuestions))}`,
    serverQuestions,
  )

  const serverScores = new Map<string, number>()
  for (const [key, namespace] of questionServers) {
    const score = phase1.scores[key]
    if (score !== undefined) serverScores.set(namespace, score)
  }

  const removedServers = new Set<string>()
  for (const namespace of gatedNamespaces) {
    const score = serverScores.get(namespace)
    if (score !== undefined && score < config.phase1Threshold) removedServers.add(namespace)
  }

  // Phase 2: individual tools of the surviving servers, plus skills.
  const toolQuestions: Record<string, NoulQuestion> = {}
  const questionToolKeys = new Map<string, string>()
  if (config.pruneMcpTools) {
    for (const candidate of candidates) {
      if (candidate.always || removedServers.has(candidate.server)) continue
      const key = `t${Object.keys(toolQuestions).length}`
      toolQuestions[key] = {
        type: "noul",
        instructions: toolInstruction(candidate, config.maxDescriptionChars),
      }
      questionToolKeys.set(key, candidate.key)
    }
  }

  const skillQuestions: Record<string, NoulQuestion> = {}
  const questionSkillIds = new Map<string, string>()
  if (config.pruneSkills) {
    for (const skill of skills) {
      if (alwaysSkillIds.has(skill.id)) continue
      const key = `s${Object.keys(skillQuestions).length}`
      skillQuestions[key] = {
        type: "noul",
        instructions: skillInstruction(skill, config.maxDescriptionChars),
      }
      questionSkillIds.set(key, skill.id)
    }
  }

  const phase2Questions = { ...toolQuestions, ...skillQuestions }
  const phase2 = await askCached(
    `${event.sessionID}:p2:${hash(prompt)}:${hash(questionsSignature(phase2Questions))}:${hash(
      candidates.map((candidate) => candidate.key).join("|"),
    )}`,
    phase2Questions,
  )

  const scores = { ...phase1.scores, ...phase2.scores }
  const jevCalls = phase1.calls + phase2.calls
  const cached = phase1.cached || phase2.cached

  const toolScores = new Map<string, number>()
  for (const [key, candidateKey] of questionToolKeys) {
    const score = scores[key]
    if (score !== undefined) toolScores.set(candidateKey, score)
  }

  const removedToolKeys = new Set<string>()
  for (const candidate of candidates) {
    if (candidate.always) continue
    if (removedServers.has(candidate.server)) {
      removedToolKeys.add(candidate.key)
      continue
    }
    const score = toolScores.get(candidate.key)
    if (score !== undefined && score < config.threshold) removedToolKeys.add(candidate.key)
  }

  const skillScores = new Map<string, number>()
  for (const [key, id] of questionSkillIds) {
    const score = scores[key]
    if (score !== undefined) skillScores.set(id, score)
  }
  const removedSkillIds = new Set(
    skills
      .filter((skill) => !alwaysSkillIds.has(skill.id))
      .filter((skill) => {
        const score = skillScores.get(skill.id)
        return score !== undefined && score < config.threshold
      })
      .map((skill) => skill.id),
  )

  // Build the next system prompt in memory. Nothing is mutated until the end.
  const removedRawServerNames = new Set(
    [...removedServers].map((namespace) => serverByNamespace.get(namespace) ?? namespace),
  )
  const removedMcpInstructions = new Set<string>()

  const modifiedSystem = event.system.map((part) => {
    if (part.type !== "text") return part
    let text = part.text

    if (config.pruneMcpTools && text.includes("## Available tools")) {
      text = pruneCatalog(text, {
        keepSection: (namespace) => !removedServers.has(normalizeName(namespace)),
        keepEntry: (namespace, toolName) => {
          const key = `${normalizeName(namespace)}\u0000${toolName}`
          const candidate = candidates.find((entry) => entry.key === key)
          if (candidate === undefined) return true
          return !removedToolKeys.has(candidate.key)
        },
      }).text
    }

    if (removedRawServerNames.size > 0 && text.includes("<mcp_instructions>")) {
      const next = pruneMcpInstructions(text, removedRawServerNames)
      if (next !== text) {
        for (const name of removedRawServerNames) {
          if (text.includes(`<server name="${name}">`)) removedMcpInstructions.add(name)
        }
      }
      text = next
    }

    if (config.pruneSkills && removedSkillIds.size > 0 && text.includes("<available_skills>")) {
      text = pruneSkills(text, (skill) => !removedSkillIds.has(skill.id)).text
    }

    return text === part.text ? part : { ...part, text }
  })
  const systemChanged = modifiedSystem.some((part, index) => part !== event.system[index])
  const nextSystem = systemChanged ? modifiedSystem : event.system

  const requestKeysToDelete = new Set<string>()
  if (removedToolKeys.size > 0 || removedServers.size > 0) {
    for (const candidate of candidates) {
      if (!candidate.inRequest) continue
      const removed = removedToolKeys.has(candidate.key) || removedServers.has(candidate.server)
      if (!removed) continue
      for (const key of toolRequestKeys(candidate)) {
        if (Object.hasOwn(event.tools, key)) requestKeysToDelete.add(key)
      }
    }
  }

  let nextTools = event.tools
  if (requestKeysToDelete.size > 0) {
    nextTools = { ...event.tools }
    for (const key of requestKeysToDelete) delete nextTools[key]
  }

  const applied = nextSystem !== event.system || nextTools !== event.tools

  const report: PruningReport = {
    prompt,
    durationMs: Math.max(0, now() - startedAt),
    jevCalls,
    cached,
    stats: {
      catalogSections: catalogSections.length,
      registeredTools: registeredTools.length,
      candidates: candidates.length,
      skills: skills.length,
      catalogNamespaces: catalogSections.map((section) => section.namespace),
      serverNamespaces: [...serverByNamespace.keys()],
      toolNamespaces: [
        ...new Set(
          registeredTools
            .map((tool) => tool.namespace)
            .filter((namespace): namespace is string => namespace !== undefined),
        ),
      ],
    },
    servers: [...serverByNamespace.entries()].map(([namespace, name]) => {
      const score = serverScores.get(namespace)
      const kept = !removedServers.has(namespace)
      return {
        name,
        ...(score === undefined ? {} : { score }),
        kept,
        reason: gatedNamespaces.has(namespace)
          ? kept
            ? "phase 1 passed"
            : "phase 1 rejected"
          : config.twoPhase
            ? "phase 1 skipped"
            : "phase 1 disabled",
      }
    }),
    tools: candidates.map((candidate) => {
      const score = toolScores.get(candidate.key)
      return {
        server: candidate.serverName,
        name: candidate.toolName,
        ...(score === undefined ? {} : { score }),
        kept: !removedToolKeys.has(candidate.key),
        visible: candidate.visible,
        always: candidate.always,
      }
    }),
    skills: skills.map((skill) => {
      const score = skillScores.get(skill.id)
      return {
        id: skill.id,
        ...(score === undefined ? {} : { score }),
        kept: !removedSkillIds.has(skill.id),
      }
    }),
    removed: {
      servers: [...removedServers].map((namespace) => serverByNamespace.get(namespace) ?? namespace),
      tools: candidates
        .filter((candidate) => removedToolKeys.has(candidate.key))
        .map((candidate) => `${candidate.serverName}.${candidate.toolName}`),
      skills: [...removedSkillIds],
      mcpInstructions: [...removedMcpInstructions],
    },
  }

  return { system: nextSystem, tools: nextTools, applied, report }
}

interface CollectInput {
  registeredTools: readonly PrunerToolInfo[]
  eventTools: Record<string, ToolDefinitionLike>
  catalogSections: readonly { namespace: string; entries: readonly { toolName: string; description: string }[] }[]
  serverByNamespace: ReadonlyMap<string, string>
  config: PrunerConfig
}

function collectToolCandidates(input: CollectInput): ToolCandidate[] {
  const byKey = new Map<string, ToolCandidate>()

  for (const tool of input.registeredTools) {
    const namespace = mcpNamespace(tool, input.serverByNamespace)
    if (namespace === undefined) continue
    const serverName = input.serverByNamespace.get(namespace) ?? namespace
    const visible = isRendered(input.catalogSections, namespace, tool.name)
    const inRequest = Object.hasOwn(input.eventTools, tool.id)

    // Code Mode tools are only actionable when the catalog renders them.
    if (tool.codemode && !visible) continue
    if (!tool.codemode && !inRequest) continue

    const key = `${namespace}\u0000${tool.name}`
    byKey.set(key, {
      key,
      server: namespace,
      serverName,
      toolName: tool.name,
      toolId: tool.id,
      description: tool.description,
      visible,
      inRequest,
      codemode: tool.codemode,
      always: isAlwaysTool(tool.name, tool.id, namespace, serverName, input.config),
    })
  }

  // Fallback for non-Code-Mode MCP tools when the registry snapshot lags
  // behind: OpenCode names them `<server>_<tool>`.
  for (const [requestKey, definition] of Object.entries(input.eventTools)) {
    for (const [server, serverName] of input.serverByNamespace) {
      if (!requestKey.startsWith(`${server}_`) || requestKey.length === server.length + 1) continue
      const toolName = requestKey.slice(server.length + 1)
      const key = `${server}\u0000${toolName}`
      if (byKey.has(key)) continue
      byKey.set(key, {
        key,
        server,
        serverName,
        toolName,
        toolId: requestKey,
        description: definition.description,
        visible: false,
        inRequest: true,
        codemode: false,
        always: isAlwaysTool(toolName, requestKey, server, serverName, input.config),
      })
      break
    }
  }

  // Catalog entries whose tool is not in the registry snapshot (for example a
  // registration that happened after setup) are still prunable.
  for (const section of input.catalogSections) {
    const server = normalizeName(section.namespace)
    const serverName = input.serverByNamespace.get(server)
    if (serverName === undefined) continue
    for (const entry of section.entries) {
      const key = `${server}\u0000${entry.toolName}`
      if (byKey.has(key)) continue
      byKey.set(key, {
        key,
        server,
        serverName,
        toolName: entry.toolName,
        description: entry.description,
        visible: true,
        inRequest: false,
        codemode: true,
        always: isAlwaysTool(entry.toolName, undefined, server, serverName, input.config),
      })
    }
  }

  return [...byKey.values()]
}

function mcpNamespace(
  tool: PrunerToolInfo,
  serverByNamespace: ReadonlyMap<string, string>,
): string | undefined {
  const namespace = tool.namespace === undefined ? undefined : normalizeName(tool.namespace)
  if (namespace !== undefined) return serverByNamespace.has(namespace) ? namespace : undefined
  // Defensive fallback for MCP tools that lost their namespace option.
  for (const server of serverByNamespace.keys()) {
    if (tool.id === server || tool.id.startsWith(`${server}_`)) return server
  }
  return undefined
}

function isRendered(
  sections: readonly { namespace: string; entries: readonly { toolName: string }[] }[],
  namespace: string,
  toolName: string,
): boolean {
  return sections.some(
    (section) =>
      normalizeName(section.namespace) === namespace &&
      section.entries.some((entry) => entry.toolName === toolName),
  )
}

function isAlwaysServer(namespace: string, config: PrunerConfig): boolean {
  const normalized = normalizeName(namespace)
  return config.alwaysIncludeServers.some(
    (pattern) => matchesPattern(namespace, pattern) || matchesPattern(normalized, pattern),
  )
}

function isAlwaysTool(
  toolName: string,
  toolId: string | undefined,
  namespace: string,
  serverName: string,
  config: PrunerConfig,
): boolean {
  const values = [
    toolName,
    ...(toolId === undefined ? [] : [toolId]),
    `${namespace}_${toolName}`,
    `${serverName}_${toolName}`,
    `${namespace}.${toolName}`,
    `${serverName}.${toolName}`,
  ]
  return values.some((value) => matchesAny(value, config.alwaysIncludeTools))
}

function isAlwaysSkill(skill: SkillEntry, config: PrunerConfig): boolean {
  return [skill.id, skill.name].some((value) => matchesAny(value, config.alwaysIncludeSkills))
}

function findPartText(system: readonly SystemPartLike[], marker: string): string | undefined {
  return system.find((part) => part.type === "text" && part.text.includes(marker))?.text
}

function toolRequestKeys(candidate: ToolCandidate): string[] {
  const keys = [`${candidate.server}_${candidate.toolName}`]
  if (candidate.serverName !== candidate.server) {
    keys.push(`${candidate.serverName}_${candidate.toolName}`)
  }
  if (candidate.toolId !== undefined) keys.push(candidate.toolId)
  return keys
}

export function normalizeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_")
}

function descriptionForServer(
  namespace: string,
  sections: readonly { namespace: string; description: string }[],
): string {
  return (
    sections.find((section) => normalizeName(section.namespace) === namespace)?.description ?? ""
  )
}

function serverInstruction(name: string, description: string, toolNames: readonly string[]): string {
  const purpose = description === "" ? "" : ` Server purpose: ${description}`
  const examples =
    toolNames.length === 0 ? "" : ` Example tool names: ${toolNames.join(", ")}.`
  return `Does the user's request require tools from the MCP server "${name}"?${purpose}${examples}`
}

function toolInstruction(candidate: ToolCandidate, maxChars: number): string {
  const description = cleanDescription(candidate.description, maxChars)
  const purpose = description === "" ? "" : ` Tool purpose: ${description}`
  return `Does the user's request require the tool "${candidate.toolName}" from the MCP server "${candidate.serverName}"?${purpose}`
}

function skillInstruction(skill: SkillEntry, maxChars: number): string {
  const description = cleanDescription(skill.description, maxChars)
  const purpose = description === "" ? "" : ` Skill purpose: ${description}`
  return `Does the user's request match the skill "${skill.id}"?${purpose}`
}

function cleanDescription(description: string, maxChars: number): string {
  const collapsed = description.replace(/\s+/g, " ").trim()
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars - 1)}…` : collapsed
}

function chunkQuestions(
  questions: Record<string, NoulQuestion>,
  size: number,
): Record<string, NoulQuestion>[] {
  const entries = Object.entries(questions)
  const chunks: Record<string, NoulQuestion>[] = []
  for (let index = 0; index < entries.length; index += size) {
    chunks.push(Object.fromEntries(entries.slice(index, index + size)))
  }
  return chunks
}

function questionsSignature(questions: Record<string, NoulQuestion>): string {
  return Object.entries(questions)
    .map(([key, question]) => `${key}=${question.instructions}`)
    .join("|")
}

function hash(value: string): string {
  let result = 5381
  for (let index = 0; index < value.length; index += 1) {
    result = ((result << 5) + result + value.charCodeAt(index)) | 0
  }
  return (result >>> 0).toString(36)
}
