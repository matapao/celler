// The two coding agents, Claude Code and Codex, as data: what each needs found, how it says its version and whether it
// is signed in, how it signs in, and what one run starts with. One runtime runs either (runtime.ts). Each works with its
// own tools in the run's folder, its commands in its own sandbox at its strictest, as the settings files for each
// system say (sandbox/claude.*.ts, sandbox/codex.*.ts); everything outside the folder goes through the run's MCP tools.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { harnessLimits } from "../limits.js"
import { findProgram, launchFor, realProgram } from "./programs.js"
import claudeOnLinux from "./sandbox/claude.linux.js"
import claudeOnMacos from "./sandbox/claude.macos.js"
import claudeOnWindows from "./sandbox/claude.windows.js"
import * as codexOnLinux from "./sandbox/codex.linux.js"
import * as codexOnMacos from "./sandbox/codex.macos.js"
import * as codexOnWindows from "./sandbox/codex.windows.js"
import { inside, type Places } from "./sandbox/places.js"
import { isTier, type ClaudeWords, type CodexWords, type ModelTier, type RunSpec, type RuntimeHealth } from "./types.js"

/** An agent's ACP adapter, as the host ships it, and its own program, which the adapter runs. */
export type Found = { adapter: string; program: string }
/** What the host says when one isn't there, and what it offers. */
export type Missing = { missing: string; fix?: RuntimeHealth["fix"]; path?: string }

/** What one run starts with, beyond what every run has. */
export interface Start {
  env?: Record<string, string>
  /** session/new's _meta: the agent's own options. */
  meta?: Record<string, unknown>
  /** Selected through the session's model option. */
  model?: string
  /** The mode the run starts in: switched to, or the run stops before its prompt. */
  mode: string
  /** The run's instructions ahead of its prompt, for an agent without a system prompt. */
  preamble?: string
  /** Where usage reports name the model. */
  modelKey?: string
  /** A changed file as the run reports it, or null when it isn't the run's. */
  file?: (file: string) => string | null
}

export interface Agent {
  kind: string
  name: string
  /** Its process, in messages. */
  label: string
  find(): Found | Missing
  /** Its own program alone, for its sign-in. */
  program(): string | { error: string }
  /** Made ready before each start: a run, its sign-in, its health check. */
  ready?(): void
  /** Added to its environment whenever it starts ('' removes a variable). */
  env(program: string): Record<string, string>
  version(found: Found, ask: (file: string, args: string[]) => Promise<string | null>): Promise<string | { error: string }>
  /** Asked of its program; `yes` reads the answer: signed in, not, or null when it can't tell. */
  signedIn: { args: string[]; anyExit?: boolean; yes(answer: string | null): boolean | null }
  login: { args: string[]; fix: RuntimeHealth["fix"]; signedOut: string; hint: string }
  testRunMs: number
  /** Connector values reach it as placeholders it expands from its environment, else as they are. */
  placeholders: boolean
  /** It searches its MCP tools itself, loading only those it needs: a run lists them all to it, not celler's menu. */
  nativeDiscovery: boolean
  /** What one run starts with, in the places it may use (sandbox/places.ts); throws when it can't. */
  start(spec: RunSpec, found: Found, places: Places): Start
}

/** Each harness's settings for each system it runs on: one file each, data only (sandbox/). */
const CLAUDE_ON: Partial<Record<NodeJS.Platform, typeof claudeOnMacos>> = { darwin: claudeOnMacos, linux: claudeOnLinux, win32: claudeOnWindows }
const CODEX_ON: Partial<Record<NodeJS.Platform, typeof codexOnMacos>> = { darwin: codexOnMacos, linux: codexOnLinux, win32: codexOnWindows }

/** The settings file for this system, or why there is none: nothing runs where no sandbox is set up. */
function forThisSystem<T>(files: Partial<Record<NodeJS.Platform, T>>, name: string, platform: NodeJS.Platform = process.platform): T {
  const file = files[platform]
  if (!file) throw new Error(`${name} has no sandbox settings for ${platform} here`)
  return file
}

// ---------------------------------------------------------------- Claude Code

