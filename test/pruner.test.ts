import assert from "node:assert/strict"
import test from "node:test"
import { loadConfig } from "../src/config.ts"
import type { NoulQuestion } from "../src/jev.ts"
import { planPruning, type PrunerEventLike, type PrunerServerInfo, type PrunerToolInfo } from "../src/pruner.ts"
import { CATALOG } from "./fixtures.ts"

const servers: PrunerServerInfo[] = [
  { name: "postgres", connected: true },
  { name: "wrait-mcp", connected: true },
]

const tools: PrunerToolInfo[] = [
  {
    id: "postgres_query",
    name: "query",
    namespace: "postgres",
    codemode: true,
    description: "Run a read-only SQL query.",
  },
  {
    id: "postgres_describe_table",
    name: "describe_table",
    namespace: "postgres",
    codemode: true,
    description: "Describe a table.",
  },
  {
    id: "wrait-mcp_wrait_list_plugins",
    name: "wrait_list_plugins",
    namespace: "wrait-mcp",
    codemode: true,
    description: "List all plugin definitions.",
  },
  {
    id: "wrait-mcp_wrait_refresh",
    name: "wrait_refresh",
    namespace: "wrait-mcp",
    codemode: true,
    description: "Force a refresh.",
  },
  {
    id: "opencode_session_move",
    name: "session_move",
    namespace: "opencode",
    codemode: true,
    description: "Move a session.",
  },
  { id: "read", name: "read", codemode: false, description: "Read a file." },
]

function event(id: string): PrunerEventLike {
  return {
    sessionID: id,
    system: [{ type: "text", text: CATALOG }],
    tools: {},
    messages: [{ role: "user", content: [{ type: "text", text: "Tune the slow Postgres query" }] }],
  }
}

function fakeClient(answer: (question: NoulQuestion) => number | undefined, calls: NoulQuestion[][] = []) {
  return {
    calls,
    async ask(_state: string, questions: Record<string, NoulQuestion>) {
      const batch = Object.values(questions)
      calls.push(batch)
      const scores: Record<string, number> = {}
      for (const [key, question] of Object.entries(questions)) {
        const score = answer(question)
        if (score !== undefined) scores[key] = score
      }
      return scores
    },
  }
}

function config(overrides: Record<string, unknown> = {}) {
  return loadConfig({ jev_api_key: "sk-test", ...overrides }, {}).config
}

function deps(client: ReturnType<typeof fakeClient>, overrides: Record<string, unknown> = {}) {
  return {
    config: config(overrides),
    client,
    listTools: async () => tools,
    listServers: async () => servers,
    now: () => 0,
  }
}

test("two-phase gating removes an irrelevant server and low-confidence tools/skills", async () => {
  const client = fakeClient((question) => {
    if (question.instructions.includes('MCP server "postgres"')) return 0.05
    if (question.instructions.includes('MCP server "wrait-mcp"')) return 0.95
    if (question.instructions.includes('"query"')) return 0.9
    if (question.instructions.includes('"describe_table"')) return 0.1
    if (question.instructions.includes('"wrait_list_plugins"')) return 0.9
    if (question.instructions.includes('"wrait_refresh"')) return 0.8
    if (question.instructions.includes('"postgres-tuning"')) return 0.9
    if (question.instructions.includes('"ui-polish"')) return 0.1
    return undefined
  })

  const result = await planPruning(event("two-phase"), deps(client))

  assert.equal(result.applied, true)
  assert.ok(!result.system[0]?.text.includes("- postgres"))
  assert.ok(!result.system[0]?.text.includes('server name="postgres"'))
  assert.ok(result.system[0]?.text.includes("- wrait-mcp (2 tools)"))
  assert.ok(result.system[0]?.text.includes('tools["wrait-mcp"].wrait_refresh'))
  assert.ok(!result.system[0]?.text.includes("<id>ui-polish</id>"))
  assert.ok(result.system[0]?.text.includes("<id>postgres-tuning</id>"))
  assert.deepEqual(result.report.removed.servers, ["postgres"])
  assert.deepEqual(result.report.removed.skills, ["ui-polish"])
  assert.ok(result.report.removed.tools.includes("postgres.query"))
  assert.ok(result.report.removed.tools.includes("postgres.describe_table"))
  assert.ok(!result.report.tools.some((tool) => tool.server === "opencode"))
  assert.equal(result.report.jevCalls, 2)
})

