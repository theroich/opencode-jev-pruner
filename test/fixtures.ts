export const CATALOG = `# Code Mode

Use the \`execute\` tool to call the tools listed below.

## Available tools

- opencode (2 tools, 1 shown) // OpenCode built-in tools.
  - tools.opencode.session_move({
  sessionID?: string,
  directory: string,
}): Promise<{ sessionID: string; directory: string }> // Move a session to another directory.
- postgres (3 tools, 2 shown) // Query and mutate Postgres databases.
  - tools.postgres.query({
  sql: string,
}): Promise<unknown[]> // Run a read-only SQL query.
  - tools.postgres.describe_table({ table: string }): Promise<unknown> // Describe a table.
- wrait-mcp (2 tools) // Remote skills repository.
  - tools["wrait-mcp"].wrait_list_plugins(): Promise<unknown> // List all plugin definitions.
  - tools["wrait-mcp"].wrait_refresh(): Promise<unknown> // Force a refresh.
- skill_optimize_loop (1 tool, none shown)
- skill_validate (1 tool)
  - tools.skill_validate({ skillPath: string }): Promise<string | null> // Validate a skill directory.

<mcp_instructions>
  <server name="postgres">
    Prefer read-only queries unless the user asks for a mutation.
  </server>
  <server name="wrait-mcp">
    Use the repository tools before editing local skills.
  </server>
</mcp_instructions>

Skills provide specialized instructions and workflows for specific tasks.
Use the skill tool to load a skill when a task matches its description.
<available_skills>
  <skill>
    <id>postgres-tuning</id>
    <name>Postgres Tuning</name>
    <description>Index and query tuning for Postgres.</description>
  </skill>
  <skill>
    <id>ui-polish</id>
    <name>UI Polish</name>
    <description>Improve visual polish of web interfaces.</description>
  </skill>
</available_skills>

Today's date: Wed Oct 28 2026
`
