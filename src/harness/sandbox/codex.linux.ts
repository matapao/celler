// Codex on Linux: what every run of it starts with, in Codex's own settings (the keys of its config.toml), so each line
// can be held against its documentation. Its sandbox here is Linux's own (Landlock and seccomp, bubblewrap where
// needed). Codex takes them for the run on its command line, and loads no folder's own settings, as no folder is
// trusted in its home. Guarantees, each asserted for every system's file by test/harness-sandbox.test.mjs:
// - every command runs in the sandbox, and what would go beyond it Codex refuses itself, asking no one;
// - commands reach no network at all: everything outside the computer goes through the host's tools (MCP);
// - they write only in the run's folder (only at work) and its own scratch folder inside it, and never touch the
//   folder's own settings for the agents celler runs, nor a repository's hooks and git settings there, which Codex
//   keeps read-only itself (checked on macOS with a real run);
// - they read the computer, but never the person's home (where the host keeps its data) or the system's temporary
//   folders, which other programs share (their temporary files are in the scratch): there, only the folder, PATH's
//   folders and what the host adds; nor Codex's own home (CODEX_HOME), its settings and sign-in, wherever it is;
// - their environment is Codex's core variables and the run's own home and temporary folders;
// - no web search, no image read from anywhere on the computer, no plugins, hooks or memories.

import path from "node:path"
import { AGENT_SETTINGS, type Places } from "./places.js"

/** The folder's own settings for the agents celler runs, wherever they are in it: never written, and so not read. */
const SETTINGS = Object.fromEntries(AGENT_SETTINGS.flatMap((name) => [[`**/${name}`, "deny"], [`**/${name}/**`, "deny"]]))

/** Each of these places with one access, as Codex's filesystem table takes them. */
const each = (places: string[], access: "read" | "write" | "deny") => Object.fromEntries(places.map((place) => [place, access]))

export function codexOnLinux(p: Places, purpose: "work" | "read") {
  return {
    // The run's own permission profile, the only one it runs in.
    default_permissions: "run",
    permissions: {
      run: {
        filesystem: {
          // The computer read, but never the person's home or the system's temporary folders, each as a whole.
          ":root": "read",
          [p.home]: "deny",
          ...each(p.temps, "deny"),
          // In those, PATH's folders and what the host adds read.
          ...each(p.tools, "read"),
          ...each(p.readable, "read"),
          // Its own home, its settings and sign-in, never, wherever it is.
          ...each(p.agentHomes, "deny"),
          // The run's folder: written at work, else read but for the run's scratch in it. At work the folder holds the
          // scratch, which then has no entry of its own the run's commands could put a link in place of.
          ...each(purpose === "work" ? [] : [p.scratch.root], "write"),
          ":workspace_roots": { ".": purpose === "work" ? "write" : "read", ...SETTINGS },
        },
        network: { enabled: false },
      },
    },
    // What goes beyond the sandbox Codex refuses itself: no one is asked.
    approval_policy: "never",
    web_search: "disabled",
    // Commands get Codex's core variables only, none named like a key, secret or token; their own home, temporary
    // folder and caches in the run's scratch; and git with no personal settings.
    shell_environment_policy: {
      inherit: "core",
      ignore_default_excludes: false,
      set: {
        HOME: p.scratch.home,
        TMPDIR: p.scratch.tmp,
        XDG_CACHE_HOME: p.scratch.cache,
        npm_config_cache: path.join(p.scratch.cache, "npm"),
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    },
    features: {
      view_image: false,
      prefer_mxc: true,
      apps: false,
      plugins: false,
      hooks: false,
      memories: false,
      browser_use: false,
      browser_use_external: false,
      computer_use: false,
    },
  }
}
