// One run as Claude Code reports it through its SDK: what it does as the run's progress, what it asks put to the person
// (its forms: claude-forms.ts), and how it ended.

import type {
  AccountInfo,
  CanUseTool,
  EffortLevel,
  ElicitationResult,
  ModelInfo,
  OnElicitation,
  PermissionResult,
  SDKAssistantMessageError,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { stripVTControlCharacters } from 'node:util';
import { harnessLimits as L } from '../limits.js';
import { formOf, isRecord, questionFields } from './claude-forms.js';
import { saysSignedOut, type Turn } from './runtime.js';
import { outside } from './sandbox/places.js';
import {
  emptyUsage,
  errorText,
  type AgentAsk,
  type AgentSetting,
  type McpServerSpec,
  type RunResult,
  type TokenUsage,
} from './types.js';

/** Its tools that write a file, and those that start a helper (a subagent). */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);
const HELPER_TOOLS = new Set(['Task', 'Agent']);
/** Where a call's input names its file, and how a call reads by the first of the other keys its input has. */
const FILE_KEYS = ['file_path', 'notebook_path'];
const SUMMARIES: [string, (name: string, v: string) => string][] = [
  ['command', (n, v) => `${n}: ${v.slice(0, L.commandChars)}`],
  ['pattern', (n, v) => `${n} "${v.slice(0, L.searchChars)}"`],
  ['url', (n, v) => `${n} ${v}`],
  ['query', (n, v) => `${n} "${v.slice(0, L.searchChars)}"`],
];
/** Its account can't run: no run works until the person signs in again, or sees to the account. */
const SIGNED_OUT = new Set([
  'authentication_failed',
  'oauth_org_not_allowed',
  'account_on_hold',
  'verification_required',
  'billing_error',
  'cloud_credential_error',
]);
/** Why its turn ended without its reply, where it says so in a field: its result's kind, or its last message's error. */
const ENDED_AS: Partial<Record<SDKResultMessage['subtype'], RunResult['ended']>> = {
  error_max_turns: 'max-turns',
};
const ENDED_BY: Partial<Record<SDKAssistantMessageError, RunResult['ended']>> = { rate_limit: 'usage-limit' };
/** What it says when it isn't signed in itself. */
const SIGN_IN_RE = /api key|\/login|authenticat|oauth|not logged in|credit balance/i;
/** What the person may answer to a call it asks about: once, or not. "Always" would be written into the folder's settings. */
const OPTIONS: AgentAsk['options'] = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
];
/** What it is told of a call the person didn't allow. */
const DECLINED = 'The person declined this.';
const UNANSWERED = 'No one answered this.';

/** What is left once a terminal's escapes are gone: control characters but a line's end and a tab, and format ones. */
const UNSEEN = /[^\P{Cc}\n\t]|\p{Cf}/gu;

/** What an agent wrote for a person to read, as plain text, up to its length; nothing when it says nothing. */
function plainText(text: string | undefined, chars: number): string | undefined {
  const plain = stripVTControlCharacters(text ?? '')
    .replace(UNSEEN, '')
    .trim()
    .slice(0, chars);
  return plain || undefined;
}

const fileOf = (input: unknown) =>
  isRecord(input) ? FILE_KEYS.map((k) => input[k]).find((v): v is string => typeof v === 'string' && !!v) : undefined;

/** What a helper's call says it is for, cut to its length. */
function helperOf(input: Record<string, unknown>): string {
  // oxlint-disable-next-line typescript/no-base-to-string -- Claude Code gives these as text: String() only guards the rest
  return String(input.description ?? input.prompt ?? '')
    .trim()
    .slice(0, L.helperChars);
}

/** A tool call as the person reads it: by its file, else by the first of its other keys, else by its name. */
function summarize(name: string, input: unknown): string {
  const file = fileOf(input);
  if (file) return `${name} ${file}`;
  if (!isRecord(input)) return name;
  for (const [key, summary] of SUMMARIES) {
    const value = input[key];
    if (typeof value === 'string') return summary(name, value);
  }
  return name;
}

