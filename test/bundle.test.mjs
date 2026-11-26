import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { cell, memoryDatabase, request, text, tool, withClient } from './support.mjs';

const built = (file) => fileURLToPath(new URL(`../dist/${file}`, import.meta.url));

test('a host that bundles celler, its harness too, gets a library that loads and serves as it does unbundled: it reads nothing beside its own code', async (t) => {
  // Far from the package, as a host's own build is: no package.json, no node_modules beside it.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'celler-bundle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await build({
    entryPoints: { celler: built('index.js'), harness: built('harness/index.js') },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outdir: dir,
    outExtension: { '.js': '.mjs' },
    // What a bundle of CommonJS packages needs to require Node's own modules from an ES module.
    banner: {
      js: "import { createRequire as requireFor } from 'node:module'; const require = requireFor(import.meta.url);",
    },
    logLevel: 'silent',
  });
  const { createApp } = await import(pathToFileURL(path.join(dir, 'celler.mjs')).href);
  const harness = await import(pathToFileURL(path.join(dir, 'harness.mjs')).href);
  assert.equal(typeof harness.harnessPlatform, 'function');

  // A run through the bundle: its server says its version, and a call goes through.
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  let seen;
  const app = createApp({
    database: memoryDatabase(t),
    adapters: new Map([['ok', { call: async () => text('called') }]]),
    platform: {
      allowed: () => true,
      launch: (_spec, connect) =>
        withClient(connect, async (client) => {
          const called = await client.callTool({ name: 'echo', arguments: {} });
          seen = [client.getServerVersion(), called.content[0].text];
          return text('done');
        }),
    },
  });
  await app.start(request(app.publish([cell('root', ['echo']), tool('echo', { adapter: 'ok' })])));
  assert.deepEqual(seen, [{ name: 'celler', version }, 'called']);
});
