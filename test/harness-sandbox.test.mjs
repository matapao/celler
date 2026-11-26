import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRuntime } from 'celler/harness';
import { claudeOnLinux } from '../dist/harness/sandbox/claude.linux.js';
import { claudeOnMacos } from '../dist/harness/sandbox/claude.macos.js';
import { claudeOnWindows } from '../dist/harness/sandbox/claude.windows.js';
import { CODEX_FEATURES, CODEX_FEATURES_ON } from '../dist/harness/sandbox/codex-features.js';
import { codexOnLinux } from '../dist/harness/sandbox/codex.linux.js';
import { codexOnMacos } from '../dist/harness/sandbox/codex.macos.js';
import { codexOnWindows } from '../dist/harness/sandbox/codex.windows.js';
import { AGENT_SETTINGS, inside, unfitFolder } from '../dist/harness/sandbox/places.js';
import { fakeClaude, fakeCodex, host, inFolder, placesIn, sentTo, spec } from './support-harness.mjs';

test("a run's folder that is or holds the person's home, the filesystem's root or a system temporary folder is refused, before anything is made in it", () =>
  inFolder(async (dir) => {
    const home = path.join(dir, 'home');
    mkdirSync(path.join(home, 'work'), { recursive: true });
    const was = process.env.HOME;
    process.env.HOME = home;
    try {
      const log = path.join(dir, 'agent.jsonl');
      const runtime = new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: log }), host);
      for (const cwd of [home, dir, path.parse(dir).root, realpathSync(os.tmpdir())]) {
        const refused = await runtime.run(spec({ cwd }), () => undefined).done;
        assert.match(refused.error ?? '', /^A run can't work in /, cwd);
      }
      assert.deepEqual([existsSync(path.join(home, '.celler')), existsSync(log)], [false, false]);
      // A folder inside the home is the run's own.
      const inside = await runtime.run(spec({ cwd: path.join(home, 'work') }), () => undefined).done;
      assert.equal(inside.ok, true, inside.error);
    } finally {
      process.env.HOME = was;
    }
  }));

test("a run's folder whose path a sandbox would take as a pattern, or that is in an agent's own settings, is refused before anything is made in it", () =>
  inFolder(async (dir) => {
    const log = path.join(dir, 'agent.jsonl');
    const runtime = new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: log }), host);
    for (const name of ['Client [ACME]', 'all*', 'what?']) {
      const cwd = path.join(dir, name);
      mkdirSync(cwd);
      const refused = await runtime.run(spec({ cwd }), () => undefined).done;
      assert.match(
        refused.error ?? '',
        /its path holds \* \? \[ or \], which the agents' sandboxes take as a pattern$/,
        name,
      );
      assert.equal(existsSync(path.join(cwd, '.celler')), false, name);
    }
    // An agent's settings, its own home's (~/.codex, ~/.claude) or a repository's, wherever no variable names them; each
    // that can hold a folder.
    for (const name of AGENT_SETTINGS.filter((name) => name !== '.mcp.json')) {
      const cwd = path.join(dir, 'repo', name, 'skills');
      mkdirSync(cwd, { recursive: true });
      const refused = await runtime.run(spec({ cwd }), () => undefined).done;
      assert.match(
        refused.error ?? '',
        new RegExp(`it is in \\${name}, the settings of an agent celler runs, which no run may change$`),
        name,
      );
      // To read, too.
      const reading = await runtime.run(spec({ cwd: dir, readable: [cwd] }), () => undefined).done;
      assert.match(reading.error ?? '', /^A run can't read /, name);
    }
    assert.equal(existsSync(log), false);
  }));

