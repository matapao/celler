import { DatabaseSync } from "node:sqlite"
import { setTimeout as delay } from "node:timers/promises"
import { createApp } from "senter-mvp"
import { object, request, tool, unit, withClient } from "../support.mjs"

const database = new DatabaseSync(process.argv[2])
const app = createApp({
  database,
  adapters: new Map([["delivery", {
    prepare: async (_run, content) => ({ account: "test", destination: "outbox", operation: "send", files: [], content }),
    send: async () => process.exit(49),
  }]]),
  platform: {
    allowed: () => true,
    launch: (_spec, connect) => withClient(connect, async client => {
      const calls = ["first", "second"].map(message => client.callTool({ name: "send", arguments: { message } }))
      while (app.human.inbox("alice").length !== 2) await delay(10)
      const first = app.human.inbox("alice").find(row => app.human.review("alice", row.id).write.content.message === "first")
      await app.human.approve("alice", first.id)
      return (await Promise.all(calls))[0]
    }),
  },
})
const revision = app.publish([unit("root", ["send"]), tool("send", { adapter: "delivery" }, {
  inputSchema: object({ message: { type: "string" } }),
})])
await app.start(request(revision))
