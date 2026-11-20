import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const clientDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = path.join(clientDirectory, 'dist');
const nginxConfiguration = await readFile(path.resolve(clientDirectory, '../deploy/nginx.conf'), 'utf8');
const serviceWorker = await readFile(path.join(outputDirectory, 'sw.js'), 'utf8');
const appShellMatch = serviceWorker.match(/const APP_SHELL\s*=\s*(\[[\s\S]*?\]);/);
assert.ok(appShellMatch, 'Built service worker must declare an APP_SHELL list.');

const appShellLiteral = appShellMatch[1];
const appShell = [...appShellLiteral.matchAll(/'([^'\\]*)'/g)].map((match) => match[1]);
assert.ok(Array.isArray(appShell), 'APP_SHELL must be an array.');
assert.equal(appShellLiteral.replace(/'[^'\\]*'/g, '').replaceAll('[', '').replaceAll(']', '').replace(/[\s,]/g, ''), '',
  'APP_SHELL must contain only quoted path strings.');
assert.ok(appShell.length > 0, 'APP_SHELL must not be empty.');
assert.equal(new Set(appShell).size, appShell.length, 'APP_SHELL must not contain duplicate paths.');
assert.ok(appShell.every((entry) => typeof entry === 'string' && entry.startsWith('/') && !entry.startsWith('//')),
  'APP_SHELL entries must be same-origin absolute paths.');
assert.ok(!appShell.some((entry) => entry.startsWith('/api/')), 'API responses must not be part of the app-shell cache.');
assert.match(serviceWorker, /url\.pathname\.startsWith\('\/api\/'\)/,
  'The service worker must bypass API requests.');
assert.match(serviceWorker, /if\s*\(!APP_SHELL\.includes\(url\.pathname\)\)\s*return;/,
  'Only app-shell assets may be handled by the cache strategy.');
assert.match(serviceWorker, /cache\.put\('\/index\.html',\s*response\.clone\(\)\)/,
  'Successful navigation responses must refresh the offline HTML shell.');

const assetsLocation = nginxConfiguration.match(/location\s+\/assets\/\s*\{([^}]*)\}/);
assert.ok(assetsLocation, 'NGINX must define a production assets location.');
assert.match(assetsLocation[1], /add_header\s+Cache-Control\s+"no-cache"\s+always;/,
  'Stable production asset names must revalidate with no-cache headers.');
assert.doesNotMatch(assetsLocation[1], /immutable|max-age=|expires\s+1y/i,
  'Stable production assets must not use immutable or long-lived caching.');
const indexLocation = nginxConfiguration.match(/location\s+=\s+\/index\.html\s*\{([^}]*)\}/);
const serviceWorkerLocation = nginxConfiguration.match(/location\s+=\s+\/sw\.js\s*\{([^}]*)\}/);
const fallbackLocation = nginxConfiguration.match(/location\s+\/\s*\{([^}]*)\}/);
assert.ok(indexLocation && /Cache-Control\s+"no-store"\s+always;/.test(indexLocation[1]),
  'Production HTML must not be stored by the HTTP cache.');
assert.ok(serviceWorkerLocation && /Cache-Control\s+"no-store"\s+always;/.test(serviceWorkerLocation[1]),
  'The service worker must be discoverable without HTTP caching.');
assert.ok(fallbackLocation && /Cache-Control\s+"no-store"\s+always;/.test(fallbackLocation[1]),
  'The SPA HTML fallback must not be stored by the HTTP cache.');

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
  }));
  return paths.flat();
}

const generatedAssets = (await listFiles(path.join(outputDirectory, 'assets')))
  .map((filePath) => `/assets/${path.relative(path.join(outputDirectory, 'assets'), filePath).split(path.sep).join('/')}`)
  .sort();
const precachedAssets = appShell.filter((entry) => entry.startsWith('/assets/')).sort();
assert.deepEqual(precachedAssets, generatedAssets,
  'Service-worker asset precache must exactly match generated production assets.');

const html = await readFile(path.join(outputDirectory, 'index.html'), 'utf8');
const linkedAssets = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
  .map((match) => match[1])
  .filter((entry) => entry.startsWith('/assets/'));
assert.ok(linkedAssets.length > 0, 'Production HTML must reference generated assets.');
for (const asset of linkedAssets) {
  assert.ok(appShell.includes(asset), `Production HTML asset ${asset} must be precached by the service worker.`);
}

for (const entry of appShell) {
  const filePath = path.resolve(outputDirectory, entry === '/' ? './index.html' : `.${entry}`);
  assert.ok(filePath.startsWith(`${outputDirectory}${path.sep}`), `APP_SHELL path escapes build output: ${entry}`);
  assert.ok((await stat(filePath)).isFile(), `APP_SHELL path does not exist in production output: ${entry}`);
}