test("always_include_tools keeps a tool and its server, always_include_skills keeps a skill", async () => {
  const client = fakeClient((question) => {
    if (question.instructions.includes('MCP server "postgres"')) return 0.01
    if (question.instructions.includes('"query"')) return 0.1
    if (question.instructions.includes('"postgres-tuning"')) return 0.1
    if (question.instructions.includes('"describe_table"')) return 0.01
    if (question.instructions.includes('"ui-polish"')) return 0.01
    return 0.9
  })

  const result = await planPruning(
    event("always"),
    deps(client, {
      always_include_tools: ["postgres.describe_table"],
      always_include_skills: ["ui-polish"],
    }),
  )

  assert.ok(result.system[0]?.text.includes("- postgres"))
  assert.ok(result.system[0]?.text.includes("tools.postgres.describe_table"))
  assert.ok(result.system[0]?.text.includes("<id>ui-polish</id>"))
  assert.equal(result.report.servers.find((server) => server.name === "postgres")?.kept, true)
  assert.equal(
    result.report.tools.find((tool) => tool.name === "describe_table")?.always,
    true,
  )
  assert.ok(!result.report.skills.find((skill) => skill.id === "ui-polish")?.score)
})

test("non-Code-Mode MCP tools are removed from the request tools map only", async () => {
  const plainEvent: PrunerEventLike = {
    sessionID: "plain",
    system: [{ type: "text", text: "You are a helpful agent." }],
    tools: {
      postgres_query: { description: "Query", input: {} },
      postgres_restore: { description: "Restore", input: {} },
      read: { description: "Read a file", input: {} },
    },
    messages: [{ role: "user", content: [{ type: "text", text: "Read a file" }] }],
  }
  const plainTools: PrunerToolInfo[] = [
    {
      id: "postgres_query",
      name: "query",
      namespace: "postgres",
      codemode: false,
      description: "Query",
    },
    {
      id: "postgres_restore",
      name: "restore",
      namespace: "postgres",
      codemode: false,
      description: "Restore",
    },
    { id: "read", name: "read", codemode: false, description: "Read a file" },
  ]
  const client = fakeClient((question) => (question.instructions.includes('"query"') ? 0.9 : 0.1))

  const result = await planPruning(plainEvent, {
    config: config({ enable_two_phase_gating: false }),
    client,
    listTools: async () => plainTools,
    listServers: async () => servers,
    now: () => 0,
  })

  assert.equal(result.applied, true)
  assert.deepEqual(Object.keys(result.tools), ["postgres_query", "read"])
  assert.equal(result.system[0]?.text, "You are a helpful agent.")
  assert.deepEqual(result.report.removed.tools, ["postgres.restore"])
})

test("fallback detects non-Code-Mode MCP tools when the registry snapshot lags", async () => {
  const plainEvent: PrunerEventLike = {
    sessionID: "lagging-registry",
    system: [{ type: "text", text: "Hello" }],
    tools: {
      postgres_query: { description: "Query", input: {} },
      postgres_restore: { description: "Restore", input: {} },
      read: { description: "Read a file", input: {} },
    },
    messages: [{ role: "user", content: [{ type: "text", text: "Read a file" }] }],
  }
  const client = fakeClient((question) => (question.instructions.includes('"query"') ? 0.9 : 0.1))

  const result = await planPruning(plainEvent, {
    config: config({ enable_two_phase_gating: false }),
    client,
    listTools: async () => [{ id: "read", name: "read", codemode: false, description: "Read a file." }],
    listServers: async () => servers,
    now: () => 0,
  })

  assert.deepEqual(Object.keys(result.tools), ["postgres_query", "read"])
  assert.deepEqual(result.report.removed.tools, ["postgres.restore"])
})

test("missing Jev answers keep tools and skills (fail safe)", async () => {
  const client = fakeClient(() => undefined)
  const result = await planPruning(event("missing"), deps(client, { enable_two_phase_gating: false }))
  assert.equal(result.applied, false)
  assert.equal(result.system[0]?.text, CATALOG)
})

test("a Jev failure rejects and leaves the caller's event untouched", async () => {
  const original = event("failure")
  const snapshot = JSON.stringify(original)
  const client = {
    async ask(): Promise<Record<string, number>> {
      throw new Error("timeout")
    },
  }

  await assert.rejects(() =>
    planPruning(original, {
      config: config(),
      client,
      listTools: async () => tools,
      listServers: async () => servers,
      now: () => 0,
    }),
  )
  assert.equal(JSON.stringify(original), snapshot)
})

test("two-phase disabled scores tools and skills in one request", async () => {
  const client = fakeClient((question) => {
    if (question.instructions.includes('"ui-polish"')) return 0.01
    return 0.9
  })
  const result = await planPruning(
    event("single-phase"),
    deps(client, { enable_two_phase_gating: false }),
  )
  assert.equal(result.report.jevCalls, 1)
  assert.ok(result.system[0]?.text.includes("- postgres"))
  assert.ok(!result.system[0]?.text.includes("<id>ui-polish</id>"))
})
