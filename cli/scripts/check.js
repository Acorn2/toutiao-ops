import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
for (const file of ['index.js', ...['src', 'scripts', 'test', 'workspace'].flatMap(dir => readdirSync(dir).filter(f => f.endsWith('.js')).map(f => `${dir}/${f}`))]) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}
console.log('JavaScript syntax checks passed');
