#!/usr/bin/env node
/**
 * Offline Jev stand-in for trying opencode-jev-pruner without an API key.
 *
 * It implements the same contract as the real endpoint (`state` + `questions`
 * with `noul`), but scores each question with a deterministic keyword overlap
 * instead of a model. Point the plugin at it with:
 *
 *   JEV_API_KEY=demo \
 *   JEV_URL=http://127.0.0.1:8787/systemone \
 *   opencode --standalone
 *
 * This is a development tool, not a quality routing engine. Real behaviour
 * comes from Jev.
 */
import { createServer } from "node:http"

const PORT = Number(process.env.PORT ?? 8787)
const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "when", "where", "what", "which",
  "does", "user", "request", "require", "requires", "required", "tool", "tools", "skill",
  "skills", "purpose", "server", "mcp", "use", "using", "used", "can", "will", "should",
  "about", "into", "over", "under", "then", "than", "also", "only", "your", "their",
])

function tokens(text) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token))
}

function score(state, instructions) {
  const stateTokens = new Set(tokens(state))
  const instructionTokens = [...new Set(tokens(instructions))]
  if (instructionTokens.length === 0 || stateTokens.size === 0) return 0.1

  let matches = 0
  for (const token of instructionTokens) {
    if (stateTokens.has(token)) matches += 1
  }

  // The description is usually the discriminative part; a single strong shared
  // term is enough to clear the default 0.55 threshold, which keeps the demo
  // readable. Real routing quality comes from Jev, not from this heuristic.
  const denominator = Math.min(2, instructionTokens.length)
  const overlap = Math.min(1, matches / denominator)
  return Math.round((0.15 + overlap * 0.85) * 1000) / 1000
}

const server = createServer((request, response) => {
  if (request.method !== "POST") {
    response.writeHead(405).end()
    return
  }

  const chunks = []
  request.on("data", (chunk) => chunks.push(chunk))
  request.on("end", () => {
    let body
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    } catch {
      response.writeHead(400, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: { message: "invalid JSON" } }))
      return
    }

    const state = typeof body.state === "string" ? body.state : JSON.stringify(body.state ?? "")
    const answers = {}
    for (const [key, question] of Object.entries(body.questions ?? {})) {
      answers[key] = { type: "noul", noul: score(state, String(question.instructions ?? "")) }
    }

    const summary = Object.entries(answers)
      .map(([key, answer]) => `${key}=${answer.noul.toFixed(2)}`)
      .join(" ")
    console.error(`[fake-jev] ${Object.keys(answers).length} question(s): ${summary}`)

    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ model: body.model ?? "fake-jev", answers, usage: {} }))
  })
})

server.listen(PORT, "127.0.0.1", () => {
  console.error(`[fake-jev] listening on http://127.0.0.1:${PORT}/systemone`)
  console.error("[fake-jev] set JEV_API_KEY=demo and JEV_URL=http://127.0.0.1:8787/systemone")
})
