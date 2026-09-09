// Build/validation step ("npm run build"). There is no compilation in a
// vanilla MV3 extension, so "build" means: the manifest parses, every file it
// references exists, every JS file parses as an ES module, the pure shared
// modules import cleanly, and every local asset referenced by the HTML files
// exists.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const extDir = path.join(root, 'extension');
let failures = 0;
const fail = (msg) => {
  failures++;
  console.error('FAIL:', msg);
};

// --- manifest ---
const manifestPath = path.join(extDir, 'manifest.json');
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (err) {
  fail(`manifest.json does not parse: ${err.message}`);
  process.exit(1);
}
if (manifest.manifest_version !== 3) fail('manifest_version must be 3');

const referenced = [
  manifest.background && manifest.background.service_worker,
  manifest.action && manifest.action.default_popup,
  ...(manifest.action && manifest.action.default_icon ? Object.values(manifest.action.default_icon) : []),
  ...Object.values(manifest.icons || {}),
].filter(Boolean);
for (const ref of referenced) {
  if (!fs.existsSync(path.join(extDir, ref))) fail(`missing manifest-referenced file: ${ref}`);
}

const suggested = Object.values(manifest.commands || {}).filter((c) => c.suggested_key).length;
if (suggested > 4) fail(`${suggested} commands declare suggested_key; Chrome allows at most 4`);

// --- JS syntax (parse each as an ES module via a temp .mjs copy) ---
const jsFiles = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.js')) jsFiles.push(p);
  }
})(extDir);

for (const file of jsFiles) {
  const tmp = path.join(fs.realpathSync(fs.mkdtempSync('tt-validate-')), 'check.mjs');
  fs.copyFileSync(file, tmp);
  const res = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
  fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  if (res.status !== 0) fail(`syntax error in ${path.relative(root, file)}:\n${res.stderr.trim()}`);
}

// --- shared modules import & behave ---
const logic = await import(pathToFileURL(path.join(extDir, 'shared', 'logic.js')));
const store = await import(pathToFileURL(path.join(extDir, 'shared', 'store.js')));
const s = logic.newState();
if (
  s.schemaVersion !== 1 ||
  s.topics.length !== 2 ||
  s.topics.map((t) => t.name).join(',') !== 'NoTopic,General' ||
  s.entries.length !== 0
) {
  fail('newState() sanity check failed');
}
const adapter = store.memoryAdapter();
const loaded = await store.loadState(adapter);
if (loaded.schemaVersion !== 1) fail('loadState on empty adapter failed');
await store.saveState(adapter, loaded);
if ((await adapter.get()).schemaVersion !== 1) fail('saveState round-trip failed');

// --- HTML-local assets ---
const htmlFiles = [];
(function walkHtml(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walkHtml(p);
    else if (p.endsWith('.html')) htmlFiles.push(p);
  }
})(extDir);
for (const file of htmlFiles) {
  const text = fs.readFileSync(file, 'utf8');
  const assets = [...text.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((v) => !/^(https?:|#|data:|chrome:)/.test(v));
  for (const asset of assets) {
    if (!fs.existsSync(path.join(path.dirname(file), asset))) {
      fail(`${path.relative(root, file)} references missing asset: ${asset}`);
    }
  }
}

if (failures) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log(
  `OK — manifest valid, ${referenced.length} manifest assets present, ${jsFiles.length} JS files parse, ` +
    `shared modules import cleanly, ${htmlFiles.length} HTML files' assets resolve.`
);
