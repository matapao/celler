# Working on celler

For the people and coding agents who change this code. People who use the library read [README.md](README.md).

## Before you finish

- `pnpm test` passes: a strict TypeScript build, then every test.
- A change in behaviour comes with a test. Every invariant below has one.
- README.md stays at 50 lines or fewer.

## Invariants

1. Nothing leaves without an approved, frozen packet. A send uses exactly the bytes the person saw.
2. Approval states change only by compare-and-set along `lifecycle` in `src/store.ts`. A crash never replays a send.
3. A published revision never changes.
4. Every call is checked against the run's grants, the live policy and the whole delegation chain.
5. A delivery is recorded as sent before anything checks its response.
6. The harness sees only this library's own error messages, never raw host, adapter or database errors.
7. An agent's commands reach no network, write only in the run's folder (their scratch and temporary files are inside it, in `.celler/`), and read nothing of the person's home, environment, secret files or the system's temporary folders: one settings file per agent per system (`src/harness/sandbox/`), each asserted against the same rule.

## Style

- Declarative first: schemas, tables and state maps before branching code. Every limit lives in `src/limits.ts`.
- As few concepts as possible: no option, mode or name without behaviour behind it.
- Use the harness's and MCP's own features (tool search, tasks, annotations, `isError`) before inventing one.

## Map

- `app.ts`: runs, calls, delegation and the MCP server. `catalog.ts`: compiling and checking a graph.
- `discovery.ts`: the `discover` and `invoke` tools. `store.ts`: SQLite, approvals and the event log.
- `broker.ts`: launching the harness and the workspace tools. `connectors.ts`: ready-made adapters.
- `preview.ts`: the approval view for browsers. `errors.ts`, `json.ts`, `limits.ts`: shared helpers.
- `harness/`: the coding agents a host runs. `agents.ts`: Claude Code and Codex as data. `sandbox/`: each agent's settings for each system, data only, and a run's places (`places.ts`). `runtime.ts`: the one runtime that runs either. `acp.ts`: a run over ACP. `platform.ts`: the `Platform` that runs a cell's agent with its run's MCP server. `programs.ts`: finding and starting them. `simulated.ts`, and `types.ts`, the run each one takes and gives.
