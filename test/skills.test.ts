import assert from "node:assert/strict"
import test from "node:test"
import { pruneMcpInstructions } from "../src/mcp-instructions.ts"
import { parseSkills, pruneSkills } from "../src/skills.ts"
import { CATALOG } from "./fixtures.ts"

test("parseSkills reads id, name and description", () => {
  const parsed = parseSkills(CATALOG)
  assert.ok(parsed)
  assert.deepEqual(
    parsed.entries.map((entry) => entry.id),
    ["postgres-tuning", "ui-polish"],
  )
  assert.equal(parsed.entries[0]?.name, "Postgres Tuning")
  assert.equal(parsed.entries[0]?.description, "Index and query tuning for Postgres.")
})

test("pruneSkills removes only the rejected entries", () => {
  const pruned = pruneSkills(CATALOG, (skill) => skill.id !== "ui-polish")
  assert.deepEqual(pruned.removed.map((entry) => entry.id), ["ui-polish"])
  assert.ok(pruned.text.includes("<id>postgres-tuning</id>"))
  assert.ok(!pruned.text.includes("ui-polish"))
  assert.ok(!pruned.text.includes("UI Polish"))
  assert.ok(pruned.text.includes("</available_skills>"))
})

test("pruneSkills replaces the list when every skill is rejected", () => {
  const pruned = pruneSkills(CATALOG, () => false)
  assert.equal(pruned.removed.length, 2)
  assert.ok(pruned.text.includes("No skills are currently available."))
  assert.ok(!pruned.text.includes("<available_skills>"))
})

test("pruneMcpInstructions removes individual servers", () => {
  const next = pruneMcpInstructions(CATALOG, new Set(["postgres"]))
  assert.ok(!next.includes('<server name="postgres">'))
  assert.ok(next.includes('<server name="wrait-mcp">'))
  assert.ok(next.includes("</mcp_instructions>"))
})

test("pruneMcpInstructions removes the wrapper when every server is gone", () => {
  const next = pruneMcpInstructions(CATALOG, new Set(["postgres", "wrait-mcp"]))
  assert.ok(!next.includes("<mcp_instructions>"))
  assert.ok(!next.includes("</mcp_instructions>"))
  assert.ok(next.includes("<available_skills>"))
})
