// What Claude Code puts to the person to fill in, as the card shows it: a form or page one of its MCP servers asks for,
// and its own questions (AskUserQuestion).

import type { ElicitationRequest } from '@anthropic-ai/claude-agent-sdk';
import type { AgentAsk, AgentFormField } from './types.js';

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The kinds of field a form asks for, and a schema's `type` when it is one of them. */
const FIELD_TYPES: AgentFormField['type'][] = ['string', 'number', 'integer', 'boolean', 'array'];
const fieldType = (v: unknown) => FIELD_TYPES.find((type) => type === v);
const asText = (v: unknown) => (typeof v === 'string' ? v : undefined);

type Choice = { value: string; label: string };

/** A field's choices given as values (`enum`), each with its name beside it (`enumNames`) where it has one. */
function listedChoices(values: unknown, names?: unknown): Choice[] {
  if (!Array.isArray(values)) return [];
  const choices: Choice[] = [];
  values.forEach((value: unknown, i) => {
    if (typeof value !== 'string') return;
    const name = Array.isArray(names) ? asText(names[i]) : undefined;
    choices.push({ value, label: name ?? value });
  });
  return choices;
}

/** A field's choices given as schemas (`oneOf`, `anyOf`), each a constant with its title. */
function labelledChoices(options: unknown): Choice[] {
  if (!Array.isArray(options)) return [];
  const list: unknown[] = options;
  const choices: Choice[] = [];
  for (const option of list) {
    if (isRecord(option) && typeof option.const === 'string')
      choices.push({ value: option.const, label: asText(option.title) ?? option.const });
  }
  return choices;
}

/** A form or page as the card shows it: its fields from the MCP server's schema, or its address. */
export function formOf(req: ElicitationRequest): AgentAsk['form'] | null {
  if (req.mode === 'url') {
    if (typeof req.url !== 'string' || !/^https?:\/\//i.test(req.url)) return null;
    return { message: req.message, url: req.url };
  }
  const schema = req.requestedSchema;
  const properties: unknown = schema?.properties;
  const required = new Set<unknown>(Array.isArray(schema?.required) ? schema.required : []);
  const fields: AgentFormField[] = [];
  for (const [name, property] of Object.entries(
    typeof properties === 'object' && properties !== null ? properties : {},
  )) {
    if (!isRecord(property)) continue;
    const type = fieldType(property.type);
    if (!type) continue;
    const items: Record<string, unknown> = isRecord(property.items) ? property.items : {};
    const listed = type === 'array' ? listedChoices(items.enum) : listedChoices(property.enum, property.enumNames);
    const labelled = type === 'array' ? labelledChoices(items.anyOf) : labelledChoices(property.oneOf);
    const choices = [...listed, ...labelled];
    const description = asText(property.description);
    fields.push({
      name,
      title: asText(property.title) ?? name,
      ...(description ? { description } : {}),
      type,
      required: required.has(name),
      ...(choices.length ? { choices } : {}),
    });
  }
  return { message: req.message, fields };
}

/** Its questions to the person (AskUserQuestion's input) as a form's fields, each by its question, with its choices. */
export function questionFields(input: unknown): AgentFormField[] {
  const questions = isRecord(input) && Array.isArray(input.questions) ? input.questions : [];
  return questions.flatMap((q): AgentFormField[] => {
    if (!isRecord(q) || typeof q.question !== 'string' || !Array.isArray(q.options)) return [];
    const choices = q.options.flatMap((o) =>
      isRecord(o) && typeof o.label === 'string' ? [{ value: o.label, label: o.label }] : [],
    );
    const title = typeof q.header === 'string' && q.header ? q.header : q.question;
    return [{ name: q.question, title, type: q.multiSelect === true ? 'array' : 'string', required: true, choices }];
  });
}
