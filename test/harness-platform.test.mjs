import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '@matapao/celler';
import { AgentRuntime, claudeAgent, codexAgent, harnessPlatform, SimulatedRuntime } from '@matapao/celler/harness';
import { harnessLimits } from '../dist/limits.js';
import {
  claudeWords,
  codexHome,
  codexWords,
  desk,
  fakeClaude,
  fakeCodex,
  github,
  host,
  inFolder,
  sentTo,
} from './support-harness.mjs';

// What a cell's agent is given through the harness platform: its tools on the run's own MCP server, or celler's menu,
// none for a model-only decision, its context as text, and a delegated run's failure in celler's words.

/** A tool that says back the text it was given, and its adapter. */
const echo = { call: async (_run, args) => ({ content: [{ type: 'text', text: `echo: ${args.text}` }] }) };
const echoTool = {
  definition: { inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  target: { adapter: 'echo' },
};

test("a run of the published graph reaches its cell's tools through the harness, on the run's own MCP server", () =>
  inFolder(async (dir) => {
    const ran = async (profile, agent, log) => {
      const runs = new Set();
      const runtime = (run) => (run.profile === profile ? new AgentRuntime(agent, host) : undefined);
      const { platform, app } = desk(runtime, { progress: (run) => runs.add(run.id) }, new Map([['echo', echo]]));
      const revision = app.publish([
        { kind: 'cell', id: 'desk', title: 'Desk', profile, context: ['Be brief.'], exports: ['echo'] },
        { kind: 'tool', id: 'echo', ...echoTool },
      ]);
      try {
        const result = await app.start({ owner: 'office', revision, entry: 'desk', workspace: dir, input: 'Use echo' });
        assert.equal(result.isError, false, JSON.stringify(result));
        assert.match(result.content[0].text, /echo: hi$/);
        assert.equal(result.structuredContent.ok, true);
        // The call went through celler: in the run's history.
        const [run] = runs;
        assert.deepEqual(
          app
            .history('office', run)
            .filter((e) => e.kind === 'call')
            .map((e) => e.detail.id),
          ['echo'],
        );
        return sentTo(log);
      } finally {
        await platform.close();
      }
    };
    // Claude Code: the cell's context as its instructions, the run's server under the host's name with a token of its own.
    const claudeLog = path.join(dir, 'claude.jsonl');
    const initialize = (
      await ran('claude', fakeClaude({ FAKE_CLAUDE_LOG: claudeLog, FAKE_CLAUDE_TOOL: 'echo' }), claudeLog)
    ).find((e) => e.what === 'initialize').data;
    assert.equal(initialize.appendSystemPrompt, 'Be brief.');
    assert.match(initialize.mcpServers.office.headers.Authorization, /^Bearer \S+$/);
    // A call to it may wait for the person as long as celler lets it, not as long as the agent would on its own.
    assert.equal(initialize.mcpServers.office.timeout, harnessLimits.mcpCallMs);
    // Codex: the same, its token in a variable of its own.
    const codexLog = path.join(dir, 'codex.jsonl');
    const exec = (
      await ran('codex', fakeCodex(codexHome, { FAKE_CODEX_LOG: codexLog, FAKE_CODEX_TOOL: 'echo' }), codexLog)
    ).find((e) => e.what === 'exec').data;
    assert.match(exec.prompt, /^Be brief\.\n\n---\n\nUse echo$/);
    assert.match(exec.values.CELLER_VALUE_0, /^Bearer \S+$/);
    assert.match(
      exec.configs.find((c) => c.startsWith('mcp_servers=')),
      new RegExp(`^mcp_servers=\\{ office = \\{ .*, tool_timeout_sec = ${harnessLimits.mcpCallMs / 1000} \\} \\}$`),
    );
  }));

test("a call to one of the run's MCP tools is reported with its server and tool, by either agent; a tool of the agent's own has neither", () =>
  inFolder(async (dir) => {
    const reported = async (agent) => {
      const tools = [];
      const progress = (_run, p) => p.type === 'tool' && tools.push(p);
      const { platform, app } = desk(() => new AgentRuntime(agent, host), { progress }, new Map([['echo', echo]]));
      const revision = app.publish([
        { kind: 'cell', id: 'desk', title: 'Desk', profile: 'any', exports: ['echo'] },
        { kind: 'tool', id: 'echo', ...echoTool },
      ]);
      try {
        const result = await app.start({ owner: 'office', revision, entry: 'desk', workspace: dir, input: 'Use echo' });
        assert.equal(result.isError, false, JSON.stringify(result));
        return tools.map((p) => ({ tool: p.tool, ...('mcp' in p ? { mcp: p.mcp } : {}) }));
      } finally {
        await platform.close();
      }
    };
    const echoed = { server: 'office', tool: 'echo' };
    // Claude Code's name for it keeps its own form; the server and tool are apart beside it.
    const claude = fakeClaude({ FAKE_CLAUDE_LOG: path.join(dir, 'claude.jsonl'), FAKE_CLAUDE_TOOL: 'echo' });
    assert.deepEqual(await reported(claude), [
      { tool: 'mcp__office__echo', mcp: echoed },
      { tool: 'Grep' },
      { tool: 'Bash' },
    ]);
    const codex = fakeCodex(codexHome, { FAKE_CODEX_LOG: path.join(dir, 'codex.jsonl'), FAKE_CODEX_TOOL: 'echo' });
    assert.deepEqual(await reported(codex), [
      { tool: 'office.echo', mcp: echoed },
      { tool: 'execute' },
      { tool: 'edit' },
    ]);
  }));

test("an agent that searches its tools itself is given them all, and any other gets celler's menu", () =>
  inFolder(async (dir) => {
    const listed = async (nativeDiscovery) => {
      const log = path.join(dir, `agent-${nativeDiscovery}.jsonl`);
      const platform = harnessPlatform({
        runtime: () =>
          new AgentRuntime(
            { ...fakeClaude({ FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_TOOL: 'echo' }), nativeDiscovery },
            host,
          ),
        allowed: () => true,
        server: 'office',
        spec: () => ({ prompt: 'x', model: '', sessionId: '', resume: false, timeoutMs: 20_000 }),
      });
      // No listing fits in no bytes: a run without its own search gets the menu.
      const app = createApp({
        database: new DatabaseSync(':memory:'),
        platform,
        adapters: new Map([['echo', echo]]),
        discoveryBytes: 0,
      });
      const revision = app.publish([
        { kind: 'cell', id: 'desk', title: 'Desk', profile: 'fake', exports: ['echo', 'notes'], pins: ['echo'] },
        { kind: 'tool', id: 'echo', ...echoTool },
        { kind: 'tool', id: 'notes', ...echoTool },
      ]);
      try {
        const result = await app.start({ owner: 'office', revision, entry: 'desk', workspace: dir, input: 'x' });
        assert.equal(result.isError, false, JSON.stringify(result));
        return sentTo(log).find((e) => e.what === 'tools/list').data;
      } finally {
        await platform.close();
      }
    };
    assert.deepEqual(await listed(true), ['echo', 'notes', 'discover']);
    assert.deepEqual(await listed(false), ['echo', 'discover', 'invoke']);
    // Claude Code and Codex each search theirs; the simulated agent calls none.
    const claude = new AgentRuntime(claudeAgent({ claude: () => null, words: claudeWords }), host);
    const codex = new AgentRuntime(codexAgent({ codex: () => null, home: dir, words: codexWords }), host);
    assert.deepEqual(
      [claude.nativeDiscovery, codex.nativeDiscovery, new SimulatedRuntime().nativeDiscovery],
      [true, true, undefined],
    );
  }));

test("a model-only decision gets no MCP server, not even the run's own", () =>
  inFolder(async (dir) => {
    const log = path.join(dir, 'agent.jsonl');
    const decision = () => ({
      prompt: 'Pick one',
      model: '',
      sessionId: '',
      resume: false,
      timeoutMs: 20_000,
      purpose: 'inference',
      mcpServers: [github],
    });
    const { platform, app, revision } = desk(() => new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: log }), host), {
      spec: decision,
    });
    try {
      const result = await app.start({ owner: 'office', revision, entry: 'desk', workspace: dir, input: 'x' });
      assert.equal(result.isError, false, JSON.stringify(result));
      assert.equal(sentTo(log).find((e) => e.what === 'initialize').data.mcpServers, undefined);
    } finally {
      await platform.close();
    }
  }));

