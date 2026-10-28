import assert from "node:assert/strict"
import test from "node:test"
import { loadConfig, DEFAULTS } from "../src/config.ts"
import { extractUserPrompt } from "../src/prompt.ts"
import { matchesPattern } from "../src/match.ts"

test("loadConfig applies defaults and reads env", () => {
  const loaded = loadConfig({}, { JEV_API_KEY: "sk-test" })
  assert.equal(loaded.disabledReason, undefined)
  assert.equal(loaded.config.apiKey, "sk-test")
  assert.equal(loaded.config.endpoint, DEFAULTS.endpoint)
  assert.equal(loaded.config.threshold, 0.55)
  assert.equal(loaded.config.twoPhase, true)
  assert.deepEqual(loaded.config.alwaysIncludeSkills, ["core_system_skill", "error_recovery"])
})

test("loadConfig prefers plugin options and accepts snake_case", () => {
  const loaded = loadConfig(
    {
      jev_api_key: "sk-option",
      jev_confidence_threshold: 0.8,
      enable_two_phase_gating: false,
      always_include_skills: "a, b",
      debug_mode: true,
      jev_timeout_ms: 250,
    },
    { JEV_API_KEY: "sk-env", JEV_CONFIDENCE_THRESHOLD: "0.1" },
  )
  assert.equal(loaded.config.apiKey, "sk-option")
  assert.equal(loaded.config.threshold, 0.8)
  assert.equal(loaded.config.twoPhase, false)
  assert.deepEqual(loaded.config.alwaysIncludeSkills, ["a", "b"])
  assert.equal(loaded.config.debug, true)
  assert.equal(loaded.config.timeoutMs, 250)
})

test("loadConfig clamps thresholds and disables without a key", () => {
  const loaded = loadConfig({ jev_confidence_threshold: 42 }, {})
  assert.ok(loaded.disabledReason)
  assert.equal(loaded.config.threshold, 1)
})

test("loadConfig reads env, warmup, and the failure cooldown", () => {
  const env = loadConfig({}, { JEV_API_KEY: "sk-test", JEV_WARMUP: "true", JEV_FAILURE_COOLDOWN_MS: "30000" })
  assert.equal(env.config.warmupOnLoad, true)
  assert.equal(env.config.failureCooldownMs, 30000)

  const options = loadConfig(
    { jev_api_key: "sk-test", warmup_on_load: false, failure_cooldown_ms: 5000, jev_timeout_ms: 1500 },
    { JEV_WARMUP: "true", JEV_FAILURE_COOLDOWN_MS: "30000", JEV_TIMEOUT_MS: "9999" },
  )
  assert.equal(options.config.warmupOnLoad, false)
  assert.equal(options.config.failureCooldownMs, 5000)
  assert.equal(options.config.timeoutMs, 1500)

  const defaults = loadConfig({ jev_api_key: "sk-test" }, {})
  assert.equal(defaults.config.timeoutMs, DEFAULTS.timeoutMs)
  assert.equal(defaults.config.warmupOnLoad, false)
  assert.equal(defaults.config.failureCooldownMs, 0)
})

test("extractUserPrompt uses the last user message and ignores tool messages", () => {
  const prompt = extractUserPrompt(
    [
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
      { role: "user", content: [{ type: "text", text: "second" }, { type: "text", text: "line" }] },
      { role: "tool", content: [{ type: "text", text: "tool output" }] },
    ],
    1_000,
  )
  assert.equal(prompt, "second\nline")
})

test("extractUserPrompt truncates and returns empty when there is no user text", () => {
  assert.equal(
    extractUserPrompt([{ role: "user", content: [{ type: "text", text: "abcdef" }] }], 4),
    "abcd",
  )
  assert.equal(extractUserPrompt([{ role: "assistant", content: "hi" }], 100), "")
})

test("matchesPattern supports wildcards and is case insensitive", () => {
  assert.equal(matchesPattern("postgres_query", "postgres_*"), true)
  assert.equal(matchesPattern("Postgres_Query", "postgres_?"), false)
  assert.equal(matchesPattern("git-commit", "GIT-*"), true)
  assert.equal(matchesPattern("git-commit", "git-commit"), true)
})