test("a place no run may reach is refused by every name it has: in another case, or by its name on macOS's data volume", () => {
  if (process.platform !== 'darwin') return;
  const home = os.homedir();
  // The home in capitals is the home; the data volume's name for it too, and the data volume holds it.
  for (const folder of [home.toUpperCase(), `/System/Volumes/Data${home}`, '/System/Volumes/Data']) {
    assert.match(unfitFolder(folder) ?? '', /^A run can't work in /, folder);
  }
  // A folder in the home, by any of its names, is still one a run may have.
  assert.equal(unfitFolder(path.join(home.toUpperCase(), 'Library')), null);
  assert.equal(unfitFolder(`/System/Volumes/Data${home}/Library`), null);
});

test("what the host adds for a run to read is held to the same: the person's home or a temporary folder fails the run before it starts", () =>
  inFolder(async (dir) => {
    const work = path.join(dir, 'work');
    const repository = path.join(dir, 'repo', '.git');
    mkdirSync(work);
    mkdirSync(repository, { recursive: true });
    const log = path.join(dir, 'agent.jsonl');
    const runtime = new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: log }), host);
    for (const readable of [[os.homedir()], ...(process.platform === 'win32' ? [] : [['/tmp']])]) {
      const refused = await runtime.run(spec({ cwd: work, readable }), () => undefined).done;
      assert.match(refused.error ?? '', /^A run can't read /, readable[0]);
    }
    assert.deepEqual([existsSync(path.join(work, '.celler')), existsSync(log)], [false, false]);
    // A repository's data beside the folder it reads, by its real path, as its sandbox sees it; and the folder by its own.
    const reading = await runtime.run(spec({ cwd: work, readable: [repository] }), () => undefined).done;
    assert.equal(reading.ok, true, reading.error);
    const { filesystem } = sentTo(log).find((e) => e.what === 'started').data.settings.sandbox;
    assert.ok(filesystem.allowRead.includes(realpathSync.native(repository)), filesystem.allowRead.join('\n'));
    assert.deepEqual(filesystem.allowWrite, [realpathSync.native(work)]);
  }));

test("a run's folder that is, holds or is in the agent's own home is refused: Codex's home, and Claude Code's where the person keeps it", () =>
  inFolder(async (dir) => {
    const home = path.join(dir, 'work', 'codex-home');
    mkdirSync(path.join(home, 'sessions'), { recursive: true });
    const log = path.join(dir, 'codex.jsonl');
    const codex = new AgentRuntime(fakeCodex(home, { FAKE_CODEX_LOG: log }), host);
    for (const cwd of [path.join(dir, 'work'), home, path.join(home, 'sessions')]) {
      const refused = await codex.run(spec({ cwd }), () => undefined).done;
      assert.match(refused.error ?? '', /^A run can't work in .*, the agent's own home, which no run may reach$/, cwd);
    }
    assert.equal(existsSync(log), false);
    // Claude Code's own (CLAUDE_CONFIG_DIR), when the person keeps it somewhere of their choosing.
    const config = path.join(dir, 'claude-config');
    mkdirSync(path.join(config, 'projects'), { recursive: true });
    const was = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = config;
    try {
      const refused = await new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: log }), host).run(
        spec({ cwd: path.join(config, 'projects') }),
        () => undefined,
      ).done;
      assert.match(refused.error ?? '', /, the agent's own home, which no run may reach$/);
    } finally {
      if (was === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = was;
    }
    assert.equal(existsSync(log), false);
  }));

test("the agent's own home is closed to its commands wherever it is: Codex's, made for its owner alone, and Claude Code's", () =>
  inFolder(async (dir) => {
    const work = path.join(dir, 'work');
    mkdirSync(work);
    // Outside the person's home, which would close it otherwise.
    const home = path.join(dir, 'codex-home');
    assert.equal(inside(os.homedir(), home), false);
    const log = path.join(dir, 'codex.jsonl');
    const codex = await new AgentRuntime(fakeCodex(home, { FAKE_CODEX_LOG: log }), host).run(
      spec({ cwd: work }),
      () => undefined,
    ).done;
    assert.equal(codex.ok, true, codex.error);
    if (process.platform !== 'win32') assert.equal(statSync(home).mode & 0o777, 0o700);
    const permissions = sentTo(log)[0].data.configs.find((c) => c.startsWith('permissions='));
    assert.ok(permissions.includes(`${JSON.stringify(realpathSync.native(home))} = "deny"`), permissions);
    // Claude Code's own (CLAUDE_CONFIG_DIR), never read by its commands.
    const config = path.join(dir, 'claude-config');
    mkdirSync(config);
    const claudeLog = path.join(dir, 'claude.jsonl');
    const was = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = config;
    try {
      const claude = await new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: claudeLog }), host).run(
        spec({ cwd: work }),
        () => undefined,
      ).done;
      assert.equal(claude.ok, true, claude.error);
    } finally {
      if (was === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = was;
    }
    const { filesystem } = sentTo(claudeLog).find((e) => e.what === 'started').data.settings.sandbox;
    assert.ok(filesystem.denyRead.includes(realpathSync.native(config)), filesystem.denyRead.join('\n'));
  }));