test("a delegated run that fails tells the agent that called it so in celler's words, never its raw error, which the host hears", () =>
  inFolder(async (dir) => {
    const log = path.join(dir, 'agent.jsonl');
    const broken = {
      kind: 'broken',
      health: async () => ({ ok: false, checkedAt: 0, detail: '' }),
      run: () => {
        throw new Error('ENOENT: /Users/someone/host/data.db');
      },
    };
    const { platform, app, ended } = desk((run) =>
      run.profile === 'desk'
        ? new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_TOOL: 'helper' }), host)
        : broken,
    );
    const revision = app.publish([
      { kind: 'cell', id: 'desk', title: 'Desk', profile: 'desk', exports: ['helper'] },
      {
        kind: 'tool',
        id: 'helper',
        target: { cell: 'child' },
        definition: { name: 'helper', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
      },
      { kind: 'cell', id: 'child', title: 'Child', profile: 'child', exports: [] },
    ]);
    try {
      const result = await app.start({
        owner: 'office',
        revision,
        entry: 'desk',
        workspace: dir,
        input: 'Ask the helper',
      });
      assert.match(result.content[0].text, /The delegated run failed$/);
      assert.doesNotMatch(result.content[0].text, /ENOENT/);
      assert.ok(
        ended.some((r) => r.error === 'ENOENT: /Users/someone/host/data.db'),
        JSON.stringify(ended),
      );
    } finally {
      await platform.close();
    }
  }));