/**
 * The MCP server and tool a call is to, by the name it gives the call (`mcp__<server>__<tool>`), where the server is one
 * of the run's: none for a tool of its own. A server's name may hold `__` too, so the longest that fits is the one.
 */
function mcpOf(name: string, servers: McpServerSpec[]): { server: string; tool: string } | undefined {
  const fits = servers.map((s) => s.name).filter((server) => name.startsWith(`mcp__${server}__`));
  const server = fits.sort((a, b) => b.length - a.length)[0];
  if (server === undefined) return undefined;
  return { server, tool: name.slice(`mcp__${server}__`.length) };
}

/** Its usage; cache writes without their lifetime count as 5-minute ones, its default. */
function usageOf(u: SDKResultMessage['usage']): TokenUsage {
  const split = u.cache_creation;
  return {
    input: u.input_tokens,
    output: u.output_tokens,
    cacheRead: u.cache_read_input_tokens,
    cacheWrite5m: split ? split.ephemeral_5m_input_tokens : u.cache_creation_input_tokens,
    cacheWrite1h: split ? split.ephemeral_1h_input_tokens : 0,
  };
}

/** One run as Claude Code reports it: its reply, its tool calls, what it asks, its cost and model, what was refused. */
export class Report {
  /** Its calls, by their ids: each tool's name, and the file it writes, for one that writes. */
  private calls = new Map<string, { name: string; file: string | undefined }>();
  /** The message it is writing, by the id of the message it streams in. */
  private writing = '';
  private writingIn: string | null = null;
  private streamed = new Set<string>();
  private ended?: SDKResultMessage;
  private error?: string;
  /** The error its last message of its own carried, if any: one that ends its turn is the last it writes. */
  private lastError: SDKAssistantMessageError | undefined;
  private signedOut = false;
  private model?: string;
  /** Its models' names in its own words, by the model each is. */
  private names = new Map<string, string>();
  /** It runs on the person's subscription, whose plan pays: what it would cost is no one's to count. */
  private subscribed = false;
  /** Forms and pages waiting on the person, each of which it can take back. */
  private forms = new Map<string, AbortController>();
  private formCount = 0;
  private refused = new Set<string>();

  constructor(
    private t: Turn,
    /** The run's effort, when it is one Claude Code takes. */
    private effort?: EffortLevel,
  ) {}

  named(models: ModelInfo[], account: AccountInfo | undefined): void {
    for (const m of models) this.names.set(m.resolvedModel ?? m.value, m.displayName);
    this.subscribed = Boolean(account?.subscriptionType);
  }

