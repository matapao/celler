import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { AgentRuntime, chosenPrograms, claudeAgent, codexAgent, findProgram } from '@matapao/celler/harness';
import { agentVersions } from '../dist/limits.js';
import { agentEnv, CODEX_TARGETS, codexProgram } from '../dist/harness/programs.js';
import {
  claudeWords,
  codexHome,
  codexWords,
  fakeClaude,
  fakeCodex,
  host,
  inFolder,
  sentTo,
  spec,
} from './support-harness.mjs';

test("Claude Code says in the host's words when its program isn't there", async () => {
  const missing = new AgentRuntime(claudeAgent({ claude: () => null, words: claudeWords }), host);
  const health = await missing.health(false);
  assert.deepEqual([health.ok, health.fix, health.detail], [false, 'find', claudeWords.noClaude]);
  const run = await missing.run(spec(), () => undefined).done;
  assert.deepEqual([run.runtimeDown, run.error], [true, claudeWords.noClaude]);
  assert.deepEqual(missing.login(), { error: claudeWords.noClaude });
});

test("Codex's health says, in the host's words, when it isn't found, when it is too old and when it isn't signed in for the host", () =>
  inFolder(async (dir) => {
    const home = path.join(dir, 'home');
    const notFound = await new AgentRuntime(codexAgent({ codex: () => null, home, words: codexWords }), host).health(
      false,
    );
    assert.deepEqual(
      [notFound.fix, notFound.detail],
      ['find', `Codex wasn't found on this computer. ${codexWords.install}`],
    );
    // A Codex CLI that says its version, and isn't signed in.
    const cli = (version) => {
      const file = path.join(dir, `codex-${version}`);
      writeFileSync(
        file,
        `#!/usr/bin/env node\nif (process.argv[2] === '--version') console.log('codex-cli ${version}')\nelse process.exit(1)\n`,
      );
      chmodSync(file, 0o755);
      return file;
    };
    const signedOut = await new AgentRuntime(
      codexAgent({ codex: () => cli(agentVersions.codex), home, words: codexWords }),
      host,
    ).health(false);
    assert.deepEqual(
      [signedOut.fix, signedOut.detail],
      ['login', `Codex ${agentVersions.codex} · ${codexWords.signedOut}`],
    );
    // One older than its SDK is made with, which no run would work with.
    const old = await new AgentRuntime(
      codexAgent({ codex: () => cli('0.160.0'), home, words: codexWords }),
      host,
    ).health(false);
    assert.deepEqual(
      [old.ok, old.detail],
      [false, `Codex 0.160.0 is older than ${agentVersions.codex}, the oldest that runs here: update it.`],
    );
  }));

test("Codex runs only with its features as celler decides them: one it doesn't take as given, or one more it turns on, stops its runs and its health, and is asked again each time", () =>
  inFolder(async (dir) => {
    const asked = path.join(dir, 'asked.log');
    const own = path.join(dir, 'own');
    const program = path.join(dir, 'codex');
    // A Codex CLI, signed in, that lists the features it is given as given, then its own, in `own`; nothing else.
    writeFileSync(
      program,
      [
        '#!/usr/bin/env node',
        'const fs = require("node:fs")',
        'const [what, ...rest] = process.argv.slice(2)',
        `if (what === "--version") console.log("codex-cli ${agentVersions.codex}")`,
        'else if (what === "login") console.log("Logged in using ChatGPT")',
        'else if (what === "features") {',
        `  fs.appendFileSync(${JSON.stringify(asked)}, "asked\\n")`,
        '  const given = rest.find((arg) => arg.startsWith("features=")) ?? ""',
        '  for (const [, name, on] of given.matchAll(/(\\w+) = (true|false)/g)) console.log(name + "  stable  " + on)',
        `  process.stdout.write(fs.readFileSync(${JSON.stringify(own)}, "utf8"))`,
        '} else process.exit(1)',
      ].join('\n'),
    );
    chmodSync(program, 0o755);
    const runtime = new AgentRuntime(codexAgent({ codex: () => program, home: codexHome, words: codexWords }), host);
    const named = `Codex ${agentVersions.codex}`;
    const ends = ': it runs once celler is made for this version.';
    for (const [listed, why] of [
      ['brand_new_tool   stable   true\n', `${named} turns on brand_new_tool, which celler hasn't decided on${ends}`],
      ['goals   stable   true\n', `${named} doesn't take goals as celler sets them${ends}`],
    ]) {
      writeFileSync(own, listed);
      const health = await runtime.health(false);
      assert.deepEqual([health.ok, health.detail], [false, why]);
      const run = await runtime.run(spec({ cwd: dir }), () => undefined).done;
      assert.deepEqual([run.ok, run.runtimeDown, run.error], [false, true, why]);
    }
    // Asked each time; then, with only what celler has decided on, and one Codex no longer has, it runs.
    assert.equal(readFileSync(asked, 'utf8'), 'asked\n'.repeat(4));
    writeFileSync(
      own,
      'shell_tool   stable   true\nbrand_new_tool   removed   true\nmulti_agent   deprecated   true\n',
    );
    const fit = await runtime.health(false);
    assert.deepEqual([fit.ok, fit.detail], [true, `${named} (not yet test-run)`]);
  }));