const CLAUDE_MODELS: Record<ModelTier, string> = { fast: "haiku", balanced: "sonnet", strong: "opus" }

/** Its own sign-in only: a key or token from the shell would win over it, and an endpoint from the shell would get it. */
const OWN_SIGN_IN = { ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_BASE_URL: "", CLAUDE_CODE_USE_BEDROCK: "", CLAUDE_CODE_USE_VERTEX: "" }

/**
 * Claude Code's options in session/new, handed to the Agent SDK after the adapter's defaults, on every system; what its
 * sandbox and its own tools may do is in its settings file for the system (sandbox/claude.*.ts).
 * - No settings files: a folder's own would run hooks and helpers outside what the host set.
 * - Only the host's connectors: not the person's own MCP servers.
 * - No mode that skips the questions.
 */
const CLAUDE_OPTIONS = { settingSources: [], strictMcpConfig: true, allowDangerouslySkipPermissions: false }

/** Claude Code, the person's own, through the adapter the host ships. */
export function claudeAgent(o: { adapter?: string | null; claude?: () => string | null; words: ClaudeWords }): Agent {
  const program = () => (o.claude ? o.claude() : findProgram("claude"))
  return {
    kind: "claude-code",
    name: "Claude Code",
    label: "claude-agent-acp",
    find: () => {
      if (!o.adapter || !existsSync(o.adapter)) return { missing: o.words.noAdapter }
      const claude = program()
      return claude ? { adapter: o.adapter, program: claude } : { missing: o.words.noClaude, fix: "find-claude", path: o.adapter }
    },
    program: () => program() ?? { error: o.words.noClaude },
    env: (claude) => ({ CLAUDE_CODE_EXECUTABLE: realProgram(claude), ...OWN_SIGN_IN }),
    version: async (found, ask) => {
      const [adapter, claude] = await Promise.all([ask(found.adapter, ["--version"]), ask(found.program, ["--version"])])
      if (!adapter) return { error: `Could not run ${found.adapter} --version.` }
      if (!claude) return { error: `Could not run ${found.program} --version.` }
      return `claude-agent-acp ${adapter} · ${claude}`
    },
    signedIn: { args: ["auth", "status", "--json"], anyExit: true, yes: (answer) => loggedIn(answer) },
    login: { args: ["auth", "login", "--claudeai"], fix: "login", signedOut: "not logged in to Claude", hint: o.words.login },
    testRunMs: harnessLimits.claudeTestRunMs,
    placeholders: true,
    // Its ToolSearch.
    nativeDiscovery: true,
    start: (spec, found, places) => {
      const model = isTier(spec.model) ? CLAUDE_MODELS[spec.model] : spec.model
      // The run's own MCP servers are the host's, which gate each call themselves: Claude Code doesn't ask again.
      const allowedTools = spec.mcpServers.map((s) => `mcp__${s.name}`)
      const base = { ...CLAUDE_OPTIONS, ...(model ? { model } : {}), allowedTools }
      const meta = (options: object) => ({ ...(spec.systemPrompt ? { systemPrompt: { append: spec.systemPrompt } } : {}), claudeCode: { options } })
      // A model-only decision: no tools at all, so nothing to keep in a sandbox.
      if (spec.purpose === "inference") {
        const options = { ...base, tools: [], settings: { disableClaudeAiConnectors: true, autoMemoryEnabled: false } }
        return { meta: meta(options), ...(model ? { model } : {}), mode: "default", modelKey: "_claude/model" }
      }
      // At work or to read, whatever a host says: its settings file for this system. Never Auto, where Claude Code's own
      // classifier would answer what asks.
      const { sandbox, settings, disallowedTools, mode, env: own } = forThisSystem(CLAUDE_ON, "Claude Code")(places, spec.purpose === "work" ? "work" : "read")
      // Electron's node mode must not reach its commands; on Windows the bootstrap takes it out (windowless.ts).
      // nosemgrep: semgrep.binary-as-node
      const env = launchFor(found.adapter).node && process.platform !== "win32" ? { env: { ELECTRON_RUN_AS_NODE: "" } } : {}
      const options = { ...base, sandbox, settings, disallowedTools, ...env }
      return { env: own, meta: meta(options), ...(model ? { model } : {}), mode, modelKey: "_claude/model" }
    },
  }
}

