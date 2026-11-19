# senter-mvp

Gives an agent harness a published graph of units and tools over MCP, with grants, delegation, an audit log and a human approval inbox for everything that leaves the host. A service or Electron main process owns the library, the SQLite database and the adapters.

## Run

```sh
pnpm install --frozen-lockfile   # Node.js 24.11+, pnpm version from package.json
pnpm test                        # strict TypeScript build, then the tests
```

## Use

```ts
import { DatabaseSync } from "node:sqlite"
import { createApp, createBroker } from "senter-mvp"

const { platform, adapters, workspaceNodes } = createBroker({ executable: brokerPath }, () => true)
const app = createApp({ database: new DatabaseSync("senter.sqlite"), platform, adapters })
const revision = app.publish([...workspaceNodes, { kind: "unit", id: "review", title: "Review",
  profile: "default", context: ["Summarize the workspace."], exports: ["files"] }])
// owner and workspace come from the host's own authentication
await app.start({ owner, revision, entry: "review", workspace, input: "Summarize the notes." })
```

## Concepts

- **Unit**: a role with a launch `profile`, `context` and `exports`. Without a profile it only groups nodes.
- **Tool**: an MCP definition bound to an `{ adapter }` (host code) or a `{ unit }` (a child run that lives as long as its caller's run). Its name is its node ID.
- **Revision**: a published graph, checked for references, cycles and JSON Schemas (2020-12, or draft-07 by `$schema`).
- **Grants**: a run sees what its unit reaches and `allowed` permits, never what an ancestor was denied, rechecked up the delegation chain on every call. Call `app.notifyToolsChanged()` after a policy change.
- **Adapters**: one with `call` runs at once. One with `prepare` and `send` makes a packet, a person approves it via `app.human`, and `send` delivers exactly that packet.
- **Menu**: small tool sets are listed directly; larger ones become pinned tools, `discover` and `invoke({ name, arguments })`. Set `nativeDiscovery` for harnesses with their own tool search.
- **Calls**: failures return `isError` results the model can read; raw host errors never reach it. A retry with the same `senter/call-id`, or else the same tool and arguments, joins the same approval or child run. Task-capable clients can run any call as an MCP task and cancel it.

## Host contract

- Authenticate owners. Keep the database and `app.human` outside the harness workspace. One service per database.
- The broker confines the harness and enforces the workspace boundary: JSON on stdin/stdout, and MCP on fd 3 in `launch` mode.
- Publish `workspaceNodes` for logged file access with per-tool grants, or leave them out and let the broker mount the workspace for the harness's own file tools: faster, but not in the log.
- Put anything that sends data to a third party behind `prepare` and `send`. A `call` adapter's arguments leave unreviewed.
- Render approvals with `showApproval` from `senter-mvp/preview`. It marks every character a reviewer could not see.
- After a crash, `unknown` deliveries wait for `human.reconcile(owner, id, "sent" | "failed")`. Resume a run with `app.reconnect`; `app.end` ends it and everything it delegated.
- Limits and their defaults are in `src/limits.ts`. Override any by name in the options.

Changing the code? Read [AGENTS.md](AGENTS.md) first. `pnpm test` must pass.
