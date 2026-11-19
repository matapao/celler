import { z } from "zod"
import type { Tool } from "@modelcontextprotocol/sdk/types.js"
import type { Graph } from "./catalog.js"
import { fail, parseWith } from "./errors.js"

const MAX_QUERY_CHARS = 256
const MAX_TERMS = 16
const PAGE_SIZE = 5

// The gateway tools are the model's interface, so every field says what it is for.
const nodeId = z.string().min(1).max(128)
const request = z.strictObject({
  query: z.string().max(MAX_QUERY_CHARS).default("")
    .describe("Words to look for in names, descriptions and fields. Leave it out to browse."),
  within: nodeId.optional().describe("A unit id from an earlier result, to browse or search inside that unit."),
  offset: z.number().int().nonnegative().max(10_000).default(0).describe("The `next` value of the previous page."),
  refs: z.array(nodeId).min(1).max(20).optional()
    .describe("Tool ids to get complete definitions for, with their input and output schemas."),
})
// The same shape as an MCP tools/call request.
export const invocation = z.strictObject({
  name: nodeId.describe("The id of a tool found with discover."),
  arguments: z.record(z.string(), z.unknown()).default({}).describe("Arguments that match the tool's input schema."),
})

function gatewayTool(name: string, description: string, schema: z.ZodObject, extra: Partial<Tool>): Tool {
  return { name, description, inputSchema: z.toJSONSchema(schema, { io: "input" }) as Tool["inputSchema"], ...extra }
}

export const discoverTool = gatewayTool("discover",
  "Find the tools you can use. Search with query, look inside a unit with within, page with offset, " +
  "and get complete definitions with refs.",
  request, { annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } })
export const invokeTool = gatewayTool("invoke",
  "Call a tool found with discover, with arguments that match its input schema.",
  invocation, { execution: { taskSupport: "optional" } })

/** Returns JSON text for the MCP discover tool, fitting complete definitions within `budget` when possible. */
export function discover(graph: Graph, entry: string, allow: (id: string) => boolean, raw: unknown, budget: number): string {
  const { within = entry, refs, query, offset } = parseWith(request, "discover arguments", raw)
  const reachable = graph.view(entry, allow)
  if (!reachable.has(within)) fail("DENIED", "Unit outside this run")
  const scope = within === entry ? reachable : graph.view(within, allow)

  function definition(id: string): Tool {
    if (!scope.has(id)) fail("DENIED", "Tool outside this unit: " + id)
    const meta = graph.meta(id)
    if (meta.kind !== "tool") fail("INVALID_ARGS", "Expected a tool: " + id)
    return meta.exposed
  }
  if (refs) return JSON.stringify([...new Set(refs)].map(definition))

  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, MAX_TERMS)
  const ids = terms.length ? scope.keys() : graph.unit(within).exports
  const hits = []

  for (const id of ids) {
    if (id === within || !scope.has(id)) continue
    const meta = graph.meta(id)
    const parents = [...scope.get(id)!].map(parent => ({ id: parent, title: graph.unit(parent).title }))
    let score = 0
    if (terms.length) {
      const parentText = parents.map(parent => parent.title).join(" ").toLowerCase()
      const fieldText = meta.kind === "tool" ? meta.searchFields : ""
      for (const term of terms) {
        if (meta.searchNames.includes(term) || parentText.includes(term)) score += 2
        else if (fieldText.includes(term)) score += 1
      }
      if (!score) continue
    }
    const card = { id, kind: meta.kind, title: meta.title, description: meta.description, parents }
    hits.push({ score, card, meta })
  }

  hits.sort((a, b) => b.score - a.score)
  const page = hits.slice(offset, offset + PAGE_SIZE)
  const next = offset + page.length < hits.length ? offset + page.length : null

  const fullText = JSON.stringify({
    items: page.map(({ card, meta }) => meta.kind === "tool" ? { ...card, definition: meta.exposed } : card),
    next,
  })
  if (Buffer.byteLength(fullText) <= budget) return fullText

  return JSON.stringify({
    items: page.map(({ card, meta }) => meta.kind === "tool" ? {
      ...card,
      ...(meta.annotations ? { annotations: meta.annotations } : {}),
      inputs: meta.inputFields,
      outputs: meta.outputFields,
    } : card),
    next,
  })
}
