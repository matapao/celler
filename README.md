# celler

Gives an agent harness a published graph of cells and tools over MCP, with grants, delegation, an audit log and a human approval inbox for everything that leaves the host. A service or Electron main process owns the library, the SQLite database and the adapters.

## Install

```sh
echo '@matapao:registry=https://npm.pkg.github.com' >> .npmrc   # and a GitHub token that reads packages in ~/.npmrc
pnpm add @matapao/celler                                         # Node.js 24.11+; each release's tarball needs no token
```

## Use

```ts
import { DatabaseSync } from 'node:sqlite';
import { createApp, createBroker } from '@matapao/celler';

const { platform, adapters, workspaceNodes } = createBroker({ executable: brokerPath }, () => true);
const app = createApp({ database: new DatabaseSync('celler.sqlite'), platform, adapters });
const context = ['Summarize the workspace.'];
const revision = app.publish([
  ...workspaceNodes,
  { kind: 'cell', id: 'review', title: 'Review', profile: 'default', context, exports: ['files'] },
]);
// owner and workspace come from the host's own authentication
await app.start({ owner, revision, entry: 'review', workspace, input: 'Summarize the notes.' });
```

## Concepts

- **Cell**: a role with a launch `profile`, `context` and `exports`. Without a profile it only groups nodes.
- **Tool**: an MCP definition bound to an `{ adapter }` (host code) or a `{ cell }` (a child run that lives as long as its caller's run, and answers in text, so it declares no `outputSchema`). Its name is its node ID.
- **Revision**: a published graph, checked for references, cycles and JSON Schemas (2020-12, or draft-07 by `$schema`). A `CellerError` it refuses that is about one node names it in `node`.
- **Grants**: a run sees what its cell reaches and `allowed` permits, never what an ancestor was denied, rechecked up the delegation chain on every call. `app.grants(owner, runId)` reads what a run may reach now. Call `app.notifyToolsChanged()` after a policy change. A run's reach is fixed when it starts: `notifyToolsChanged` refreshes what it lists within that reach and never widens it, so a tool turned on mid-run is reached from the next run.
- **Adapters**: one with `call` runs at once. One with `prepare` and `send` makes a packet, a person approves it via `app.human`, and `send` delivers exactly that packet. The host's map is read live: add adapters, then publish the tools they serve.
- **Menu**: a run's server first says what it holds, as MCP's `instructions`: its cell, then each cell it reaches with the tools in it, by their titles and descriptions (`instructionsChars`). Small tool sets are listed directly; larger ones become pinned tools, `discover` and `invoke({ name, arguments })`. Set `nativeDiscovery` for harnesses with their own tool search, which get every tool and no `discover`; `harnessPlatform` sets it for each agent that has one, as Claude Code and Codex do.
- **Calls**: failures return `isError` results the model can read; raw host errors never reach it. A retry with the same `celler/call-id` joins the same approval or child run; without one, the same tool and arguments join an approval while it is open, or until a call has heard what it came to: the same call made again after that is made again. Task-capable clients can run any call as an MCP task and cancel it.
- **Harnesses** (`@matapao/celler/harness`): the person's own Claude Code and Codex, each through its own SDK and at least the version that SDK is made with, with their sign-in and health, and a simulated one. At `work` an agent uses its own tools in the run's folder, its commands in its own sandbox at its strictest on macOS, Linux and Windows, as one settings file per agent per system says (`src/harness/sandbox/`): no network, nothing written outside the folder or in its settings for the agents celler runs (the run's scratch and temporary files are its own: in `.celler/`, and Claude Code's shell's in a short folder of the run's), nothing read of the person's home, the host's data, the environment or the system's temporary folders, each closed as a whole. Everything outside goes through the run's MCP tools. Codex runs only with its features as celler decides them (`src/harness/sandbox/codex-features.ts`): one a newer Codex turns on stops its runs, and its health says so, until celler is made for it. `purpose: "read"` leaves the folder as it was: Claude Code gets no commands, and Codex's write only in the run's scratch, gone after it; `"inference"` has no tools, but for what Codex's model comes with: its patch tool, which writes only in that scratch, and its clock. `harnessPlatform({ runtime, spec, server })` is a `Platform` that runs each cell's agent (`new AgentRuntime(claudeAgent(…) or codexAgent(…), host)`) with the run's MCP server at a local address; its progress (a call to an MCP tool with its server and tool, as `mcp`), its own asks (Claude Code's with its reason, as `reason`) and what it ended with (a stopped run's too, and why, as `ended`, where its clock or its agent's SDK says) go to the host. Its `close()` stops the agents still going and settles once what they left is gone: their runs end failed, not cancelled, so what they left for a person can still be approved. A host's own `Runtime` makes its results with `emptyUsage()` and `failure(error)`. Each agent keeps a session's transcript, every prompt and tool result, which resuming it needs, and more by the session's id: once the session's work is done, `removeSession({ cwd, sessionId })` on the `AgentRuntime` that ran it removes all of it, Codex's by Codex's own deletion, and that session's alone, never through a link.

## Host contract

- Authenticate owners. Keep the database and `app.human` outside the harness workspace. One service per database.
- The broker confines the harness and enforces the workspace boundary: JSON on stdin/stdout, and MCP on fd 3 in `launch` mode.
- Publish `workspaceNodes` for logged file access with per-tool grants, or leave them out and let the broker mount the workspace for the harness's own file tools: faster, but not in the log.
- Put anything that sends data to a third party behind `prepare` and `send`, and render its approvals with `showApproval` from `@matapao/celler/preview`, which marks every character a reviewer could not see. A `call` adapter's arguments leave unreviewed. A `send` whose request never reached the service throws `NotSent`: its delivery failed, and its run hears `Delivery failed`, or, given a `reason` written for the agent apart from its message (`new NotSent(message, { reason })`), `Delivery failed: <reason>`, on one line and cut to `reasonChars`. Its message never reaches the agent. Any other throw leaves it `unknown`.
- celler keeps only what it must. A sent packet stays exactly as approved. Of what never went, declined or failed, it keeps its state, when it changed and a hash (`human.review` gives a `HashedReview`, `write: { sha256 }`, which `isHashed(review)` tells apart), and of a failed one its `reason` until a call of its run has heard it: the same call made again then hears only that it failed. Of a delivery's answer, once a call of its run has heard it, or the host has, as `human.approve` returns it (a call of its run still waiting hears it too), a hash: the same call made again hears only that it was delivered. Of a run's output, a hash in `history`'s `ended`: the output itself is what `app.start` returns, or a delegated run's caller hears. Keep anything else you need yourself.
- After a crash, `unknown` deliveries wait for `human.reconcile(owner, id, "sent" | "failed", result?)`: a sent one's result passes its tool's checks, as a delivery's own answer does. Resume a run with `app.reconnect`; `app.end` ends it and everything it delegated.
- Limits and their defaults are in `src/limits.ts`. Override any of the app's, the broker's or a connector's by name in its options. The harness's, and how deep JSON may nest, are module constants.

Changing the code? Read [AGENTS.md](AGENTS.md) first. `pnpm test` must pass.
