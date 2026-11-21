// Agents and MCP servers on Windows start without a console window (windowsHide), so nothing flashes up. But a
// console program they start in turn (Codex's app-server, a shell command) then gets a console of its own, which
// Windows shows as a terminal window, and closing that window kills the program. A Node program the host runs is
// therefore started through a small bootstrap that makes windowsHide the default for every process it launches.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

/** Sets windowsHide on every child_process call unless the caller says otherwise, then runs the script in argv[2]. */
export const BOOTSTRAP = `import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const self = fileURLToPath(import.meta.url);
// Electron's node mode is this runtime's, not the agent's: what the agent starts doesn't inherit it (on Windows an
// empty value still counts as set, so it can't be blanked further on), and only what runs on this runtime gets it back.
const electronNode = process.env.ELECTRON_RUN_AS_NODE;
delete process.env.ELECTRON_RUN_AS_NODE;
// Given back only to what runs on this same runtime (sameRuntime below).
// nosemgrep: semgrep.binary-as-node
const asNode = (options) => (electronNode ? { ...options, env: { ...(options.env ?? process.env), ELECTRON_RUN_AS_NODE: electronNode } } : options);
// A Node script it starts with this same runtime (Codex's codex.js, under Electron) goes through this file too, so
// what that script starts is hidden as well.
const sameRuntime = (cmd) => typeof cmd === 'string' && path.resolve(cmd).toLowerCase() === path.resolve(process.execPath).toLowerCase();
const throughSelf = (args) => {
  if (sameRuntime(args[0]) && Array.isArray(args[1]) && typeof args[1][0] === 'string' && !args[1][0].startsWith('-')) args[1] = [self, ...args[1]];
  return args;
};

const isOptions = (a) => !!a && typeof a === 'object' && !Array.isArray(a);
const hidden = (args) => {
  const i = args.findIndex((a, k) => k >= 1 && isOptions(a));
  if (i >= 0) {
    args[i] = { windowsHide: true, ...args[i] };
    return args;
  }
  // No options yet: after the arguments array where there is one, before a callback.
  const at = Array.isArray(args[1]) ? 2 : 1;
  args.splice(Math.min(at, args.length), 0, { windowsHide: true });
  return args;
};
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync']) {
  const original = cp[name];
  if (typeof original !== 'function') continue;
  const direct = name.startsWith('spawn') || name.startsWith('execFile');
  cp[name] = function (...args) {
    const onThisRuntime = direct && sameRuntime(args[0]);
    const call = hidden(direct ? throughSelf(args) : args);
    if (onThisRuntime) {
      const i = call.findIndex((a, k) => k >= 1 && isOptions(a));
      call[i] = asNode(call[i]);
    }
    return original.apply(this, call);
  };
}
// fork(module, args, options) runs this runtime on the module: through this file first.
const fork = cp.fork;
cp.fork = function (modulePath, ...rest) {
  const args = Array.isArray(rest[0]) ? rest.shift() : [];
  const options = rest.find((a) => isOptions(a)) ?? {};
  return fork.call(this, self, [String(modulePath), ...args], asNode({ windowsHide: true, ...options }));
};
syncBuiltinESMExports();

const script = process.argv[2];
process.argv.splice(1, 1);
await import(pathToFileURL(script).href);
`

/**
 * Where the bootstrap's file goes: the host's own data (bootstrapIn), never the temporary folder at a name anyone can
 * know, where a file put there first would run in its place.
 */
let folder: string | null = null
let hostVersion = "0"

/** The host's data, where the bootstrap's file goes, and its version, which names the file: set as the host starts. */
export function bootstrapIn(dataDir: string, version: string): void {
  folder = dataDir
  hostVersion = version
}

/** Before the host's data is known (tests): a folder of this process's own, at a name nobody knows. */
const where = () => (folder ??= mkdtempSync(path.join(os.tmpdir(), "celler-")))

/** The bootstrap's file for a host version: looked at each time it is used, and written when it isn't as it should be. */
export function bootstrapFile(version = hostVersion, dir = where()): string {
  const file = path.join(dir, `windowless-${version}.mjs`)
  try {
    if (readFileSync(file, "utf8") === BOOTSTRAP) return file
  } catch {
    /* not there yet */
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, BOOTSTRAP)
  return file
}
