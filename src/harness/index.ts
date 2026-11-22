// The coding agents a host runs: Claude Code and Codex, each an entry of agents.ts that one runtime runs through the
// agent's own SDK, and a simulated one. The host lends its own names and words.
export { claudeAgent, codexAgent, tierModel, type Agent } from "./agents.js"
export { AGENT_PROGRAMS, agentEnv, checkProgram, chosenPrograms, findProgram, type AgentProgram } from "./programs.js"
export { harnessPlatform, type HarnessPlatform, type Launched } from "./platform.js"
export { AgentRuntime } from "./runtime.js"
// What a run's commands never write in its folder; a host that writes into a run's folder itself keeps to it too.
export { AGENT_SETTINGS, type Places } from "./sandbox/places.js"
export { SimulatedRuntime } from "./simulated.js"
export { isTier, type AgentAsk, type AgentFormField, type AgentLogin, type AgentSetting, type AskAnswer, type ClaudeWords, type CodexWords, type Host } from "./types.js"
export type { McpServerSpec, ModelTier, RunHandle, RunProgress, RunResult, RunSpec, Runtime, RuntimeHealth, TokenUsage } from "./types.js"
