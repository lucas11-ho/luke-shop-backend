import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function files(dir) {
  const output = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) output.push(...files(path));
    else if (path.endsWith('.js') || path.endsWith('.mjs')) output.push(path);
  }
  return output;
}

const targets = [...files('src'), ...files('scripts')];
for (const file of targets) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout);
    process.exit(result.status || 1);
  }
}
console.log(`PASS JavaScript syntax checks (${targets.length} files)`);
