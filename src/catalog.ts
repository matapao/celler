import { ContentBlockSchema, ToolSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { Ajv, type ValidateFunction } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
import { z } from 'zod';
import { fail } from './errors.js';
import { canonicalJson, normalizeJson, type JsonValue } from './json.js';

const id = z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/);
const cellSchema = z.strictObject({
  kind: z.literal('cell'),
  id,
  title: z.string(),
  description: z.string().default(''),
  // A cell without a profile only groups nodes: it can be exported and browsed, never launched.
  profile: id.optional(),
  context: z.array(z.union([z.string(), ContentBlockSchema])).default([]),
  exports: z.array(id),
  pins: z.array(id).default([]),
});
const bindingSchema = z.strictObject({
  kind: z.literal('tool'),
  id,
  // The exposed tool name is always the node id, so `name` is optional here and only searched.
  definition: ToolSchema.extend({ name: z.string().optional() }).passthrough(),
  target: z.union([z.strictObject({ cell: id }), z.strictObject({ adapter: id })]),
});
const graphSchema = z.array(z.discriminatedUnion('kind', [cellSchema, bindingSchema]));

export type NodeConfig = z.input<typeof graphSchema>[number];
export type Cell = z.output<typeof cellSchema>;
type RunnableCell = Cell & { profile: string };
export type Binding = z.output<typeof bindingSchema>;
export type FieldSummary = { name: string; type: string; required: boolean };
type NodeMeta =
  | { kind: 'cell'; id: string; title: string; description: string; searchNames: string }
  | {
      kind: 'tool';
      id: string;
      title: string;
      description: string;
      exposed: Tool;
      exposedBytes: number;
      annotations: Tool['annotations'];
      inputFields: FieldSummary[];
      outputFields: FieldSummary[] | null;
      searchNames: string;
      searchFields: string;
    };

function schemaType(value: unknown): string {
  if (!value || typeof value !== 'object') return 'unknown';
  const field = value as Record<string, unknown>;
  if (typeof field.type === 'string') return field.type;
  if (Array.isArray(field.type)) return field.type.filter((item) => typeof item === 'string').join('|') || 'unknown';
  if (Array.isArray(field.anyOf)) return field.anyOf.map(schemaType).join('|') || 'unknown';
  if (Array.isArray(field.oneOf)) return field.oneOf.map(schemaType).join('|') || 'unknown';
  if (Array.isArray(field.enum)) return 'enum';
  if ('const' in field) return 'const';
  if (typeof field.$ref === 'string') return 'ref';
  return 'unknown';
}

function summarizeFields(schema: Tool['inputSchema']): FieldSummary[] {
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).map(([name, value]) => ({
    name,
    type: schemaType(value),
    required: required.has(name),
  }));
}

function searchableFields(schema: Tool['inputSchema']): string {
  return Object.entries(schema.properties ?? {})
    .map(([name, field]) => {
      const desc =
        field && typeof field === 'object' && 'description' in field && typeof field.description === 'string'
          ? field.description
          : '';
      return desc ? `${name} ${desc}` : name;
    })
    .join(' ');
}

// Every call can run as an MCP task, so tools default to `taskSupport: "optional"`.
function exposedTool(binding: Binding): Tool {
  return {
    ...binding.definition,
    name: binding.id,
    execution: { taskSupport: 'optional', ...binding.definition.execution },
  };
}

// MCP's default JSON Schema dialect is 2020-12; many servers still declare draft-07.
function createDialects(urlChars: number) {
  const options = { strict: false, addUsedSchema: false };
  const dialects = { draft07: new Ajv(options), latest: new Ajv2020(options) };
  for (const ajv of [dialects.draft07, dialects.latest]) {
    // Fast formats avoid backtracking regexes on untrusted arguments. The `url` regex is quadratic even in fast mode.
    formats.default(ajv, { mode: 'fast' });
    ajv.addFormat(
      'url',
      (value: string) => value.length <= urlChars && /^(?:https?|ftp):\/\//i.test(value) && URL.canParse(value),
    );
  }
  return dialects;
}

/** An app's JSON Schema validators, shared by schema text, so publishing the same tools again compiles nothing new. */
export function createSchemas(limits: { schemaCacheSize: number; urlChars: number; argsErrorChars: number }) {
  let dialects = createDialects(limits.urlChars);
  let compiled = new Map<string, ValidateFunction>();

  function validator(schema: Tool['inputSchema'], nodeId: string): ValidateFunction {
    const text = canonicalJson(schema);
    const known = compiled.get(text);
    if (known) return known;
    if (compiled.size >= limits.schemaCacheSize) {
      // Bounds memory when schemas never repeat: Ajv keeps what it compiled, so it starts afresh too.
      dialects = createDialects(limits.urlChars);
      compiled = new Map();
    }
    // `$schema` picks the dialect. Compiling without it accepts every spelling of the dialect's id.
    const ajv = String(schema.$schema).includes('draft-07') ? dialects.draft07 : dialects.latest;
    const { $schema: _dialect, ...body } = schema;
    let check: ValidateFunction;
    try {
      check = ajv.compile(body);
    } catch (error) {
      fail(
        'INVALID_CONFIG',
        `Invalid JSON Schema in ${nodeId}: ` + (error instanceof Error ? error.message : String(error)),
        nodeId,
      );
    }
    if ('$async' in check) fail('INVALID_CONFIG', 'Expected a synchronous JSON Schema', nodeId);
    compiled.set(text, check);
    return check;
  }

  // Ajv's messages name the field and the rule, never the value, so the model can fix its call.
  function errors(check: ValidateFunction): string {
    return dialects.latest.errorsText(check.errors, { dataVar: 'arguments' }).slice(0, limits.argsErrorChars);
  }

  return { validator, errors };
}
export type Schemas = ReturnType<typeof createSchemas>;

