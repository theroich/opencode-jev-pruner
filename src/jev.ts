/** Minimal client for the Jev (TypeSafe System One) `noul` primitive. */

export interface NoulQuestion {
  type: "noul"
  instructions: string
  criteria?: string
}

export interface JevResponse {
  model?: string
  answers?: Record<string, { type?: string; noul?: unknown } | undefined>
  usage?: { input_tokens?: number; output_tokens?: number; cost?: number }
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface JevClientOptions {
  apiKey: string
  endpoint: string
  model: string
  timeoutMs: number
  fetchImpl?: FetchLike
}

export class JevError extends Error {
  readonly statusCode: number | undefined
  readonly body: string | undefined

  constructor(message: string, options: { statusCode?: number; body?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = "JevError"
    this.statusCode = options.statusCode
    this.body = options.body
  }
}

/**
 * Sends one request with many `noul` questions and returns their
 * probabilities. There are deliberately no retries: the pruner has a
 * sub-second budget and fails open.
 */
export class JevClient {
  private readonly apiKey: string
  private readonly endpoint: string
  private readonly model: string
  private readonly timeoutMs: number
  private readonly fetchImpl: FetchLike

  constructor(options: JevClientOptions) {
    this.apiKey = options.apiKey
    this.endpoint = options.endpoint
    this.model = options.model
    this.timeoutMs = options.timeoutMs
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
  }

  async ask(
    state: string,
    questions: Record<string, NoulQuestion>,
    signal?: AbortSignal,
  ): Promise<Record<string, number>> {
    if (Object.keys(questions).length === 0) return {}

    const timeout = AbortSignal.timeout(this.timeoutMs)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])

    let response: Response
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "opencode-jev-pruner/0.1",
        },
        body: JSON.stringify({ model: this.model, state, questions }),
        signal: combined,
      })
    } catch (error) {
      throw new JevError(`Jev request failed: ${messageOf(error)}`, { cause: error })
    }

    const text = await response.text()
    if (!response.ok) {
      throw new JevError(`Jev responded with ${response.status}`, {
        statusCode: response.status,
        body: text.slice(0, 2_000),
      })
    }

    let body: JevResponse
    try {
      body = JSON.parse(text) as JevResponse
    } catch (error) {
      throw new JevError("Jev returned invalid JSON", { body: text.slice(0, 2_000), cause: error })
    }

    if (body.answers === undefined || typeof body.answers !== "object") {
      throw new JevError("Jev response has no answers object", { body: text.slice(0, 2_000) })
    }

    const scores: Record<string, number> = {}
    for (const [key, answer] of Object.entries(body.answers)) {
      const value = answer?.noul
      if (typeof value === "number" && Number.isFinite(value)) {
        scores[key] = Math.min(1, Math.max(0, value))
      }
    }
    return scores
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return "timeout"
    return error.message
  }
  return String(error)
}