test("each agent's oldest program that runs is the one its installed SDK is made with", () => {
  const sdk = (name) =>
    JSON.parse(readFileSync(fileURLToPath(new URL(`../node_modules/${name}/package.json`, import.meta.url)), 'utf8'));
  assert.equal(agentVersions.claude, sdk('@anthropic-ai/claude-agent-sdk').claudeCodeVersion);
  assert.equal(agentVersions.codex, sdk('@openai/codex-sdk').dependencies['@openai/codex']);
});

test("a run starts only an agent's program new enough to run, with no health check before it: one too old is asked again each run, as an update behind a shim leaves its file as it was", () =>
  inFolder(async (dir) => {
    const program = path.join(dir, 'claude');
    const version = path.join(dir, 'version');
    const asked = path.join(dir, 'asked.log');
    const started = path.join(dir, 'started.log');
    // A shim, which says the version of the program it leads to, and otherwise only that it was started.
    writeFileSync(
      program,
      [
        '#!/usr/bin/env node',
        'const fs = require("node:fs")',
        `const version = fs.readFileSync(${JSON.stringify(version)}, "utf8")`,
        `if (process.argv[2] === "--version") fs.appendFileSync(${JSON.stringify(asked)}, version + "\\n"), console.log(version + " (Claude Code)")`,
        `else fs.appendFileSync(${JSON.stringify(started)}, "started\\n")`,
      ].join('\n'),
    );
    chmodSync(program, 0o755);
    writeFileSync(version, '2.1.30');
    const runtime = new AgentRuntime(claudeAgent({ claude: () => program, words: claudeWords }), host);
    for (let i = 0; i < 2; i++) {
      const old = await runtime.run(spec({ cwd: dir }), () => undefined).done;
      assert.deepEqual(
        [old.ok, old.runtimeDown, old.error],
        [
          false,
          true,
          `Claude Code 2.1.30 is older than ${agentVersions.claude}, the oldest that runs here: update it.`,
        ],
      );
    }
    // Asked each time, never started.
    assert.deepEqual([readFileSync(asked, 'utf8'), existsSync(started)], ['2.1.30\n2.1.30\n', false]);
    // Updated behind the shim, whose file is as it was: asked again, and started; from then on, known.
    writeFileSync(version, agentVersions.claude);
    for (let i = 0; i < 2; i++) {
      const updated = await runtime.run(spec({ cwd: dir }), () => undefined).done;
      assert.equal(updated.runtimeDown, false);
    }
    assert.deepEqual(
      [readFileSync(asked, 'utf8'), existsSync(started)],
      [`2.1.30\n2.1.30\n${agentVersions.claude}\n`, true],
    );
    // Its version known, as after a health check, its agent starts as its run does: its process is there at once.
    const known = new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: path.join(dir, 'agent.jsonl') }), host);
    await known.health(false);
    const handle = known.run(spec({ cwd: dir }), () => undefined);
    assert.ok(handle.pid);
    assert.equal((await handle.done).ok, true);
  }));

test("Codex installed with npm runs as its own program, found as npm's wrapper finds it, with its helpers on PATH", () =>
  inFolder((dir) => {
    const platform = `${process.platform}-${process.arch}`;
    const target = CODEX_TARGETS[platform];
    if (!target || process.platform === 'win32') return;
    // npm's layout: the wrapper in its package, Codex's own program in the package for this system beside it.
    const pkg = path.join(dir, 'lib', 'node_modules', '@openai', 'codex');
    mkdirSync(path.join(pkg, 'bin'), { recursive: true });
    writeFileSync(path.join(pkg, 'bin', 'codex.js'), '');
    const own = path.join(pkg, 'node_modules', '@openai', `codex-${platform}`);
    mkdirSync(path.join(own, 'vendor', target, 'bin'), { recursive: true });
    mkdirSync(path.join(own, 'vendor', target, 'codex-path'));
    writeFileSync(path.join(own, 'package.json'), '{}');
    writeFileSync(path.join(own, 'vendor', target, 'bin', 'codex'), '');
    mkdirSync(path.join(dir, 'bin'));
    symlinkSync(path.join(pkg, 'bin', 'codex.js'), path.join(dir, 'bin', 'codex'));
    const real = realpathSync(own);
    assert.deepEqual(codexProgram(path.join(dir, 'bin', 'codex')), {
      program: path.join(real, 'vendor', target, 'bin', 'codex'),
      path: [path.join(real, 'vendor', target, 'codex-path')],
    });
    // Its own program from another installer starts as it is.
    writeFileSync(path.join(dir, 'codex-native'), '');
    assert.deepEqual(codexProgram(path.join(dir, 'codex-native')), {
      program: realpathSync(path.join(dir, 'codex-native')),
      path: [],
    });
  }));

