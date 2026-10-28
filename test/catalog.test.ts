import assert from "node:assert/strict"
import test from "node:test"
import { parseCatalog, pruneCatalog } from "../src/catalog.ts"
import { CATALOG } from "./fixtures.ts"

test("parseCatalog reads namespaces, entries and descriptions", () => {
  const catalog = parseCatalog(CATALOG)
  assert.ok(catalog)
  assert.equal(catalog.sections.length, 5)

  const postgres = catalog.sections.find((section) => section.namespace === "postgres")
  assert.ok(postgres)
  assert.equal(postgres.description, "Query and mutate Postgres databases.")
  assert.equal(postgres.total, 3)
  assert.equal(postgres.shown, 2)
  assert.deepEqual(
    postgres.entries.map((entry) => entry.toolName),
    ["query", "describe_table"],
  )
  assert.equal(postgres.entries[0]?.description, "Run a read-only SQL query.")
  assert.equal(postgres.entries[0]?.path, "postgres.query")

  const wrait = catalog.sections.find((section) => section.namespace === "wrait-mcp")
  assert.ok(wrait)
  assert.deepEqual(
    wrait.entries.map((entry) => entry.path),
    ["wrait-mcp.wrait_list_plugins", "wrait-mcp.wrait_refresh"],
  )

  const flat = catalog.sections.find((section) => section.namespace === "skill_validate")
  assert.ok(flat)
  assert.equal(flat.entries[0]?.toolName, "skill_validate")
  assert.equal(flat.entries[0]?.path, "skill_validate")

  const emptySample = catalog.sections.find((section) => section.namespace === "skill_optimize_loop")
  assert.ok(emptySample)
  assert.equal(emptySample.total, 1)
  assert.equal(emptySample.shown, 0)
  assert.deepEqual(emptySample.entries, [])

  assert.ok(catalog.prefix.includes("# Code Mode"))
  assert.ok(catalog.suffix.includes("<mcp_instructions>"))
})

test("pruneCatalog drops a namespace and an individual entry", () => {
  const pruned = pruneCatalog(CATALOG, {
    keepSection: (namespace) => namespace !== "wrait-mcp",
    keepEntry: (namespace, toolName) => !(namespace === "postgres" && toolName === "describe_table"),
  })

  assert.deepEqual(pruned.removedSections, ["wrait-mcp"])
  assert.deepEqual(pruned.removedEntries, [
    { namespace: "postgres", toolName: "describe_table" },
    { namespace: "wrait-mcp", toolName: "wrait_list_plugins" },
    { namespace: "wrait-mcp", toolName: "wrait_refresh" },
  ])

  assert.ok(!pruned.text.includes("- wrait-mcp"))
  assert.ok(!pruned.text.includes('tools["wrait-mcp"]'))
  assert.ok(!pruned.text.includes("describe_table"))
  assert.ok(pruned.text.includes("tools.postgres.query"))
  assert.ok(pruned.text.includes("- postgres (2 tools, 1 shown)"))
  assert.ok(pruned.text.includes("- opencode (2 tools, 1 shown)"))
  assert.ok(pruned.text.includes("<mcp_instructions>"))
  assert.ok(pruned.text.includes("Today's date"))
})

test("pruneCatalog reports no changes when everything is kept", () => {
  const pruned = pruneCatalog(CATALOG, {
    keepSection: () => true,
    keepEntry: () => true,
  })
  assert.equal(pruned.text, CATALOG)
  assert.deepEqual(pruned.removedSections, [])
  assert.deepEqual(pruned.removedEntries, [])
})

test("pruneCatalog replaces the catalog when every section is pruned", () => {
  const pruned = pruneCatalog(CATALOG, {
    keepSection: () => false,
    keepEntry: () => false,
  })
  assert.ok(pruned.text.includes("No Code Mode tools are currently available."))
  assert.ok(!pruned.text.includes("- opencode"))
  assert.ok(pruned.text.includes("<available_skills>"))
})
