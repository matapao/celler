// Claude Code on Windows: what every run of it starts with, in Claude Code's own settings (the keys of its settings.json
// and its Agent SDK options), so each line can be held against its documentation. Its sandbox here is its own for
// Windows: commands run as its sandbox group, with permissions on the folders they may use. It doesn't start in the home
// folder itself, or in a folder holding it. Where its shell keeps its own temporary files here is its sandbox's to say;
// these settings were run on macOS, not here. Guarantees, each asserted for every system's file by test/harness.test.mjs:
// - every command runs in the sandbox, none outside it, and where the sandbox can't start, nothing runs;
// - commands reach no network at all: everything outside the computer goes through the host's tools (MCP);
// - they write only in the run's folder (only at work), its own scratch folder inside it, and its shell's own temporary
//   folder, which its sandbox gives its commands and Claude Code can't do without (its working folder after each
//   command); never the folder's own settings for the agents celler runs;
// - they read the folder, the system and the programs on its PATH, never the person's home, the host's data or the
//   system's other temporary folders, which other programs share;
// - files named for secrets are closed to them and to its own file tools, and the connectors' values to its commands;
// - its own web fetch and web search are off: a web page is a tool of the host's too.

import type { Places } from "./places.js"
import { AGENT_SETTINGS, SECRET_NAMES } from "./places.js"

export default function claudeOnWindows(p: Places, purpose: "work" | "read") {
  return {
    sandbox: {
      enabled: true, // every command it runs, in the sandbox
      failIfUnavailable: true, // no sandbox, no run
      allowUnsandboxedCommands: false, // never a command outside it, even one it asks for
      autoAllowBashIfSandboxed: true, // inside it, commands go without asking the person
      filesystem: {
        // Never read: the person's home, the host's data, the system's temporary folders, and secret files in the folder.
        denyRead: [p.home, ...(p.data ? [p.data] : []), ...p.temps, ...p.secrets],
        // Read again inside those: the folder (its scratch in it), the run's short folder (its shell's temporary one),
        // the programs on its PATH, and what the host adds.
        allowRead: [p.folder, p.scratch.short, ...p.toolchain, ...p.readable],
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
        // Its own file tools: in the folder only, and never a secret file there. Claude Code puts these deny rules into
        // its sandbox too, so its commands can't read or write such a file anywhere in the folder either.
        blockReadsOutsideWorkingDirectories: true,
        blockWritesOutsideWorkingDirectories: true,
        deny: [
          ...SECRET_NAMES.flatMap((name) => [`Read(**/${name})`, `Edit(**/${name})`]),
          // The folder's own settings for the agents celler runs: read, never written (AGENT_SETTINGS).
          ...AGENT_SETTINGS.flatMap((name) => [`Edit(**/${name})`, `Edit(**/${name}/**)`]),
        ],
      },
      disableClaudeAiConnectors: true, // only the host's connectors, not the person's claude.ai ones
      autoMemoryEnabled: false, // nothing carried from one run to the next
    },
    // Its own tools that reach outside: off. To read, none that write.
    disallowedTools: ["WebFetch", "WebSearch", ...(purpose === "read" ? ["Edit", "Write", "MultiEdit", "NotebookEdit"] : [])],
    // At work, edits in the folder go ahead; to read, nothing of its own would ask. Anything else asks the person.
    mode: purpose === "work" ? "acceptEdits" : "default",
    // Its own temporary folder, the run's short one (here its scratch's: Windows needs no short path), where its
    // sandbox gives its commands theirs; and git with no personal settings: the person's own can't be read here.
    env: { CLAUDE_CODE_TMPDIR: p.scratch.short, GIT_CONFIG_GLOBAL: "NUL" },
  }
}
