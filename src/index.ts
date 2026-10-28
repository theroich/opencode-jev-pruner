import { appendFile } from "node:fs/promises"
import { Plugin } from "@opencode/plugin"
import { loadConfig } from "./config.ts"
import { JevClient } from "./jev.ts"
import { planPruning, type PruningReport, type PrunerEventLike } from "./pruner.ts"

const PREFIX = "[opencode-jev-pruner]"

export default Plugin.define({
  id: "opencode-jev-pruner",
  async setup(ctx) {
    const { config, disabledReason } = loadConfig(ctx.options ?? {}, process.env)

    if (config.debugLogFile !== undefined) {
      await writeDebugEvent(config.debugLogFile, {
        type: disabledReason === undefined ? "setup" : "disabled",
        ...(disabledReason === undefined ? {} : { reason: disabledReason }),
        model: config.model,
        endpoint: config.endpoint,
        threshold: config.threshold,
        phase1Threshold: config.phase1Threshold,
        twoPhase: config.twoPhase,
        timeoutMs: config.timeoutMs,
      })
    }

    if (disabledReason !== undefined) {
      console.error(`${PREFIX} disabled: ${disabledReason}`)
      return
    }

    const client = new JevClient({
      apiKey: config.apiKey,
      endpoint: config.endpoint,
      model: config.model,
      timeoutMs: config.timeoutMs,
    })

    // The first HTTPS call of a process pays DNS + TLS, which can eat the whole
    // timeout budget. Warm the connection once, off the request path.
    let cooldownUntil = 0
    if (config.warmupOnLoad) {
      const warmStartedAt = Date.now()
      void client
        .ask("warmup", { warmup: { type: "noul", instructions: "Is this a warmup request?" } })
        .then(
          () =>
            config.debugLogFile === undefined
              ? undefined
              : writeDebugEvent(config.debugLogFile, {
                  type: "warmup",
                  ok: true,
                  durationMs: Date.now() - warmStartedAt,
                }),
          async (error) => {
            cooldownUntil = Date.now() + config.failureCooldownMs
            console.error(`${PREFIX} warmup failed: ${messageOf(error)}`)
            if (config.debugLogFile !== undefined) {
              await writeDebugEvent(config.debugLogFile, {
                type: "warmup",
                ok: false,
                message: messageOf(error),
                durationMs: Date.now() - warmStartedAt,
              })
            }
          },
        )
    }

    const registration = await ctx.session.hook("context", async (event) => {
      const startedAt = performance.now()

      if (config.failureCooldownMs > 0 && Date.now() < cooldownUntil) {
        if (config.debug) {
          console.error(`${PREFIX} skipped: Jev failure cooldown active`)
        }
        if (config.debugLogFile !== undefined) {
          await writeDebugEvent(config.debugLogFile, {
            type: "skipped",
            reason: "failure cooldown active",
            retryInMs: Math.round(cooldownUntil - Date.now()),
          })
        }
        return
      }

      try {
        const plan = await planPruning(toPrunerEvent(event), {
          config,
          client,
          listTools: async () =>
            (await ctx.tool.list()).map((tool) => ({
              id: tool.id,
              name: tool.name,
              description: tool.description ?? "",
              ...(typeof tool.options?.namespace === "string"
                ? { namespace: tool.options.namespace }
                : {}),
              codemode: tool.options?.codemode !== false,
            })),
          listServers: async () => {
            const result = await ctx.mcp.list()
            return result.data.map((server) => ({
              name: server.name,
              // `pending` still means its tools may already be registered and
              // rendered in the request catalog, so only exclude `disabled`.
              connected: server.status.status !== "disabled",
            }))
          },
        })

        // Jev answered: leave the failure cooldown.
        cooldownUntil = 0

        if (config.debug) logReport(plan.report)
        if (config.debugLogFile !== undefined) {
          await writeDebugEvent(config.debugLogFile, {
            type: "report",
            applied: plan.applied,
            ...plan.report,
          })
        }

        if (!plan.applied) return

        event.system = plan.system as typeof event.system
        event.tools = plan.tools as typeof event.tools
      } catch (error) {
        // Fail open: a Jev outage, timeout or parser error must never block or
        // alter the request. The original event is untouched at this point.
        cooldownUntil = Date.now() + config.failureCooldownMs
        console.error(`${PREFIX} pruning failed open: ${messageOf(error)}`)
        if (config.debugLogFile !== undefined) {
          await writeDebugEvent(config.debugLogFile, {
            type: "error",
            sessionID: event.sessionID,
            message: messageOf(error),
            durationMs: Math.round(performance.now() - startedAt),
          })
        }
      }
    })

    return () => registration.dispose()
  },
})

function toPrunerEvent(event: {
  sessionID: string
  system: readonly { type: string; text: string; [key: string]: unknown }[]
  tools: Record<string, { description: string; input: unknown; [key: string]: unknown }>
  messages: readonly { role: string; content: unknown }[]
}): PrunerEventLike {
  return {
    sessionID: event.sessionID,
    system: event.system.map((part) => ({ ...part })),
    tools: { ...event.tools },
    messages: event.messages.map((message) => ({ role: message.role, content: message.content })),
  }
}

function logReport(report: PruningReport): void {
  const keptTools = report.tools.filter((tool) => tool.kept).length
  const prunedTools = report.tools.length - keptTools
  const keptSkills = report.skills.filter((skill) => skill.kept).length
  const prunedSkills = report.skills.length - keptSkills

  console.error(
    `${PREFIX} ${report.durationMs}ms, ${report.jevCalls} Jev call(s)${report.cached ? " (cached)" : ""}: ` +
      `catalog ${report.stats.catalogSections} section(s), ${report.stats.registeredTools} registered tool(s), ` +
      `servers ${report.servers.length - report.removed.servers.length}/${report.servers.length} kept, ` +
      `tools ${keptTools}/${report.tools.length} kept (${prunedTools} pruned), ` +
      `skills ${keptSkills}/${report.skills.length} kept (${prunedSkills} pruned)`,
  )

  for (const server of report.servers) {
    console.error(
      `  server ${formatScore(server.score)} ${server.kept ? "keep " : "PRUNE"} ${server.name} (${server.reason})`,
    )
  }
  for (const tool of report.tools) {
    console.error(
      `  tool   ${formatScore(tool.score)} ${tool.kept ? "keep " : "PRUNE"} ${tool.server}.${tool.name}` +
        `${tool.visible ? "" : " [not rendered]"}${tool.always ? " [always]" : ""}`,
    )
  }
  for (const skill of report.skills) {
    console.error(`  skill  ${formatScore(skill.score)} ${skill.kept ? "keep " : "PRUNE"} ${skill.id}`)
  }

  if (report.removed.mcpInstructions.length > 0) {
    console.error(`  mcp instructions removed: ${report.removed.mcpInstructions.join(", ")}`)
  }
}

function formatScore(score: number | undefined): string {
  return score === undefined ? "  n/a" : score.toFixed(3)
}

async function writeDebugEvent(path: string, event: Record<string, unknown>): Promise<void> {
  try {
    await appendFile(path, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`)
  } catch (error) {
    console.error(`${PREFIX} could not write debug log: ${messageOf(error)}`)
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
