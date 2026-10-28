# opencode-jev-pruner

Context pruning for [OpenCode V2](https://opencode.ai/v2/docs/build/plugins/server). Before every model call, the
plugin asks [Jev (TypeSafe System One)](https://opencode.ai/console) which MCP servers, MCP tools, and skills are
relevant to the current user prompt. Only candidates above a probability threshold stay in the outgoing request.

The plugin is a **context-only** middleware: OpenCode's tool registry, MCP connections, and RPC bridge are never
modified. If the model still calls a pruned tool by name, OpenCode can execute it; the tool is simply not advertised
in the prompt anymore.

## Why

Every connected MCP server contributes descriptions and JSON schemas to each request. With several servers this
becomes thousands of input tokens per turn and a wider action space that increases wrong-tool calls. Jev answers
`noul` (yes/no) questions in roughly 100 ms, so a fast first pass can remove whole servers and most skills without
blocking the turn.

## How it works

OpenCode V2 has two ways to expose tools:

1. **Code Mode** (default for MCP servers): MCP tools are grouped in a `<namespace>` catalog inside the system
   prompt and called through the `execute` tool. The plugin rewrites that catalog: it removes entire namespaces, and
   individual rendered tool entries inside surviving namespaces. It also removes the corresponding
   `<mcp_instructions>` block.
2. **Native tools** (`codemode: false`, or built-ins): tools are individual entries in `event.tools`. The plugin
   deletes the rejected MCP tools from that per-request map.

Skills are advertised in `<available_skills>` inside the same system prompt. The plugin removes rejected
`<skill>` entries; the skill registry and the `skill` tool stay intact.

### Two phases

```
user prompt ──► Phase 1 (one Jev request)
                 "Does this request need MCP server X?"
                 └─ servers below phase1_threshold are dropped entirely
                       │
                       ▼
                 Phase 2 (one Jev request)
                 "Does this request need tool T of server S?"  +  skill questions
                 └─ entries below threshold are pruned
```

Phase 1 is skipped when there is only one candidate MCP server. With `enable_two_phase_gating: false`, phase 2 scores
every candidate in a single request. Questions are batched (`max_questions_per_request`) and sent in parallel, each
with the configured timeout.

### Hooks

The plugin registers one OpenCode V2 hook:

```ts
await ctx.session.hook("context", async (event) => {
  // rewrite event.system (Code Mode catalog, mcp instructions, skills)
  // delete rejected keys from event.tools
})
```

`context` runs immediately before model dispatch and receives a mutable copy of the assembled system prompt, message
list, and tool map. Changes affect only that request. This is the same mechanism the official docs show with
`delete event.tools.write`.

## Install

The package exposes its server part through `package.json` `exports["."]`.

### From a local checkout

```jsonc title="opencode.jsonc"
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./path/to/opencode-jev-pruner",
      "options": {
        "jev_confidence_threshold": 0.55,
        "enable_two_phase_gating": true,
        "always_include_skills": ["core_system_skill", "error_recovery"],
        "debug_mode": false
      }
    }
  ]
}
```

### From npm

```jsonc title="opencode.jsonc"
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-jev-pruner"]
}
```

Either way, provide the API key through the environment (recommended, keeps secrets out of config):

```sh
export JEV_API_KEY="sk-..."
```

or through plugin options:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-jev-pruner",
      "options": { "jev_api_key": "sk-..." }
    }
  ]
}
```

OpenCode reloads plugins when config changes; no restart is needed.

### Try it from this repository

This repository includes a ready-to-use `opencode.json` at its root. `package: "."` loads the checkout through its
`package.json` `exports`:

```json title="opencode.json"
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": ".",
      "options": {
        "jev_confidence_threshold": 0.55,
        "enable_two_phase_gating": true,
        "debug_mode": true,
        "debug_log_file": "/tmp/jev-pruner.jsonl"
      }
    }
  ]
}
```

With a real key:

```sh
export JEV_API_KEY="sk-..."
opencode --standalone
```

Without spending Jev tokens, run the bundled deterministic stand-in in another terminal:

```sh
npm run fake-jev
# [fake-jev] listening on http://127.0.0.1:8787/systemone