test("an agent's program is found on PATH only in the folders it names in full, never one relative to where the host is", () =>
  inFolder((dir) => {
    mkdirSync(path.join(dir, 'bin'));
    writeFileSync(path.join(dir, 'bin', 'claude'), '#!/bin/sh\n');
    chmodSync(path.join(dir, 'bin', 'claude'), 0o755);
    const was = { path: process.env.PATH, cwd: process.cwd() };
    try {
      // Where its installers put it, if anywhere on this computer: null here.
      process.env.PATH = '';
      const installed = findProgram('claude');
      process.chdir(dir);
      process.env.PATH = 'bin';
      assert.equal(findProgram('claude'), installed);
    } finally {
      process.env.PATH = was.path;
      process.chdir(was.cwd);
    }
  }));

test("Codex's own errands use its own sign-in, in its home: no key, token or endpoint from the person's shell", () => {
  const names = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_BASE_URL'];
  const was = names.map((name) => process.env[name]);
  for (const name of names) process.env[name] = 'from-the-shell';
  try {
    const env = agentEnv(codexAgent({ codex: () => null, home: codexHome, words: codexWords }).env(host), host);
    assert.deepEqual([names.filter((name) => env[name] !== undefined), env.CODEX_HOME], [[], codexHome]);
  } finally {
    names.forEach((name, i) => (was[i] === undefined ? delete process.env[name] : (process.env[name] = was[i])));
  }
});

test('where the person showed the host each program is kept in full, in a folder made for it', () =>
  inFolder((dir) => {
    const file = path.join(dir, 'settings', 'programs.json');
    const chosen = chosenPrograms(file);
    assert.throws(() => chosen.set('claude', path.join('bin', 'claude')), /isn't a full path/);
    const claude = path.join(dir, 'bin', 'claude');
    chosen.set('claude', claude);
    assert.equal(chosenPrograms(file).get('claude'), claude);
  }));

test("an agent that isn't signed in takes its runtime offline in the host's words, and a session that is gone says so", () =>
  inFolder(async (dir) => {
    const claude = await new AgentRuntime(
      fakeClaude({ FAKE_CLAUDE_LOG: path.join(dir, 'claude.jsonl'), FAKE_CLAUDE_SIGNED_OUT: '1' }),
      host,
    ).run(spec({ cwd: dir }), () => undefined).done;
    assert.deepEqual([claude.ok, claude.runtimeDown, claude.error], [false, true, claudeWords.login]);
    const home = codexHome;
    const codexLog = path.join(dir, 'codex.jsonl');
    const codex = await new AgentRuntime(
      fakeCodex(home, { FAKE_CODEX_LOG: codexLog, FAKE_CODEX_SIGNED_OUT: '1' }),
      host,
    ).run(spec({ cwd: dir }), () => undefined).done;
    assert.deepEqual([codex.ok, codex.runtimeDown, codex.error], [false, true, codexWords.login]);
    // A connector's server that says 401 is no sign-in of Codex's own: the run failed, Codex didn't.
    const connector = await new AgentRuntime(
      fakeCodex(home, { FAKE_CODEX_LOG: codexLog, FAKE_CODEX_MCP_401: '1' }),
      host,
    ).run(spec({ cwd: dir }), () => undefined).done;
    assert.deepEqual([connector.ok, connector.runtimeDown], [false, false]);
    const gone = await new AgentRuntime(fakeCodex(home, { FAKE_CODEX_LOG: codexLog }), host).run(
      spec({ cwd: dir, resume: true, sessionId: 'missing' }),
      () => undefined,
    ).done;
    // Only its words say so, and the harness already tells from them that it has no such session: that is its reason.
    assert.deepEqual(
      [gone.ok, gone.runtimeDown, gone.ended, gone.error],
      [false, false, 'session-not-found', 'Session missing could not be resumed: not found'],
    );
  }));

test('a deep health check test-runs the agent once, as a model-only run with no tools, and says how it went', () =>
  inFolder(async (dir) => {
    const log = path.join(dir, 'agent.jsonl');
    const prompts = () => sentTo(log).filter((e) => e.what === 'prompt');
    const runtime = new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: log }), host);
    const healthy = await runtime.health(true);
    assert.deepEqual([healthy.ok, healthy.detail], [true, `Claude Code ${agentVersions.claude} · test run succeeded`]);
    assert.equal(prompts()[0].data.text, 'Reply with exactly: OK');
    const opened = sentTo(log).find((e) => e.what === 'started').data;
    assert.equal(sentTo(log).find((e) => e.what === 'initialize').data.mcpServers, undefined);
    // In an empty folder of its own, never the temporary folder other programs share, and gone after it.
    assert.equal(path.dirname(opened.cwd), realpathSync(os.tmpdir()));
    assert.match(path.basename(opened.cwd), /^celler-test-run-/);
    assert.equal(existsSync(opened.cwd), false);
    // Without deep, no run at all.
    assert.deepEqual(
      [(await runtime.health(false)).detail, prompts().length],
      [`Claude Code ${agentVersions.claude} (not yet test-run)`, 1],
    );
    // A test run that doesn't finish in its time: not healthy, and why.
    const slow = await new AgentRuntime({ ...fakeClaude({ FAKE_CLAUDE_LOG: log }), testRunMs: 1 }, host).health(true);
    assert.deepEqual([slow.ok, slow.detail], [false, `Claude Code ${agentVersions.claude} · Timed out after 0 s`]);
    // A sign-in it still has but that no longer works: its test run says so, and the host can offer the sign-in again.
    const expired = await new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_EXPIRED: '1' }), host).health(
      true,
    );
    assert.deepEqual(
      [expired.ok, expired.fix, expired.detail],
      [false, 'login', `Claude Code ${agentVersions.claude} · ${claudeWords.login}`],
    );
  }));