test("each harness's settings for each system keep its commands to the folder and off the network, and close the person's home as a whole", () => {
  const p = placesIn('/x');
  for (const [system, claude] of Object.entries({
    macos: claudeOnMacos,
    linux: claudeOnLinux,
    windows: claudeOnWindows,
  })) {
    for (const purpose of ['work', 'read']) {
      const own = claude(p, purpose);
      const at = `Claude Code on ${system}, to ${purpose}`;
      // Every command in the sandbox, none outside it, and no run where it can't start.
      assert.deepEqual(
        [own.sandbox.enabled, own.sandbox.failIfUnavailable, own.sandbox.allowUnsandboxedCommands],
        [true, true, false],
        at,
      );
      // No network at all: no host, no server of its own, no other program's socket.
      assert.deepEqual(
        own.sandbox.network,
        {
          allowedDomains: [],
          strictAllowlist: true,
          allowLocalBinding: false,
          allowUnixSockets: [],
          allowAllUnixSockets: false,
        },
        at,
      );
      // Written: the folder at work, else only its own scratch in it, and nothing else of ours (its sandbox adds its
      // shell's own temporary folder itself).
      assert.deepEqual(own.sandbox.filesystem.allowWrite, purpose === 'work' ? [p.folder] : [p.scratch.root], at);
      assert.ok(
        own.sandbox.filesystem.allowWrite.every((dir) => dir === p.folder || dir.startsWith(p.folder + path.sep)),
        at,
      );
      // Never read: the system's temporary folders, as a whole, and its own home wherever it is; the person's home and
      // other users' folders are closed by Claude Code's own rule. Read again: the folder, the run's short folder (its
      // shell's temporary one), PATH's folders in the home and what the host adds, and nothing else.
      assert.deepEqual(own.sandbox.filesystem.denyRead, [...p.temps, ...p.agentHomes], at);
      assert.deepEqual(own.sandbox.filesystem.allowRead, [p.folder, p.scratch.short, ...p.tools, ...p.readable], at);
      assert.deepEqual(
        [
          own.settings.permissions.blockReadsOutsideWorkingDirectories,
          own.settings.permissions.blockWritesOutsideWorkingDirectories,
        ],
        [true, true],
        at,
      );
      // Its temporary folder, where its sandbox gives its commands theirs: the run's short one; and git with no personal
      // settings.
      assert.deepEqual(
        own.env,
        { CLAUDE_CODE_TMPDIR: p.scratch.short, GIT_CONFIG_GLOBAL: system === 'windows' ? 'NUL' : '/dev/null' },
        at,
      );
      // The proxies' values never reach its commands.
      assert.deepEqual(
        own.sandbox.credentials.envVars,
        p.hidden.map((name) => ({ name, mode: 'deny' })),
        at,
      );
      // Its commands never wait for the person: each is in the sandbox, which keeps it to the rest.
      assert.deepEqual(own.settings.permissions.allow, ['Bash'], at);
      // The folder's own settings for the agents celler runs, never written: a run can't set up what an agent starts.
      // Claude Code puts these rules into its sandbox too, for its commands: checked on macOS with a real run.
      assert.deepEqual(
        own.settings.permissions.deny,
        AGENT_SETTINGS.flatMap((name) => [`Edit(**/${name})`, `Edit(**/${name}/**)`]),
        at,
      );
      assert.deepEqual([own.settings.disableClaudeAiConnectors, own.settings.autoMemoryEnabled], [true, false], at);
      // Its own tools are a list, each one decided: none that reach outside the computer, those a coding agent works
      // with, and to read, none that write: no commands either, which its sandbox always lets write its working folder.
      const reading = ['Read', 'Glob', 'Grep', 'Agent', 'ToolSearch', 'AskUserQuestion'];
      const writing = ['Write', 'Edit', 'NotebookEdit', 'Bash', 'TaskStop'];
      assert.deepEqual([...own.tools].sort(), (purpose === 'work' ? [...reading, ...writing] : reading).sort(), at);
      // On Linux its sandbox skips a pattern for what its commands may not write: the agents' settings at the folder's
      // top are named in full there, there or not.
      const named = AGENT_SETTINGS.map((name) => `${p.folder}/${name}`);
      assert.deepEqual(own.sandbox.filesystem.denyWrite, system === 'linux' ? named : undefined, at);
      assert.equal(own.permissionMode, purpose === 'work' ? 'acceptEdits' : 'default', at);
    }
  }
  for (const [system, codex] of Object.entries({ macos: codexOnMacos, linux: codexOnLinux, windows: codexOnWindows })) {
    for (const purpose of ['work', 'read']) {
      const own = codex(p, purpose);
      const at = `Codex on ${system}, to ${purpose}`;
      // One profile, the run's own, with no network.
      assert.equal(own.default_permissions, 'run', at);
      assert.deepEqual(Object.keys(own.permissions), ['run'], at);
      assert.deepEqual(own.permissions.run.network, { enabled: false }, at);
      // The computer read, but never the person's home or the system's temporary folders, each as a whole; in those,
      // PATH's folders and what the host adds read. Its own home never, wherever it is. To read, the run's scratch
      // written; at work the folder holds it, with no entry of its own the run's commands could put a link in place of.
      const { ':workspace_roots': folder, ...computer } = own.permissions.run.filesystem;
      const each = (places, access) => Object.fromEntries(places.map((place) => [place, access]));
      const scratch = purpose === 'work' ? {} : { [p.scratch.root]: 'write' };
      assert.deepEqual(
        computer,
        {
          ':root': 'read',
          [p.home]: 'deny',
          ...each(p.temps, 'deny'),
          ...each([...p.tools, ...p.readable], 'read'),
          ...each(p.agentHomes, 'deny'),
          ...scratch,
        },
        at,
      );
      assert.ok(p.scratch.root.startsWith(p.folder + path.sep), at);
      // The folder written at work, else read; its own settings for the agents celler runs never, wherever they are.
      assert.equal(folder['.'], purpose === 'work' ? 'write' : 'read', at);
      for (const name of AGENT_SETTINGS) {
        for (const pattern of [`**/${name}`, `**/${name}/**`])
          assert.equal(folder[pattern], 'deny', `${at}: ${pattern}`);
      }
      // Beyond the sandbox refused, never asked; no web search, no image read from anywhere, no plugins, hooks or
      // memories, no skills it comes with, no goals it keeps after its turn, no pictures made, no MCP server installed:
      // its features are every system's, and celler lets none other be on but those it has decided on.
      assert.deepEqual([own.approval_policy, own.web_search], ['never', 'disabled'], at);
      assert.deepEqual(own.skills, { bundled: { enabled: false } }, at);
      // No helpers of its own, and no folder's AGENTS.md as its instructions.
      assert.deepEqual([own.agents, own.project_doc_max_bytes], [{ enabled: false }, 0], at);
      assert.equal(own.features, CODEX_FEATURES, at);
      for (const feature of [
        'view_image',
        'apps',
        'plugins',
        'hooks',
        'memories',
        'browser_use',
        'browser_use_external',
        'computer_use',
        'goals',
        'image_generation',
        'skill_mcp_dependency_install',
        'multi_agent',
        'multi_agent_v2',
      ]) {
        assert.equal(own.features[feature], false, `${at}: ${feature}`);
      }
      for (const feature of Object.keys(own.features)) assert.equal(CODEX_FEATURES_ON.has(feature), false, feature);
      // Its commands get Codex's core variables only, nothing named like a key, secret or token, and the run's own home,
      // temporary folder and caches.
      assert.deepEqual(
        [own.shell_environment_policy.inherit, own.shell_environment_policy.ignore_default_excludes],
        ['core', false],
        at,
      );
      const set = own.shell_environment_policy.set;
      assert.deepEqual(
        [set.HOME, set.TMPDIR, set.XDG_CACHE_HOME, set.GIT_CONFIG_GLOBAL],
        [p.scratch.home, p.scratch.tmp, p.scratch.cache, system === 'windows' ? 'NUL' : '/dev/null'],
        at,
      );
      if (system === 'windows') {
        assert.deepEqual([set.USERPROFILE, set.TMP, set.TEMP], [p.scratch.home, p.scratch.tmp, p.scratch.tmp], at);
        assert.deepEqual(own.windows, { sandbox: 'elevated' }, at);
      }
    }
  }
});
