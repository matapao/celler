# Working on celler

For the people and coding agents who change this code. People who use the library read [README.md](README.md).

## Before you finish

- After `pnpm install --frozen-lockfile` (Node.js 24.11+, pnpm as package.json names it), `pnpm test` passes: a strict
  TypeScript build, then every test.
- So do `pnpm lint` (oxlint, knip), `pnpm lint:style` (`pnpm format` applies Prettier), `pnpm check:lines` (500 lines
  a file) and `pnpm check:security` (nothing about the project leaves this computer; CI adds pnpm audit): CI requires
  them. `pnpm test:coverage` reports only.
- When package.json or an entry point changes: `pnpm check:package` (publint and attw: the package as npm gets it).
- A change in behaviour comes with a test. Every invariant below has one.
- README.md stays at 50 lines or fewer.

## Invariants

1. Nothing leaves without an approved, frozen packet. A send uses exactly the bytes the person saw.
2. Approval states change only by compare-and-set along `lifecycle` in `src/store.ts`. A crash never replays a send.
3. A published revision never changes.
4. Every call is checked against the run's grants, the live policy and the whole delegation chain.
5. A delivery is recorded as sent before anything checks its response.
6. The harness sees only this library's own error messages, never raw host, adapter or database errors. The one exception is a reason a host writes for the agent, given on purpose apart from its error (`NotSent`'s `reason`): it passes as written, on one line and within its limit (`reasonChars`).
7. An agent's commands reach no network, write only in the run's folder and never its own settings for the agents celler runs (their scratch and temporary files are the run's own: in `.celler/` inside it, and Claude Code's shell's in a short folder of the run's), and read nothing of the person's home, the host's data, the environment or the system's temporary folders, each closed as a whole: what isn't the run's folder or the system's own needs no list. Only each agent's own sandbox settings say so, one file per agent per system (`src/harness/sandbox/`), each asserted against the same rule. On Linux Claude Code's sandbox takes no pattern for what its commands may not write, so they are kept from those settings at the folder's top only, by name (`claude.linux.ts`).
8. celler keeps only what it must: a sent packet exactly as approved; of what never went (declined or failed), its state, when it changed and the hash of its arguments and packet; a delivery's answer until a call of its run has heard it, or its host as `human.approve` returns it, then its hash, and a failed one's `reason` until a call of its run has heard it, then nothing; a run's output only as its hash, in its `ended` event. `src/tables.ts` says what each record keeps, and brings an older celler's database there once, as it opens.

## Style

- Declarative first: schemas, tables and state maps before branching code. Every limit lives in `src/limits.ts`.
- As few concepts as possible: no option, mode or name without behaviour behind it.
- Use the harness's and MCP's own features (tool search, tasks, annotations, `isError`) before inventing one.

## Map

- `app.ts`: `createApp` and its types, what a host calls. `runs.ts`: runs, their grants, lifetimes and delegation.
- `calls.ts`: a run's calls, through its adapters and the inbox. `server.ts`: a run's MCP server. `catalog.ts`: compiling and checking a graph.
- `discovery.ts`: the `discover` and `invoke` tools, and the `instructions` a run's server gives. `store.ts`: SQLite, approvals and the event log. `tables.ts`: its tables and records, what each keeps, and an older database brought up to date.
- `broker.ts`: launching the harness and the workspace tools. `connectors.ts`: ready-made adapters.
- `preview.ts`: the approval view for browsers. `errors.ts`, `json.ts`, `limits.ts`: shared helpers.
- `harness/`: the coding agents a host runs. `agents.ts`: Claude Code and Codex as data. `sandbox/`: each agent's settings for each system, data only, Codex's features every system's give it and those it may have on (`codex-features.ts`), and a run's places (`places.ts`). `runtime.ts`: the one runtime that runs either, and what a run is given (`Turn`); `setup.ts`: a run checked and set up; `clock.ts`: its clock; `processes.ts`: the processes it starts and ends, the agent's sign-in too; `versions.ts`: each program's version, and the features it lists (Codex's). `sessions.ts`: all an agent keeps of a session removed once its work is done, by the agent's own deletion where it has one, and from where `agents.ts` says it keeps it. `claude.ts`, `codex.ts`: a run through each agent's own SDK; `claude-report.ts`: Claude Code's run as it reports it, its forms in `claude-forms.ts`. `platform.ts`: the `Platform` that runs a cell's agent with its run's MCP server. `programs.ts`: finding them. `simulated.ts`, and `types.ts`, the run each one takes and gives.
- An agent SDK updated: `agentVersions` in `limits.ts` becomes the version of the agent it is made with (a test holds them together). For Codex, each feature that version's `codex features list` has on, under celler's own, is read in its source and decided on in `codex-features.ts`.

## Releasing

- Set `version` in package.json and `VERSION` in `src/server.ts` (a test holds them together), commit, and push the tag `v<version>`. The Publish workflow (`publish.yml`) runs Test
  and Security, then packs the package once, attests that tarball, and attaches it with its SBOM to the tag's release.
  That tarball, as it is, is what goes to npm as `celler`: `npm publish <tarball>`, by someone signed in to npm who may
  publish it. The package holds its build (`dist/`) and its source (`src/`), which a host can read, as TypeScript does,
  where the build has no types.
- A host installs it from npm with no token. Check a version against its release with
  `gh attestation verify <tarball> --repo matapao/celler`: the same file, by its hash.
