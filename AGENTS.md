# Working on celler

celler is a TypeScript library, published on npm as `celler`, that gives an agent harness (Claude Code, Codex or a
host's own) a published graph of cells and tools over MCP, with grants, delegation, an audit log in SQLite and an
approval inbox for what leaves the host. It runs on Node.js (24.11 and later for hosts such as Electron 45's Node 24;
26 to develop) and is built with TypeScript's native compiler. This file is for the people and coding agents who
change it; people who use the library read [README.md](README.md).

## Check your work

- Setup: Node 26.13.1 (`.nvmrc`) and pnpm as `packageManager` names it (12.22.0; `npx -y pnpm@12.22.0` the first
  time, then `pnpm` switches itself), then `pnpm install --frozen-lockfile`.
- `pnpm check` must pass before you say a change works. It runs, and lists as passed or failed: `typecheck` (tsc,
  strict, with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`), `lint` (oxlint's type-aware rules in
  `.oxlintrc.json`, which reports unused disable directives, and knip), `format:check` (Prettier; `pnpm format`
  applies it), `check:files` (500 lines a hand-written file, README.md and AGENTS.md the only Markdown, every
  suppression with its reason) and `test` (the build, then every test in `test/*.test.mjs` against `dist/`). CI runs
  `pnpm check --coverage`: `test:coverage`, which fails below 80% of lines, 70% of branches or 75% of functions.
- `pnpm check:security` when dependencies, the lockfile, `pnpm-workspace.yaml`, the workflows or anything that
  touches secrets change: the lockfile one YAML document from the registry, hidden characters, licences, secrets in
  every commit, zizmor and actionlint. Nothing about the project leaves this computer; CI adds pnpm audit, and runs
  `--live` (advisories, the registry, the actions' repositories) daily and before a release.
- `pnpm check:package` when package.json or an entry point changes: publint and attw, the package as npm gets it.
- A change in behaviour comes with a test. Every invariant below has one. Parsers and validators have fast-check
  properties besides (`test/properties-*.test.mjs`).
- Tests are deterministic but for their order: they run in a random order and print its seed
  (`Randomized test order seed: <n>`); `NODE_OPTIONS=--test-random-seed=<n> pnpm test` runs that order again.
  `test/setup.mjs` runs first in every test process: TZ=UTC, and fast-check's seed fixed (`FAST_CHECK_SEED=<n>`
  tries another; a failing property prints the seed and path that rerun it). No `.only`, no retries, no snapshots,
  no network beyond loopback and no model calls: the agents in tests are fakes (`test/fixtures/`). No sleeps for
  timing in new tests: the clock's tests (`harness-clock.test.mjs`) and some others still wait in real time, which a
  very busy computer can make fail.

## Layout

- `src/`: the library, `dist/` its build (never committed). `test/`: the tests, their helpers (`support*.mjs`) and
  fixtures. `scripts/`: the checks (`check.mjs`, `check-files.mjs`, `check-security.mjs`) and `github-settings.mjs`
  (the repository's GitHub settings, which the owner runs: `pnpm github:settings`, `--apply` to set them).
  `patches/`: the Codex SDK's patch (pnpm-workspace.yaml says why). `.github/workflows/`: Checks, Security, CodeQL,
  Scorecard, Dependency review and Publish.
- In `src/`, file by file:
  - `app.ts`: `createApp` and its types, what a host calls. `runs.ts`: runs, their grants, lifetimes and delegation.
  - `calls.ts`: a run's calls, through its adapters and the inbox. `server.ts`: a run's MCP server. `catalog.ts`: compiling and checking a graph.
  - `discovery.ts`: the `discover` and `invoke` tools, and the `instructions` a run's server gives. `store.ts`: SQLite, approvals and the event log. `tables.ts`: its tables and records, what each keeps, and an older database brought up to date.
  - `broker.ts`: launching the harness and the workspace tools. `connectors.ts`: ready-made adapters.
  - `preview.ts`: the approval view for browsers. `errors.ts`, `json.ts`, `limits.ts`: shared helpers.
  - `harness/`: the coding agents a host runs. `agents.ts`: Claude Code and Codex as data. `sandbox/`: each agent's settings for each system, data only, Codex's features every system's give it and those it may have on (`codex-features.ts`), and a run's places (`places.ts`). `runtime.ts`: the one runtime that runs either, and what a run is given (`Turn`); `setup.ts`: a run checked and set up; `clock.ts`: its clock; `processes.ts`: the processes it starts and ends, the agent's sign-in too; `versions.ts`: each program's version, and the features it lists (Codex's). `sessions.ts`: all an agent keeps of a session removed once its work is done, by the agent's own deletion where it has one, and from where `agents.ts` says it keeps it. `claude.ts`, `codex.ts`: a run through each agent's own SDK; `claude-report.ts`: Claude Code's run as it reports it, its forms in `claude-forms.ts`. `platform.ts`: the `Platform` that runs a cell's agent with its run's MCP server. `programs.ts`: finding them. `simulated.ts`, and `types.ts`, the run each one takes and gives.

## Rules

### Invariants

1. Nothing leaves without an approved, frozen packet. A send uses exactly the bytes the person saw.
2. Approval states change only by compare-and-set along `lifecycle` in `src/store.ts`. A crash never replays a send.
3. A published revision never changes.
4. Every call is checked against the run's grants, the live policy and the whole delegation chain.
5. A delivery is recorded as sent before anything checks its response.
6. The harness sees only this library's own error messages, never raw host, adapter or database errors. The one exception is a reason a host writes for the agent, given on purpose apart from its error (`NotSent`'s `reason`): it passes as written, on one line and within its limit (`reasonChars`).
7. An agent's commands reach no network, write only in the run's folder and never its own settings for the agents celler runs (their scratch and temporary files are the run's own: in `.celler/` inside it, and Claude Code's shell's in a short folder of the run's), and read nothing of the person's home, the host's data, the environment or the system's temporary folders, each closed as a whole: what isn't the run's folder or the system's own needs no list. Only each agent's own sandbox settings say so, one file per agent per system (`src/harness/sandbox/`), each asserted against the same rule. On Linux Claude Code's sandbox takes no pattern for what its commands may not write, so they are kept from those settings at the folder's top only, by name (`claude.linux.ts`).
8. celler keeps only what it must: a sent packet exactly as approved; of what never went (declined or failed), its state, when it changed and the hash of its arguments and packet; a delivery's answer until a call of its run has heard it, or its host as `human.approve` returns it, then its hash, and a failed one's `reason` until a call of its run has heard it, then nothing; a run's output only as its hash, in its `ended` event. `src/tables.ts` says what each record keeps, and brings an older celler's database there once, as it opens.

### Style

- Declarative first: schemas, tables and state maps before branching code. Every limit lives in `src/limits.ts`.
- As few concepts as possible: no option, mode or name without behaviour behind it.
- Use the harness's and MCP's own features (tool search, tasks, annotations, `isError`) before inventing one.

### Agent SDKs

- An agent SDK updated: `agentVersions` in `limits.ts` becomes the version of the agent it is made with (a test holds them together). For Codex, each feature that version's `codex features list` has on, under celler's own, is read in its source and decided on in `codex-features.ts`.

### Releasing

- Set `version` in package.json and `VERSION` in `src/server.ts` (a test holds them together) and commit; the person
  pushes the tag `v<version>`. The Publish workflow (`publish.yml`) runs Checks and Security, then packs the package
  once, attests that tarball and creates the tag's release with it, its attestation (`<tgz>.sigstore.json`, the
  Sigstore bundle, and `<tgz>.intoto.jsonl`, its DSSE envelope) and its SBOM (`<tgz>.cdx.json`).
- Its `npm` job then waits for the owner's approval in the `npm` environment, downloads the release's own tarball,
  checks it with `gh attestation verify` and publishes that file, as it is, with `npm publish <tgz>` by npm's trusted
  publishing: the run's OIDC token (npm 11.5.1 or later, as Node 26 brings), no npm token anywhere. npm adds its own
  provenance. The package holds its build (`dist/`) and its source (`src/`), which a host can read, as TypeScript
  does, where the build has no types.
- The owner's setup, once: on npmjs.com, celler's Settings, Trusted publishing, GitHub Actions: owner `matapao`,
  repository `celler`, workflow `publish.yml`, environment `npm` (then, once a publish has worked, its publishing
  access can disallow tokens). On GitHub, Settings, Environments: `npm`, with the owner as required reviewer and
  only `v*` tags allowed to deploy to it.
- A host installs it from npm with no token. Check a version against its release with
  `gh attestation verify <tarball> --repo matapao/celler`: the same file, by its hash.

## Don't

- Push, merge, tag, publish or deploy: those are the person's.
- Add Markdown besides README.md (100 lines at most) and AGENTS.md (200), a file over 500 lines, or a suppression
  without its reason (`-- <reason>`, `@ts-expect-error <reason>`).
- Edit generated files: `dist/` (build it), `pnpm-lock.yaml` (pnpm writes it) or `patches/` (`pnpm patch`), whose
  patch adds the Codex SDK's missing listener and nothing else.
- Commit `dist/`, put a limit anywhere but `src/limits.ts`, or let a raw host, adapter or database error reach the
  harness.
