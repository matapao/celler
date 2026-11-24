// One run of Claude Code through the Claude Agent SDK: its options from the run and its settings file for this system
// (sandbox/claude.*.ts), and the run to its end, as it reports what it does, what it asks put to the person, and how it
// ended (claude-report.ts).

import { query, type EffortLevel, type Options } from '@anthropic-ai/claude-agent-sdk';
import { harnessLimits as L } from '../limits.js';
import { Report } from './claude-report.js';
import { forThisSystem, promptOf, type Turn } from './runtime.js';
import { claudeOnLinux } from './sandbox/claude.linux.js';
import { claudeOnMacos } from './sandbox/claude.macos.js';
import { claudeOnWindows } from './sandbox/claude.windows.js';
import { isTier, type ModelTier, type RunResult, type RunSpec } from './types.js';

/** Claude Code's settings file for each system it runs on (sandbox/). */
const CLAUDE_ON: Partial<Record<NodeJS.Platform, typeof claudeOnMacos>> = {
  darwin: claudeOnMacos,
  linux: claudeOnLinux,
  win32: claudeOnWindows,
};

/** The efforts it takes, and the run's when it is one of them. */
const EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const effortOf = (spec: RunSpec) => EFFORTS.find((effort) => effort === spec.effort);

/** Its options for the run: the run's own, then its settings file's for this system, in its own words. */
function optionsFor(t: Turn, model: string): Options {
  const { spec } = t;
  const effort = effortOf(spec);
  const base: Options = {
    cwd: spec.cwd,
    pathToClaudeCodeExecutable: t.program,
    // Started as the runtime starts an agent's processes: in a process group of its own, which its end ends.
    spawnClaudeCodeProcess: (s) => t.spawn(s.command, s.args, s),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    // Its own system prompt, and the cells' texts after it: without it, it would start with an empty one.
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      ...(spec.systemPrompt ? { append: spec.systemPrompt } : {}),
    },
    // No settings files: a folder's own would run hooks and helpers outside what the host set. Only the host's connectors.
    settingSources: [],
    strictMcpConfig: true,
    ...(spec.resume ? { resume: spec.sessionId } : {}),
    includePartialMessages: true,
  };
  // A model-only decision: no tools at all, not even the run's MCP server, so nothing to keep in a sandbox.
  if (spec.purpose === 'inference') {
    return {
      ...base,
      env: t.env,
      tools: [],
      settings: { disableClaudeAiConnectors: true, autoMemoryEnabled: false },
      permissionMode: 'default',
      persistSession: false,
    };
  }
  const own = forThisSystem(CLAUDE_ON, 'Claude Code')(t.places, spec.purpose);
  // The host's servers gate each call themselves: Claude Code doesn't ask about their tools again.
  const allow = [...own.settings.permissions.allow, ...spec.mcpServers.map((s) => `mcp__${s.name}`)];
  return {
    ...base,
    env: { ...t.env, ...own.env },
    tools: own.tools,
    sandbox: own.sandbox,
    settings: { ...own.settings, permissions: { ...own.settings.permissions, allow } },
    permissionMode: own.permissionMode,
    // The host's servers, sent in its first request rather than on its command line, where anyone on the computer could
    // read their values; a call to them may wait for the person as long as celler lets it (limits.ts).
    mcpServers: Object.fromEntries(
      spec.mcpServers.map((s) => [
        s.name,
        {
          type: s.transport === 'sse' ? ('sse' as const) : ('http' as const),
          url: s.url,
          headers: s.headers,
          timeout: L.mcpCallMs,
        },
      ]),
    ),
    mcpServersDelivery: 'initialize',
  };
}

/** One run of Claude Code, to its end. */
export async function runClaude(
  t: Turn,
  o: { models: Record<ModelTier, string>; signedOut: string },
): Promise<RunResult> {
  const { spec } = t;
  const model = isTier(spec.model) ? o.models[spec.model] : spec.model;
  const report = new Report(t, effortOf(spec));
  const abort = new AbortController();
  const q = query({
    prompt: promptOf(spec),
    options: {
      ...optionsFor(t, model),
      canUseTool: report.permission,
      onElicitation: report.elicit,
      abortController: abort,
    },
  });
  // Asked to end its turn, its session kept to resume; stopped if it hasn't ended in its grace.
  const stop = () => {
    q.interrupt().catch(() => undefined);
    setTimeout(() => abort.abort(), L.exitGraceMs).unref();
  };
  t.signal.addEventListener('abort', stop, { once: true });
  if (t.signal.aborted) stop();
  q.initializationResult().then(
    (init) => report.named(init.models, init.account),
    () => undefined,
  );
  try {
    for await (const m of q) report.message(m);
  } catch (err) {
    report.broke(err);
  } finally {
    t.signal.removeEventListener('abort', stop);
    q.close();
  }
  return report.ending(o.signedOut);
}
