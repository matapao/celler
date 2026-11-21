// A stand-in broker: workspace mode answers fs.read; launch mode plays the harness and calls fs.read over fd 3.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { Socket } from "node:net"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"

const input = JSON.parse(readFileSync(0, "utf8"))
assert.equal(input.workspace, "folder")
assert.equal(input.owner, "alice")
if (process.argv[2] === "workspace") {
  assert.equal(input.op, "read")
  assert.equal(input.args.path, "note.txt")
  process.stdout.write(JSON.stringify({ content: [{ type: "text", text: "workspace result" }] }))
} else {
  assert.equal(input.profile, "root")
  const pipe = new Socket({ fd: 3, readable: true, writable: true })
  const client = new Client({ name: "broker-fixture", version: "1" })
  await client.connect(new StdioServerTransport(pipe, pipe))
  const result = await client.callTool({ name: "fs.read", arguments: { path: "note.txt" } })
  await client.close()
  pipe.destroy()
  process.stdout.write(JSON.stringify(result))
}
