import { execFileSync } from 'node:child_process';

/** Runs `git <args>` in `dir`; returns trimmed stdout, throws with stderr on failure. */
export function git(dir: string, ...args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message?: string };
    const stderr = e.stderr ? e.stderr.toString() : e.message ?? String(err);
    throw new Error(`git ${args.join(' ')} (in ${dir}) failed: ${stderr}`);
  }
}

export const head = (dir: string) => git(dir, 'rev-parse', 'HEAD');
export const currentBranch = (dir: string) => git(dir, 'symbolic-ref', '--short', '-q', 'HEAD');
export const log1 = (dir: string, fmt = '%s', rev = 'HEAD') => git(dir, 'log', '-1', `--format=${fmt}`, rev);
export const parents = (dir: string, rev = 'HEAD') =>
  git(dir, 'rev-list', '--parents', '-n', '1', rev).split(' ').slice(1);
export const statusLines = (dir: string) => git(dir, 'status', '--porcelain').split('\n').filter(Boolean);
export const cachedNames = (dir: string) => git(dir, 'diff', '--cached', '--name-only').split('\n').filter(Boolean);
export const stashList = (dir: string) => git(dir, 'stash', 'list').split('\n').filter(Boolean);
export const worktreeList = (dir: string) => git(dir, 'worktree', 'list', '--porcelain');

/**
 * Polls `read()` every 200ms until `ok(value)` is true, or throws after
 * `timeoutMs`. A `read()` that throws (e.g. a git command that fails while
 * a repo is mid-operation) is treated as just another not-yet-ok value —
 * it's caught and polling continues; the timeout message shows the error
 * instead of a value if the last attempt was the one that threw.
 */
export async function waitForGit<T>(
  read: () => T,
  ok: (v: T) => boolean,
  what: string,
  timeoutMs = 10_000
): Promise<T> {
  const start = Date.now();
  let lastValue: T | undefined;
  let lastError: unknown;
  let hasValue = false;
  for (;;) {
    try {
      const v = read();
      lastValue = v;
      hasValue = true;
      lastError = undefined;
      if (ok(v)) return v;
    } catch (err) {
      lastError = err;
      hasValue = false;
    }
    if (Date.now() - start >= timeoutMs) {
      const shown = hasValue
        ? JSON.stringify(lastValue)
        : `<error: ${lastError instanceof Error ? lastError.message : String(lastError)}>`;
      throw new Error(`${what}: last value ${shown}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}
