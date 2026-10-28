/** Runtime configuration for the context pruner. */
export interface PrunerConfig {
  /** Jev / TypeSafe API key. Empty disables the plugin (fail open). */
  apiKey: string
  endpoint: string
  model: string
  /** Keep a tool or skill when its "yes" probability is >= this value. */
  threshold: number
  /** Keep an MCP server when its "yes" probability is >= this value. */
  phase1Threshold: number
  /** Per Jev request timeout. On timeout the original payload is sent unchanged. */
  timeoutMs: number
  /** Gate MCP servers first, then score the tools of the surviving servers. */
  twoPhase: boolean
  alwaysIncludeSkills: string[]
  alwaysIncludeTools: string[]
  alwaysIncludeServers: string[]
  pruneSkills: boolean
  pruneMcpTools: boolean
  debug: boolean
  /** Optional file that receives one JSON line per pruned request. */
  debugLogFile?: string
  /** Maximum questions sent to Jev in a single HTTP request. */
  maxQuestionsPerRequest: number
  /** Descriptions are truncated before being embedded in a Jev question. */
  maxDescriptionChars: number
  /** Reuse decisions for the same prompt + catalog within this window. */
  cacheTtlMs: number
  /** Maximum prompt characters forwarded as Jev `state`. */
  maxPromptChars: number
  /** Pay DNS/TLS at load so the first real request does not eat the timeout. */
  warmupOnLoad: boolean
  /**
   * After a Jev failure, skip pruning for this many milliseconds instead of
   * paying the timeout on every turn. `0` disables the cooldown.
   */
  failureCooldownMs: number
}

export const DEFAULTS = {
  endpoint: "https://opencode.ai/inference/systemone/v1/systemone",
  model: "jev-1.13",
  threshold: 0.55,
  phase1Threshold: 0.35,
  // 400 ms is the spec's example, but a cold HTTPS connection to the endpoint
  // routinely takes ~400-500 ms on the first call. Keep the budget realistic.
  timeoutMs: 900,
  twoPhase: true,
  alwaysIncludeSkills: ["core_system_skill", "error_recovery"],
  alwaysIncludeTools: [] as string[],
  alwaysIncludeServers: ["opencode"],
  pruneSkills: true,
  pruneMcpTools: true,
  debug: false,
  maxQuestionsPerRequest: 100,
  maxDescriptionChars: 400,
  cacheTtlMs: 10 * 60_000,
  maxPromptChars: 6_000,
  warmupOnLoad: false,
  failureCooldownMs: 0,
} as const

/** Result of reading settings. `disabledReason` is set when the plugin must fail open. */
export interface LoadedConfig {
  config: PrunerConfig
  disabledReason?: string
}

type Options = Record<string, unknown>
type Env = Record<string, string | undefined>

const ENV_KEYS = {
  apiKey: ["JEV_API_KEY", "TYPESAFE_API_KEY"],
  endpoint: ["JEV_URL", "JEV_ENDPOINT"],
  model: ["JEV_MODEL"],
  threshold: ["JEV_CONFIDENCE_THRESHOLD", "JEV_PRUNER_THRESHOLD"],
  phase1Threshold: ["JEV_PHASE1_THRESHOLD"],
  timeoutMs: ["JEV_TIMEOUT_MS"],
  debug: ["JEV_PRUNER_DEBUG"],
  debugLogFile: ["JEV_PRUNER_DEBUG_LOG"],
  warmupOnLoad: ["JEV_WARMUP"],
  failureCooldownMs: ["JEV_FAILURE_COOLDOWN_MS"],
} as const

function envValue(env: Env, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]
    if (value !== undefined && value.trim() !== "") return value.trim()
  }
  return undefined
}

function option(options: Options, snake: string, camel: string): unknown {
  const value = options[snake]
  if (value !== undefined) return value
  return options[camel]
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

function asStringArray(value: unknown, fallback: readonly string[]): string[] {
  if (value === undefined) return [...fallback]
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "")
  }
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "")
  }
  return [...fallback]
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase()
    if (["1", "true", "yes", "on"].includes(normalized)) return true
    if (["0", "false", "no", "off"].includes(normalized)) return false
  }
  return fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Reads plugin options (snake_case per the spec, camelCase also accepted) and
 * environment variables. Options win over environment variables.
 */
