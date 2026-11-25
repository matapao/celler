// Claude Code on Windows: what every run of it starts with, in Claude Code's own settings (the keys of its settings.json
// and its Agent SDK options), so each line can be held against its documentation. Its sandbox here is its own for
// Windows: commands run as its sandbox group, with permissions on the folders they may use. It doesn't start in the home
// folder itself, or in a folder holding it. Where its shell keeps its own temporary files here is its sandbox's to say;
// these settings were run on macOS, not here. Guarantees, each asserted for every system's file by
// test/harness-sandbox.test.mjs:
// - every command runs in the sandbox, none outside it, and where the sandbox can't start, nothing runs;
// - commands reach no network at all: everything outside the computer goes through the host's tools (MCP);
// - they write only in the run's folder (only at work), its own scratch folder inside it, and its shell's own temporary
//   folder, which its sandbox gives its commands and Claude Code can't do without (its working folder after each
//   command); never the folder's own settings for the agents celler runs, nor a repository's hooks and git settings
//   there, which its sandbox keeps read-only itself;
// - they read the folder and the system, never the person's home (where the host keeps its data), other users' folders,
//   the system's temporary folders, which other programs share, or Claude Code's own settings and sign-in where the
//   person keeps them (CLAUDE_CONFIG_DIR); the proxies' values never reach them;
// - its own tools are the ones listed, none that reach outside the computer, and its file tools keep to the folder;
// - to read, none of its tools writes: no file tool that writes, and no commands, which its sandbox always lets write its
//   working folder, whatever it is told.

import { AGENT_SETTINGS, type Places } from './places.js';

/** Its own tools: files, commands, helpers, the run's MCP tools and questions to the person. */
const WORK_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'Bash',
  'TaskStop',
  'Agent',
  'ToolSearch',
  'AskUserQuestion',
];
/** Those that can change the folder, which a run to read doesn't have: its commands, and stopping one, among them. */
const WRITING_TOOLS = ['Write', 'Edit', 'NotebookEdit', 'Bash', 'TaskStop'];

export function claudeOnWindows(p: Places, purpose: 'work' | 'read') {
  return {
    tools: purpose === 'work' ? WORK_TOOLS : WORK_TOOLS.filter((tool) => !WRITING_TOOLS.includes(tool)),
    sandbox: {
      enabled: true, // every command it runs, in the sandbox
      failIfUnavailable: true, // no sandbox, no run
      allowUnsandboxedCommands: false, // never a command outside it, even one it asks for
      autoAllowBashIfSandboxed: true, // inside it, commands go without asking the person
      filesystem: {
        // Never read: the system's temporary folders, and its own home (CLAUDE_CONFIG_DIR) wherever it is. The person's
        // home and other users' folders are closed by blockReadsOutsideWorkingDirectories below, Claude Code's own rule.
        denyRead: [...p.temps, ...p.agentHomes],
        // Read again: the folder (its scratch in it), the run's short folder (its shell's temporary one), PATH's folders
        // in the home, and what the host adds.
        allowRead: [p.folder, p.scratch.short, ...p.tools, ...p.readable],
        // Written: the folder at work, else only its own scratch in it, though a run to read has no commands (and its
        // shell's own temporary folder, which its sandbox adds itself). Nothing else: what isn't here can't be written.
        allowWrite: purpose === 'work' ? [p.folder] : [p.scratch.root],
      },
      network: {
        allowedDomains: [], // no host at all
        strictAllowlist: true, // and nothing that isn't on that list
        allowLocalBinding: false, // nor a server of its own, even on this computer
        allowUnixSockets: [], // nor another program's socket
        allowAllUnixSockets: false,
      },
      // The proxies' variables are Claude Code's own, to reach its service; never its commands'.
      credentials: { envVars: p.hidden.map((name) => ({ name, mode: 'deny' as const })) },
    },
    settings: {
      permissions: {
        // Its commands, every one in the sandbox, which keeps them to all of the above: none waits for the person.
        allow: ['Bash'],
        // Its own file tools: in the folder only. And with its sandbox and its network kept to an allow-list, Claude
        // Code's commands see none of the person's home or other users' folders (but the person's git settings, which
        // it keeps readable for git), and it opens again the folders its tools are in there.
        blockReadsOutsideWorkingDirectories: true,
        blockWritesOutsideWorkingDirectories: true,
        // The folder's own settings for the agents celler runs, never written (AGENT_SETTINGS): by its own file tools,
        // nor by its commands, as Claude Code puts these rules into its sandbox too.
        deny: AGENT_SETTINGS.flatMap((name) => [`Edit(**/${name})`, `Edit(**/${name}/**)`]),
      },
      disableClaudeAiConnectors: true, // only the host's connectors, not the person's claude.ai ones
      autoMemoryEnabled: false, // nothing carried from one run to the next
    },
    // At work, edits in the folder go ahead; to read, nothing of its own would ask. Anything else asks the person.
    permissionMode: purpose === 'work' ? ('acceptEdits' as const) : ('default' as const),
    // Its own temporary folder, the run's short one (here its scratch's: Windows needs no short path), where its
    // sandbox gives its commands theirs; and git with no personal settings.
    env: { CLAUDE_CODE_TMPDIR: p.scratch.short, GIT_CONFIG_GLOBAL: 'NUL' },
  };
}