JEV_API_KEY=demo \
JEV_URL=http://127.0.0.1:8787/systemone \
opencode --standalone
```

Then ask something that clearly targets one MCP server or skill, and inspect:

```sh
tail -f /tmp/jev-pruner.jsonl
```

The first line is a `setup` event (or `disabled` when no key is visible to the server). Each request then adds a
`report` event with `applied`, `stats`, `servers`, `tools`, `skills`, and `removed`. The stand-in is a keyword-overlap
heuristic, not a replacement for Jev; it exists only to verify loading, parsing, payload mutation, and fail-open
behaviour offline.

> Plugins run in the OpenCode **server**, not in the TUI process. If OpenCode is already running as a background
> service, it does not see `JEV_API_KEY` exported in another terminal. Either start it from the same shell
> (`opencode --standalone`) or put `jev_api_key` in the plugin options and let the config watcher reload the plugin.

## Configuration

Options use the snake_case names from the original spec. camelCase aliases are accepted too.

| Option | Env | Default | Description |
| --- | --- | --- | --- |
| `jev_api_key` | `JEV_API_KEY`, `TYPESAFE_API_KEY` | — | Required. Without it the plugin logs a warning and passes requests through unchanged. |
| `jev_endpoint` | `JEV_URL`, `JEV_ENDPOINT` | `https://opencode.ai/inference/systemone/v1/systemone` | Full Jev endpoint. |
| `jev_model` | `JEV_MODEL` | `jev-1.13` | Jev model. |
| `jev_confidence_threshold` | `JEV_CONFIDENCE_THRESHOLD` | `0.55` | Keep a tool or skill when `noul >= threshold`. |
| `jev_phase1_threshold` | `JEV_PHASE1_THRESHOLD` | `0.35` | Keep a server when `noul >= threshold`. Lower than phase 2 to avoid dropping a useful server. |
| `jev_timeout_ms` | `JEV_TIMEOUT_MS` | `900` | Per-request timeout. On timeout, the whole plan is discarded and the original payload is sent. The first call of a process pays DNS + TLS, so 400 ms is usually too tight; use `warmup_on_load` if you want a lower budget. |
| `enable_two_phase_gating` | — | `true` | Gate servers before scoring their tools. |
| `always_include_skills` | — | `["core_system_skill", "error_recovery"]` | Skill IDs/names that are never scored. `*` and `?` globs are accepted. |
| `always_include_tools` | — | `[]` | Tool names, IDs, `server.tool`, or `server_tool` patterns that are never scored. A server with an always-included tool is kept in phase 1. |
| `always_include_servers` | — | `["opencode"]` | MCP server names that are never gated. |
| `prune_mcp_tools` | — | `true` | Enable MCP server/tool pruning. |
| `prune_skills` | — | `true` | Enable skill pruning. |
| `debug_mode` | `JEV_PRUNER_DEBUG` | `false` | Print scores and decisions for each request. |
| `debug_log_file` | `JEV_PRUNER_DEBUG_LOG` | — | Append JSON events to this file: `setup`, `disabled`, `warmup`, `skipped`, `error`, and one `report` per request. |
| `warmup_on_load` | `JEV_WARMUP` | `false` | Send one tiny question at load so the first real request does not pay DNS + TLS inside its timeout. |
| `failure_cooldown_ms` | `JEV_FAILURE_COOLDOWN_MS` | `0` | After a Jev failure, skip pruning for this long instead of paying the timeout every turn. `0` keeps retrying each turn. |
| `max_questions_per_request` | — | `100` | Split large candidate sets into parallel Jev requests. |
| `max_description_chars` | — | `400` | Truncate descriptions embedded in Jev questions. |
| `max_prompt_chars` | — | `6000` | Truncate the user prompt used as Jev `state`. |
| `cache_ttl_ms` | — | `600000` | Reuse phase decisions for the same session, prompt, and candidate set. Set `0` to disable. |

### Example

```jsonc title="opencode.jsonc"
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-jev-pruner",
      "options": {
        "jev_confidence_threshold": 0.55,
        "jev_phase1_threshold": 0.35,
        "jev_timeout_ms": 400,
        "enable_two_phase_gating": true,
        "always_include_skills": ["core_system_skill", "error_recovery", "opencode"],
        "always_include_tools": ["opencode_*"],
        "debug_mode": false
      }
    }
  ]
}
```

## Fail-open behavior

The request is never blocked or degraded by the pruner:

- Missing API key → plugin disabled, payload untouched.
- Jev HTTP error, invalid JSON, timeout, or abort → the hook catches the error and leaves `event.system` and
  `event.tools` exactly as they were.
- Missing answers for an individual question → that candidate is kept (never pruned on absent evidence).
- Parser mismatch (for example a future Code Mode format) → no rewrite; the original prompt is sent.

Because the plan is built in memory and assigned only after every Jev call succeeds, a failure cannot produce a
half-pruned prompt.

## Jev request shape

For each phase the plugin sends the standard System One payload:

```json
{
  "model": "jev-1.13",
  "state": "<user prompt>",
  "questions": {
    "t0": {
      "type": "noul",
      "instructions": "Does the user's request require the tool \"query\" from the MCP server \"postgres\"? Tool purpose: Run a read-only SQL query."
    }
  }
}
```

The candidate key (`t0`) is not shown to the model; the item name is embedded in `instructions` on purpose, because
Jev shares one `state` across all questions. Responses are read from `answers.<key>.noul`.

## Debugging

```sh
export JEV_PRUNER_DEBUG=true
export JEV_PRUNER_DEBUG_LOG=/tmp/jev-pruner.jsonl
```

The console report looks like:

```
[opencode-jev-pruner] 212ms, 2 Jev call(s): servers 1/2 kept, tools 1/2 kept (1 pruned), skills 5/27 kept (22 pruned)
  server 0.050 PRUNE postgres (phase 1 rejected)
  server 0.950 keep  wrait-mcp (phase 1 passed)
  tool   0.910 keep  wrait-mcp.wrait_list_plugins
  tool   0.100 PRUNE wrait-mcp.wrait_refresh
  skill  0.900 keep  jev-cli
  skill  0.020 PRUNE ui-polish
  mcp instructions removed: postgres
```

Server logs are in `~/.local/share/opencode/log/opencode.log`.

Debug output includes the user prompt, tool names, and scores. Treat the debug log as sensitive and do not enable it
for prompts that contain secrets.

## Limitations (V1)

- **Code Mode catalog is a sample.** OpenCode renders only a subset of each namespace's tools and exposes the rest
  through `search(...)`. The plugin prunes whole namespaces and the rendered sample entries; it cannot remove hidden
  tools from the search index. The context savings come mainly from dropping entire namespaces.
- **Skills are unadvertised, not unregistered.** A model that already knows a skill ID can still load it with the
  `skill` tool. That matches the "context-only mutation" requirement.
- **Only `noul`.** `choice` and `score` are intentionally not used in V1.
- **No skill categories in V2.** The spec's phase 1 covers "skill categories", but OpenCode V2 exposes skills as a
  flat list with an id, name, and description. Phase 1 therefore gates MCP servers only; skills are scored
  individually in phase 2.
- **No MCP lifecycle changes.** Servers are never disconnected, restarted, or disabled.
- **Phase decisions are cached per turn.** Tool-driven continuations reuse the same scores when the prompt and
  candidate set are unchanged. Set `cache_ttl_ms: 0` to re-evaluate every step.

### Nothing appears in the debug log

The debug log is written by the plugin **inside the OpenCode server process**. A long-running background service keeps
the plugin instance (and its environment) from the moment it was started, so:

- Exporting `JEV_API_KEY` in another terminal does not reach an already running service.
- Editing the plugin sources does not re-run `setup` in the running service.

Fix it with a restart from a shell that has the key:

```sh
export JEV_API_KEY="sk-..."
opencode service restart
```

Or test against a private server, which always inherits the current shell:

```sh
JEV_API_KEY="sk-..." opencode --standalone run "¿De qué color son las nubes?"
```

Every load of the plugin appends a `setup` (or `disabled`) event, each request appends a `report` event, and a failed
Jev call appends an `error` event. If none of these appear, that server never ran this plugin.

The first request of a session can also show `candidates: 0`: MCP servers may still be `pending` while the prompt is
sent, so nothing is prunable yet. Ask a second time in the same session.

## Development

```sh
npm install
npm run typecheck
npm test
```

The tests cover the Code Mode catalog parser/rewriter, skills parser, MCP instruction removal, config precedence,
prompt extraction, the Jev client, fail-safe behavior, two-phase gating, always-include rules, and the
non-Code-Mode fallback.

## License

MIT