export function loadConfig(options: Options = {}, env: Env = process.env): LoadedConfig {
  const apiKey =
    asString(option(options, "jev_api_key", "apiKey")) ?? envValue(env, ENV_KEYS.apiKey) ?? ""

  const threshold = clamp(
    asNumber(
      option(options, "jev_confidence_threshold", "threshold") ?? envValue(env, ENV_KEYS.threshold),
      DEFAULTS.threshold,
    ),
    0,
    1,
  )
  const phase1Threshold = clamp(
    asNumber(
      option(options, "jev_phase1_threshold", "phase1Threshold") ??
        envValue(env, ENV_KEYS.phase1Threshold),
      DEFAULTS.phase1Threshold,
    ),
    0,
    1,
  )
  const timeoutMs = clamp(
    asNumber(
      option(options, "jev_timeout_ms", "timeoutMs") ?? envValue(env, ENV_KEYS.timeoutMs),
      DEFAULTS.timeoutMs,
    ),
    1,
    15_000,
  )

  const debugLogFile =
    asString(option(options, "debug_log_file", "debugLogFile")) ??
    envValue(env, ENV_KEYS.debugLogFile)

  const config: PrunerConfig = {
    apiKey,
    endpoint:
      asString(option(options, "jev_endpoint", "endpoint")) ??
      envValue(env, ENV_KEYS.endpoint) ??
      DEFAULTS.endpoint,
    model:
      asString(option(options, "jev_model", "model")) ??
      envValue(env, ENV_KEYS.model) ??
      DEFAULTS.model,
    threshold,
    phase1Threshold,
    timeoutMs,
    twoPhase: asBoolean(option(options, "enable_two_phase_gating", "twoPhase"), DEFAULTS.twoPhase),
    alwaysIncludeSkills: asStringArray(
      option(options, "always_include_skills", "alwaysIncludeSkills"),
      DEFAULTS.alwaysIncludeSkills,
    ),
    alwaysIncludeTools: asStringArray(
      option(options, "always_include_tools", "alwaysIncludeTools"),
      DEFAULTS.alwaysIncludeTools,
    ),
    alwaysIncludeServers: asStringArray(
      option(options, "always_include_servers", "alwaysIncludeServers"),
      DEFAULTS.alwaysIncludeServers,
    ),
    pruneSkills: asBoolean(option(options, "prune_skills", "pruneSkills"), DEFAULTS.pruneSkills),
    pruneMcpTools: asBoolean(
      option(options, "prune_mcp_tools", "pruneMcpTools"),
      DEFAULTS.pruneMcpTools,
    ),
    debug:
      asBoolean(option(options, "debug_mode", "debug"), DEFAULTS.debug) ||
      asBoolean(envValue(env, ENV_KEYS.debug), false),
    maxQuestionsPerRequest: Math.round(
      clamp(
        asNumber(
          option(options, "max_questions_per_request", "maxQuestionsPerRequest"),
          DEFAULTS.maxQuestionsPerRequest,
        ),
        1,
        1_000,
      ),
    ),
    maxDescriptionChars: Math.round(
      clamp(
        asNumber(
          option(options, "max_description_chars", "maxDescriptionChars"),
          DEFAULTS.maxDescriptionChars,
        ),
        40,
        4_000,
      ),
    ),
    cacheTtlMs: Math.round(
      clamp(
        asNumber(option(options, "cache_ttl_ms", "cacheTtlMs"), DEFAULTS.cacheTtlMs),
        0,
        24 * 60 * 60_000,
      ),
    ),
    maxPromptChars: Math.round(
      clamp(
        asNumber(option(options, "max_prompt_chars", "maxPromptChars"), DEFAULTS.maxPromptChars),
        200,
        100_000,
      ),
    ),
    warmupOnLoad:
      asBoolean(
        option(options, "warmup_on_load", "warmupOnLoad") ?? envValue(env, ENV_KEYS.warmupOnLoad),
        DEFAULTS.warmupOnLoad,
      ),
    failureCooldownMs: Math.round(
      clamp(
        asNumber(
          option(options, "failure_cooldown_ms", "failureCooldownMs") ??
            envValue(env, ENV_KEYS.failureCooldownMs),
          DEFAULTS.failureCooldownMs,
        ),
        0,
        5 * 60_000,
      ),
    ),
    ...(debugLogFile === undefined ? {} : { debugLogFile }),
  }

  if (apiKey === "") {
    return {
      config,
      disabledReason:
        "missing Jev API key. Set JEV_API_KEY (or plugins[].options.jev_api_key); requests pass through unfiltered.",
    }
  }

  return { config }
}
