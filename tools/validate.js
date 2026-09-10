// Build/validation step ("npm run build"). There is no compilation in a
// vanilla MV3 extension, so "build" means: the manifest parses, every file it
// references exists, every JS file in extension/ and pwa/ parses as an ES module,
// the pure shared modules import cleanly, and every local asset referenced by
// the HTML files exists.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const extDir = path.join(root, 'extension');
const pwaDir = path.join(root, 'pwa');
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

// Validate manifest permissions
const expectedPerms = ['tabs', 'storage', 'favicon', 'identity', 'alarms'];
for (const p of expectedPerms) {
  if (!manifest.permissions?.includes(p)) fail(`manifest missing expected permission: ${p}`);
}
if (!manifest.oauth2 || !manifest.oauth2.scopes?.includes('https://www.googleapis.com/auth/drive.appdata')) {
  fail('manifest missing oauth2 drive.appdata scope configuration');
}

// --- JS syntax (parse each as an ES module via a temp .mjs copy) across extension/ and pwa/ ---
const jsFiles = [];
function walkJs(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walkJs(p);
    else if (p.endsWith('.js')) jsFiles.push(p);
  }
}
walkJs(extDir);
walkJs(pwaDir);

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
const sync = await import(pathToFileURL(path.join(extDir, 'shared', 'sync.js')));
const drive = await import(pathToFileURL(path.join(extDir, 'shared', 'drive.js')));
const syncEngine = await import(pathToFileURL(path.join(extDir, 'shared', 'sync-engine.js')));

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

// Verify sync engine methods exist
if (typeof sync.mergeStates !== 'function') fail('sync.mergeStates is missing');
if (typeof drive.findOrCreateSyncFile !== 'function') fail('drive.findOrCreateSyncFile is missing');
if (typeof syncEngine.performSync !== 'function') fail('syncEngine.performSync is missing');

// --- HTML-local assets across extension/ and pwa/ ---
const htmlFiles = [];
function walkHtml(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walkHtml(p);
    else if (p.endsWith('.html')) htmlFiles.push(p);
  }
}
walkHtml(extDir);
walkHtml(pwaDir);

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
