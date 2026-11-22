// A stand-in agent over ACP: no model is called. It says what it was sent in FAKE_ACP_LOG, offers two modes as Claude's
// adapter does, streams a reply, asks before it runs a command, and ends its turn with its usage. With FAKE_ACP_TOOL, it
// first lists the tools of the HTTP MCP server it was given and calls that one, and its reply ends with the tool's answer.
import { spawn } from "node:child_process"
import { appendFileSync } from "node:fs"
import path from "node:path"
import { Readable, Writable } from "node:stream"
import { agent, ndJsonStream } from "@agentclientprotocol/sdk"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

if (process.argv.includes("--version")) {
  console.log("9.9.9")
  process.exit(0)
}

// Where it says what it was sent: as the test names it, or, for an agent started with only its own environment, in its folder.
const logFile = process.env.FAKE_ACP_LOG ?? path.join(process.cwd(), "agent.jsonl")
const log = (what, data) => appendFileSync(logFile, JSON.stringify({ what, data }) + "\n")
let servers = []

/** The answer of FAKE_ACP_TOOL, called on the first HTTP server, its headers as given. */
async function toolAnswer() {
  const server = servers.find((s) => s.type === "http")
  if (!process.env.FAKE_ACP_TOOL || !server) return ""
  const mcp = new Client({ name: "fake-acp-agent", version: "9.9.9" })
  await mcp.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: Object.fromEntries(server.headers.map((h) => [h.name, h.value])) } }))
  try {
    log("tools/list", (await mcp.listTools()).tools.map((t) => t.name))
    const answer = await mcp.callTool({ name: process.env.FAKE_ACP_TOOL, arguments: { text: "hi" } })
    return answer.content.map((c) => c.text ?? "").join(" ")
  } finally {
    await mcp.close()
  }
}

agent({ name: "fake-acp-agent" })
  .onRequest("initialize", ({ params }) => {
    log("initialize", { clientInfo: params.clientInfo, mark: process.env.HOST_RUN ?? null })
    return { protocolVersion: params.protocolVersion, agentCapabilities: { loadSession: false }, agentInfo: { name: "fake-acp-agent", version: "9.9.9" }, authMethods: [] }
  })
  .onRequest("session/new", ({ params }) => {
    log("session/new", { cwd: params.cwd, meta: params._meta ?? null, servers: params.mcpServers })
    servers = params.mcpServers
    const modes = [{ id: "default", name: "Default" }, { id: "acceptEdits", name: "Accept edits" }]
    // Its mode is also an option, as Claude's adapter publishes it; a switch doesn't update it here.
    const mode = { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "default", options: modes.map(m => ({ value: m.id, name: m.name })) }
    return { sessionId: "fake-session", modes: { currentModeId: "default", availableModes: modes }, configOptions: [mode] }
  })
  .onRequest("session/set_mode", ({ params }) => {
    log("session/set_mode", { mode: params.modeId })
    return {}
  })
  .onRequest("session/prompt", async ({ params, client }) => {
    log("session/prompt", { text: params.prompt.filter((b) => b.type === "text").map((b) => b.text).join("\n") })
    const update = (u) => client.notify("session/update", { sessionId: params.sessionId, update: u })
    const used = await toolAnswer()
    await update({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "Hello." } })
    const toolCall = { toolCallId: "t1", title: "Run the tests", kind: "execute", rawInput: { command: "npm test" } }
    await update({ sessionUpdate: "tool_call", ...toolCall, status: "pending" })
    const asked = client.request("session/request_permission", {
      sessionId: params.sessionId,
      toolCall,
      options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }],
    })
    // With FAKE_ACP_LEAVE_RUNNING, a command of its keeps running after it, and says where it is.
    if (process.env.FAKE_ACP_LEAVE_RUNNING) {
      const left = spawn(process.execPath, ["-e", "setTimeout(() => undefined, 60_000)"], { stdio: "ignore" })
      // Not waited for: the agent can exit while it goes on, as a command put in the background does.
      left.unref()
      appendFileSync(process.env.FAKE_ACP_LEAVE_RUNNING, String(left.pid))
    }
    // With FAKE_ACP_EXIT_WHILE_ASKING, it is gone while the person is still asked.
    if (process.env.FAKE_ACP_EXIT_WHILE_ASKING) {
      asked.catch(() => undefined)
      setTimeout(() => process.exit(3), 100)
      return new Promise(() => undefined)
    }
    const answer = await asked
    const allowed = answer.outcome.outcome === "selected" && answer.outcome.optionId === "yes"
    await update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: allowed ? "completed" : "failed" })
    const said = (allowed ? " Ran them." : " Didn't run them.") + (used ? ` ${used}` : "")
    await update({ sessionUpdate: "agent_message_chunk", messageId: "m2", content: { type: "text", text: said } })
    return { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } }
  })
  .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