/**
 * A cycle among the nodes a topological sort left over, in the order its links go, its first node again at its end.
 * Each of them has a link from another of them, so walking back from one comes round to a node it has passed: from
 * there on, the walk is the cycle.
 */
function cycleAmong(left: ReadonlySet<string>, edges: ReadonlyMap<string, string[]>): string[] {
  const linkedFrom = new Map<string, string>();
  for (const [from, links] of edges) {
    if (!left.has(from)) continue;
    for (const link of links) if (left.has(link) && !linkedFrom.has(link)) linkedFrom.set(link, from);
  }
  const walked: string[] = [];
  let node = [...left][0];
  while (!walked.includes(node)) {
    walked.push(node);
    node = linkedFrom.get(node)!;
  }
  const cycle = walked.slice(walked.indexOf(node)).reverse();
  // From its node declared first.
  const start = cycle.indexOf([...left].find((id) => cycle.includes(id))!);
  const declared = [...cycle.slice(start), ...cycle.slice(0, start)];
  return [...declared, declared[0]];
}

/**
 * Compiles a graph with an app's validators. Publishing also checks it against the host's adapters and the rules a
 * stored revision may predate, so a stored revision always loads, and retiring an adapter fails only its own calls.
 */
export function compileGraph(config: unknown, schemas: Schemas, publishing?: { adapters: ReadonlySet<string> }) {
  const snapshot: JsonValue = normalizeJson(config);
  const parsed = graphSchema.safeParse(snapshot);
  if (!parsed.success) fail('INVALID_CONFIG', 'Invalid graph: ' + z.prettifyError(parsed.error));
  const rows = parsed.data;
  const nodes = new Map(rows.map((node) => [node.id, node]));
  if (nodes.size !== rows.length) fail('INVALID_CONFIG', 'Duplicate node ID');
  for (const reserved of ['discover', 'invoke']) {
    if (nodes.has(reserved)) fail('INVALID_CONFIG', 'Reserved node ID: ' + reserved, reserved);
  }

  function get(nodeId: string) {
    const node = nodes.get(nodeId);
    if (!node) fail('INVALID_CONFIG', 'Unknown node: ' + nodeId, nodeId);
    return node;
  }
  function cell(nodeId: string): Cell {
    const node = get(nodeId);
    if (node.kind !== 'cell') fail('INVALID_CONFIG', 'Expected a cell: ' + nodeId, nodeId);
    return node;
  }
  function runnableCell(nodeId: string): RunnableCell {
    const node = cell(nodeId);
    if (!node.profile) fail('INVALID_CONFIG', 'Cell has no launch profile: ' + nodeId, nodeId);
    return node as RunnableCell;
  }

  const inputs = new Map<string, ValidateFunction>();
  const outputs = new Map<string, ValidateFunction>();
  const metadata = new Map<string, NodeMeta>();
  const edges = new Map<string, string[]>();
  const exporters = new Map<string, string[]>(); // node id → the cells that export it
  const incoming = new Map(rows.map((node) => [node.id, 0]));

  for (const node of rows) {
    let links: string[] = [];
    if (node.kind === 'cell') {
      links = node.exports;
      if (new Set(links).size !== links.length) fail('INVALID_CONFIG', 'Duplicate export in ' + node.id, node.id);
      if (new Set(node.pins).size !== node.pins.length) fail('INVALID_CONFIG', 'Duplicate pin in ' + node.id, node.id);
      for (const link of links) {
        const parents = exporters.get(link);
        if (parents) parents.push(node.id);
        else exporters.set(link, [node.id]);
      }
      metadata.set(node.id, {
        kind: 'cell',
        id: node.id,
        title: node.title,
        description: node.description,
        searchNames: [node.id, node.title, node.description].join(' ').toLowerCase(),
      });
    } else {
      inputs.set(node.id, schemas.validator(node.definition.inputSchema, node.id));
      if (node.definition.outputSchema) outputs.set(node.id, schemas.validator(node.definition.outputSchema, node.id));
      if ('cell' in node.target) {
        links = [runnableCell(node.target.cell).id];
        // A delegated run answers in text, so no structured output could ever pass the schema.
        if (publishing && node.definition.outputSchema) {
          fail(
            'INVALID_CONFIG',
            'A tool bound to a cell has no outputSchema, as a delegated run answers in text: ' + node.id,
            node.id,
          );
        }
      } else if (publishing && !publishing.adapters.has(node.target.adapter)) {
        fail('INVALID_CONFIG', 'Unknown adapter: ' + node.target.adapter, node.id);
      }
      const exposed = Object.freeze(exposedTool(node));
      const title = node.definition.title ?? node.definition.name ?? node.id;
      const description = node.definition.description ?? '';
      metadata.set(node.id, {
        kind: 'tool',
        id: node.id,
        title,
        description,
        exposed,
        exposedBytes: Buffer.byteLength(JSON.stringify(exposed)),
        annotations: node.definition.annotations,
        inputFields: summarizeFields(exposed.inputSchema),
        outputFields: exposed.outputSchema ? summarizeFields(exposed.outputSchema) : null,
        searchNames: [node.id, title, node.definition.name ?? '', description].join(' ').toLowerCase(),
        searchFields: [
          searchableFields(exposed.inputSchema),
          exposed.outputSchema ? searchableFields(exposed.outputSchema) : '',
        ]
          .join(' ')
          .toLowerCase(),
      });
    }
    edges.set(node.id, links);
    for (const link of links) {
      get(link);
      incoming.set(link, incoming.get(link)! + 1);
    }
  }

  // Kahn's topological sort rejects cycles across both exports and delegations.
  const ready = rows.filter((node) => incoming.get(node.id) === 0).map((node) => node.id);
  let visited = 0;
  for (let i = 0; i < ready.length; i++) {
    visited++;
    for (const link of edges.get(ready[i])!) {
      const left = incoming.get(link)! - 1;
      incoming.set(link, left);
      if (left === 0) ready.push(link);
    }
  }
  if (visited !== rows.length) {
    const loop = cycleAmong(new Set(rows.map((node) => node.id).filter((id) => incoming.get(id)! > 0)), edges);
    fail('INVALID_CONFIG', 'Cycle through exports or delegation: ' + loop.join(' → '));
  }

  // Everything an entry can browse, each node with the cells that export it. BFS keeps declared export order
  // and asks `allowed` at most once per node.
  function view(entry: string, allowed: (id: string) => boolean) {
    cell(entry);
    if (!allowed(entry)) fail('DENIED', 'Cell denied: ' + entry);
    const parents = new Map<string, Set<string>>([[entry, new Set()]]);
    const denied = new Set<string>();
    const todo = [entry];
    for (let i = 0; i < todo.length; i++) {
      const parent = todo[i];
      for (const childId of cell(parent).exports) {
        const seen = parents.get(childId);
        if (seen) {
          seen.add(parent);
          continue;
        }
        if (denied.has(childId)) continue;
        if (!allowed(childId)) {
          denied.add(childId);
          continue;
        }
        parents.set(childId, new Set([parent]));
        // Only exports are browsable. Entering a delegated cell requires a tool call.
        if (get(childId).kind === 'cell') todo.push(childId);
      }
    }
    return parents;
  }

  // Whether allowed exports lead from entry to id. It walks up from id, so `allowed` is asked only about that chain,
  // not about the whole graph as `view` does.
  function reaches(entry: string, nodeId: string, allowed: (id: string) => boolean, seen = new Set<string>()): boolean {
    if (seen.has(nodeId)) return false;
    // Seen before it is asked about, so a node denied on one way up is not asked again on the next.
    seen.add(nodeId);
    if (!allowed(nodeId)) return false;
    return nodeId === entry || (exporters.get(nodeId) ?? []).some((parent) => reaches(entry, parent, allowed, seen));
  }

  const staticViews = new Map<string, ReadonlySet<string>>();
  function staticReachable(entry: string): ReadonlySet<string> {
    let cached = staticViews.get(entry);
    if (!cached) {
      cached = new Set(view(entry, () => true).keys());
      staticViews.set(entry, cached);
    }
    return cached;
  }

  for (const node of rows) {
    if (node.kind !== 'cell' || !node.pins.length) continue;
    const reachable = staticReachable(node.id);
    for (const pin of node.pins) {
      if (!reachable.has(pin) || get(pin).kind !== 'tool') fail('INVALID_CONFIG', 'Invalid pin: ' + pin, pin);
    }
  }

  function meta(nodeId: string): NodeMeta {
    const item = metadata.get(nodeId);
    if (!item) fail('INVALID_CONFIG', 'Unknown node: ' + nodeId);
    return item;
  }
  function validateInput(nodeId: string, args: unknown) {
    const check = inputs.get(nodeId);
    if (check?.(args)) return;
    const detail = check ? ': ' + schemas.errors(check) : '';
    fail('INVALID_ARGS', `Invalid arguments for ${nodeId}${detail}`);
  }
  function validateOutput(nodeId: string, value: unknown) {
    const check = outputs.get(nodeId);
    if (check && !check(value)) fail('INVALID_OUTPUT', 'Invalid structured output for ' + nodeId);
  }

  return { snapshot, get, cell, runnableCell, meta, view, reaches, staticReachable, validateInput, validateOutput };
}

export type Graph = ReturnType<typeof compileGraph>;
