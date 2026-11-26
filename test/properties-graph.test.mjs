// Properties of compiling a graph, as `publish` does, over graphs fast-check makes: every graph whose links lead
// nowhere twice publishes, and one with a cycle is refused by a cycle it really has, named from its node declared first.
import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { createApp, CellerError } from 'celler';
import { cell, memoryDatabase, text, tool } from './support.mjs';

const RESERVED = new Set(['discover', 'invoke']);
const nodeId = fc.stringMatching(/^[A-Za-z0-9_.-]{1,12}$/).filter((id) => !RESERVED.has(id));

/**
 * A graph of cells and tools in the order it is declared, each node's links as indexes into it: a cell's exports, any
 * node; a tool's delegation, a cell, or none for an adapter's tool. `acyclic` links only to nodes later in a hidden
 * order, so no link leads back.
 */
function graphs({ acyclic }) {
  return fc
    .uniqueArray(nodeId, { minLength: 1, maxLength: 8 })
    .chain((ids) =>
      fc.record({
        ids: fc.constant(ids),
        kinds: fc.array(fc.constantFrom('cell', 'tool'), { minLength: ids.length, maxLength: ids.length }),
        links: fc.array(fc.uniqueArray(fc.nat({ max: ids.length - 1 }), { maxLength: 3 }), {
          minLength: ids.length,
          maxLength: ids.length,
        }),
        order: fc.shuffledSubarray([...ids.keys()], { minLength: ids.length, maxLength: ids.length }),
      }),
    )
    .map(({ ids, kinds, links, order }) => {
      const rank = new Map(order.map((index, position) => [index, position]));
      const later = (from, to) => !acyclic || rank.get(to) > rank.get(from);
      return ids.map((id, i) => {
        const targets = links[i].filter((to) => later(i, to));
        if (kinds[i] === 'cell')
          return cell(
            id,
            targets.map((to) => ids[to]),
          );
        const delegate = targets.find((to) => kinds[to] === 'cell');
        return tool(id, delegate === undefined ? { adapter: 'ok' } : { cell: ids[delegate] });
      });
    });
}

/** Each node's links by id: a cell's exports, a tool's delegated cell. */
function linksOf(nodes) {
  const delegated = (target) => (target.cell === undefined ? [] : [target.cell]);
  return new Map(nodes.map((node) => [node.id, node.kind === 'cell' ? node.exports : delegated(node.target)]));
}

/** Whether links lead from a node back to itself, found apart from celler's own sort. */
function hasCycle(links) {
  const state = new Map();
  const visit = (id) => {
    if (state.get(id) === 'done') return false;
    if (state.get(id) === 'walking') return true;
    state.set(id, 'walking');
    const found = links.get(id).some(visit);
    state.set(id, 'done');
    return found;
  };
  return [...links.keys()].some(visit);
}

function publisher(t) {
  return createApp({
    database: memoryDatabase(t),
    adapters: new Map([['ok', { call: async () => text('ok') }]]),
    platform: {},
  });
}

test('a graph whose links never lead back publishes, whatever order it is declared in', (t) => {
  const app = publisher(t);
  fc.assert(
    fc.property(graphs({ acyclic: true }), (nodes) => {
      assert.equal(typeof app.publish(nodes), 'string');
    }),
  );
});

test("a graph with a cycle is refused with one it has, named from that cycle's node declared first and back to it", (t) => {
  const app = publisher(t);
  fc.assert(
    fc.property(graphs({ acyclic: false }), (nodes) => {
      const links = linksOf(nodes);
      if (!hasCycle(links)) {
        assert.equal(typeof app.publish(nodes), 'string');
        return;
      }
      assert.throws(
        () => app.publish(nodes),
        (error) => {
          assert.ok(error instanceof CellerError);
          // About the whole graph: no one node.
          assert.deepEqual([error.code, error.node], ['INVALID_CONFIG', undefined]);
          const prefix = 'Cycle through exports or delegation: ';
          assert.ok(error.message.startsWith(prefix), error.message);
          const cycle = error.message.slice(prefix.length).split(' → ');
          const [first] = cycle;
          // From a node back to it, through links the graph has, each node of it once.
          assert.equal(cycle.at(-1), first);
          for (let i = 0; i + 1 < cycle.length; i++)
            assert.ok(links.get(cycle[i]).includes(cycle[i + 1]), error.message);
          assert.equal(new Set(cycle.slice(0, -1)).size, cycle.length - 1);
          // Its node declared first leads it.
          const declared = nodes.map((node) => node.id);
          assert.equal(first, declared[Math.min(...cycle.map((id) => declared.indexOf(id)))]);
          return true;
        },
      );
    }),
  );
});

test('a link to a node the graph lacks is refused by that id, and two nodes by one id refuse the whole graph', (t) => {
  const app = publisher(t);
  fc.assert(
    fc.property(graphs({ acyclic: true }), nodeId, fc.nat(), (nodes, missing, at) => {
      fc.pre(!nodes.some((node) => node.id === missing));
      const index = at % nodes.length;
      const linking = nodes.map((node, i) =>
        i === index ? cell(node.id, [...(node.kind === 'cell' ? node.exports : []), missing]) : node,
      );
      assert.throws(() => app.publish(linking), {
        code: 'INVALID_CONFIG',
        message: 'Unknown node: ' + missing,
        node: missing,
      });
      assert.throws(() => app.publish([...nodes, cell(nodes[index].id, [])]), {
        code: 'INVALID_CONFIG',
        message: 'Duplicate node ID',
        node: undefined,
      });
    }),
  );
});
