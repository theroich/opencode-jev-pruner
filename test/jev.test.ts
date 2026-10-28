import assert from "node:assert/strict"
import test from "node:test"
import { JevClient, JevError } from "../src/jev.ts"

test("JevClient sends the documented request and parses noul answers", async () => {
  let seen: { url: string; init: RequestInit | undefined } | undefined
  const client = new JevClient({
    apiKey: "sk-test",
    endpoint: "https://example.test/systemone",
    model: "jev-1.13",
    timeoutMs: 400,
    fetchImpl: async (url, init) => {
      seen = { url: String(url), init }
      return new Response(
        JSON.stringify({
          model: "jev-1.13",
          answers: {
            t0: { type: "noul", noul: 0.91 },
            t1: { type: "noul", noul: 1.4 },
            t2: { type: "noul" },
          },
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
        { status: 200 },
      )
    },
  })

  const scores = await client.ask("fix the UI", {
    t0: { type: "noul", instructions: "Does it need the UI tool?" },
    t1: { type: "noul", instructions: "Does it need the DB tool?" },
    t2: { type: "noul", instructions: "Does it need git?" },
  })

  assert.equal(seen?.url, "https://example.test/systemone")
  const body = JSON.parse(String(seen?.init?.body)) as {
    model: string
    state: string
    questions: Record<string, { type: string; instructions: string }>
  }
  assert.equal(body.model, "jev-1.13")
  assert.equal(body.state, "fix the UI")
  assert.equal(body.questions.t0?.instructions, "Does it need the UI tool?")
  assert.equal((seen?.init?.headers as Record<string, string>).Authorization, "Bearer sk-test")

  assert.deepEqual(scores, { t0: 0.91, t1: 1 })
})

test("JevClient throws a JevError on an HTTP error", async () => {
  const client = new JevClient({
    apiKey: "sk-test",
    endpoint: "https://example.test/systemone",
    model: "jev-1.13",
    timeoutMs: 400,
    fetchImpl: async () => new Response('{"error":{"code":"bad_key"}}', { status: 401 }),
  })
  await assert.rejects(
    () => client.ask("x", { t0: { type: "noul", instructions: "y" } }),
    (error: unknown) => error instanceof JevError && error.statusCode === 401,
  )
})

test("JevClient throws a JevError on malformed JSON", async () => {
  const client = new JevClient({
    apiKey: "sk-test",
    endpoint: "https://example.test/systemone",
    model: "jev-1.13",
    timeoutMs: 400,
    fetchImpl: async () => new Response("not json", { status: 200 }),
  })
  await assert.rejects(
    () => client.ask("x", { t0: { type: "noul", instructions: "y" } }),
    (error: unknown) => error instanceof JevError && /invalid JSON/.test(error.message),
  )
})

test("JevClient does not call the API when there are no questions", async () => {
  let called = false
  const client = new JevClient({
    apiKey: "sk-test",
    endpoint: "https://example.test/systemone",
    model: "jev-1.13",
    timeoutMs: 400,
    fetchImpl: async () => {
      called = true
      return new Response("{}", { status: 200 })
    },
  })
  assert.deepEqual(await client.ask("x", {}), {})
  assert.equal(called, false)
})
