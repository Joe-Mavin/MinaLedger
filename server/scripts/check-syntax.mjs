import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = fileURLToPath(new URL('..', import.meta.url));
const targets = ['src', 'tests'];

function listModules(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listModules(path);
    return entry.isFile() && path.endsWith('.mjs') ? [path] : [];
  });
}

const modules = targets.flatMap((target) => listModules(join(serverRoot, target)));
let failed = false;

for (const modulePath of modules) {
  const result = spawnSync(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main', '--check', modulePath], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) failed = true;
}

if (failed) process.exitCode = 1;
else console.log(`Syntax check passed for ${modules.length} ES modules.`);
