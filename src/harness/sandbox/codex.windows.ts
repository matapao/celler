// Codex on Windows: what every run of it starts with, in Codex's own settings (the keys of its config.toml), so each line
// can be held against its documentation. Its sandbox here is its own for Windows, at its strictest ("elevated": commands
// run as its own sandbox accounts). `home` is the config.toml of the
// host's Codex home, the same for every run; `run` is what one run adds, its own places, given to Codex as its session's
// settings (codex-acp's CODEX_CONFIG). Guarantees, each asserted for every system's file by test/harness.test.mjs:
// - every command runs in the sandbox, and what would go beyond it Codex refuses itself, asking no one;
// - commands reach no network at all: everything outside the computer goes through the host's tools (MCP);
// - they write only in the run's folder (only at work) and its own scratch folder inside it;
// - they read the system's essentials, the folder, the programs on its PATH and what the host adds, nothing else, and
//   never the system's temporary folders, which other programs share: their temporary files are in the scratch;
// - their environment is Codex's core variables and the run's own home and temporary folders: no secrets;
// - files named for secrets in the folder are closed to them (when there are any, as the run starts);
// - no web search, no image read from anywhere on the computer, no plugins, hooks or memories.

import path from "node:path"
import type { Places } from "./places.js"

export function home(profile: string): string {
  return `default_permissions = "${profile}"
# What goes beyond the sandbox Codex refuses itself; only its MCP servers' questions come to the person.
approvals_reviewer = "user"
approval_policy = { granular = { sandbox_approval = false, rules = false, request_permissions = false, mcp_elicitations = true } }
# Its sign-in in this home, not the person's own.
cli_auth_credentials_store = "file"
web_search = "disabled"

# At work: the system's essentials read, the run's folder written; no network.
[permissions.${profile}.filesystem]
":minimal" = "read"

[permissions.${profile}.filesystem.":workspace_roots"]
"." = "write"

[permissions.${profile}.network]
enabled = false

# To read: the same, the folder read only.
[permissions.${profile}-read.filesystem]
":minimal" = "read"

[permissions.${profile}-read.filesystem.":workspace_roots"]
"." = "read"

[permissions.${profile}-read.network]
enabled = false

# Commands get Codex's core variables only; anything named like a key, secret or token is left out.
[shell_environment_policy]
inherit = "core"
ignore_default_excludes = false
set = { GIT_CONFIG_GLOBAL = "NUL" }

[windows]
sandbox = "elevated"

[features]
view_image = false
prefer_mxc = true
apps = false
plugins = false
hooks = false
memories = false
browser_use = false
browser_use_external = false
computer_use = false
`
}

export function run(p: Places, purpose: "work" | "read", profile: string) {
  return {
    permissions: {
      // The run's own places, in the profile it runs in: its scratch in the folder written (to read too); the programs on
      // its PATH and what the host adds, read.
      [purpose === "work" ? profile : `${profile}-read`]: {
        filesystem: Object.fromEntries([
          [p.scratch.root, "write"],
          ...p.toolchain.map((dir) => [dir, "read"]),
          ...p.readable.map((dir) => [dir, "read"]),
        ]),
      },
      // Never read: the system's temporary folders, and secret files in the folder.
      filesystem: { deny_read: [...p.temps, ...p.secrets] },
    },
    // Its commands' own home, temporary folder and caches, in its scratch: nothing of the person's.
    shell_environment_policy: {
      set: {
        HOME: p.scratch.home,
        USERPROFILE: p.scratch.home,
        TMPDIR: p.scratch.tmp,
        TMP: p.scratch.tmp,
        TEMP: p.scratch.tmp,
        XDG_CACHE_HOME: p.scratch.cache,
        npm_config_cache: path.join(p.scratch.cache, "npm"),
        GIT_CONFIG_GLOBAL: "NUL",
      },
    },
  }
}
