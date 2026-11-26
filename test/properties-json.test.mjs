// Properties of the JSON celler copies and hashes (json.ts), over values fast-check makes: a copy is the same JSON, a
// value's text and hash don't depend on the order of its keys, and what isn't JSON, or nests too deep, is refused.
import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { CellerError } from 'celler';
import { canonicalJson, hash, normalizeJson } from '../dist/json.js';
import { jsonDepth } from '../dist/limits.js';

/** The same value with each object's keys in another order. */
function reordered(value, order) {
  if (Array.isArray(value)) return value.map((item) => reordered(item, order));
  if (value === null || typeof value !== 'object') return value;
  const entries = Object.entries(value);
  const shuffled = entries.map((entry, i) => [order[i % order.length] ?? 0, entry]).sort(([a], [b]) => a - b);
  const out = {};
  for (const [, [key, item]] of shuffled) {
    Object.defineProperty(out, key, {
      value: reordered(item, order),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

const refusedAsArgs = (pattern) => (error) => {
  assert.ok(error instanceof CellerError);
  assert.equal(error.code, 'INVALID_ARGS');
  assert.match(error.message, pattern);
  return true;
};

test("a JSON value's copy is the same JSON, and copying it again changes nothing", () => {
  fc.assert(
    fc.property(fc.jsonValue(), (value) => {
      const copy = normalizeJson(value);
      assert.equal(canonicalJson(copy), canonicalJson(value));
      assert.deepEqual(normalizeJson(copy), copy);
      if (value !== null && typeof value === 'object') assert.notEqual(copy, value);
    }),
  );
});

test("a value's canonical text and hash are the same whatever order its keys are in, and differ when it does", () => {
  fc.assert(
    fc.property(fc.jsonValue(), fc.jsonValue(), fc.array(fc.nat(), { minLength: 1 }), (value, other, order) => {
      const same = reordered(value, order);
      assert.equal(canonicalJson(same), canonicalJson(value));
      assert.equal(hash(same), hash(value));
      assert.match(hash(value), /^[0-9a-f]{64}$/);
      assert.equal(hash(other) === hash(value), canonicalJson(other) === canonicalJson(value));
    }),
  );
});

test('an omitted property is left out of the copy, and a `__proto__` key stays a key of its own', () => {
  fc.assert(
    fc.property(fc.dictionary(fc.string(), fc.jsonValue()), fc.string(), fc.jsonValue(), (object, key, kept) => {
      const copy = normalizeJson({ ...object, [key]: undefined, ['__proto__']: kept });
      assert.equal(Object.hasOwn(copy, key), key === '__proto__');
      assert.equal(Object.getPrototypeOf(copy), Object.prototype);
      assert.equal(canonicalJson(copy.__proto__), canonicalJson(kept));
    }),
  );
});

test('a value with something in it that JSON has no way to write is refused, wherever it is', () => {
  const unwritable = fc.constantFrom(
    { value: Number.NaN, says: /Non-finite/ },
    { value: Number.POSITIVE_INFINITY, says: /Non-finite/ },
    { value: () => 'code', says: /not valid JSON/ },
    { value: Symbol('s'), says: /not valid JSON/ },
    { value: 1n, says: /not valid JSON/ },
    { value: new Date(0), says: /Non-plain object/ },
    { value: new Map(), says: /Non-plain object/ },
  );
  const placed = fc.array(fc.oneof(fc.string(), fc.nat({ max: 3 })), { maxLength: 6 });
  fc.assert(
    fc.property(unwritable, placed, ({ value, says }, path) => {
      // Inside arrays and objects, as the path says: a string a key, a number an array's place.
      const nested = path.reduceRight(
        (inner, step) => (typeof step === 'string' ? { [step]: inner } : [...Array(step).fill(null), inner]),
        value,
      );
      assert.throws(() => normalizeJson(nested), refusedAsArgs(says));
    }),
  );
});

test(`JSON nests at most ${jsonDepth} levels deep, and a value that holds itself is refused`, () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: jsonDepth + 20 }), fc.boolean(), (depth, inObjects) => {
      let value = 'leaf';
      for (let i = 0; i < depth; i++) value = inObjects ? { inner: value } : [value];
      if (depth <= jsonDepth) assert.equal(canonicalJson(normalizeJson(value)), canonicalJson(value));
      else assert.throws(() => normalizeJson(value), refusedAsArgs(/nests deeper/));
    }),
  );
  fc.assert(
    fc.property(fc.array(fc.nat({ max: 3 }), { maxLength: 4 }), (path) => {
      // A chain of objects, or of arrays, whose last holds the first.
      const loop = {};
      let at = loop;
      const hold = (inner) => {
        if (Array.isArray(at)) at.push(inner);
        else at.next = inner;
      };
      for (const step of path) {
        const next = step % 2 ? {} : [];
        hold(next);
        at = next;
      }
      hold(loop);
      assert.throws(() => normalizeJson(loop), refusedAsArgs(/Circular/));
    }),
  );
});
