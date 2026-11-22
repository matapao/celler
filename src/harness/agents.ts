// The two coding agents, Claude Code and Codex, as data: what each needs found, how it says its version and whether it
// is signed in, how it signs in, and how a run of it goes, through its own SDK (claude.ts, codex.ts). One runtime runs
// either (runtime.ts). Each works with its own tools in the run's folder, its commands in its own sandbox at its
// strictest, as the settings files for each system say (sandbox/claude.*.ts, sandbox/codex.*.ts); everything outside
// the folder goes through the run's MCP tools.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { agentVersions, harnessLimits } from "../limits.js"
import { runClaude } from "./claude.js"
import { runCodex } from "./codex.js"
import { codexProgram, findProgram, realProgram } from "./programs.js"
import type { Turn } from "./runtime.js"
import type { ClaudeWords, CodexWords, Host, ModelTier, RunResult, RuntimeHealth } from "./types.js"

/** What the host says when an agent's program isn't there, and what it offers. */
export type Missing = { missing: string; fix?: RuntimeHealth["fix"] }

export interface Agent {
  kind: string
  name: string
  /** Its own program, as found, or what the host says when it isn't there. */
  find(): string | Missing
  /** The program that runs for the one found, and the folders it needs on PATH. */
  started(found: string): { program: string; path: string[] }
  /** Made ready before each start: a run, its sign-in, its health check. */
  ready?(): void
  /** Added to its environment whenever it starts ('' removes a variable). */
  env(host: Host): Record<string, string>
  /** Its version in what `--version` says, and the oldest that runs (limits.ts agentVersions). */
  version: { of(said: string): string | null; oldest: string }
  /** Asked of its program; `yes` reads the answer: signed in, not, or null when it can't tell. */
  signedIn: { args: string[]; anyExit?: boolean; yes(answer: string | null): boolean | null }
  login: { args: string[]; fix: RuntimeHealth["fix"]; signedOut: string; hint: string }
  testRunMs: number
  /** It searches its MCP tools itself, loading only those it needs: a run lists them all to it, not celler's menu. */
  nativeDiscovery: boolean
  /** One run, through its own SDK. */
  run(turn: Turn): Promise<RunResult>
}

/** The models a tier runs on, as each agent names them. */
const MODELS: Record<"claude" | "codex", Record<ModelTier, string>> = {
  claude: { fast: "haiku", balanced: "sonnet", strong: "opus" },
  codex: { fast: "gpt-6-luna", balanced: "gpt-6.1-sol", strong: "gpt-6-astra" },
}

/** The model a tier runs on, as each agent names it. */
export const tierModel = (agent: "claude" | "codex", tier: ModelTier): string => MODELS[agent][tier]

/** The first version number in what a program says, "2.1.330" in "2.1.330 (Claude Code)". */
const versionIn = (said: string) => /\d+\.\d+\.\d+/.exec(said)?.[0] ?? null

// ---------------------------------------------------------------- Claude Code

/** Its own sign-in only: a key or token from the shell would win over it, and an endpoint from the shell would get it. */
const OWN_SIGN_IN = { ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_BASE_URL: "", CLAUDE_CODE_USE_BEDROCK: "", CLAUDE_CODE_USE_VERTEX: "" }

/** Claude Code, the person's own, through the Claude Agent SDK. */
export function claudeAgent(o: { claude?: () => string | null; words: ClaudeWords }): Agent {
  const program = () => (o.claude ? o.claude() : findProgram("claude"))
  return {
    kind: "claude-code",
    name: "Claude Code",
    find: () => program() ?? { missing: o.words.noClaude, fix: "find-claude" },
    started: (found) => ({ program: realProgram(found), path: [] }),
    // The host by its name, in the agent's requests, as the Agent SDK has it said.
    env: (host) => ({ ...OWN_SIGN_IN, CLAUDE_AGENT_SDK_CLIENT_APP: `${host.client.name}/${host.client.version}` }),
    version: { of: versionIn, oldest: agentVersions.claude },
    signedIn: { args: ["auth", "status", "--json"], anyExit: true, yes: (answer) => loggedIn(answer) },
    login: { args: ["auth", "login", "--claudeai"], fix: "login", signedOut: "not logged in to Claude", hint: o.words.login },
    testRunMs: harnessLimits.claudeTestRunMs,
    // Its ToolSearch.
    nativeDiscovery: true,
    run: (turn) => runClaude(turn, { models: MODELS.claude, signedOut: o.words.login }),
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

/** The `config.toml` of the host's Codex home: its sign-in kept in a file there, not the person's own. */
export const CODEX_HOME_CONFIG = 'cli_auth_credentials_store = "file"\n'

/**
 * Codex, the person's own CLI, through the Codex SDK, in the host's Codex home (`home`): its sign-in and its sessions
 * are kept there, and as no folder is trusted there, Codex loads no folder's own settings.
 */
export function codexAgent(o: { codex?: () => string | null; home: string; words: CodexWords }): Agent {
  const program = () => (o.codex ? o.codex() : findProgram("codex"))
  return {
    kind: "codex",
    name: "Codex",
    find: () => program() ?? { missing: `Codex wasn't found on this computer. ${o.words.install}`, fix: "find-codex" },
    started: codexProgram,
    ready: () => {
      mkdirSync(o.home, { recursive: true })
      const file = path.join(o.home, "config.toml")
      if (!existsSync(file) || readFileSync(file, "utf8") !== CODEX_HOME_CONFIG) writeFileSync(file, CODEX_HOME_CONFIG)
    },
    env: () => ({ CODEX_HOME: o.home }),
    version: { of: versionIn, oldest: agentVersions.codex },
    signedIn: { args: ["login", "status"], yes: (answer) => answer !== null },
    login: { args: ["login"], fix: "login-codex", signedOut: o.words.signedOut, hint: o.words.login },
    testRunMs: harnessLimits.codexTestRunMs,
    // Its tool_search, over MCP tools it always defers.
    nativeDiscovery: true,
    run: (turn) => runCodex(turn, { models: MODELS.codex, home: o.home, signedOut: o.words.login }),
  }
}
