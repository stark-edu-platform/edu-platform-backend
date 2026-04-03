import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const gitDir = resolve(repoRoot, '.git');

if (!existsSync(gitDir)) {
  process.exit(0);
}

try {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], {
    cwd: repoRoot,
    stdio: 'ignore',
  });
} catch (error) {
  console.warn('Unable to configure git hooks automatically.');
  if (error instanceof Error) {
    console.warn(error.message);
  }
}
