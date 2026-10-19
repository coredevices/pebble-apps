import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { upstreamDir } from './paths.mjs';

export const ICLOUD_MD_REPOSITORY = 'https://github.com/coddingtonbear/icloud-md.git';
export const ICLOUD_MD_COMMIT = 'a5160cc78e2bfeab35b8c8b365b1ef25662b21bb';

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

async function exists(target) {
  try { await access(target); return true; } catch { return false; }
}

if (await exists(path.join(upstreamDir, '.git'))) {
  const current = git(['rev-parse', 'HEAD'], upstreamDir);
  if (current !== ICLOUD_MD_COMMIT) {
    throw new Error(
      `Cached icloud-md is ${current}, expected ${ICLOUD_MD_COMMIT}. ` +
      'Remove only .cache/icloud-md and run this command again.',
    );
  }
  console.log(`Using cached icloud-md ${current}.`);
} else {
  await mkdir(upstreamDir, { recursive: true });
  git(['init', '--quiet'], upstreamDir);
  git(['remote', 'add', 'origin', ICLOUD_MD_REPOSITORY], upstreamDir);
  git(['fetch', '--quiet', '--depth=1', 'origin', ICLOUD_MD_COMMIT], upstreamDir);
  git(['checkout', '--quiet', '--detach', 'FETCH_HEAD'], upstreamDir);
  const current = git(['rev-parse', 'HEAD'], upstreamDir);
  if (current !== ICLOUD_MD_COMMIT) throw new Error(`Fetched ${current}, expected ${ICLOUD_MD_COMMIT}.`);
  console.log(`Fetched icloud-md ${current}.`);
}