test("an agent's own sign-in gives its page's address as it is, from either of its outputs, and can be called off", async () => {
  // Claude Code's, as a terminal link (OSC 8): its address, then the same as its words.
  const url = 'https://claude.ai/oauth/authorize?code=true&client_id=fake-id&state=a_b-c';
  for (const env of [
    { FAKE_CLAUDE_LOGIN_URL: url },
    { FAKE_CLAUDE_LOGIN_URL: url, FAKE_CLAUDE_LOGIN_ON_STDERR: '1' },
  ]) {
    const login = new AgentRuntime(fakeClaude(env), host).login();
    try {
      assert.equal(await Promise.race([login.url, delay(5_000).then(() => 'no address in 5 s')]), url);
    } finally {
      login.cancel();
    }
    // Called off, it ends.
    const ended = await Promise.race([login.done, delay(5_000).then(() => 'still going')]);
    assert.equal(ended.ok, false);
  }
});

test("from another device, Codex's sign-in shows its page and a one-time code of its own, and Claude Code's is as it is", async () => {
  const within = (p) => Promise.race([p, delay(5_000).then(() => 'nothing in 5 s')]);
  const codex = new AgentRuntime(fakeCodex(codexHome), host);
  const device = codex.login({ elsewhere: true });
  try {
    // Its page, then its code, which comes after it: each as it is, its terminal escapes gone.
    assert.equal(await within(device.url), 'https://auth.openai.com/codex/device');
    assert.equal(await within(device.userCode), 'FAKE-12345');
  } finally {
    device.cancel();
  }
  // Called off, it says so, not the warning it showed last.
  assert.deepEqual(await within(device.done), { ok: false, error: 'Sign-in called off' });
  // Refused before it showed one: no code, and why.
  const refused = new AgentRuntime(fakeCodex(codexHome, { FAKE_CODEX_DEVICE_REFUSED: '1' }), host).login({
    elsewhere: true,
  });
  assert.equal(await within(refused.userCode), null);
  assert.deepEqual(await within(refused.done), { ok: false, error: 'Error: device code login is not enabled' });
  // Its own on this computer, and Claude Code's from anywhere: no code of their own.
  const own = codex.login();
  assert.equal('userCode' in own, false);
  assert.equal((await within(own.done)).ok, true);
  const url = 'https://claude.ai/oauth/authorize?code=true&client_id=fake-id';
  const claude = new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOGIN_URL: url }), host).login({ elsewhere: true });
  try {
    assert.equal(await within(claude.url), url);
    assert.equal('userCode' in claude, false);
  } finally {
    claude.cancel();
  }
});
