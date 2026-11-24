// Count physical lines, including comments and blank lines, in first-party code and configuration.
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const maximum = 500;
const extensions = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
  '.html', '.css', '.svg', '.sh', '.ps1', '.nsh', '.json', '.yaml', '.yml',
]);
const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'coverage']);
const lockfiles = new Set(['pnpm-lock.yaml', 'package-lock.json']);
const violations = [];
let checked = 0;

function checkDirectory(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) checkDirectory(path);
      continue;
    }
    if (!entry.isFile() || !extensions.has(extname(path)) || lockfiles.has(entry.name)) continue;

    const source = readFileSync(path, 'utf8');
    const physicalLines = source.split(/\r\n|[\n\r]/);
    // A final newline terminates a line. An empty file has zero lines.
    if (physicalLines.at(-1) === '') physicalLines.pop();
    const lines = physicalLines.length;
    checked++;
    if (lines > maximum) violations.push(`${relative(root, path)} (${lines} lines)`);
  }
}

checkDirectory(root);
// The README is the one document besides AGENTS.md: at most 50 lines.
const readmeMaximum = 50;
const readme = readFileSync(join(root, 'README.md'), 'utf8').split(/\r\n|[\n\r]/);
if (readme.at(-1) === '') readme.pop();
if (readme.length > readmeMaximum) violations.push(`README.md (${readme.length} lines; it keeps to ${readmeMaximum})`);
if (violations.length) {
  console.error(`Over the line limits (${maximum} a handwritten file, ${readmeMaximum} the README):\n${violations.sort().join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`Checked ${checked} handwritten files against the ${maximum}-line limit, and the README against ${readmeMaximum}.`);
}
