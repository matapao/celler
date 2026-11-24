// A run checked and set up before its agent starts: its folder, its MCP servers' names, the places no run may be
// (sandbox/places.ts), its scratch, and the environments its agent starts in.

import { existsSync } from "node:fs"
import path from "node:path"
import type { Agent } from "./agents.js"
import { agentEnv, PROXIES, runEnv } from "./programs.js"
import { placesFor, removeScratch, scratchFor, unfitFolder, type Places } from "./sandbox/places.js"
import { errorText, type Host, type McpServerSpec, type RunSpec } from "./types.js"

/** What a run's MCP server may be named: its agent names the server's tools by it, as Codex does its settings' table. */
const SERVER_NAME = /^[A-Za-z0-9_-]+$/

/** Why a run's MCP servers can't be given to its agent as they are named, or null: each needs a name of its own. */
function misnamed(servers: McpServerSpec[]): string | null {
  const seen = new Set<string>()
  for (const { name } of servers) {
    if (!SERVER_NAME.test(name)) return `${JSON.stringify(name)} can't name one of the run's MCP servers: only letters, digits, "_" and "-" can`
    if (seen.has(name)) return `Two of the run's MCP servers are named ${name}: each needs a name of its own`
    seen.add(name)
  }
  return null
}

/** The agent's own home, as a run's environment names it: by the agent's own variables, else by the person's. */
function homeOf(agent: Agent, own: Record<string, string>): string[] {
  const named = own[agent.homeVariable] ?? process.env[agent.homeVariable]
  return named ? [named] : []
}

/** A run set up: its agent's program as it starts, its places, its environment, and the one its agent's own errands start in. */
interface SetUp {
  started: ReturnType<Agent["started"]>
  places: Places
  env: NodeJS.ProcessEnv
  errands: NodeJS.ProcessEnv
}

/** A run of the agent's program `found`, set up; or why it can't be, with nothing made for it left behind. */
export function setUp(agent: Agent, found: string, spec: RunSpec, host: Host): SetUp | string {
  if (!existsSync(spec.cwd)) return `Workspace folder not found: ${spec.cwd}`
  const stdio = spec.mcpServers.find((s) => s.transport === "stdio")
  if (stdio) return `${stdio.name}: a connector's program is started by the host, never by the agent`
  const unnamed = misnamed(spec.mcpServers)
  if (unnamed) return unnamed
  let scratch: Places["scratch"] | undefined
  try {
    agent.ready?.()
    const started = agent.started(found)
    const own = agent.env(host)
    // Where no run may be, by any of its names (sandbox/places.ts): checked for its folder, and for each the host adds.
    const agentHomes = homeOf(agent, own)
    const unfit = unfitFolder(spec.cwd, agentHomes) ?? (spec.readable ?? []).map((place) => unfitFolder(place, agentHomes, "read")).find((why) => why !== null)
    if (unfit) return unfit
    // Its own scratch folder inside its folder, removed when it ends, and where its commands may go (sandbox/places.ts).
    scratch = scratchFor(spec.cwd)
    // The folders its program needs on PATH, then the person's: its programs' folders in the home are read again.
    const runPath = [...started.path, process.env.PATH ?? ""].join(path.delimiter)
    const places = placesFor({ folder: spec.cwd, scratch, agentHomes, path: runPath, readable: spec.readable, hidden: PROXIES.filter((name) => process.env[name] !== undefined) })
    // Its own user's environment, marked as the host's run, on that PATH; and the one its own errands start in (its
    // version).
    const env = runEnv({ ...own, PATH: runPath }, host, places)
    const errands = agentEnv(own, host)
    return { started, places, env, errands }
  } catch (err) {
    // What was made for it goes with it.
    if (scratch) void removeScratch(scratch)
    return `${agent.name} could not be set up for this run: ${errorText(err)}`
  }
}
