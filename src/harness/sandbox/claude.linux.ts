// Claude Code on Linux: what every run of it starts with, in Claude Code's own settings (the keys of its settings.json
// and its Agent SDK options), so each line can be held against its documentation. Its sandbox here is bubblewrap, which
// the computer must have (with socat); without it, nothing runs. Guarantees, each asserted for every system's file by
// test/harness.test.mjs:
// - every command runs in the sandbox, none outside it, and where the sandbox can't start, nothing runs;
// - commands reach no network at all: everything outside the computer goes through the host's tools (MCP);
// - they write only in the run's folder (only at work), its own scratch folder inside it, and its shell's own temporary
//   folder, which its sandbox gives its commands and Claude Code can't do without (its working folder after each command);
// - they read the folder, the system and the programs on its PATH, never the person's home, the host's data or the
//   system's other temporary folders, which other programs share;
// - files named for secrets are closed to them and to its own file tools, and the connectors' values to its commands;
// - its own web fetch and web search are off: a web page is a tool of the host's too.

import type { Places } from "./places.js"
import { SECRET_NAMES } from "./places.js"

/** Its shell's own temporary folder, as its sandbox makes it here: Claude Code's, not the system's, and not to be moved. */
const uid = process.getuid?.() ?? 0
const OWN_TMP = [`/tmp/claude-${uid}`]

export default function claudeOnLinux(p: Places, purpose: "work" | "read") {
  return {
    sandbox: {
      enabled: true, // every command it runs, in the sandbox
      failIfUnavailable: true, // no sandbox, no run
      allowUnsandboxedCommands: false, // never a command outside it, even one it asks for
      autoAllowBashIfSandboxed: true, // inside it, commands go without asking the person
      enableWeakerNestedSandbox: false, // never the weaker sandbox meant for inside a container
      filesystem: {
        // Never read: the person's home, the host's data, the system's temporary folders, and secret files in the folder.
        denyRead: [p.home, ...(p.data ? [p.data] : []), ...p.temps, ...p.secrets],
        // Read again inside those: the folder (its scratch in it), its shell's own temporary folder, the programs on its
        // PATH, and what the host adds.
        allowRead: [p.folder, ...OWN_TMP, ...p.toolchain, ...p.readable],
        // Written: the folder at work, else only its own scratch in it (and its shell's own temporary folder, which its
        // sandbox adds itself). Nothing else: what isn't on this list can't be written.
        allowWrite: purpose === "work" ? [p.folder] : [p.scratch.root],
      },
      network: {
        allowedDomains: [], // no host at all
        strictAllowlist: true, // and nothing that isn't on that list
        allowLocalBinding: false, // nor a server of its own, even on this computer
        allowUnixSockets: [], // nor another program's socket
        allowAllUnixSockets: false,
      },
      // The connectors' values reach it in these variables, for its MCP servers; never its commands.
      credentials: { envVars: p.hidden.map((name) => ({ name, mode: "deny" as const })) },
    },
    settings: {
      permissions: {
        // Its commands, every one in the sandbox, which keeps them to all of the above: none waits for the person.
        allow: ["Bash"],
        // Its own file tools: in the folder only, and never a secret file there.
        blockReadsOutsideWorkingDirectories: true,
        blockWritesOutsideWorkingDirectories: true,
        deny: SECRET_NAMES.flatMap((name) => [`Read(**/${name})`, `Edit(**/${name})`]),
      },
      disableClaudeAiConnectors: true, // only the host's connectors, not the person's claude.ai ones
      autoMemoryEnabled: false, // nothing carried from one run to the next
    },
    // Its own tools that reach outside: off. To read, none that write.
    disallowedTools: ["WebFetch", "WebSearch", ...(purpose === "read" ? ["Edit", "Write", "MultiEdit", "NotebookEdit"] : [])],
    // At work, edits in the folder go ahead; to read, nothing of its own would ask. Anything else asks the person.
    mode: purpose === "work" ? "acceptEdits" : "default",
    // Its own temporary folder in its scratch, in the folder: where its sandbox gives its commands theirs too.
    env: { CLAUDE_CODE_TMPDIR: p.scratch.tmp },
  }
}