  message(m: SDKMessage): void {
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') return this.started(m.session_id, m.model, m.permissionMode);
        if (m.subtype === 'elicitation_complete') this.forms.get(m.elicitation_id)?.abort();
        return;
      case 'stream_event':
        return this.streaming(m.event, m.parent_tool_use_id);
      case 'assistant':
        if (m.error && SIGNED_OUT.has(m.error)) this.signedOut = true;
        if (m.parent_tool_use_id === null) this.lastError = m.error;
        for (const block of m.message.content) {
          if (block.type === 'tool_use') this.tool(block.id, block.name, block.input, m.parent_tool_use_id);
          // A message of its own it didn't stream, whole.
          if (block.type === 'text' && m.parent_tool_use_id === null && !this.streamed.has(m.message.id)) {
            if (this.writingIn !== m.message.id) this.begin(m.message.id);
            this.add(block.text);
          }
        }
        return;
      case 'user':
        if (typeof m.message.content === 'string') return;
        for (const block of m.message.content)
          if (block.type === 'tool_result') this.finished(block.tool_use_id, block.is_error !== true);
        return;
      case 'result':
        this.ended = m;
        return;
    }
  }

  broke(err: unknown): void {
    this.error = errorText(err);
  }

  private started(sessionId: string, model: string, mode: string): void {
    this.model = model;
    this.t.progress({ type: 'session', sessionId });
    const { effort } = this;
    const settings: AgentSetting[] = [
      { id: 'model', name: 'Model', value: this.names.get(model) ?? model },
      { id: 'mode', name: 'Mode', value: mode },
      ...(effort ? [{ id: 'effort', name: 'Effort', value: effort }] : []),
    ];
    this.t.progress({ type: 'settings', settings });
  }

  /** Its reply as it streams it; a helper's own words aren't the run's. */
  private streaming(event: SDKPartialAssistantMessage['event'], parent: string | null): void {
    if (parent !== null) return;
    if (event.type === 'message_start') {
      this.streamed.add(event.message.id);
      this.begin(event.message.id);
    }
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') this.add(event.delta.text);
  }

  /** A new message of its own: what it writes starts again. */
  private begin(id: string): void {
    this.writingIn = id;
    this.writing = '';
  }

  /** More of the message it is writing. */
  private add(text: string): void {
    this.writing += text;
    this.t.progress({ type: 'text', text: this.writing });
  }

  /** A call once it is made, with what it is to do; a helper's with what it is for; an MCP tool's with its server. */
  private tool(id: string, name: string, input: unknown, parent: string | null): void {
    if (this.calls.has(id)) return;
    this.calls.set(id, { name, file: WRITE_TOOLS.has(name) ? fileOf(input) : undefined });
    const helper = HELPER_TOOLS.has(name) && isRecord(input) ? helperOf(input) : '';
    const mcp = mcpOf(name, this.t.spec.mcpServers);
    this.t.progress({
      type: 'tool',
      tool: name,
      summary: summarize(name, input),
      call: id,
      ...(parent ? { parent } : {}),
      ...(helper ? { helper } : {}),
      ...(mcp ? { mcp } : {}),
    });
  }

  /** A call's end: the file it wrote, or refused writing outside the folder; a helper done. */
  private finished(id: string, ok: boolean): void {
    const call = this.calls.get(id);
    if (!call) return;
    const { file } = call;
    if (file && ok) this.t.progress({ type: 'file', file });
    if (file && !ok && outside(file, this.t.spec.cwd)) this.refused.add(file);
    if (HELPER_TOOLS.has(call.name)) this.t.progress({ type: 'helper-done', call: id, ok });
  }

  /** What it asks before it acts, put to the person; nothing is answered in the person's place. */
  readonly permission: CanUseTool = async (tool, input, o): Promise<PermissionResult> => {
    if (tool === 'AskUserQuestion') return this.question(input, o.toolUseID, o.signal);
    const ask = this.t.ask;
    const reason = plainText(o.decisionReason, L.reasonChars);
    const asked: AgentAsk = {
      call: o.toolUseID,
      tool,
      title: o.title ?? summarize(tool, input),
      ...(reason ? { reason } : {}),
      input,
      options: OPTIONS,
    };
    const answer = ask ? await ask(asked, o.signal) : null;
    if (answer && 'option' in answer && answer.option === 'allow') return { behavior: 'allow', updatedInput: input };
    // A no to writing a file outside its folder is a write refused, which the host may offer the task that folder for.
    const file = WRITE_TOOLS.has(tool) ? fileOf(input) : undefined;
    if (file && outside(file, this.t.spec.cwd)) this.refused.add(file);
    return { behavior: 'deny', message: answer ? DECLINED : UNANSWERED };
  };

  /** Its questions to the person (AskUserQuestion) as a form, each answered with one of its choices, or several. */
  private async question(input: Record<string, unknown>, call: string, signal: AbortSignal): Promise<PermissionResult> {
    const fields = questionFields(input);
    const [first] = fields;
    const ask = this.t.ask;
    if (!ask || !first) return { behavior: 'deny', message: UNANSWERED };
    const form = { message: fields.map((f) => f.name).join('\n'), fields };
    const answer = await ask({ call, tool: 'AskUserQuestion', title: first.name, input, options: [], form }, signal);
    if (!answer || !('accept' in answer) || !answer.accept)
      return { behavior: 'deny', message: answer ? DECLINED : UNANSWERED };
    // oxlint-disable-next-line typescript/no-base-to-string -- MCP's answers are strings, numbers, booleans or lists: never another object
    const said = (v: unknown) => (Array.isArray(v) ? v.map(String).join(', ') : String(v ?? ''));
    const answers = Object.fromEntries(fields.map((f) => [f.name, said(answer.content?.[f.name])]));
    return { behavior: 'allow', updatedInput: { ...input, answers } };
  }

  /** A form or page one of its MCP servers asks the person for, which it can take back when done elsewhere. */
  readonly elicit: OnElicitation = async (req, o): Promise<ElicitationResult> => {
    const form = formOf(req);
    const ask = this.t.ask;
    if (!ask || !form) return { action: 'cancel' };
    const id = req.elicitationId ?? `form-${++this.formCount}`;
    const gone = new AbortController();
    this.forms.set(id, gone);
    const both = AbortSignal.any([o.signal, gone.signal]);
    try {
      const answer = await ask({ call: id, tool: '', title: form.message, options: [], form }, both);
      if (!answer || !('accept' in answer) || both.aborted) return { action: 'cancel' };
      if (!answer.accept) return { action: 'decline' };
      return form.url
        ? { action: 'accept' }
        : { action: 'accept', content: (answer.content ?? {}) as ElicitationResult['content'] };
    } finally {
      this.forms.delete(id);
    }
  };

  /** How the run ended: its reply, or why it didn't end as the agent meant; what it spent either way. */
  ending(signedOut: string): RunResult {
    const { spec } = this.t;
    const r = this.ended;
    const permissionDenials = (r?.permission_denials ?? []).map((d) => {
      const file = WRITE_TOOLS.has(d.tool_name) ? fileOf(d.tool_input) : undefined;
      if (file && outside(file, spec.cwd)) this.refused.add(file);
      return summarize(d.tool_name, d.tool_input);
    });
    const usage = r ? usageOf(r.usage) : emptyUsage();
    // Its total is the session's, from its first turn on, and an estimate: the run's own only for a new session, and
    // nothing at all on a subscription.
    const counted = r && !spec.resume && !this.subscribed;
    const result = {
      text: r?.subtype === 'success' ? r.result : this.writing,
      usage,
      costUsd: counted ? r.total_cost_usd : null,
      ...(this.model ? { model: this.model } : {}),
      permissionDenials,
      refusedWrites: [...this.refused],
    };
    const ended = (r && ENDED_AS[r.subtype]) ?? (this.lastError && ENDED_BY[this.lastError]);
    const failed = (error: string, runtimeDown = false) => ({
      ...result,
      ok: false,
      error: error.slice(0, L.errorChars),
      runtimeDown,
      ...(ended ? { ended } : {}),
    });
    // Only a sign-in problem before this turn used anything takes the whole runtime offline.
    const spent = usage.input + usage.output + usage.cacheRead + usage.cacheWrite5m + usage.cacheWrite1h > 0;
    if (this.signedOut && !spent) return failed(signedOut, true);
    if (!r) {
      const said = [this.t.stderr().trim(), this.error ?? ''].filter(Boolean).join('\n');
      if (spec.resume && /no conversation found/i.test(said))
        return { ...failed(`Session ${spec.sessionId} could not be resumed: not found`), ended: 'session-not-found' };
      if (saysSignedOut(said, SIGN_IN_RE)) return failed(signedOut, true);
      return { ...failed(''), error: (said || 'Claude Code ended before its turn did').slice(-L.errorChars) };
    }
    if (r.subtype !== 'success') return failed(r.errors.join('\n') || r.subtype);
    if (r.is_error)
      return saysSignedOut(r.result, SIGN_IN_RE) && !spent
        ? failed(signedOut, true)
        : failed(r.result || 'Claude Code ended its turn with an error');
    if (r.stop_reason === 'refusal') return failed('The model declined the request');
    return { ...result, ok: true };
  }
}
