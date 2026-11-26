// Properties of the limits a host may set (limits.ts), over options fast-check makes: each bound a host names is taken
// when it is a positive safe integer (zero where a bound allows none, a time no longer than a timer waits), every other
// bound keeps its default, and anything else is refused by the bound's name.
import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { createApp, CellerError } from 'celler';
import { appLimits, brokerLimits, postLimits, withLimits } from '../dist/limits.js';
import { memoryDatabase } from './support.mjs';

const LONGEST_TIMER_MS = 2 ** 31 - 1;
const ZERO_ALLOWED = new Set(['discoveryBytes', 'maxDepth', 'progressIntervalMs']);
const components = { appLimits, brokerLimits, postLimits };

/** Whether celler takes `value` for the bound `name`, as AGENTS.md and limits.ts say. */
function fits(name, value) {
  if (!Number.isSafeInteger(value) || value < (ZERO_ALLOWED.has(name) ? 0 : 1)) return false;
  return !name.endsWith('Ms') || value <= LONGEST_TIMER_MS;
}

const bound = fc.oneof(
  fc.integer({ min: -2, max: 2 }),
  fc.integer({ min: 1, max: LONGEST_TIMER_MS + 2 }),
  fc.constantFrom(LONGEST_TIMER_MS, LONGEST_TIMER_MS + 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 2),
  fc.double({ noNaN: false }),
);

const optionsFor = (defaults) =>
  fc.dictionary(fc.constantFrom(...Object.keys(defaults)), bound, { maxKeys: Object.keys(defaults).length });

for (const [component, defaults] of Object.entries(components)) {
  test(`${component}: a bound a host names is taken if it fits, every other keeps its default, and one that doesn't fit is refused by name`, () => {
    fc.assert(
      fc.property(optionsFor(defaults), (options) => {
        const misfits = Object.entries(options).filter(([name, value]) => !fits(name, value));
        if (!misfits.length) {
          assert.deepEqual(withLimits(defaults, options), { ...defaults, ...options });
          return;
        }
        // The first bound in the defaults' own order that doesn't fit is the one named.
        const [named] = Object.keys(defaults).filter((name) => misfits.some(([misfit]) => misfit === name));
        assert.throws(
          () => withLimits(defaults, options),
          (error) =>
            error instanceof CellerError &&
            error.code === 'INVALID_CONFIG' &&
            [`Invalid ${named}`, `Invalid ${named}: longer than a timer waits`].includes(error.message),
        );
      }),
    );
  });
}

test("an app takes its limits as withLimits does: one that doesn't fit stops it being made", (t) => {
  const database = memoryDatabase(t);
  fc.assert(
    fc.property(optionsFor(appLimits), (limits) => {
      const make = () => createApp({ database, adapters: new Map(), platform: {}, ...limits });
      if (Object.entries(limits).every(([name, value]) => fits(name, value))) assert.ok(make());
      else assert.throws(make, { code: 'INVALID_CONFIG' });
    }),
    { numRuns: 30 },
  );
});