function loggedIn(answer: string | null): boolean | null {
  try {
    const status = JSON.parse(answer ?? "")
    return typeof status?.loggedIn === "boolean" ? status.loggedIn : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- Codex

const CODEX_MODELS: Record<ModelTier, string> = { fast: "gpt-6-luna", balanced: "gpt-6.1-sol", strong: "gpt-6-astra" }

/** The model a tier runs on, as each agent names it. */
export const tierModel = (agent: "claude" | "codex", tier: ModelTier): string => (agent === "codex" ? CODEX_MODELS : CLAUDE_MODELS)[tier]

/**
 * The `config.toml` of the host's Codex home, written before every start of Codex: its settings file for the system
 * (sandbox/codex.*.ts), the profiles a run works or reads in. Its sign-in stays in this home.
 */
export function codexHomeConfig(profile: string, platform: NodeJS.Platform = process.platform): string {
  return forThisSystem(CODEX_ON, "Codex", platform).home(profile)
}

/**
 * Codex, the person's own CLI, through the adapter the host ships, in the host's Codex home (`home`), in the host's
 * permission profile (`profile`), and only in a folder the person trusts, as Codex loads a folder's own settings.
 */
export function codexAgent(o: { adapter?: string | null; codex?: () => string | null; home: string; profile: string; words: CodexWords }): Agent {
  const program = () => (o.codex ? o.codex() : findProgram("codex"))
  const notFound = `Codex wasn't found on this computer. ${o.words.install}`
  return {
    kind: "codex",
    name: "Codex",
    label: "Codex",
    find: () => {
      const codex = o.adapter && existsSync(o.adapter) ? program() : null
      return codex ? { adapter: o.adapter!, program: codex } : { missing: notFound, fix: "find-codex" }
    },
    program: () => program() ?? { error: notFound },
    ready: () => {
      mkdirSync(o.home, { recursive: true })
      const file = path.join(o.home, "config.toml")
      const config = codexHomeConfig(o.profile)
      if (!existsSync(file) || readFileSync(file, "utf8") !== config) writeFileSync(file, config)
    },
    env: (codex) => ({ CODEX_HOME: o.home, CODEX_PATH: codex }),
    version: async (found, ask) => {
      const said = await ask(found.program, ["--version"])
      // "codex-cli 0.160.1" is Codex 0.160.1.
      return said ? `Codex ${said.split("\n")[0].replace(/^[\w-]+-cli\s+/, "")}` : { error: `Could not run ${found.program} --version.` }
    },
    signedIn: { args: ["login", "status"], yes: (answer) => answer !== null },
    login: { args: ["login"], fix: "login-codex", signedOut: o.words.signedOut, hint: o.words.login },
    testRunMs: harnessLimits.codexTestRunMs,
    placeholders: false,
    // Its tool_search, over MCP tools it always defers.
    nativeDiscovery: true,
    start: (spec, _found, places) => {
      if (!spec.trusted && spec.purpose !== "inference") throw new Error(o.words.untrusted)
      const model = isTier(spec.model) ? CODEX_MODELS[spec.model] : spec.model
      const working = spec.purpose === "work"
      // The run's own places, as its settings file for this system puts them; a model-only decision runs no command.
      const own = spec.purpose === "inference" ? { features: { shell_tool: false } } : forThisSystem(CODEX_ON, "Codex").run(places, working ? "work" : "read", o.profile)
      return {
        ...(model ? { model } : {}),
        env: { CODEX_CONFIG: JSON.stringify({ ...(model ? { model } : {}), ...own }) },
        mode: `permission-profile:${o.profile}${working ? "" : "-read"}`,
        preamble: spec.systemPrompt.trim(),
        // It names some files from the run's folder; its own, in its home, aren't the run's.
        file: (f) => {
          const file = path.resolve(spec.cwd, f)
          return inside(o.home, file) ? null : file
        },
      }
    },
  }
}