test("a platform whose MCP server couldn't open tries again for the next run", () =>
  inFolder(async (dir) => {
    // The next server to open fails, once.
    http.Server.prototype.listen = function () {
      delete http.Server.prototype.listen;
      process.nextTick(() =>
        this.emit('error', Object.assign(new Error('listen EADDRNOTAVAIL'), { code: 'EADDRNOTAVAIL' })),
      );
      return this;
    };
    const { platform, app } = desk(
      () =>
        new AgentRuntime(
          fakeClaude({ FAKE_CLAUDE_LOG: path.join(dir, 'agent.jsonl'), FAKE_CLAUDE_TOOL: 'echo' }),
          host,
        ),
      {},
      new Map([['echo', echo]]),
    );
    const revision = app.publish([
      { kind: 'cell', id: 'desk', title: 'Desk', profile: 'fake', exports: ['echo'] },
      { kind: 'tool', id: 'echo', ...echoTool },
    ]);
    const start = () => app.start({ owner: 'office', revision, entry: 'desk', workspace: dir, input: 'Use echo' });
    try {
      await assert.rejects(start(), /EADDRNOTAVAIL/);
      assert.match((await start()).content[0].text, /echo: hi$/);
    } finally {
      delete http.Server.prototype.listen;
      await platform.close();
    }
  }));

test("a cell's context reaches its agent as text, a resource's text too, and context with no text fails the run in celler's words", () =>
  inFolder(async (dir) => {
    const log = path.join(dir, 'agent.jsonl');
    const { platform, app } = desk(() => new AgentRuntime(fakeClaude({ FAKE_CLAUDE_LOG: log }), host));
    const deskWith = (context) =>
      app.publish([{ kind: 'cell', id: 'desk', title: 'Desk', profile: 'any', exports: [], context }]);
    const start = (revision) => app.start({ owner: 'office', revision, entry: 'desk', workspace: dir, input: 'Go' });
    try {
      await start(
        deskWith([
          'Be brief.',
          { type: 'resource', resource: { uri: 'policy://mail', text: 'Never email customers.' } },
        ]),
      );
      assert.equal(
        sentTo(log).find((e) => e.what === 'initialize').data.appendSystemPrompt,
        'Be brief.\n\nNever email customers.',
      );
      const image = await start(deskWith([{ type: 'image', data: 'AAAA', mimeType: 'image/png' }]));
      assert.deepEqual(
        [image.isError, image.content[0].text],
        [true, "A cell's context can't hold image content for an agent run by the harness: only text"],
      );
    } finally {
      await platform.close();
    }
  }));
