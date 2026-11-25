import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Graph } from './catalog.js';
import { fail, parseWith } from './errors.js';

type DiscoveryLimits = {
  discoveryBytes: number;
  discoveryQueryChars: number;
  discoveryTerms: number;
  discoveryRefs: number;
  discoveryPageSize: number;
  discoveryOffset: number;
};

// The model reads these schemas, so every field says what it is for.
const nodeId = z.string().min(1).max(128);
// The same shape as an MCP tools/call request.
export const invocation = z.strictObject({
  name: nodeId.describe('The id of a tool found with discover.'),
  arguments: z.record(z.string(), z.unknown()).default({}).describe("Arguments that match the tool's input schema."),
});

function gatewayTool(name: string, description: string, schema: z.ZodObject, extra: Partial<Tool>): Tool {
  return { name, description, inputSchema: z.toJSONSchema(schema, { io: 'input' }) as Tool['inputSchema'], ...extra };
}

export const invokeTool = gatewayTool(
  'invoke',
  'Call a tool found with discover, with arguments that match its input schema.',
  invocation,
  { execution: { taskSupport: 'optional' } },
);

/** The discover tool an app's limits shape, and its JSON reply: complete definitions if they fit, else compact cards. */
/** A title and its description on one line, as an outline holds them. */
const titled = (title: string, description: string) => {
  const said = description.replace(/\s+/g, ' ').trim();
  return said ? `${title}: ${said}` : title;
};

/**
 * What a run's MCP server holds, as MCP's `instructions` give it to an agent before any tool: the run's cell on the first
 * line, which is all of it some agents show (Codex), then what it exports as an outline, each cell by its title and
 * description and each tool by its name and title, a cell's own nested under it, once. All in the host's own words, cut
 * at a whole line within `maxChars`.
 */
export function instructionsFor(graph: Graph, entry: string, allowed: (id: string) => boolean, maxChars: number) {
  const reach = graph.view(entry, allowed);
  const told = new Set<string>([entry]);
  const root = graph.meta(entry);
  const lines = [titled(root.title, root.description)];
  function tell(cellId: string, depth: number) {
    for (const child of graph.cell(cellId).exports) {
      if (!reach.has(child) || told.has(child)) continue;
      const node = graph.meta(child);
      const item = '  '.repeat(depth) + '- ';
      if (node.kind === 'tool') {
        lines.push(item + (node.title === child ? child : `${child}: ${node.title}`));
        continue;
      }
      told.add(child);
      lines.push(item + titled(node.title, node.description));
      tell(child, depth + 1);
    }
  }
  tell(entry, 0);
  let text = '';
  for (const line of lines) {
    if (text.length + line.length + 1 > maxChars) break;
    text += line + '\n';
  }
  return text.trimEnd();
}

export function createDiscovery(limits: DiscoveryLimits) {
  const request = z.strictObject({
    query: z
      .string()
      .max(limits.discoveryQueryChars)
      .default('')
      .describe('Words to look for in names, descriptions and fields. Leave it out to browse.'),
    within: nodeId.optional().describe('A cell id from an earlier result, to browse or search inside that cell.'),
    offset: z
      .number()
      .int()
      .nonnegative()
      .max(limits.discoveryOffset)
      .default(0)
      .describe('The `next` value of the previous page.'),
    refs: z
      .array(nodeId)
      .min(1)
      .max(limits.discoveryRefs)
      .optional()
      .describe('Tool ids to get complete definitions for, with their input and output schemas.'),
  });
  const tool = gatewayTool(
    'discover',
    'Find the tools you can use. Search with query, look inside a cell with within, page with offset, ' +
      'and get complete definitions with refs.',
    request,
    { annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } },
  );

  function discover(graph: Graph, entry: string, allow: (id: string) => boolean, raw: unknown): string {
    const { within = entry, refs, query, offset } = parseWith(request, 'discover arguments', raw);
    const reachable = graph.view(entry, allow);
    if (!reachable.has(within)) fail('DENIED', 'Cell outside this run');
    if (graph.get(within).kind !== 'cell') fail('INVALID_ARGS', 'Expected a cell in within: ' + within);
    const scope = within === entry ? reachable : graph.view(within, allow);

    function definition(id: string): Tool {
      if (!scope.has(id)) fail('DENIED', 'Tool outside this cell: ' + id);
      const meta = graph.meta(id);
      if (meta.kind !== 'tool') fail('INVALID_ARGS', 'Expected a tool: ' + id);
      return meta.exposed;
    }
    if (refs) return JSON.stringify([...new Set(refs)].map(definition));

    const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, limits.discoveryTerms);
    const ids = terms.length ? scope.keys() : graph.cell(within).exports;
    const hits = [];

    for (const id of ids) {
      if (id === within || !scope.has(id)) continue;
      const meta = graph.meta(id);
      const parents = [...scope.get(id)!].map((parent) => ({ id: parent, title: graph.cell(parent).title }));
      let score = 0;
      if (terms.length) {
        const parentText = parents
          .map((parent) => parent.title)
          .join(' ')
          .toLowerCase();
        const fieldText = meta.kind === 'tool' ? meta.searchFields : '';
        for (const term of terms) {
          if (meta.searchNames.includes(term) || parentText.includes(term)) score += 2;
          else if (fieldText.includes(term)) score += 1;
        }
        if (!score) continue;
      }
      const card = { id, kind: meta.kind, title: meta.title, description: meta.description, parents };
      hits.push({ score, card, meta });
    }

    hits.sort((a, b) => b.score - a.score); // stable: equal scores keep BFS order
    const page = hits.slice(offset, offset + limits.discoveryPageSize);
    const next = offset + page.length < hits.length ? offset + page.length : null;

    const fullText = JSON.stringify({
      items: page.map(({ card, meta }) => (meta.kind === 'tool' ? { ...card, definition: meta.exposed } : card)),
      next,
    });
    if (Buffer.byteLength(fullText) <= limits.discoveryBytes) return fullText;

    return JSON.stringify({
      items: page.map(({ card, meta }) =>
        meta.kind === 'tool'
          ? {
              ...card,
              ...(meta.annotations ? { annotations: meta.annotations } : {}),
              inputs: meta.inputFields,
              outputs: meta.outputFields,
            }
          : card,
      ),
      next,
    });
  }

  return { tool, discover };
}
