// What every test process starts with: package.json's test scripts load this first (`--import`), in the runner and in
// each test file's process.
import fc from 'fast-check';

// UTC, whatever the computer's own time zone.
process.env.TZ = 'UTC';
// fast-check's cases are the same on every run, so the same code always gives the same answer. A property that fails
// prints its seed and path to rerun it; FAST_CHECK_SEED=<n> tries the cases of another seed.
fc.configureGlobal({ seed: Number(process.env.FAST_CHECK_SEED ?? 2026_11_26) });
